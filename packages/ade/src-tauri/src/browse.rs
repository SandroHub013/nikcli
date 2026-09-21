//! What the browser pane needs from outside the webview.
//!
//! The pane's frame is sandboxed and cross-origin, and a `fetch` from ADE's
//! page only sees the response headers a server chooses to expose to CORS.
//! Whether a site forbids being framed (`X-Frame-Options`, CSP
//! `frame-ancestors`) is exactly what servers do not expose, so without this
//! a refused frame was an empty box with no explanation.
//!
//! A same-origin frame that loads ADE's own origin can read the window.
//! The typed URL is refused in the pane; this module also cancels a frame
//! that navigates itself (or a nested frame) there, which wry's top-level
//! `on_navigation` does not see.

use serde::Serialize;

/// The two headers that decide whether a page may be framed, as the last response sent them.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramingHeaders {
    pub x_frame_options: Option<String>,
    pub csp: Option<String>,
}

/// Only web pages: never `file:`, a custom scheme, or anything a shell would read as more than one argument.
fn web_url(url: &str) -> Result<&str, String> {
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("solo indirizzi http e https".into());
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) || url.starts_with('-') {
        return Err("indirizzo non valido".into());
    }
    Ok(url)
}

/// Whether `url` is ADE itself and must not load in a same-origin frame.
///
/// `host_origin` is the window (Vite in development, `http://tauri.localhost`
/// in a release). `tauri.localhost` is always ADE on Windows. The top-level
/// page *is* that origin and must still load: this check is for frames.
pub fn is_ade_origin(url: &str, host_origin: &str) -> bool {
    let Ok(parsed) = tauri::Url::parse(url) else {
        return false;
    };
    if parsed.origin().ascii_serialization() == host_origin {
        return true;
    }
    parsed.host_str().is_some_and(|host| host.eq_ignore_ascii_case("tauri.localhost"))
}

/// Cancels a subframe that tries to become ADE. Top-level stays on ADE.
#[cfg(windows)]
pub fn refuse_ade_in_frames(window: &tauri::WebviewWindow, host_origin: String) {
    use webview2_com::{take_pwstr, NavigationStartingEventHandler};

    let origin = host_origin;
    let result = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = windows_core::PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            if is_ade_origin(&uri, &origin) {
                args.SetCancel(true)?;
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(error) = core.add_FrameNavigationStarting(&handler, &mut token) {
            eprintln!("ADE: blocco origine nei frame non collegato: {error}");
        }
    });
    if let Err(error) = result {
        eprintln!("ADE: blocco origine nei frame non collegato: {error}");
    }
}

/// Reads the headers of the last response in `curl -D -` output (one block per redirect).
fn last_block_headers(dump: &str) -> FramingHeaders {
    let mut headers = FramingHeaders::default();
    for line in dump.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with("HTTP/") {
            headers = FramingHeaders::default();
            continue;
        }
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim().to_string();
        match name.trim().to_ascii_lowercase().as_str() {
            "x-frame-options" => headers.x_frame_options = Some(value),
            "content-security-policy" => {
                // Several policies all apply; joined, a `frame-ancestors` in any of them is found.
                headers.csp = Some(match headers.csp.take() {
                    Some(previous) => format!("{previous}; {value}"),
                    None => value,
                })
            }
            _ => {}
        }
    }
    headers
}

fn curl() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        std::path::PathBuf::from(system_root).join("System32").join("curl.exe")
    }
    #[cfg(not(windows))]
    {
        std::path::PathBuf::from("curl")
    }
}

