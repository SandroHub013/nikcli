//! Sessions talking to each other, whatever CLI each one runs.
//!
//! No CLI has a way to talk to another CLI, and ADE cannot add one to each of
//! them. What they all have is a shell tool and a terminal, so the channel is
//! built from exactly those two things:
//!
//! - every session ADE starts finds `ade-msg` on its PATH, from a folder beside
//!   the mailbox, with its own pane id in `ADE_PANE_ID`, the secret that proves it
//!   in `ADE_PANE_TOKEN`, and the mailbox in `ADE_MAILBOX`;
//! - `ade-msg send|ask|spawn|reply` drops a JSON file in `outbox/` and waits
//!   for a receipt; `ade-msg list` and `agents` print what ADE last published;
//! - every session can write in this folder, so what `ade-msg` posts and what it
//!   reads carries a MAC keyed by the pane's token (`src/session/mail-seal.ts`):
//!   a file another session dropped here is not believed, and the token itself is
//!   never in the folder;
//! - the frontend takes the outbox, types each message into the target pane's
//!   terminal as if the user had, and writes the receipt;
//! - `ask` and `spawn` then keep waiting, the way a subagent call does, for
//!   `results/<id>.txt`, which ADE writes when the other session runs
//!   `ade-msg reply <id>`. The waiter claims it by renaming it; one that is
//!   still there a moment later had nobody waiting, and ADE takes it back
//!   (`<id>.typed`) and types it into the caller instead;
//! - for orchestration, `--no-wait` returns the id at once and `wait` takes
//!   several; ADE writes `results/<id>.state` when what a request waits on
//!   changes (a permission prompt, say) and publishes `requests.txt` for
//!   `status`. `cancel`, `close` and `spawn --close` are messages like the rest.
//!
//! This side only moves files. Deciding who a message is for, and what it
//! looks like when it lands, is `src/session/mailbox.ts`, where it is tested.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use tauri::Manager;

const MAILBOX_SUBDIR: &str = "mailbox";

/// Receipts and results nobody collected are removed after this long.
const LEFTOVER_TTL: Duration = Duration::from_secs(60 * 60 * 24);

/// A message larger than this is not a message; the file is dropped unread and its sender told.
///
/// Room for the longest text the frontend accepts (40,000 characters) even
/// when every one is four bytes of UTF-8, plus the JSON around it.
const MAX_MESSAGE_BYTES: u64 = 256 * 1024;

/// Set by `bun run test:app` to give each worktree's ADE Test its own mailbox.
const MAILBOX_ROOT_ENV: &str = "ADE_MAILBOX_ROOT";

/// Where the mailbox is: the app's data directory, or for a test build the
/// absolute folder in `ADE_MAILBOX_ROOT`.
///
/// Every ADE Test shares one identifier, so without this two of them, from
/// two worktrees, shared a mailbox: each took the other's messages and the
/// last one started rewrote `ade-msg` with its own version (S25). The
/// official ADE never reads the variable, so a session that inherits it
/// cannot move the user's mailbox.
fn choose_root(test_build: bool, env: Option<std::ffi::OsString>, default: Option<PathBuf>) -> Option<PathBuf> {
    let custom = env.map(PathBuf::from).filter(|path| path.is_absolute());
    match (test_build, custom) {
        (true, Some(path)) => Some(path),
        _ => default,
    }
}

pub fn mailbox_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = choose_root(
        crate::is_test_build(app),
        std::env::var_os(MAILBOX_ROOT_ENV),
        app.path().app_local_data_dir().ok().map(|data| data.join(MAILBOX_SUBDIR)),
    )?;
    for sub in ["outbox", "receipts", "results"] {
        fs::create_dir_all(dir.join(sub)).ok()?;
    }
    Some(dir)
}

/// Where the scripts go for a mailbox at `mailbox`: beside it, never inside.
///
/// Every session runs them and every session can write in the mailbox, so in there one
/// session could rewrite the `ade-msg` the others run, and an agent a CLI sandboxes, with
/// write access to the mailbox only, would get out through a session that is not. Per
/// mailbox, since an ADE Test of another worktree has its own version of the scripts (S25).
fn bin_beside(mailbox: &Path) -> Option<PathBuf> {
    let name = mailbox.file_name()?.to_string_lossy();
    Some(mailbox.with_file_name(if name == MAILBOX_SUBDIR { "bin".to_string() } else { format!("{name}-bin") }))
}

/// The directory prepended to every session's PATH.
pub fn bin_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let bin = bin_beside(&mailbox_path(app)?)?;
    fs::create_dir_all(&bin).ok()?;
    Some(bin)
}

/// Writes the `ade-msg` scripts and clears old leftovers. Called at startup.
///
/// Rewritten every launch rather than only when missing, so a session always
/// runs the version that matches the ADE that will read its messages.
pub fn install(app: &tauri::AppHandle) {
    let Some(dir) = mailbox_path(app) else { return };
    let Some(bin) = bin_dir(app) else { return };
    // Where an older ADE put them: nothing has them on its PATH any more, and they would not read today's mail.
    let _ = fs::remove_dir_all(dir.join("bin"));
    // And the lists and help texts, which used to be published in the mailbox itself, where any session could replace them.
    for name in PUBLISHED {
        let _ = fs::remove_file(dir.join(format!("{name}.txt")));
    }
    let _ = fs::write(bin.join("ade-msg.ps1"), PS1);
    let _ = fs::write(bin.join("ade-msg.cmd"), CMD);
    let _ = fs::write(bin.join("ade-msg"), SH);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(bin.join("ade-msg"), fs::Permissions::from_mode(0o755));
    }

    clear_leftovers(&dir, SystemTime::now());
}

fn clear_leftovers(dir: &Path, now: SystemTime) {
    // Read messages are kept a day, like receipts, then go. An unread one stays however old: only the page knows what it
    // left there, and a brief unread over a weekend must not come back as a request closed as lost.
    let handled = fs::read_dir(dir.join("inbox"))
        .map(|panes| panes.flatten().map(|pane| pane.path().join("handled")).collect::<Vec<_>>())
        .unwrap_or_default();
    for folder in [dir.join("receipts"), dir.join("results")].into_iter().chain(handled) {
        let Ok(entries) = fs::read_dir(folder) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            let old = meta
                .modified()
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > LEFTOVER_TTL);
            if old && meta.is_file() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// What the page's mail round runs on, besides its own timer.
const PENDING_EVENT: &str = "mailbox:pending";

/// How often the outbox is looked at: a `read_dir` of a folder that is nearly always empty.
const WATCH_EVERY: Duration = Duration::from_millis(200);

/// The least time between two signals, unless new mail has just appeared.
const SIGNAL_GAP: Duration = Duration::from_secs(1);

fn outbox_has_mail(outbox: &Path) -> bool {
    fs::read_dir(outbox).is_ok_and(|mut entries| {
        entries.any(|entry| entry.is_ok_and(|entry| entry.path().extension().is_some_and(|ext| ext == "json")))
    })
}

/// Whether to signal the page now, and with what: `true` for mail in the outbox, `false` for the pulse a second.
///
/// The pulse goes out whatever the window looks like, and the page drops it while it is visible (`pulseRuns`). Only the
/// page can tell a window that another one covers: it was left on a timer Chromium had slowed to one a minute.
fn pending_signal(mail: bool, mail_before: bool, since_last: Duration) -> Option<bool> {
    if mail && (!mail_before || since_last >= SIGNAL_GAP) {
        return Some(true);
    }
    (since_last >= SIGNAL_GAP).then_some(false)
}

/// Tells the page when to run its mail round, from a thread no page throttling can reach.
///
/// The round was only a page timer. A minimised window has been `hidden` since
/// P1-C1, and Chromium wakes a hidden page's chained timers once a minute after 5
/// minutes, so every `ade-msg kv` hit its 10 s and printed «ADE non ha risposto»
/// (2026-10-30). An event is script the host runs, and it runs at once in a hidden
/// page. So the throttling stays on, with everything it saves in CPU and memory
/// while hidden, and only the mail stops depending on it.
pub fn watch_outbox(app: tauri::AppHandle) {
    let Some(dir) = mailbox_path(&app) else { return };
    let outbox = dir.join("outbox");
    let started = std::thread::Builder::new().name("ade-mailbox-watch".into()).spawn(move || {
        use tauri::Emitter;
        let mut mail_before = false;
        let mut last = Instant::now();
        loop {
            std::thread::sleep(WATCH_EVERY);
            let mail = outbox_has_mail(&outbox);
            if let Some(waiting) = pending_signal(mail, mail_before, last.elapsed()) {
                let _ = app.emit(PENDING_EVENT, waiting);
                last = Instant::now();
            }
            mail_before = mail;
        }
    });
    if let Err(error) = started {
        eprintln!("ADE: la posta non ha il suo segnale nativo, resta il timer della pagina: {error}");
    }
}

/// A message id names a file, so it is held to a shape that cannot be a path.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Puts a script in the folder.
fn put_script(dir: &Path, name: &str, text: &str) -> Result<bool, String> {
    fs::write(dir.join(name), text).map_err(|e| format!("scrittura fallita: {e}"))?;
    Ok(true)
}

/// Writes `dir/<name>` whole: a reader polling for the final name never sees half of it.
fn write_whole(dir: PathBuf, name: &str, text: &str) -> Result<(), String> {
    let part = dir.join(format!("{name}.part"));
    fs::write(&part, text).map_err(|e| format!("scrittura fallita: {e}"))?;
    fs::rename(&part, dir.join(name)).map_err(|e| format!("scrittura fallita: {e}"))
}

#[derive(Serialize)]
pub struct Outgoing {
    id: String,
    /// The JSON the script wrote, unparsed: judging it is the frontend's job.
    body: String,
}

/// Takes every complete message out of the outbox.
///
/// Only `*.json`: the scripts write `*.part` and rename, so a file with the
/// final name is always whole. Each one is claimed by a rename before it is
/// read, and removed once read, which is what makes a message delivered at
/// most once; a read that failed for a passing reason leaves it for the next pass.
#[tauri::command]
pub async fn mailbox_take(app: tauri::AppHandle) -> Result<Vec<Outgoing>, String> {
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?;
    take_outbox(&dir.join("outbox"), &dir.join("receipts"), Instant::now())
}

/// The page's word: it holds these messages on disk, and they can go.
#[tauri::command]
pub async fn mailbox_taken(app: tauri::AppHandle, ids: Vec<String>) -> Result<(), String> {
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?;
    confirm_taken(&dir.join("outbox"), &ids);
    Ok(())
}

/// A page has gone, with what it was handed and had not confirmed: the next one gets it.
pub fn give_back_handed(app: &tauri::AppHandle) {
    if let Some(dir) = mailbox_path(app) {
        give_back_all(&dir.join("outbox"));
    }
}

/// The outbox read, and a receipt for every message refused for its size.
///
/// A refused message used to vanish: the sender waited for a receipt that
/// never came and printed "ADE non ha ancora confermato", as if it would.
/// The receipt for a message not read because of its size.
fn too_big_receipt(len: u64) -> String {
    let max = MAX_MESSAGE_BYTES / 1024;
    format!(
        "errore: messaggio troppo grande ({} KiB, massimo {max} KiB): mandalo come file con --file o scrivilo in un file e manda il percorso",
        len / 1024
    )
}

/// The ids this process read (or answered with a receipt) whose `.taking` could not be deleted.
///
/// Only these claims are deleted when found again. Any other `.taking` is a message that was claimed and never read
/// (the process died, or the read and the give-back both failed): it goes back to `.json`, so it is delivered and
/// not lost without a word. The cost is a duplicate if a delete failed and the process then died, which is rare.
fn undeleted() -> std::sync::MutexGuard<'static, std::collections::HashSet<String>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = std::sync::OnceLock::new();
    SET.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// How far a claimed message has got, for as long as its `.taking` stands in this process.
#[derive(Clone, Copy)]
enum Claim {
    /// A take has claimed it and has not finished with it.
    Reading,
    /// Read and returned to the page, at this moment; the page has not said it holds it yet.
    Handed(Instant),
}

/// The claims of this process. One map for every take, as `undeleted`, so that two takes at once know of each other.
fn claims() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, Claim>> {
    static MAP: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Claim>>> = std::sync::OnceLock::new();
    MAP.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// How long a message handed to the page may wait for the page's word before it goes back in the outbox.
const UNCONFIRMED_AFTER: Duration = Duration::from_secs(30);

/// Deletes what the page says it now holds, and only what was handed to it.
fn confirm_taken(outbox: &Path, ids: &[String]) {
    for id in ids {
        if !valid_id(id) {
            continue;
        }
        let handed = matches!(claims().get(id), Some(Claim::Handed(_)));
        if handed {
            finish_claim(&outbox.join(format!("{id}.taking")), id);
            claims().remove(id);
        }
    }
}

/// Every message handed to a page that never confirmed it, back in the outbox.
fn give_back_all(outbox: &Path) {
    let Ok(entries) = fs::read_dir(outbox) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("taking") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        let handed = matches!(claims().get(&id), Some(Claim::Handed(_)));
        if handed && fs::rename(&path, path.with_extension("json")).is_ok() {
            claims().remove(&id);
        }
    }
}

/// Deletes a claim that has been dealt with; if that fails, remembers it so it is never delivered again.
fn finish_claim(claim: &std::path::Path, id: &str) {
    if fs::remove_file(claim).is_err() {
        undeleted().insert(id.to_string());
    }
}

/// Takes the files of the outbox, one claimed at a time.
///
/// A file is claimed by renaming `<id>.json` to `<id>.taking`: the rename either
/// happens or it does not, and a file that is not `.json` is never taken again.
/// That is what lets a failed delete leave a harmless file instead of a message
/// delivered twice, and a transient read error leave the message for the next
/// pass instead of being answered as if it were damaged (RS-10).
///
/// A message read stays as its `.taking` until the page says it has it
/// (`mailbox_taken`): one taken by a page that then went was lost. It comes back
/// if that word does not come, at the next page load or after `UNCONFIRMED_AFTER`,
/// and the page knows a copy when it sees one (`session/mail-taken.ts`).
fn take_outbox(outbox: &std::path::Path, receipts: &std::path::Path, now: Instant) -> Result<Vec<Outgoing>, String> {
    let mut out = Vec::new();
    // What this call claimed itself: a claim given back must not be taken twice in the same pass.
    let mut claimed_here = std::collections::HashSet::new();
    let entries = fs::read_dir(outbox).map_err(|e| format!("casella non leggibile: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        match path.extension().and_then(|e| e.to_str()) {
            Some("json") => {}
            // A claim found again: cleared if this process already read it, otherwise it was never read and goes back.
            Some("taking") => {
                let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
                    continue;
                };
                if claimed_here.contains(&id) {
                    continue;
                }
                // Its own statement: the guard must be gone before the arms take it again.
                let state = claims().get(&id).copied();
                match state {
                    // Another take is reading it: what becomes of it is decided there, and a rename now would pull it from under that read.
                    Some(Claim::Reading) => continue,
                    Some(Claim::Handed(at)) if now.saturating_duration_since(at) < UNCONFIRMED_AFTER => continue,
                    Some(Claim::Handed(_)) => {
                        if fs::rename(&path, path.with_extension("json")).is_ok() {
                            claims().remove(&id);
                        }
                        continue;
                    }
                    None => {}
                }
                if !valid_id(&id) || undeleted().contains(&id) {
                    if fs::remove_file(&path).is_ok() {
                        undeleted().remove(&id);
                    }
                } else {
                    let _ = fs::rename(&path, path.with_extension("json"));
                }
                continue;
            }
            _ => continue,
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        if !valid_id(&id) {
            let _ = fs::remove_file(&path);
            continue;
        }
        // Given back a moment ago in this very pass: the next pass tries it again, this one does not loop on it.
        if claimed_here.contains(&id) {
            continue;
        }
        // Held open by a scanner or the indexer: it is still there, so the next pass takes it.
        let claim = path.with_extension("taking");
        // Before the rename: a take that finds the `.taking` must already know it is being read.
        {
            let mut map = claims();
            if map.contains_key(&id) {
                continue;
            }
            map.insert(id.clone(), Claim::Reading);
        }
        if fs::rename(&path, &claim).is_err() {
            claims().remove(&id);
            continue;
        }
        claimed_here.insert(id.clone());
        // Nothing below deletes the message unless it has been read, or can never be.
        let give_back = || {
            let _ = fs::rename(&claim, &path);
            claims().remove(&id);
        };
        let Ok(meta) = fs::metadata(&claim) else {
            give_back();
            continue;
        };
        if meta.len() > MAX_MESSAGE_BYTES {
            let said = too_big_receipt(meta.len());
            let _ = write_whole(receipts.to_path_buf(), &format!("{id}.txt"), &said);
            finish_claim(&claim, &id);
            claims().remove(&id);
            continue;
        }
        match fs::read_to_string(&claim) {
            Ok(body) => {
                // Not deleted: that waits for the page's word, once it holds the message.
                claims().insert(id.clone(), Claim::Handed(now));
                out.push(Outgoing { id: id.clone(), body });
            }
            // Bytes that are not UTF-8 will never be: the sender is told. Any other error may pass.
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                let _ = write_whole(receipts.to_path_buf(), &format!("{id}.txt"), "errore: messaggio non leggibile (non è UTF-8)");
                finish_claim(&claim, &id);
                claims().remove(&id);
            }
            Err(_) => give_back(),
        }
    }
    Ok(out)
}

