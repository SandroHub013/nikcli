//! NikVerse's assets, fetched the first time the world is opened.
//!
//! The installer does not carry them (`nikverse-assets/` is no longer in `bundle.resources`): they are models, lightmaps and the world's
//! bundle, and most people open NikVerse rarely or never. What the binary carries is the list (`MANIFEST`, from `build.rs`: every file with its
//! size and SHA-256), and the list is what makes fetching safe: a file is asked for by the hash the binary was built with, it is kept only if
//! it has exactly that size and that hash, and the scheme (`nikverse.rs`) serves only what is in the list and still has its hash. The network
//! cannot put anything in the world's folder that the binary did not name.
//!
//! Where from: the release `ade-updater`, the one installed copies already read their update manifest from, with one asset per file named
//! `nikverse-<sha256>` (`ade-release.yml` puts them there before a release is public). Addressed by content: the same file in two versions
//! is one asset, and an older app finds the files its own list names. Where to: `<app local data>/nikverse-assets/`, the folder the scheme
//! reads in a release. A debug build reads the sources and has nothing to fetch.
//!
//! One file at a time, into `<name>.part`, checked, then renamed: a reader never finds half a file, and a download that dies leaves nothing
//! that looks like progress. The progress is read by polling (`nikverse_assets_status`), like the voice packs': the panel asks while it waits.

use crate::nikverse::{sha256_hex, ManifestEntry, Source, MANIFEST};
use crate::tts::{Curl, Fetcher};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// The release the files are attached to, and the start of every asset's name in it.
pub const BASE_URL: &str = "https://github.com/SandroHub013/nikcli/releases/download/ade-updater/nikverse-";

/// Where one manifest entry is fetched from. Only the hash goes into the address: the entry's path is never part of a URL.
pub fn url_of(entry: &ManifestEntry) -> String {
    format!("{BASE_URL}{}", entry.sha256)
}

const ATTEMPTS: usize = 3;
const RENAME_WAIT: std::time::Duration = std::time::Duration::from_millis(200);

const BROKEN: &str = "Il download si è interrotto prima del file atteso: scartato.";
const WRONG: &str = "Il file scaricato non corrisponde a quello atteso: scartato.";

/// What the panel is told about a fetch, running or just over.
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct Progress {
    pub running: bool,
    /// Files in place over the files this fetch is made of.
    pub files_done: u32,
    pub files_total: u32,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Why the last fetch stopped, in the user's words.
    pub error: Option<String>,
}

/// The answer to «is the world's folder complete?».
#[derive(Serialize, Debug, PartialEq)]
pub struct Status {
    /// Nothing to fetch: every file of the list is in place (always, in a debug build).
    pub ready: bool,
    pub missing_files: u32,
    pub missing_bytes: u64,
    #[serde(flatten)]
    pub progress: Progress,
}

/// The one fetch that may run, and what it reports.
#[derive(Default)]
pub struct Assets {
    progress: Mutex<Progress>,
}

impl Assets {
    fn read(&self) -> Progress {
        self.progress.lock().map(|p| p.clone()).unwrap_or_default()
    }

    fn update(&self, change: impl FnOnce(&mut Progress)) {
        if let Ok(mut progress) = self.progress.lock() {
            change(&mut progress);
        }
    }

    /// Takes the turn: false when a fetch is already running (then that one is the one to watch).
    fn begin(&self, files: u32, bytes: u64) -> bool {
        let Ok(mut progress) = self.progress.lock() else { return false };
        if progress.running {
            return false;
        }
        *progress = Progress { running: true, files_total: files, bytes_total: bytes, ..Progress::default() };
        true
    }
}

/// Whether the file of `entry` is in `root` with the size and the hash the list says. Anything else, missing or not, is missing.
fn present(root: &Path, entry: &ManifestEntry) -> bool {
    let file = root.join(entry.path);
    match std::fs::metadata(&file) {
        Ok(meta) if meta.is_file() && meta.len() == entry.size => {}
        _ => return false,
    }
    std::fs::read(&file).map(|bytes| sha256_hex(&bytes) == entry.sha256).unwrap_or(false)
}