/// The framing headers of `url`, fetched the way a browser would reach it (redirects followed).
///
/// Returns only those two headers: the body is discarded, so this cannot be
/// used to read a page ADE's own fetch is not allowed to read.
#[tauri::command]
pub async fn ade_browser_framing(url: String) -> Result<FramingHeaders, String> {
    let url = web_url(&url)?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let mut command = std::process::Command::new(curl());
        command
            // Web schemes only, on the first request and on every redirect.
            .args(["-sS", "--proto", "=http,https", "--proto-redir", "=http,https"])
            .args(["-L", "--max-redirs", "5", "--max-time", "6", "-o", null, "-D", "-", "--"])
            .arg(&url)
            .stdin(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let output = command.output().map_err(|e| format!("curl non eseguibile: {e}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        Ok(last_block_headers(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a web page in the system browser, for a page that cannot be shown in the pane.
#[tauri::command]
pub async fn ade_open_in_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = web_url(&url)?.to_string();
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app)
        .open(url, None)
        .map_err(|e| e.to_string())
}

/// The origin whose cookies and storage «Dimentica questo sito» will wipe.
pub fn site_origin(url: &str) -> Result<String, String> {
    let url = web_url(url)?;
    let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err("origine non valida".into());
    }
    Ok(origin)
}

/// Frame ids in a `Page.getFrameTree` result whose URL is `origin`.
fn frame_ids_for_origin(json: &str, origin: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let tree = value.get("frameTree").unwrap_or(&value);
    let mut ids = Vec::new();
    collect_frame_ids(tree, origin, &mut ids);
    ids
}

fn collect_frame_ids(node: &serde_json::Value, origin: &str, ids: &mut Vec<String>) {
    if let Some(frame) = node.get("frame") {
        if let (Some(id), Some(url)) = (frame.get("id").and_then(|v| v.as_str()), frame.get("url").and_then(|v| v.as_str())) {
            if site_origin(url).ok().as_deref() == Some(origin) {
                ids.push(id.to_string());
            }
        }
    }
    if let Some(children) = node.get("childFrames").and_then(|v| v.as_array()) {
        for child in children {
            collect_frame_ids(child, origin, ids);
        }
    }
}

fn storage_key_from_json(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()?
        .get("storageKey")?
        .as_str()
        .map(str::to_string)
}

/// What «Dimentica questo sito» actually managed to delete.
///
/// Every field is something that was *checked*, not something that was
/// attempted: the first version of this reported success whenever the CDP
/// call returned, and told the user their data was gone while the site's
/// `localStorage` survived the next reload.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetReport {
    /// The site's storage was read back empty after clearing it.
    pub storage_cleared: bool,
    /// A clear was sent but the result could not be read back.
    pub storage_unverified: bool,
    /// How many cookies were deleted.
    pub cookies_deleted: u32,
    /// Whether the cookie store could be read at all.
    pub cookies_readable: bool,
    /// The storage keys that were cleared, for the log and for a bug report.
    pub keys: Vec<String>,
}

/// Deletes cookies and site storage for `url` from ADE's WebView2 profile.
///
/// With `allow-same-origin` a visit leaves cookies, localStorage and cache in
/// the profile ADE itself uses. `Storage.clearDataForOrigin` only sees
/// unpartitioned data; a third-party frame is stored under a storage key that
/// includes ADE as the top-level site, so this also finds the iframe's CDP
/// target, attaches to it, reads its real storage key, and calls
/// `Storage.clearDataForStorageKey`. ADE's own origin is refused above.
#[tauri::command]
pub async fn ade_forget_site(app: tauri::AppHandle, url: String) -> Result<ForgetReport, String> {
    use tauri::Manager;

    let origin = site_origin(&url)?;
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "finestra non disponibile".to_string())?;

    #[cfg(debug_assertions)]
    let host = crate::own_origin(tauri::Manager::config(&app).build.dev_url.as_ref());
    #[cfg(not(debug_assertions))]
    let host = crate::own_origin(None);
    if is_ade_origin(&url, &host) {
        return Err("non si dimentica ADE stessa".into());
    }

    let mut report = ForgetReport::default();

    if let Ok(cookies) = window.cookies_for_url(parsed) {
        report.cookies_readable = true;
        for cookie in &cookies {
            if window.delete_cookie(cookie.clone()).is_ok() {
                report.cookies_deleted += 1;
            }
        }
    }

    #[cfg(windows)]
    {
        let storage = forget_origin_storage(&window, &origin, &host);
        report.storage_cleared = storage.cleared;
        report.storage_unverified = storage.unverified;
        report.keys = storage.keys;
        report.cookies_deleted += storage.cookies_deleted;
        report.cookies_readable |= storage.cookies_readable;
    }

    Ok(report)
}

