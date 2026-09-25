/// The chat's calls to the nikcli server, made from here (C1).
///
/// The page could `fetch` the server itself in development, and only there:
/// Vite serves it from `http://localhost:1420`, which the server's CORS
/// accepts. A release is served from `tauri.localhost`, which it does not, so
/// every call failed before it left the WebView — the review's A3. Changing
/// the CORS of the user's shared service is not ADE's to do, and ADE's own
/// server has a password the page must not hold either.
///
/// So the page hands a request to `nikcli_serve_fetch` — a method, a path and
/// a body, never an address — and gets the answer back on a channel: first
/// the status and headers, then the body as it arrives, which is what makes
/// the server's event stream (SSE) work. The address and the credentials are
/// added here, and a path cannot point the request anywhere but the server.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use reqwest::{Client, Method, Url};
use tauri::Manager;
use tauri::ipc::Channel;

use crate::serve::Server;

/// A connection that takes longer than this is a server that is not there.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Headers the page does not get to set: credentials are added here, and the
/// rest describe the connection, which is this module's, not the page's.
const DROPPED_HEADERS: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "host",
    "content-length",
    "connection",
    "transfer-encoding",
    "te",
    "upgrade",
    "keep-alive",
    "origin",
    "referer",
];

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProxyRequest {
    pub method: String,
    /// The path and query, starting with `/`: never a whole address.
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// What arrives on the channel, in this order: one `head`, any number of
/// `chunk`s, then `end` — or `error` at any point, and nothing after it.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProxyEvent {
    Head { status: u16, headers: Vec<(String, String)> },
    Chunk { bytes: Vec<u8> },
    End,
    Error { message: String },
}

/// The requests in flight, so the page can abort one.
#[derive(Default)]
pub struct Requests {
    next: AtomicU64,
    running: Mutex<HashMap<u64, tauri::async_runtime::JoinHandle<()>>>,
}