/// The entries of `manifest` that are not in `root` as they must be.
pub fn missing<'a>(root: &Path, manifest: &'a [ManifestEntry]) -> Vec<&'a ManifestEntry> {
    manifest.iter().filter(|entry| !present(root, entry)).collect()
}

/// Where a file is written before it is whole: its name and `.part` (never its extension replaced, `a.glb` and `a.ktx2` must not share one).
fn staging(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".part");
    dest.with_file_name(name)
}

/// Moves a whole file into place. On Windows the antivirus may hold it for a moment, so a refusal is tried a few times before it is believed.
fn rename_into_place(from: &Path, dest: &Path) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 1..=ATTEMPTS {
        match std::fs::rename(from, dest) {
            Ok(()) => return Ok(()),
            Err(problem) => {
                last = problem.to_string();
                if attempt < ATTEMPTS {
                    std::thread::sleep(RENAME_WAIT);
                }
            }
        }
    }
    let _ = std::fs::remove_file(from);
    Err(format!("Impossibile mettere in posto {}: {last}", dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()))
}

/// Fetches what is missing from `root`, one file at a time, each checked before it is put in place.
///
/// `url` names where an entry is fetched from, `fetcher` does the fetching (a test hands one that never touches the network), `stop` is asked
/// while a transfer waits: `Some(reason)` ends it. Returns the first failure, and leaves nothing half-written behind it.
pub fn install_into(
    root: &Path,
    manifest: &[ManifestEntry],
    url: &dyn Fn(&ManifestEntry) -> String,
    fetcher: &dyn Fetcher,
    assets: &Assets,
    stop: &dyn Fn() -> Option<String>,
) -> Result<(), String> {
    let todo = missing(root, manifest);
    let bytes: u64 = todo.iter().map(|entry| entry.size).sum();
    if !assets.begin(todo.len() as u32, bytes) {
        return Ok(());
    }
    let outcome = fetch_all(root, &todo, url, fetcher, assets, stop);
    assets.update(|progress| {
        progress.running = false;
        progress.error = outcome.as_ref().err().cloned();
    });
    outcome
}

fn fetch_all(
    root: &Path,
    todo: &[&ManifestEntry],
    url: &dyn Fn(&ManifestEntry) -> String,
    fetcher: &dyn Fetcher,
    assets: &Assets,
    stop: &dyn Fn() -> Option<String>,
) -> Result<(), String> {
    let mut before = 0u64;
    for entry in todo {
        if let Some(reason) = stop() {
            return Err(reason);
        }
        let dest = root.join(entry.path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let part = staging(&dest);
        let _ = std::fs::remove_file(&part);
        // The list says how much the file weighs: a body larger than that is refused before it is written.
        let written = fetcher.fetch_within(
            &url(entry),
            &part,
            Some(entry.size),
            &mut |so_far| assets.update(|progress| progress.bytes_done = before + so_far.min(entry.size)),
            stop,
        );
        let checked = written.and_then(|len| {
            if len != entry.size {
                return Err(BROKEN.to_string());
            }
            let bytes = std::fs::read(&part).map_err(|e| e.to_string())?;
            if bytes.len() as u64 != entry.size || sha256_hex(&bytes) != entry.sha256 {
                return Err(WRONG.to_string());
            }
            Ok(())
        });
        if let Err(reason) = checked {
            let _ = std::fs::remove_file(&part);
            return Err(reason);
        }
        rename_into_place(&part, &dest)?;
        before += entry.size;
        assets.update(|progress| {
            progress.files_done += 1;
            progress.bytes_done = before;
        });
    }
    Ok(())
}

/// The folder the assets are fetched into, when this run has one (a release: the app's local data; a debug build: nothing to fetch).
fn target(source: &Source) -> Option<&Path> {
    if source.verifies() {
        source.root()
    } else {
        None
    }
}

/// The status of the world's folder now. Reads and hashes the files, so it is asked when a panel opens and not on a timer:
/// while a fetch runs the panel reads the progress from the same answer without hashing anything.
fn status_of(source: &Source, manifest: &[ManifestEntry], assets: &Assets) -> Status {
    let progress = assets.read();
    let Some(root) = target(source) else {
        return Status { ready: true, missing_files: 0, missing_bytes: 0, progress };
    };
    if progress.running {
        let left = progress.files_total.saturating_sub(progress.files_done);
        return Status { ready: false, missing_files: left, missing_bytes: progress.bytes_total.saturating_sub(progress.bytes_done), progress };
    }
    let todo = missing(root, manifest);
    Status {
        ready: todo.is_empty(),
        missing_files: todo.len() as u32,
        missing_bytes: todo.iter().map(|entry| entry.size).sum(),
        progress,
    }
}

#[tauri::command]
pub async fn nikverse_assets_status(app: tauri::AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Assets>();
        status_of(crate::nikverse::source(&app), MANIFEST, &state)
    })
    .await
    .map_err(|e| e.to_string())
}