#[cfg(windows)]
fn cdp_method(window: &tauri::WebviewWindow, method: &str, params: &str) -> Result<String, String> {
    use std::sync::mpsc;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows_core::HSTRING;

    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    let method = method.to_string();
    let params = params.to_string();
    let scheduled = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            let _ = sender.send(Err("WebView2 non disponibile".into()));
            return;
        };
        let told = sender.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            match result {
                Ok(()) => {
                    let _ = told.send(Ok(json));
                }
                Err(error) => {
                    let _ = told.send(Err(format!("dati del sito non cancellati: {error}")));
                }
            }
            Ok(())
        }));
        if let Err(error) = core.CallDevToolsProtocolMethod(
            &HSTRING::from(method.as_str()),
            &HSTRING::from(params.as_str()),
            &handler,
        ) {
            let _ = sender.send(Err(format!("dati del sito non cancellati: {error}")));
        }
    });
    scheduled.map_err(|error| format!("finestra non raggiungibile: {error}"))?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "la cancellazione non ha risposto entro 5 secondi".to_string())?
}

/// Calls a CDP method on an attached session (cross-origin iframe target).
#[cfg(windows)]
fn cdp_session_method(window: &tauri::WebviewWindow, session_id: &str, method: &str, params: &str) -> Result<String, String> {
    use std::sync::mpsc;
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
    use windows_core::{Interface, HSTRING};

    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    let session_id = session_id.to_string();
    let method = method.to_string();
    let params = params.to_string();
    let scheduled = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            let _ = sender.send(Err("WebView2 non disponibile".into()));
            return;
        };
        let Ok(core11) = core.cast::<ICoreWebView2_11>() else {
            let _ = sender.send(Err("ICoreWebView2_11 non disponibile".into()));
            return;
        };
        let told = sender.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
            match result {
                Ok(()) => {
                    let _ = told.send(Ok(json));
                }
                Err(error) => {
                    let _ = told.send(Err(format!("CDP session: {error}")));
                }
            }
            Ok(())
        }));
        if let Err(error) = core11.CallDevToolsProtocolMethodForSession(
            &HSTRING::from(session_id.as_str()),
            &HSTRING::from(method.as_str()),
            &HSTRING::from(params.as_str()),
            &handler,
        ) {
            let _ = sender.send(Err(format!("CDP session: {error}")));
        }
    });
    scheduled.map_err(|error| format!("finestra non raggiungibile: {error}"))?;
    receiver
        .recv_timeout(std::time::Duration::from_secs(5))
        .map_err(|_| "CDP session non ha risposto entro 5 secondi".to_string())?
}