/// The mailbox folder, for the frontend code that writes to it directly (the voice outbox).
#[tauri::command]
pub async fn mailbox_dir(app: tauri::AppHandle) -> Result<String, String> {
    mailbox_path(&app)
        .map(|dir| dir.to_string_lossy().into_owned())
        .ok_or_else(|| "casella non disponibile".into())
}

/// Tells the waiting `ade-msg` what happened to its message.
#[tauri::command]
pub async fn mailbox_receipt(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id messaggio non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("receipts");
    write_whole(dir, &format!("{id}.txt"), &text)
}

/// The answer to request `id`, for the `ade-msg ask|spawn|wait` blocked on it.
#[tauri::command]
pub async fn mailbox_result(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id richiesta non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("results");
    write_whole(dir, &format!("{id}.txt"), &text)
}

/// Takes back an answer nobody claimed, and returns it to be typed instead.
///
/// A rename, like the waiter's claim, so exactly one of the two wins. What is
/// kept is a `.closed` copy, not the `.txt` a waiter takes: a later `ade-msg
/// wait` says the request is closed, at once, rather than answering it anew.
#[tauri::command]
///
/// `kind: "update"` does the same for an `ade-msg update` no waiter woke on;
/// that one is not kept, since a later `wait` should wait for the answer.
pub async fn mailbox_result_reclaim(app: tauri::AppHandle, id: String, kind: Option<String>) -> Result<Option<String>, String> {
    if !valid_id(&id) {
        return Err("id richiesta non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("results");
    if kind.as_deref() == Some("update") {
        let taken = dir.join(format!("{id}.update-typed"));
        if fs::rename(dir.join(format!("{id}.update")), &taken).is_err() {
            return Ok(None);
        }
        let text = fs::read_to_string(&taken).ok();
        let _ = fs::remove_file(&taken);
        return Ok(text);
    }
    Ok(reclaim_result(&dir, &id))
}

/// The answer in `dir/<id>.txt`, taken back from the waiter it was left for.
///
/// Kept as `<id>.closed`, as a waiter keeps what it took: a later `ade-msg
/// wait` on the id says at once that the request is closed, with its answer,
/// instead of waiting its whole timeout for a file already gone and then
/// saying «in corso» (ROADMAP, BASSO). Removed with the other leftovers.
fn reclaim_result(dir: &std::path::Path, id: &str) -> Option<String> {
    let typed = dir.join(format!("{id}.typed"));
    if fs::rename(dir.join(format!("{id}.txt")), &typed).is_err() {
        return None;
    }
    let text = fs::read_to_string(&typed).ok();
    if fs::rename(&typed, dir.join(format!("{id}.closed"))).is_err() {
        let _ = fs::remove_file(&typed);
    }
    text
}

/// What request `id` is waiting on, for the `ade-msg wait` blocked on it to
/// print when it changes ("attende un permesso"). Empty text removes it.
#[tauri::command]
///
/// `kind: "update"` writes `<id>.update` instead: an `ade-msg update` from the
/// answering session, which wakes the waiter rather than being printed beside it.
pub async fn mailbox_state(app: tauri::AppHandle, id: String, text: String, kind: Option<String>) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id richiesta non valido".into());
    }
    let ext = match kind.as_deref() {
        None | Some("state") => "state",
        Some("update") => "update",
        Some(_) => return Err("tipo di stato sconosciuto".into()),
    };
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("results");
    if text.is_empty() {
        let _ = fs::remove_file(dir.join(format!("{id}.{ext}")));
        return Ok(());
    }
    write_whole(dir, &format!("{id}.{ext}"), &text)
}

/// Leaves a long message in `inbox/<pane>/<name>.msg`, for `ade-msg inbox` to print.
///
/// Typed into a terminal, a long message was taken for a paste and its Enter
/// lost (S17); here only a short bell is typed, and the text waits as a file.
#[tauri::command]
pub async fn mailbox_inbox_put(app: tauri::AppHandle, pane: String, name: String, text: String) -> Result<(), String> {
    if !valid_id(&pane) || !valid_id(&name) {
        return Err("id non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("inbox").join(&pane);
    fs::create_dir_all(dir.join("handled")).map_err(|e| format!("inbox non creata: {e}"))?;
    write_whole(dir, &format!("{name}.msg"), &text)
}

/// Where the message is: `unread` still in the inbox, `read` in `handled/`
/// (where `ade-msg inbox` moves what it prints), `lost` in neither.
///
/// The first version answered "read" for anything no longer in the inbox, so
/// a file deleted by hand passed for read and nobody was told: the same
/// silent loss S70's review found in the native handoff. Whoever waits must
/// never believe a thing arrived when it did not.
#[tauri::command]
pub async fn mailbox_inbox_read(app: tauri::AppHandle, pane: String, name: String) -> Result<String, String> {
    if !valid_id(&pane) || !valid_id(&name) {
        return Err("id non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("inbox").join(&pane);
    let file = format!("{name}.msg");
    /*
     * `try_exists`, not `exists`: `exists` swallows every I/O error into
     * "no", so a permission denied on either folder would have come back as
     * "lost" — the one thing this command must never say by mistake, because
     * "lost" is what makes the sender resend. An error is an error; the
     * caller keeps waiting and asks again.
     */
    let present = |path: std::path::PathBuf| path.try_exists().map_err(|e| format!("casella non leggibile ({}): {e}", path.display()));
    Ok(if present(dir.join(&file))? {
        "unread"
    } else if present(dir.join("handled").join(&file))? {
        "read"
    } else {
        "lost"
    }
    .to_string())
}

/// The text of a message still in the inbox, `None` once it has gone: what ADE reads to seal it again when the pane
/// gets a new token, or the new process would take its own unread mail for false.
#[tauri::command]
pub async fn mailbox_inbox_text(app: tauri::AppHandle, pane: String, name: String) -> Result<Option<String>, String> {
    if !valid_id(&pane) || !valid_id(&name) {
        return Err("id non valido".into());
    }
    let dir = mailbox_path(&app).ok_or("casella non disponibile")?.join("inbox").join(&pane);
    read_if_there(&dir.join(format!("{name}.msg")))
}

fn read_if_there(path: &Path) -> Result<Option<String>, String> {
    // The inbox is a folder any session can write in: a file over the cap is not read into memory and handed to the page,
    // which would hold it (and seal it again) whole. It counts as gone, as the outbox reader treats the same size.
    if fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_MESSAGE_BYTES) {
        return Ok(None);
    }
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("messaggio non leggibile: {e}")),
    }
}

/// The lists and help texts `mailbox_publish` writes, one `<name>.txt` each, next to the scripts.
const PUBLISHED: [&str; 7] = ["sessions", "agents", "requests", "usage", "usage-design", "usage-decisioni", "stats"];

/// Publishes a list `ade-msg` prints: `sessions` for `list`, `agents` for
/// `agents`, `requests` for `status`, `usage` for the help text (`usage-design`,
/// `usage-decisioni` for `help design` and `help decisioni`).
#[tauri::command]
pub async fn mailbox_publish(app: tauri::AppHandle, name: Option<String>, text: String) -> Result<(), String> {
    let name = match name.as_deref() {
        None | Some("sessions") => "sessions",
        Some("agents") => "agents",
        Some("requests") => "requests",
        Some("usage") => "usage",
        Some("usage-design") => "usage-design",
        Some("usage-decisioni") => "usage-decisioni",
        Some("stats") => "stats",
        Some(_) => return Err("elenco sconosciuto".into()),
    };
    // Beside the scripts, not in the mailbox: any session can write in the mailbox, so a list left there could be a forged
    // one. The folder the scripts run from is ADE's alone.
    let dir = bin_dir(&app).ok_or("casella non disponibile")?;
    write_whole(dir, &format!("{name}.txt"), &text)
}

/// Windows: the implementation. Plain PowerShell 5.1, no modules.
///
/// `$args`, not a `param` block: with named parameters a message containing
/// `-To` or `-Command` would be bound as one of them.
const PS1: &str = r#"# ade-msg — talk to the other ADE sessions. Written by ADE; do not edit.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$utf8 = New-Object Text.UTF8Encoding $false
$box = $env:ADE_MAILBOX
if (-not $box -or -not (Test-Path $box)) { [Console]::Error.WriteLine('ade-msg: questa shell non e'' una sessione avviata da ADE (ADE_MAILBOX mancante).'); exit 2 }

function Usage {
  $f = Join-Path $PSScriptRoot 'usage.txt'
  if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'uso: ade-msg list | send | ask | spawn | reply | wait | status | cancel | close | agents | whoami | registro | design proponi' }
  exit 1
}
function Fail($message) { [Console]::Error.WriteLine("ade-msg: $message"); exit 1 }
# A probe that cannot fail. Under 'Stop' a denied Test-Path (a caller at a
# lower integrity level than the mailbox) was a screenful of PowerShell error.
function Has($path) { try { return [IO.File]::Exists($path) } catch { return $false } }

# Any session can write in the mailbox. So what ADE leaves for this session starts with a MAC keyed by this session's
# own token, which the others do not have, and what this session posts is signed the same way (mail-seal.ts).
function Mac($kind, $id, $body) {
  $hmac = New-Object Security.Cryptography.HMACSHA256 (, $utf8.GetBytes([string]$env:ADE_PANE_TOKEN))
  $hash = $hmac.ComputeHash($utf8.GetBytes("$kind`n$id`n$body"))
  return ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}
# The text of a file ADE wrote for this session as $kind of $id; $null for any other file. With no token nothing is
# believed: anybody can sign with an empty key.
function Sealed($kind, $id, $file) {
  if (-not $env:ADE_PANE_TOKEN -or -not $file -or -not $file.StartsWith('ade-mac1 ') -or $file.IndexOf("`n") -ne 73) { return $null }
  $body = $file.Substring(74)
  if ($file.Substring(9, 64) -cne (Mac $kind $id $body)) { return $null }
  return $body
}
# Said once for each file: a forged one must not fill a wait that looks at it four times a second.
$refused = @{}
function Refused($what, $id) {
  if ($refused["$what $id"]) { return }
  $refused["$what $id"] = $true
  [Console]::Error.WriteLine("ade-msg: ignoro $what $id`: non e' firmato per questa sessione, e lo lascio dov'e'. Se e' di un'altra sessione resta a lei; se no qualcuno ha messo un falso nella casella.")
}
# wait and inbox read only what is signed for this session, and with no token that is nothing: stopped before a file is touched.
function NeedToken {
  if ($env:ADE_PANE_TOKEN) { return }
  [Console]::Error.WriteLine("ade-msg: ADE_PANE_TOKEN mancante: ADE non puo' riconoscere questa shell, lancia ade-msg dal terminale di un pannello di ADE.")
  exit 2
}
# The text of a file, $null when it has gone or is held open: another process may have just taken it.
function ReadFile($path) { try { return [IO.File]::ReadAllText($path, $utf8) } catch { return $null } }
# Sealed, and said once if the file is still there and fails. Nothing that fails is moved or removed: it may be the real
# one for the session it is signed for.
function Checks($kind, $id, $path, $what) {
  $r = Sealed $kind $id (ReadFile $path)
  if ($null -eq $r -and (Has $path)) { Refused $what $id }
  return $r
}

$all = @($args | ForEach-Object { [string]$_ })
$cmd = if ($all.Count -gt 0) { $all[0] } else { '' }
# -h/--help anywhere prints the help and posts nothing. An argument that is only
# an option is never text: a typo must not become a message. After a lone --
# everything is positional again, so a text that starts with -- can still be sent.
$wantHelp = $false
$options = $true
if ($cmd -eq '-h' -or $cmd -eq '--help') { $wantHelp = $true; $cmd = '' }
elseif ($cmd -eq '--') { $options = $false; $cmd = '' }
elseif ($cmd.StartsWith('--')) { Fail "opzione sconosciuta: $cmd" }
$timeout = 110
$timeoutSet = $false
$attendi = $false
$noWait = $false
$any = $false
$close = $false
$worktree = $false
$force = $false
$fresh = $false
$fork = $false
$fromStdin = $false
$ttl = 0
$name = $null
$model = $null
$base = $null
$note = $null
$effort = $null
$profile = $null
$file = $null
$via = $null
$budget = $null
$title = $null
# update takes an id and a state before its text, kv an operation and a key, memory an operation and a type,
# registro a register and an operation; everything else one word.
$lead = if ($cmd -eq 'update' -or $cmd -eq 'kv' -or $cmd -eq 'memory' -or $cmd -eq 'registro') { 2 } else { 1 }
$pos = New-Object System.Collections.Generic.List[string]
for ($i = 1; $i -lt $all.Count; $i++) {
  $a = $all[$i]
  # Options anywhere: agents write them after the text as often as before it.
  if ($options) {
    $hasNext = ($i + 1) -lt $all.Count
    if ($a -eq '-h' -or $a -eq '--help') { $wantHelp = $true; continue }
    elseif ($a -eq '--') { $options = $false; continue }
    elseif ($a -eq '--timeout' -and $hasNext) { try { $timeout = [int]$all[$i + 1]; $timeoutSet = $true } catch { Usage }; $i++; continue }
    elseif ($a -eq '--file' -and $hasNext) { $file = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--name' -and $hasNext) { $name = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--model' -and $hasNext) { $model = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--base' -and $hasNext) { $base = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--note' -and $hasNext) { $note = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--effort' -and $hasNext) { $effort = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--profile' -and $hasNext) { $profile = $all[$i + 1]; $i++; continue }
    elseif ($a -eq '--title' -and $hasNext) { $title = $all[$i + 1]; $i++; continue }
    # D73: seconds, a whole number from 60 to 14400; anything else is a usage error.
    elseif ($a -eq '--budget' -and $hasNext) { $b = 0; if ($all[$i + 1] -notmatch '^[1-9][0-9]*$' -or -not [int]::TryParse($all[$i + 1], [ref]$b) -or $b -lt 60 -or $b -gt 14400) { Usage }; $budget = $b; $i++; continue }
    elseif ($a -eq '--attendi') { $attendi = $true; continue }
    elseif ($a -eq '--no-wait') { $noWait = $true; continue }
    elseif ($a -eq '--any') { $any = $true; continue }
    elseif ($a -eq '--close') { $close = $true; continue }
    elseif ($a -eq '--worktree') { $worktree = $true; continue }
    elseif ($a -eq '--force') { $force = $true; continue }
    elseif ($a -eq '--fresh') { $fresh = $true; continue }
    elseif ($a -eq '--fork') { $fork = $true; continue }
    elseif ($a -eq '--stdin') { $fromStdin = $true; continue }
    elseif ($a -eq '--digita') { $via = 'typed'; continue }
    elseif ($a -eq '--ttl' -and $hasNext) { try { $ttl = [int]$all[$i + 1] } catch { Usage }; $i++; continue }
    elseif ($a.StartsWith('--')) {
      # A known option with no value after it is still a usage error, said as such.
      if (@('--timeout', '--file', '--name', '--model', '--base', '--note', '--effort', '--profile', '--title', '--budget', '--ttl') -contains $a) { Usage }
      Fail "opzione sconosciuta: $a"
    }
  }
  $pos.Add($a)
}
$head = if ($pos.Count -gt 0) { $pos[0] } else { '' }
$second = if ($pos.Count -gt 1) { $pos[1] } else { '' }
$text = if ($pos.Count -gt $lead) { ($pos.GetRange($lead, $pos.Count - $lead)) -join ' ' } else { '' }

