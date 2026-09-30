//! Installing a plugin, updating it and taking it away, apart from ADE's own installer.
//!
//! **The chain of trust runs from a signature to a file.** ADE carries a public key (`ADE_PLUGINS_PUBKEY`, put in at build time, one per
//! distribution: the fork and upstream sign with their own). The release publishes `plugins.json` and its minisign signature; ADE verifies
//! the signature against that key and reads from the index, for each plugin, the version, the API it speaks, the oldest ADE it works with,
//! and the SHA-256 of its manifest. The manifest is fetched by that hash and kept only if it is the hash; the manifest lists every file with
//! its size and hash, and each file is fetched by its hash, one at a time, into a `.part` file, checked, and renamed, exactly as
//! `nikverse_assets.rs` does. Nothing the network sends is believed for what it says, only for what it hashes to.
//!
//! What is refused, each with a test: a signature that is not valid or is another key's; an index older than the last one accepted
//! (`issued_at`: an old index shown again to keep ADE from updating); a version under the installed one; an `api` ADE does not speak; a
//! `min_ade` above this ADE; a manifest or a file whose size or hash is not the one the chain says. Sizes are capped (index 64 KB,
//! manifest 256 KB, each file the size declared, all together 200 MB), and `curl` goes with `--proto =https --proto-redir =https --max-filesize`.
//!
//! **Where things live:** `<app local data>/plugins/<id>/<version>/…` (the version is written in `<version>.part/` and renamed when it is
//! whole), and two pointers in the plugin's folder, `current` (served) and `pending` (downloaded, waiting), with `previous` the one before
//! `current`; each pointer is a text file written with a rename. At most two versions are kept. `storage.json` in the plugin's folder is the
//! plugin's own (T2): this module never writes it and deletes it only when the plugin is uninstalled.
//!
//! No key in the build (as long as nobody has made one) is not an error of the code: `plugin_check` and `plugin_install` answer «nessuna
//! chiave dei plugin in questa build», nothing is downloaded, and what is already installed and verified is served all the same.

use crate::nikverse::sha256_hex;
use crate::plugin_scheme::{self as scheme, Manifest, Store, CURRENT, MANIFEST_FILE, MAX_MANIFEST_BYTES, MAX_TOTAL_BYTES, PENDING, PREVIOUS};
use crate::tts::{Curl, Fetcher};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

/// Where the release keeps the index and the files, unless the distribution says otherwise (`ADE_PLUGINS_BASE_URL`).
pub const DEFAULT_BASE_URL: &str = "https://github.com/SandroHub013/nikcli/releases/download/ade-updater/";

/// The plugin API this ADE speaks: an entry whose `api` is outside these is not installed.
pub const API_MIN: u32 = 1;
pub const API_MAX: u32 = 1;

pub const MAX_INDEX_BYTES: u64 = 64 * 1024;
pub const MAX_SIGNATURE_BYTES: u64 = 4 * 1024;

pub const NO_KEY: &str = "nessuna chiave dei plugin in questa build";

/// The file, next to the plugins, with the `issued_at` of the newest index accepted.
const ACCEPTED_FILE: &str = ".issued-at";

// ---------------------------------------------------------------------------------------------------------------------------------
// The configuration of a build
// ---------------------------------------------------------------------------------------------------------------------------------

/// What an installation is done against.
pub struct Config<'a> {
    /// Where `plugins.json` and the `plugin-<sha256>` files are, with the slash at the end.
    pub base_url: &'a str,
    /// The public key that signs the index: minisign's, as a `.pub` file or as `tauri signer generate` wraps it in base64.
    pub pubkey: &'a str,
    /// The version of this ADE, for `min_ade`.
    pub ade_version: &'a str,
}

/// The configuration this build was made with: its address and its key, or why there is none.
///
/// The address must be `https`: a distribution that says otherwise is refused, the tests use the loopback through `Config` directly.
pub fn build_config(base: Option<&'static str>, key: Option<&'static str>) -> Result<(String, &'static str), String> {
    let key = key.map(str::trim).filter(|key| !key.is_empty()).ok_or(NO_KEY)?;
    let base = base.map(str::trim).filter(|base| !base.is_empty()).unwrap_or(DEFAULT_BASE_URL);
    if !base.starts_with("https://") {
        return Err("l'indirizzo dei plugin di questa build non è https".into());
    }
    Ok((if base.ends_with('/') { base.to_string() } else { format!("{base}/") }, key))
}

fn url_of(base: &str, name: &str) -> String {
    format!("{}{name}", if base.ends_with('/') { base.to_string() } else { format!("{base}/") })
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Base64, and the signature
// ---------------------------------------------------------------------------------------------------------------------------------

/// Standard base64, padding optional, whitespace ignored. `None` for anything else.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut bits, mut have) = (0u32, 0u32);
    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' | b'\t' => continue,
            _ => return None,
        };
        bits = (bits << 6) | value as u32;
        have += 6;
        if have >= 8 {
            have -= 8;
            out.push((bits >> have) as u8);
            bits &= (1 << have) - 1;
        }
    }
    Some(out)
}

/// The text of a minisign key or signature, whether given as it is or as `tauri signer` wraps it (the same text, in base64).
fn unwrap_text(input: &str) -> String {
    let input = input.trim();
    if input.starts_with("untrusted comment") {
        return input.to_string();
    }
    base64_decode(input).and_then(|bytes| String::from_utf8(bytes).ok()).unwrap_or_else(|| input.to_string())
}