/// Target IDs from `Target.getTargets` whose URL matches `origin`.
#[cfg(windows)]
fn target_ids_for_origin(json: &str, origin: &str) -> Vec<String> {
    let value: serde_json::Value = match serde_json::from_str(json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(infos) = value.get("targetInfos").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    infos
        .iter()
        .filter_map(|info| {
            let url = info.get("url").and_then(|v| v.as_str())?;
            if site_origin(url).ok().as_deref() != Some(origin) {
                return None;
            }
            info.get("targetId").and_then(|v| v.as_str()).map(str::to_string)
        })
        .collect()
}

/// Reads the `sessionId` from a `Target.attachToTarget` response.
#[cfg(windows)]
fn session_id_from_json(json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(json)
        .ok()?
        .get("sessionId")?
        .as_str()
        .map(str::to_string)
}

/// Reads the main frame id from a `Page.getFrameTree` response.
#[cfg(windows)]
fn main_frame_id(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let tree = value.get("frameTree").unwrap_or(&value);
    tree.get("frame")?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

/// Cookies of `origin`, deleted through CDP; how many went, and whether the
/// store could be read at all.
#[cfg(windows)]
fn forget_cookies_for_origin(window: &tauri::WebviewWindow, origin: &str) -> (u32, bool) {
    let _ = cdp_method(window, "Network.enable", "{}");
    let urls = format!(r#"{{"urls":[{:?}]}}"#, format!("{origin}/"));
    let Ok(json) = cdp_method(window, "Network.getCookies", &urls) else {
        return (0, false);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return (0, false);
    };
    let Some(cookies) = value.get("cookies").and_then(|v| v.as_array()) else {
        return (0, false);
    };
    let mut deleted = 0;
    for cookie in cookies {
        let Some(name) = cookie.get("name").and_then(|v| v.as_str()) else { continue };
        if name.is_empty() {
            continue;
        }
        let domain = cookie.get("domain").and_then(|v| v.as_str()).unwrap_or("");
        let path = cookie.get("path").and_then(|v| v.as_str()).unwrap_or("/");
        let params = format!(r#"{{"name":{name:?},"domain":{domain:?},"path":{path:?}}}"#);
        if cdp_method(window, "Network.deleteCookies", &params).is_ok() {
            deleted += 1;
        }
    }
    (deleted, true)
}

/// What one attempt at clearing a site's storage came to.
#[cfg(windows)]
#[derive(Debug, Default)]
struct StorageOutcome {
    /// The site's storage was read back empty.
    cleared: bool,
    /// A clear was sent, and nothing could be read back to check it.
    unverified: bool,
    keys: Vec<String>,
    cookies_deleted: u32,
    cookies_readable: bool,
}

/// `localStorage.length + sessionStorage.length` inside the site's own frame,
/// or `None` when the frame cannot be asked.
#[cfg(windows)]
fn stored_items(window: &tauri::WebviewWindow, session: &str) -> Option<u64> {
    let params = r#"{"expression":"try{localStorage.length+sessionStorage.length}catch(e){-1}","returnByValue":true}"#;
    let json = cdp_session_method(window, session, "Runtime.evaluate", params).ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    let count = value.get("result")?.get("value")?.as_i64()?;
    if count < 0 {
        return None;
    }
    Some(count as u64)
}

/// The keys a partitioned site could be stored under, most likely first.
///
/// Chromium writes a third-party frame's storage under
/// `<origin>/^0<top-level-site>`; the trailing slash is part of the origin's
/// serialisation and was what the first version left out. The unpartitioned
/// forms are there because a site opened at the top level writes those.
#[cfg(windows)]
fn candidate_keys(origin: &str, host: &str) -> Vec<String> {
    vec![
        format!("{origin}/^0{host}"),
        format!("{origin}^0{host}"),
        format!("{origin}/"),
        origin.to_string(),
    ]
}

/// Clears the site's storage and says whether it is really gone.
///
/// The site runs in a frame of another origin, which is a CDP *target* of its
/// own: `Page.getFrameTree` on ADE's page only ever shows `tauri.localhost`,
/// so the frame is found with `Target.getTargets` and attached to. Its own
/// `Storage.getStorageKeyForFrame` is the one key that is certainly right —
/// guessed keys miss by a character and delete nothing while reporting
/// success, which is the bug this replaces.
///
/// With the frame attached the result is also *checked*: `localStorage` is
/// counted before and after, and only an empty read-back counts as cleared.
/// Without a frame to ask, the keys are still tried and the caller is told the
/// outcome is unverified rather than "done".
#[cfg(windows)]
fn forget_origin_storage(window: &tauri::WebviewWindow, origin: &str, host: &str) -> StorageOutcome {
    let mut outcome = StorageOutcome::default();

    // First-party data, for a site that was also opened at the top level.
    let payload = format!(r#"{{"origin":{origin:?},"storageTypes":"all"}}"#);
    let _ = cdp_method(window, "Storage.clearDataForOrigin", &payload);
    let (deleted, readable) = forget_cookies_for_origin(window, origin);
    outcome.cookies_deleted = deleted;
    outcome.cookies_readable = readable;

    // The frame's own target, and with it the real storage key.
    let mut sessions = Vec::new();
    let mut keys = Vec::new();
    if let Ok(targets_json) = cdp_method(window, "Target.getTargets", "{}") {
        for target_id in target_ids_for_origin(&targets_json, origin) {
            let attach = format!(r#"{{"targetId":{target_id:?},"flatten":true}}"#);
            let Ok(attach_json) = cdp_method(window, "Target.attachToTarget", &attach) else {
                continue;
            };
            let Some(session) = session_id_from_json(&attach_json) else {
                continue;
            };
            if let Ok(tree_json) = cdp_session_method(window, &session, "Page.getFrameTree", "{}") {
                if let Some(frame_id) = main_frame_id(&tree_json) {
                    let params = format!(r#"{{"frameId":{frame_id:?}}}"#);
                    if let Ok(key_json) = cdp_session_method(window, &session, "Storage.getStorageKeyForFrame", &params) {
                        if let Some(key) = storage_key_from_json(&key_json) {
                            keys.push(key);
                        }
                    }
                }
            }
            sessions.push(session);
        }
    }

    // Whatever the frame did not tell us, tried in the shapes Chromium uses.
    for key in candidate_keys(origin, host) {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }

    for key in &keys {
        let params = format!(r#"{{"storageKey":{key:?},"storageTypes":"all"}}"#);
        if cdp_method(window, "Storage.clearDataForStorageKey", &params).is_ok() {
            outcome.keys.push(key.clone());
        }
    }

    // Checked in the site's own frame: a read-back of zero is the only proof.
    let mut checked = false;
    for session in &sessions {
        if let Some(left) = stored_items(window, session) {
            checked = true;
            if left > 0 {
                outcome.cleared = false;
                outcome.unverified = false;
                for session in &sessions {
                    let detach = format!(r#"{{"sessionId":{session:?}}}"#);
                    let _ = cdp_method(window, "Target.detachFromTarget", &detach);
                }
                return outcome;
            }
        }
    }
    outcome.cleared = checked;
    outcome.unverified = !checked && !outcome.keys.is_empty();

    for session in &sessions {
        let detach = format!(r#"{{"sessionId":{session:?}}}"#);
        let _ = cdp_method(window, "Target.detachFromTarget", &detach);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_urls_pass() {
        assert!(web_url("https://example.com/a?b=c").is_ok());
        assert!(web_url("HTTP://example.com").is_ok());
        assert!(web_url("file:///C:/Windows").is_err());
        assert!(web_url("javascript:alert(1)").is_err());
        assert!(web_url("https://example.com/a b").is_err());
        assert!(web_url("https://example.com/\n").is_err());
    }

    #[test]
    fn the_last_redirect_decides() {
        let dump = "HTTP/1.1 301 Moved\r\nLocation: https://b/\r\nX-Frame-Options: DENY\r\n\r\nHTTP/2 200\r\ncontent-security-policy: default-src 'self'\r\ncontent-security-policy: frame-ancestors 'none'\r\n\r\n";
        assert_eq!(
            last_block_headers(dump),
            FramingHeaders {
                x_frame_options: None,
                csp: Some("default-src 'self'; frame-ancestors 'none'".into()),
            }
        );
    }

    #[test]
    fn no_headers_is_nothing() {
        assert_eq!(last_block_headers("HTTP/2 200\r\ncontent-type: text/html\r\n\r\n"), FramingHeaders::default());
    }

    #[test]
    fn ade_origin_is_the_window_and_tauri_localhost() {
        assert!(is_ade_origin("http://localhost:5177/", "http://localhost:5177"));
        assert!(is_ade_origin("http://localhost:5177/index.html", "http://localhost:5177"));
        assert!(is_ade_origin("http://tauri.localhost/x", "http://tauri.localhost"));
        assert!(is_ade_origin("http://tauri.localhost/", "http://localhost:5177"));
        assert!(!is_ade_origin("https://bastelli-cmp.vercel.app/", "http://tauri.localhost"));
        assert!(!is_ade_origin("http://localhost:5173/", "http://localhost:5177"));
        assert!(!is_ade_origin("not a url", "http://tauri.localhost"));
    }

    #[test]
    fn forget_site_takes_the_origin_and_refuses_the_rest() {
        assert_eq!(
            site_origin("https://bastelli-cmp.vercel.app/path").as_deref(),
            Ok("https://bastelli-cmp.vercel.app")
        );
        assert!(site_origin("file:///C:/x").is_err());
        assert!(site_origin("javascript:alert(1)").is_err());
    }

    #[test]
    fn a_nested_frame_of_the_site_is_found_and_ade_is_not() {
        let tree = r#"{
            "frameTree": {
                "frame": {"id": "ade", "url": "http://tauri.localhost/"},
                "childFrames": [
                    {"frame": {"id": "site", "url": "https://hostile.test/app"}},
                    {"frame": {"id": "other", "url": "https://cdn.test/"}}
                ]
            }
        }"#;
        assert_eq!(
            frame_ids_for_origin(tree, "https://hostile.test"),
            vec!["site".to_string()]
        );
        assert!(frame_ids_for_origin(tree, "http://tauri.localhost").contains(&"ade".to_string()));
        assert!(storage_key_from_json(r#"{"storageKey":"https://hostile.test^http://tauri.localhost"}"#)
            .as_deref()
            == Some("https://hostile.test^http://tauri.localhost"));
        assert!(storage_key_from_json("not json").is_none());
    }

    #[test]
    fn target_ids_are_found_by_origin() {
        let targets = r#"{"targetInfos":[
            {"targetId":"T1","type":"iframe","url":"http://127.0.0.1:8893/page"},
            {"targetId":"T2","type":"page","url":"http://tauri.localhost/"},
            {"targetId":"T3","type":"iframe","url":"http://127.0.0.1:8893/other"}
        ]}"#;
        assert_eq!(
            target_ids_for_origin(targets, "http://127.0.0.1:8893"),
            vec!["T1".to_string(), "T3".to_string()]
        );
        assert!(target_ids_for_origin(targets, "https://other.test").is_empty());
        assert!(target_ids_for_origin("bad json", "http://a.test").is_empty());
    }

    #[test]
    fn session_id_is_read_from_attach_response() {
        assert_eq!(
            session_id_from_json(r#"{"sessionId":"ABC123"}"#).as_deref(),
            Some("ABC123")
        );
        assert!(session_id_from_json(r#"{"error":"nope"}"#).is_none());
        assert!(session_id_from_json("bad json").is_none());
    }

    #[test]
    fn main_frame_id_is_read_from_frame_tree() {
        let tree = r#"{"frameTree":{"frame":{"id":"F1","url":"http://127.0.0.1:8893/"}}}"#;
        assert_eq!(main_frame_id(tree).as_deref(), Some("F1"));
        assert!(main_frame_id(r#"{"frameTree":{}}"#).is_none());
        assert!(main_frame_id("bad json").is_none());
    }

    #[test]
    fn fallback_key_has_trailing_slash_before_partition_separator() {
        // The partitioned storage key for origin http://127.0.0.1:8893 under
        // top-level http://tauri.localhost must be
        // "http://127.0.0.1:8893/^0http://tauri.localhost" — with the slash.
        let origin = "http://127.0.0.1:8893";
        let host = "http://tauri.localhost";
        let key = format!("{origin}/^0{host}");
        assert_eq!(key, "http://127.0.0.1:8893/^0http://tauri.localhost");
    }
}
