/// Screenshots, noticed rather than asked for.
///
/// The user presses the key their operating system gives them and the picture
/// lands in a folder; ADE's job is to see it arrive. Nothing here takes a
/// screenshot, and nothing here asks the user where to put one — a tool that
/// made you save the file somewhere special before it would look at it would be
/// slower than dragging the file yourself.
///
/// Polled rather than hooked into the filesystem's change notifications. The
/// folder gains a file every few minutes at most, a poll costs one metadata
/// read and, when the folder changed, one directory listing, and ReadDirectoryChangesW brings a watcher handle, a cancellation
/// path and a class of missed-event bugs that this does not have.
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

/// Extensions worth showing. A screenshot folder collects other things —
/// thumbnails databases, the odd stray download — and a tray full of them is
/// worse than an empty one.
const IMAGES: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

#[derive(Default)]
pub struct Watch {
    dir: Mutex<Option<PathBuf>>,
    /*
     * Bumped every time a different folder is watched, and read by the polling
     * thread on each pass. Without it the thread started for the previous
     * folder keeps running for as long as the window is open, announcing
     * `shot:new` for a folder nobody is looking at any more — the "don't start
     * a second thread" guard below only ever compared the current path.
     */
    generation: Arc<AtomicUsize>,
    /// The last choice of screenshots folder and when it was made. See `current_dir`.
    picked: Mutex<Option<(Instant, Option<PathBuf>)>>,
}

#[derive(Clone, serde::Serialize)]
pub struct Shot {
    path: String,
    name: String,
    /// Milliseconds since the epoch, so the tray can order without re-reading.
    modified_ms: u64,
}

/// What the page needs to know about the folder ADE is watching.
///
/// Separate from the folder itself because a network share can be named but
/// not read: the tray says so, rather than showing an empty strip with no
/// explanation for the rest of the session.
#[derive(Clone, serde::Serialize)]
pub struct ShotLocation {
    dir: String,
    network: bool,
}

/// Folders that hold nothing but screenshots, where every image is one.
///
/// True everywhere except the Desktop, which on macOS is where screenshots
/// land by default — and where everything else the user leaves lying around
/// lands too, and the Pictures folder itself, which on Linux is a candidate
/// (`Pictures` may be localised, so it is the operating system's answer that
/// is compared, not the name). A tray listing every picture there, and
/// offering to delete them, would be answering a question nobody asked.
fn holds_only_shots(dir: &Path) -> bool {
    holds_only_shots_in(dir, broad_folders())
}

fn holds_only_shots_in(dir: &Path, broad: &[PathBuf]) -> bool {
    let desktop = dir
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.eq_ignore_ascii_case("Desktop"))
        .unwrap_or(false);
    !desktop && !broad.iter().any(|folder| same_path(folder, dir))
}

/// The folders of a user's pictures, asked once: `holds_only_shots` runs for
/// every file of a listing.
fn broad_folders() -> &'static [PathBuf] {
    static BROAD: OnceLock<Vec<PathBuf>> = OnceLock::new();
    BROAD.get_or_init(|| pictures_dir().into_iter().collect())
}

/*
 * What macOS calls a screenshot, in the languages it writes it in.
 *
 * The name follows the system language: "Screenshot 2026-09-17 at 21.43.13",
 * "Schermata 2026-09-17 alle 21.43.13", "Bildschirmfoto …". The prefix can
 * also be changed (`defaults write com.apple.screencapture name`), which is
 * why a date with a time is accepted as evidence on its own below.
 */
const SHOT_PREFIXES: [&str; 14] = [
    "screen shot",
    "screenshot",
    "schermata",
    "immagine",
    "bildschirmfoto",
    "capture d",
    "captura de pantalla",
    "captura de ecra",
    "schermafbeelding",
    "skarmavbild",
    "zrzut ekranu",
    "ekran goruntusu",
    "\u{441}\u{43d}\u{438}\u{43c}\u{43e}\u{43a} \u{44d}\u{43a}\u{440}\u{430}\u{43d}\u{430}",
    "\u{30b9}\u{30af}\u{30ea}\u{30fc}\u{30f3}\u{30b7}\u{30e7}\u{30c3}\u{30c8}",
];

/// Whether a file name reads as a screenshot: a known prefix, or a date and a time.
fn named_like_shot(name: &str) -> bool {
    let lower = name.to_lowercase();
    if SHOT_PREFIXES.iter().any(|prefix| lower.starts_with(prefix)) {
        return true;
    }
    /*
     * 2026-09-17 … 21.43.13, whatever sits between them and whatever the
     * prefix was renamed to. Both halves are required: a date alone is a
     * holiday photo, a time alone is nothing.
     */
    has_date(&lower) && has_clock(&lower)
}

fn has_date(name: &str) -> bool {
    matches_shape(name, &[4, 2, 2], &['-', '.', '_'])
}

fn has_clock(name: &str) -> bool {
    matches_shape(name, &[2, 2, 2], &['.', '-', ':', '_'])
}

/// Three runs of digits of the given lengths, joined by one of `separators`,
/// and not part of a longer run of digits on either side.
fn matches_shape(name: &str, lengths: &[usize; 3], separators: &[char]) -> bool {
    let chars: Vec<char> = name.chars().collect();
    'start: for start in 0..chars.len() {
        if start > 0 && chars[start - 1].is_ascii_digit() {
            continue;
        }
        let mut at = start;
        for (index, wanted) in lengths.iter().enumerate() {
            let run = chars[at..].iter().take_while(|c| c.is_ascii_digit()).count();
            if run != *wanted {
                continue 'start;
            }
            at += run;
            if index < lengths.len() - 1 {
                match chars.get(at) {
                    Some(c) if separators.contains(c) => at += 1,
                    _ => continue 'start,
                }
            }
        }
        if chars.get(at).map(|c| !c.is_ascii_digit()).unwrap_or(true) {
            return true;
        }
    }
    false
}

