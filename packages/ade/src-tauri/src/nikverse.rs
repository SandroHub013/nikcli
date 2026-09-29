//! Serving NikVerse's world to its panel.
//!
//! The world runs in a frame of its own inside the NikVerse panel, so that a
//! heavy renderer lives in a process and an origin that are not ADE's: if the
//! world falls over, ADE stays up (the lesson of Parakeet). An origin of its
//! own needs a scheme of its own, and this registers it: `nikverse://localhost/`,
//! which Windows rewrites to `http://nikverse.localhost/`; both arrive here.
//!
//! What it serves is the package and nothing else. The files are compiled into
//! the binary (`PACKAGE`), so a request can only ever name one of them: there
//! is no directory behind the scheme to escape from, and no project file, `.env`
//! or session transcript that a page in the frame could read by asking for it.
//! The path rules below still refuse `..`, an absolute path or a backslash
//! outright, so a request that tries is told why instead of being told "not
//! found".
//!
//! **The assets are the one thing read from disk** (`/assets/<file>`): sprites,
//! models, sounds are too big to compile in. `build.rs` lists every file of
//! `nikverse-assets/` with its SHA-256 and size (`MANIFEST`, compiled in); the
//! scheme answers only a path the manifest names, and serves the file only if
//! its size and hash are still what the binary was built with. The request's
//! path is only ever compared to the list, never joined to a directory, so
//! there is nothing to traverse; a file added to the folder after the build, or
//! swapped for another, is not served. A release finds the folder in the
//! bundle's resources (`bundle.resources` in `tauri.conf.json`); a debug build
//! reads the sources, so editing an asset shows on the next request, and does
//! not check the hash, which an edit would break (the list is rebuilt on the
//! next `cargo build`).
//!
//! Every answer carries the world's content security policy: its own files
//! only, no network, no inline script.
//!
//! **The frame's origin is opaque, on purpose.** In Tauri every scheme registered
//! with `register_uri_scheme_protocol` is a *local* origin for the IPC's ACL, so a
//! world framed with `allow-same-origin` would have `http://nikverse.localhost`
//! as its origin and the window's own capabilities with it. The panel frames it
//! with `sandbox="allow-scripts"` alone: the origin becomes `null`, which Tauri
//! refuses. Two consequences live here. `'self'` no longer matches anything on
//! an opaque origin, so the policy names the host. And a module script or a
//! `fetch` from an opaque origin is a CORS request, so the package, which is
//! static and public, answers `Access-Control-Allow-Origin: *`.

use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::Manager;

/// The scheme name. `nikverse://localhost/<file>`, or `http://nikverse.localhost/<file>` on Windows.
pub const SCHEME: &str = "nikverse";

/// One file of the package, as it is served.
struct PackageFile {
    /// Relative to the root, forward slashes, no leading slash.
    path: &'static str,
    mime: &'static str,
    body: &'static [u8],
}

/// Everything the scheme can answer with.
const PACKAGE: &[PackageFile] = &[
    PackageFile {
        path: "index.html",
        mime: "text/html; charset=utf-8",
        body: include_bytes!("../../src/nikverse/world/index.html"),
    },
    PackageFile {
        path: "world.js",
        mime: "text/javascript; charset=utf-8",
        body: include_bytes!("../../src/nikverse/world/world.js"),
    },
    PackageFile {
        path: "world.css",
        mime: "text/css; charset=utf-8",
        body: include_bytes!("../../src/nikverse/world/world.css"),
    },
];

/// The file served for `/`.
const INDEX: &str = "index.html";

/// The folder of the assets, next to `Cargo.toml` and, in a bundle, inside the resources.
/// `build.rs` lists the same folder and `tauri.conf.json` ships it under the same name.
pub const ASSETS_DIR: &str = "nikverse-assets";

/// The URL prefix of the assets: `nikverse://localhost/assets/<path in the manifest>`.
const ASSETS_PREFIX: &str = "assets/";

/// One asset the binary was built with: where it is under the folder, and what it must still be.
pub struct ManifestEntry {
    /// Relative to the assets folder, forward slashes; the same as the path after `/assets/`.
    pub path: &'static str,
    /// SHA-256 of the file, lowercase hex.
    pub sha256: &'static str,
    pub size: u64,
}

// `MANIFEST`, written by `build.rs` from the files in `nikverse-assets/`.
include!(concat!(env!("OUT_DIR"), "/nikverse_manifest.rs"));