# -h/--help: the help of the command it follows, and nothing is posted. It goes
# through the same `help` branch below, so the text and its fallback stay in one place.
# --file and --stdin are not read: with --help the answer is the help, not an error.
if ($wantHelp) {
  if ($cmd -eq 'design' -or $cmd -eq 'decisioni') { $head = $cmd }
  $file = $null
  $fromStdin = $false
  $cmd = 'help'
}

# --file: the text is the file. One too big for a message is sent as its path and its beginning.
if ($file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Fail "file non trovato: $file" }
  $item = Get-Item -LiteralPath $file
  $content = [IO.File]::ReadAllText($item.FullName, $utf8)
  if ($content.Length -gt 40000) {
    $content = "Il contenuto completo e' nel file $($item.FullName) ($($item.Length) byte); leggilo da li'. Inizio:`n" + $content.Substring(0, 1500)
  }
  $text = if ($text) { "$text`n`n$content" } else { $content }
}

# --stdin: the text from stdin, as UTF-8, where no quoting can reach it (SEC2-1). In bash a quoted heredoc
# (<<'EOF') runs nothing, whatever the text holds; an apostrophe in a single-quoted argument would break it, and
# the double quotes an agent falls back to run backticks and $(...). Through ade-msg.cmd and -File, PowerShell 5.1
# also drops the inner quotes of a '<json>' argument. A lone '-' cannot say it: PowerShell takes it for a
# parameter with no name.
if ($fromStdin -and (@('registro', 'send', 'reply', 'ask', 'spawn', 'update', 'kv', 'memory') -contains $cmd)) {
  if ([Console]::IsInputRedirected) {
    # A pipe or a heredoc: the bytes as they are. ($input would do too, but it splits them into lines and loses the CRs.)
    $ms = New-Object IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($ms)
    $piped = $utf8.GetString($ms.ToArray()).TrimStart([char]0xFEFF).Trim()
  } else {
    # No $input anywhere in this script, on purpose: the mere mention makes the host read stdin into the pipeline
    # before the script starts, and the bytes above are gone (and a pipeline splits them into lines, losing the CRs).
    Fail "--stdin: nessun testo in ingresso (una pipe, o in bash <<'EOF' ... EOF)"
  }
  # registro takes the JSON from here alone; the others join it to the text on the command line, as --file does.
  $text = if ($cmd -ne 'registro' -and $text) { "$text`n`n$piped" } else { $piped }
}

function Post($fields) {
  NeedToken
  $id = ('{0}-{1}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), ([guid]::NewGuid().ToString('N').Substring(0, 8)))
  # Past one message ADE would cut the text; the whole of it goes to a file the recipient can read.
  $long = [string]$fields['text']
  if ($long.Length -gt 40000) {
    $path = Join-Path (Join-Path $box 'results') "$id.long.txt"
    [IO.File]::WriteAllText($path, $long, $utf8)
    $fields['text'] = "Testo completo ($($long.Length) caratteri) in $path, leggilo da li'. Inizio: " + $long.Substring(0, 1500)
  }
  $fields['from'] = $env:ADE_PANE_ID
  $json = $fields | ConvertTo-Json -Compress
  $out = Join-Path $box 'outbox'
  $part = Join-Path $out "$id.part"
  [IO.File]::WriteAllText($part, "ade-mac1 $(Mac 'outbox' $id $json)`n$json", $utf8)
  Move-Item -LiteralPath $part -Destination (Join-Path $out "$id.json")
  return $id
}

# The receipt: what ADE did with the message. $null when ADE has not answered yet.
function Receipt($id) {
  for ($i = 0; $i -lt 50; $i++) {
    $r = TakeReceipt $id
    if ($null -ne $r) { return $r }
    Start-Sleep -Milliseconds 200
  }
  # Still not signed: ADE does not know this process's key, or another session wrote it. An ok is not believed; a refusal
  # is said as what it is, since that is how ADE answers a sender it cannot prove.
  $receipt = Join-Path (Join-Path $box 'receipts') "$id.txt"
  $left = ReadFile $receipt
  if (-not $left) { return $null }
  Remove-Item -LiteralPath $receipt -ErrorAction SilentlyContinue
  $line = (($left -split "`n")[0] -replace '[\x00-\x1f\x7f]', ' ').Trim()
  if (-not $line -or $line.StartsWith('ok') -or $line.StartsWith('ade-mac1 ')) { return $null }
  if ($line.Length -gt 300) { $line = $line.Substring(0, 300) }
  return "ricevuta non firmata: $line"
}

# The receipt if it is there and ADE wrote it. One it did not stays: the real one takes its place when it comes.
function TakeReceipt($id) {
  $receipt = Join-Path (Join-Path $box 'receipts') "$id.txt"
  if (-not (Has $receipt)) { return $null }
  $r = Checks 'receipt' $id $receipt 'una ricevuta per'
  if ($null -eq $r) { return $null }
  Remove-Item -LiteralPath $receipt -ErrorAction SilentlyContinue
  return $r.Trim()
}

# Posts and prints the receipt; exits 1 when ADE refused.
function PostAndConfirm($fields) {
  $id = Post $fields
  $r = Receipt $id
  if ($null -eq $r) { Write-Output 'in coda: ADE non ha ancora confermato'; exit 0 }
  Write-Output $r
  if ($r.StartsWith('ok')) { exit 0 } else { exit 1 }
}

# Posts and prints what ADE answered after its first line: the value, not the receipt.
function PostAndPrint($fields) {
  $id = Post $fields
  $r = Receipt $id
  # Said as failed, so taken back if nobody took it yet: ADE must not carry it out later.
  if ($null -eq $r) {
    Remove-Item -LiteralPath (Join-Path (Join-Path $box 'outbox') "$id.json") -ErrorAction SilentlyContinue
    Fail 'ADE non ha risposto: riprova tra poco'
  }
  if (-not $r.StartsWith('ok')) { Write-Output $r; exit 1 }
  $nl = $r.IndexOf("`n")
  if ($nl -ge 0) { Write-Output $r.Substring($nl + 1) } else { Write-Output $r }
  exit 0
}

# The answer to $id if it is there, claimed so nobody else takes it; $null if not yet.
function TakeResult($id) {
  $dir = Join-Path $box 'results'
  $ready = Join-Path $dir "$id.txt"
  $taken = Join-Path $dir "$id.taken"
  $typed = Join-Path $dir "$id.typed"
  $closed = Join-Path $dir "$id.closed"
  # Checked before it is touched: the id of a request is public, and this may be the answer for the session that asked.
  if ((Has $ready) -and $null -ne (Checks 'result' $id $ready 'una risposta per')) {
    $claimed = $true
    try { Move-Item -LiteralPath $ready -Destination $taken -Force } catch { $claimed = $false }
    if ($claimed) {
      $r = Sealed 'result' $id (ReadFile $taken)
      if ($null -ne $r) {
        Move-Item -LiteralPath $taken -Destination $closed -Force -ErrorAction SilentlyContinue
        return $r
      }
      # Changed between the check and the move: it goes back as it is, whoever's it is.
      if (-not (Has $ready)) { Move-Item -LiteralPath $taken -Destination $ready -ErrorAction SilentlyContinue }
    }
  }
  if (Has $typed) {
    $r = Checks 'result' $id $typed 'una risposta per'
    if ($null -ne $r) {
      Move-Item -LiteralPath $typed -Destination $closed -Force -ErrorAction SilentlyContinue
      return $r
    }
  }
  # Answered already, to an earlier wait or into the terminal: said at once, not waited for.
  if (Has $closed) {
    $r = Sealed 'result' $id (ReadFile $closed)
    if ($null -ne $r) { return "ade-msg: la richiesta $id e' gia' chiusa. La sua risposta, gia' consegnata:`n" + $r }
    if (Has $closed) { return "ade-msg: la richiesta $id e' gia' chiusa, ma la risposta non si legge con la chiave di questo processo: e' andata a un processo di prima, o la richiesta e' di un'altra sessione." }
  }
  return $null
}

# Blocks until the answers arrive (all of them, or the first with --any) and prints them.
function AwaitIds([string[]]$ids) {
  $dir = Join-Path $box 'results'
  $pending = New-Object System.Collections.Generic.List[string]
  foreach ($id in $ids) { $pending.Add($id) }
  $multi = $ids.Count -gt 1
  $seen = @{}
  $deadline = [DateTime]::UtcNow.AddSeconds($timeout)
  while ($pending.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    foreach ($id in @($pending)) {
      # An update is not an answer, but it is the caller's turn: wake with it.
      $updateFile = Join-Path $dir "$id.update"
      if ((Has $updateFile) -and $null -ne (Checks 'update' $id $updateFile 'un aggiornamento per')) {
        $claimed = Join-Path $dir "$id.update-taken"
        $ok = $true
        try { Move-Item -LiteralPath $updateFile -Destination $claimed -Force } catch { $ok = $false }
        if ($ok) {
          $u = Sealed 'update' $id (ReadFile $claimed)
          if ($null -ne $u) {
            Remove-Item -LiteralPath $claimed -ErrorAction SilentlyContinue
            Write-Output $u
            $others = @($pending | Where-Object { $_ -ne $id })
            if ($others.Count -gt 0) { Write-Output "(ancora in attesa anche di: $($others -join ' '))" }
            exit 0
          }
          if (-not (Has $updateFile)) { Move-Item -LiteralPath $claimed -Destination $updateFile -ErrorAction SilentlyContinue }
        }
      }
      $r = TakeResult $id
      $stateFile = Join-Path $dir "$id.state"
      if ($null -ne $r) {
        [void]$pending.Remove($id)
        Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue
        if ($multi) { Write-Output "=== risposta $id ===" }
        Write-Output $r
        if ($any) {
          if ($pending.Count -gt 0) { Write-Output "`n(ancora in attesa: $($pending -join ' ') - riprendi con: ade-msg wait $($pending -join ' '))" }
          exit 0
        }
        continue
      }
      if (Has $stateFile) {
        $s = $null
        try { $s = Sealed 'state' $id ([IO.File]::ReadAllText($stateFile, $utf8)) } catch {}
        if ($s) { $s = $s.Trim() }
        if ($s -and $seen[$id] -ne $s) { $seen[$id] = $s; [Console]::Error.WriteLine("ade-msg: richiesta $id - $s") }
      }
    }
    if ($pending.Count -gt 0) { Start-Sleep -Milliseconds 250 }
  }
  if ($pending.Count -eq 0) { exit 0 }
  Write-Output "in corso: $($pending -join ' '). Non ripetere wait: la risposta ti arriva da sola nel terminale."
  exit 0
}

switch ($cmd) {
  'list' { $f = Join-Path $PSScriptRoot 'sessions.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessuna sessione pubblicata' }; exit 0 }
  'agents' { $f = Join-Path $PSScriptRoot 'agents.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessun agente pubblicato' }; exit 0 }
  'help' {
    # help design, help decisioni: the formats, kept out of the general help that every session reads.
    $name = if ($head -eq 'design' -or $head -eq 'decisioni') { "usage-$head.txt" } else { 'usage.txt' }
    $f = Join-Path $PSScriptRoot $name
    if (Has $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'uso: ade-msg list | send | ask | spawn | reply | wait | status | cancel | close | agents | whoami | registro | design proponi' }
    exit 0
  }
  'status' { $f = Join-Path $PSScriptRoot 'requests.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessuna richiesta in corso' }; exit 0 }
  'whoami' { Write-Output $env:ADE_PANE_ID; exit 0 }
  'inbox' {
    # Prints the long messages left for this session, oldest first, and moves each to handled/: that move tells ADE it was read.
    NeedToken
    if (-not $env:ADE_PANE_ID) { Fail 'ADE_PANE_ID mancante' }
    $dir = Join-Path (Join-Path $box 'inbox') $env:ADE_PANE_ID
    $files = @()
    try { $files = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction Stop | Where-Object { $_.Extension -eq '.msg' } | Sort-Object Name) } catch {}
    if ($files.Count -eq 0) { Write-Output 'nessun messaggio in attesa'; exit 0 }
    $done = Join-Path $dir 'handled'
    if (-not (Test-Path -LiteralPath $done)) { [void](New-Item -ItemType Directory -Path $done) }
    $printed = 0
    foreach ($f in $files) {
      # Left where it is: moved to handled/ it would pass for read, and deleted a real one would be lost for good.
      $m = Checks 'inbox' $f.BaseName $f.FullName 'un messaggio in inbox,'
      if ($null -eq $m) { continue }
      Write-Output $m
      Write-Output ''
      Move-Item -LiteralPath $f.FullName -Destination (Join-Path $done $f.Name) -Force
      $printed++
    }
    if ($printed -eq 0) { Write-Output 'nessun messaggio in attesa' }
    exit 0
  }
  'who-owns' { if (-not $head) { Usage }; PostAndPrint ([ordered]@{ kind = 'whoowns'; text = (@($pos) -join ' ') }) }
  'stats' { $f = Join-Path $PSScriptRoot 'stats.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessun dato di consumo ancora' }; exit 0 }
  'kv' {
    $op = $head
    switch ($op) {
      'get' { if (-not $second) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'get'; key = $second }) }
      'del' { if (-not $second) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'del'; key = $second }) }
      'list' { PostAndPrint ([ordered]@{ kind = 'kv'; op = 'list'; key = $second }) }
      'set' { if (-not $second -or -not $text) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'set'; key = $second; text = $text }) }
      'lock' { if (-not $second) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'lock'; key = $second; ttl = $ttl; text = $text }) }
      'unlock' { if (-not $second) { Usage }; PostAndPrint ([ordered]@{ kind = 'kv'; op = 'unlock'; key = $second; force = $force }) }
      default { Usage }
    }
  }
  'registro' {
    # The JSON is the event's fields; ADE adds type, at and by, checks and writes it.
    if (-not $head -or -not $second -or -not $text) { Usage }
    PostAndPrint ([ordered]@{ kind = 'registro'; register = $head; op = $second; text = $text })
  }
  'memory' {
    switch ($head) {
      'add' { if (-not $second -or -not $text) { Usage }; PostAndPrint ([ordered]@{ kind = 'memory'; op = 'add'; type = $second; text = $text }) }
      'show' { PostAndPrint ([ordered]@{ kind = 'memory'; op = 'show' }) }
      default { Usage }
    }
  }
  'send' {
    if (-not $head -or -not $text) { Usage }
    $fields = [ordered]@{ kind = 'send'; to = $head; text = $text }
    if ($via) { $fields['via'] = $via }
    PostAndConfirm $fields
  }
  'reply' {
    if (-not $head -or -not $text) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'reply'; ref = $head; text = $text })
  }
  'cancel' {
    if ($head -notmatch '^[A-Za-z0-9_-]{1,80}$') { Usage }
    PostAndConfirm ([ordered]@{ kind = 'cancel'; ref = $head })
  }
  'delivered' {
    if ($head -notmatch '^[A-Za-z0-9_-]{1,80}$') { Usage }
    # `delivered <id>` means sent; `delivered <id> no [motivo]` means ADE has to type it.
    $ok = -not ($second -eq 'no')
    $why = if ($ok) { '' } elseif ($pos.Count -gt 2) { ($pos.GetRange(2, $pos.Count - 2)) -join ' ' } else { '' }
    PostAndConfirm ([ordered]@{ kind = 'delivered'; ref = $head; ok = $ok; text = $why })
  }
  'update' {
    if ($head -notmatch '^[A-Za-z0-9_-]{1,80}$' -or ($second -ne 'bloccata' -and $second -ne 'decisione') -or -not $text) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'update'; ref = $head; state = $second; text = $text })
  }
  'interrupt' {
    if (-not $head) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'interrupt'; to = $head })
  }
  'design' {
    # proponi: ADE reads the folder, checks it and opens the proposal; with --attendi, and with attendi,
    # this waits for the user's choice as ask waits for an answer, and prints it. Exit 2: no choice yet.
    if ($head -eq 'proponi' -or $head -eq 'attendi') {
      if (-not $second) { Usage }
      $t = if ($timeoutSet) { $timeout } else { 1800 }
      if ($t -lt 1) { Usage }
      # A day at most, as ADE counts it: past that ADE would type the choice while this still waited.
      if ($t -gt 86400) { $t = 86400 }
      if ($head -eq 'proponi') {
        $k = Split-Path -Leaf $second.TrimEnd('\', '/')
        $fields = [ordered]@{ kind = 'design'; op = 'proponi'; folder = $second; cwd = (Get-Location).ProviderPath; attendi = $attendi; timeout = $t }
      } else {
        $k = $second
        $fields = [ordered]@{ kind = 'design'; op = 'attendi'; key = $k; timeout = $t }
      }
      $id = Post $fields
      $r = Receipt $id
      if ($null -ne $r -and -not $r.StartsWith('ok')) { Write-Output $r; exit 1 }
      if ($head -eq 'proponi' -and -not $attendi) {
        if ($null -eq $r) { Write-Output 'in coda: ADE non ha ancora confermato' } else { Write-Output $r }
        exit 0
      }
      $said = if ($null -eq $r) { 'in coda, ADE non ha ancora confermato' } else { $r }
      [Console]::Error.WriteLine("ade-msg: $said (richiesta $id), in attesa della scelta...")
      $late = Join-Path (Join-Path $box 'receipts') "$id.txt"
      $deadline = [DateTime]::UtcNow.AddSeconds($t)
      while ([DateTime]::UtcNow -lt $deadline) {
        # A receipt later than Receipt waited for: a refusal ends the wait instead of sitting it out.
        if ($null -eq $r -and (Has $late)) {
          $r = TakeReceipt $id
          if ($null -ne $r -and -not $r.StartsWith('ok')) { Write-Output $r; exit 1 }
        }
        $res = TakeResult $id
        if ($null -ne $res) { Write-Output $res.Trim(); exit 0 }
        Start-Sleep -Milliseconds 250
      }
      Write-Output "ancora nessuna scelta su $k; riprendi con: ade-msg design attendi $k"
      exit 2
    } else {
      if (-not $head) { Usage }
      $sheet = if ([IO.Path]::IsPathRooted($head)) { [IO.Path]::GetFullPath($head) } else { [IO.Path]::GetFullPath((Join-Path (Get-Location).ProviderPath $head)) }
      if (-not (Test-Path -LiteralPath $sheet -PathType Leaf)) { Fail "file non trovato: $head" }
      $fields = [ordered]@{ kind = 'design'; path = $sheet }
      if ($title) { $fields['title'] = $title }
      PostAndConfirm $fields
    }
  }
  'close' {
    if (-not $head) { Usage }
    PostAndConfirm ([ordered]@{ kind = 'close'; to = $head; force = $force })
  }
  'relaunch' {
    if (-not $head) { Usage }
    $fields = [ordered]@{ kind = 'relaunch'; to = $head; fresh = $fresh; note = $(if ($note) { $note } else { $text }) }
    if ($model) { $fields['model'] = $model }
    if ($effort) { $fields['effort'] = $effort }
    PostAndConfirm $fields
  }
  { $_ -eq 'ask' -or $_ -eq 'spawn' } {
    if (-not $head -or -not $text) { Usage }
    if ($cmd -eq 'ask') {
      $fields = [ordered]@{ kind = 'ask'; to = $head; text = $text }
      if ($effort) { $fields['effort'] = $effort }
      if ($via) { $fields['via'] = $via }
      if ($budget) { $fields['budget'] = $budget }
    } else {
      $fields = [ordered]@{ kind = 'spawn'; agent = $head; close = $close; worktree = $worktree; fork = $fork }
      if ($name) { $fields['name'] = $name }
      if ($model) { $fields['model'] = $model }
      if ($base) { $fields['base'] = $base }
      if ($effort) { $fields['effort'] = $effort }
      if ($profile) { $fields['profile'] = $profile }
      if ($budget) { $fields['budget'] = $budget }
      $fields['text'] = $text
    }
    $id = Post $fields
    $r = Receipt $id
    if ($null -ne $r -and -not $r.StartsWith('ok')) { Write-Output $r; exit 1 }
    $said = if ($null -eq $r) { 'in coda, ADE non l''ha ancora consegnata' } else { $r }
    # The delivery is the caller's own SendMessage: waiting here first would wait for a reply to a request nobody has received yet.
    if ($null -ne $r -and $r.StartsWith('ok: consegna tu')) { Write-Output "id: $id - $r`nDopo averla mandata attendi con: ade-msg wait $id"; exit 0 }
    if ($noWait) { Write-Output "id: $id - $said - attendi con: ade-msg wait $id"; exit 0 }
    [Console]::Error.WriteLine("ade-msg: $said (richiesta $id), in attesa della risposta...")
    AwaitIds @($id)
  }
  'wait' {
    if ($pos.Count -eq 0) { Usage }
    NeedToken
    foreach ($id in $pos) { if ($id -notmatch '^[A-Za-z0-9_-]{1,80}$') { Fail "id non valido: $id" } }
    AwaitIds $pos.ToArray()
  }
  default { Usage }
}
"#;