/// An image this tray should show: in a screenshots folder any, on the Desktop one named like a shot.
///
/// `root` is the folder being watched, never the file's own parent. Asking
/// the parent let `~/Desktop/qualsiasi-cartella/foto.png` through: that
/// folder is not called Desktop, so every image in it read as a screenshot.
/// The tray only ever lists the root itself, so a file anywhere below it is
/// not one of its screenshots either.
fn is_shot(root: &Path, path: &Path) -> bool {
    if !is_image(path) {
        return false;
    }
    if path.parent().map(|parent| parent != root).unwrap_or(true) {
        return false;
    }
    if holds_only_shots(root) {
        return true;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .map(named_like_shot)
        .unwrap_or(false)
}

/// The screenshots in `entries`, at most `limit` of them.
///
/// The cap is on what is kept, not on what is looked at: capping the reading
/// meant that in a folder of thousands of files — which a Desktop is — the
/// limit could be spent entirely on things that are not screenshots, and the
/// tray stayed empty. Names are cheap to judge; only what survives this is
/// ever asked for its metadata.
fn keep_shots(entries: impl Iterator<Item = PathBuf>, root: &Path, limit: usize) -> Vec<PathBuf> {
    entries.filter(|path| is_shot(root, path)).take(limit).collect()
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGES.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn describe(path: &Path) -> Option<Shot> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(Shot {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        modified_ms: modified,
    })
}

/// Where this machine puts screenshots.
///
/// More than one folder can exist, and the one Windows creates first is often
/// empty while the pictures go somewhere else. The first one found is therefore
/// not the answer: the newest image decides between the candidates, and the
/// folder the user chose in the tray, or the one the operating system was told
/// about, wins outright.
///
/// Which folders to look in is a question about the operating system, not
/// about ADE. Windows keeps the real answer in `FOLDERID_Screenshots`, which
/// follows a moved folder and the localised names OneDrive creates; macOS saves
/// on the Desktop unless the user moved it with `defaults write
/// com.apple.screencapture location`.
/*
 * `async` throughout, for the reason spelled out in `lib.rs`: a synchronous
 * command runs on the thread that draws the window, and every command here
 * touches the disk. `shot_bytes` is the sharp one — a 4K screenshot is several
 * megabytes read from a folder that is often a OneDrive mount, and the tray
 * asks for one per thumbnail.
 */
#[tauri::command]
pub async fn shots_dir(watch: tauri::State<'_, Watch>) -> Result<Option<ShotLocation>, String> {
    // The tray asking is the moment to look again: it is opening, or the page
    // was reloaded, and the answer may have changed since the last look.
    let dir = current_dir(&watch, true);
    Ok(dir.map(|dir| ShotLocation {
        network: crate::is_network_path(&dir.to_string_lossy()),
        dir: dir.to_string_lossy().into_owned(),
    }))
}

/// How long a choice of folder is trusted before it is made again.
///
/// Every thumbnail and every delete asks which folder is the screenshots
/// folder, and making the choice reads every candidate folder. The tray asking
/// (`shots_dir`) and the user choosing a folder renew it at once. The expiry
/// limits the cost, nothing more: the page asks `shots_dir` once, when the tray
/// mounts, so a tool that starts saving elsewhere while ADE stays open changes
/// which roots `shot_delete` accepts, not the folder the tray is on.
const PICK_TTL: Duration = Duration::from_secs(60);

/// The folder the tray should watch, made at most once per `PICK_TTL`.
///
/// `fresh` forces the choice to be made again. The result lives in the `Watch`
/// state, so a test can build its own and no choice leaks between them.
fn current_dir(watch: &Watch, fresh: bool) -> Option<PathBuf> {
    cached_pick(&watch.picked, Instant::now(), PICK_TTL, fresh, default_dir)
}

/// `compute` unless the last answer in `cache` is younger than `ttl`.
fn cached_pick(
    cache: &Mutex<Option<(Instant, Option<PathBuf>)>>,
    now: Instant,
    ttl: Duration,
    fresh: bool,
    compute: impl FnOnce() -> Option<PathBuf>,
) -> Option<PathBuf> {
    // A poisoned lock only means a panic elsewhere: choosing again is safe.
    if let Ok(held) = cache.lock() {
        if let Some((at, answer)) = held.as_ref() {
            if !fresh && now.saturating_duration_since(*at) < ttl {
                return answer.clone();
            }
        }
    }
    // Computed outside the lock: it reads the disk, and a thumbnail waiting on
    // another thumbnail's directory listing is what the cache is there to stop.
    let answer = compute();
    if let Ok(mut held) = cache.lock() {
        *held = Some((now, answer.clone()));
    }
    answer
}

/// Forget the last choice, so the next question makes it again.
fn forget_pick(watch: &Watch) {
    if let Ok(mut held) = watch.picked.lock() {
        *held = None;
    }
}

/// The folder the tray should watch, or `None` when this machine has none.
///
/// Reads the disk on every call: go through `current_dir`.
fn default_dir() -> Option<PathBuf> {
    let home = dirs::home_dir();
    let chosen = chosen_dir();
    let configured = configured_dir();
    let candidates = shot_dir_candidates(
        std::env::consts::OS,
        home.as_deref(),
        pictures_dir().as_deref(),
        chosen.as_deref(),
        configured.as_deref(),
        &one_drive_roots(home.as_deref()),
    );
    pick_shot_dir(&candidates, chosen.as_deref())
}

/// The folders this platform may be saving screenshots in, likeliest first.
///
/// `os` is `std::env::consts::OS`, passed in rather than read here so the
/// order for every platform can be tested from any of them. `chosen` is the
/// folder the user picked in the tray; `configured` is the one the operating
/// system was told to use. The rest are fallbacks for installs where neither
/// can be read.
pub fn shot_dir_candidates(
    os: &str,
    home: Option<&Path>,
    pictures: Option<&Path>,
    chosen: Option<&Path>,
    configured: Option<&Path>,
    one_drive: &[PathBuf],
) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    // The user's choice wins over everything, then the operating system's.
    found.extend(chosen.map(Path::to_path_buf));
    found.extend(configured.map(Path::to_path_buf));
    match os {
        "macos" => {
            found.extend(home.map(|h| h.join("Desktop")));
            found.extend(pictures.map(|p| p.join("Screenshots")));
        }
        "windows" => {
            /*
             * HEURISTIC, with no source behind the names: the English
             * `Pictures\Screenshots` under each OneDrive root. The real answers
             * come from the shell API, not from here: `configured` is
             * `FOLDERID_Screenshots` and `pictures` is `FOLDERID_Pictures`
             * (through `dirs`), and both follow a move to OneDrive and any
             * localised name. These guesses only matter when neither can be
             * read, and a wrong one costs nothing: it is filtered by existing
             * and by holding a screenshot.
             */
            for root in one_drive {
                found.push(root.join("Pictures").join("Screenshots"));
            }
            found.extend(pictures.map(|p| p.join("Screenshots")));
            found.extend(home.map(|h| h.join("OneDrive").join("Pictures").join("Screenshots")));
        }
        // GNOME and KDE both save under Pictures; a desktop that does not is
        // covered by Pictures itself rather than by guessing further.
        _ => {
            found.extend(pictures.map(|p| p.join("Screenshots")));
            found.extend(pictures.map(PathBuf::from));
            found.extend(home.map(|h| h.join("Desktop")));
        }
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    for path in found {
        if !unique.iter().any(|known| same_path(known, &path)) {
            unique.push(path);
        }
    }
    unique
}

/// The folder the tray should watch: the one the user chose when it exists,
/// otherwise the candidate with the most recent screenshot, and on a tie (every
/// candidate empty, or two with the same time) the one listed first.
///
/// `candidates` is in order of trust: the folder the operating system was told
/// about (`FOLDERID_Screenshots`) comes right after the user's, so it decides
/// a tie and nothing else. An empty folder never beats one with a screenshot in
/// it, whoever named it: Windows leaves an empty `Pictures\Screenshots` behind
/// while the pictures go to OneDrive or to a folder a tool was pointed at, and
/// ADE watched the empty one.
///
/// A share is never listed (that would send the user's hash), so it cannot win
/// on pictures; it is named only when no local folder has any, so that the tray
/// can say why it is empty instead of looking broken.
fn pick_shot_dir(candidates: &[PathBuf], chosen: Option<&Path>) -> Option<PathBuf> {
    // Asked before `is_dir`: on a UNC path the latter talks to the server,
    // which sends the user's hash before the tray has even named the folder.
    if let Some(chosen) = chosen {
        if names_a_folder(chosen) {
            return Some(chosen.to_path_buf());
        }
    }
    let mut best: Option<(&PathBuf, SystemTime)> = None;
    for dir in candidates {
        if crate::is_network_path(&dir.to_string_lossy()) || !dir.is_dir() {
            continue;
        }
        let Some(modified) = newest_image(dir) else { continue };
        // Strictly newer: on a tie the earlier, more trusted candidate stays.
        if best.map(|(_, current)| modified > current).unwrap_or(true) {
            best = Some((dir, modified));
        }
    }
    best.map(|(dir, _)| dir.clone())
        .or_else(|| candidates.iter().find(|path| names_a_folder(path)).cloned())
}

/// A folder that exists, or a share that is only named.
///
/// Asked in this order because `is_dir` on a UNC path talks to the server and
/// sends the user's hash; the text says it is a share before the file system
/// is touched.
fn names_a_folder(path: &Path) -> bool {
    crate::is_network_path(&path.to_string_lossy()) || path.is_dir()
}

/// When the most recent screenshot directly inside `dir` was written, if any.
///
/// `is_shot`, not `is_image`: on the macOS Desktop every picture lying about
/// would otherwise count, and beat a Screenshots folder that really is used.
fn newest_image(dir: &Path) -> Option<SystemTime> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_file()).unwrap_or(false))
        .filter(|entry| is_shot(dir, &entry.path()))
        .filter_map(|entry| entry.metadata().ok()?.modified().ok())
        .max()
}

/// Whether two paths name the same folder, as far as a user would say.
///
/// Windows paths are case-insensitive and the environment can spell the same
/// root differently from a directory listing.
fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

/// Where the folder the user picked is remembered, under the app's config.
///
/// A file rather than the page's storage: the choice is made in a native
/// dialog and must survive a WebView profile, a reload and a second window.
const CHOSEN_FILE: &str = "screenshots-folder";

/// Same split the identifier makes: ADE Test must not rewrite the official
/// ADE's choice, and both can be open at once.
fn config_dir_name() -> &'static str {
    if cfg!(feature = "test-exe") {
        "ai.nikcli.ade.test"
    } else {
        "ai.nikcli.ade"
    }
}

/// Under the local app data, not the roaming config: a folder such as `D:\Shots`
/// means nothing on another PC, and a roaming profile would carry it there.
fn chosen_dir_file() -> Option<PathBuf> {
    dirs::data_local_dir().map(|base| base.join(config_dir_name()).join(CHOSEN_FILE))
}

fn read_chosen(path: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(path).ok()?;
    let raw = raw.trim();
    (!raw.is_empty()).then(|| PathBuf::from(raw))
}

fn save_chosen(path: &Path, dir: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("cartella di configurazione: {error}"))?;
    }
    std::fs::write(path, dir.to_string_lossy().as_bytes()).map_err(|error| format!("scelta non salvata: {error}"))
}

/// The remembered choice, unless it is one the tray would refuse today: the
/// file is plain text, and anything that wrote it is not the dialog.
fn chosen_dir() -> Option<PathBuf> {
    chosen_dir_file().and_then(|file| chosen_dir_from(&file, dirs::home_dir().as_deref()))
}

/// `chosen_dir` for a given file and home, so a test can call the real filter.
fn chosen_dir_from(file: &Path, home: Option<&Path>) -> Option<PathBuf> {
    read_chosen(file).filter(|dir| refuse_broad_folder(dir, home).is_none())
}