/// What the assets weigh on this disk: the files of the list that are there, by the size the disk says (no hashing: this is asked to show a
/// number), and what a fetch that died left as `<name>.part`.
pub fn installed_bytes(root: &Path, manifest: &[ManifestEntry]) -> u64 {
    manifest
        .iter()
        .map(|entry| {
            let file = root.join(entry.path);
            let size = |f: &Path| std::fs::metadata(f).map(|meta| if meta.is_file() { meta.len() } else { 0 }).unwrap_or(0);
            size(&file) + size(&staging(&file))
        })
        .sum()
}

/// Takes the assets away again, and says how much that freed; they are fetched again the next time the world opens.
///
/// Only the files the list names (and their `.part` leftovers) go, never the folder as a whole: what is in `root` that the binary did not name
/// is not this code's to remove. The folders left empty go after them, the root last. Refused while a fetch is running, which is told by the
/// same turn the fetch takes: the removal takes it too, so a fetch that starts meanwhile finds it taken and waits for nothing, and the files
/// of a fetch in progress are not deleted from under it.
pub fn remove_from(root: &Path, manifest: &[ManifestEntry], assets: &Assets) -> Result<u64, String> {
    if !assets.begin(0, 0) {
        return Err("Il download è in corso: fermalo prima di cancellare.".into());
    }
    let outcome = remove_files(root, manifest);
    assets.update(|progress| {
        progress.running = false;
        progress.error = None;
    });
    outcome
}

fn remove_files(root: &Path, manifest: &[ManifestEntry]) -> Result<u64, String> {
    let mut freed = 0;
    let mut folders: Vec<PathBuf> = Vec::new();
    for entry in manifest {
        let file = root.join(entry.path);
        for target in [file.clone(), staging(&file)] {
            match std::fs::metadata(&target) {
                Ok(meta) if meta.is_file() => {
                    let size = meta.len();
                    std::fs::remove_file(&target).map_err(|e| format!("{}: {e}", target.display()))?;
                    freed += size;
                }
                _ => {}
            }
        }
        let mut parent = file.parent().map(Path::to_path_buf);
        while let Some(dir) = parent {
            if dir == root || !dir.starts_with(root) {
                break;
            }
            if !folders.contains(&dir) {
                folders.push(dir.clone());
            }
            parent = dir.parent().map(Path::to_path_buf);
        }
    }
    // Deepest first, so a folder is empty by the time it is asked; `remove_dir` refuses one that is not, which is the check.
    folders.sort_by_key(|dir| std::cmp::Reverse(dir.components().count()));
    for dir in folders {
        let _ = std::fs::remove_dir(&dir);
    }
    let _ = std::fs::remove_dir(root);
    Ok(freed)
}