/// Windows, for shells that look for `.cmd` (cmd, PowerShell via PATHEXT).
const CMD: &str = "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0ade-msg.ps1\" %*\r\n";

/// Git Bash on Windows (Claude Code's shell there) forwards to the PowerShell
/// script; on macOS and Linux it is the implementation.
const SH: &str = r#"#!/bin/sh
# ade-msg — talk to the other ADE sessions. Written by ADE; do not edit.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$(dirname "$0")/ade-msg.ps1" 2>/dev/null || echo "$(dirname "$0")/ade-msg.ps1")" "$@" ;;
esac
box="$ADE_MAILBOX"
if [ -z "$box" ] || [ ! -d "$box" ]; then echo "ade-msg: questa shell non e' una sessione avviata da ADE (ADE_MAILBOX mancante)." >&2; exit 2; fi
# The lists and help texts ADE publishes sit beside this script, not in the mailbox, which every session can write in.
here="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
usage() { if [ -f "$here/usage.txt" ]; then cat "$here/usage.txt"; else echo "uso: ade-msg list | send | ask | spawn | reply | wait | status | cancel | close | agents | whoami | registro | design proponi"; fi; exit 1; }
fail() { echo "ade-msg: $1" >&2; exit 1; }
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g' | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//'; }
valid_id() { case "$1" in ''|*[!A-Za-z0-9_-]*) return 1 ;; esac; return 0; }

# Any session can write in the mailbox. So what ADE leaves for this session starts with a MAC keyed by this session's
# own token, which the others do not have, and what this session posts is signed the same way (mail-seal.ts). HMAC-SHA256
# made from the hash alone: `openssl dgst -hmac` would put the key on a command line, where ps shows it.
hash_cmd=""
if command -v sha256sum >/dev/null 2>&1; then hash_cmd=sha256sum
elif command -v shasum >/dev/null 2>&1; then hash_cmd=shasum
elif command -v openssl >/dev/null 2>&1; then hash_cmd=openssl
fi
need_hash() { [ -n "$hash_cmd" ] || fail "manca sha256sum, shasum od openssl: non posso firmare ne' controllare chi scrive nella casella, quindi non continuo"; }
digest() {
  case "$hash_cmd" in
    sha256sum) sha256sum ;;
    shasum) shasum -a 256 ;;
    *) openssl dgst -sha256 | sed 's/.*= *//' ;;
  esac | cut -c1-64
}
# The key's 64 bytes xored with each pad, as printf formats. No fork for each byte but the one that reads it.
ipad=""; opad=""
hmac_pads() {
  [ -n "$ipad" ] && return 0
  pad_key="$ADE_PANE_TOKEN"; pad_n=0
  [ "${#pad_key}" -le 64 ] || fail "ADE_PANE_TOKEN troppo lungo"
  while [ $pad_n -lt 64 ]; do
    pad_v=0
    if [ -n "$pad_key" ]; then pad_c="${pad_key%"${pad_key#?}"}"; pad_key="${pad_key#?}"; pad_v=$(printf '%d' "'$pad_c"); fi
    pad_i=$((pad_v ^ 54)); pad_o=$((pad_v ^ 92))
    ipad="$ipad\\$(( ((pad_i>>6)&7)*100 + ((pad_i>>3)&7)*10 + (pad_i&7) ))"
    opad="$opad\\$(( ((pad_o>>6)&7)*100 + ((pad_o>>3)&7)*10 + (pad_o&7) ))"
    pad_n=$((pad_n+1))
  done
}
# The HMAC of stdin. hmac_pads and need_hash first, in the shell itself: this runs in a subshell, where a failure is lost.
hmac() {
  h="$({ printf "$ipad"; cat; } | digest)"; bin=""
  while [ -n "$h" ]; do
    b="${h%"${h#??}"}"; h="${h#??}"; v=$((0x$b))
    bin="$bin\\$(( ((v>>6)&7)*100 + ((v>>3)&7)*10 + (v&7) ))"
  done
  { printf "$opad"; printf "$bin"; } | digest
}
# Whether file $3 is what ADE wrote for this session as $1 of $2; its text is then tail -n +2. With no token nothing is
# believed: anybody can sign with an empty key.
sealed() {
  [ -n "$ADE_PANE_TOKEN" ] || return 1
  need_hash; hmac_pads
  line="$(head -n 1 "$3" 2>/dev/null)"
  case "$line" in "ade-mac1 "*) ;; *) return 1 ;; esac
  [ "$line" = "ade-mac1 $({ printf '%s\n%s\n' "$1" "$2"; tail -n +2 "$3" 2>/dev/null; } | hmac)" ]
}
# Said once for each file: a forged one must not fill a wait that looks at it four times a second.
said_refused=""
refused() {
  case " $said_refused " in *" $2:$1 "*) return 0 ;; esac
  said_refused="$said_refused $2:$1"
  echo "ade-msg: ignoro $1 $2: non e' firmato per questa sessione, e lo lascio dov'e'. Se e' di un'altra sessione resta a lei; se no qualcuno ha messo un falso nella casella." >&2
}
# wait and inbox read only what is signed for this session, and with no token that is nothing: stopped before a file is touched.
need_token() { [ -n "$ADE_PANE_TOKEN" ] || { echo "ade-msg: ADE_PANE_TOKEN mancante: ADE non puo' riconoscere questa shell, lancia ade-msg dal terminale di un pannello di ADE." >&2; exit 2; }; }
# sealed, and said once if the file is still there and fails. Nothing that fails is moved or removed: it may be the real
# one for the session it is signed for.
checked() {
  sealed "$1" "$2" "$3" && return 0
  if [ -f "$3" ]; then refused "$4" "$2"; fi
  return 1
}

cmd="$1"; [ $# -gt 0 ] && shift
# -h/--help anywhere prints the help and posts nothing. An argument that is only
# an option is never text: a typo must not become a message. After a lone --
# everything is positional again, so a text that starts with -- can still be sent.
wanthelp=0; options=1
case "$cmd" in
  -h|--help) wanthelp=1; cmd="" ;;
  --) options=0; cmd="" ;;
  --*) fail "opzione sconosciuta: $cmd" ;;
esac
timeout=110; timeout_set=0; attendi=0; nowait=0; any=0; close=false; worktree=false; force=false; fresh=false; fork=false; stdin=0; ttl=0; name=""; model=""; base=""; note=""; effort=""; profile=""; file=""; via=""; budget=""; title=""
lead=1; case "$cmd" in update|kv|memory|registro|design) lead=2 ;; esac
n=0; head=""; second=""; text=""; ids=""
while [ $# -gt 0 ]; do
  a="$1"
  # Options anywhere: agents write them after the text as often as before it.
  if [ $options = 1 ]; then
    case "$a" in
      -h|--help) wanthelp=1; shift; continue ;;
      --) options=0; shift; continue ;;
      --timeout) [ $# -ge 2 ] || usage; timeout="$2"; timeout_set=1; shift 2; continue ;;
      --attendi) attendi=1; shift; continue ;;
      --file) [ $# -ge 2 ] || usage; file="$2"; shift 2; continue ;;
      --name) [ $# -ge 2 ] || usage; name="$2"; shift 2; continue ;;
      --model) [ $# -ge 2 ] || usage; model="$2"; shift 2; continue ;;
      --base) [ $# -ge 2 ] || usage; base="$2"; shift 2; continue ;;
      --note) [ $# -ge 2 ] || usage; note="$2"; shift 2; continue ;;
      --effort) [ $# -ge 2 ] || usage; effort="$2"; shift 2; continue ;;
      --profile) [ $# -ge 2 ] || usage; profile="$2"; shift 2; continue ;;
      --title) [ $# -ge 2 ] || usage; title="$2"; shift 2; continue ;;
      --budget) [ $# -ge 2 ] || usage; budget="$2"; shift 2; continue ;;
      --no-wait) nowait=1; shift; continue ;;
      --any) any=1; shift; continue ;;
      --close) close=true; shift; continue ;;
      --worktree) worktree=true; shift; continue ;;
      --force) force=true; shift; continue ;;
      --fresh) fresh=true; shift; continue ;;
      --fork) fork=true; shift; continue ;;
      --stdin) stdin=1; shift; continue ;;
      --digita) via=typed; shift; continue ;;
      --ttl) [ $# -ge 2 ] || usage; ttl="$2"; shift 2; continue ;;
      --*) fail "opzione sconosciuta: $a" ;;
    esac
  fi
  if [ $n -eq 0 ]; then head="$a"; elif [ $n -eq 1 ] && [ $lead -eq 2 ]; then second="$a"; else text="${text:+$text }$a"; fi
  ids="${ids:+$ids }$a"
  n=$((n+1)); shift
done

# -h/--help: the help of the command it follows, and nothing is posted. It goes
# through the same `help` branch below, so the text and its fallback stay in one place.
# --file and --stdin are not read: with --help the answer is the help, not an error.
if [ $wanthelp = 1 ]; then
  case "$cmd" in design|decisioni) head="$cmd" ;; esac
  file=""; stdin=0
  cmd=help
fi

if [ -n "$file" ]; then
  [ -f "$file" ] || fail "file non trovato: $file"
  size=$(wc -c < "$file" | tr -d ' ')
  full="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  if [ "$size" -gt 40000 ]; then
    content="Il contenuto completo e' nel file $full ($size byte); leggilo da li'. Inizio:
$(head -c 1500 "$file")"
  else
    content="$(cat "$file")"
  fi
  if [ -n "$text" ]; then text="$text