/// Folders that must not become "the screenshots folder", with the code that
/// says why.
///
/// Every image directly inside the screenshots folder is the tray's to show
/// and `shot_delete` to remove (`check_shot` only asks that it be an image in
/// the watched folder). A disk root, the home folder or the folder that holds
/// the user's folders would hand the delete button every picture a person owns,
/// and a system folder has no business being watched. Textual, like
/// `is_network_path`: it must not touch the disk, and a share has nothing of
/// the sort to refuse.
///
/// `too-broad`: a disk root, the home folder, or a folder that contains it
/// (`C:\Users`). `system`: the operating system's folders and anything in them.
fn refuse_broad_folder(path: &Path, home: Option<&Path>) -> Option<&'static str> {
    let text = path.to_string_lossy();
    if crate::is_network_path(&text) {
        return None;
    }
    let clean = clean_text(&text);
    // A root: nothing left once the separators go, or a bare drive (`c:`).
    let bare = clean.trim_start_matches('/');
    if bare.is_empty() || (bare.len() == 2 && bare.ends_with(':')) {
        return Some("too-broad");
    }
    // `path` is the home folder or holds it (`C:\Users`).
    if home.map(|home| within(&clean_text(&home.to_string_lossy()), &clean)).unwrap_or(false) {
        return Some("too-broad");
    }
    let mut system: Vec<String> = Vec::new();
    if cfg!(windows) {
        for key in ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"] {
            system.extend(std::env::var_os(key).map(|dir| clean_text(&dir.to_string_lossy())));
        }
    } else {
        system.extend(
            ["/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/sbin", "/sys", "/usr", "/var", "/System", "/Library"]
                .map(String::from),
        );
    }
    system.iter().any(|dir| within(&clean, dir)).then_some("system")
}

/// A path as text one can compare: one separator, no `.` or `..` segments, no
/// trailing separator, no `\\?\` prefix on a local path and, on Windows, no case.
///
/// Lexical on purpose: it must not touch the disk (a share would answer with
/// the user's hash), and `C:\Users\nik\..\..` must read as `C:`. A junction or
/// an 8.3 name is not seen through here; `shots_root` asks the same question of
/// the canonical path, which is.
fn clean_text(text: &str) -> String {
    let text = text.replace('\\', "/");
    let text = match text.strip_prefix("//?/") {
        Some(rest) if rest.chars().nth(1) == Some(':') => rest.to_string(),
        _ => text.clone(),
    };
    let mut kept: Vec<&str> = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                kept.pop();
            }
            other => kept.push(other),
        }
    }
    let lead = if text.starts_with('/') { "/" } else { "" };
    let joined = format!("{lead}{}", kept.join("/"));
    if cfg!(windows) { joined.to_lowercase() } else { joined }
}

/// Whether `inner` is `outer` or lies inside it, both already `clean_text`.
fn within(inner: &str, outer: &str) -> bool {
    outer == "/" || inner == outer || inner.starts_with(&format!("{outer}/"))
}

/// The OneDrive roots this machine actually has.
///
/// OneDrive sets `OneDrive`, `OneDriveConsumer` and `OneDriveCommercial` to
/// the sync roots, and for a work account the folder is `OneDrive - Azienda`
/// unless an administrator renamed it. The environment is the source; the
/// home's `OneDrive*` folders cover an install that lost the variables, and a
/// moved root. Duplicates are harmless and removed by the candidates.
fn one_drive_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for key in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
        if let Some(value) = std::env::var_os(key) {
            roots.push(PathBuf::from(value));
        }
    }
    if let Some(home) = home {
        roots.push(home.join("OneDrive"));
        roots.extend(one_drive_folders_in(home));
    }
    let mut unique: Vec<PathBuf> = Vec::new();
    for path in roots {
        if !unique.iter().any(|known| same_path(known, &path)) {
            unique.push(path);
        }
    }
    unique
}

/// The `OneDrive*` folders directly inside `home`, sorted.
fn one_drive_folders_in(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(home) else { return Vec::new() };
    // The name first, and the entry's own type (no disk access, and a link is
    // not followed): `is_dir` on every entry of home would follow a link to a
    // NAS and wait for it.
    let mut named: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .map(|name| name.to_lowercase().starts_with("onedrive"))
                .unwrap_or(false)
        })
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_dir() && !kind.is_symlink())
                .unwrap_or(false)
        })
        .map(|entry| entry.path())
        .collect();
    named.sort();
    named
}

/// `~` at the start is the shell's, not the filesystem's: expanded here or the path does not exist.
// Only macOS reads a configured folder, but the rule is tested from every platform.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn expand_tilde(raw: &str, home: Option<&Path>) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match raw.strip_prefix('~') {
        Some(rest) => home.map(|h| h.join(rest.trim_start_matches(['/', '\\']))),
        None => Some(PathBuf::from(raw)),
    }
}

/// The folder macOS was told to save screenshots in, when the user moved it.
#[cfg(target_os = "macos")]
fn configured_dir() -> Option<PathBuf> {
    let output = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
        .ok()?;
    if !output.status.success() {
        // Unset is the normal case, and it means the Desktop.
        return None;
    }
    expand_tilde(&String::from_utf8_lossy(&output.stdout), dirs::home_dir().as_deref())
}

/// `FOLDERID_Screenshots`: where the Snipping Tool and OneDrive put them now.
///
/// The registry value behind it (`User Shell Folders`,
/// `{B7BEDE81-DF94-4682-A7D8-57A52620B86F}`) is what a move rewrites, and the
/// shell API is what turns it into a path, follows the redirect, and returns
/// the localised folder OneDrive provisioned. Reading the registry directly
/// would miss the last two.
#[cfg(windows)]
fn configured_dir() -> Option<PathBuf> {
    use windows::Win32::UI::Shell::FOLDERID_Screenshots;

    // A redirected Pictures can be a share: `names_a_folder` asks the text
    // before the disk, so the share is named without being opened.
    known_folder(&FOLDERID_Screenshots).filter(|path| names_a_folder(path))
}

/// A known folder's path, without the shell checking that it exists.
///
/// `KF_FLAG_DONT_VERIFY`: by default the shell tries to reach the folder, and
/// when it is redirected to `\\server\share` that opens an SMB connection
/// (sending the user's hash, and waiting for the server's timeout when it is
/// off) inside this very call, before any check on the text can run. Without
/// the flag the path comes back as it is configured, and the callers ask
/// `names_a_folder`.
#[cfg(windows)]
fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath};

    unsafe {
        let raw = SHGetKnownFolderPath(id, KF_FLAG_DONT_VERIFY, None).ok()?;
        let path = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as *const core::ffi::c_void));
        path.map(PathBuf::from)
    }
}

/// `FOLDERID_Pictures`, which follows a move to OneDrive and any localised name.
///
/// On Windows through `known_folder` rather than `dirs::picture_dir`, which
/// verifies the folder and so touches a redirected share.
#[cfg(windows)]
fn pictures_dir() -> Option<PathBuf> {
    use windows::Win32::UI::Shell::FOLDERID_Pictures;

    known_folder(&FOLDERID_Pictures)
}

#[cfg(not(windows))]
fn pictures_dir() -> Option<PathBuf> {
    dirs::picture_dir()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn configured_dir() -> Option<PathBuf> {
    None
}

/// Asks for a folder and remembers it, then answers with what the tray should
/// now watch. `None` when the dialog was dismissed.
///
/// The folder is picked here rather than in the page: the tray is the only
/// caller, the choice is a native dialog, and the path never has to travel
/// through the WebView. A network share is accepted and reported as such —
/// the tray can name it, and `shots_watch` will not read it.
///
/// The errors are codes for the page to translate (`not-a-folder`,
/// `too-broad`, `system`, `not-saved`), not sentences: the texts are in the
/// page's i18n, under `shots.error.<code>`.
#[tauri::command]
pub async fn shots_choose_folder(
    app: AppHandle,
    watch: tauri::State<'_, Watch>,
) -> Result<Option<ShotLocation>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|_| "not-saved".to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|_| "not-a-folder".to_string())?;
    if !names_a_folder(&path) {
        return Err("not-a-folder".into());
    }
    if let Some(reason) = refuse_broad_folder(&path, dirs::home_dir().as_deref()) {
        return Err(reason.into());
    }
    let Some(file) = chosen_dir_file() else {
        return Err("not-saved".into());
    };
    save_chosen(&file, &path).map_err(|_| "not-saved".to_string())?;
    // The next question must see the choice, not the one made a minute ago.
    forget_pick(&watch);
    Ok(Some(ShotLocation {
        network: crate::is_network_path(&path.to_string_lossy()),
        dir: path.to_string_lossy().into_owned(),
    }))
}

/// The images already there, newest first, capped at `limit`.
///
/// Read once when the tray opens so it is not empty until the next screenshot:
/// the one the user took a moment before switching to ADE is the one they came
/// to use.
#[tauri::command]
pub async fn shots_recent(
    watch: tauri::State<'_, Watch>,
    dir: String,
    limit: usize,
) -> Result<Vec<Shot>, String> {
    // Only the folder the tray is on: the page names it, but whatever it names
    // is not a folder this command lists (it would show the names and dates of
    // any picture folder on the disk).
    if !is_current_dir(&watch, &dir) {
        return Err("not-current".into());
    }
    // A share is named in the tray but never opened from here: touching one
    // sends the user's NTLM hash to the server (see `is_network_path`).
    if crate::refuse_network_path(&dir).is_err() {
        return Ok(Vec::new());
    }
    let folder = PathBuf::from(&dir);
    let entries = std::fs::read_dir(&folder).into_iter().flatten().flatten().map(|entry| entry.path());
    let mut found: Vec<Shot> = keep_shots(entries, &folder, MAX_KEPT)
        .into_iter()
        .filter_map(|path| describe(&path))
        .collect();
    found.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    found.truncate(limit);
    Ok(found)
}