/// Checks `signature` over `message` against `pubkey`.
pub fn verify_signature(pubkey: &str, message: &[u8], signature: &str) -> Result<(), String> {
    let key_text = unwrap_text(pubkey);
    let public = PublicKey::decode(&key_text)
        .or_else(|_| PublicKey::from_base64(pubkey.trim()))
        .map_err(|_| "la chiave dei plugin di questa build non è valida".to_string())?;
    let signature = Signature::decode(&unwrap_text(signature)).map_err(|_| "firma dell'indice non valida".to_string())?;
    // Legacy signatures are accepted as the updater accepts them: it is the same minisign, made by the same tool.
    public.verify(message, &signature, true).map_err(|_| "firma dell'indice non valida o di un'altra chiave".to_string())
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct IndexEntry {
    pub version: String,
    pub api: u32,
    pub min_ade: String,
    /// SHA-256 of the manifest, lowercase hex.
    pub manifest: String,
}

#[derive(Deserialize, Debug)]
pub struct Index {
    /// When the index was issued, seconds since 1970. Never goes down.
    pub issued_at: u64,
    pub plugins: BTreeMap<String, IndexEntry>,
}

fn is_hash(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Reads an index that has been verified, and refuses one that says things that cannot be.
fn parse_index(bytes: &[u8]) -> Result<Index, String> {
    let index: Index = serde_json::from_slice(bytes).map_err(|e| format!("indice non valido: {e}"))?;
    for (id, entry) in &index.plugins {
        if !scheme::valid_id(id) {
            return Err(format!("l'indice nomina un plugin non valido ({id})"));
        }
        if !is_hash(&entry.manifest) {
            return Err(format!("hash del manifesto non valido nell'indice ({id})"));
        }
    }
    Ok(index)
}

/// What to do with an entry of the index, given what is installed.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// A version to download.
    Install,
    /// The version is the one installed (or the one already downloaded and waiting).
    UpToDate,
}

/// Whether ADE takes this entry: its API, the ADE it needs, and not a version under the installed one.
pub fn accept_entry(entry: &IndexEntry, current: Option<&str>, pending: Option<&str>, ade_version: &str) -> Result<Decision, String> {
    let offered = scheme::parse_version(&entry.version).ok_or("versione non valida nell'indice")?;
    if entry.api < API_MIN || entry.api > API_MAX {
        return Err(format!("il plugin parla l'API {} e questo ADE parla dalla {API_MIN} alla {API_MAX}", entry.api));
    }
    let needs = scheme::parse_version(&entry.min_ade).ok_or("min_ade non valido nell'indice")?;
    let ade = scheme::parse_version(ade_version).ok_or("versione di ADE non valida")?;
    if needs > ade {
        return Err(format!("il plugin richiede ADE {} o più recente", entry.min_ade));
    }
    if let Some(current) = current.and_then(scheme::parse_version) {
        if offered < current {
            return Err("la versione offerta è più vecchia di quella installata".into());
        }
        if offered == current {
            return Ok(Decision::UpToDate);
        }
    }
    if pending.and_then(scheme::parse_version) == Some(offered) {
        return Ok(Decision::UpToDate);
    }
    Ok(Decision::Install)
}

fn accepted_at(store: &Store) -> Option<u64> {
    let text = std::fs::read_to_string(store.root()?.join(ACCEPTED_FILE)).ok()?;
    text.trim().parse().ok()
}

fn remember_accepted(store: &Store, issued_at: u64) {
    if let Some(root) = store.root() {
        let _ = std::fs::create_dir_all(root);
        let temp = root.join(format!("{ACCEPTED_FILE}.tmp"));
        if std::fs::write(&temp, format!("{issued_at}\n")).is_ok() && std::fs::rename(&temp, root.join(ACCEPTED_FILE)).is_err() {
            let _ = std::fs::remove_file(&temp);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------------------------------------------

type Stop<'a> = &'a dyn Fn() -> Option<String>;

fn scratch_name() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("download-{}-{}.part", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
}

/// A small file (the index, its signature, a manifest) fetched into a `.part` in `scratch` and read, and never more than `limit` bytes.
fn fetch_bytes(fetcher: &dyn Fetcher, url: &str, limit: u64, scratch: &Path, stop: Stop) -> Result<Vec<u8>, String> {
    std::fs::create_dir_all(scratch).map_err(|e| e.to_string())?;
    let part = scratch.join(scratch_name());
    let _ = std::fs::remove_file(&part);
    let result = fetcher
        .fetch_within(url, &part, Some(limit), &mut |_| {}, stop)
        .and_then(|written| {
            let on_disk = std::fs::metadata(&part).map(|m| m.len()).map_err(|e| e.to_string())?;
            if written > limit || on_disk > limit {
                return Err("file più grande del limite: scartato".to_string());
            }
            std::fs::read(&part).map_err(|e| e.to_string())
        });
    let _ = std::fs::remove_file(&part);
    result
}

/// The index, verified: fetched with its signature, checked against the key, not older than the newest accepted. Remembers its date.
pub fn verified_index(cfg: &Config, fetcher: &dyn Fetcher, store: &Store, stop: Stop) -> Result<Index, String> {
    let root = store.root().ok_or("nessuna cartella per i plugin")?;
    let scratch = root.join(".download");
    let index = fetch_bytes(fetcher, &url_of(cfg.base_url, "plugins.json"), MAX_INDEX_BYTES, &scratch, stop)?;
    let signature = fetch_bytes(fetcher, &url_of(cfg.base_url, "plugins.json.minisig"), MAX_SIGNATURE_BYTES, &scratch, stop)?;
    let signature = String::from_utf8(signature).map_err(|_| "firma dell'indice non valida".to_string())?;
    verify_signature(cfg.pubkey, &index, &signature)?;
    let index = parse_index(&index)?;
    if let Some(newest) = accepted_at(store) {
        if index.issued_at < newest {
            return Err("l'indice è più vecchio dell'ultimo accettato: rifiutato".into());
        }
    }
    remember_accepted(store, index.issued_at);
    Ok(index)
}

/// The manifest an index entry names, fetched by its hash and kept only if it is that hash, and a manifest of this plugin and version.
fn fetch_manifest(cfg: &Config, fetcher: &dyn Fetcher, store: &Store, id: &str, entry: &IndexEntry, stop: Stop) -> Result<(Manifest, Vec<u8>), String> {
    let root = store.root().ok_or("nessuna cartella per i plugin")?;
    let bytes = fetch_bytes(fetcher, &url_of(cfg.base_url, &format!("plugin-{}", entry.manifest)), MAX_MANIFEST_BYTES, &root.join(".download"), stop)?;
    if sha256_hex(&bytes) != entry.manifest {
        return Err("il manifesto non corrisponde al suo hash: scartato".into());
    }
    let manifest = Manifest::parse(&bytes, id, &entry.version)?;
    Ok((manifest, bytes))
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------------------------------------------

/// What the panel is told about an install, running or just over.
#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct Progress {
    pub id: String,
    pub running: bool,
    pub files_done: u32,
    pub files_total: u32,
    pub bytes_done: u64,
    pub bytes_total: u64,
    /// Why the last install stopped, in the user's words.
    pub error: Option<String>,
}

/// The one install that may run, and what it reports.
#[derive(Default)]
pub struct Installer {
    progress: Mutex<Progress>,
}

impl Installer {
    fn read(&self) -> Progress {
        self.progress.lock().map(|p| p.clone()).unwrap_or_default()
    }

    fn update(&self, change: impl FnOnce(&mut Progress)) {
        if let Ok(mut progress) = self.progress.lock() {
            change(&mut progress);
        }
    }

    /// Takes the turn: false when an install is already running.
    fn begin(&self, id: &str, files: u32, bytes: u64) -> bool {
        let Ok(mut progress) = self.progress.lock() else { return false };
        if progress.running {
            return false;
        }
        *progress = Progress { id: id.to_string(), running: true, files_total: files, bytes_total: bytes, ..Progress::default() };
        true
    }

    /// The progress of `id`, or nothing when the last install was another's.
    pub fn status(&self, id: &str) -> Progress {
        let progress = self.read();
        if progress.id == id {
            progress
        } else {
            Progress { id: id.to_string(), ..Progress::default() }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// What is on offer
// ---------------------------------------------------------------------------------------------------------------------------------

/// The answer to «is there a new version of this plugin?».
#[derive(Serialize, Debug, PartialEq)]
pub struct Available {
    pub id: String,
    /// The version the index offers.
    pub version: String,
    pub current: Option<String>,
    pub pending: Option<String>,
    /// Whether there is something to download.
    pub update: bool,
    /// What the download weighs and what the plugin asks ADE for: read from its manifest, so shown before anything is installed.
    pub size_bytes: u64,
    pub permissions: Vec<String>,
}

/// Asks the release, through the chain of trust, what it offers for `id`.
pub fn check(cfg: &Config, fetcher: &dyn Fetcher, store: &Store, id: &str, stop: Stop) -> Result<Available, String> {
    if !scheme::valid_id(id) {
        return Err("plugin non valido".into());
    }
    let index = verified_index(cfg, fetcher, store, stop)?;
    let entry = index.plugins.get(id).ok_or("il plugin non è nell'indice")?;
    let (current, pending) = (store.pointer(id, CURRENT), store.pointer(id, PENDING));
    let decision = accept_entry(entry, current.as_deref(), pending.as_deref(), cfg.ade_version)?;
    let (manifest, _) = fetch_manifest(cfg, fetcher, store, id, entry, stop)?;
    Ok(Available {
        id: id.to_string(),
        version: entry.version.clone(),
        current,
        pending,
        update: decision == Decision::Install,
        size_bytes: manifest.total_bytes(),
        permissions: manifest.permissions.clone(),
    })
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------------------------------------------------------------

const RETRIES: usize = 5;
const RETRY_WAIT: std::time::Duration = std::time::Duration::from_millis(200);

/// Windows can hold a file for a moment (the antivirus, a search index): a refusal is tried a few times before it is believed.
fn retry<T>(mut attempt: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut last = None;
    for n in 0..RETRIES {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error) => {
                last = Some(error);
                if n + 1 < RETRIES {
                    std::thread::sleep(RETRY_WAIT);
                }
            }
        }
    }
    Err(last.expect("almeno un tentativo"))
}

fn remove_dir_retry(dir: &Path) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    retry(|| std::fs::remove_dir_all(dir))
}

/// What a folder weighs, all of it.
fn dir_bytes(dir: &Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            match entry.metadata() {
                Ok(meta) if meta.is_dir() => total += dir_bytes(&entry.path()),
                Ok(meta) => total += meta.len(),
                Err(_) => {}
            }
        }
    }
    total
}

/// Downloads a version into `pending`: the chain of trust from the signature to each file, and nothing left behind if any link breaks.
///
/// Returns whether it downloaded (`true`) or found nothing to do (`false`: the version is the installed one, or the one already waiting).
pub fn install(cfg: &Config, fetcher: &dyn Fetcher, store: &Store, installer: &Installer, id: &str, stop: Stop) -> Result<bool, String> {
    if !scheme::valid_id(id) {
        return Err("plugin non valido".into());
    }
    let index = verified_index(cfg, fetcher, store, stop)?;
    let entry = index.plugins.get(id).ok_or("il plugin non è nell'indice")?;
    let (current, pending) = (store.pointer(id, CURRENT), store.pointer(id, PENDING));
    if accept_entry(entry, current.as_deref(), pending.as_deref(), cfg.ade_version)? == Decision::UpToDate {
        return Ok(false);
    }
    let (manifest, manifest_bytes) = fetch_manifest(cfg, fetcher, store, id, entry, stop)?;
    if manifest.total_bytes() > MAX_TOTAL_BYTES {
        return Err("il plugin supera i 200 MB".into());
    }
    if !installer.begin(id, manifest.files.len() as u32, manifest.total_bytes()) {
        return Err("un'altra installazione è già in corso".into());
    }
    let outcome = download(cfg, fetcher, store, installer, id, entry, &manifest, &manifest_bytes, stop);
    installer.update(|progress| {
        progress.running = false;
        progress.error = outcome.as_ref().err().cloned();
    });
    outcome.map(|_| true)
}

#[allow(clippy::too_many_arguments)]
fn download(
    cfg: &Config,
    fetcher: &dyn Fetcher,
    store: &Store,
    installer: &Installer,
    id: &str,
    entry: &IndexEntry,
    manifest: &Manifest,
    manifest_bytes: &[u8],
    stop: Stop,
) -> Result<(), String> {
    let plugin = store.plugin_dir(id).ok_or("plugin non valido")?;
    let part_dir = plugin.join(format!("{}.part", entry.version));
    let final_dir = store.version_dir(id, &entry.version).ok_or("versione non valida")?;
    let _ = remove_dir_retry(&part_dir);
    let result = fill(cfg, fetcher, installer, &part_dir, manifest, manifest_bytes, stop).and_then(|_| {
        // Whole and verified: it takes the place of a version of the same number that was left behind, and is pending.
        remove_dir_retry(&final_dir).map_err(|e| e.to_string())?;
        retry(|| std::fs::rename(&part_dir, &final_dir)).map_err(|e| format!("impossibile mettere in posto la versione: {e}"))?;
        store.set_pointer(id, PENDING, &entry.version)
    });
    if result.is_err() {
        let _ = remove_dir_retry(&part_dir);
    }
    result
}

fn fill(cfg: &Config, fetcher: &dyn Fetcher, installer: &Installer, dir: &Path, manifest: &Manifest, manifest_bytes: &[u8], stop: Stop) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut before = 0u64;
    for file in &manifest.files {
        if let Some(reason) = stop() {
            return Err(reason);
        }
        let dest = dir.join(&file.path);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut staged = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        staged.push(".part");
        let part = dest.with_file_name(staged);
        let _ = std::fs::remove_file(&part);
        let written = fetcher.fetch_within(
            &url_of(cfg.base_url, &format!("plugin-{}", file.sha256)),
            &part,
            Some(file.size),
            &mut |so_far| installer.update(|progress| progress.bytes_done = before + so_far.min(file.size)),
            stop,
        );
        let checked = written.and_then(|len| {
            if len != file.size {
                return Err("Il download si è interrotto prima del file atteso: scartato.".to_string());
            }
            let bytes = std::fs::read(&part).map_err(|e| e.to_string())?;
            if bytes.len() as u64 != file.size || sha256_hex(&bytes) != file.sha256 {
                return Err("Il file scaricato non corrisponde a quello atteso: scartato.".to_string());
            }
            Ok(())
        });
        if let Err(reason) = checked {
            let _ = std::fs::remove_file(&part);
            return Err(reason);
        }
        retry(|| std::fs::rename(&part, &dest)).map_err(|e| format!("impossibile mettere in posto {}: {e}", file.path))?;
        before += file.size;
        installer.update(|progress| {
            progress.files_done += 1;
            progress.bytes_done = before;
        });
    }
    std::fs::write(dir.join(MANIFEST_FILE), manifest_bytes).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Commit, rollback, uninstall, list
// ---------------------------------------------------------------------------------------------------------------------------------

/// Keeps `current` and `previous` and nothing else of a plugin's versions: the other versions, and any `.part` left by an install that was cut.
fn prune(store: &Store, id: &str) {
    let Some(plugin) = store.plugin_dir(id) else { return };
    let keep: Vec<String> = [CURRENT, PREVIOUS, PENDING].iter().filter_map(|name| store.pointer(id, name)).collect();
    let Ok(entries) = std::fs::read_dir(&plugin) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let stale = name.ends_with(".part") || (scheme::parse_version(&name).is_some() && !keep.contains(&name));
        if stale {
            let _ = remove_dir_retry(&entry.path());
        }
    }
}

/// `pending` becomes `current` and `current` becomes `previous`. Called when the panel opens, BEFORE the frame loads: the scheme serves
/// only `current`, so a pending version cannot answer `ready` until it is committed. The order is commit, then `ready` within 15 s, and
/// `rollback` if it does not come.
pub fn commit(store: &Store, id: &str) -> Result<String, String> {
    let pending = store.pointer(id, PENDING).ok_or("nessuna versione da attivare")?;
    // What is turned on is a version that is whole and whose manifest is still a manifest.
    store.manifest(id, &pending).map_err(|e| format!("la versione da attivare non è integra: {e}"))?;
    let old = store.pointer(id, CURRENT);
    store.set_pointer(id, CURRENT, &pending)?;
    if let Some(old) = old.filter(|old| *old != pending) {
        store.set_pointer(id, PREVIOUS, &old)?;
    }
    store.clear_pointer(id, PENDING);
    prune(store, id);
    Ok(pending)
}

/// `previous` becomes `current`, and the version that was `current` goes: it did not work.
pub fn rollback(store: &Store, id: &str) -> Result<String, String> {
    let previous = store.pointer(id, PREVIOUS).ok_or("nessuna versione precedente")?;
    store.manifest(id, &previous).map_err(|e| format!("la versione precedente non è integra: {e}"))?;
    let bad = store.pointer(id, CURRENT);
    store.set_pointer(id, CURRENT, &previous)?;
    store.clear_pointer(id, PREVIOUS);
    if let (Some(bad), Some(plugin)) = (bad.filter(|bad| *bad != previous), store.plugin_dir(id)) {
        let _ = remove_dir_retry(&plugin.join(bad));
    }
    prune(store, id);
    Ok(previous)
}

/// Takes the plugin away, with its `storage.json`. Returns how many bytes that freed.
pub fn uninstall(store: &Store, id: &str) -> Result<u64, String> {
    let dir = store.plugin_dir(id).ok_or("plugin non valido")?;
    if !dir.is_dir() {
        return Err("il plugin non è installato".into());
    }
    let freed = dir_bytes(&dir);
    remove_dir_retry(&dir).map_err(|e| format!("impossibile cancellare il plugin: {e}"))?;
    Ok(freed)
}

/// A plugin that is on disk.
#[derive(Serialize, Debug, PartialEq)]
pub struct Listed {
    pub id: String,
    pub current: Option<String>,
    pub pending: Option<String>,
    pub previous: Option<String>,
    pub bytes: u64,
    /// What the manifest of `current` asks for, so the panel can tell what is granted without reading a file.
    pub permissions: Vec<String>,
    /// What the manifest of `pending` asks for: shown before an update that asks for more is switched on.
    pub pending_permissions: Option<Vec<String>>,
    /// Served from a folder, with no signature (a debug build with `ADE_PLUGIN_DEV_DIR`).
    pub dev: bool,
}

/// What is installed, and what it weighs.
pub fn list(store: &Store) -> Vec<Listed> {
    let mut out: Vec<Listed> = Vec::new();
    if let Some(entries) = store.root().and_then(|root| std::fs::read_dir(root).ok()) {
        out = entries
            .flatten()
            .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter_map(|entry| {
                let id = entry.file_name().to_string_lossy().into_owned();
                if !scheme::valid_id(&id) {
                    return None;
                }
                let (current, pending) = (store.pointer(&id, CURRENT), store.pointer(&id, PENDING));
                // A folder with neither is not an installed plugin: what is left of an uninstall, or the data of one under development.
                if current.is_none() && pending.is_none() {
                    return None;
                }
                let permissions_of =
                    |version: &Option<String>| version.as_ref().and_then(|v| store.manifest(&id, v).ok()).map(|manifest| manifest.permissions);
                Some(Listed {
                    permissions: permissions_of(&current).unwrap_or_default(),
                    pending_permissions: permissions_of(&pending),
                    previous: store.pointer(&id, PREVIOUS),
                    bytes: dir_bytes(&entry.path()),
                    dev: false,
                    current,
                    pending,
                    id,
                })
            })
            .collect();
    }
    // The plugin under development takes the place of an installed one with the same id.
    if let Some(dev) = store.dev_plugin() {
        out.retain(|listed| listed.id != dev.id);
        out.push(Listed {
            bytes: dir_bytes(&dev.dir),
            current: Some(dev.version),
            pending: None,
            previous: None,
            permissions: dev.permissions,
            pending_permissions: None,
            dev: true,
            id: dev.id,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The commands: the main window's only
// ---------------------------------------------------------------------------------------------------------------------------------

/// The plugin commands answer to ADE's own window and no other: a frame, a browser pane or a second window that reaches `invoke` is refused.
pub fn main_only(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("comando riservato alla finestra principale".into())
    }
}

fn configured() -> Result<(String, &'static str), String> {
    build_config(option_env!("ADE_PLUGINS_BASE_URL"), option_env!("ADE_PLUGINS_PUBKEY"))
}

/// Never for longer than this in all: a transfer that is never going to arrive is not waited for.
fn deadline() -> impl Fn() -> Option<String> {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(15 * 60);
    move || (std::time::Instant::now() > end).then(|| "Download interrotto: il tempo è scaduto.".to_string())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plugin_list(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Vec<Listed>, String> {
    main_only(window.label())?;
    blocking(move || Ok(list(scheme::store(&app)))).await
}

#[tauri::command]
pub async fn plugin_check(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<Available, String> {
    main_only(window.label())?;
    blocking(move || {
        let (base, key) = configured()?;
        let version = app.package_info().version.to_string();
        let cfg = Config { base_url: &base, pubkey: key, ade_version: &version };
        check(&cfg, &Curl, scheme::store(&app), &id, &deadline())
    })
    .await
}

/// Downloads into `pending`. Returns when it is over (the panel watches `plugin_status` meanwhile); `false` when there was nothing to download.
#[tauri::command]
pub async fn plugin_install(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<bool, String> {
    main_only(window.label())?;
    blocking(move || {
        let (base, key) = configured()?;
        let version = app.package_info().version.to_string();
        let cfg = Config { base_url: &base, pubkey: key, ade_version: &version };
        let state = app.state::<Installer>();
        install(&cfg, &Curl, scheme::store(&app), &state, &id, &deadline())
    })
    .await
}

#[tauri::command]
pub async fn plugin_status(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<Progress, String> {
    main_only(window.label())?;
    blocking(move || Ok(app.state::<Installer>().status(&id))).await
}

#[tauri::command]
pub async fn plugin_commit(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<String, String> {
    main_only(window.label())?;
    blocking(move || commit(scheme::store(&app), &id)).await
}

#[tauri::command]
pub async fn plugin_rollback(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<String, String> {
    main_only(window.label())?;
    blocking(move || rollback(scheme::store(&app), &id)).await
}

#[tauri::command]
pub async fn plugin_uninstall(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<u64, String> {
    main_only(window.label())?;
    blocking(move || uninstall(scheme::store(&app), &id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_scheme::tests::Scratch;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use tauri::http::{Request, StatusCode};

    macro_rules! fixture {
        ($name:expr) => {
            include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/plugin-fixtures/", $name)).as_slice()
        };
    }

    const TEST_PUB: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/plugin-fixtures/test.pub"));
    const OTHER_PUB: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/plugin-fixtures/other.pub"));
    const ADE: &str = "0.13.0";
    const BASE: &str = "https://plugins.test/releases/";

    /// The files of the two fixture versions, by path.
    fn files(version: &str) -> Vec<(&'static str, &'static [u8])> {
        match version {
            "1.0.0" => vec![("index.html", fixture!("nikverse-1.0.0/index.html")), ("app.js", fixture!("nikverse-1.0.0/app.js"))],
            "1.1.0" => vec![
                ("index.html", fixture!("nikverse-1.1.0/index.html")),
                ("app.js", fixture!("nikverse-1.1.0/app.js")),
                ("assets/extra.css", fixture!("nikverse-1.1.0/assets/extra.css")),
            ],
            other => panic!("nessuna fixture per {other}"),
        }
    }

    fn manifest_bytes(version: &str) -> &'static [u8] {
        match version {
            "1.0.0" => fixture!("manifest-1.0.0.json"),
            "1.1.0" => fixture!("manifest-1.1.0.json"),
            other => panic!("nessuna fixture per {other}"),
        }
    }

    /// What the release holds: the index and its signature, and every file of both versions and both manifests under `plugin-<sha256>`.
    fn release(index: &[u8], signature: &[u8]) -> HashMap<String, Vec<u8>> {
        let mut table = HashMap::new();
        table.insert(url_of(BASE, "plugins.json"), index.to_vec());
        table.insert(url_of(BASE, "plugins.json.minisig"), signature.to_vec());
        for version in ["1.0.0", "1.1.0"] {
            table.insert(url_of(BASE, &format!("plugin-{}", sha256_hex(manifest_bytes(version)))), manifest_bytes(version).to_vec());
            for (_, bytes) in files(version) {
                table.insert(url_of(BASE, &format!("plugin-{}", sha256_hex(bytes))), bytes.to_vec());
            }
        }
        table
    }

    fn good_release() -> HashMap<String, Vec<u8>> {
        release(fixture!("index-good.json"), fixture!("index-good.json.sig"))
    }

    /// A fetcher that answers from a table by URL, and writes what the table says to the part file.
    struct Table {
        bodies: RefCell<HashMap<String, Vec<u8>>>,
        asked: RefCell<Vec<String>>,
        limits: RefCell<Vec<(String, Option<u64>)>>,
    }

    impl Table {
        fn new(bodies: HashMap<String, Vec<u8>>) -> Table {
            Table { bodies: RefCell::new(bodies), asked: RefCell::new(Vec::new()), limits: RefCell::new(Vec::new()) }
        }

        fn asked(&self) -> Vec<String> {
            self.asked.borrow().clone()
        }
    }

    impl Fetcher for Table {
        fn fetch(&self, url: &str, part: &Path, report: &mut dyn FnMut(u64), _stop: &dyn Fn() -> Option<String>) -> Result<u64, String> {
            self.asked.borrow_mut().push(url.to_string());
            let body = self.bodies.borrow().get(url).cloned().ok_or("404")?;
            std::fs::write(part, &body).map_err(|e| e.to_string())?;
            report(body.len() as u64);
            Ok(body.len() as u64)
        }

        fn fetch_within(&self, url: &str, part: &Path, limit: Option<u64>, report: &mut dyn FnMut(u64), stop: &dyn Fn() -> Option<String>) -> Result<u64, String> {
            self.limits.borrow_mut().push((url.to_string(), limit));
            self.fetch(url, part, report, stop)
        }
    }

    fn never() -> Option<String> {
        None
    }

    fn cfg<'a>(base: &'a str, pubkey: &'a str) -> Config<'a> {
        Config { base_url: base, pubkey, ade_version: ADE }
    }

    /// A plugins folder with nothing in it.
    fn fresh() -> (Scratch, Store) {
        let scratch = Scratch::new();
        let store = Store::new(scratch.0.join("plugins"));
        (scratch, store)
    }

    fn get(store: &Store, path: &str) -> tauri::http::Response<Vec<u8>> {
        scheme::respond(&Request::builder().uri(format!("plugin://localhost/nikverse/{path}")).body(Vec::new()).unwrap(), store)
    }

    /// Installs a version from the good release (or the one that `table` holds) and makes it current.
    fn install_and_commit(table: &Table, store: &Store, installer: &Installer, pubkey: &str) {
        assert_eq!(install(&cfg(BASE, pubkey), table, store, installer, "nikverse", &never), Ok(true));
        commit(store, "nikverse").unwrap();
    }

    /// Nothing of a plugin that was refused is left where a reader could find it: no version folder, no `.part`, no pointer that was not there.
    fn assert_nothing_left(store: &Store) {
        let plugin = store.plugin_dir("nikverse").unwrap();
        if let Ok(entries) = std::fs::read_dir(&plugin) {
            let names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            assert!(names.iter().all(|n| n == "current" || n == "previous" || n == "1.0.0"), "{names:?}");
        }
    }

    // ---- the signature ----

    #[test]
    fn base64_reads_what_tauri_writes_and_refuses_the_rest() {
        assert_eq!(base64_decode("aGVsbG8=").as_deref(), Some(b"hello".as_slice()));
        assert_eq!(base64_decode("aGVsbG8").as_deref(), Some(b"hello".as_slice()));
        assert_eq!(base64_decode("aGVs\nbG8=\r\n").as_deref(), Some(b"hello".as_slice()));
        assert_eq!(base64_decode("").as_deref(), Some(b"".as_slice()));
        assert_eq!(base64_decode("a$b"), None);
        assert!(unwrap_text(TEST_PUB).starts_with("untrusted comment: minisign public key"));
        assert_eq!(unwrap_text("untrusted comment: x\nRWQ"), "untrusted comment: x\nRWQ");
    }

    #[test]
    fn the_fixture_index_is_signed_by_the_test_key() {
        assert_eq!(verify_signature(TEST_PUB, fixture!("index-good.json"), std::str::from_utf8(fixture!("index-good.json.sig")).unwrap()), Ok(()));
        // The key as a .pub file, unwrapped, works too.
        assert_eq!(verify_signature(&unwrap_text(TEST_PUB), fixture!("index-good.json"), std::str::from_utf8(fixture!("index-good.json.sig")).unwrap()), Ok(()));
    }

    #[test]
    fn a_signature_that_is_not_valid_is_refused() {
        let good = std::str::from_utf8(fixture!("index-good.json.sig")).unwrap();
        // Bytes changed after they were signed.
        assert!(verify_signature(TEST_PUB, fixture!("index-tampered.json"), good).is_err());
        // A signature by another key, valid in itself.
        let other = std::str::from_utf8(fixture!("index-otherkey.json.sig")).unwrap();
        assert!(verify_signature(TEST_PUB, fixture!("index-otherkey.json"), other).is_err());
        assert_eq!(verify_signature(OTHER_PUB, fixture!("index-otherkey.json"), other), Ok(()));
        // No signature, garbage, another file's signature, a key that is not one.
        for signature in ["", "not a signature", "aGVsbG8=", "untrusted comment: x\nRWQ"] {
            assert!(verify_signature(TEST_PUB, fixture!("index-good.json"), signature).is_err(), "{signature:?}");
        }
        assert!(verify_signature(TEST_PUB, fixture!("index-good.json"), std::str::from_utf8(fixture!("index-update.json.sig")).unwrap()).is_err());
        assert!(verify_signature("not a key", fixture!("index-good.json"), good).is_err());
        assert!(verify_signature("", fixture!("index-good.json"), good).is_err());
    }

    #[test]
    fn the_test_key_is_not_a_release_key() {
        // The public half of the key that signs the fixtures must not be one that signs anything shipped: the build's own, if it has one,
        // and the updater's, which is in the configuration ADE is built with.
        let wanted = TEST_PUB.trim();
        if let Some(build) = option_env!("ADE_PLUGINS_PUBKEY") {
            assert_ne!(build.trim(), wanted, "la chiave di prova è la chiave dei plugin di questa build");
        }
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let updater = config["plugins"]["updater"]["pubkey"].as_str().unwrap_or("").trim().to_string();
        assert_ne!(updater, wanted, "la chiave di prova è la chiave dell'updater");
        assert_ne!(unwrap_text(&updater), unwrap_text(wanted));
        assert_ne!(unwrap_text(TEST_PUB), unwrap_text(OTHER_PUB));
        // And a key from the fixtures is never the build's default: the build has none until the user makes one.
        assert!(!DEFAULT_BASE_URL.contains("test"));
    }

    // ---- the configuration of a build ----

    #[test]
    fn a_build_with_no_key_downloads_nothing() {
        assert_eq!(build_config(None, None), Err(NO_KEY.to_string()));
        assert_eq!(build_config(Some("https://x.test/"), None), Err(NO_KEY.to_string()));
        assert_eq!(build_config(None, Some("   ")), Err(NO_KEY.to_string()));
        assert_eq!(build_config(None, Some("RWQkey")), Ok((DEFAULT_BASE_URL.to_string(), "RWQkey")));
        // A distribution's own address, with or without the slash; never plain http.
        assert_eq!(build_config(Some("https://mine.test/plugins"), Some("k")), Ok(("https://mine.test/plugins/".to_string(), "k")));
        assert!(build_config(Some("http://mine.test/"), Some("k")).is_err());
        assert!(build_config(Some("file:///c/x/"), Some("k")).is_err());
        assert!(build_config(Some("ftp://mine.test/"), Some("k")).is_err());
    }

    #[test]
    fn the_message_of_a_build_with_no_key_is_the_one_the_panel_shows() {
        assert_eq!(NO_KEY, "nessuna chiave dei plugin in questa build");
    }

    // ---- what the index says ----

    fn entry(version: &str, api: u32, min_ade: &str) -> IndexEntry {
        IndexEntry { version: version.to_string(), api, min_ade: min_ade.to_string(), manifest: "a".repeat(64) }
    }

    #[test]
    fn an_api_outside_the_ones_ade_speaks_is_refused() {
        assert_eq!(accept_entry(&entry("1.0.0", 1, "0.0.0"), None, None, ADE), Ok(Decision::Install));
        for api in [0, 2, 3, u32::MAX] {
            assert!(accept_entry(&entry("1.0.0", api, "0.0.0"), None, None, ADE).is_err(), "api {api}");
        }
        assert_eq!((API_MIN, API_MAX), (1, 1));
    }

    #[test]
    fn a_plugin_that_needs_a_newer_ade_is_refused() {
        assert!(accept_entry(&entry("1.0.0", 1, "0.13.0"), None, None, "0.13.0").is_ok());
        assert!(accept_entry(&entry("1.0.0", 1, "0.13.1"), None, None, "0.13.0").is_err());
        assert!(accept_entry(&entry("1.0.0", 1, "1.0.0"), None, None, "0.13.9").is_err());
        assert!(accept_entry(&entry("1.0.0", 1, "0.9.9"), None, None, "0.13.0").is_ok());
        assert!(accept_entry(&entry("1.0.0", 1, "0.100.0"), None, None, "0.13.0").is_err());
        assert!(accept_entry(&entry("1.0.0", 1, "banana"), None, None, ADE).is_err());
        assert!(accept_entry(&entry("1.0.0", 1, "0.0.0"), None, None, "banana").is_err());
    }

    #[test]
    fn a_version_under_the_installed_one_is_refused_and_the_same_one_is_up_to_date() {
        assert!(accept_entry(&entry("1.0.9", 1, "0.0.0"), Some("1.1.0"), None, ADE).is_err());
        assert!(accept_entry(&entry("0.9.0", 1, "0.0.0"), Some("1.0.0"), None, ADE).is_err());
        assert_eq!(accept_entry(&entry("1.1.0", 1, "0.0.0"), Some("1.1.0"), None, ADE), Ok(Decision::UpToDate));
        assert_eq!(accept_entry(&entry("1.2.0", 1, "0.0.0"), Some("1.1.0"), None, ADE), Ok(Decision::Install));
        assert_eq!(accept_entry(&entry("1.10.0", 1, "0.0.0"), Some("1.9.0"), None, ADE), Ok(Decision::Install));
        // Already downloaded and waiting.
        assert_eq!(accept_entry(&entry("1.2.0", 1, "0.0.0"), Some("1.1.0"), Some("1.2.0"), ADE), Ok(Decision::UpToDate));
        assert!(accept_entry(&entry("1.2", 1, "0.0.0"), None, None, ADE).is_err());
    }

    #[test]
    fn an_index_that_names_what_it_should_not_is_refused() {
        let hash = "a".repeat(64);
        let make = |id: &str, hash: &str| format!(r#"{{"issued_at":1,"plugins":{{"{id}":{{"version":"1.0.0","api":1,"min_ade":"0.0.0","manifest":"{hash}"}}}}}}"#);
        assert!(parse_index(make("nikverse", &hash).as_bytes()).is_ok());
        assert!(parse_index(make("Nik", &hash).as_bytes()).is_err());
        assert!(parse_index(make("../x", &hash).as_bytes()).is_err());
        assert!(parse_index(make("nikverse", "abc").as_bytes()).is_err());
        assert!(parse_index(make("nikverse", &hash.to_uppercase()).as_bytes()).is_err());
        assert!(parse_index(b"[]").is_err());
        assert!(parse_index(br#"{"plugins":{}}"#).is_err());
    }

    // ---- the index, fetched ----

    #[test]
    fn an_index_with_a_tampered_byte_or_another_keys_signature_is_refused_and_nothing_is_downloaded() {
        for (index, signature) in [
            (fixture!("index-tampered.json"), fixture!("index-good.json.sig")),
            (fixture!("index-otherkey.json"), fixture!("index-otherkey.json.sig")),
            (fixture!("index-good.json"), b"".as_slice()),
            (fixture!("index-good.json"), fixture!("index-update.json.sig")),
        ] {
            let (_scratch, store) = fresh();
            let table = Table::new(release(index, signature));
            let error = install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &never).unwrap_err();
            assert!(error.contains("firma"), "{error}");
            // Only the index and its signature were asked for: no manifest, no file.
            assert_eq!(table.asked().len(), 2, "{:?}", table.asked());
            assert!(store.pointer("nikverse", PENDING).is_none() && store.pointer("nikverse", CURRENT).is_none());
        }
    }

    #[test]
    fn an_index_older_than_the_last_one_accepted_is_refused() {
        let (_scratch, store) = fresh();
        let installer = Installer::default();
        // Good is issued at 1000.
        let table = Table::new(good_release());
        install_and_commit(&table, &store, &installer, TEST_PUB);
        assert_eq!(accepted_at(&store), Some(1000));
        // Then an older, validly signed index is shown again: to hold ADE back on what it has.
        let old = Table::new(release(fixture!("index-old.json"), fixture!("index-old.json.sig")));
        let error = check(&cfg(BASE, TEST_PUB), &old, &store, "nikverse", &never).unwrap_err();
        assert!(error.contains("più vecchio dell'ultimo accettato"), "{error}");
        assert_eq!(accepted_at(&store), Some(1000), "the date does not go back");
        assert_eq!(old.asked().len(), 2);
        // The same date is fine (the same index again), and a newer one moves it forward.
        assert!(check(&cfg(BASE, TEST_PUB), &table, &store, "nikverse", &never).is_ok());
        let newer = Table::new(release(fixture!("index-update.json"), fixture!("index-update.json.sig")));
        assert!(check(&cfg(BASE, TEST_PUB), &newer, &store, "nikverse", &never).is_ok());
        assert_eq!(accepted_at(&store), Some(2000));
    }

    #[test]
    fn a_version_under_the_installed_one_is_refused_end_to_end() {
        let (_scratch, store) = fresh();
        let installer = Installer::default();
        install_and_commit(&Table::new(good_release()), &store, &installer, TEST_PUB);
        let table = Table::new(release(fixture!("index-downgrade.json"), fixture!("index-downgrade.json.sig")));
        let error = install(&cfg(BASE, TEST_PUB), &table, &store, &installer, "nikverse", &never).unwrap_err();
        assert!(error.contains("più vecchia"), "{error}");
        assert_eq!(store.pointer("nikverse", CURRENT).as_deref(), Some("1.0.0"));
        assert_eq!(table.asked().len(), 2, "{:?}", table.asked());
    }

    #[test]
    fn an_api_or_an_ade_the_index_does_not_fit_is_refused_end_to_end() {
        for (index, signature, wanted) in [
            (fixture!("index-api2.json"), fixture!("index-api2.json.sig"), "API"),
            (fixture!("index-api0.json"), fixture!("index-api0.json.sig"), "API"),
            (fixture!("index-minade.json"), fixture!("index-minade.json.sig"), "richiede ADE"),
        ] {
            let (_scratch, store) = fresh();
            let table = Table::new(release(index, signature));
            let error = install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &never).unwrap_err();
            assert!(error.contains(wanted), "{error}");
            assert_eq!(table.asked().len(), 2, "no manifest, no file: {:?}", table.asked());
            assert!(!store.plugin_dir("nikverse").unwrap().exists());
        }
    }

    #[test]
    fn the_plugin_the_index_does_not_have_is_not_installed() {
        let (_scratch, store) = fresh();
        let table = Table::new(good_release());
        let error = install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "someone-else", &never).unwrap_err();
        assert!(error.contains("non è nell'indice"), "{error}");
        assert!(install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "Bad_Id", &never).is_err());
        assert!(install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "../x", &never).is_err());
    }

    #[test]
    fn an_index_bigger_than_64_kb_or_a_signature_bigger_than_4_kb_is_refused_before_it_is_read() {
        let (_scratch, store) = fresh();
        let mut bodies = good_release();
        bodies.insert(url_of(BASE, "plugins.json"), vec![b' '; (MAX_INDEX_BYTES + 1) as usize]);
        let table = Table::new(bodies);
        let error = install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &never).unwrap_err();
        assert!(error.contains("più grande del limite"), "{error}");
        // The fetcher was told the limit, for curl to refuse it before writing.
        let limits = table.limits.borrow();
        assert_eq!(limits[0], (url_of(BASE, "plugins.json"), Some(MAX_INDEX_BYTES)));
        drop(limits);
        let mut bodies = good_release();
        bodies.insert(url_of(BASE, "plugins.json.minisig"), vec![b'A'; (MAX_SIGNATURE_BYTES + 1) as usize]);
        let table = Table::new(bodies);
        assert!(install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &never).unwrap_err().contains("più grande del limite"));
        assert_eq!(table.limits.borrow()[1], (url_of(BASE, "plugins.json.minisig"), Some(MAX_SIGNATURE_BYTES)));
    }

    // ---- the manifest and the files ----

    #[test]
    fn a_manifest_that_is_not_the_hash_the_index_says_is_refused() {
        let (_scratch, store) = fresh();
        let mut bodies = good_release();
        // The address is the right hash; what is behind it is another manifest.
        bodies.insert(url_of(BASE, &format!("plugin-{}", sha256_hex(manifest_bytes("1.0.0")))), manifest_bytes("1.1.0").to_vec());
        let table = Table::new(bodies);
        let error = install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &never).unwrap_err();
        assert!(error.contains("manifesto non corrisponde"), "{error}");
        assert_eq!(table.asked().len(), 3, "no file was asked for: {:?}", table.asked());
        assert!(!store.plugin_dir("nikverse").unwrap().exists());
    }

    #[test]
    fn a_manifest_bigger_than_256_kb_is_refused() {
        let (_scratch, store) = fresh();
        let mut bodies = good_release();
        bodies.insert(url_of(BASE, &format!("plugin-{}", sha256_hex(manifest_bytes("1.0.0")))), vec![b' '; (MAX_MANIFEST_BYTES + 1) as usize]);
        let table = Table::new(bodies);
        assert!(install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &never).unwrap_err().contains("più grande del limite"));
        let limits = table.limits.borrow();
        assert!(limits.iter().any(|(url, limit)| url.ends_with(&sha256_hex(manifest_bytes("1.0.0"))) && *limit == Some(MAX_MANIFEST_BYTES)));
    }

    #[test]
    fn a_file_with_other_bytes_of_the_same_size_or_a_size_that_is_not_the_manifests_is_refused_and_leaves_nothing() {
        let app_js = files("1.0.0")[1].1;
        let mut same_size = app_js.to_vec();
        same_size[0] ^= 1;
        let mut longer = app_js.to_vec();
        longer.push(b'!');
        let shorter = app_js[..app_js.len() - 1].to_vec();
        for (name, body) in [("hash", same_size), ("longer", longer), ("shorter", shorter), ("empty", Vec::new())] {
            let (_scratch, store) = fresh();
            let mut bodies = good_release();
            bodies.insert(url_of(BASE, &format!("plugin-{}", sha256_hex(app_js))), body);
            let installer = Installer::default();
            let table = Table::new(bodies);
            let error = install(&cfg(BASE, TEST_PUB), &table, &store, &installer, "nikverse", &never).unwrap_err();
            assert!(error.contains("scartato"), "{name}: {error}");
            assert_nothing_left(&store);
            assert!(store.pointer("nikverse", PENDING).is_none(), "{name}");
            // The first file (index.html) was good and is gone with the rest: a version is whole or is not there.
            let plugin = store.plugin_dir("nikverse").unwrap();
            assert!(!plugin.join("1.0.0").exists() && !plugin.join("1.0.0.part").exists(), "{name}");
            assert_eq!(installer.status("nikverse").error.as_deref(), Some(error.as_str()), "{name}");
            assert!(!installer.status("nikverse").running);
        }
    }

    #[test]
    fn every_file_is_asked_for_with_the_size_the_manifest_gives_as_its_limit() {
        let (_scratch, store) = fresh();
        let table = Table::new(good_release());
        install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &never).unwrap();
        let limits = table.limits.borrow();
        for (path, bytes) in files("1.0.0") {
            let url = url_of(BASE, &format!("plugin-{}", sha256_hex(bytes)));
            assert!(limits.contains(&(url, Some(bytes.len() as u64))), "{path}");
        }
    }

    #[test]
    fn a_file_that_is_not_published_stops_the_install_and_the_ones_before_it_are_not_kept() {
        let (_scratch, store) = fresh();
        let mut bodies = good_release();
        bodies.remove(&url_of(BASE, &format!("plugin-{}", sha256_hex(files("1.0.0")[1].1))));
        let table = Table::new(bodies);
        assert!(install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &never).is_err());
        assert_nothing_left(&store);
    }

    #[test]
    fn a_stop_ends_the_install_and_leaves_nothing() {
        let (_scratch, store) = fresh();
        let table = Table::new(good_release());
        let error = install(&cfg(BASE, TEST_PUB), &table, &store, &Installer::default(), "nikverse", &|| Some("fermato".to_string())).unwrap_err();
        assert_eq!(error, "fermato");
        assert_nothing_left(&store);
    }

    #[test]
    fn a_version_downloaded_twice_is_replaced_whole_and_a_cut_download_is_swept_at_the_next_commit() {
        let (_scratch, store) = fresh();
        // A `.part` left by an install that was cut, and a version folder that is nobody's.
        let plugin = store.plugin_dir("nikverse").unwrap();
        std::fs::create_dir_all(plugin.join("0.5.0")).unwrap();
        std::fs::create_dir_all(plugin.join("1.0.0.part")).unwrap();
        std::fs::write(plugin.join("1.0.0.part").join("half.js"), b"x").unwrap();
        let table = Table::new(good_release());
        let installer = Installer::default();
        assert_eq!(install(&cfg(BASE, TEST_PUB), &table, &store, &installer, "nikverse", &never), Ok(true));
        assert!(!plugin.join("1.0.0.part").exists(), "the .part of a cut download does not stay");
        commit(&store, "nikverse").unwrap();
        assert!(!plugin.join("0.5.0").exists(), "a version that is neither current nor previous does not stay");
        assert!(plugin.join("1.0.0").join(MANIFEST_FILE).exists());
    }

    // ---- a whole install, and what comes after ----

    #[test]
    fn a_whole_install_check_pending_commit_rollback_uninstall() {
        let (_scratch, store) = fresh();
        let installer = Installer::default();
        let table = Table::new(good_release());

        // Nothing installed: the scheme says not found, the list is empty.
        assert_eq!(get(&store, "index.html").status(), StatusCode::NOT_FOUND);
        assert!(list(&store).is_empty());

        // The check reads the chain and says what the download weighs and what the plugin asks for, before anything is installed.
        let offered = check(&cfg(BASE, TEST_PUB), &table, &store, "nikverse", &never).unwrap();
        assert_eq!(offered.version, "1.0.0");
        assert!(offered.update && offered.current.is_none() && offered.pending.is_none());
        assert_eq!(offered.size_bytes, files("1.0.0").iter().map(|(_, b)| b.len() as u64).sum::<u64>());
        assert_eq!(offered.permissions, vec!["theme".to_string(), "snapshot".to_string()]);
        assert!(!store.plugin_dir("nikverse").unwrap().join("1.0.0").exists(), "checking installs nothing");

        // The install goes to pending, and the panel can read the progress.
        assert_eq!(install(&cfg(BASE, TEST_PUB), &table, &store, &installer, "nikverse", &never), Ok(true));
        let progress = installer.status("nikverse");
        assert_eq!((progress.running, progress.files_done, progress.files_total, progress.error), (false, 2, 2, None));
        assert_eq!(progress.bytes_done, progress.bytes_total);
        assert_eq!(installer.status("other").files_total, 0, "the progress of another plugin is nobody's");
        assert_eq!(store.pointer("nikverse", PENDING).as_deref(), Some("1.0.0"));
        assert_eq!(store.pointer("nikverse", CURRENT), None);
        // A pending version is not served.
        assert_eq!(get(&store, "index.html").status(), StatusCode::NOT_FOUND);
        // The same version again is up to date, and nothing more is asked for than the index.
        let asked = table.asked().len();
        assert_eq!(install(&cfg(BASE, TEST_PUB), &table, &store, &installer, "nikverse", &never), Ok(false));
        assert_eq!(table.asked().len(), asked + 2);

        // Commit: it is current, and the scheme serves its index.html and the file of a folder.
        assert_eq!(commit(&store, "nikverse"), Ok("1.0.0".to_string()));
        assert_eq!(store.pointer("nikverse", PENDING), None);
        let page = get(&store, "index.html");
        assert_eq!(page.status(), StatusCode::OK);
        assert_eq!(page.body().as_slice(), fixture!("nikverse-1.0.0/index.html"));
        assert_eq!(get(&store, "").body().as_slice(), fixture!("nikverse-1.0.0/index.html"));
        assert_eq!(get(&store, "app.js").body().as_slice(), fixture!("nikverse-1.0.0/app.js"));
        // The manifest that was kept is the one the index named, byte for byte, and is not served.
        let kept = std::fs::read(store.version_dir("nikverse", "1.0.0").unwrap().join(MANIFEST_FILE)).unwrap();
        assert_eq!(kept.as_slice(), manifest_bytes("1.0.0"));
        assert_eq!(get(&store, ".manifest.json").status(), StatusCode::NOT_FOUND);
        assert_eq!(list(&store).len(), 1);
        assert_eq!(list(&store)[0].current.as_deref(), Some("1.0.0"));
        assert!(list(&store)[0].bytes > 0);

        // Update: the new version is downloaded beside, and the current one goes on being served until commit.
        let newer = Table::new(release(fixture!("index-update.json"), fixture!("index-update.json.sig")));
        let offered = check(&cfg(BASE, TEST_PUB), &newer, &store, "nikverse", &never).unwrap();
        assert!(offered.update && offered.current.as_deref() == Some("1.0.0") && offered.version == "1.1.0");
        assert_eq!(offered.permissions.len(), 3);
        assert_eq!(install(&cfg(BASE, TEST_PUB), &newer, &store, &installer, "nikverse", &never), Ok(true));
        assert_eq!(get(&store, "app.js").body().as_slice(), fixture!("nikverse-1.0.0/app.js"));
        assert_eq!(store.pointer("nikverse", PENDING).as_deref(), Some("1.1.0"));
        assert_eq!(commit(&store, "nikverse"), Ok("1.1.0".to_string()));
        assert_eq!(store.pointer("nikverse", CURRENT).as_deref(), Some("1.1.0"));
        assert_eq!(store.pointer("nikverse", PREVIOUS).as_deref(), Some("1.0.0"));
        assert_eq!(get(&store, "app.js").body().as_slice(), fixture!("nikverse-1.1.0/app.js"));
        assert_eq!(get(&store, "assets/extra.css").body().as_slice(), fixture!("nikverse-1.1.0/assets/extra.css"));
        assert!(store.version_dir("nikverse", "1.0.0").unwrap().is_dir(), "the version before is kept");

        // Rollback: the one that did not work goes, the one before comes back.
        assert_eq!(rollback(&store, "nikverse"), Ok("1.0.0".to_string()));
        assert_eq!(store.pointer("nikverse", CURRENT).as_deref(), Some("1.0.0"));
        assert_eq!(store.pointer("nikverse", PREVIOUS), None);
        assert!(!store.version_dir("nikverse", "1.1.0").unwrap().exists());
        assert_eq!(get(&store, "app.js").body().as_slice(), fixture!("nikverse-1.0.0/app.js"));
        assert_eq!(get(&store, "assets/extra.css").status(), StatusCode::NOT_FOUND);
        assert!(rollback(&store, "nikverse").is_err(), "nothing before the first");

        // Uninstall: the folder is gone, with the plugin's own storage, and it says how much that freed.
        let plugin = store.plugin_dir("nikverse").unwrap();
        std::fs::write(plugin.join("storage.json"), b"{\"a\":1}").unwrap();
        let before = dir_bytes(&plugin);
        assert_eq!(uninstall(&store, "nikverse"), Ok(before));
        assert!(before > 7);
        assert!(!plugin.exists());
        assert_eq!(get(&store, "index.html").status(), StatusCode::NOT_FOUND);
        assert!(list(&store).is_empty());
        assert!(uninstall(&store, "nikverse").is_err());
        assert!(uninstall(&store, "Bad").is_err());
    }

    #[test]
    fn commit_needs_a_pending_version_that_is_whole() {
        let (_scratch, store) = fresh();
        assert!(commit(&store, "nikverse").is_err());
        // Pending, pointing at a folder with no manifest.
        std::fs::create_dir_all(store.version_dir("nikverse", "1.0.0").unwrap()).unwrap();
        store.set_pointer("nikverse", PENDING, "1.0.0").unwrap();
        assert!(commit(&store, "nikverse").is_err());
        assert_eq!(store.pointer("nikverse", CURRENT), None);
        assert!(rollback(&store, "nikverse").is_err());
    }

    #[test]
    fn at_most_two_versions_are_kept() {
        let (_scratch, store) = fresh();
        let installer = Installer::default();
        install_and_commit(&Table::new(good_release()), &store, &installer, TEST_PUB);
        let plugin = store.plugin_dir("nikverse").unwrap();
        std::fs::create_dir_all(plugin.join("0.9.0")).unwrap();
        install_and_commit(&Table::new(release(fixture!("index-update.json"), fixture!("index-update.json.sig"))), &store, &installer, TEST_PUB);
        let mut versions: Vec<String> = std::fs::read_dir(&plugin)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        versions.sort();
        assert_eq!(versions, vec!["1.0.0".to_string(), "1.1.0".to_string()]);
    }

    #[test]
    fn the_installer_does_not_touch_the_storage_of_a_plugin() {
        let (_scratch, store) = fresh();
        let installer = Installer::default();
        let plugin = store.plugin_dir("nikverse").unwrap();
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("storage.json"), b"mine").unwrap();
        install_and_commit(&Table::new(good_release()), &store, &installer, TEST_PUB);
        install_and_commit(&Table::new(release(fixture!("index-update.json"), fixture!("index-update.json.sig"))), &store, &installer, TEST_PUB);
        rollback(&store, "nikverse").unwrap();
        assert_eq!(std::fs::read(plugin.join("storage.json")).unwrap(), b"mine");
        // And the scheme never serves it, listed or not.
        assert_eq!(get(&store, "storage.json").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn only_one_install_runs_at_a_time() {
        let installer = Installer::default();
        assert!(installer.begin("nikverse", 2, 10));
        assert!(!installer.begin("other", 1, 1));
        installer.update(|p| p.running = false);
        assert!(installer.begin("other", 1, 1));
    }

    // ---- the real curl, against a server on the loopback ----

    /// A server on the loopback that answers from a table by path, 404 for the rest, until it is dropped: what the release is, for a real `curl`.
    struct Server {
        port: u16,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Server {
        fn start(table: HashMap<String, Vec<u8>>) -> Server {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let port = listener.local_addr().unwrap().port();
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let flag = stop.clone();
            let thread = std::thread::spawn(move || {
                while !flag.load(std::sync::atomic::Ordering::SeqCst) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    };
                    let _ = stream.set_nonblocking(false);
                    let mut request = [0u8; 4096];
                    let n = stream.read(&mut request).unwrap_or(0);
                    let head = String::from_utf8_lossy(&request[..n]).into_owned();
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    match table.get(&path) {
                        Some(body) => {
                            let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
                            let _ = stream.write_all(body);
                        }
                        None => {
                            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        }
                    }
                }
            });
            Server { port, stop, thread: Some(thread) }
        }

        fn base(&self) -> String {
            format!("http://127.0.0.1:{}/releases/", self.port)
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// The release's table, with its addresses as paths for the loopback server.
    fn as_paths(table: HashMap<String, Vec<u8>>) -> HashMap<String, Vec<u8>> {
        table.into_iter().map(|(url, body)| (url.strip_prefix("https://plugins.test").unwrap().to_string(), body)).collect()
    }

    #[test]
    fn a_whole_install_with_the_real_curl_against_a_local_server() {
        let (_scratch, store) = fresh();
        let server = Server::start(as_paths(good_release()));
        let base = server.base();
        let installer = Installer::default();
        assert_eq!(install(&cfg(&base, TEST_PUB), &Curl, &store, &installer, "nikverse", &never), Ok(true));
        assert_eq!(commit(&store, "nikverse"), Ok("1.0.0".to_string()));
        let page = get(&store, "index.html");
        assert_eq!((page.status(), page.body().as_slice()), (StatusCode::OK, fixture!("nikverse-1.0.0/index.html")));
        assert_eq!(installer.status("nikverse").files_done, 2);
        // Nothing of the downloads is left in the plugins folder.
        let leftovers: Vec<String> = std::fs::read_dir(store.root().unwrap().join(".download"))
            .map(|entries| entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn the_real_curl_refuses_a_file_bigger_than_the_manifest_says_and_a_missing_one() {
        let (_scratch, store) = fresh();
        let app_js = files("1.0.0")[1].1;
        let mut bodies = good_release();
        let mut long = app_js.to_vec();
        long.extend_from_slice(&[b'x'; 4096]);
        bodies.insert(url_of(BASE, &format!("plugin-{}", sha256_hex(app_js))), long);
        let server = Server::start(as_paths(bodies));
        let error = install(&cfg(&server.base(), TEST_PUB), &Curl, &store, &Installer::default(), "nikverse", &never).unwrap_err();
        assert!(!error.is_empty());
        assert_nothing_left(&store);
        drop(server);

        let mut bodies = good_release();
        bodies.remove(&url_of(BASE, &format!("plugin-{}", sha256_hex(app_js))));
        let server = Server::start(as_paths(bodies));
        assert!(install(&cfg(&server.base(), TEST_PUB), &Curl, &store, &Installer::default(), "nikverse", &never).is_err());
        assert_nothing_left(&store);
    }

    #[test]
    fn the_real_curl_reads_the_index_from_a_server_and_a_wrong_signature_stops_it() {
        let (_scratch, store) = fresh();
        let server = Server::start(as_paths(release(fixture!("index-otherkey.json"), fixture!("index-otherkey.json.sig"))));
        let error = check(&cfg(&server.base(), TEST_PUB), &Curl, &store, "nikverse", &never).unwrap_err();
        assert!(error.contains("firma"), "{error}");
        drop(server);
        let server = Server::start(as_paths(good_release()));
        assert_eq!(check(&cfg(&server.base(), TEST_PUB), &Curl, &store, "nikverse", &never).unwrap().version, "1.0.0");
    }

    // ---- the commands ----

    #[test]
    fn the_commands_answer_to_the_main_window_and_no_other() {
        assert_eq!(main_only("main"), Ok(()));
        for label in ["", "nikverse", "browser", "plugin-frame", "Main", "main2", "main ", "*"] {
            assert!(main_only(label).is_err(), "{label:?}");
        }
        // Every command of this module starts by asking, and none is written that does not.
        let source = include_str!("plugin_install.rs");
        let body = source.split("#[cfg(test)]").next().unwrap();
        let commands: Vec<&str> = body.split("#[tauri::command]").skip(1).collect();
        assert_eq!(commands.len(), 7, "list, check, install, status, commit, rollback, uninstall");
        for command in commands {
            let header = command.lines().find(|l| l.contains("pub async fn plugin_")).expect("a command follows");
            assert!(header.contains("window: tauri::WebviewWindow"), "{header}");
            let start = command.find("pub async fn plugin_").unwrap();
            let first_statement = command[start..].lines().nth(1).unwrap_or("").trim();
            assert_eq!(first_statement, "main_only(window.label())?;", "{header}");
        }
    }

    #[test]
    fn the_capability_binds_the_commands_to_the_main_window_and_the_frame_is_not_one() {
        let capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).expect("capabilities/default.json");
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        // No capability of this app names a window other than the main one, so no other window is granted anything.
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities");
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            if entry.path().extension().map(|e| e == "json").unwrap_or(false) {
                let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(entry.path()).unwrap()).unwrap();
                assert_eq!(value["windows"], serde_json::json!(["main"]), "{:?}", entry.path());
                assert!(value.get("webviews").is_none() && value.get("remote").is_none(), "{:?}", entry.path());
            }
        }
    }

    #[test]
    fn the_commands_are_registered_and_the_module_is_next_to_nikverses_and_leaves_it_alone() {
        let lib = include_str!("lib.rs");
        for command in ["plugin_list", "plugin_check", "plugin_install", "plugin_status", "plugin_commit", "plugin_rollback", "plugin_uninstall"] {
            assert!(lib.contains(&format!("plugin_install::{command}")), "{command}");
        }
        assert!(lib.contains("plugin_scheme::SCHEME") && lib.contains("plugin_install::Installer::default()"));
        // NikVerse's modules do not mention the new ones: it goes on as it is until it moves over.
        for other in [include_str!("nikverse.rs"), include_str!("nikverse_assets.rs")] {
            assert!(!other.contains("plugin_scheme") && !other.contains("plugin_install"));
        }
    }

    // ---- what the list says ----

    #[test]
    fn the_list_says_what_each_version_asks_for_and_what_it_weighs() {
        let (_scratch, store) = fresh();
        scheme::tests::install_by_hand(&store, "alpha", "1.0.0", &[("index.html", b"x")], &["storage", "sessions:read"]);
        // A newer version waiting: its permissions are readable before it is switched on.
        let pending = store.version_dir("alpha", "1.1.0").unwrap();
        std::fs::create_dir_all(&pending).unwrap();
        let manifest = format!(
            r#"{{"id":"alpha","version":"1.1.0","permissions":["storage","sessions:read","pane:focus"],"files":[{{"path":"index.html","sha256":"{}","size":1}}]}}"#,
            crate::nikverse::sha256_hex(b"y")
        );
        std::fs::write(pending.join(scheme::MANIFEST_FILE), manifest).unwrap();
        std::fs::write(pending.join("index.html"), b"y").unwrap();
        store.set_pointer("alpha", PENDING, "1.1.0").unwrap();
        let listed = list(&store);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].permissions, vec!["storage".to_string(), "sessions:read".to_string()]);
        assert_eq!(listed[0].pending_permissions, Some(vec!["storage".to_string(), "sessions:read".to_string(), "pane:focus".to_string()]));
        assert!(!listed[0].dev && listed[0].bytes > 0);
    }

    #[test]
    fn a_folder_with_no_version_to_serve_is_not_an_installed_plugin() {
        // What is left of an uninstall, or the document of a plugin under development.
        let (scratch, store) = fresh();
        std::fs::create_dir_all(scratch.0.join("ghost")).unwrap();
        std::fs::write(scratch.0.join("ghost").join("storage.json"), "{}").unwrap();
        assert!(list(&store).is_empty());
    }

    #[test]
    fn the_plugin_under_development_is_listed_as_such_and_replaces_an_installed_one_of_its_id() {
        let (scratch, store) = fresh();
        scheme::tests::install_by_hand(&store, "hello", "1.0.0", &[("index.html", b"x")], &["theme"]);
        let dev = scratch.0.join("dev-plugin");
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::write(dev.join("plugin.json"), r#"{"id":"hello","version":"0.0.1","permissions":["storage"]}"#).unwrap();
        std::fs::write(dev.join("index.html"), b"12345").unwrap();
        let store = store.with_dev(Some(dev));
        let listed = list(&store);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].dev);
        assert_eq!(listed[0].current.as_deref(), Some("0.0.1"));
        assert_eq!(listed[0].permissions, vec!["storage".to_string()]);
        assert!(listed[0].bytes >= 5);
    }
}