impl Requests {
    fn lock(&self) -> MutexGuard<'_, HashMap<u64, tauri::async_runtime::JoinHandle<()>>> {
        match self.running.lock() {
            Ok(running) => running,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/// Installs the TLS provider reqwest insists on, once; the updater does the
/// same, and whichever comes first wins.
pub(crate) fn tls_ready() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// A client for loopback calls: no proxy — a system proxy would see the
/// password and the conversation — and no overall timeout, because an event
/// stream is meant to stay open.
fn client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            tls_ready();
            Client::builder()
                .no_proxy()
                .connect_timeout(CONNECT_TIMEOUT)
                .build()
                .map_err(|error| format!("client HTTP non disponibile: {error}"))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The same, with a deadline for the whole call: for probes, not streams.
pub(crate) fn client_with_timeout(timeout: Duration) -> Result<Client, String> {
    tls_ready();
    Client::builder()
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
        .map_err(|error| format!("client HTTP non disponibile: {error}"))
}

/// `path` on the server at `base`, or a refusal when it would lead anywhere
/// else: another host, another port, another scheme.
pub(crate) fn target(base: &str, path: &str) -> Result<Url, String> {
    if !path.starts_with('/') || path.starts_with("//") || path.contains('\\') {
        return Err(format!("percorso non valido per il server di nikcli: {path}"));
    }
    let base = Url::parse(base).map_err(|error| format!("indirizzo del server non valido: {error}"))?;
    let url = base
        .join(path)
        .map_err(|error| format!("percorso non valido per il server di nikcli: {error}"))?;
    let same = url.scheme() == base.scheme()
        && url.host_str() == base.host_str()
        && url.port_or_known_default() == base.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none();
    if !same {
        return Err(format!("percorso non valido per il server di nikcli: {path}"));
    }
    Ok(url)
}

/// What a rule of `FENCED` covers: every method, or all but reading.
#[derive(Clone, Copy)]
enum Methods {
    Any,
    Writes,
}

/// Parts of the server the chat has no business with (C1 review, BASSO 3).
///
/// The page is trusted, so this is not the boundary; it keeps a mistake from
/// reaching them, and the user's shared service most of all: starting nikcli's
/// own Discord or chat bots outside ADE's gateway, disposing the instance or
/// the whole server under other clients, changing the configuration, the
/// logins or the MCP servers, a terminal, a shell or a command outside a turn,
/// the TUI's remote control, writing files or applying changes from outside a
/// session. Taken from the server's routes (`packages/nikcli/src/server`).
///
/// A pattern is matched segment by segment: `*` is any one segment, `**` at
/// the end any rest, nothing included.
const FENCED: &[(Methods, &str)] = &[
    (Methods::Any, "/discord/**"),
    (Methods::Any, "/chatbot/**"),
    (Methods::Any, "/mobile/**"),
    (Methods::Any, "/global/dispose"),
    (Methods::Any, "/instance/dispose"),
    (Methods::Any, "/config/reload"),
    (Methods::Writes, "/config/**"),
    (Methods::Any, "/auth/**"),
    (Methods::Any, "/provider/*/auth/**"),
    (Methods::Any, "/provider/*/oauth/**"),
    (Methods::Writes, "/provider/*/api"),
    (Methods::Writes, "/connectors/**"),
    (Methods::Writes, "/mcp/**"),
    (Methods::Writes, "/account/**"),
    (Methods::Writes, "/user/**"),
    (Methods::Writes, "/profile/**"),
    (Methods::Writes, "/sync/**"),
    (Methods::Writes, "/project/*"),
    (Methods::Any, "/pty/**"),
    (Methods::Any, "/tui/**"),
    (Methods::Any, "/session/*/shell"),
    (Methods::Any, "/session/*/command"),
    (Methods::Writes, "/vcs/**"),
    (Methods::Writes, "/file/**"),
    (Methods::Writes, "/experimental/**"),
    (Methods::Writes, "/loop/**"),
    (Methods::Writes, "/mission/**"),
];

fn matches(pattern: &str, segments: &[&str]) -> bool {
    let pattern: Vec<&str> = pattern.split('/').filter(|part| !part.is_empty()).collect();
    for (index, part) in pattern.iter().enumerate() {
        if *part == "**" {
            return true;
        }
        match segments.get(index) {
            Some(segment) if *part == "*" || part == segment => {}
            _ => return false,
        }
    }
    segments.len() == pattern.len()
}

/// Why the chat may not call `url`, if it may not. Compared without case,
/// empty segments dropped, after `target` resolved any `..`; a path with a
/// `%` is refused outright, since nothing the chat calls needs one and a
/// decoding server could read it as another route.
pub(crate) fn fenced(method: &Method, url: &Url) -> Option<String> {
    let path = url.path().to_ascii_lowercase();
    if path.contains('%') {
        return Some(format!("percorso non consentito alla chat: {}", url.path()));
    }
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let reading = *method == Method::GET || *method == Method::HEAD;
    let hit = FENCED.iter().any(|(methods, pattern)| {
        let applies = match methods {
            Methods::Any => true,
            Methods::Writes => !reading,
        };
        applies && matches(pattern, &segments)
    });
    hit.then(|| format!("la chat non può chiamare {} {} sul server di nikcli", method, url.path()))
}

/// The methods the SDK uses, and nothing like `CONNECT` or `TRACE`.
pub(crate) fn method_of(name: &str) -> Result<Method, String> {
    match name.to_ascii_uppercase().as_str() {
        "GET" => Ok(Method::GET),
        "HEAD" => Ok(Method::HEAD),
        "POST" => Ok(Method::POST),
        "PUT" => Ok(Method::PUT),
        "PATCH" => Ok(Method::PATCH),
        "DELETE" => Ok(Method::DELETE),
        other => Err(format!("metodo non consentito verso il server di nikcli: {other}")),
    }
}

/// The page's headers, minus the ones it does not get to set.
pub(crate) fn forwarded(headers: Vec<(String, String)>) -> Vec<(String, String)> {
    headers
        .into_iter()
        .filter(|(name, _)| {
            let name = name.to_ascii_lowercase();
            !DROPPED_HEADERS.contains(&name.as_str()) && !name.starts_with("proxy-") && !name.starts_with("sec-")
        })
        .collect()
}

/// Makes the call and reports it to `sink`, which returns false once nobody
/// is listening. Returns true when the server could not be reached at all.
pub(crate) async fn relay(
    client: &Client,
    url: Url,
    method: Method,
    headers: Vec<(String, String)>,
    body: Option<String>,
    auth: Option<(String, String)>,
    mut sink: impl FnMut(ProxyEvent) -> bool,
) -> bool {
    let mut request = client.request(method, url);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    if let Some((user, password)) = auth {
        request = request.basic_auth(user, Some(password));
    }
    if let Some(body) = body {
        request = request.body(body);
    }

    let mut response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            sink(ProxyEvent::Error {
                message: format!("il server di nikcli non risponde: {error}"),
            });
            return error.is_connect();
        }
    };