/// Whether `dir`, as the page spells it, is the folder this process chose.
///
/// The page asks for the folder it was told about by `shots_dir` or
/// `shots_choose_folder`; anything else is not the tray's folder, and must not
/// become a root that `shot_delete` accepts. Answered from the remembered
/// choice (no disk read), and `shots_dir` and the picker renew it just before
/// the page asks.
fn is_current_dir(watch: &Watch, dir: &str) -> bool {
    current_dir(watch, false)
        .map(|current| same_path(&current, Path::new(dir)))
        .unwrap_or(false)
}

/// Starts watching `dir`, emitting `shot:new` for each image that appears.
///
/// Only what arrives from now on. The folder already holds months of pictures,
/// and announcing all of them would bury whatever the user just took.
#[tauri::command]
pub async fn shots_watch(
    app: AppHandle,
    watch: tauri::State<'_, Watch>,
    dir: String,
) -> Result<(), String> {
    // The same folder as `shots_recent`: this one becomes a root for
    // `shot_delete`, so a page cannot name a disk root or the Pictures folder.
    if !is_current_dir(&watch, &dir) {
        return Err("not-current".into());
    }
    let path = PathBuf::from(&dir);
    if crate::is_network_path(&dir) {
        /*
         * Retire the watcher before refusing: the tray has just been pointed
         * at a share, and the old folder's pictures must not keep arriving in
         * it. Nothing here opens the share.
         */
        let _ = claim(&watch, &path);
        return Err(format!("percorso di rete non consentito: {dir}"));
    }
    if !path.is_dir() {
        return Err(format!("{dir} non è una cartella"));
    }

    let Some(generation) = claim(&watch, &path)? else {
        return Ok(());
    };
    let mine = Arc::clone(&watch.generation);

    std::thread::spawn(move || {
        // Read before the listing, never after: a file that lands between the
        // two moves the folder's time past this value, and the next pass lists.
        let mut listed_mtime = dir_modified(&path);
        let mut listed_at = Instant::now();
        let mut seen: HashSet<PathBuf> = std::fs::read_dir(&path)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|entry| is_shot(&path, entry))
            .take(MAX_KEPT)
            .collect();
        // An image found but not yet settled, which a skipped pass would strand.
        let mut unsettled = false;

        loop {
            std::thread::sleep(POLL_INTERVAL);

            // The window is gone: stop, rather than poll a folder for a page
            // that will never be told about it.
            if app.webview_windows().is_empty() {
                return;
            }

            // Someone asked for a different folder: that call started its own
            // thread, and this one has nothing left to report.
            if !is_current(&mine, generation) {
                return;
            }

            let mtime = dir_modified(&path);
            if !needs_listing(listed_mtime, mtime, unsettled, listed_at.elapsed()) {
                continue;
            }

            let entries: HashSet<PathBuf> = match std::fs::read_dir(&path) {
                Ok(read) => keep_shots(read.flatten().map(|entry| entry.path()), &path, MAX_KEPT)
                    .into_iter()
                    .collect(),
                Err(_) => {
                    // Not listed, so nothing is known: the next pass tries again.
                    listed_mtime = None;
                    continue;
                }
            };
            listed_mtime = mtime;
            listed_at = Instant::now();
            unsettled = false;

            for entry in &entries {
                if seen.contains(entry) || !entry.is_file() {
                    continue;
                }
                /*
                 * A screenshot tool writes the file before it finishes writing
                 * the file: read too eagerly and the tray shows half an image,
                 * or none. Waiting for the size to stop moving is cruder than
                 * asking the writer, and it works for every tool.
                 *
                 * Marked as seen only once it has settled. Marking first meant
                 * that a capture slower than one pass — a 4K shot, a folder
                 * being synced to the cloud — was written off on the single
                 * pass that arrived too early, and never looked at again.
                 */
                if !settled(entry) {
                    unsettled = true;
                    continue;
                }
                seen.insert(entry.clone());
                if let Some(shot) = describe(entry) {
                    let _ = app.emit("shot:new", shot);
                }
            }

            forget_missing(&mut seen, &entries);
        }
    });

    Ok(())
}

/*
 * How often the folder is looked at, and how long it may go unlisted.
 *
 * Two and a half seconds: a screenshot is taken to be pasted somewhere, and
 * the time it takes a person to switch to ADE and look for it is longer than
 * that. Most passes list nothing at all — see `needs_listing`.
 */
const POLL_INTERVAL: Duration = Duration::from_millis(2500);

/// How many screenshots one listing may keep, before the newest are chosen. See `keep_shots`.
const MAX_KEPT: usize = 5_000;
const FULL_RELIST: Duration = Duration::from_secs(30);