#[tauri::command]
pub async fn nikverse_assets_bytes(app: tauri::AppHandle) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(target(crate::nikverse::source(&app)).map(|root| installed_bytes(root, MANIFEST)).unwrap_or(0))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Takes the fetched assets off the disk; the bytes freed (nothing in a debug build, which reads the sources and has none fetched).
#[tauri::command]
pub async fn nikverse_assets_remove(app: tauri::AppHandle) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Assets>();
        match target(crate::nikverse::source(&app)) {
            Some(root) => remove_from(root, MANIFEST, &state),
            None => Ok(0),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fetches what is missing. Returns when it is over (the panel watches the progress meanwhile); an error comes back as the message to show.
#[tauri::command]
pub async fn nikverse_assets_install(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Assets>();
        let Some(root) = target(crate::nikverse::source(&app)) else { return Ok(()) };
        // Never for longer than this in all: a transfer that is never going to arrive is not waited for.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15 * 60);
        install_into(
            root,
            MANIFEST,
            &url_of,
            &Curl,
            &state,
            &|| (std::time::Instant::now() > deadline).then(|| "Download interrotto: il tempo è scaduto.".to_string()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Scratch {
            static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "nikverse-assets-{}-{}",
                std::process::id(),
                N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn entry(path: &'static str, bytes: &[u8]) -> ManifestEntry {
        let sha256: &'static str = Box::leak(sha256_hex(bytes).into_boxed_str());
        ManifestEntry { path, sha256, size: bytes.len() as u64 }
    }

    /// A fetcher that answers from a table by URL, and writes what the table says to the part file.
    struct Table {
        bodies: Vec<(String, Vec<u8>)>,
        asked: RefCell<Vec<String>>,
        /// The size limit each request came with.
        limits: RefCell<Vec<Option<u64>>>,
        /// Reports this many bytes short: the connection dropped.
        cut: Option<usize>,
    }
    impl Fetcher for Table {
        fn fetch_within(
            &self,
            url: &str,
            part: &Path,
            limit: Option<u64>,
            report: &mut dyn FnMut(u64),
            stop: &dyn Fn() -> Option<String>,
        ) -> Result<u64, String> {
            self.limits.borrow_mut().push(limit);
            self.fetch(url, part, report, stop)
        }

        fn fetch(
            &self,
            url: &str,
            part: &Path,
            report: &mut dyn FnMut(u64),
            _stop: &dyn Fn() -> Option<String>,
        ) -> Result<u64, String> {
            self.asked.borrow_mut().push(url.to_string());
            let body = self.bodies.iter().find(|(u, _)| u == url).map(|(_, b)| b.clone()).ok_or("404")?;
            let body = match self.cut {
                Some(short) => body[..body.len().saturating_sub(short)].to_vec(),
                None => body,
            };
            std::fs::write(part, &body).map_err(|e| e.to_string())?;
            report(body.len() as u64);
            Ok(body.len() as u64)
        }
    }

    fn table(manifest: &[ManifestEntry], bodies: &[&[u8]]) -> Table {
        Table {
            bodies: manifest.iter().zip(bodies).map(|(entry, body)| (url_of(entry), body.to_vec())).collect(),
            asked: RefCell::new(Vec::new()),
            limits: RefCell::new(Vec::new()),
            cut: None,
        }
    }

    fn never() -> Option<String> {
        None
    }

    #[test]
    fn every_file_is_asked_for_with_the_size_the_list_gives_as_its_limit() {
        let root = Scratch::new();
        let manifest = [entry("a.txt", b"alpha"), entry("sub/b.txt", b"bravo!")];
        let fetcher = table(&manifest, &[b"alpha", b"bravo!"]);
        install_into(&root.0, &manifest, &url_of, &fetcher, &Assets::default(), &never).unwrap();
        assert_eq!(*fetcher.limits.borrow(), vec![Some(5), Some(6)]);
    }

    #[test]
    fn curl_is_kept_on_https_and_told_the_limit() {
        use crate::tts::curl_guard;
        let https = curl_guard(&url_of(&entry("a.txt", b"alpha")), Some(5));
        assert_eq!(https, ["--proto", "=https", "--proto-redir", "=https", "--max-filesize", "5"]);
        // A loopback server in a test speaks http: nothing to restrict there, and the limit still holds.
        assert_eq!(curl_guard("http://127.0.0.1:9/x", Some(5)), ["--max-filesize", "5"]);
        assert!(curl_guard("https://example.org/x", None).iter().all(|a| a != "--max-filesize"));
    }

    #[test]
    fn a_body_larger_than_the_list_says_is_refused_and_leaves_nothing() {
        let root = Scratch::new();
        // The list says five bytes; the server has eleven.
        let manifest = [entry("levels/a.glb", b"alpha")];
        let (port, server) = serve(vec![(format!("/nikverse-{}", manifest[0].sha256), b"model bytes".to_vec())], 1);
        let url = |entry: &ManifestEntry| format!("http://127.0.0.1:{port}/nikverse-{}", entry.sha256);
        let error = install_into(&root.0, &manifest, &url, &Curl, &Assets::default(), &never).unwrap_err();
        server.join().unwrap();
        assert!(!error.is_empty());
        assert!(!root.0.join("levels/a.glb").exists() && !root.0.join("levels/a.glb.part").exists());
    }

    #[test]
    fn the_address_of_a_file_is_the_release_and_its_hash_and_never_its_path() {
        let e = entry("levels/media/city.glb", b"city");
        let url = url_of(&e);
        assert_eq!(url, format!("{BASE_URL}{}", e.sha256));
        assert!(url.starts_with("https://github.com/SandroHub013/nikcli/releases/download/ade-updater/nikverse-"));
        assert!(!url.contains("city.glb") && !url.contains("levels"));
    }

    #[test]
    fn what_is_missing_is_what_is_absent_short_or_not_the_file_the_list_names() {
        let root = Scratch::new();
        let manifest = [entry("a.txt", b"alpha"), entry("sub/b.txt", b"bravo"), entry("c.txt", b"charlie"), entry("d.txt", b"delta")];
        std::fs::create_dir_all(root.0.join("sub")).unwrap();
        std::fs::write(root.0.join("a.txt"), b"alpha").unwrap(); // whole
        std::fs::write(root.0.join("sub/b.txt"), b"brav").unwrap(); // short
        std::fs::write(root.0.join("c.txt"), b"charlix").unwrap(); // same size, other bytes
        // d.txt is absent
        let names: Vec<&str> = missing(&root.0, &manifest).iter().map(|e| e.path).collect();
        assert_eq!(names, ["sub/b.txt", "c.txt", "d.txt"]);
    }

    #[test]
    fn a_fetch_puts_every_missing_file_in_place_checked_and_reports_it() {
        let root = Scratch::new();
        let manifest = [entry("levels/a.glb", b"aaaa"), entry("levels/lightmap/b.ktx2", b"bbbbbb")];
        let fetcher = table(&manifest, &[b"aaaa", b"bbbbbb"]);
        let assets = Assets::default();
        install_into(&root.0, &manifest, &url_of, &fetcher, &assets, &never).unwrap();
        assert_eq!(std::fs::read(root.0.join("levels/a.glb")).unwrap(), b"aaaa");
        assert_eq!(std::fs::read(root.0.join("levels/lightmap/b.ktx2")).unwrap(), b"bbbbbb");
        assert!(missing(&root.0, &manifest).is_empty());
        assert_eq!(
            assets.read(),
            Progress { running: false, files_done: 2, files_total: 2, bytes_done: 10, bytes_total: 10, error: None }
        );
        // Nothing half-written is left.
        assert!(!root.0.join("levels/a.glb.part").exists() && !root.0.join("levels/lightmap/b.ktx2.part").exists());
    }

    #[test]
    fn a_file_already_in_place_is_not_asked_for_again() {
        let root = Scratch::new();
        let manifest = [entry("a.txt", b"alpha"), entry("b.txt", b"bravo")];
        std::fs::write(root.0.join("a.txt"), b"alpha").unwrap();
        let fetcher = table(&manifest, &[b"alpha", b"bravo"]);
        install_into(&root.0, &manifest, &url_of, &fetcher, &Assets::default(), &never).unwrap();
        assert_eq!(*fetcher.asked.borrow(), [url_of(&manifest[1])]);
    }

    #[test]
    fn a_file_with_the_wrong_hash_is_never_written() {
        let root = Scratch::new();
        let manifest = [entry("a.txt", b"alpha")];
        // Same size, other bytes: what a swapped release asset looks like.
        let fetcher = table(&manifest, &[b"alphX"]);
        let assets = Assets::default();
        let error = install_into(&root.0, &manifest, &url_of, &fetcher, &assets, &never).unwrap_err();
        assert_eq!(error, WRONG);
        assert!(!root.0.join("a.txt").exists(), "un file con l'hash sbagliato non viene scritto");
        assert!(!root.0.join("a.txt.part").exists(), "e non resta il .part");
        let progress = assets.read();
        assert!((progress.running, progress.error.as_deref()) == (false, Some(WRONG)));
    }

    #[test]
    fn a_partial_download_never_replaces_a_good_file_nor_stays_as_one() {
        let root = Scratch::new();
        let manifest = [entry("a.txt", b"alpha")];
        // A bad copy is on disk (it has to be fetched again) and the connection drops before the end.
        std::fs::write(root.0.join("a.txt"), b"old-bad").unwrap();
        let mut fetcher = table(&manifest, &[b"alpha"]);
        fetcher.cut = Some(2);
        let error = install_into(&root.0, &manifest, &url_of, &fetcher, &Assets::default(), &never).unwrap_err();
        assert_eq!(error, BROKEN);
        assert_eq!(std::fs::read(root.0.join("a.txt")).unwrap(), b"old-bad", "il file che c'era non e stato toccato");
        assert!(!root.0.join("a.txt.part").exists());
    }

    #[test]
    fn a_file_that_is_not_published_stops_the_fetch_and_the_ones_before_it_stay() {
        let root = Scratch::new();
        let manifest = [entry("a.txt", b"alpha"), entry("b.txt", b"bravo")];
        let mut fetcher = table(&manifest, &[b"alpha", b"bravo"]);
        fetcher.bodies.pop(); // b.txt is not on the release
        let assets = Assets::default();
        assert!(install_into(&root.0, &manifest, &url_of, &fetcher, &assets, &never).is_err());
        assert!(root.0.join("a.txt").exists() && !root.0.join("b.txt").exists());
        assert_eq!(assets.read().files_done, 1);
        // The next try asks only for what is left.
        let again = table(&manifest, &[b"alpha", b"bravo"]);
        install_into(&root.0, &manifest, &url_of, &again, &Assets::default(), &never).unwrap();
        assert_eq!(*again.asked.borrow(), [url_of(&manifest[1])]);
    }

    #[test]
    fn a_stop_ends_the_fetch_before_the_next_file() {
        let root = Scratch::new();
        let manifest = [entry("a.txt", b"alpha")];
        let fetcher = table(&manifest, &[b"alpha"]);
        let error = install_into(&root.0, &manifest, &url_of, &fetcher, &Assets::default(), &|| Some("annullato".to_string())).unwrap_err();
        assert_eq!(error, "annullato");
        assert!(fetcher.asked.borrow().is_empty());
    }

    #[test]
    fn only_one_fetch_runs_at_a_time() {
        let assets = Assets::default();
        assert!(assets.begin(2, 10));
        assert!(!assets.begin(2, 10), "una seconda richiesta non parte");
        assets.update(|p| p.running = false);
        assert!(assets.begin(1, 1));
    }

    #[test]
    fn the_status_says_ready_in_a_debug_build_and_what_is_missing_in_a_release() {
        let data = Scratch::new();
        let manifest = [entry("a.txt", b"alpha"), entry("b.txt", b"bravo!")];
        let release = Source::choose(false, Path::new("/nowhere"), Some(data.0.clone()));
        // The release folder is `<data>/nikverse-assets`: the files go there.
        let folder = data.0.join(crate::nikverse::ASSETS_DIR);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("a.txt"), b"alpha").unwrap();
        let status = status_of(&release, &manifest, &Assets::default());
        assert_eq!((status.ready, status.missing_files, status.missing_bytes), (false, 1, 6));
        std::fs::write(folder.join("b.txt"), b"bravo!").unwrap();
        assert!(status_of(&release, &manifest, &Assets::default()).ready);
        // A debug build reads the sources: nothing to fetch, whatever the folder holds.
        let debug = Source::choose(true, Path::new("/nowhere"), None);
        assert!(status_of(&debug, &manifest, &Assets::default()).ready);
        assert!(target(&debug).is_none());
    }

    #[test]
    fn while_a_fetch_runs_the_status_is_its_progress_without_reading_the_files() {
        let assets = Assets::default();
        assert!(assets.begin(3, 300));
        assets.update(|p| {
            p.files_done = 1;
            p.bytes_done = 100;
        });
        let folder = Scratch::new();
        let release = Source::choose(false, Path::new("/nowhere"), Some(folder.0.clone()));
        let status = status_of(&release, MANIFEST, &assets);
        assert_eq!((status.ready, status.missing_files, status.missing_bytes), (false, 2, 200));
        assert!(status.progress.running);
    }

    #[test]
    fn a_file_name_is_never_part_of_the_address_or_replaced_by_the_part_extension() {
        assert_eq!(staging(Path::new("/x/levels/a.glb")), Path::new("/x/levels/a.glb.part"));
        assert_ne!(staging(Path::new("/x/a.glb")), staging(Path::new("/x/a.ktx2")));
    }
    /// A server on the loopback that answers `count` requests from a table by path, 404 for the rest: what the release is, for a real `curl`.
    fn serve(table: Vec<(String, Vec<u8>)>, count: usize) -> (u16, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for _ in 0..count {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut request = [0u8; 2048];
                let n = stream.read(&mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..n]).into_owned();
                let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                match table.iter().find(|(p, _)| *p == path) {
                    Some((_, body)) => {
                        let _ = stream.write_all(
                            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes(),
                        );
                        let _ = stream.write_all(body);
                    }
                    None => {
                        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    }
                }
            }
        });
        (port, handle)
    }

    #[test]
    fn the_real_curl_fetches_by_hash_from_a_server_and_a_missing_asset_leaves_nothing() {
        let root = Scratch::new();
        let manifest = [entry("levels/a.glb", b"model bytes"), entry("b.txt", b"never published")];
        // Only the first is on the "release": the second answers 404.
        let (port, server) = serve(vec![(format!("/nikverse-{}", manifest[0].sha256), b"model bytes".to_vec())], 2);
        let url = |entry: &ManifestEntry| format!("http://127.0.0.1:{port}/nikverse-{}", entry.sha256);
        let assets = Assets::default();
        let error = install_into(&root.0, &manifest, &url, &Curl, &assets, &never).unwrap_err();
        server.join().unwrap();
        assert!(!error.is_empty());
        // What came, checked, is in place; what did not, is not, and no half-file is left.
        assert_eq!(std::fs::read(root.0.join("levels/a.glb")).unwrap(), b"model bytes");
        assert!(!root.0.join("b.txt").exists() && !root.0.join("b.txt.part").exists());
        assert_eq!(assets.read().files_done, 1);
        assert_eq!(assets.read().error.as_deref(), Some(error.as_str()));
    }
    // ---- taking the assets away (C4 of the file hygiene)

    fn fetched(scratch: &Scratch, manifest: &[ManifestEntry], bodies: &[&[u8]]) {
        for (entry, body) in manifest.iter().zip(bodies) {
            let dest = scratch.0.join(entry.path);
            std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            std::fs::write(dest, body).unwrap();
        }
    }

    #[test]
    fn what_the_assets_weigh_is_the_listed_files_that_are_there_and_the_half_fetched_ones() {
        let scratch = Scratch::new();
        let manifest = [entry("models/a.glb", b"aaaa"), entry("city.js", b"bb"), entry("lights/c.ktx2", b"c")];
        fetched(&scratch, &manifest[..2], &[b"aaaa", b"bb"]);
        std::fs::create_dir_all(scratch.0.join("lights")).unwrap();
        std::fs::write(scratch.0.join("lights/c.ktx2.part"), b"cc").unwrap();
        assert_eq!(installed_bytes(&scratch.0, &manifest), 4 + 2 + 2);
        assert_eq!(installed_bytes(&scratch.0.join("nowhere"), &manifest), 0);
    }

    #[test]
    fn removing_frees_what_was_counted_and_leaves_no_folder_of_its_own_behind() {
        let scratch = Scratch::new();
        let manifest = [entry("models/a.glb", b"aaaa"), entry("models/deep/b.glb", b"bbb"), entry("city.js", b"cc")];
        fetched(&scratch, &manifest, &[b"aaaa", b"bbb", b"cc"]);
        let counted = installed_bytes(&scratch.0, &manifest);
        assert_eq!(remove_from(&scratch.0, &manifest, &Assets::default()), Ok(counted));
        assert!(!scratch.0.exists(), "the root is removed once it is empty");
    }

    #[test]
    fn a_half_fetched_file_goes_too() {
        let scratch = Scratch::new();
        let manifest = [entry("a.glb", b"aaaa")];
        fetched(&scratch, &manifest, &[b"aaaa"]);
        std::fs::write(scratch.0.join("a.glb.part"), b"aa").unwrap();
        assert_eq!(remove_from(&scratch.0, &manifest, &Assets::default()), Ok(6));
        assert!(!scratch.0.join("a.glb.part").exists());
    }

    #[test]
    fn what_the_list_does_not_name_is_not_touched_and_keeps_its_folder() {
        let scratch = Scratch::new();
        let manifest = [entry("models/a.glb", b"aaaa")];
        fetched(&scratch, &manifest, &[b"aaaa"]);
        std::fs::write(scratch.0.join("models/mine.txt"), b"keep").unwrap();
        std::fs::write(scratch.0.join("readme.md"), b"keep").unwrap();
        assert_eq!(remove_from(&scratch.0, &manifest, &Assets::default()), Ok(4));
        assert_eq!(std::fs::read(scratch.0.join("models/mine.txt")).unwrap(), b"keep");
        assert_eq!(std::fs::read(scratch.0.join("readme.md")).unwrap(), b"keep");
        assert!(!scratch.0.join("models/a.glb").exists());
    }

    #[test]
    fn nothing_fetched_frees_nothing_and_is_not_an_error() {
        let scratch = Scratch::new();
        let manifest = [entry("a.glb", b"aaaa")];
        assert_eq!(remove_from(&scratch.0, &manifest, &Assets::default()), Ok(0));
    }

    #[test]
    fn it_is_refused_while_a_fetch_is_running_and_nothing_is_deleted() {
        let scratch = Scratch::new();
        let manifest = [entry("a.glb", b"aaaa")];
        fetched(&scratch, &manifest, &[b"aaaa"]);
        let assets = Assets::default();
        assert!(assets.begin(1, 4), "a fetch takes its turn");
        let refused = remove_from(&scratch.0, &manifest, &assets);
        assert!(refused.unwrap_err().contains("download è in corso"));
        assert!(scratch.0.join("a.glb").is_file());
        assert!(assets.read().running, "the fetch's turn is still the fetch's");
    }

    #[test]
    fn the_turn_is_given_back_so_a_fetch_can_follow() {
        let scratch = Scratch::new();
        let manifest = [entry("a.glb", b"aaaa")];
        fetched(&scratch, &manifest, &[b"aaaa"]);
        let assets = Assets::default();
        remove_from(&scratch.0, &manifest, &assets).unwrap();
        assert!(!assets.read().running);
        assert!(assets.begin(1, 4));
    }

    #[test]
    fn a_fetch_after_the_removal_brings_the_files_back() {
        let scratch = Scratch::new();
        let manifest = [entry("models/a.glb", b"aaaa")];
        fetched(&scratch, &manifest, &[b"aaaa"]);
        let assets = Assets::default();
        remove_from(&scratch.0, &manifest, &assets).unwrap();
        let fetcher = table(&manifest, &[b"aaaa"]);
        install_into(&scratch.0, &manifest, &url_of, &fetcher, &assets, &never).unwrap();
        assert!(present(&scratch.0, &manifest[0]));
    }
}
