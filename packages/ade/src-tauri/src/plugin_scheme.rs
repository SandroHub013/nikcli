//! Serving a plugin's files to its panel: the `plugin` scheme, and the layout on disk it reads.
//!
//! A plugin runs in a frame of its own inside its panel, so that whatever it does (a heavy renderer, a page that falls over) lives in a
//! process and an origin that are not ADE's. An origin of its own needs a scheme of its own: `plugin://localhost/<id>/<path>`, which
//! Windows rewrites to `http://plugin.localhost/<id>/<path>`; both arrive here. The frame is sandboxed with `allow-scripts` alone, so its
//! origin is opaque and two plugins share nothing (see the top of `nikverse.rs`, where the same is worked out for the world).
//!
//! **What is served is what an installed, verified manifest lists, and nothing else.** A plugin is a folder,
//! `<app local data>/plugins/<id>/<version>/`, with the manifest the installer verified next to its files
//! (`.manifest.json`: the path, size and SHA-256 of every file). The `current` pointer of `<id>` names the version served. A request's
//! path is only ever compared to the manifest's list, never joined to a folder, so there is nothing to traverse; a file added to the
//! folder afterwards is not in the list, and one swapped for another no longer has the size or the hash and is refused. A plugin that is
//! not installed, or has no `current`, is a 404 (a `pending` version is not served: it becomes `current` only when the panel says it
//! worked, `plugin_commit`).
//!
//! The paths it refuses outright, and tells why with a 400 rather than a 404: a way up (`..`, in every spelling), an absolute path,
//! a backslash, a NUL, and any `:` at all (a drive, a scheme, and `file::$DATA`, the NTFS alternate stream that reads and writes a file's
//! other data). An `<id>` outside `^[a-z][a-z0-9-]{1,31}$` is refused too.
//!
//! Every answer, refusals included, carries the plugin's policy: its own prefix (`http://plugin.localhost/<id>/`, `plugin://localhost/<id>/`)
//! and nothing else. No network, no inline script. Another plugin's prefix is not named, so a plugin cannot load another's files.

use crate::nikverse::sha256_hex;
use serde::Deserialize;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::Manager;

/// The scheme name. `plugin://localhost/<id>/<path>`, or `http://plugin.localhost/<id>/<path>` on Windows.
pub const SCHEME: &str = "plugin";

/// The manifest an installed version carries, next to its files. A dot-name: no file of a plugin may start with a dot.
pub const MANIFEST_FILE: &str = ".manifest.json";

/// The file served for the plugin's root, `plugin://localhost/<id>/`.
const INDEX: &str = "index.html";

/// The pointers of a plugin's folder: the version served, the one downloaded and waiting, the one before `current`.
pub const CURRENT: &str = "current";
pub const PENDING: &str = "pending";
pub const PREVIOUS: &str = "previous";

/// The biggest manifest that is read from disk (the installer refuses a bigger one on the way in; this refuses a swapped one).
pub const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
/// The most a plugin may weigh, and the most files it may have.
pub const MAX_TOTAL_BYTES: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 4096;
const MAX_PERMISSIONS: usize = 32;

// ---------------------------------------------------------------------------------------------------------------------------------
// The layout
// ---------------------------------------------------------------------------------------------------------------------------------

/// Whether `id` is a plugin's name: `^[a-z][a-z0-9-]{1,31}$`.
pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    (2..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// A version is `major.minor.patch`, three numbers, nothing after.
pub fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let mut next = || {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse::<u64>().ok()
    };
    let parsed = (next()?, next()?, next()?);
    if parts.next().is_some() {
        return None;
    }
    Some(parsed)
}

/// Where the plugins live: `<app local data>/plugins`. `None` when there is no telling, and then nothing is served.
pub struct Store {
    root: Option<PathBuf>,
}

impl Store {
    pub fn new(root: PathBuf) -> Store {
        Store { root: Some(root) }
    }

    /// No folder: every plugin is "not installed".
    pub fn absent() -> Store {
        Store { root: None }
    }

    pub fn root(&self) -> Option<&Path> {
        self.root.as_deref()
    }

    /// The folder of one plugin, when its name is one.
    pub fn plugin_dir(&self, id: &str) -> Option<PathBuf> {
        if !valid_id(id) {
            return None;
        }
        self.root.as_ref().map(|root| root.join(id))
    }

    /// The folder of one version of one plugin.
    pub fn version_dir(&self, id: &str, version: &str) -> Option<PathBuf> {
        parse_version(version)?;
        self.plugin_dir(id).map(|dir| dir.join(version))
    }