/// The folder's own modified time, which moves when a file is added, removed
/// or renamed in it.
fn dir_modified(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/*
 * Whether this pass has to list the folder.
 *
 * A folder of months of screenshots is thousands of entries, and listing it
 * every pass to find that nothing arrived was the whole cost of the watcher.
 * NTFS and APFS move a directory's modified time whenever a file is created
 * in it, so an unchanged time means an unchanged listing — on those, which are
 * the two this is written for.
 *
 * Three reasons to list anyway. An image seen but not settled on the last pass
 * has to be looked at again, and its growing does not touch the folder's time.
 * A time that cannot be read is no evidence of anything. And some mounts —
 * network shares, cloud-synced folders, filesystems with two-second times —
 * do not keep the folder's time honestly, so every thirty seconds the folder
 * is listed whatever its time says: a late screenshot, not a lost one.
 */
fn needs_listing(
    listed: Option<SystemTime>,
    current: Option<SystemTime>,
    unsettled: bool,
    since_listing: Duration,
) -> bool {
    unsettled || since_listing >= FULL_RELIST || current.is_none() || listed != current
}

/// Files deleted outside ADE should be forgotten, or the set grows for as long
/// as the window is open and a re-created name is missed.
///
/// Both sides are sets: with a `Vec` of entries this was a scan of the whole
/// folder for every file already seen, on every pass.
fn forget_missing(seen: &mut HashSet<PathBuf>, entries: &HashSet<PathBuf>) {
    seen.retain(|known| entries.contains(known));
}

/// Takes the next generation for `path`, or `None` when that folder is already
/// the one being watched.
///
/// Split out of `shots_watch` because it is the whole of the duplicate guard
/// and the whole of the stop signal, and neither could be exercised while it
/// sat inside a command that wants an `AppHandle` and a real folder.
fn claim(watch: &Watch, path: &Path) -> Result<Option<usize>, String> {
    let mut current = watch.dir.lock().map_err(|_| "watch bloccato")?;
    // Re-watching the same folder must not start a second thread: both would
    // announce every screenshot, and the tray would show each one twice.
    if current.as_deref() == Some(path) {
        return Ok(None);
    }
    *current = Some(path.to_path_buf());
    // Bumped under the same lock that swaps the folder, so the thread being
    // replaced can see it is no longer the current one.
    Ok(Some(watch.generation.fetch_add(1, Ordering::SeqCst) + 1))
}

/// True while `mine` is still the generation the watcher is on.
fn is_current(shared: &AtomicUsize, mine: usize) -> bool {
    shared.load(Ordering::SeqCst) == mine
}

/// Two readings that agree on a size that is not zero: the writer has stopped.
///
/// Zero is the case worth naming. `size_of` below reports it both for a file
/// that is not there and for one the screenshot tool has created but not
/// written into yet, and calling either of those "unchanged, therefore
/// finished" would announce an empty placeholder as a screenshot.
fn size_is_stable(previous: u64, current: u64) -> bool {
    current == previous && current > 0
}

/// Waits, briefly, for a file to stop growing.
fn settled(path: &Path) -> bool {
    let size_of = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let mut last = size_of(path);
    for _ in 0..10 {
        std::thread::sleep(Duration::from_millis(120));
        let now = size_of(path);
        if size_is_stable(last, now) {
            return true;
        }
        last = now;
    }
    false
}

/*
 * Which files these two commands will touch.
 *
 * "Has an image extension" was the only check, and it is not one: every page
 * loaded in the browser pane can invoke these, so it made `shot_delete` a way
 * to remove any picture anywhere on the disk, and `shot_bytes` a way to read
 * one. The tray only ever names files it found by listing the screenshots
 * folder, so that folder — plus whichever one is being watched, if the user
 * pointed the tray elsewhere — is the entire legitimate range.
 */
/// The watched folder this file is in, canonicalised, or nothing.
///
/// Canonicalised on both sides: the point is to catch a link planted in the
/// screenshots folder and aimed somewhere else, which a textual prefix check
/// would wave straight through.
///
/// The folder is returned rather than a yes: whether a file counts as a
/// screenshot is a question about the folder being *watched*, and answering it
/// from the file's own parent let `~/Desktop/una-cartella/foto.png` through.
fn shots_root(watch: &Watch, path: &Path) -> Option<(PathBuf, PathBuf)> {
    let resolved = path.canonicalize().ok()?;

    let mut roots: Vec<PathBuf> = Vec::new();
    // The remembered choice, not a new one: this runs for every thumbnail.
    if let Some(dir) = current_dir(watch, false) {
        roots.push(dir);
    }
    if let Ok(current) = watch.dir.lock() {
        if let Some(dir) = current.as_ref() {
            roots.push(dir.clone());
        }
    }

    let home = dirs::home_dir();
    shots_root_among(&roots, &resolved, home.as_deref()).map(|root| (root, resolved))
}

/// The first of `roots`, canonicalised, that holds `resolved` directly or not.
///
/// Split from `shots_root` so a test can hand it roots of its own.
fn shots_root_among(roots: &[PathBuf], resolved: &Path, home: Option<&Path>) -> Option<PathBuf> {
    roots
        .iter()
        // Never touch a share here: canonicalising it sends the user's hash to
        // the server, and a chosen network folder is otherwise a root.
        .filter(|root| !crate::is_network_path(&root.to_string_lossy()))
        .filter_map(|root| root.canonicalize().ok())
        // The canonical folder, which sees through a junction or a link to
        // `C:\` that the text of the choice did not: a root is never a place
        // the delete button could reach every picture of a person.
        .filter(|root| refuse_broad_folder(root, home).is_none())
        .find(|root| resolved.starts_with(root))
}

fn check_shot(watch: &Watch, path: &str) -> Result<PathBuf, String> {
    // Before `canonicalize`, which on a UNC path talks to the server first (and sends it the user's hash).
    crate::refuse_network_path(path)?;
    let file = PathBuf::from(path);
    /*
     * Named like a screenshot as well as being in the folder, judged by the
     * folder being watched.
     *
     * On macOS that folder is the Desktop, so "an image in the watched
     * folder" is every picture the user has left lying about — and
     * `shot_delete` takes a path from the page. The tray never offers one of
     * those, and now it could not act on one either.
     */
    let Some((root, resolved)) = shots_root(watch, &file) else {
        return Err("non è nella cartella degli screenshot".into());
    };
    // The resolved path, so a link cannot borrow a screenshot's name.
    if !is_shot(&root, &resolved) {
        return Err("non è una schermata".into());
    }
    Ok(file)
}

/// The image itself, for the tray's thumbnail.
///
/// Handed over as bytes rather than as a path the page could load directly: the
/// webview has no access to the filesystem, and opening one up so it could read
/// a picture would be a far larger grant than reading the picture.
#[tauri::command]
pub async fn shot_bytes(watch: tauri::State<'_, Watch>, path: String) -> Result<Vec<u8>, String> {
    let file = check_shot(&watch, &path)?;
    std::fs::read(&file).map_err(|e| format!("non leggibile: {e}"))
}

/// Removes a screenshot from disk. Used by the tray's own delete, never by the
/// dismiss — closing a thumbnail hides it, it does not throw the file away.
#[tauri::command]
pub async fn shot_delete(watch: tauri::State<'_, Watch>, path: String) -> Result<(), String> {
    let file = check_shot(&watch, &path)?;
    std::fs::remove_file(&file).map_err(|e| format!("non eliminabile: {e}"))
}

/*
 * What is tested here, and what is deliberately not.
 *
 * The two rules that had the bugs — "seen only once settled" and "stop when a
 * newer watcher exists" — are tested through the functions that decide them.
 * The loop that applies them is not: it needs an `AppHandle` to emit through
 * and a folder that gains a file while it is polling, and a test that wrote a
 * screenshot slowly enough to span a pass would be deciding by stopwatch which
 * of two threads wins. That is the flaky test this deliberately does not have.
 */
#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of our own under the system temp folder. Named after the
    /// test, so two of them running at once never share a file.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ade-shots-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("cartella temporanea");
        dir
    }

    // Full review 2026-10-06, rust (minor): `canonicalize` on a UNC path talks to the server before the text check.
    #[test]
    fn a_network_path_is_refused_before_it_is_resolved() {
        let watch = Watch::default();
        let error = check_shot(&watch, "\\\\ade-test-unreachable.invalid\\share\\Screenshot 1.png").unwrap_err();
        assert!(error.contains("rete"), "{error}");
    }

    #[test]
    fn only_pictures_are_worth_announcing() {
        assert!(is_image(Path::new("Screenshot 2026-09-11.png")));
        // Whatever case the tool felt like using.
        assert!(is_image(Path::new("shot.JPG")));
        assert!(!is_image(Path::new("Thumbs.db")));
        assert!(!is_image(Path::new("note.txt")));
        assert!(!is_image(Path::new("Screenshots")));
    }

    #[test]
    fn a_size_that_stopped_moving_means_the_write_finished() {
        assert!(size_is_stable(4096, 4096));
    }

    #[test]
    fn a_file_still_growing_has_not_finished() {
        assert!(!size_is_stable(2048, 4096));
        // Shrinking counts as movement too: some tools write a header last.
        assert!(!size_is_stable(4096, 2048));
    }

    #[test]
    fn nothing_on_disk_is_never_a_finished_screenshot() {
        // Both readings are zero for a file that does not exist and for one
        // created but not written into. "Unchanged" must not win here.
        assert!(!size_is_stable(0, 0));
    }

    #[test]
    fn a_file_already_written_settles_on_the_first_pass() {
        // Not a race: nothing writes to this file while `settled` watches it,
        // so the first two readings agree whatever the machine is doing.
        let dir = scratch("settled");
        let file = dir.join("shot.png");
        std::fs::write(&file, b"not really a png, but it has a size").expect("scrittura");

        assert!(settled(&file));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_file_never_settles() {
        // The regression this guards: an empty file has an unchanging size, and
        // treating that as finished announced a placeholder as a screenshot.
        // Costs the full ten passes by design — there is nothing to wait for.
        let dir = scratch("empty");
        let file = dir.join("shot.png");
        std::fs::write(&file, b"").expect("scrittura");

        assert!(!settled(&file));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_folder_whose_time_did_not_move_is_not_listed() {
        let t = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let later = t + Duration::from_millis(1);
        let soon = Duration::from_secs(3);

        assert!(!needs_listing(Some(t), Some(t), false, soon));
        // A file arrived, or left.
        assert!(needs_listing(Some(t), Some(later), false, soon));
        // A time that cannot be read, now or last time, proves nothing.
        assert!(needs_listing(Some(t), None, false, soon));
        assert!(needs_listing(None, Some(t), false, soon));
    }

    #[test]
    fn a_screenshot_still_being_written_keeps_the_folder_listed() {
        // Its growing does not touch the folder's time, and skipping the pass
        // would leave it unannounced until the fallback relist.
        let t = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        assert!(needs_listing(Some(t), Some(t), true, Duration::from_secs(3)));
    }

    #[test]
    fn the_folder_is_relisted_now_and_then_whatever_its_time_says() {
        let t = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        assert!(needs_listing(Some(t), Some(t), false, FULL_RELIST));
    }

    #[test]
    fn files_gone_from_the_folder_are_forgotten_and_the_rest_kept() {
        let mut seen: HashSet<PathBuf> = ["a.png", "b.png", "c.png"].iter().map(PathBuf::from).collect();
        let entries: HashSet<PathBuf> = ["b.png", "c.png", "d.png"].iter().map(PathBuf::from).collect();

        forget_missing(&mut seen, &entries);

        let expected: HashSet<PathBuf> = ["b.png", "c.png"].iter().map(PathBuf::from).collect();
        // `d.png` is not added: only a settled file is marked as seen.
        assert_eq!(seen, expected);
    }

    #[test]
    fn watching_the_same_folder_twice_starts_nothing_new() {
        let watch = Watch::default();
        let dir = Path::new("C:/Users/x/Pictures/Screenshots");

        assert_eq!(claim(&watch, dir), Ok(Some(1)));
        // Second call finds the folder unchanged and declines to hand out a
        // generation, which is what stops a duplicate thread being spawned.
        assert_eq!(claim(&watch, dir), Ok(None));
    }

    #[test]
    fn a_new_folder_retires_the_watcher_of_the_old_one() {
        let watch = Watch::default();

        let first = claim(&watch, Path::new("/pictures/one")).unwrap().unwrap();
        assert!(is_current(&watch.generation, first));

        let second = claim(&watch, Path::new("/pictures/two")).unwrap().unwrap();
        assert_ne!(first, second);
        // The old thread's next pass reads this and returns; before the counter
        // existed it kept polling its folder and kept emitting `shot:new` for
        // pictures nobody was looking at any more.
        assert!(!is_current(&watch.generation, first));
        assert!(is_current(&watch.generation, second));
    }

    #[test]
    fn going_back_to_the_first_folder_is_a_new_generation_too() {
        // Not the same as "already watching it": the thread for that folder has
        // been retired by the folder in between, so one has to be started again.
        let watch = Watch::default();

        let first = claim(&watch, Path::new("/pictures/one")).unwrap().unwrap();
        claim(&watch, Path::new("/pictures/two")).unwrap().unwrap();
        let again = claim(&watch, Path::new("/pictures/one")).unwrap().unwrap();

        assert_ne!(again, first);
        assert!(is_current(&watch.generation, again));
    }
}

#[cfg(test)]
mod dir_tests {
    use super::*;

    fn home() -> PathBuf {
        PathBuf::from("/Users/nik")
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ade-shot-dirs-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("cartella temporanea");
        dir
    }

    fn candidates(
        os: &str,
        home: Option<&Path>,
        pictures: Option<&Path>,
        chosen: Option<&Path>,
        configured: Option<&Path>,
        one_drive: &[PathBuf],
    ) -> Vec<PathBuf> {
        shot_dir_candidates(os, home, pictures, chosen, configured, one_drive)
    }

    #[test]
    fn macos_looks_on_the_desktop_first() {
        let found = candidates("macos", Some(&home()), Some(&home().join("Pictures")), None, None, &[]);
        assert_eq!(found[0], home().join("Desktop"));
        assert!(found.contains(&home().join("Pictures").join("Screenshots")));
    }

    #[test]
    fn a_folder_the_user_chose_comes_first() {
        let chosen = PathBuf::from("/Volumes/SSD/Shots");
        let found = candidates("macos", Some(&home()), None, Some(&chosen), None, &[]);
        assert_eq!(found[0], chosen);
    }

    /// `FOLDERID_Screenshots` is the exact path Windows was told to use, so it
    /// is listed before every guess (and decides a tie between folders).
    #[test]
    fn the_known_folder_comes_before_the_guesses() {
        let known = PathBuf::from(r"C:\Users\nik\Cartella\Screenshot");
        let win = PathBuf::from(r"C:\Users\nik");
        let found = candidates(
            "windows",
            Some(&win),
            Some(&win.join("Pictures")),
            None,
            Some(&known),
            &[win.join("OneDrive - Azienda")],
        );
        assert_eq!(found[0], known);
    }

    #[test]
    fn windows_tries_every_onedrive_root_it_was_given() {
        let win = PathBuf::from(r"C:\Users\nik");
        let work = win.join("OneDrive - Azienda");
        let found = candidates(
            "windows",
            Some(&win),
            Some(&win.join("Pictures")),
            None,
            None,
            std::slice::from_ref(&work),
        );
        assert_eq!(
            found,
            vec![
                work.join("Pictures").join("Screenshots"),
                win.join("Pictures").join("Screenshots"),
                win.join("OneDrive").join("Pictures").join("Screenshots"),
            ]
        );
    }

    /// The environment root and the `OneDrive*` folder in home are the same
    /// install; two identical candidates would only make the order confusing.
    #[test]
    fn the_same_onedrive_root_is_only_looked_at_once() {
        let win = PathBuf::from(r"C:\Users\nik");
        let root = win.join("OneDrive");
        let found = candidates(
            "windows",
            Some(&win),
            Some(&win.join("Pictures")),
            None,
            None,
            std::slice::from_ref(&root),
        );
        assert_eq!(
            found
                .iter()
                .filter(|path| **path == root.join("Pictures").join("Screenshots"))
                .count(),
            1
        );
    }

    #[test]
    fn linux_falls_back_to_pictures_itself() {
        let found = candidates("linux", Some(&home()), Some(&home().join("Pictures")), None, None, &[]);
        assert_eq!(found[1], home().join("Pictures"));
    }

    #[test]
    fn nothing_known_means_nowhere_to_look() {
        assert!(candidates("macos", None, None, None, None, &[]).is_empty());
    }

    #[test]
    fn a_tilde_path_is_expanded_against_home() {
        // `defaults` prints a trailing newline, which is part of no path.
        assert_eq!(expand_tilde("~/Desktop/Shots\n", Some(&home())), Some(home().join("Desktop/Shots")));
        assert_eq!(expand_tilde("/Volumes/SSD/Shots", Some(&home())), Some(PathBuf::from("/Volumes/SSD/Shots")));
        assert_eq!(expand_tilde("  ", Some(&home())), None);
    }

    fn image_at(dir: &Path, name: &str, seconds: u64) {
        let file = dir.join(name);
        std::fs::write(&file, b"not really an image, but it has a time").expect("scrittura");
        let file = std::fs::File::options().write(true).open(&file).expect("apertura");
        file.set_modified(UNIX_EPOCH + Duration::from_secs(seconds)).expect("mtime");
    }

    /// The bug this fixes: Windows leaves an empty `Pictures\Screenshots`
    /// behind, ADE took the first folder that existed, and watched the empty
    /// one while the pictures went to OneDrive.
    #[test]
    fn the_folder_with_the_newest_image_wins_over_the_first_empty_one() {
        let root = scratch("newest");
        let empty = root.join("Pictures").join("Screenshots");
        let used = root.join("OneDrive").join("Pictures").join("Screenshots");
        std::fs::create_dir_all(&empty).expect("cartella vuota");
        std::fs::create_dir_all(&used).expect("cartella usata");
        image_at(&used, "Screenshot 1.png", 1_700_000_000);

        let found = pick_shot_dir(&[empty.clone(), used.clone()], None);
        assert_eq!(found, Some(used));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The known folder is trusted first but only decides a tie: a newer
    /// screenshot elsewhere wins over an older one in it.
    #[test]
    fn the_known_folder_loses_to_a_folder_with_a_newer_picture() {
        let root = scratch("known");
        let known = root.join("Cartella").join("Screenshot");
        let used = root.join("OneDrive").join("Pictures").join("Screenshots");
        std::fs::create_dir_all(&known).expect("cartella nota");
        std::fs::create_dir_all(&used).expect("cartella recente");
        image_at(&known, "Screenshot 1.png", 1_600_000_000);
        image_at(&used, "Screenshot 1.png", 1_700_000_000);

        let found = pick_shot_dir(&[known, used.clone()], None);
        assert_eq!(found, Some(used));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The case the decision is about: Windows made the known folder, nothing
    /// is saved there, and the pictures go to another folder.
    #[test]
    fn an_empty_known_folder_never_beats_a_folder_with_pictures() {
        let root = scratch("knownempty");
        let known = root.join("Pictures").join("Screenshots");
        let used = root.join("ShareX");
        std::fs::create_dir_all(&known).expect("cartella nota vuota");
        std::fs::create_dir_all(&used).expect("cartella usata");
        image_at(&used, "Screenshot 1.png", 1_700_000_000);

        assert_eq!(pick_shot_dir(&[known, used.clone()], None), Some(used));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// On a tie the earlier candidate stays, which is the known folder: every
    /// folder empty, or two with the very same time.
    #[test]
    fn the_known_folder_decides_a_tie() {
        let root = scratch("tie");
        let known = root.join("Known");
        let other = root.join("Other");
        std::fs::create_dir_all(&known).expect("cartella nota");
        std::fs::create_dir_all(&other).expect("altra cartella");

        assert_eq!(pick_shot_dir(&[known.clone(), other.clone()], None), Some(known.clone()));

        image_at(&known, "Screenshot 1.png", 1_700_000_000);
        image_at(&other, "Screenshot 2.png", 1_700_000_000);
        assert_eq!(pick_shot_dir(&[known.clone(), other], None), Some(known));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_folder_the_user_chose_wins_even_when_another_has_pictures() {
        let root = scratch("chosen");
        let empty = root.join("Pictures").join("Screenshots");
        let used = root.join("OneDrive").join("Pictures").join("Screenshots");
        let chosen = root.join("Scelte");
        std::fs::create_dir_all(&empty).expect("cartella vuota");
        std::fs::create_dir_all(&used).expect("cartella usata");
        std::fs::create_dir_all(&chosen).expect("cartella scelta");
        image_at(&used, "Screenshot 1.png", 1_700_000_000);

        let found = pick_shot_dir(&[empty, used, chosen.clone()], Some(&chosen));
        assert_eq!(found, Some(chosen));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A remembered folder that was deleted or unplugged is not an answer.
    #[test]
    fn a_chosen_folder_that_is_gone_falls_back_to_what_exists() {
        let root = scratch("gone");
        let used = root.join("OneDrive").join("Pictures").join("Screenshots");
        std::fs::create_dir_all(&used).expect("cartella usata");
        image_at(&used, "Screenshot 1.png", 1_700_000_000);
        let gone = root.join("Non Esiste");

        let found = pick_shot_dir(&[gone, used.clone()], Some(&root.join("Non Esiste")));
        assert_eq!(found, Some(used));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// None of the folders has an image: something is better than nothing,
    /// because the watcher will announce the first screenshot that arrives.
    #[test]
    fn with_no_images_the_first_existing_folder_is_kept() {
        let root = scratch("noimages");
        let empty = root.join("Pictures").join("Screenshots");
        std::fs::create_dir_all(&empty).expect("cartella vuota");

        assert_eq!(pick_shot_dir(&[empty.clone()], None), Some(empty));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The choice is made once per interval, not once per thumbnail.
    #[test]
    fn the_choice_of_folder_is_remembered_until_it_is_old() {
        let cache = Mutex::new(None);
        let start = Instant::now();
        let ttl = Duration::from_secs(60);
        let mut runs = 0;
        let mut ask = |at: Instant, fresh: bool| {
            cached_pick(&cache, at, ttl, fresh, || {
                runs += 1;
                Some(PathBuf::from(format!("/cartella/{runs}")))
            })
        };

        assert_eq!(ask(start, false), Some(PathBuf::from("/cartella/1")));
        // Twelve thumbnails a moment later: the same answer, nothing read.
        for second in 1..13 {
            assert_eq!(ask(start + Duration::from_secs(second), false), Some(PathBuf::from("/cartella/1")));
        }
        // The tray asking, or the user choosing, makes it again at once.
        assert_eq!(ask(start + Duration::from_secs(13), true), Some(PathBuf::from("/cartella/2")));
        // And an old answer is made again without being asked.
        assert_eq!(ask(start + Duration::from_secs(74), false), Some(PathBuf::from("/cartella/3")));
        assert_eq!(runs, 3);
    }

    /// "Nothing found" is an answer too: it is not looked for again on every thumbnail.
    #[test]
    fn no_folder_is_remembered_as_well() {
        let cache = Mutex::new(None);
        let start = Instant::now();
        let mut runs = 0;
        for second in 0..5 {
            let found = cached_pick(&cache, start + Duration::from_secs(second), PICK_TTL, false, || {
                runs += 1;
                None
            });
            assert_eq!(found, None);
        }
        assert_eq!(runs, 1);
    }

    /// The folder the user picks gets the delete button, so it must not be
    /// one that holds everything the user owns.
    #[test]
    fn broad_folders_are_refused_as_the_screenshots_folder() {
        let home = PathBuf::from(r"C:\Users\nik");
        for broad in [r"C:\", r"C:", r"C:\Users", r"C:\Users\nik", r"C:\Users\nik\"] {
            assert_eq!(refuse_broad_folder(Path::new(broad), Some(&home)), Some("too-broad"), "{broad}");
        }
        // Windows paths do not care about case; other systems do.
        if cfg!(windows) {
            assert_eq!(refuse_broad_folder(Path::new(r"c:\USERS\Nik"), Some(&home)), Some("too-broad"));
        }
        assert_eq!(refuse_broad_folder(Path::new("/"), Some(Path::new("/home/nik"))), Some("too-broad"));
        assert_eq!(refuse_broad_folder(Path::new("/home"), Some(Path::new("/home/nik"))), Some("too-broad"));
    }

    #[test]
    fn a_folder_inside_home_is_fine_and_a_system_folder_is_not() {
        let home = PathBuf::from(r"C:\Users\nik");
        for fine in [r"C:\Users\nik\Pictures\Screenshots", r"C:\Users\nik\OneDrive\Immagini", r"D:\Schermate"] {
            assert_eq!(refuse_broad_folder(Path::new(fine), Some(&home)), None, "{fine}");
        }
        // A folder named like home's start is not inside it.
        assert_eq!(refuse_broad_folder(Path::new(r"C:\Users\nikita\Shots"), Some(&home)), None);
        if cfg!(windows) {
            let windir = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
            assert_eq!(refuse_broad_folder(&Path::new(&windir).join("System32"), None), Some("system"));
        } else {
            assert_eq!(refuse_broad_folder(Path::new("/etc/ssh"), Some(Path::new("/home/nik"))), Some("system"));
        }
    }

    #[test]
    fn a_share_is_never_refused_as_broad() {
        assert_eq!(refuse_broad_folder(Path::new(r"\\server\shots"), Some(Path::new(r"C:\Users\nik"))), None);
    }

    /// A choice written by hand into the file is not trusted more than the
    /// dialog. Calls the reader the app uses, not a copy of its filter: taking
    /// the refusal out of `chosen_dir_from` turns this red.
    #[test]
    fn a_broad_choice_found_in_the_file_is_not_a_choice() {
        let root = scratch("broadfile");
        let file = root.join("screenshots-folder");
        let home = PathBuf::from("/home/nik");
        let system = if cfg!(windows) {
            format!("{}{}", std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()), r"\System32")
        } else {
            "/etc/ssh".to_string()
        };
        for broad in [
            "/",
            "/home",
            "/home/nik",
            "/home/nik/.",
            "/home/nik/Pictures/../..",
            system.as_str(),
            r"C:\Users\nik\..\..",
        ] {
            std::fs::write(&file, broad).expect("scrittura");
            assert_eq!(chosen_dir_from(&file, Some(&home)), None, "{broad}");
        }
        let good = PathBuf::from("/home/nik/Shots");
        std::fs::write(&file, good.to_string_lossy().as_bytes()).expect("scrittura");
        assert_eq!(chosen_dir_from(&file, Some(&home)), Some(good));
        assert_eq!(chosen_dir_from(&root.join("non-c-e"), Some(&home)), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dots_and_verbatim_prefixes_do_not_hide_a_broad_folder() {
        let home = PathBuf::from(r"C:\Users\nik");
        for broad in [
            r"C:\Users\nik\.",
            r"C:\Users\nik\..",
            r"C:\Users\nik\..\..",
            r"\\?\C:\Users\nik",
            r"\\?\C:\",
            r"C:\Users\nik\Pictures\..\..",
        ] {
            assert_eq!(refuse_broad_folder(Path::new(broad), Some(&home)), Some("too-broad"), "{broad}");
        }
        assert_eq!(refuse_broad_folder(Path::new(r"C:\Users\nik\Pictures\..\Shots"), Some(&home)), None);
    }

    fn watch_on(root: &Path) -> Watch {
        let watch = Watch::default();
        *watch.dir.lock().expect("lucchetto") = Some(root.to_path_buf());
        // A choice already made, so nothing here reads this machine's folders.
        *watch.picked.lock().expect("lucchetto") = Some((Instant::now(), None));
        watch
    }

    /// The point of the whole change: what `shot_bytes` and `shot_delete` may
    /// touch is an image directly inside the watched folder, and nothing else.
    #[test]
    fn the_delete_field_is_the_watched_folder_and_nothing_else() {
        let base = scratch("field");
        let root = base.join("shots");
        std::fs::create_dir_all(root.join("sub")).expect("sottocartella");
        std::fs::write(root.join("Screenshot 1.png"), b"x").expect("scrittura");
        std::fs::write(root.join("sub").join("Screenshot 2.png"), b"x").expect("scrittura");
        std::fs::write(root.join("nota.txt"), b"x").expect("scrittura");
        std::fs::write(base.join("fuori.png"), b"x").expect("scrittura");
        let watch = watch_on(&root);
        let ask = |path: PathBuf| check_shot(&watch, &path.to_string_lossy());

        assert!(ask(root.join("Screenshot 1.png")).is_ok());
        // `..` out of the folder, to a picture next to it.
        assert!(ask(root.join("..").join("fuori.png")).is_err());
        // A subfolder, a name that is not an image, a file that is not there.
        assert!(ask(root.join("sub").join("Screenshot 2.png")).is_err());
        assert!(ask(root.join("nota.txt")).is_err());
        assert!(ask(root.join("non-c-e.png")).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_picture_outside_the_folder_is_not_in_the_delete_field() {
        let base = scratch("link");
        let root = base.join("shots");
        std::fs::create_dir_all(&root).expect("cartella");
        std::fs::write(base.join("fuori.png"), b"x").expect("scrittura");
        std::os::unix::fs::symlink(base.join("fuori.png"), root.join("Screenshot 1.png")).expect("link");
        let watch = watch_on(&root);

        assert!(check_shot(&watch, &root.join("Screenshot 1.png").to_string_lossy()).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn a_junction_to_a_folder_outside_is_not_in_the_delete_field() {
        let base = scratch("junction");
        let root = base.join("shots");
        let outside = base.join("fuori");
        std::fs::create_dir_all(&root).expect("cartella");
        std::fs::create_dir_all(&outside).expect("cartella fuori");
        std::fs::write(outside.join("Screenshot 3.png"), b"x").expect("scrittura");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("giunzione"))
            .arg(&outside)
            .output()
            .expect("cmd");
        assert!(made.status.success(), "mklink /J: {}", String::from_utf8_lossy(&made.stdout));
        let watch = watch_on(&root);

        let through = root.join("giunzione").join("Screenshot 3.png");
        assert!(through.exists(), "la giunzione porta al file");
        assert!(check_shot(&watch, &through.to_string_lossy()).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// An NTFS stream name after the file name cannot take a path out of the
    /// folder: whatever the check answers, the file it names is in the root.
    #[cfg(windows)]
    #[test]
    fn a_stream_name_does_not_take_a_path_out_of_the_folder() {
        let base = scratch("stream");
        let root = base.join("shots");
        std::fs::create_dir_all(&root).expect("cartella");
        std::fs::write(root.join("Screenshot 1.png"), b"x").expect("scrittura");
        let watch = watch_on(&root);

        for name in ["Screenshot 1.png::$DATA", "Screenshot 1.png:y.png"] {
            if let Ok(file) = check_shot(&watch, &root.join(name).to_string_lossy()) {
                let resolved = file.canonicalize().expect("percorso");
                assert_eq!(resolved.parent(), root.canonicalize().ok().as_deref(), "{name}");
            }
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    /// A root that is a junction to a disk root is not a root, whatever the
    /// text of the choice said.
    #[test]
    fn a_canonical_root_that_is_broad_is_dropped() {
        let base = scratch("broadroot");
        std::fs::write(base.join("Screenshot 1.png"), b"x").expect("scrittura");
        let resolved = base.join("Screenshot 1.png").canonicalize().expect("percorso");

        // With `base` as home, `base` itself is "the home folder".
        let home = base.canonicalize().expect("percorso");
        assert_eq!(shots_root_among(&[base.clone()], &resolved, Some(&home)), None);
        // With another home it is an ordinary folder.
        assert!(shots_root_among(&[base.clone()], &resolved, Some(Path::new("/home/nik"))).is_some());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn only_the_current_folder_may_be_watched_or_listed() {
        let watch = Watch::default();
        let current = PathBuf::from("/home/nik/Shots");
        *watch.picked.lock().expect("lucchetto") = Some((Instant::now(), Some(current)));

        assert!(is_current_dir(&watch, "/home/nik/Shots"));
        for other in ["/", "/home/nik", "/home/nik/Pictures", "C:\\", ""] {
            assert!(!is_current_dir(&watch, other), "{other}");
        }
        // Nothing chosen: nothing is current.
        *watch.picked.lock().expect("lucchetto") = Some((Instant::now(), None));
        assert!(!is_current_dir(&watch, "/home/nik/Shots"));
    }

    /// The Pictures folder itself is not a screenshots folder: in it only
    /// what is named like a screenshot counts, as on the Desktop.
    #[test]
    fn the_pictures_folder_and_the_desktop_do_not_hold_only_shots() {
        let pictures = PathBuf::from("/home/nik/Immagini");
        assert!(!holds_only_shots_in(&pictures, std::slice::from_ref(&pictures)));
        assert!(holds_only_shots_in(&pictures.join("Screenshots"), std::slice::from_ref(&pictures)));
        assert!(!holds_only_shots_in(Path::new("/home/nik/Desktop"), &[]));
        assert!(holds_only_shots_in(Path::new("/home/nik/Shots"), &[]));
    }

    /// Only folders of home named `OneDrive…` are roots: not files, not other
    /// folders (which the old code asked `is_dir` about one by one).
    #[test]
    fn only_the_onedrive_folders_of_home_are_roots() {
        let home = scratch("home");
        for dir in ["OneDrive", "OneDrive - Azienda", "Documents"] {
            std::fs::create_dir_all(home.join(dir)).expect("cartella");
        }
        std::fs::write(home.join("OneDrive.txt"), b"x").expect("scrittura");

        assert_eq!(
            one_drive_folders_in(&home),
            vec![home.join("OneDrive"), home.join("OneDrive - Azienda")]
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    /// A share is a name, not a question to the server.
    #[test]
    fn a_share_counts_as_a_folder_without_being_opened() {
        assert!(names_a_folder(Path::new(r"\\server\shots")));
        assert!(!names_a_folder(Path::new("/davvero/non/esiste")));
    }

    /// On the Desktop an unrelated picture is not a screenshot, so it must not
    /// make the Desktop look more recently used than the Screenshots folder.
    #[test]
    fn a_picture_on_the_desktop_does_not_beat_a_used_screenshots_folder() {
        let root = scratch("desktop");
        let desktop = root.join("Desktop");
        let used = root.join("Pictures").join("Screenshots");
        std::fs::create_dir_all(&desktop).expect("scrivania");
        std::fs::create_dir_all(&used).expect("cartella usata");
        image_at(&desktop, "vacanza.png", 1_800_000_000);
        image_at(&used, "Screenshot 1.png", 1_700_000_000);

        let found = pick_shot_dir(&[desktop, used.clone()], None);
        assert_eq!(found, Some(used));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_existing_folder_means_no_place_to_watch() {
        assert_eq!(pick_shot_dir(&[PathBuf::from("/davvero/non/esiste")], None), None);
    }

    /// The path is never opened: naming it is what lets the tray say the
    /// folder is on a share, and opening it would leak the user's credentials.
    #[test]
    fn a_share_is_named_even_when_it_is_not_read() {
        let share = PathBuf::from(r"\\server\shots");
        assert_eq!(pick_shot_dir(&[share.clone()], None), Some(share.clone()));
        assert_eq!(pick_shot_dir(&[], Some(&share)), Some(share));
    }

    #[test]
    fn a_choice_survives_the_file_it_is_written_to() {
        let root = scratch("saved");
        let file = root.join("config").join("screenshots-folder");
        let chosen = root.join("Scelte");
        std::fs::create_dir_all(&chosen).expect("cartella scelta");

        save_chosen(&file, &chosen).expect("salvataggio");
        assert_eq!(read_chosen(&file), Some(chosen));

        // An empty file is not a choice that was made.
        std::fs::write(&file, "  \n").expect("scrittura");
        assert_eq!(read_chosen(&file), None);

        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod name_tests {
    use super::*;

    fn desktop() -> PathBuf {
        PathBuf::from("/Users/nik/Desktop")
    }

    fn shots_folder() -> PathBuf {
        PathBuf::from("C:/Users/nik/Pictures/Screenshots")
    }

    /// Windows watches a Screenshots folder, so nothing there is filtered by name.
    #[test]
    fn a_screenshots_folder_holds_only_screenshots() {
        assert!(holds_only_shots(&shots_folder()));
        assert!(is_shot(&shots_folder(), &shots_folder().join("una foto qualsiasi.png")));
    }

    #[test]
    fn on_the_desktop_only_what_reads_as_a_screenshot() {
        for name in [
            "Screenshot 2026-09-17 at 21.43.13.png",
            "Screen Shot 2026-09-17 at 09.02.55.png",
            "Schermata 2026-09-17 alle 21.43.13.png",
            "Bildschirmfoto 2026-09-17 um 21.43.13.png",
            "Capture d'ecran 2026-09-17 a 21.43.13.png",
            "Nome scelto da me 2026-09-17 alle 21.43.13.png",
        ] {
            assert!(is_shot(&desktop(), &desktop().join(name)), "{name}");
        }

        for name in [
            "IMG_4821.jpeg",
            "logo.png",
            "vacanza 2026-08-14.png",
            "CV 2026.pdf",
            "appunti.txt",
        ] {
            assert!(!is_shot(&desktop(), &desktop().join(name)), "{name}");
        }
    }

    #[test]
    fn a_date_alone_is_not_one_and_neither_is_a_long_number() {
        assert!(!named_like_shot("2026-09-17.png"));
        assert!(!named_like_shot("20260917214313.png"));
        assert!(named_like_shot("2026-09-17 21.43.13.png"));
    }

    /// The watched folder decides, so nothing below it is one of its screenshots.
    #[test]
    fn a_folder_inside_the_desktop_is_not_the_desktop() {
        let inside = desktop().join("vecchie foto");
        assert!(!is_shot(&desktop(), &inside.join("foto.png")));
        assert!(!is_shot(&desktop(), &inside.join("Screenshot 2026-09-17 at 21.43.13.png")));
        assert!(!is_shot(&shots_folder(), &shots_folder().join("2025").join("a.png")));
    }

    /// The cap is on screenshots kept, not on entries read: a Desktop of
    /// thousands of files used to spend the whole budget before reaching one.
    #[test]
    fn a_crowded_folder_still_yields_its_screenshots() {
        let mut entries: Vec<PathBuf> = (0..8_000).map(|n| desktop().join(format!("foto-{n}.png"))).collect();
        entries.push(desktop().join("Schermata 2026-09-17 alle 21.43.13.png"));

        let kept = keep_shots(entries.into_iter(), &desktop(), MAX_KEPT);
        assert_eq!(kept, vec![desktop().join("Schermata 2026-09-17 alle 21.43.13.png")]);
    }

    #[test]
    fn what_is_kept_is_capped() {
        let entries: Vec<PathBuf> = (0..MAX_KEPT + 10)
            .map(|n| shots_folder().join(format!("{n}.png")))
            .collect();
        assert_eq!(keep_shots(entries.into_iter(), &shots_folder(), MAX_KEPT).len(), MAX_KEPT);
    }

    #[test]
    fn a_screenshot_is_still_only_an_image() {
        assert!(!is_shot(&desktop(), &desktop().join("Screenshot 2026-09-17 at 21.43.13.txt")));
        assert!(!is_shot(&shots_folder(), &shots_folder().join("thumbs.db")));
    }
}