/// Where the assets are read from, and whether their hash is checked.
pub struct Source {
    /// The assets folder; `None` when there is no telling where it is, and then no asset is served.
    root: Option<PathBuf>,
    /// A release checks size and hash; a debug build reads the sources as they are being edited.
    verify: bool,
}

impl Source {
    /// No assets folder: the package is served and every asset is "not found".
    pub fn absent() -> Source {
        Source { root: None, verify: true }
    }

    /// Debug: the sources, unchecked. Release: the bundle's resources, checked.
    fn choose(debug: bool, manifest_dir: &Path, resource_dir: Option<PathBuf>) -> Source {
        if debug {
            Source { root: Some(manifest_dir.join(ASSETS_DIR)), verify: false }
        } else {
            Source { root: resource_dir.map(|dir| dir.join(ASSETS_DIR)), verify: true }
        }
    }
}

/// The source of this run, found once.
pub fn source<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> &'static Source {
    static SOURCE: std::sync::OnceLock<Source> = std::sync::OnceLock::new();
    SOURCE.get_or_init(|| {
        Source::choose(
            cfg!(debug_assertions),
            Path::new(env!("CARGO_MANIFEST_DIR")),
            app.path().resource_dir().ok(),
        )
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The media type of an asset, by its extension.
fn asset_mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ktx2" => "image/ktx2",
        "json" => "application/json",
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

/// The bytes of an asset the manifest names, or the status to answer with.
///
/// `relative` is compared to the list and is not used as a path: what is read is `entry.path`.
fn read_asset(
    source: &Source,
    manifest: &[ManifestEntry],
    relative: &str,
) -> Result<(&'static str, Vec<u8>), StatusCode> {
    let entry = manifest
        .iter()
        .find(|entry| entry.path == relative)
        .ok_or(StatusCode::NOT_FOUND)?;
    let root = source.root.as_ref().ok_or(StatusCode::NOT_FOUND)?;
    let file = root.join(entry.path);
    if source.verify {
        // The size first, so a file swapped for a huge one is not read into memory to be refused.
        let length = std::fs::metadata(&file).map_err(io_status)?.len();
        if length != entry.size {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    }
    let bytes = std::fs::read(&file).map_err(io_status)?;
    if source.verify && (bytes.len() as u64 != entry.size || sha256_hex(&bytes) != entry.sha256) {
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }
    Ok((asset_mime(entry.path), bytes))
}

fn io_status(error: std::io::Error) -> StatusCode {
    if error.kind() == std::io::ErrorKind::NotFound {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// The policy of every answer: the world's own files, WebAssembly for its decoders, and no network.
///
/// The host is named, not `'self'`, because the frame's origin is opaque (see the top of the file):
/// `http://nikverse.localhost` is the scheme as Windows answers it, `nikverse:` as the others do.
/// `connect-src` lets the world load its own assets and nothing else; the data it needs from ADE
/// arrives on the channel, which is not a request.
pub const CSP: &str = "default-src http://nikverse.localhost nikverse:; script-src http://nikverse.localhost nikverse: 'wasm-unsafe-eval'; img-src http://nikverse.localhost nikverse: data: blob:; connect-src http://nikverse.localhost nikverse:";

const HEADERS: [(&str, &str); 4] = [
    ("Content-Security-Policy", CSP),
    // The package is public and static, and an opaque origin can only load it through CORS.
    ("Access-Control-Allow-Origin", "*"),
    ("X-Content-Type-Options", "nosniff"),
    // The world is served from the binary, so a stale copy would only ever be one from an older build.
    ("Cache-Control", "no-store"),
];

fn with_headers(mut builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    for (name, value) in HEADERS {
        builder = builder.header(name, value);
    }
    builder
}

fn deny(status: StatusCode) -> Response<Vec<u8>> {
    with_headers(Response::builder())
        .status(status)
        .body(Vec::new())
        .expect("risposta statica")
}

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
        // A drive (`C:/…`), a stream (`file::$DATA`), or a scheme: an absolute path in every spelling.
        return Some("percorso assoluto");
    }
    if decoded.starts_with("//") {
        return Some("percorso assoluto");
    }
    if decoded.split('/').any(|part| part == "..") {
        return Some("percorso che risale (..)");
    }
    None
}

/// What a request path names.
enum Route {
    Package(&'static PackageFile),
    /// The path after `/assets/`, checked against the manifest later.
    Asset(String),
}

/// The package file or asset a request path names, or why it cannot be one.
fn resolve(raw_path: &str) -> Result<Route, StatusCode> {
    let decoded = urldecode(raw_path);
    if refused(&decoded).is_some() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let relative = decoded.trim_start_matches('/');
    if let Some(asset) = relative.strip_prefix(ASSETS_PREFIX) {
        return Ok(Route::Asset(asset.to_string()));
    }
    let wanted = if relative.is_empty() { INDEX } else { relative };
    PACKAGE
        .iter()
        .find(|file| file.path == wanted)
        .map(Route::Package)
        .ok_or(StatusCode::NOT_FOUND)
}

/// Answers one request for a file of the world: the package, or an asset from `source`.
pub fn respond(request: &Request<Vec<u8>>, source: &Source) -> Response<Vec<u8>> {
    respond_with(request, source, MANIFEST)
}

fn respond_with(request: &Request<Vec<u8>>, source: &Source, manifest: &[ManifestEntry]) -> Response<Vec<u8>> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return deny(StatusCode::METHOD_NOT_ALLOWED);
    }
    let route = match resolve(request.uri().path()) {
        Ok(route) => route,
        Err(status) => return deny(status),
    };
    let (mime, bytes): (&str, Cow<[u8]>) = match route {
        Route::Package(file) => (file.mime, Cow::Borrowed(file.body)),
        Route::Asset(relative) => match read_asset(source, manifest, &relative) {
            Ok((mime, bytes)) => (mime, Cow::Owned(bytes)),
            Err(status) => return deny(status),
        },
    };
    let length = bytes.len();
    let body = if request.method() == Method::HEAD { Vec::new() } else { bytes.into_owned() };
    with_headers(Response::builder())
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Content-Length", length.to_string())
        .body(body)
        .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(uri: &str) -> Response<Vec<u8>> {
        respond(&Request::builder().uri(uri).body(Vec::new()).expect("richiesta"), &Source::absent())
    }

    fn header<'a>(response: &'a Response<Vec<u8>>, name: &str) -> &'a str {
        response.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
    }

    #[test]
    fn serves_the_package_and_its_index_for_the_root() {
        for uri in ["nikverse://localhost/", "nikverse://localhost/index.html", "http://nikverse.localhost/"] {
            let response = get(uri);
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            assert!(header(&response, "content-type").starts_with("text/html"), "{uri}");
            assert!(String::from_utf8_lossy(response.body()).contains("<html"), "{uri}");
        }
        let script = get("nikverse://localhost/world.js");
        assert_eq!(script.status(), StatusCode::OK);
        assert!(header(&script, "content-type").starts_with("text/javascript"));
        assert_eq!(header(&get("nikverse://localhost/world.css"), "content-type"), "text/css; charset=utf-8");
    }

    #[test]
    fn every_answer_carries_the_policy_even_a_refusal() {
        for uri in ["nikverse://localhost/", "nikverse://localhost/nope.js", "nikverse://localhost/../Cargo.toml"] {
            let response = get(uri);
            assert_eq!(header(&response, "content-security-policy"), CSP, "{uri}");
            assert_eq!(header(&response, "x-content-type-options"), "nosniff", "{uri}");
        }
        for directive in [
            "default-src http://nikverse.localhost nikverse:",
            "script-src http://nikverse.localhost nikverse: 'wasm-unsafe-eval'",
            "connect-src http://nikverse.localhost nikverse:",
        ] {
            assert!(CSP.contains(directive), "manca {directive}");
        }
        let tokens: Vec<&str> = CSP.split(|c: char| c == ';' || c.is_whitespace()).collect();
        for banned in ["'unsafe-inline'", "'unsafe-eval'", "http:", "https:", "*"] {
            assert!(!tokens.contains(&banned), "la policy non deve avere {banned}");
        }
        let script = CSP.split(';').map(str::trim).find(|d| d.starts_with("script-src")).unwrap();
        assert!(!script.contains("data:") && !script.contains("blob:"), "script-src: {script}");
    }

    #[test]
    fn the_policy_names_the_host_because_the_frame_is_opaque_and_the_package_answers_cors() {
        // On an opaque origin `'self'` matches nothing: a policy that relied on it would load no script at all.
        assert!(!CSP.contains("'self'"), "{CSP}");
        // Public and static, so any origin may read it; nothing else is opened up.
        for uri in ["nikverse://localhost/", "nikverse://localhost/world.js", "nikverse://localhost/nope", "nikverse://localhost/../x"] {
            assert_eq!(header(&get(uri), "access-control-allow-origin"), "*", "{uri}");
        }
        // Not credentials: the world never carries any.
        assert_eq!(header(&get("nikverse://localhost/"), "access-control-allow-credentials"), "");
        // Both spellings of the scheme are allowed, and no other host.
        assert!(CSP.contains("http://nikverse.localhost") && CSP.contains(" nikverse:"));
        assert!(!CSP.contains("tauri") && !CSP.contains("ade-media"));
    }

    #[test]
    fn refuses_a_way_up_in_every_spelling() {
        for uri in [
            "nikverse://localhost/../Cargo.toml",
            "nikverse://localhost/%2e%2e/Cargo.toml",
            "nikverse://localhost/%2E%2E%2FCargo.toml",
            "nikverse://localhost/a/../../secret",
            "nikverse://localhost/..%5CCargo.toml",
        ] {
            assert_eq!(get(uri).status(), StatusCode::BAD_REQUEST, "{uri}");
        }
    }

    #[test]
    fn refuses_an_absolute_path_a_drive_and_a_stream() {
        for uri in [
            "nikverse://localhost//etc/passwd",
            "nikverse://localhost/C:/Windows/win.ini",
            "nikverse://localhost/C%3A%5CWindows%5Cwin.ini",
            "nikverse://localhost/%2FWindows/win.ini",
            "nikverse://localhost/index.html::$DATA",
            "nikverse://localhost/back%5Cslash",
            "nikverse://localhost/nul%00.js",
        ] {
            assert_eq!(get(uri).status(), StatusCode::BAD_REQUEST, "{uri}");
        }
    }

    #[test]
    fn serves_nothing_that_is_not_in_the_package_even_when_it_exists_on_disk() {
        // Files that are really there, next to this source, and one that exists nowhere.
        for uri in [
            "nikverse://localhost/Cargo.toml",
            "nikverse://localhost/src/lib.rs",
            "nikverse://localhost/src/nikverse.rs",
            "nikverse://localhost/world/index.html",
            "nikverse://localhost/missing.js",
            "nikverse://localhost/INDEX.HTML",
        ] {
            assert_eq!(get(uri).status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    #[test]
    fn only_reads_are_answered_and_head_has_no_body() {
        for method in [Method::POST, Method::PUT, Method::DELETE, Method::PATCH] {
            let request = Request::builder().method(method).uri("nikverse://localhost/").body(Vec::new()).unwrap();
            assert_eq!(respond(&request, &Source::absent()).status(), StatusCode::METHOD_NOT_ALLOWED);
        }
        let head = Request::builder().method(Method::HEAD).uri("nikverse://localhost/").body(Vec::new()).unwrap();
        let response = respond(&head, &Source::absent());
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().is_empty());
        assert!(header(&response, "content-length").parse::<usize>().unwrap() > 0);
    }

    #[test]
    fn the_world_page_holds_nothing_the_policy_would_block() {
        let page = String::from_utf8_lossy(get("nikverse://localhost/").body()).into_owned();
        assert!(!page.contains("<style"), "stile in linea: la policy lo blocca");
        assert!(!page.contains(" onclick=") && !page.contains(" onload="), "gestori in linea");
        assert!(!page.contains("http://") && !page.contains("https://"), "risorse remote");
        for script in page.split("<script").skip(1) {
            let tag = script.split('>').next().unwrap_or("");
            assert!(tag.contains("src="), "script in linea: {tag}");
        }
    }

    // ---- the assets ----

    /// A folder of its own under the temp dir, removed when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Scratch {
            static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("nikverse-test-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("cartella di prova");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// An entry as build.rs would write it for `bytes`.
    fn entry(path: &'static str, bytes: &[u8]) -> ManifestEntry {
        ManifestEntry {
            path,
            sha256: Box::leak(sha256_hex(bytes).into_boxed_str()),
            size: bytes.len() as u64,
        }
    }

    fn asset(source: &Source, manifest: &[ManifestEntry], uri: &str) -> Response<Vec<u8>> {
        respond_with(&Request::builder().uri(uri).body(Vec::new()).expect("richiesta"), source, manifest)
    }

    fn checked(root: &Path) -> Source {
        Source { root: Some(root.to_path_buf()), verify: true }
    }

    fn write(root: &Path, path: &str, bytes: &[u8]) {
        let file = root.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, bytes).unwrap();
    }

    #[test]
    fn serves_an_asset_the_manifest_names_with_its_type_and_the_policy() {
        let scratch = Scratch::new();
        write(&scratch.0, "sprites/a.svg", b"<svg/>");
        let manifest = [entry("sprites/a.svg", b"<svg/>")];
        let response = asset(&checked(&scratch.0), &manifest, "nikverse://localhost/assets/sprites/a.svg");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().as_slice(), b"<svg/>");
        assert_eq!(header(&response, "content-type"), "image/svg+xml");
        assert_eq!(header(&response, "content-length"), "6");
        assert_eq!(header(&response, "content-security-policy"), CSP);
        assert_eq!(header(&response, "access-control-allow-origin"), "*");
        let head = Request::builder().method(Method::HEAD).uri("http://nikverse.localhost/assets/sprites/a.svg").body(Vec::new()).unwrap();
        let head = respond_with(&head, &checked(&scratch.0), &manifest);
        assert_eq!((head.status(), head.body().is_empty(), header(&head, "content-length")), (StatusCode::OK, true, "6"));
    }

    #[test]
    fn a_file_on_disk_the_manifest_does_not_name_is_not_served() {
        let scratch = Scratch::new();
        write(&scratch.0, "listed.txt", b"a");
        write(&scratch.0, "added-after-the-build.txt", b"b");
        write(&scratch.0, "sub/hidden.txt", b"c");
        let manifest = [entry("listed.txt", b"a")];
        // `/listed.txt` (a double slash after `assets`) is not `listed.txt`: the list is compared, never normalised.
        for uri in ["added-after-the-build.txt", "sub/hidden.txt", "LISTED.txt", "listed.txt/", "", "sub", "/listed.txt"] {
            let response = asset(&checked(&scratch.0), &manifest, &format!("nikverse://localhost/assets/{uri}"));
            assert_eq!((uri, response.status()), (uri, StatusCode::NOT_FOUND));
        }
    }

    #[test]
    fn a_way_up_is_refused_before_the_manifest_is_looked_at() {
        let scratch = Scratch::new();
        write(&scratch.0, "a.txt", b"a");
        write(scratch.0.parent().unwrap(), "nikverse-outside.txt", b"secret");
        let manifest = [entry("a.txt", b"a")];
        for uri in [
            "nikverse://localhost/assets/../nikverse-outside.txt",
            "nikverse://localhost/assets/%2e%2e/nikverse-outside.txt",
            "nikverse://localhost/assets/sub/..%5Cx",
            "nikverse://localhost/assets/C:/Windows/win.ini",
            "nikverse://localhost/assets/a.txt::$DATA",
        ] {
            let response = asset(&checked(&scratch.0), &manifest, uri);
            assert_eq!((uri, response.status()), (uri, StatusCode::BAD_REQUEST));
        }
        let _ = std::fs::remove_file(scratch.0.parent().unwrap().join("nikverse-outside.txt"));
    }

    #[test]
    fn a_release_refuses_a_file_whose_bytes_or_size_are_not_the_ones_it_was_built_with() {
        let scratch = Scratch::new();
        let manifest = [entry("a.txt", b"the real bytes")];
        let uri = "nikverse://localhost/assets/a.txt";
        write(&scratch.0, "a.txt", b"the real bytes");
        assert_eq!(asset(&checked(&scratch.0), &manifest, uri).status(), StatusCode::OK);
        // Same length, other content: only the hash tells.
        write(&scratch.0, "a.txt", b"the fake bytes");
        assert_eq!(asset(&checked(&scratch.0), &manifest, uri).status(), StatusCode::INTERNAL_SERVER_ERROR);
        // Another length: refused by the size, before the file is read.
        write(&scratch.0, "a.txt", b"longer than the real bytes were");
        assert_eq!(asset(&checked(&scratch.0), &manifest, uri).status(), StatusCode::INTERNAL_SERVER_ERROR);
        // Gone: not found, not a crash.
        std::fs::remove_file(scratch.0.join("a.txt")).unwrap();
        assert_eq!(asset(&checked(&scratch.0), &manifest, uri).status(), StatusCode::NOT_FOUND);
        // A folder where the file should be is not a file that can be read.
        std::fs::create_dir(scratch.0.join("a.txt")).unwrap();
        assert_ne!(asset(&checked(&scratch.0), &manifest, uri).status(), StatusCode::OK);
    }

    #[test]
    fn a_debug_build_reads_the_sources_as_they_are_edited() {
        let scratch = Scratch::new();
        write(&scratch.0, "a.txt", b"edited just now");
        let manifest = [entry("a.txt", b"as built")];
        let debug = Source { root: Some(scratch.0.clone()), verify: false };
        let response = asset(&debug, &manifest, "nikverse://localhost/assets/a.txt");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().as_slice(), b"edited just now");
        // Still only what the list names.
        write(&scratch.0, "new.txt", b"n");
        assert_eq!(asset(&debug, &manifest, "nikverse://localhost/assets/new.txt").status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn where_the_assets_are_read_from_debug_the_sources_release_the_bundle() {
        let manifest_dir = Path::new("/src/ade/src-tauri");
        let resources = PathBuf::from("/opt/ade/resources");
        let debug = Source::choose(true, manifest_dir, Some(resources.clone()));
        assert_eq!((debug.root, debug.verify), (Some(manifest_dir.join(ASSETS_DIR)), false));
        let release = Source::choose(false, manifest_dir, Some(resources.clone()));
        assert_eq!((release.root, release.verify), (Some(resources.join(ASSETS_DIR)), true));
        // No resource folder to be found: nothing is served, and nothing is guessed instead.
        let lost = Source::choose(false, manifest_dir, None);
        assert_eq!((lost.root, lost.verify), (None, true));
        let manifest = [entry("a.txt", b"a")];
        assert_eq!(asset(&lost_source(), &manifest, "nikverse://localhost/assets/a.txt").status(), StatusCode::NOT_FOUND);
    }

    fn lost_source() -> Source {
        Source::choose(false, Path::new("."), None)
    }

    fn source_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join(ASSETS_DIR)
    }

    /// Every non-hidden file under `dir`, relative, with forward slashes.
    fn files_under(root: &Path, dir: &Path, into: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().unwrap().to_string_lossy().starts_with('.') {
                continue;
            }
            if path.is_dir() {
                files_under(root, &path, into);
            } else {
                let relative = path.strip_prefix(root).unwrap();
                into.push(relative.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"));
            }
        }
    }

    #[test]
    fn the_manifest_lists_exactly_the_files_of_the_folder_with_their_hash() {
        let mut on_disk = Vec::new();
        files_under(&source_dir(), &source_dir(), &mut on_disk);
        on_disk.sort();
        let listed: Vec<&str> = MANIFEST.iter().map(|entry| entry.path).collect();
        assert_eq!(listed, on_disk, "il manifesto di build.rs non elenca la cartella");
        assert!(!MANIFEST.is_empty(), "la cartella degli asset e vuota");
        for entry in MANIFEST {
            let bytes = std::fs::read(source_dir().join(entry.path)).unwrap();
            assert_eq!(sha256_hex(&bytes), entry.sha256, "{}", entry.path);
            assert_eq!(bytes.len() as u64, entry.size, "{}", entry.path);
            assert_ne!(asset_mime(entry.path), "application/octet-stream", "tipo mancante per {}", entry.path);
        }
    }

    #[test]
    fn the_release_finds_the_assets_where_the_bundle_puts_them() {
        // What `bundle.resources` says, read from the config the bundler reads.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let resources = config["bundle"]["resources"].as_object().expect("bundle.resources e una mappa");
        let (from, to) = resources
            .iter()
            .find(|(from, _)| from.trim_end_matches('/') == ASSETS_DIR)
            .expect("bundle.resources non porta la cartella degli asset");
        let to = to.as_str().expect("destinazione").trim_matches('/');
        assert_eq!(from.trim_end_matches('/'), ASSETS_DIR);
        // The runtime looks for the folder under the resources by the same name the bundler gives it.
        assert_eq!(to, ASSETS_DIR, "il bundle mette gli asset dove il codice non li cerca");

        // The bundler's layout: every file of the folder at `<resources>/<to>/<relative>`.
        let bundle = Scratch::new();
        for entry in MANIFEST {
            write(&bundle.0.join(to), entry.path, &std::fs::read(source_dir().join(entry.path)).unwrap());
        }
        let release = Source::choose(false, Path::new("/nowhere"), Some(bundle.0.clone()));
        for entry in MANIFEST {
            let response = respond(
                &Request::builder().uri(format!("nikverse://localhost/assets/{}", entry.path)).body(Vec::new()).unwrap(),
                &release,
            );
            assert_eq!((entry.path, response.status()), (entry.path, StatusCode::OK));
            assert_eq!(response.body().len() as u64, entry.size);
        }
    }
}