    let headers = response
        .headers()
        .iter()
        .filter(|(name, _)| name.as_str() != "set-cookie")
        .filter_map(|(name, value)| Some((name.as_str().to_string(), value.to_str().ok()?.to_string())))
        .collect();
    if !sink(ProxyEvent::Head {
        status: response.status().as_u16(),
        headers,
    }) {
        return false;
    }

    loop {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                if !sink(ProxyEvent::Chunk { bytes: bytes.to_vec() }) {
                    return false;
                }
            }
            Ok(None) => {
                sink(ProxyEvent::End);
                return false;
            }
            Err(error) => {
                sink(ProxyEvent::Error {
                    message: format!("risposta del server di nikcli interrotta: {error}"),
                });
                return false;
            }
        }
    }
}

/// Sends one request to the nikcli server; the answer comes on `on_event`.
/// Returns the request's id, for `nikcli_serve_abort`.
#[tauri::command]
pub async fn nikcli_serve_fetch(
    app: tauri::AppHandle,
    request: ProxyRequest,
    on_event: Channel<ProxyEvent>,
) -> Result<u64, String> {
    let (base, auth, shared) = app
        .state::<Server>()
        .endpoint()
        .ok_or_else(|| "il server di nikcli non è avviato".to_string())?;
    let url = target(&base, &request.path)?;
    let method = method_of(&request.method)?;
    if let Some(refusal) = fenced(&method, &url) {
        return Err(refusal);
    }
    let headers = forwarded(request.headers);
    let body = request.body;
    let client = client()?.clone();

    let requests = app.state::<Requests>();
    let id = requests.next.fetch_add(1, Ordering::Relaxed) + 1;
    let task_app = app.clone();
    // Held while the task is spawned and recorded, so a task that ends at
    // once cannot remove its entry before it is there.
    let mut running = requests.lock();
    let handle = tauri::async_runtime::spawn(async move {
        let unreachable = relay(&client, url, method, headers, body, auth, |event| on_event.send(event).is_ok()).await;
        if unreachable && shared {
            task_app.state::<Server>().forget_shared(&base);
        }
        task_app.state::<Requests>().lock().remove(&id);
    });
    running.insert(id, handle);
    Ok(id)
}

/// Stops a request: the page aborted it, or stopped reading the stream.
#[tauri::command]
pub async fn nikcli_serve_abort(requests: tauri::State<'_, Requests>, id: u64) -> Result<(), String> {
    if let Some(handle) = requests.lock().remove(&id) {
        handle.abort();
    }
    Ok(())
}

/// A server for tests: answers each connection with the next response, its
/// parts written apart so a stream arrives in pieces, and reports each
/// request's head.
#[cfg(test)]
pub(crate) mod test_server {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc::{Receiver, channel};
    use std::time::Duration;