$content"; else text="$content"; fi
fi

# --stdin: the text from stdin, where no quoting can reach it (SEC2-1): a quoted heredoc (<<'EOF') runs nothing,
# whatever the text holds. Nothing piped, on a terminal, is said and not waited for.
case "$cmd" in
  registro|send|reply|ask|spawn|update|kv|memory)
    if [ "$stdin" = 1 ]; then
      [ -t 0 ] && fail "--stdin: nessun testo in ingresso (una pipe, o <<'EOF' ... EOF)"
      piped="$(cat)"
      # registro takes the JSON from here alone; the others join it to the text on the command line, as --file does.
      if [ "$cmd" != "registro" ] && [ -n "$text" ]; then text="$text

$piped"; else text="$piped"; fi
    fi ;;
esac

post() {
  need_token
  need_hash; hmac_pads
  id="$(date +%s)000-$$"
  if [ "${#text}" -gt 40000 ]; then
    long="$box/results/$id.long.txt"; printf '%s' "$text" > "$long"
    text="Testo completo (${#text} caratteri) in $long, leggilo da li'. Inizio: $(printf '%s' "$text" | head -c 1500)"
  fi
  body="$(printf '{"from":"%s",%s,"text":"%s"}' "$(esc "$ADE_PANE_ID")" "$1" "$(esc "$text")")"
  printf 'ade-mac1 %s\n%s' "$({ printf 'outbox\n%s\n%s' "$id" "$body"; } | hmac)" "$body" > "$box/outbox/$id.part"
  mv "$box/outbox/$id.part" "$box/outbox/$id.json"
}
receipt() {
  r=""; i=0
  while [ $i -lt 50 ]; do
    if take_receipt; then return 0; fi
    sleep 0.2; i=$((i+1))
  done
  # Still not signed: ADE does not know this process's key, or another session wrote it. An ok is not believed; a refusal
  # is said as what it is, since that is how ADE answers a sender it cannot prove.
  f="$box/receipts/$id.txt"
  [ -f "$f" ] || return 1
  left="$(head -n 1 "$f" 2>/dev/null | tr -d '\000-\037\177' | cut -c1-300)"
  rm -f "$f"
  case "$left" in ''|ok*|"ade-mac1 "*) return 1 ;; esac
  r="ricevuta non firmata: $left"; return 0
}
# The receipt if it is there and ADE wrote it. One it did not stays: the real one takes its place when it comes.
take_receipt() {
  f="$box/receipts/$id.txt"
  [ -f "$f" ] || return 1
  checked receipt "$id" "$f" "una ricevuta per" || return 1
  r="$(tail -n +2 "$f")"; rm -f "$f"; return 0
}
confirm() {
  post "$1"
  if receipt; then echo "$r"; case "$r" in ok*) exit 0 ;; *) exit 1 ;; esac; fi
  echo "in coda: ADE non ha ancora confermato"; exit 0
}
# Prints what ADE answered after its first line: the value, not the receipt.
show() {
  post "$1"
  # Said as failed, so taken back if nobody took it yet: ADE must not carry it out later.
  receipt || { rm -f "$box/outbox/$id.json"; fail "ADE non ha risposto: riprova tra poco"; }
  case "$r" in
    ok*) case "$r" in *"
"*) printf '%s\n' "${r#*
}" ;; *) printf '%s\n' "$r" ;; esac; exit 0 ;;
    *) echo "$r"; exit 1 ;;
  esac
}
take() {
  got=""
  # Checked before it is touched: the id of a request is public, and this may be the answer for the session that asked.
  if [ -f "$box/results/$1.txt" ] && checked result "$1" "$box/results/$1.txt" "una risposta per" && mv "$box/results/$1.txt" "$box/results/$1.taken" 2>/dev/null; then
    if sealed result "$1" "$box/results/$1.taken"; then
      got="$(tail -n +2 "$box/results/$1.taken")"; mv -f "$box/results/$1.taken" "$box/results/$1.closed" 2>/dev/null; return 0
    fi
    # Changed between the check and the move: it goes back as it is, whoever's it is.
    [ -e "$box/results/$1.txt" ] || mv "$box/results/$1.taken" "$box/results/$1.txt" 2>/dev/null
  fi
  if [ -f "$box/results/$1.typed" ] && checked result "$1" "$box/results/$1.typed" "una risposta per"; then
    got="$(tail -n +2 "$box/results/$1.typed")"; mv -f "$box/results/$1.typed" "$box/results/$1.closed" 2>/dev/null; return 0
  fi
  # Answered already, to an earlier wait or into the terminal: said at once, not waited for.
  if [ -f "$box/results/$1.closed" ]; then
    if sealed result "$1" "$box/results/$1.closed"; then
      got="ade-msg: la richiesta $1 e' gia' chiusa. La sua risposta, gia' consegnata:
$(tail -n +2 "$box/results/$1.closed")"; return 0
    fi
    if [ -f "$box/results/$1.closed" ]; then got="ade-msg: la richiesta $1 e' gia' chiusa, ma la risposta non si legge con la chiave di questo processo: e' andata a un processo di prima, o la richiesta e' di un'altra sessione."; return 0; fi
  fi
  return 1
}
await() {
  # One more: the clock is in whole seconds, and on the edge of one a timeout of 1 would not look even once.
  end=$(( $(date +%s) + timeout + 1 ))
  multi=0; [ $# -gt 1 ] && multi=1
  pending="$*"
  while [ -n "$pending" ] && [ "$(date +%s)" -lt "$end" ]; do
    still=""
    for rid in $pending; do
      if [ -f "$box/results/$rid.update" ] && checked update "$rid" "$box/results/$rid.update" "un aggiornamento per" && mv "$box/results/$rid.update" "$box/results/$rid.update-taken" 2>/dev/null; then
        if sealed update "$rid" "$box/results/$rid.update-taken"; then
          tail -n +2 "$box/results/$rid.update-taken"; echo; rm -f "$box/results/$rid.update-taken"
          rest=""; for o in $pending; do [ "$o" != "$rid" ] && rest="${rest:+$rest }$o"; done
          [ -n "$rest" ] && echo "(ancora in attesa anche di: $rest)"
          exit 0
        fi
        [ -e "$box/results/$rid.update" ] || mv "$box/results/$rid.update-taken" "$box/results/$rid.update" 2>/dev/null
      fi
      if take "$rid"; then
        rm -f "$box/results/$rid.state"
        [ $multi = 1 ] && echo "=== risposta $rid ==="
        printf '%s\n' "$got"
        if [ $any = 1 ]; then
          rest=""; for o in $pending; do [ "$o" != "$rid" ] && rest="${rest:+$rest }$o"; done
          [ -n "$rest" ] && printf '\n(ancora in attesa: %s - riprendi con: ade-msg wait %s)\n' "$rest" "$rest"
          exit 0
        fi
      else
        still="${still:+$still }$rid"
        if [ -f "$box/results/$rid.state" ] && sealed state "$rid" "$box/results/$rid.state"; then
          s="$(tail -n +2 "$box/results/$rid.state")"; key="seen_$(printf '%s' "$rid" | tr -c 'A-Za-z0-9_' '_')"
          eval "old=\"\${$key}\""
          if [ "$s" != "$old" ]; then eval "$key=\"\$s\""; echo "ade-msg: richiesta $rid - $s" >&2; fi
        fi
      fi
    done
    pending="$still"
    [ -n "$pending" ] && sleep 0.25
  done
  [ -z "$pending" ] && exit 0
  echo "in corso: $pending. Non ripetere wait: la risposta ti arriva da sola nel terminale."
  exit 0
}

case "$cmd" in
  list) if [ -f "$here/sessions.txt" ]; then cat "$here/sessions.txt"; else echo "nessuna sessione pubblicata"; fi ;;
  agents) if [ -f "$here/agents.txt" ]; then cat "$here/agents.txt"; else echo "nessun agente pubblicato"; fi ;;
  help)
    # help design, help decisioni: the formats, kept out of the general help that every session reads.
    f="$here/usage.txt"; case "$head" in design|decisioni) f="$here/usage-$head.txt" ;; esac
    if [ -f "$f" ]; then cat "$f"; else echo "uso: ade-msg list | send | ask | spawn | reply | wait | status | cancel | close | agents | whoami | registro | design proponi"; fi ;;
  status) if [ -f "$here/requests.txt" ]; then cat "$here/requests.txt"; else echo "nessuna richiesta in corso"; fi ;;
  whoami) echo "$ADE_PANE_ID" ;;
  inbox)
    need_token
    [ -n "$ADE_PANE_ID" ] || fail "ADE_PANE_ID mancante"
    dir="$box/inbox/$ADE_PANE_ID"; found=0
    for f in "$dir"/*.msg; do
      [ -f "$f" ] || continue
      name="$(basename "$f" .msg)"
      # Left where it is: moved to handled/ it would pass for read, and deleted a real one would be lost for good.
      checked inbox "$name" "$f" "un messaggio in inbox," || continue
      found=1
      mkdir -p "$dir/handled"; tail -n +2 "$f"; printf '\n\n'; mv -f "$f" "$dir/handled/"
    done
    [ $found = 1 ] || echo "nessun messaggio in attesa" ;;
  who-owns) [ -n "$head" ] || usage; text="$head${text:+ $text}"; show "\"kind\":\"whoowns\"" ;;
  stats) if [ -f "$here/stats.txt" ]; then cat "$here/stats.txt"; else echo "nessun dato di consumo ancora"; fi ;;
  kv)
    key="\"key\":\"$(esc "$second")\""
    case "$head" in
      get|del) [ -n "$second" ] || usage; show "\"kind\":\"kv\",\"op\":\"$head\",$key" ;;
      list) show "\"kind\":\"kv\",\"op\":\"list\",$key" ;;
      set) [ -n "$second" ] && [ -n "$text" ] || usage; show "\"kind\":\"kv\",\"op\":\"set\",$key" ;;
      lock) [ -n "$second" ] || usage; show "\"kind\":\"kv\",\"op\":\"lock\",$key,\"ttl\":$(printf '%d' "$ttl" 2>/dev/null || echo 0)" ;;
      unlock) [ -n "$second" ] || usage; show "\"kind\":\"kv\",\"op\":\"unlock\",$key,\"force\":$force" ;;
      *) usage ;;
    esac ;;
  registro)
    [ -n "$head" ] && [ -n "$second" ] && [ -n "$text" ] || usage
    show "\"kind\":\"registro\",\"register\":\"$(esc "$head")\",\"op\":\"$(esc "$second")\"" ;;
  memory)
    case "$head" in
      add) [ -n "$second" ] && [ -n "$text" ] || usage; show "\"kind\":\"memory\",\"op\":\"add\",\"type\":\"$(esc "$second")\"" ;;
      show) show "\"kind\":\"memory\",\"op\":\"show\"" ;;
      *) usage ;;
    esac ;;
  send)
    [ -n "$head" ] && [ -n "$text" ] || usage
    extra=""; [ -n "$via" ] && extra=",\"via\":\"$via\""
    confirm "\"kind\":\"send\",\"to\":\"$(esc "$head")\"$extra" ;;
  reply) [ -n "$head" ] && [ -n "$text" ] || usage; confirm "\"kind\":\"reply\",\"ref\":\"$(esc "$head")\"" ;;
  cancel) valid_id "$head" || usage; confirm "\"kind\":\"cancel\",\"ref\":\"$head\"" ;;
  delivered)
    valid_id "$head" || usage
    # `delivered <id>` means sent; `delivered <id> no [motivo]` means ADE has to type it.
    if [ "$second" = no ]; then ok=false; text="$(printf '%s' "$text" | sed 's/^no *//')"; else ok=true; text=""; fi
    confirm "\"kind\":\"delivered\",\"ref\":\"$head\",\"ok\":$ok" ;;
  update)
    valid_id "$head" || usage
    case "$second" in bloccata|decisione) ;; *) usage ;; esac
    [ -n "$text" ] || usage
    confirm "\"kind\":\"update\",\"ref\":\"$head\",\"state\":\"$second\"" ;;
  interrupt) [ -n "$head" ] || usage; confirm "\"kind\":\"interrupt\",\"to\":\"$(esc "$head")\"" ;;
  design)
    # proponi: ADE reads the folder, checks it and opens the proposal; with --attendi, and with attendi,
    # this waits for the user's choice as ask waits for an answer, and prints it. Exit 2: no choice yet.
    if [ "$head" = proponi ] || [ "$head" = attendi ]; then
      [ -n "$second" ] || usage
      t="$timeout"; [ "$timeout_set" = 0 ] && t=1800
      case "$t" in ''|0|*[!0-9]*) usage ;; esac
      # A day at most, as ADE counts it: past that ADE would type the choice while this still waited.
      [ ${#t} -gt 5 ] || [ "$t" -gt 86400 ] && t=86400
      if [ "$head" = proponi ]; then
        k="$(basename "$second")"
        a=false; [ "$attendi" = 1 ] && a=true
        post "\"kind\":\"design\",\"op\":\"proponi\",\"folder\":\"$(esc "$second")\",\"cwd\":\"$(esc "$(pwd -W 2>/dev/null || pwd)")\",\"attendi\":$a,\"timeout\":$t"
      else
        k="$second"
        post "\"kind\":\"design\",\"op\":\"attendi\",\"key\":\"$(esc "$k")\",\"timeout\":$t"
      fi
      if receipt; then case "$r" in ok*) ;; *) echo "$r"; exit 1 ;; esac; else r=""; fi
      if [ "$head" = proponi ] && [ "$attendi" = 0 ]; then echo "${r:-in coda: ADE non ha ancora confermato}"; exit 0; fi
      echo "ade-msg: ${r:-in coda, ADE non ha ancora confermato} (richiesta $id), in attesa della scelta..." >&2
      end=$(( $(date +%s) + t ))
      while [ "$(date +%s)" -lt "$end" ]; do
        # A receipt later than receipt() waited for: a refusal ends the wait instead of sitting it out.
        if [ -z "$r" ] && take_receipt; then
          case "$r" in ok*) ;; *) echo "$r"; exit 1 ;; esac
        fi
        if take "$id"; then printf '%s\n' "$got"; exit 0; fi
        sleep 0.25
      done
      echo "ancora nessuna scelta su $k; riprendi con: ade-msg design attendi $k"
      exit 2
    else
      [ -n "$head" ] || usage
      [ -f "$head" ] || fail "file non trovato: $head"
      sheet="$(cd "$(dirname "$head")" && { pwd -W 2>/dev/null || pwd; })/$(basename "$head")"
      confirm "\"kind\":\"design\",\"path\":\"$(esc "$sheet")\",\"title\":\"$(esc "$title")\""
    fi ;;
  close) [ -n "$head" ] || usage; confirm "\"kind\":\"close\",\"to\":\"$(esc "$head")\",\"force\":$force" ;;
  relaunch)
    [ -n "$head" ] || usage
    extra=""; [ -n "$model" ] && extra=",\"model\":\"$(esc "$model")\""
    [ -n "$effort" ] && extra="$extra,\"effort\":\"$(esc "$effort")\""
    [ -n "$note" ] || note="$text"
    confirm "\"kind\":\"relaunch\",\"to\":\"$(esc "$head")\",\"fresh\":$fresh,\"note\":\"$(esc "$note")\"$extra" ;;
  ask|spawn)
    [ -n "$head" ] && [ -n "$text" ] || usage
    # D73: seconds, a whole number from 60 to 14400, no leading zero; anything else is a usage error.
    bextra=""
    if [ -n "$budget" ]; then
      case "$budget" in *[!0-9]*|0*) usage ;; esac
      { [ ${#budget} -le 5 ] && [ "$budget" -ge 60 ] && [ "$budget" -le 14400 ]; } || usage
      bextra=",\"budget\":$budget"
    fi
    if [ "$cmd" = ask ]; then
      extra=""; [ -n "$effort" ] && extra=",\"effort\":\"$(esc "$effort")\""
      extra="$extra$bextra"
      [ -n "$via" ] && extra="$extra,\"via\":\"$via\""
      post "\"kind\":\"ask\",\"to\":\"$(esc "$head")\"$extra"
    else
      extra=""
      [ -n "$name" ] && extra="$extra,\"name\":\"$(esc "$name")\""
      [ -n "$model" ] && extra="$extra,\"model\":\"$(esc "$model")\""
      [ -n "$base" ] && extra="$extra,\"base\":\"$(esc "$base")\""
      [ -n "$effort" ] && extra="$extra,\"effort\":\"$(esc "$effort")\""
      [ -n "$profile" ] && extra="$extra,\"profile\":\"$(esc "$profile")\""
      extra="$extra$bextra"
      post "\"kind\":\"spawn\",\"agent\":\"$(esc "$head")\",\"close\":$close,\"worktree\":$worktree,\"fork\":$fork$extra"
    fi
    if receipt; then
      case "$r" in ok*) said="$r" ;; *) echo "$r"; exit 1 ;; esac
    else
      said="in coda, ADE non l'ha ancora consegnata"
    fi
    # The delivery is the caller's own SendMessage: waiting here first would wait for a reply to a request nobody has received yet.
    case "$said" in "ok: consegna tu"*) printf '%s\n' "id: $id - $said" "Dopo averla mandata attendi con: ade-msg wait $id"; exit 0 ;; esac
    if [ $nowait = 1 ]; then echo "id: $id - $said - attendi con: ade-msg wait $id"; exit 0; fi
    echo "ade-msg: $said (richiesta $id), in attesa della risposta..." >&2
    await "$id" ;;
  wait)
    [ -n "$ids" ] || usage
    need_token
    for rid in $ids; do valid_id "$rid" || fail "id non valido: $rid"; done
    await $ids ;;
  *) usage ;;
