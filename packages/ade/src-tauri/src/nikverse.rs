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
//! found" — and the day the package grows a folder read from disk, the rule
//! is already the one that guards it.
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

use tauri::http::{Method, Request, Response, StatusCode};

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

/// The package file a request path names, or why it cannot be one.
fn resolve(raw_path: &str) -> Result<&'static PackageFile, StatusCode> {
    let decoded = urldecode(raw_path);
    if refused(&decoded).is_some() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let relative = decoded.trim_start_matches('/');
    let wanted = if relative.is_empty() { INDEX } else { relative };
    PACKAGE
        .iter()
        .find(|file| file.path == wanted)
        .ok_or(StatusCode::NOT_FOUND)
}

/// Answers one request for a file of the world.
pub fn respond(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return deny(StatusCode::METHOD_NOT_ALLOWED);
    }
    let file = match resolve(request.uri().path()) {
        Ok(file) => file,
        Err(status) => return deny(status),
    };
    let body = if request.method() == Method::HEAD { Vec::new() } else { file.body.to_vec() };
    with_headers(Response::builder())
        .status(StatusCode::OK)
        .header("Content-Type", file.mime)
        .header("Content-Length", file.body.len().to_string())
        .body(body)
        .unwrap_or_else(|_| deny(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(uri: &str) -> Response<Vec<u8>> {
        respond(&Request::builder().uri(uri).body(Vec::new()).expect("richiesta"))
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
            assert_eq!(respond(&request).status(), StatusCode::METHOD_NOT_ALLOWED);
        }
        let head = Request::builder().method(Method::HEAD).uri("nikverse://localhost/").body(Vec::new()).unwrap();
        let response = respond(&head);
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
}