    pub(crate) fn serve(responses: Vec<Vec<Vec<u8>>>) -> (String, Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("porta di prova");
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            for parts in responses {
                let Ok((mut stream, _)) = listener.accept() else { return };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    head.push(byte[0]);
                }
                let _ = tx.send(String::from_utf8_lossy(&head).into_owned());
                for part in parts {
                    let _ = stream.write_all(&part);
                    let _ = stream.flush();
                    std::thread::sleep(Duration::from_millis(30));
                }
            }
        });
        (url, rx)
    }

    /// A complete response that closes its connection.
    pub(crate) fn plain(status: &str, body: &str) -> Vec<Vec<u8>> {
        vec![
            format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .into_bytes(),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::{plain, serve};
    use super::{ProxyEvent, fenced, forwarded, method_of, relay, target};
    use reqwest::Method;
    use std::time::Duration;

    fn run(
        url: &str,
        path: &str,
        headers: Vec<(String, String)>,
        auth: Option<(String, String)>,
    ) -> (bool, Vec<ProxyEvent>) {
        let client = super::client().unwrap().clone();
        let target = target(url, path).unwrap();
        let mut events = Vec::new();
        let unreachable = tauri::async_runtime::block_on(relay(
            &client,
            target,
            reqwest::Method::GET,
            forwarded(headers),
            None,
            auth,
            |event| {
                events.push(event);
                true
            },
        ));
        (unreachable, events)
    }

    #[test]
    fn a_path_cannot_lead_anywhere_but_the_server() {
        let base = "http://127.0.0.1:4096";
        assert_eq!(
            target(base, "/session?directory=x").unwrap().as_str(),
            "http://127.0.0.1:4096/session?directory=x"
        );
        for path in [
            "//evil.example/x",
            "http://evil.example/x",
            "https://127.0.0.1:4096/x",
            "session",
            "/\\evil.example",
            "",
        ] {
            assert!(target(base, path).is_err(), "accettato: {path}");
        }
    }

    #[test]
    fn the_chat_cannot_reach_the_servers_bots_disposal_config_or_shells() {
        let base = "http://127.0.0.1:4096";
        let refused = |method: Method, path: &str| fenced(&method, &target(base, path).unwrap()).is_some();
        for (method, path) in [
            (Method::POST, "/discord/start"),
            (Method::GET, "/discord"),
            (Method::POST, "/Discord/Start"),
            (Method::POST, "/chatbot/bots/aiuto/start"),
            (Method::POST, "/mobile/pty"),
            (Method::POST, "/global/dispose"),
            (Method::POST, "/instance/dispose"),
            (Method::POST, "/config/reload"),
            (Method::PATCH, "/config"),
            (Method::POST, "/config/mcp"),
            (Method::PUT, "/auth/openrouter"),
            (Method::DELETE, "/provider/openai/auth"),
            (Method::POST, "/provider/openai/oauth/authorize"),
            (Method::POST, "/mcp/github/connect"),
            (Method::POST, "/pty"),
            (Method::GET, "/pty/p1/connect"),
            (Method::POST, "/tui/submit-prompt"),
            (Method::POST, "/session/ses_1/shell"),
            (Method::POST, "/session/ses_1/command"),
            (Method::POST, "/session//ses_1/shell"),
            (Method::POST, "/session/ses_1/../ses_1/shell"),
            (Method::PUT, "/file/content"),
            (Method::POST, "/vcs/apply"),
            (Method::PATCH, "/project/p1"),
            (Method::POST, "/experimental/worktree"),
            (Method::POST, "/discord%2Fstart"),
            (Method::POST, "/session/ses_1/%73hell"),
        ] {
            assert!(refused(method.clone(), path), "consentito: {method} {path}");
        }
        // What a chat needs goes through.
        for (method, path) in [
            (Method::GET, "/global/health"),
            (Method::GET, "/global/event"),
            (Method::GET, "/event"),
            (Method::GET, "/config"),
            (Method::GET, "/provider"),
            (Method::GET, "/project/current"),
            (Method::GET, "/session?directory=x&roots=true"),
            (Method::POST, "/session"),
            (Method::GET, "/session/ses_1/message"),
            (Method::POST, "/session/ses_1/message"),
            (Method::POST, "/session/ses_1/prompt_async"),
            (Method::POST, "/session/ses_1/abort"),
            (Method::POST, "/permission/per_1/reply"),
            (Method::POST, "/question/q_1/reply"),
            (Method::GET, "/file?path=src/a.ts"),
            (Method::GET, "/mcp"),
        ] {
            assert!(!refused(method.clone(), path), "rifiutato: {method} {path}");
        }
    }

    #[test]
    fn only_the_methods_the_sdk_uses() {
        for name in ["GET", "post", "Put", "PATCH", "DELETE", "HEAD"] {
            assert!(method_of(name).is_ok(), "{name}");
        }
        for name in ["CONNECT", "TRACE", "OPTIONS", "FOO"] {
            assert!(method_of(name).is_err(), "{name}");
        }
    }

    #[test]
    fn the_page_cannot_set_credentials_or_connection_headers() {
        let kept = forwarded(vec![
            ("Authorization".into(), "Basic dG9rZW4=".into()),
            ("cookie".into(), "a=b".into()),
            ("Proxy-Authorization".into(), "x".into()),
            ("host".into(), "evil.example".into()),
            ("x-nikcli-directory".into(), "C:/p".into()),
            ("content-type".into(), "application/json".into()),
        ]);
        assert_eq!(
            kept,
            vec![
                ("x-nikcli-directory".to_string(), "C:/p".to_string()),
                ("content-type".to_string(), "application/json".to_string()),
            ]
        );
    }

    #[test]
    fn the_password_is_added_here_and_the_pages_own_is_dropped() {
        let (url, requests) = serve(vec![plain("200 OK", "{\"ok\":true}")]);
        let (_, events) = run(
            &url,
            "/provider",
            vec![("authorization".into(), "Basic ZmFsc286ZmFsc28=".into())],
            Some(("nikcli".into(), "finta".into())),
        );
        let head = requests.recv_timeout(Duration::from_secs(5)).unwrap().to_ascii_lowercase();
        assert!(head.starts_with("get /provider http/1.1"), "{head}");
        // "nikcli:finta", and only that one.
        assert!(head.contains("authorization: basic bmlry2xpomzpbnrh"), "{head}");
        assert_eq!(head.matches("authorization").count(), 1, "{head}");
        assert!(matches!(events.first(), Some(ProxyEvent::Head { status: 200, .. })));
        assert_eq!(events.last(), Some(&ProxyEvent::End));
    }

    #[test]
    fn an_event_stream_arrives_as_it_is_written() {
        let (url, _) = serve(vec![vec![
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n".to_vec(),
            b"b\r\ndata: uno\n\n\r\n".to_vec(),
            b"b\r\ndata: due\n\n\r\n".to_vec(),
            b"0\r\n\r\n".to_vec(),
        ]]);
        let (unreachable, events) = run(&url, "/global/event", Vec::new(), None);
        assert!(!unreachable);
        let Some(ProxyEvent::Head { status, headers }) = events.first() else {
            panic!("niente head: {events:?}")
        };
        assert_eq!(*status, 200);
        assert!(headers.contains(&("content-type".to_string(), "text/event-stream".to_string())));
        let chunks: Vec<&Vec<u8>> = events
            .iter()
            .filter_map(|event| match event {
                ProxyEvent::Chunk { bytes } => Some(bytes),
                _ => None,
            })
            .collect();
        // Two writes 30 ms apart: two chunks, not one body at the end.
        assert!(chunks.len() >= 2, "{events:?}");
        let text: Vec<u8> = chunks.into_iter().flatten().copied().collect();
        assert_eq!(String::from_utf8(text).unwrap(), "data: uno\n\ndata: due\n\n");
        assert_eq!(events.last(), Some(&ProxyEvent::End));
    }

    #[test]
    fn a_server_that_is_not_there_is_an_error_and_says_so() {
        // A port that was just free: nothing listens on it now.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let (unreachable, events) = run(&format!("http://127.0.0.1:{port}"), "/global/health", Vec::new(), None);
        assert!(unreachable);
        assert!(matches!(events.as_slice(), [ProxyEvent::Error { .. }]), "{events:?}");
    }

    #[test]
    fn a_listener_that_went_away_stops_the_relay() {
        let (url, _) = serve(vec![vec![
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n".to_vec(),
            b"b\r\ndata: uno\n\n\r\n".to_vec(),
            b"b\r\ndata: due\n\n\r\n".to_vec(),
            b"0\r\n\r\n".to_vec(),
        ]]);
        let client = super::client().unwrap().clone();
        let mut seen = 0;
        tauri::async_runtime::block_on(relay(
            &client,
            target(&url, "/global/event").unwrap(),
            reqwest::Method::GET,
            Vec::new(),
            None,
            None,
            |_| {
                seen += 1;
                false
            },
        ));
        assert_eq!(seen, 1);
    }
}