esac
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * The whole channel rests on this: the PATH set on the builder is the one
     * the child sees. On Windows the inherited variable is spelled `Path`, and
     * a second `PATH` entry beside it would be a coin toss for the child.
     */
    #[cfg(windows)]
    #[test]
    fn a_session_finds_ade_msg_on_its_path() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;

        let bin = std::env::temp_dir().join(format!("ade-msg-path-{}", std::process::id()));
        fs::create_dir_all(&bin).expect("a directory");
        fs::write(bin.join("ade-msg-probe.cmd"), "@echo off\r\necho found-it\r\n").expect("a script");

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 200, pixel_width: 0, pixel_height: 0 })
            .expect("a pty");
        let mut builder = CommandBuilder::new("cmd.exe");
        builder.args(["/c", "ade-msg-probe"]);
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut parts = vec![bin.clone()];
        parts.extend(std::env::split_paths(&path));
        builder.env("PATH", std::env::join_paths(parts).expect("a PATH"));

        let mut child = pair.slave.spawn_command(builder).expect("cmd starts");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("a reader");
        let collector = std::thread::spawn(move || {
            let mut out = String::new();
            let mut buf = [0u8; 4096];
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(10) {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        out.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if out.contains("found-it") {
                            break;
                        }
                    }
                }
            }
            out
        });
        let _ = child.wait();
        drop(pair.master);
        let out = collector.join().expect("output");
        let _ = fs::remove_dir_all(&bin);
        assert!(out.contains("found-it"), "the child did not find the script: {out}");
    }

    #[test]
    fn new_mail_is_signalled_at_once_and_a_stuck_outbox_only_once_a_second() {
        let soon = Duration::from_millis(200);
        let later = SIGNAL_GAP;
        assert_eq!(pending_signal(true, false, false, soon), Some(true));
        assert_eq!(pending_signal(true, true, false, soon), None);
        assert_eq!(pending_signal(true, true, false, later), Some(true));
    }

    #[test]
    fn every_page_gets_a_pulse_a_second() {
        let soon = Duration::from_millis(200);
        let later = SIGNAL_GAP;
        assert_eq!(pending_signal(false, false, later), Some(false));
        assert_eq!(pending_signal(false, false, soon), None);
        // Mail says so even in a pulse's place.
        assert_eq!(pending_signal(true, true, later), Some(true));
        // And a pulse does not come in its gap.
        assert_eq!(pending_signal(true, true, soon), None);
    }

    /// An outbox and a receipts folder of their own: the claims are one map for the whole process, so each test has its own ids too.
    fn take_dirs(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let base = std::env::current_dir().unwrap().join("target").join(format!("mailbox-claims-{tag}"));
        let _ = fs::remove_dir_all(&base);
        let (outbox, receipts) = (base.join("outbox"), base.join("receipts"));
        fs::create_dir_all(&outbox).unwrap();
        fs::create_dir_all(&receipts).unwrap();
        (base, outbox, receipts)
    }

    #[test]
    fn a_claim_another_take_is_reading_is_not_given_back() {
        let (base, outbox, receipts) = take_dirs("reading");
        let id = "1757860000001-read";
        fs::write(outbox.join(format!("{id}.taking")), "{}").unwrap();
        claims().insert(id.to_string(), Claim::Reading);

        assert!(take_outbox(&outbox, &receipts, Instant::now()).unwrap().is_empty());
        assert!(outbox.join(format!("{id}.taking")).exists(), "the other take is reading it");
        assert!(!outbox.join(format!("{id}.json")).exists(), "and it does not go back under its feet");
        claims().remove(id);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_message_is_kept_until_the_page_has_it() {
        let (base, outbox, receipts) = take_dirs("kept");
        let id = "1757860000002-kept";
        fs::write(outbox.join(format!("{id}.json")), "{\"kind\":\"send\"}").unwrap();

        let taken = take_outbox(&outbox, &receipts, Instant::now()).unwrap();
        assert_eq!(taken.len(), 1);
        assert!(outbox.join(format!("{id}.taking")).exists(), "the page does not hold it yet");

        confirm_taken(&outbox, &[id.to_string()]);
        assert!(!outbox.join(format!("{id}.taking")).exists());
        assert!(!outbox.join(format!("{id}.json")).exists());
        assert!(take_outbox(&outbox, &receipts, Instant::now()).unwrap().is_empty(), "nothing comes back after the page's word");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_page_load_gives_back_what_the_old_page_never_confirmed() {
        let (base, outbox, receipts) = take_dirs("reload");
        let id = "1757860000003-load";
        fs::write(outbox.join(format!("{id}.json")), "{\"kind\":\"send\"}").unwrap();
        assert_eq!(take_outbox(&outbox, &receipts, Instant::now()).unwrap().len(), 1);

        give_back_all(&outbox);
        assert!(outbox.join(format!("{id}.json")).exists(), "the new page gets it");
        assert!(!outbox.join(format!("{id}.taking")).exists());
        let again = take_outbox(&outbox, &receipts, Instant::now()).unwrap();
        assert_eq!(again.len(), 1);
        confirm_taken(&outbox, &[id.to_string()]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn an_unconfirmed_claim_comes_back_after_half_a_minute() {
        let (base, outbox, receipts) = take_dirs("late");
        let id = "1757860000004-late";
        fs::write(outbox.join(format!("{id}.json")), "{\"kind\":\"send\"}").unwrap();
        let now = Instant::now();
        assert_eq!(take_outbox(&outbox, &receipts, now).unwrap().len(), 1);

        assert!(take_outbox(&outbox, &receipts, now + Duration::from_secs(29)).unwrap().is_empty());
        assert!(outbox.join(format!("{id}.taking")).exists(), "the page still has time");

        let later = now + Duration::from_secs(31);
        let mut delivered = take_outbox(&outbox, &receipts, later).unwrap();
        delivered.extend(take_outbox(&outbox, &receipts, later).unwrap());
        assert_eq!(delivered.len(), 1, "back once, and read once");
        confirm_taken(&outbox, &[id.to_string()]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn scripts_are_replaced_whole_and_only_when_changed() {
        let dir = std::env::current_dir().unwrap().join("target").join("mailbox-put-script");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert!(put_script(&dir, "ade-msg.cmd", "uno").unwrap());
        assert!(!put_script(&dir, "ade-msg.cmd", "uno").unwrap(), "the same bytes are left alone");
        assert!(put_script(&dir, "ade-msg.cmd", "due").unwrap());
        assert_eq!(fs::read_to_string(dir.join("ade-msg.cmd")).unwrap(), "due");
        assert!(!dir.join("ade-msg.cmd.part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_open_for_reading_is_still_replaced() {
        use std::os::windows::fs::OpenOptionsExt;
        let scratch = Scratch::new("replace-open");
        let target = scratch.0.join("requests.txt");
        fs::write(&target, "old").unwrap();
        // Read sharing only: how `[IO.File]::ReadAllText` opens a file.
        let held = fs::OpenOptions::new().read(true).share_mode(1).open(&target).unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            drop(held);
        });

        write_whole(scratch.0.clone(), "requests.txt", "new").unwrap();
        release.join().unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "new");
        assert!(!scratch.0.join("requests.txt.part").exists());
    }

    #[cfg(windows)]
    #[test]
    fn ade_msg_reads_with_delete_sharing() {
        use std::os::windows::fs::OpenOptionsExt;
        let scratch = mailbox_scratch("replace-shared");
        let target = scratch.0.join("bin").join("requests.txt");
        fs::write(&target, "una richiesta").unwrap();
        {
            // What `ReadShared` opens it with: read, write and delete sharing.
            let _reader = fs::OpenOptions::new().read(true).share_mode(7).open(&target).unwrap();
            let part = scratch.0.join("bin").join("requests.txt.part");
            fs::write(&part, "un'altra richiesta").unwrap();
            fs::rename(&part, &target).expect("a reader that shares delete does not stop the replace");
        }
        let reads: Vec<&str> = PS1.lines().filter(|line| line.contains("ReadAllText(")).collect();
        assert_eq!(reads.len(), 1, "only the file an agent names: {reads:?}");
        assert!(reads[0].contains("$item.FullName"), "{reads:?}");
        assert_eq!(run_ps1_status(&scratch.0, &["status"]).0.trim(), "un'altra richiesta");
    }

    #[test]
    fn only_a_whole_message_counts_as_mail() {
        let base = std::env::current_dir().unwrap().join("target").join("mailbox-watch-test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        assert!(!outbox_has_mail(&base));
        fs::write(base.join("1757860000000-aaaa.part"), "half").unwrap();
        assert!(!outbox_has_mail(&base));
        fs::write(base.join("1757860000000-aaaa.json"), "{}").unwrap();
        assert!(outbox_has_mail(&base));
        let _ = fs::remove_dir_all(&base);
        // A folder that is not there is not mail, and not a panic in the watcher.
        assert!(!outbox_has_mail(&base));
    }

    #[test]
    fn both_scripts_take_back_what_they_say_has_failed() {
        assert!(PS1.contains(r#"(Join-Path (Join-Path $box 'outbox') "$id.json") -ErrorAction SilentlyContinue"#));
        assert!(SH.contains(r#"receipt || { rm -f "$box/outbox/$id.json"; fail"#));
    }

    /// The whole of it on the real script: 10 s of nobody answering, then the message is gone with the failure.
    #[cfg(windows)]
    #[test]
    fn a_kv_nobody_answered_is_withdrawn_from_the_outbox() {
        use std::process::{Command, Stdio};
        let scratch = Scratch::new("withdraw");
        let base = scratch.0.clone();
        for dir in ["outbox", "receipts", "results", "bin"] {
            fs::create_dir_all(base.join(dir)).unwrap();
        }
        let script = base.join("bin").join("ade-msg.ps1");
        fs::write(&script, PS1).unwrap();
        let status = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .args(["kv", "lock", "pc:prova"])
            .current_dir(&base)
            .env("ADE_MAILBOX", &base)
            .env("ADE_PANE_TOKEN", TOKEN)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(1));
        let left: Vec<_> = fs::read_dir(base.join("outbox")).unwrap().flatten().map(|e| e.path()).collect();
        assert!(left.is_empty(), "still in the outbox: {left:?}");
    }

    #[test]
    fn who_owns_takes_the_whole_path_in_both_scripts() {
        // A path with a space, unquoted, arrives as two words: both must reach the lookup.
        assert!(SH.contains("who-owns) [ -n \"$head\" ] || usage; text=\"$head${text:+ $text}\""));
        assert!(PS1.contains("text = (@($pos) -join ' ')"));
    }

    #[test]
    fn a_long_multibyte_message_passes_and_an_oversized_one_is_answered() {
        let base = std::env::current_dir().unwrap().join("target").join("mailbox-take-test");
        let _ = fs::remove_dir_all(&base);
        let (outbox, receipts) = (base.join("outbox"), base.join("receipts"));
        fs::create_dir_all(&outbox).unwrap();
        fs::create_dir_all(&receipts).unwrap();

        // 40,000 characters of four bytes each: the longest the frontend accepts, 160 KiB on disk.
        let text: String = std::iter::repeat('\u{1F600}').take(40_000).collect();
        fs::write(outbox.join("1757860000000-aaaa.json"), format!("{{\"kind\":\"send\",\"to\":\"1\",\"text\":\"{text}\"}}")).unwrap();
        fs::write(outbox.join("1757860000000-bbbb.json"), "x".repeat(MAX_MESSAGE_BYTES as usize + 1)).unwrap();

        let taken = take_outbox(&outbox, &receipts, Instant::now()).unwrap();
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].id, "1757860000000-aaaa");
        assert!(taken[0].body.contains(&text));
        let receipt = fs::read_to_string(receipts.join("1757860000000-bbbb.txt")).unwrap();
        assert!(receipt.starts_with("errore: messaggio troppo grande"));
        assert!(!receipts.join("1757860000000-aaaa.txt").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_read_that_fails_for_a_passing_reason_leaves_the_message_and_answers_nothing() {
        let base = std::env::current_dir().unwrap().join("target").join("mailbox-take-transient");
        let _ = fs::remove_dir_all(&base);
        let (outbox, receipts) = (base.join("outbox"), base.join("receipts"));
        fs::create_dir_all(&outbox).unwrap();
        fs::create_dir_all(&receipts).unwrap();
        // A folder with the name of a message cannot be read as text, and is not invalid UTF-8: a read error of the other kind.
        fs::create_dir_all(outbox.join("1757860000000-cccc.json")).unwrap();

        assert!(take_outbox(&outbox, &receipts, Instant::now()).unwrap().is_empty());
        assert!(outbox.join("1757860000000-cccc.json").exists(), "given back for the next pass");
        assert!(!outbox.join("1757860000000-cccc.taking").exists());
        assert!(!receipts.join("1757860000000-cccc.txt").exists(), "no error receipt over a message that may pass");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn bytes_that_are_not_utf8_are_answered_once_and_a_claim_is_never_delivered() {
        let base = std::env::current_dir().unwrap().join("target").join("mailbox-take-claim");
        let _ = fs::remove_dir_all(&base);
        let (outbox, receipts) = (base.join("outbox"), base.join("receipts"));
        fs::create_dir_all(&outbox).unwrap();
        fs::create_dir_all(&receipts).unwrap();
        fs::write(outbox.join("1757860000000-dddd.json"), [0xff, 0xfe, 0xfd]).unwrap();
        // What a failed delete leaves behind: this process read it, so it must not come out a second time.
        fs::write(outbox.join("1757860000000-eeee.taking"), "{\"kind\":\"send\"}").unwrap();
        undeleted().insert("1757860000000-eeee".to_string());

        assert!(take_outbox(&outbox, &receipts, Instant::now()).unwrap().is_empty());
        let receipt = fs::read_to_string(receipts.join("1757860000000-dddd.txt")).unwrap();
        assert!(receipt.contains("non è UTF-8"));
        assert!(!outbox.join("1757860000000-dddd.json").exists());
        assert!(!outbox.join("1757860000000-dddd.taking").exists());
        assert!(take_outbox(&outbox, &receipts, Instant::now()).unwrap().is_empty(), "the leftover claim is not delivered on a later pass");
        assert!(!outbox.join("1757860000000-eeee.taking").exists(), "and it is cleared away");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_claim_that_was_never_read_goes_back_and_is_delivered_once() {
        let base = std::env::current_dir().unwrap().join("target").join("mailbox-take-stale");
        let _ = fs::remove_dir_all(&base);
        let (outbox, receipts) = (base.join("outbox"), base.join("receipts"));
        fs::create_dir_all(&outbox).unwrap();
        fs::create_dir_all(&receipts).unwrap();
        // What a crash between the rename and the read leaves, an hour after the client wrote it (the rename keeps that time).
        let claim = outbox.join("1757860000000-ffff.taking");
        fs::write(&claim, "{\"kind\":\"send\",\"to\":\"1\",\"text\":\"ciao\"}").unwrap();
        let old = SystemTime::now() - Duration::from_secs(3600);
        fs::File::options().write(true).open(&claim).unwrap().set_modified(old).unwrap();

        let mut delivered = Vec::new();
        for _ in 0..2 {
            delivered.extend(take_outbox(&outbox, &receipts, Instant::now()).unwrap());
        }
        assert_eq!(delivered.len(), 1, "delivered, and once");
        assert_eq!(delivered[0].id, "1757860000000-ffff");
        confirm_taken(&outbox, &["1757860000000-ffff".to_string()]);
        assert!(!claim.exists() && !outbox.join("1757860000000-ffff.json").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn the_size_is_said_in_kib() {
        assert!(too_big_receipt(300 * 1024).contains("(300 KiB, massimo 256 KiB)"));
    }

    #[test]
    fn only_a_test_build_moves_the_mailbox_and_only_to_an_absolute_folder() {
        let default = Some(PathBuf::from("default"));
        let absolute = if cfg!(windows) { "C:\\w\\.ade-test\\mailbox" } else { "/w/.ade-test/mailbox" };
        let env = || Some(std::ffi::OsString::from(absolute));
        assert_eq!(choose_root(true, env(), default.clone()), Some(PathBuf::from(absolute)));
        assert_eq!(choose_root(false, env(), default.clone()), default);
        assert_eq!(choose_root(true, Some("relativa".into()), default.clone()), default);
        assert_eq!(choose_root(true, None, default.clone()), default);
    }

    #[test]
    fn both_scripts_take_a_budget_for_ask_and_spawn_and_check_its_range() {
        // D73: parsed in both, written on ask and on spawn, and held to 60..14400 before anything is posted.
        assert!(PS1.contains("$a -eq '--budget'") && PS1.contains("$b -lt 60 -or $b -gt 14400) { Usage }"));
        assert_eq!(PS1.matches("if ($budget) { $fields['budget'] = $budget }").count(), 2);
        assert!(SH.contains("--budget) [ $# -ge 2 ]") && SH.contains("[ \"$budget\" -ge 60 ] && [ \"$budget\" -le 14400 ]"));
        assert!(SH.contains("bextra=\",\\\"budget\\\":$budget\""));
        assert_eq!(SH.matches("extra=\"$extra$bextra\"").count(), 2);
    }

    #[test]
    fn both_scripts_read_the_inbox_and_move_what_they_print() {
        assert!(PS1.contains("'inbox' {") && PS1.contains("Join-Path $dir 'handled'"));
        assert!(SH.contains("  inbox)") && SH.contains("mv -f \"$f\" \"$dir/handled/\""));
        assert!(!PS1.contains("3800") && !SH.contains("3800"));
        assert!(PS1.contains("kind = 'interrupt'") && SH.contains("interrupt) [ -n"));
        assert!(PS1.contains("$fields['effort'] = $effort") && SH.contains("--effort)") && SH.contains("--profile)"));
        assert!(PS1.contains("--note") && SH.contains("\\\"note\\\":"));
    }

    /// What the scripts run with in these tests, and what signs the files they read.
    #[cfg(windows)]
    const TOKEN: &str = "0123456789abcdef01234567";

    /// A file as `mail-seal.ts` writes it. HMAC-SHA256 by hand: the app has no other use for an hmac crate.
    #[cfg(windows)]
    fn sealed(kind: &str, id: &str, body: &str) -> String {
        use sha2::{Digest, Sha256};
        let mut key = [0u8; 64];
        key[..TOKEN.len()].copy_from_slice(TOKEN.as_bytes());
        let pad = |x: u8| key.iter().map(|byte| byte ^ x).collect::<Vec<u8>>();
        let inner = Sha256::new().chain_update(pad(0x36)).chain_update(format!("{kind}\n{id}\n{body}")).finalize();
        let outer = Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize();
        let mac: String = outer.iter().map(|byte| format!("{byte:02x}")).collect();
        format!("ade-mac1 {mac}\n{body}")
    }

    /// A folder under the test TEMP, removed when dropped: on a failed assertion too.
    #[cfg(windows)]
    struct Scratch(PathBuf);

    #[cfg(windows)]
    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let dir = std::env::temp_dir().join(format!("ade-msg-{tag}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    #[cfg(windows)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Runs the real `ade-msg.ps1` on `args`, answers its receipt with "ok", and returns the JSON it posted.
    #[cfg(windows)]
    fn posted_by_ps1(tag: &str, args: &[&str], stdin: Option<&[u8]>) -> serde_json::Value {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let scratch = Scratch::new(tag);
        let base = scratch.0.clone();
        for dir in ["outbox", "receipts", "results", "bin"] {
            fs::create_dir_all(base.join(dir)).unwrap();
        }
        let script = base.join("bin").join("ade-msg.ps1");
        fs::write(&script, PS1).unwrap();
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .args(args)
            .current_dir(&base)
            .env("ADE_MAILBOX", &base)
            .env("ADE_PANE_TOKEN", TOKEN)
            .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        if let Some(bytes) = stdin {
            let mut pipe = child.stdin.take().unwrap();
            pipe.write_all(bytes).unwrap();
        }
        // ADE's part: take the posted message and answer it, so the script does not wait out its receipt.
        let started = std::time::Instant::now();
        let posted = loop {
            let found = fs::read_dir(base.join("outbox")).unwrap().flatten().map(|e| e.path()).find(|p| p.extension().is_some_and(|x| x == "json"));
            if let Some(path) = found {
                let id = path.file_stem().unwrap().to_string_lossy().into_owned();
                let body = fs::read_to_string(&path).unwrap();
                fs::write(base.join("receipts").join(format!("{id}.txt")), sealed("receipt", &id, "ok")).unwrap();
                break body;
            }
            assert!(started.elapsed().as_secs() < 30, "ade-msg.ps1 posted nothing");
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        let _ = child.wait();
        assert!(!posted.contains(TOKEN), "the token went into the outbox: {posted}");
        let (_mac, json) = posted.split_once('\n').expect("the MAC on its own line");
        serde_json::from_str(json).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn registro_takes_its_json_from_a_file_or_stdin_with_the_quotes_intact() {
        // Audit 0.7.7, MEDIO 8: as an argument, PowerShell 5.1 drops these quotes on the way to the script.
        let json = r#"{"k":"D1","words":"ha detto \"sì, ma dopo\""}"#;
        let dir = Scratch::new("json");
        let file = dir.0.join("evento.json");
        fs::write(&file, json).unwrap();
        let from_file = posted_by_ps1("file", &["registro", "decisioni", "risposta", "--file", file.to_str().unwrap()], None);
        assert_eq!(from_file["kind"], "registro");
        assert_eq!(from_file["text"], json);
        let from_stdin = posted_by_ps1("stdin", &["registro", "decisioni", "risposta", "--stdin"], Some(json.as_bytes()));
        assert_eq!(from_stdin["text"], json);
        assert!(SH.contains("--stdin) stdin=1;") && SH.contains("registro|send|reply|ask|spawn|update|kv|memory)") && SH.contains("piped=\"$(cat)\""));
    }

    #[cfg(windows)]
    #[test]
    fn every_text_command_takes_its_text_from_stdin_byte_for_byte() {
        // The text of a reply is often what an agent was told not to run: a backtick command, $(...), $0, an apostrophe.
        let hostile = "L'utente ha visto `ragu tunnel` e $(whoami) e $0: niente viene eseguito. è ñ\r\nseconda riga";
        for (tag, args) in [
            ("stdin-reply", vec!["reply", "1790000000000-aaaa", "--stdin"]),
            ("stdin-send", vec!["send", "2", "--stdin"]),
            ("stdin-update", vec!["update", "1790000000000-aaaa", "bloccata", "--stdin"]),
        ] {
            let posted = posted_by_ps1(tag, &args, Some(hostile.as_bytes()));
            assert_eq!(posted["text"], hostile, "{tag}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn design_posts_the_sheet_as_an_absolute_path_with_its_title() {
        let dir = Scratch::new("design");
        let sheet = dir.0.join(".ade").join("design").join("menu.html");
        fs::create_dir_all(sheet.parent().unwrap()).unwrap();
        fs::write(&sheet, "<p>menu</p>").unwrap();
        let posted = posted_by_ps1("design", &["design", sheet.to_str().unwrap(), "--title", "Il menu"], None);
        assert_eq!(posted["kind"], "design");
        // Rooted stays as it is: joining it to the current folder doubled the drive.
        assert_eq!(posted["path"], sheet.to_str().unwrap());
        assert_eq!(posted["title"], "Il menu");
        // The sh twin: the same fields, the path made absolute in Git Bash's Windows spelling.
        assert!(SH.contains("--title) [ $# -ge 2 ] || usage; title=\"$2\"; shift 2; continue ;;"));
        assert!(SH.contains("pwd -W 2>/dev/null || pwd;"));
        assert!(SH.contains("\\\"kind\\\":\\\"design\\\",\\\"path\\\":"));
    }

    /// Runs the real `ade-msg.ps1` in `base` on `args`; what it printed, and how long it took.
    #[cfg(windows)]
    fn run_ps1(base: &std::path::Path, args: &[&str]) -> (String, Duration) {
        use std::process::{Command, Stdio};
        let script = base.join("bin").join("ade-msg.ps1");
        fs::create_dir_all(base.join("bin")).unwrap();
        fs::write(&script, PS1).unwrap();
        let started = std::time::Instant::now();
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .args(args)
            .current_dir(base)
            .env("ADE_MAILBOX", base)
            .env("ADE_PANE_TOKEN", TOKEN)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        (String::from_utf8_lossy(&out.stdout).into_owned(), started.elapsed())
    }

    /*
     * ROADMAP, BASSO: `ade-msg wait` on a request already answered sat out its
     * whole timeout and then said «in corso». The answer had gone to the
     * caller's terminal (nobody was waiting), or to an earlier wait, and with
     * it the only file that said the request was over.
     */
    #[cfg(windows)]
    #[test]
    fn wait_on_a_request_already_answered_says_so_at_once() {
        let scratch = Scratch::new("wait-closed");
        let results = scratch.0.join("results");
        fs::create_dir_all(&results).unwrap();

        // Typed into the caller: nobody was waiting when the answer came.
        let answer = sealed("result", "1790000000000-aaaa", "risposta A");
        fs::write(results.join("1790000000000-aaaa.txt"), &answer).unwrap();
        // Whole: `.closed` stays sealed for a later wait, and the page checks what it takes back.
        assert_eq!(reclaim_result(&results, "1790000000000-aaaa").as_deref(), Some(answer.as_str()));
        let (out, took) = run_ps1(&scratch.0, &["wait", "1790000000000-aaaa", "--timeout", "8"]);
        assert!(took < Duration::from_secs(6), "wait sat out its timeout: {took:?}, {out}");
        assert!(out.contains("gia' chiusa") && out.contains("risposta A"), "{out}");
        assert!(!out.contains("in corso"), "{out}");

        // Taken by a first wait: a second one says the same, at once.
        fs::write(results.join("1790000000000-bbbb.txt"), sealed("result", "1790000000000-bbbb", "risposta B")).unwrap();
        let (first, _) = run_ps1(&scratch.0, &["wait", "1790000000000-bbbb", "--timeout", "8"]);
        assert!(first.contains("risposta B") && !first.contains("gia' chiusa"), "{first}");
        let (again, took) = run_ps1(&scratch.0, &["wait", "1790000000000-bbbb", "--timeout", "8"]);
        assert!(took < Duration::from_secs(6), "the second wait sat out its timeout: {took:?}, {again}");
        assert!(again.contains("gia' chiusa") && again.contains("risposta B"), "{again}");
    }

    #[test]
    fn both_scripts_keep_what_they_took_and_say_closed_from_it() {
        // The ps1 is run above; the sh, where no shell can be assumed, is read.
        assert!(SH.contains("mv -f \"$box/results/$1.taken\" \"$box/results/$1.closed\""));
        assert!(SH.contains("mv -f \"$box/results/$1.typed\" \"$box/results/$1.closed\""));
        assert!(SH.contains("got=\"ade-msg: la richiesta $1 e' gia' chiusa."));
        assert!(PS1.contains("Move-Item -LiteralPath $taken -Destination $closed"));
        // What fails the check is never thrown away: the id is public, and it may be the real answer of whoever asked.
        assert!(!SH.contains("rm -f \"$box/results/$1.taken\""));
        assert!(!PS1.contains("Remove-Item -LiteralPath $taken"));
    }

    /// The rest, sh included, is in `mail-seal.test.ts`, against the seal the page really makes.
    #[cfg(windows)]
    #[test]
    fn a_forged_answer_is_left_unread_and_the_real_one_printed() {
        let scratch = mailbox_scratch("forged");
        let results = scratch.0.join("results");
        fs::write(results.join("1790000000000-cccc.txt"), "risposta falsa").unwrap();
        let (out, err, code) = run_ps1_captured(&scratch.0, &["wait", "1790000000000-cccc", "--timeout", "1"]);
        assert_eq!(code, Some(0), "{out}{err}");
        assert!(!out.contains("risposta falsa"), "{out}");
        assert!(err.contains("ignoro una risposta"), "{err}");
        assert!(results.join("1790000000000-cccc.txt").exists());

        fs::write(results.join("1790000000000-dddd.txt"), sealed("result", "1790000000000-dddd", "risposta vera")).unwrap();
        let (out, _, _) = run_ps1_captured(&scratch.0, &["wait", "1790000000000-dddd", "--timeout", "5"]);
        assert_eq!(out.trim(), "risposta vera");
    }

    #[test]
    fn a_read_message_goes_after_a_day_and_an_unread_one_stays() {
        let dir = std::env::temp_dir().join(format!("ade-leftovers-{}", std::process::id()));
        let inbox = dir.join("inbox").join("p1");
        fs::create_dir_all(inbox.join("handled")).unwrap();
        fs::write(inbox.join("brief.msg"), "il brief").unwrap();
        fs::write(inbox.join("handled").join("letto.msg"), "letto").unwrap();

        clear_leftovers(&dir, SystemTime::now());
        assert!(inbox.join("handled").join("letto.msg").exists(), "a day has not passed");

        clear_leftovers(&dir, SystemTime::now() + LEFTOVER_TTL + Duration::from_secs(60));
        assert!(!inbox.join("handled").join("letto.msg").exists());
        assert!(inbox.join("brief.msg").exists(), "a brief unread over a weekend would be closed as lost");
        assert!(inbox.join("handled").is_dir(), "the folder is not a leftover");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_message_no_longer_there_is_none_and_not_an_error() {
        let dir = std::env::temp_dir().join(format!("ade-inbox-text-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("m.msg");
        assert_eq!(read_if_there(&file), Ok(None));
        fs::write(&file, "testo").unwrap();
        assert_eq!(read_if_there(&file), Ok(Some("testo".to_string())));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_inbox_file_over_the_cap_is_not_read() {
        let dir = std::env::temp_dir().join(format!("ade-inbox-big-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("grande.msg");
        fs::write(&file, "x".repeat(MAX_MESSAGE_BYTES as usize + 1)).unwrap();
        assert_eq!(read_if_there(&file), Ok(None));
        fs::write(&file, "x".repeat(MAX_MESSAGE_BYTES as usize)).unwrap();
        assert_eq!(read_if_there(&file).unwrap().map(|text| text.len()), Some(MAX_MESSAGE_BYTES as usize));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_scripts_are_beside_the_mailbox_and_not_in_it() {
        let data = Path::new("C:/dati/ade");
        assert_eq!(bin_beside(&data.join("mailbox")), Some(data.join("bin")));
        // An ADE Test keeps its own, per worktree; a folder with another name cannot take the name of a real one.
        let state = Path::new("C:/lavoro/.ade-test");
        assert_eq!(bin_beside(&state.join("casella")), Some(state.join("casella-bin")));
        assert!(!bin_beside(&data.join("mailbox")).unwrap().starts_with(data.join("mailbox")));
    }

    #[test]
    fn a_message_id_cannot_become_a_path() {
        assert!(valid_id("1757860000000-ab12cd34"));
        assert!(valid_id("1757860000000-4242"));
        for bad in ["", "../x", "a/b", "a\\b", "a.json", &"1".repeat(81)] {
            assert!(!valid_id(bad), "{bad} was accepted");
        }
    }

    #[cfg(windows)]
    #[test]
    fn design_proponi_and_attendi_post_the_folder_the_cwd_and_the_timeout() {
        let posted = posted_by_ps1("prop", &["design", "proponi", r".ade\design\DS-t2"], None);
        assert_eq!(posted["kind"], "design");
        assert_eq!(posted["op"], "proponi");
        assert_eq!(posted["folder"], r".ade\design\DS-t2");
        assert_eq!(posted["attendi"], false);
        assert_eq!(posted["timeout"], 1800);
        // The folder is judged by ADE against the project: the script resolves nothing, it says where it is.
        assert!(posted["cwd"].as_str().is_some_and(|cwd| std::path::Path::new(cwd).is_absolute()), "{posted}");

        // These two wait for a choice that never comes here: a short timeout, so the helper's wait ends.
        let waiting = posted_by_ps1("prop-wait", &["design", "proponi", r".ade\design\DS-t2", "--attendi", "--timeout", "2"], None);
        assert_eq!(waiting["attendi"], true);
        assert_eq!(waiting["timeout"], 2);

        let again = posted_by_ps1("att", &["design", "attendi", "DS-t2", "--timeout", "1"], None);
        assert_eq!(again["op"], "attendi");
        assert_eq!(again["key"], "DS-t2");
        assert_eq!(again["timeout"], 1);
        assert!(PS1.contains("$t = if ($timeoutSet) { $timeout } else { 1800 }"));

        // A day at most, as ADE counts it (without --attendi, so the helper's wait ends at once).
        let long = posted_by_ps1("prop-long", &["design", "proponi", r".ade\design\DS-t2", "--timeout", "200000"], None);
        assert_eq!(long["timeout"], 86400);
        assert!(SH.contains(r#"[ ${#t} -gt 5 ] || [ "$t" -gt 86400 ] && t=86400"#));

        // The sheet with notes still works: told apart by its first argument.
        let dir = Scratch::new("design-sheet");
        let sheet = dir.0.join("menu.html");
        fs::write(&sheet, "<p>menu</p>").unwrap();
        let shown = posted_by_ps1("sheet", &["design", sheet.to_str().unwrap()], None);
        assert_eq!(shown["path"], sheet.to_str().unwrap());
        assert!(shown.get("op").is_none());
    }

    /// Runs the real `ade-msg.ps1` in `base`: what it printed, how long it took, its exit code.
    #[cfg(windows)]
    fn run_ps1_status(base: &std::path::Path, args: &[&str]) -> (String, Duration, Option<i32>) {
        use std::process::{Command, Stdio};
        let script = base.join("bin").join("ade-msg.ps1");
        fs::create_dir_all(base.join("bin")).unwrap();
        fs::write(&script, PS1).unwrap();
        let started = std::time::Instant::now();
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .args(args)
            .current_dir(base)
            .env("ADE_MAILBOX", base)
            .env("ADE_PANE_TOKEN", TOKEN)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        (String::from_utf8_lossy(&out.stdout).into_owned(), started.elapsed(), out.status.code())
    }

    /// Runs the real `ade-msg.ps1` in `base` on `args`: stdout, stderr, exit code.
    #[cfg(windows)]
    fn run_ps1_captured(base: &std::path::Path, args: &[&str]) -> (String, String, Option<i32>) {
        use std::process::{Command, Stdio};
        let script = base.join("bin").join("ade-msg.ps1");
        fs::create_dir_all(base.join("bin")).unwrap();
        fs::write(&script, PS1).unwrap();
        let out = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script)
            .args(args)
            .current_dir(base)
            .env("ADE_MAILBOX", base)
            .env("ADE_PANE_TOKEN", TOKEN)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        (
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
            out.status.code(),
        )
    }

    /// ADE's part for the one message posted: its receipt, then, after a pause, the answer if there is one.
    #[cfg(windows)]
    fn answer_design(
        base: PathBuf,
        receipt: &'static str,
        answer: Option<(&'static str, Duration)>,
    ) -> std::thread::JoinHandle<Option<String>> {
        std::thread::spawn(move || {
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(20) {
                let found = fs::read_dir(base.join("outbox"))
                    .ok()?
                    .flatten()
                    .map(|e| e.path())
                    .find(|p| p.extension().is_some_and(|x| x == "json"));
                if let Some(path) = found {
                    let id = path.file_stem().unwrap().to_string_lossy().into_owned();
                    let _ = fs::remove_file(&path);
                    fs::write(base.join("receipts").join(format!("{id}.txt")), sealed("receipt", &id, receipt)).unwrap();
                    if let Some((text, after)) = answer {
                        std::thread::sleep(after);
                        fs::write(base.join("results").join(format!("{id}.txt")), sealed("result", &id, text)).unwrap();
                    }
                    return Some(id);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            None
        })
    }

    #[cfg(windows)]
    fn mailbox_scratch(tag: &str) -> Scratch {
        let scratch = Scratch::new(tag);
        for dir in ["outbox", "receipts", "results", "bin"] {
            fs::create_dir_all(scratch.0.join(dir)).unwrap();
        }
        scratch
    }

    #[cfg(windows)]
    #[test]
    fn design_proponi_attendi_prints_the_choice_when_it_comes_and_leaves_it_claimed() {
        let scratch = mailbox_scratch("des-answer");
        let line = "scelta: 2 · Carta — parole: \"ottima\"";
        let ade = answer_design(scratch.0.clone(), "ok: DS-t2 aperta", Some((line, Duration::from_millis(1500))));
        let (out, took, code) =
            run_ps1_status(&scratch.0, &["design", "proponi", r".ade\design\DS-t2", "--attendi", "--timeout", "15"]);
        let id = ade.join().unwrap().expect("posted");
        assert_eq!(code, Some(0), "{out}");
        assert!(took < Duration::from_secs(12), "took too long: {took:?}");
        assert_eq!(out.trim(), line);
        // Claimed: nothing left for ADE to take back and type into the terminal.
        let results = scratch.0.join("results");
        assert!(!results.join(format!("{id}.txt")).exists());
        assert_eq!(reclaim_result(&results, &id), None);
    }

    #[cfg(windows)]
    #[test]
    fn design_without_a_choice_in_time_exits_2_and_says_how_to_resume() {
        let scratch = mailbox_scratch("des-timeout");
        let ade = answer_design(scratch.0.clone(), "ok: in attesa della scelta su DS-t2", None);
        let (out, took, code) = run_ps1_status(&scratch.0, &["design", "attendi", "DS-t2", "--timeout", "2"]);
        let id = ade.join().unwrap().expect("posted");
        assert_eq!(code, Some(2), "{out}");
        assert!(took >= Duration::from_millis(1800), "finished too early: {took:?}");
        assert!(out.contains("ancora nessuna scelta su DS-t2; riprendi con: ade-msg design attendi DS-t2"), "{out}");
        // A choice made afterwards is not lost: nobody took it, so ADE takes it back to type it.
        let results = scratch.0.join("results");
        fs::write(results.join(format!("{id}.txt")), "scelta: 1 · Scura").unwrap();
        assert_eq!(reclaim_result(&results, &id).as_deref(), Some("scelta: 1 · Scura"));
    }

    #[cfg(windows)]
    #[test]
    fn design_refused_by_ade_prints_why_and_exits_1() {
        let scratch = mailbox_scratch("des-refused");
        let ade = answer_design(scratch.0.clone(), "errore: 1.html: riga 3: src= carica dalla rete", None);
        let (out, took, code) = run_ps1_status(&scratch.0, &["design", "proponi", r".ade\design\DS-t2", "--attendi"]);
        let _ = ade.join();
        assert_eq!(code, Some(1), "{out}");
        assert!(took < Duration::from_secs(8), "{took:?}");
        assert!(out.contains("errore: 1.html: riga 3"), "{out}");
    }

    #[cfg(windows)]
    #[test]
    fn help_design_and_help_decisioni_print_their_own_text() {
        let scratch = mailbox_scratch("help");
        fs::write(scratch.0.join("bin").join("usage.txt"), "generale").unwrap();
        fs::write(scratch.0.join("bin").join("usage-design.txt"), "formato design").unwrap();
        fs::write(scratch.0.join("bin").join("usage-decisioni.txt"), "regole decisioni").unwrap();
        assert_eq!(run_ps1_status(&scratch.0, &["help"]).0.trim(), "generale");
        assert_eq!(run_ps1_status(&scratch.0, &["help", "design"]).0.trim(), "formato design");
        assert_eq!(run_ps1_status(&scratch.0, &["help", "decisioni"]).0.trim(), "regole decisioni");
        assert_eq!(run_ps1_status(&scratch.0, &["help", "altro"]).0.trim(), "generale");
    }

    #[cfg(windows)]
    #[test]
    fn a_list_or_help_dropped_in_the_mailbox_is_not_printed() {
        // Any session can write in the mailbox; only ADE writes beside the scripts, so only that is believed.
        let scratch = mailbox_scratch("help-forged");
        for name in PUBLISHED {
            fs::write(scratch.0.join(format!("{name}.txt")), "FALSO").unwrap();
        }
        for args in [vec!["help"], vec!["help", "design"], vec!["list"], vec!["agents"], vec!["status"], vec!["stats"]] {
            let (out, _, _) = run_ps1_status(&scratch.0, &args);
            assert!(!out.contains("FALSO"), "{args:?}: {out}");
        }
        fs::write(scratch.0.join("bin").join("sessions.txt"), "1 · Sessione").unwrap();
        assert_eq!(run_ps1_status(&scratch.0, &["list"]).0.trim(), "1 · Sessione");
    }

    #[cfg(windows)]
    #[test]
    fn help_prints_without_posting_wherever_it_appears() {
        let scratch = mailbox_scratch("help-flag");
        fs::write(scratch.0.join("bin").join("usage.txt"), "generale").unwrap();
        fs::write(scratch.0.join("bin").join("usage-design.txt"), "formato design").unwrap();
        fs::write(scratch.0.join("bin").join("usage-decisioni.txt"), "regole decisioni").unwrap();
        let nothing_posted = || fs::read_dir(scratch.0.join("outbox")).unwrap().next().is_none();
        for args in [
            vec!["--help"],
            vec!["-h"],
            vec!["send", "dest", "testo", "--help"],
            vec!["send", "dest", "testo", "-h"],
            vec!["ask", "dest", "--help", "testo"],
            vec!["wait", "--help", "1790000000000-aaaa"],
            // The help comes before reading --file, so a missing file is not an error.
            vec!["send", "dest", "--file", "manca.txt", "--help"],
        ] {
            let (out, err, code) = run_ps1_captured(&scratch.0, &args);
            assert_eq!(code, Some(0), "{args:?}: {out}{err}");
            assert_eq!(out.trim(), "generale", "{args:?}");
            assert!(!err.contains("file non trovato"), "{args:?}: {err}");
            assert!(nothing_posted(), "{args:?} posted a message");
        }
        // --stdin is not read either: the help answers at once.
        let (out, err, code) = run_ps1_captured(&scratch.0, &["registro", "decisioni", "risposta", "--stdin", "--help"]);
        assert_eq!(code, Some(0), "{out}{err}");
        assert_eq!(out.trim(), "regole decisioni");
        assert!(nothing_posted(), "registro --stdin --help posted a message");
        let (out, err, code) = run_ps1_captured(&scratch.0, &["design", "proponi", r".ade\design\DS-t2", "--help"]);
        assert_eq!(code, Some(0), "{out}{err}");
        assert_eq!(out.trim(), "formato design");
        assert!(nothing_posted(), "design --help posted a message");
        // The sh twin is read here: no shell can be assumed on this machine.
        assert!(SH.contains("-h|--help) wanthelp=1; shift; continue ;;"));
        assert!(SH.contains("if [ $wanthelp = 1 ]; then"));
    }

    #[cfg(windows)]
    #[test]
    fn an_unknown_option_is_an_error_and_never_a_message() {
        let scratch = mailbox_scratch("unknown-option");
        let (out, err, code) = run_ps1_captured(&scratch.0, &["send", "dest", "testo", "--x"]);
        assert_eq!(code, Some(1), "{out}{err}");
        assert!(err.contains("opzione sconosciuta: --x"), "{err}");
        assert!(out.trim().is_empty(), "{out}");
        assert!(fs::read_dir(scratch.0.join("outbox")).unwrap().next().is_none());
        // A sentence that carries -- inside stays text.
        let inside = posted_by_ps1("dash-inside", &["send", "dest", "testo con -- dentro"], None);
        assert_eq!(inside["text"], "testo con -- dentro");
        // A text that starts with -- is still reachable: after the end-of-options marker.
        let after = posted_by_ps1("dash-after", &["send", "dest", "--", "--x"], None);
        assert_eq!(after["text"], "--x");
        // The sh twin is read here: no shell can be assumed on this machine.
        assert!(SH.contains(r#"--*) fail "opzione sconosciuta: $a" ;;"#));
        assert!(SH.contains("--) options=0; shift; continue ;;"));
    }

    #[test]
    fn the_sh_script_has_the_same_design_commands() {
        // The ps1 is run above; the sh, where no shell can be assumed, is read.
        assert!(SH.contains(r#"if [ "$head" = proponi ] || [ "$head" = attendi ]; then"#));
        assert!(SH.contains(r#"\"op\":\"proponi\",\"folder\":\"$(esc "$second")\",\"cwd\":\"$(esc "$(pwd -W 2>/dev/null || pwd)")\",\"attendi\":$a,\"timeout\":$t"#));
        assert!(SH.contains(r#"\"op\":\"attendi\",\"key\":\"$(esc "$k")\",\"timeout\":$t"#));
        assert!(SH.contains(r#"t="$timeout"; [ "$timeout_set" = 0 ] && t=1800"#));
        assert!(SH.contains("echo \"ancora nessuna scelta su $k; riprendi con: ade-msg design attendi $k\"\n      exit 2"));
        assert!(SH.contains(r#"if take "$id"; then printf '%s\n' "$got"; exit 0; fi"#));
        assert!(SH.contains("--attendi) attendi=1; shift; continue ;;"));
        assert!(SH.contains(r#"case "$head" in design|decisioni) f="$here/usage-$head.txt" ;; esac"#));
        // Both fallbacks of both scripts name the commands an agent needs most.
        for script in [PS1, SH] {
            assert_eq!(script.matches("| registro | design proponi").count(), 2);
        }
    }
}