    /// The version a pointer names, when it names one that is written as a version.
    pub fn pointer(&self, id: &str, name: &str) -> Option<String> {
        let text = std::fs::read_to_string(self.plugin_dir(id)?.join(name)).ok()?;
        let version = text.trim();
        parse_version(version)?;
        Some(version.to_string())
    }

    /// Writes a pointer with a rename, so a reader sees the old one or the new one and never half of one.
    pub fn set_pointer(&self, id: &str, name: &str, version: &str) -> Result<(), String> {
        parse_version(version).ok_or("versione non valida")?;
        let dir = self.plugin_dir(id).ok_or("plugin non valido")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let temp = dir.join(format!("{name}.tmp"));
        std::fs::write(&temp, format!("{version}\n")).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, dir.join(name)).map_err(|e| {
            let _ = std::fs::remove_file(&temp);
            e.to_string()
        })
    }

    pub fn clear_pointer(&self, id: &str, name: &str) {
        if let Some(dir) = self.plugin_dir(id) {
            let _ = std::fs::remove_file(dir.join(name));
        }
    }

    /// The manifest an installed version carries, read and checked, or why not.
    pub fn manifest(&self, id: &str, version: &str) -> Result<Manifest, String> {
        let file = self.version_dir(id, version).ok_or("versione non valida")?.join(MANIFEST_FILE);
        let length = std::fs::metadata(&file).map_err(|e| e.to_string())?.len();
        if length > MAX_MANIFEST_BYTES {
            return Err("manifesto troppo grande".into());
        }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        Manifest::parse(&bytes, id, version)
    }
}

/// The store of this run, found once.
pub fn store<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> &'static Store {
    static STORE: std::sync::OnceLock<Store> = std::sync::OnceLock::new();
    STORE.get_or_init(|| match app.path().app_local_data_dir() {
        Ok(dir) => Store::new(dir.join("plugins")),
        Err(_) => Store::absent(),
    })
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------------------------------------------------------------

/// One file of a plugin, as the manifest lists it.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct FileEntry {
    /// Relative to the plugin's folder, forward slashes.
    pub path: String,
    /// SHA-256 of the file, lowercase hex.
    pub sha256: String,
    pub size: u64,
}

/// The list of a version's files, with what the plugin asks ADE for.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    pub files: Vec<FileEntry>,
}

/// Names Windows will not let a file have, with or without an extension.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4",
    "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

impl Manifest {
    /// Reads a manifest, and refuses one that is not what the installer would have kept: another plugin's or version's, an empty one,
    /// a path that is not plain, a hash that is not a hash, a total over the limit.
    pub fn parse(bytes: &[u8], id: &str, version: &str) -> Result<Manifest, String> {
        let manifest: Manifest = serde_json::from_slice(bytes).map_err(|e| format!("manifesto non valido: {e}"))?;
        if manifest.id != id || manifest.version != version {
            return Err("il manifesto è di un altro plugin o di un'altra versione".into());
        }
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), String> {
        if self.files.is_empty() || self.files.len() > MAX_FILES {
            return Err("il manifesto non elenca file, o ne elenca troppi".into());
        }
        if self.permissions.len() > MAX_PERMISSIONS
            || self.permissions.iter().any(|p| {
                p.is_empty()
                    || p.len() > 32
                    || !p.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'_'))
            })
        {
            return Err("permessi non validi nel manifesto".into());
        }
        let mut total: u64 = 0;
        let mut seen = std::collections::HashSet::new();
        for file in &self.files {
            if let Some(reason) = plain_path(&file.path) {
                return Err(format!("percorso non valido nel manifesto ({}): {}", file.path, reason));
            }
            if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
                return Err(format!("hash non valido nel manifesto ({})", file.path));
            }
            if file.size > MAX_TOTAL_BYTES {
                return Err(format!("file troppo grande nel manifesto ({})", file.path));
            }
            total = total.saturating_add(file.size);
            if !seen.insert(file.path.to_ascii_lowercase()) {
                return Err(format!("percorso doppio nel manifesto ({})", file.path));
            }
        }
        if total > MAX_TOTAL_BYTES {
            return Err("il plugin supera i 200 MB".into());
        }
        Ok(())
    }

    /// The bytes of every file together.
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }
}

/// Why a manifest's path is not a plain relative path, when it is not: every component a name, none starting with a dot.
fn plain_path(path: &str) -> Option<&'static str> {
    if path.is_empty() || path.len() > 200 {
        return Some("vuoto o troppo lungo");
    }
    if let Some(reason) = refused(path) {
        return Some(reason);
    }
    if path.starts_with('/') || path.ends_with('/') {
        return Some("percorso assoluto o di una cartella");
    }
    for part in path.split('/') {
        if part.is_empty() {
            return Some("componente vuoto");
        }
        if part.starts_with('.') {
            return Some("nome che comincia con un punto");
        }
        if part.ends_with(' ') || part.ends_with('.') || part.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) {
            return Some("nome che Windows non accetta");
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
        if RESERVED.contains(&stem.as_str()) {
            return Some("nome riservato di Windows");
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The paths a request may name
// ---------------------------------------------------------------------------------------------------------------------------------

fn urldecode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Why a path is refused, when it is; `None` when it may go on to be looked up.
///
/// Checked on the decoded path, so `%2e%2e` and a plain `..` are the same request.
fn refused(decoded: &str) -> Option<&'static str> {
    if decoded.contains('\0') {
        return Some("percorso con un byte nullo");
    }
    if decoded.contains('\\') {
        return Some("percorso con una barra rovesciata");
    }
    if decoded.contains(':') {
        // A drive (`C:/…`), a stream (`file::$DATA`), or a scheme: an absolute path, or another data of the same file, in every spelling.
        return Some("percorso assoluto");
    }
    // An empty component: `//etc/passwd` at the start, or `alpha//etc/passwd` after the name, which is an absolute path in disguise.
    if decoded.contains("//") {
        return Some("percorso assoluto");
    }
    if decoded.split('/').any(|part| part == "..") {
        return Some("percorso che risale (..)");
    }
    None
}

fn asset_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ktx2" => "image/ktx2",
        "wasm" => "application/wasm",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------------------------------------------

/// The policy of every answer of the plugin `id`: its own prefix, WebAssembly for its decoders, and no network.
///
/// The host is named, not `'self'`, because the frame's origin is opaque: `http://plugin.localhost` is the scheme as Windows answers it,
/// `plugin:` as the others do. Only this plugin's prefix is named, so it cannot load another plugin's files (or ADE's).
///
/// `sandbox allow-scripts` is in the answer itself, not only in the `sandbox` attribute of the panel's frame: this scheme is a LOCAL origin
/// for Tauri's IPC ACL, so a page of a plugin that was ever loaded without the attribute (a bug, another panel, a top-level navigation)
/// would have every command. With the directive the document is opaque whoever frames it, and never `allow-same-origin`.
pub fn csp_for(id: &str) -> String {
    let prefix = format!("http://plugin.localhost/{id}/ plugin://localhost/{id}/");
    format!("default-src {prefix}; script-src {prefix} 'wasm-unsafe-eval'; img-src {prefix} data: blob:; connect-src {prefix}; sandbox allow-scripts")
}

/// What a request with no plugin to name (a refused id) is answered under: nothing may load, and the document is opaque all the same.
const NOTHING: &str = "default-src 'none'; sandbox allow-scripts";

fn with_headers(mut builder: tauri::http::response::Builder, id: Option<&str>) -> tauri::http::response::Builder {
    let csp = match id {
        Some(id) if valid_id(id) => csp_for(id),
        _ => NOTHING.to_string(),
    };
    for (name, value) in [
        ("Content-Security-Policy", csp.as_str()),
        // Public and static, and an opaque origin can only load it through CORS.
        ("Access-Control-Allow-Origin", "*"),
        ("X-Content-Type-Options", "nosniff"),
        ("Cache-Control", "no-store"),
    ] {
        builder = builder.header(name, value);
    }
    builder
}

fn deny(status: StatusCode, id: Option<&str>) -> Response<Vec<u8>> {
    with_headers(Response::builder(), id)
        .status(status)
        .body(Vec::new())
        .expect("risposta statica")
}

fn io_status(error: std::io::Error) -> StatusCode {
    if error.kind() == std::io::ErrorKind::NotFound {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// The bytes of one file the installed manifest lists, or the status to answer with.
///
/// `relative` is compared to the list and is not used as a path: what is read is the list's own `path`.
fn read_file(store: &Store, id: &str, relative: &str) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let version = store.pointer(id, CURRENT).ok_or(StatusCode::NOT_FOUND)?;
    let manifest = store.manifest(id, &version).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let entry = manifest.files.iter().find(|entry| entry.path == relative).ok_or(StatusCode::NOT_FOUND)?;
    let file = store.version_dir(id, &version).ok_or(StatusCode::NOT_FOUND)?.join(&entry.path);
    // The size first, so a file swapped for a huge one is not read into memory to be refused.
    let length = std::fs::metadata(&file).map_err(io_status)?.len();
    if length != entry.size {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    let bytes = std::fs::read(&file).map_err(io_status)?;
    if bytes.len() as u64 != entry.size || sha256_hex(&bytes) != entry.sha256 {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Ok((asset_mime(&entry.path), bytes))
}

/// The plugin a request path names and the path inside it. The id is looked at even in a refusal, to put the right policy on it.
fn split(decoded: &str) -> (Option<&str>, &str) {
    let relative = decoded.trim_start_matches('/');
    match relative.split_once('/') {
        Some((id, rest)) => (Some(id), rest),
        None => (Some(relative), ""),
    }
}

/// Answers one request for a file of a plugin, from `store`.
pub fn respond(request: &Request<Vec<u8>>, store: &Store) -> Response<Vec<u8>> {
    let decoded = urldecode(request.uri().path());
    let (id, rest) = split(&decoded);
    let id = id.filter(|id| valid_id(id));
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return deny(StatusCode::METHOD_NOT_ALLOWED, id);
    }
    if refused(&decoded).is_some() {
        return deny(StatusCode::BAD_REQUEST, id);
    }
    let Some(id) = id else {
        return deny(StatusCode::BAD_REQUEST, None);
    };
    let wanted = if rest.is_empty() { INDEX } else { rest };
    let (mime, bytes): (&str, Cow<[u8]>) = match read_file(store, id, wanted) {
        Ok((mime, bytes)) => (mime, Cow::Owned(bytes)),
        Err(status) => return deny(status, Some(id)),
    };
    let length = bytes.len();
    let body = if request.method() == Method::HEAD { Vec::new() } else { bytes.into_owned() };
    with_headers(Response::builder(), Some(id))
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Content-Length", length.to_string())
        .body(body)
        .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR, Some(id)))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A folder of its own under the temp dir, removed when the test ends.
    pub(crate) struct Scratch(pub PathBuf);

    impl Scratch {
        pub(crate) fn new() -> Scratch {
            static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("plugin-test-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("cartella di prova");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Installs a version by hand: its files, its manifest, and `current` pointing at it.
    pub(crate) fn install_by_hand(store: &Store, id: &str, version: &str, files: &[(&str, &[u8])], permissions: &[&str]) {
        let dir = store.version_dir(id, version).expect("cartella della versione");
        for (path, bytes) in files {
            let file = dir.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }
        let listed: Vec<String> = files
            .iter()
            .map(|(path, bytes)| format!(r#"{{"path":"{path}","sha256":"{}","size":{}}}"#, sha256_hex(bytes), bytes.len()))
            .collect();
        let perms: Vec<String> = permissions.iter().map(|p| format!("\"{p}\"")).collect();
        let manifest = format!(
            r#"{{"id":"{id}","version":"{version}","permissions":[{}],"files":[{}]}}"#,
            perms.join(","),
            listed.join(",")
        );
        std::fs::write(dir.join(MANIFEST_FILE), manifest).unwrap();
        store.set_pointer(id, CURRENT, version).unwrap();
    }

    fn get(store: &Store, uri: &str) -> Response<Vec<u8>> {
        respond(&Request::builder().uri(uri).body(Vec::new()).expect("richiesta"), store)
    }

    fn header<'a>(response: &'a Response<Vec<u8>>, name: &str) -> &'a str {
        response.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }

    /// A store with plugin `alpha` installed at 1.0.0 (an index and a script) and `beta` at 2.0.0.
    fn store_with_plugins(scratch: &Scratch) -> Store {
        let store = Store::new(scratch.0.clone());
        install_by_hand(&store, "alpha", "1.0.0", &[("index.html", b"<html>alpha</html>"), ("js/app.js", b"alpha()"), ("data/a.wasm", b"\0asm")], &["theme"]);
        install_by_hand(&store, "beta", "2.0.0", &[("index.html", b"<html>beta</html>")], &[]);
        store
    }

    #[test]
    fn serves_what_the_installed_manifest_lists_with_its_type_and_the_policy() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        for uri in ["plugin://localhost/alpha/", "plugin://localhost/alpha/index.html", "http://plugin.localhost/alpha/", "http://plugin.localhost/alpha/index.html"] {
            let response = get(&store, uri);
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert_eq!(header(&response, "content-type"), "text/html; charset=utf-8", "{uri}");
            assert_eq!(response.body().as_slice(), b"<html>alpha</html>", "{uri}");
            assert_eq!(header(&response, "content-length"), "18", "{uri}");
        }
        let script = get(&store, "plugin://localhost/alpha/js/app.js");
        assert_eq!((script.status(), header(&script, "content-type")), (StatusCode::OK, "text/javascript; charset=utf-8"));
        assert_eq!(header(&get(&store, "plugin://localhost/alpha/data/a.wasm"), "content-type"), "application/wasm");
        // Each plugin answers with its own files.
        assert_eq!(get(&store, "plugin://localhost/beta/").body().as_slice(), b"<html>beta</html>");
    }

    #[test]
    fn only_reads_are_answered_and_head_has_no_body() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        for method in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
            let request = Request::builder().method(method).uri("plugin://localhost/alpha/").body(Vec::new()).unwrap();
            assert_eq!(respond(&request, &store).status(), StatusCode::METHOD_NOT_ALLOWED);
        }
        let head = Request::builder().method(Method::HEAD).uri("plugin://localhost/alpha/index.html").body(Vec::new()).unwrap();
        let response = respond(&head, &store);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().is_empty());
        assert_eq!(header(&response, "content-length"), "18");
    }

    #[test]
    fn refuses_a_way_up_in_every_spelling() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        for uri in [
            "plugin://localhost/alpha/../beta/index.html",
            "plugin://localhost/alpha/%2e%2e/beta/index.html",
            "plugin://localhost/alpha/%2E%2E%2Fbeta/index.html",
            "plugin://localhost/alpha/a/../../beta/index.html",
            "plugin://localhost/alpha/..%5Cbeta/index.html",
            "plugin://localhost/alpha/%2e%2e",
            "plugin://localhost/alpha/js/%2e%2e/%2e%2e/beta/index.html",
            "plugin://localhost/../alpha/index.html",
        ] {
            assert_eq!(get(&store, uri).status(), StatusCode::BAD_REQUEST, "{uri}");
        }
    }

    #[test]
    fn refuses_an_absolute_path_a_drive_and_a_backslash() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        for uri in [
            "plugin://localhost//etc/passwd",
            "plugin://localhost/alpha//etc/passwd",
            "plugin://localhost/alpha/C:/Windows/win.ini",
            "plugin://localhost/alpha/C%3A%5CWindows%5Cwin.ini",
            "plugin://localhost/C:/alpha/index.html",
            "plugin://localhost/alpha/back%5Cslash",
            "plugin://localhost/alpha/nul%00.js",
            "plugin://localhost/alpha/index.html%00.png",
        ] {
            assert_eq!(get(&store, uri).status(), StatusCode::BAD_REQUEST, "{uri}");
        }
    }

    #[test]
    fn refuses_any_colon_the_ntfs_streams_included() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        // `file::$DATA` reads, and on a write would replace, the file itself; `file:stream` is another stream of it.
        for uri in [
            "plugin://localhost/alpha/index.html::$DATA",
            "plugin://localhost/alpha/index.html%3A%3A%24DATA",
            "plugin://localhost/alpha/index.html:evil",
            "plugin://localhost/alpha/index.html:evil:$DATA",
            "plugin://localhost/alpha/js/app.js::$DATA",
            "plugin://localhost/alpha/js:x/app.js",
            "plugin://localhost/alpha:x/index.html",
            "plugin://localhost/alpha/:",
        ] {
            assert_eq!(get(&store, uri).status(), StatusCode::BAD_REQUEST, "{uri}");
        }
    }

    #[test]
    fn a_name_that_is_not_a_plugins_is_refused() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        let long = "a".repeat(33);
        for id in ["A", "Alpha", "a", "1a", "-a", "a_b", "a.b", "a%20b", "alpha%20", "%61lpha%2f", long.as_str(), "%C3%A1lpha", ""] {
            let status = get(&store, &format!("plugin://localhost/{id}/index.html")).status();
            assert!(status == StatusCode::BAD_REQUEST || status == StatusCode::NOT_FOUND, "{id}: {status}");
            assert_ne!(status, StatusCode::OK, "{id}");
        }
        // The plain refusals are 400: the name is what is wrong, not a lookup that failed.
        for id in ["Alpha", "a", "1a", "a_b", "a.b"] {
            assert_eq!(get(&store, &format!("plugin://localhost/{id}/index.html")).status(), StatusCode::BAD_REQUEST, "{id}");
        }
        assert!(valid_id("ab") && valid_id("nikverse") && valid_id("a-1-b") && valid_id(&"a".repeat(32)));
        assert!(!valid_id(&long) && !valid_id("a") && !valid_id("Ab") && !valid_id("a_b") && !valid_id("9a") && !valid_id("a/b"));
    }

    #[test]
    fn a_plugin_that_is_not_installed_or_has_no_current_is_not_found() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        assert_eq!(get(&store, "plugin://localhost/gamma/index.html").status(), StatusCode::NOT_FOUND);
        // A version that is only pending is not served: it is `current` only once the panel has said it worked.
        let pending = store.version_dir("gamma", "1.0.0").unwrap();
        std::fs::create_dir_all(&pending).unwrap();
        std::fs::write(pending.join("index.html"), b"x").unwrap();
        store.set_pointer("gamma", PENDING, "1.0.0").unwrap();
        assert_eq!(get(&store, "plugin://localhost/gamma/index.html").status(), StatusCode::NOT_FOUND);
        // No store at all.
        assert_eq!(get(&Store::absent(), "plugin://localhost/alpha/index.html").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn serves_nothing_that_is_not_in_the_manifest_even_when_it_is_on_disk() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        let dir = store.version_dir("alpha", "1.0.0").unwrap();
        std::fs::write(dir.join("added-later.js"), b"evil()").unwrap();
        std::fs::write(dir.join("js/hidden.js"), b"evil()").unwrap();
        // Another plugin's file, and the manifest itself, and a file in the plugin's folder above the version.
        for uri in [
            "plugin://localhost/alpha/added-later.js",
            "plugin://localhost/alpha/js/hidden.js",
            "plugin://localhost/alpha/.manifest.json",
            "plugin://localhost/alpha/INDEX.HTML",
            "plugin://localhost/alpha/js",
            "plugin://localhost/alpha/js/",
            "plugin://localhost/alpha/current",
            "plugin://localhost/alpha/1.0.0/index.html",
            "plugin://localhost/alpha/missing.js",
        ] {
            assert_eq!(get(&store, uri).status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    #[test]
    fn a_file_whose_size_or_bytes_changed_is_not_served() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        let dir = store.version_dir("alpha", "1.0.0").unwrap();
        // Same size, other bytes.
        std::fs::write(dir.join("js/app.js"), b"evil!()").unwrap();
        assert_eq!(get(&store, "plugin://localhost/alpha/js/app.js").status(), StatusCode::INTERNAL_SERVER_ERROR);
        // Another size.
        std::fs::write(dir.join("index.html"), b"<html>alpha and a lot more</html>").unwrap();
        assert_eq!(get(&store, "plugin://localhost/alpha/index.html").status(), StatusCode::INTERNAL_SERVER_ERROR);
        // A file that is gone.
        std::fs::remove_file(dir.join("data/a.wasm")).unwrap();
        assert_eq!(get(&store, "plugin://localhost/alpha/data/a.wasm").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn a_manifest_that_was_swapped_is_not_believed() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        let dir = store.version_dir("alpha", "1.0.0").unwrap();
        // Another plugin's manifest under this name, one with a way up in a path, and one too big to read.
        std::fs::write(dir.join(MANIFEST_FILE), br#"{"id":"beta","version":"1.0.0","files":[{"path":"index.html","sha256":"00","size":1}]}"#).unwrap();
        assert_eq!(get(&store, "plugin://localhost/alpha/index.html").status(), StatusCode::INTERNAL_SERVER_ERROR);
        let bad = format!(r#"{{"id":"alpha","version":"1.0.0","files":[{{"path":"../beta/index.html","sha256":"{}","size":18}}]}}"#, "0".repeat(64));
        std::fs::write(dir.join(MANIFEST_FILE), bad).unwrap();
        assert_eq!(get(&store, "plugin://localhost/alpha/index.html").status(), StatusCode::INTERNAL_SERVER_ERROR);
        std::fs::write(dir.join(MANIFEST_FILE), vec![b' '; (MAX_MANIFEST_BYTES + 1) as usize]).unwrap();
        assert_eq!(get(&store, "plugin://localhost/alpha/index.html").status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn every_answer_carries_the_plugins_policy_even_a_refusal() {
        let scratch = Scratch::new();
        let store = store_with_plugins(&scratch);
        let csp = csp_for("alpha");
        for uri in [
            "plugin://localhost/alpha/",
            "plugin://localhost/alpha/js/app.js",
            "plugin://localhost/alpha/nope.js",
            "plugin://localhost/alpha/../beta/index.html",
            "plugin://localhost/alpha/index.html::$DATA",
        ] {
            let response = get(&store, uri);
            assert_eq!(header(&response, "content-security-policy"), csp, "{uri}");
            assert_eq!(header(&response, "x-content-type-options"), "nosniff", "{uri}");
            assert_eq!(header(&response, "access-control-allow-origin"), "*", "{uri}");
        }
        // Even a request that names no plugin at all: nothing may load under it.
        for uri in ["plugin://localhost/", "plugin://localhost/Bad_Id/x", "plugin://localhost/a/x"] {
            let response = get(&store, uri);
            assert_eq!(header(&response, "content-security-policy"), "default-src 'none'; sandbox allow-scripts", "{uri}");
            assert_eq!(header(&response, "x-content-type-options"), "nosniff", "{uri}");
        }
        // Every answer, a refusal or not, makes the document opaque itself, and never gives it back its origin.
        for uri in [
            "plugin://localhost/alpha/index.html",
            "plugin://localhost/alpha/nope.js",
            "plugin://localhost/alpha/../beta/index.html",
            "plugin://localhost/",
            "plugin://localhost/Bad_Id/x",
        ] {
            let response = get(&store, uri);
            let csp = header(&response, "content-security-policy");
            assert!(csp.split(';').map(str::trim).any(|d| d == "sandbox allow-scripts"), "{uri}: {csp}");
            assert!(!csp.contains("allow-same-origin"), "{uri}: {csp}");
        }
        // A method that is refused is answered under the plugin's policy too.
        let post = Request::builder().method(Method::POST).uri("plugin://localhost/alpha/").body(Vec::new()).unwrap();
        assert_eq!(header(&respond(&post, &store), "content-security-policy"), csp);
    }

    #[test]
    fn the_policy_names_only_its_own_plugin_and_no_network() {
        let alpha = csp_for("alpha");
        let beta = csp_for("beta");
        assert!(alpha.contains("http://plugin.localhost/alpha/") && alpha.contains("plugin://localhost/alpha/"));
        // A plugin's policy does not name another plugin, and not the host without a plugin.
        assert!(!alpha.contains("beta") && !beta.contains("alpha"));
        assert!(!alpha.contains("plugin.localhost/ ") && !alpha.contains("plugin.localhost;"), "{alpha}");
        // The frame's origin is opaque, so `'self'` would match nothing.
        assert!(!alpha.contains("'self'"), "{alpha}");
        let tokens: Vec<&str> = alpha.split(|c: char| c == ';' || c.is_whitespace()).collect();
        for banned in ["'unsafe-inline'", "'unsafe-eval'", "http:", "https:", "ws:", "wss:", "*", "'self'"] {
            assert!(!tokens.contains(&banned), "la policy non deve avere {banned}");
        }
        for directive in ["default-src", "script-src", "img-src", "connect-src"] {
            assert!(alpha.split(';').any(|d| d.trim().starts_with(directive)), "manca {directive}");
        }
        let script = alpha.split(';').map(str::trim).find(|d| d.starts_with("script-src")).unwrap();
        assert!(script.contains("'wasm-unsafe-eval'") && !script.contains("data:") && !script.contains("blob:"), "script-src: {script}");
        // No style, frame, form, or object directive is widened: they fall back to default-src.
        assert!(!alpha.contains("style-src") && !alpha.contains("frame-src") && !alpha.contains("form-action"));
    }

    #[test]
    fn the_scheme_and_the_frame_source_line_up() {
        assert_eq!(SCHEME, "plugin");
        // `tauri.conf.json` lets ADE frame it, and keeps `nikverse:` until the world moves over.
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let csp = config["app"]["security"]["csp"].as_str().expect("app.security.csp");
        let frame_src = csp.split(';').map(str::trim).find(|d| d.starts_with("frame-src")).expect("frame-src");
        let tokens: Vec<&str> = frame_src.split_whitespace().collect();
        assert!(tokens.contains(&"plugin:") && tokens.contains(&"nikverse:"), "{frame_src}");
        assert!(!tokens.contains(&"*"), "{frame_src}");
    }

    #[test]
    fn versions_are_three_numbers_and_nothing_else() {
        assert_eq!(parse_version("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("0.0.0"), Some((0, 0, 0)));
        assert!(parse_version("1.2.10") > parse_version("1.2.9"));
        for bad in ["", "1", "1.2", "1.2.3.4", "1.2.x", "1.2.3-beta", "v1.2.3", "1..3", "-1.2.3", " 1.2.3", "1.2.3 ", "1.2.99999999999"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_pointer_is_written_whole_and_a_bad_one_is_no_pointer() {
        let scratch = Scratch::new();
        let store = Store::new(scratch.0.clone());
        assert_eq!(store.pointer("alpha", CURRENT), None);
        store.set_pointer("alpha", CURRENT, "1.2.3").unwrap();
        assert_eq!(store.pointer("alpha", CURRENT).as_deref(), Some("1.2.3"));
        store.set_pointer("alpha", CURRENT, "1.2.4").unwrap();
        assert_eq!(store.pointer("alpha", CURRENT).as_deref(), Some("1.2.4"));
        assert!(!store.plugin_dir("alpha").unwrap().join("current.tmp").exists());
        std::fs::write(store.plugin_dir("alpha").unwrap().join(PENDING), "../../x\n").unwrap();
        assert_eq!(store.pointer("alpha", PENDING), None);
        assert!(store.set_pointer("alpha", CURRENT, "../x").is_err());
        assert!(store.set_pointer("Bad", CURRENT, "1.0.0").is_err());
        store.clear_pointer("alpha", CURRENT);
        assert_eq!(store.pointer("alpha", CURRENT), None);
    }

    #[test]
    fn a_manifest_is_refused_for_every_path_that_is_not_plain() {
        let hash = "a".repeat(64);
        let make = |path: &str| {
            format!(r#"{{"id":"alpha","version":"1.0.0","files":[{{"path":{},"sha256":"{hash}","size":1}}]}}"#, serde_json::to_string(path).unwrap())
        };
        assert!(Manifest::parse(make("index.html").as_bytes(), "alpha", "1.0.0").is_ok());
        assert!(Manifest::parse(make("a/b/c.js").as_bytes(), "alpha", "1.0.0").is_ok());
        let long = "x".repeat(201);
        for path in [
            "", "/index.html", "index.html/", "../x", "a/../x", "a//b", ".hidden", "a/.hidden", ".manifest.json", "a\\b", "C:/x", "x::$DATA", "x:y", "nul", "NUL.txt",
            "a/com1.js", "trailing.", "trailing ", "a<b", "a|b", "a?b", "a*b", "a\"b", "a\u{0}b", long.as_str(),
        ] {
            assert!(Manifest::parse(make(path).as_bytes(), "alpha", "1.0.0").is_err(), "{path:?}");
        }
    }

    #[test]
    fn a_manifest_is_refused_for_what_it_says_about_itself() {
        let hash = "a".repeat(64);
        let file = format!(r#"{{"path":"index.html","sha256":"{hash}","size":1}}"#);
        let ok = |extra: &str, files: &str| format!(r#"{{"id":"alpha","version":"1.0.0"{extra},"files":[{files}]}}"#);
        assert!(Manifest::parse(ok("", &file).as_bytes(), "alpha", "1.0.0").is_ok());
        // Another plugin, another version, nothing listed, a hash that is not one, a size over the limit, twice the same path (any case).
        assert!(Manifest::parse(ok("", &file).as_bytes(), "beta", "1.0.0").is_err());
        assert!(Manifest::parse(ok("", &file).as_bytes(), "alpha", "1.0.1").is_err());
        assert!(Manifest::parse(ok("", "").as_bytes(), "alpha", "1.0.0").is_err());
        let (upper, letters_g, too_long) = ("A".repeat(64), "g".repeat(64), "a".repeat(65));
        for bad_hash in ["00", upper.as_str(), letters_g.as_str(), too_long.as_str()] {
            let bad = format!(r#"{{"path":"index.html","sha256":"{bad_hash}","size":1}}"#);
            assert!(Manifest::parse(ok("", &bad).as_bytes(), "alpha", "1.0.0").is_err(), "{bad_hash}");
        }
        let huge = format!(r#"{{"path":"index.html","sha256":"{hash}","size":{}}}"#, MAX_TOTAL_BYTES + 1);
        assert!(Manifest::parse(ok("", &huge).as_bytes(), "alpha", "1.0.0").is_err());
        let twice = format!("{file},{}", file.replace("index.html", "INDEX.HTML"));
        assert!(Manifest::parse(ok("", &twice).as_bytes(), "alpha", "1.0.0").is_err());
        // Together they must fit in 200 MB.
        let half = MAX_TOTAL_BYTES / 2 + 1;
        let two = format!(
            r#"{{"path":"a.bin","sha256":"{hash}","size":{half}}},{{"path":"b.bin","sha256":"{hash}","size":{half}}}"#
        );
        assert!(Manifest::parse(ok("", &two).as_bytes(), "alpha", "1.0.0").is_err());
        // Permissions: plain lowercase names only.
        assert!(Manifest::parse(ok(r#","permissions":["theme","snapshot.read"]"#, &file).as_bytes(), "alpha", "1.0.0").is_ok());
        assert!(Manifest::parse(ok(r#","permissions":["Theme"]"#, &file).as_bytes(), "alpha", "1.0.0").is_err());
        assert!(Manifest::parse(ok(r#","permissions":[""]"#, &file).as_bytes(), "alpha", "1.0.0").is_err());
        assert!(Manifest::parse(b"not json", "alpha", "1.0.0").is_err());
    }
}
