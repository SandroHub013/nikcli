//! Streaming speech-to-text with xAI's Grok Voice Transcribe, held open by Rust.
//!
//! The page cannot do it: a browser WebSocket cannot send the `Authorization` header, and xAI says never to put the key in client code. So the
//! key stays in the system keychain (the key of the voice settings whose variable is `XAI_API_KEY`), is read here, and goes into one header. The
//! page asks for a session, hands it audio and hears events; it never sees the key, and no event carries any text but the transcript.
//!
//! One session is one segment of speech: opened when the segment starts, closed with `audio.done` when it ends. Rust keeps its own limits so a
//! page that forgets a session cannot leave a socket open: 3 s without audio, or 60 s in all, ends the audio on its own; at most two sessions at
//! once; every session ends at once when the app does.
//!
//! The protocol, as measured (`prove/grok-stt`): connect to `/v1/stt?model=…&sample_rate=16000&encoding=pcm&interim_results=true`, wait for
//! `transcript.created`, send PCM16 mono binary frames, send `{"type":"audio.done"}`, read `transcript.partial` (`is_final`, `speech_final`) and
//! then `transcript.done`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::{AppHandle, State};
use tokio::sync::{mpsc, Notify};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// The variable of the keychain entry that holds the xAI key.
pub const XAI_ENV: &str = "XAI_API_KEY";

const ENDPOINT: &str = "wss://api.x.ai/v1/stt";
const MODEL: &str = "grok-voice-transcribe-2.0";
const SAMPLE_RATE: u32 = 16_000;
/// PCM16 mono at 16 kHz.
const BYTES_PER_SECOND: f64 = 32_000.0;
const MAX_KEYTERMS: usize = 100;
const MAX_KEYTERM_CHARS: usize = 50;
const MAX_SESSIONS: usize = 2;
/// Frames waiting to be sent: 5 s at 100 ms each. A page that is further ahead than that is not keeping time.
const QUEUE_FRAMES: usize = 50;
const MAX_FRAME_BYTES: usize = 64 * 1024;

/// How long each wait lasts. The defaults are the product's; the tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// The connection, TLS and handshake included.
    pub connect: Duration,
    /// From the handshake to `transcript.created`.
    pub created: Duration,
    /// Without audio, with the socket open: the audio is ended.
    pub idle: Duration,
    /// From the opening: the audio is ended whatever is still coming.
    pub total: Duration,
    /// From `audio.done` to `transcript.done`.
    pub done: Duration,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            connect: Duration::from_secs(5),
            created: Duration::from_secs(5),
            idle: Duration::from_secs(3),
            total: Duration::from_secs(60),
            done: Duration::from_secs(5),
        }
    }
}

/// Why a session failed. The page decides what to do with each (fall back to the batch transcription, pause, tell the user).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    NoKey,
    Auth,
    Credit,
    Rate,
    Unavailable,
    Network,
    Timeout,
    Protocol,
    Backpressure,
    /// Two sessions are open already: a local limit, not the server's, so the page is not to pause the streaming for it.
    Busy,
}

impl Reason {
    fn code(self) -> &'static str {
        match self {
            Reason::NoKey => "no-key",
            Reason::Auth => "auth",
            Reason::Credit => "credit",
            Reason::Rate => "rate",
            Reason::Unavailable => "unavailable",
            Reason::Network => "network",
            Reason::Timeout => "timeout",
            Reason::Protocol => "protocol",
            Reason::Backpressure => "backpressure",
            Reason::Busy => "busy",
        }
    }
}

/// What the page hears. Nothing here is free text from a server or an error: the transcript is the only text, and the key is nowhere.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SttEvent {
    /// The server is ready: audio can flow (the page may already have queued some).
    Ready,
    Partial {
        text: String,
        #[serde(rename = "isFinal")]
        is_final: bool,
        #[serde(rename = "speechFinal")]
        speech_final: bool,
    },
    Done {
        text: String,
        #[serde(rename = "durationS")]
        duration_s: f64,
    },
    Failed {
        reason: Reason,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
    },
}

/// Where events go; false when nobody listens any more (the page reloaded), which ends the session.
pub type Emit = Arc<dyn Fn(SttEvent) -> bool + Send + Sync>;

enum Command {
    Audio(Vec<u8>),
    End,
}

struct Live {
    commands: mpsc::Sender<Command>,
    /// Woken when the page outran the queue, which the task cannot see by itself.
    kick: Arc<Notify>,
    overflow: Arc<AtomicBool>,
    /// Set before the task is stopped: an event being built at that moment is dropped, so nothing arrives after a cancel.
    cancelled: Arc<AtomicBool>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

type Registry = Arc<Mutex<HashMap<u64, Live>>>;

fn lock(registry: &Registry) -> MutexGuard<'_, HashMap<u64, Live>> {
    match registry.lock() {
        Ok(live) => live,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// The sessions open now.
#[derive(Default)]
pub struct Sessions {
    next: AtomicU64,
    live: Registry,
}

impl Sessions {
    /// Opens a session. The connection is made by a task; this returns at once with the id. With no key (`NoKey`), or two sessions already
    /// (`Busy`), nothing is opened: the reason comes back and `emit` hears it too, as a `failed` event.
    pub fn start(&self, key: Option<String>, url: String, limits: Limits, emit: Emit) -> Result<u64, Reason> {
        let Some(key) = key.filter(|key| !key.trim().is_empty()) else {
            emit(SttEvent::Failed { reason: Reason::NoKey, status: None });
            return Err(Reason::NoKey);
        };
        let mut live = lock(&self.live);
        if live.len() >= MAX_SESSIONS {
            drop(live);
            emit(SttEvent::Failed { reason: Reason::Busy, status: None });
            return Err(Reason::Busy);
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (commands, receiver) = mpsc::channel(QUEUE_FRAMES);
        let kick = Arc::new(Notify::new());
        let overflow = Arc::new(AtomicBool::new(false));
        let cancelled = Arc::new(AtomicBool::new(false));
        let guarded: Emit = {
            let cancelled = cancelled.clone();
            Arc::new(move |event| !cancelled.load(Ordering::SeqCst) && emit(event))
        };
        let registry = self.live.clone();
        let task = (kick.clone(), overflow.clone());
        // The entry goes in under the lock the task needs to take itself out, so a session that ends at once cannot leave before it is there.
        let handle = tauri::async_runtime::spawn(async move {
            run(url, key, receiver, task.0, task.1, guarded, limits).await;
            lock(&registry).remove(&id);
        });
        live.insert(id, Live { commands, kick, overflow, cancelled, handle });
        Ok(id)
    }

    /// Hands a frame of audio to a session. A page that is more than 5 s ahead of the socket ends the session with `backpressure`.
    pub fn send(&self, id: u64, frame: Vec<u8>) -> Result<(), String> {
        if frame.len() > MAX_FRAME_BYTES {
            return Err("frame troppo grande".into());
        }
        self.command(id, Command::Audio(frame))
    }

    /// Ends the audio: the session sends `audio.done` and answers with `done`.
    pub fn end(&self, id: u64) -> Result<(), String> {
        self.command(id, Command::End)
    }

    fn command(&self, id: u64, command: Command) -> Result<(), String> {
        let live = lock(&self.live);
        let session = live.get(&id).ok_or_else(|| "sessione chiusa o sconosciuta".to_string())?;
        match session.commands.try_send(command) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                session.overflow.store(true, Ordering::SeqCst);
                session.kick.notify_one();
                Err("backpressure".into())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err("sessione chiusa".into()),
        }
    }

    /// Closes a session now. After this returns it sends no event.
    pub fn cancel(&self, id: u64) {
        let session = lock(&self.live).remove(&id);
        if let Some(session) = session {
            session.cancelled.store(true, Ordering::SeqCst);
            session.handle.abort();
        }
    }

    /// Closes every session: the app is ending.
    pub fn close_all(&self) {
        let ids: Vec<u64> = lock(&self.live).keys().copied().collect();
        for id in ids {
            self.cancel(id);
        }
    }
}

/// Percent-encodes one query value: the unreserved characters stay, every other byte of the UTF-8 becomes `%XX`.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// A language code the server can read (`it`, `en`, `pt-BR`), or nothing: «auto», empty and anything else leave the choice to the server.
fn clean_language(language: &str) -> Option<&str> {
    let language = language.trim();
    let plain = !language.is_empty()
        && language.len() <= 10
        && language.chars().all(|c| c.is_ascii_alphabetic() || c == '-')
        && !language.eq_ignore_ascii_case("auto");
    plain.then_some(language)
}

/// The address of a session: the parameters of the measured protocol, the language when there is one, and the key terms (at most 100, each cut
/// at 50 characters, blanks dropped), one `keyterm` each.
pub fn build_url(base: &str, language: &str, keyterms: &[String]) -> String {
    let mut url = format!("{base}?model={MODEL}&sample_rate={SAMPLE_RATE}&encoding=pcm&interim_results=true");
    if let Some(language) = clean_language(language) {
        url.push_str(&format!("&language={}", encode(language)));
    }
    for term in keyterms.iter().map(|term| term.trim()).filter(|term| !term.is_empty()).take(MAX_KEYTERMS) {
        let term: String = term.chars().take(MAX_KEYTERM_CHARS).collect();
        url.push_str(&format!("&keyterm={}", encode(&term)));
    }
    url
}

/// `text` without `key`: every text that could reach a log or the page goes through this.
fn scrub(text: &str, key: &str) -> String {
    if key.is_empty() {
        text.to_string()
    } else {
        text.replace(key, "•••")
    }
}

/// What a refused handshake means. xAI's code for an empty account is not documented (402, or 403 with words about credit), so both read as
/// credit; 401 and any other 403 are the key.
fn classify_status(status: u16, body: &str) -> Reason {
    let body = body.to_ascii_lowercase();
    let about_credit = ["credit", "balance", "billing", "quota", "payment"].iter().any(|word| body.contains(word));
    match status {
        402 => Reason::Credit,
        403 if about_credit => Reason::Credit,
        401 | 403 => Reason::Auth,
        429 => Reason::Rate,
        500..=599 => Reason::Unavailable,
        _ => Reason::Protocol,
    }
}

fn classify(error: &WsError) -> (Reason, Option<u16>) {
    match error {
        WsError::Http(response) => {
            let status = response.status().as_u16();
            let body = response.body().as_deref().map(String::from_utf8_lossy).unwrap_or_default();
            (classify_status(status, &body), Some(status))
        }
        WsError::Io(_) | WsError::Tls(_) | WsError::ConnectionClosed | WsError::AlreadyClosed => (Reason::Network, None),
        _ => (Reason::Protocol, None),
    }
}

fn request_for(url: &str, key: &str) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, Reason> {
    let mut request = url.into_client_request().map_err(|_| Reason::Protocol)?;
    // A key that is not a legal header value cannot be a working key.
    let mut value = HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| Reason::Auth)?;
    value.set_sensitive(true);
    request.headers_mut().insert("Authorization", value);
    Ok(request)
}

fn message_type(value: &serde_json::Value) -> &str {
    value.get("type").and_then(|kind| kind.as_str()).unwrap_or("")
}

async fn audio_done<S: SinkExt<Message> + Unpin>(sink: &mut S) -> bool {
    sink.send(Message::Text(r#"{"type":"audio.done"}"#.into())).await.is_ok()
}

async fn hang_up<S: SinkExt<Message> + Unpin>(sink: &mut S) {
    // A polite close, not waited for long: the other side may be gone already.
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.send(Message::Close(None))).await;
}

/// One session, from the connection to `done` or a failure; everything it has to say goes to `emit`.
async fn run(
    url: String,
    key: String,
    mut commands: mpsc::Receiver<Command>,
    kick: Arc<Notify>,
    overflow: Arc<AtomicBool>,
    emit: Emit,
    limits: Limits,
) {
    crate::serve_proxy::tls_ready();
    let fail = |reason: Reason, status: Option<u16>| {
        emit(SttEvent::Failed { reason, status });
    };
    let request = match request_for(&url, &key) {
        Ok(request) => request,
        Err(reason) => return fail(reason, None),
    };
    let socket = match tokio::time::timeout(limits.connect, tokio_tungstenite::connect_async(request)).await {
        Err(_) => return fail(Reason::Timeout, None),
        Ok(Err(error)) => {
            let (reason, status) = classify(&error);
            return fail(reason, status);
        }
        Ok(Ok((socket, _handshake))) => socket,
    };
    let (mut sink, mut source) = socket.split();

    let opened = Instant::now();
    let mut ready = false;
    let mut ended = false;
    let mut sent_bytes: usize = 0;
    let created = tokio::time::sleep(limits.created);
    let idle = tokio::time::sleep(limits.idle);
    let total = tokio::time::sleep_until(opened + limits.total);
    let done = tokio::time::sleep(limits.done);
    tokio::pin!(created, idle, total, done);

    loop {
        tokio::select! {
            _ = kick.notified() => {
                if overflow.load(Ordering::SeqCst) {
                    fail(Reason::Backpressure, None);
                    hang_up(&mut sink).await;
                    return;
                }
            }
            incoming = source.next() => {
                let message = match incoming {
                    Some(Ok(message)) => message,
                    // The socket went: before the end it is a lost connection, after it the answer never came.
                    Some(Err(_)) | None => return fail(Reason::Network, None),
                };
                match message {
                    Message::Text(text) => {
                        let Ok(value) = serde_json::from_str::<serde_json::Value>(text.as_ref()) else { continue };
                        match message_type(&value) {
                            "transcript.created" if !ready => {
                                ready = true;
                                idle.as_mut().reset(Instant::now() + limits.idle);
                                if !emit(SttEvent::Ready) {
                                    return;
                                }
                            }
                            "transcript.partial" => {
                                let event = SttEvent::Partial {
                                    text: value.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                                    is_final: value.get("is_final").and_then(|f| f.as_bool()).unwrap_or(false),
                                    speech_final: value.get("speech_final").and_then(|f| f.as_bool()).unwrap_or(false),
                                };
                                if !emit(event) {
                                    return;
                                }
                            }
                            "transcript.done" => {
                                let reported = ["duration_s", "duration", "audio_duration"]
                                    .iter()
                                    .find_map(|name| value.get(*name).and_then(|d| d.as_f64()));
                                emit(SttEvent::Done {
                                    text: value.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                                    duration_s: reported.unwrap_or(sent_bytes as f64 / BYTES_PER_SECOND),
                                });
                                hang_up(&mut sink).await;
                                return;
                            }
                            "error" => {
                                fail(Reason::Protocol, None);
                                hang_up(&mut sink).await;
                                return;
                            }
                            _ => {}
                        }
                    }
                    Message::Ping(payload) => {
                        let _ = sink.send(Message::Pong(payload)).await;
                    }
                    Message::Close(_) => return fail(Reason::Network, None),
                    _ => {}
                }
            }
            // Nothing is read from the page before the server is ready: what it queued waits in order.
            command = commands.recv(), if ready => {
                match command {
                    // The audio has ended (the page said so, or a limit did): a late frame is read and dropped, so it cannot fill the queue and
                    // turn the wait for `done` into `backpressure`.
                    Some(_) if ended => {}
                    Some(Command::Audio(frame)) => {
                        sent_bytes += frame.len();
                        if sink.send(Message::Binary(frame)).await.is_err() {
                            return fail(Reason::Network, None);
                        }
                        idle.as_mut().reset(Instant::now() + limits.idle);
                    }
                    Some(Command::End) => {
                        if !audio_done(&mut sink).await {
                            return fail(Reason::Network, None);
                        }
                        ended = true;
                        done.as_mut().reset(Instant::now() + limits.done);
                    }
                    // The handle is gone: nobody will say more.
                    None => {
                        hang_up(&mut sink).await;
                        return;
                    }
                }
            }
            _ = &mut created, if !ready => return fail(Reason::Timeout, None),
            // The limits of Rust's own, whatever the page does: the audio ends, and the answer is waited for as after an `End`.
            _ = &mut idle, if ready && !ended => {
                if !audio_done(&mut sink).await {
                    return fail(Reason::Network, None);
                }
                ended = true;
                done.as_mut().reset(Instant::now() + limits.done);
            }
            _ = &mut total, if ready && !ended => {
                if !audio_done(&mut sink).await {
                    return fail(Reason::Network, None);
                }
                ended = true;
                done.as_mut().reset(Instant::now() + limits.done);
            }
            _ = &mut done, if ended => {
                fail(Reason::Timeout, None);
                hang_up(&mut sink).await;
                return;
            }
        }
    }
}

/// The audio of a `stt_stream_send` call and the session it is for: the raw body with the id in the `x-stt-id` header, or, as a fallback, a
/// JSON body `{ "id": n, "bytes": [..] }`.
fn frame_of(body: &InvokeBody, header: Option<&str>) -> Result<(u64, Vec<u8>), String> {
    match body {
        InvokeBody::Raw(bytes) => {
            let id = header.and_then(|id| id.trim().parse::<u64>().ok()).ok_or_else(|| "manca l'id della sessione".to_string())?;
            Ok((id, bytes.clone()))
        }
        InvokeBody::Json(value) => {
            let id = value.get("id").and_then(|id| id.as_u64()).ok_or_else(|| "manca l'id della sessione".to_string())?;
            let bytes = value
                .get("bytes")
                .and_then(|bytes| bytes.as_array())
                .ok_or_else(|| "mancano i byte dell'audio".to_string())?
                .iter()
                .map(|byte| byte.as_u64().and_then(|byte| u8::try_from(byte).ok()))
                .collect::<Option<Vec<u8>>>()
                .ok_or_else(|| "byte dell'audio non validi".to_string())?;
            Ok((id, bytes))
        }
    }
}

/// Opens a session for one segment of speech. `language` is a code or «auto»; `keyterms` are words the model should expect. Answers the
/// session's id; the events, from `ready` to `done` or `failed`, come on `on_event`. Without a key it answers `no-key` (and `on_event` hears
/// `failed`), and nothing touches the network.
#[tauri::command]
pub async fn stt_stream_open(
    app: AppHandle,
    sessions: State<'_, Sessions>,
    language: Option<String>,
    keyterms: Option<Vec<String>>,
    on_event: Channel<SttEvent>,
) -> Result<u64, String> {
    let key = crate::secrets::value_of_env(&app, XAI_ENV).map_err(|error| scrub(&error, ""))?;
    let url = build_url(ENDPOINT, language.as_deref().unwrap_or("auto"), &keyterms.unwrap_or_default());
    let emit: Emit = Arc::new(move |event| on_event.send(event).is_ok());
    sessions.start(key, url, Limits::default(), emit).map_err(|reason| reason.code().to_string())
}

/// One frame of PCM16 mono at 16 kHz, about 100 ms. The body is the bytes themselves and the header `x-stt-id` the session.
#[tauri::command]
pub fn stt_stream_send(request: Request<'_>, sessions: State<'_, Sessions>) -> Result<(), String> {
    let header = request.headers().get("x-stt-id").and_then(|value| value.to_str().ok());
    let (id, frame) = frame_of(request.body(), header)?;
    if frame.is_empty() {
        return Ok(());
    }
    sessions.send(id, frame)
}

/// The segment is over: the audio ends, and `done` follows.
#[tauri::command]
pub fn stt_stream_end(sessions: State<'_, Sessions>, id: u64) -> Result<(), String> {
    sessions.end(id)
}

/// The segment is dropped: the socket closes and no event follows.
#[tauri::command]
pub fn stt_stream_cancel(sessions: State<'_, Sessions>, id: u64) {
    sessions.cancel(id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request as HandshakeRequest, Response as HandshakeResponse};
    use tokio_tungstenite::tungstenite::http;

    const KEY: &str = "xai-test-key-0123456789-SECRET";

    /// What the fake server saw.
    #[derive(Default)]
    struct Seen {
        /// The address asked for, and the Authorization header, of each handshake.
        handshakes: Vec<(String, Option<String>)>,
        frames: Vec<Vec<u8>>,
        texts: Vec<String>,
        /// A frame that came before `transcript.created` was sent.
        early_frame: bool,
        /// Connections that ended.
        closed: usize,
    }

    /// What the fake server does.
    #[derive(Clone, Default)]
    struct Script {
        /// Refuse the handshake with this status and body.
        reject: Option<(u16, &'static str)>,
        /// Send `transcript.created` after this long; never when `None`.
        created_after: Option<Duration>,
        /// What to send on `audio.done`, after `done_delay`: these partials, then `done` with this text; no `done` when `None`.
        done_delay: Duration,
        partials: Vec<(&'static str, bool, bool)>,
        done_text: Option<&'static str>,
        /// Send an `error` message after this many frames, with this text.
        error_after: Option<(usize, String)>,
        /// Send a partial every 30 ms once ready.
        chatty: bool,
    }

    impl Script {
        fn talking() -> Script {
            Script {
                created_after: Some(Duration::ZERO),
                partials: vec![("ciao", false, false), ("ciao a tutti", true, true)],
                done_text: Some("ciao a tutti"),
                ..Script::default()
            }
        }
    }

    async fn serve(script: Script) -> (u16, Arc<Mutex<Seen>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Seen::default()));
        let shared = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                tokio::spawn(connection(stream, script.clone(), shared.clone()));
            }
        });
        (port, seen)
    }

    async fn connection(stream: tokio::net::TcpStream, script: Script, seen: Arc<Mutex<Seen>>) {
        let recorded = seen.clone();
        let reject = script.reject;
        let callback = move |request: &HandshakeRequest, response: HandshakeResponse| {
            let auth = request.headers().get("authorization").and_then(|value| value.to_str().ok()).map(String::from);
            recorded.lock().unwrap().handshakes.push((request.uri().to_string(), auth));
            match reject {
                Some((status, body)) => Err(http::Response::builder().status(status).body(Some(body.to_string())).unwrap()),
                None => Ok(response),
            }
        };
        let Ok(socket) = tokio_tungstenite::accept_hdr_async(stream, callback).await else { return };
        let (mut sink, mut source) = socket.split();
        let Some(delay) = script.created_after else {
            // Handshaken and silent: read until the client leaves.
            while let Some(Ok(_)) = source.next().await {}
            seen.lock().unwrap().closed += 1;
            return;
        };
        tokio::time::sleep(delay).await;
        // A client that sends before `created` would have a frame waiting by now.
        if let Ok(Some(Ok(_))) = tokio::time::timeout(Duration::from_millis(40), source.next()).await {
            seen.lock().unwrap().early_frame = true;
        }
        let _ = sink.send(Message::Text(r#"{"type":"transcript.created"}"#.into())).await;
        let mut frames = 0;
        let mut tick = tokio::time::interval(Duration::from_millis(30));
        loop {
            tokio::select! {
                incoming = source.next() => match incoming {
                    Some(Ok(Message::Binary(frame))) => {
                        seen.lock().unwrap().frames.push(frame);
                        frames += 1;
                        if let Some((after, text)) = &script.error_after {
                            if frames == *after {
                                let error = serde_json::json!({ "type": "error", "message": text });
                                let _ = sink.send(Message::Text(error.to_string().into())).await;
                            }
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        seen.lock().unwrap().texts.push(text.to_string());
                        if text.contains("audio.done") {
                            tokio::time::sleep(script.done_delay).await;
                            for (partial, is_final, speech_final) in &script.partials {
                                let message = serde_json::json!({ "type": "transcript.partial", "text": partial, "is_final": is_final, "speech_final": speech_final });
                                let _ = sink.send(Message::Text(message.to_string().into())).await;
                            }
                            if let Some(done) = script.done_text {
                                let message = serde_json::json!({ "type": "transcript.done", "text": done });
                                let _ = sink.send(Message::Text(message.to_string().into())).await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        seen.lock().unwrap().closed += 1;
                        return;
                    }
                    Some(Ok(_)) => {}
                },
                _ = tick.tick(), if script.chatty => {
                    let message = serde_json::json!({ "type": "transcript.partial", "text": "blah", "is_final": false, "speech_final": false });
                    let _ = sink.send(Message::Text(message.to_string().into())).await;
                }
            }
        }
    }

    /// The events a session sent, collected.
    #[derive(Clone, Default)]
    struct Events(Arc<Mutex<Vec<SttEvent>>>);

    impl Events {
        fn emit(&self) -> Emit {
            let events = self.0.clone();
            Arc::new(move |event| {
                events.lock().unwrap().push(event);
                true
            })
        }

        fn all(&self) -> Vec<SttEvent> {
            self.0.lock().unwrap().clone()
        }

        async fn until(&self, what: &str, done: impl Fn(&[SttEvent]) -> bool) -> Vec<SttEvent> {
            for _ in 0..300 {
                let events = self.all();
                if done(&events) {
                    return events;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("never saw {what}; events: {:?}", self.all());
        }
    }

    fn quick() -> Limits {
        Limits {
            connect: Duration::from_millis(600),
            created: Duration::from_millis(600),
            idle: Duration::from_millis(300),
            total: Duration::from_secs(10),
            done: Duration::from_millis(600),
        }
    }

    fn url(port: u16) -> String {
        build_url(&format!("ws://127.0.0.1:{port}/v1/stt"), "auto", &[])
    }

    fn open(sessions: &Sessions, port: u16, events: &Events, limits: Limits) -> u64 {
        sessions.start(Some(KEY.into()), url(port), limits, events.emit()).expect("a session")
    }

    fn frame(marker: u8) -> Vec<u8> {
        vec![marker; 3200]
    }

    fn failed(events: &[SttEvent]) -> Option<(Reason, Option<u16>)> {
        events.iter().find_map(|event| match event {
            SttEvent::Failed { reason, status } => Some((*reason, *status)),
            _ => None,
        })
    }

    fn has_failed(events: &[SttEvent]) -> bool {
        failed(events).is_some()
    }

    /// No event, in the JSON the page gets, holds the key.
    fn assert_key_not_in(events: &[SttEvent]) {
        let json = serde_json::to_string(events).unwrap();
        assert!(!json.contains(KEY), "the key is in the events: {json}");
        assert!(!json.contains("SECRET"), "part of the key is in the events: {json}");
    }

    #[tokio::test]
    async fn the_key_goes_in_the_header_and_the_query_is_the_measured_protocol() {
        let (port, seen) = serve(Script::talking()).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let terms = vec!["Nikcli".to_string(), "  ".to_string(), "à&b c".to_string()];
        let address = build_url(&format!("ws://127.0.0.1:{port}/v1/stt"), "auto", &terms);
        sessions.start(Some(KEY.into()), address, quick(), events.emit()).unwrap();
        events.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        let handshakes = seen.lock().unwrap().handshakes.clone();
        assert_eq!(handshakes.len(), 1);
        let (uri, auth) = &handshakes[0];
        assert_eq!(auth.as_deref(), Some(format!("Bearer {KEY}").as_str()));
        assert!(uri.starts_with("/v1/stt?model=grok-voice-transcribe-2.0&sample_rate=16000&encoding=pcm&interim_results=true"), "{uri}");
        // «auto» leaves the language out; a blank term is dropped; the others are repeated and encoded.
        assert!(!uri.contains("language="), "{uri}");
        assert!(uri.ends_with("&keyterm=Nikcli&keyterm=%C3%A0%26b%20c"), "{uri}");
        sessions.close_all();
        assert_key_not_in(&events.all());
    }

    #[test]
    fn the_address_has_a_language_only_when_it_is_one_and_bounded_key_terms() {
        let base = "wss://api.x.ai/v1/stt";
        assert!(build_url(base, "it", &[]).ends_with("&language=it"));
        assert!(build_url(base, "pt-BR", &[]).ends_with("&language=pt-BR"));
        for not_a_language in ["", "  ", "auto", "AUTO", "it&x=1", "it/../x", "averyveryverylongone"] {
            assert!(!build_url(base, not_a_language, &[]).contains("language"), "{not_a_language}");
        }
        let many: Vec<String> = (0..150).map(|n| format!("term{n}")).collect();
        assert_eq!(build_url(base, "auto", &many).matches("&keyterm=").count(), 100);
        let long = vec!["x".repeat(80)];
        assert!(build_url(base, "auto", &long).ends_with(&format!("&keyterm={}", "x".repeat(50))));
        // Multi-byte characters are cut by character, not in the middle of one.
        let accents = vec!["è".repeat(60)];
        let url = build_url(base, "auto", &accents);
        assert_eq!(url.matches("%C3%A8").count(), 50);
    }

    #[tokio::test]
    async fn nothing_is_sent_before_created_and_what_was_queued_goes_in_order() {
        let script = Script { created_after: Some(Duration::from_millis(250)), ..Script::talking() };
        let (port, seen) = serve(script).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let id = open(&sessions, port, &events, quick());
        // The page does not wait for `ready`: it sends the pre-roll and the first frames at once.
        for marker in [1, 2, 3] {
            sessions.send(id, frame(marker)).unwrap();
        }
        events.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        sessions.send(id, frame(4)).unwrap();
        sessions.end(id).unwrap();
        events.until("done", |e| e.iter().any(|event| matches!(event, SttEvent::Done { .. }))).await;
        let seen = seen.lock().unwrap();
        assert!(!seen.early_frame, "a frame reached the server before created");
        let markers: Vec<u8> = seen.frames.iter().map(|frame| frame[0]).collect();
        assert_eq!(markers, vec![1, 2, 3, 4]);
        assert_eq!(seen.texts, vec![r#"{"type":"audio.done"}"#.to_string()]);
    }

    #[tokio::test]
    async fn audio_done_brings_the_partials_and_then_done_with_the_text() {
        let (port, _seen) = serve(Script::talking()).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let id = open(&sessions, port, &events, quick());
        events.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        sessions.send(id, frame(7)).unwrap();
        sessions.send(id, frame(7)).unwrap();
        sessions.end(id).unwrap();
        let events = events.until("done", |e| e.iter().any(|event| matches!(event, SttEvent::Done { .. }))).await;
        assert_eq!(
            events,
            vec![
                SttEvent::Ready,
                SttEvent::Partial { text: "ciao".into(), is_final: false, speech_final: false },
                SttEvent::Partial { text: "ciao a tutti".into(), is_final: true, speech_final: true },
                // The server did not say how long: it is what was sent, 6400 bytes of PCM16 at 16 kHz.
                SttEvent::Done { text: "ciao a tutti".into(), duration_s: 0.2 },
            ]
        );
        assert_key_not_in(&events);
        // The session is over: it left the registry, and frames for it are refused.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(sessions.send(id, frame(1)).is_err());
    }

    #[test]
    fn the_events_are_what_the_page_reads() {
        let json = |event: SttEvent| serde_json::to_string(&event).unwrap();
        assert_eq!(json(SttEvent::Ready), r#"{"kind":"ready"}"#);
        assert_eq!(
            json(SttEvent::Partial { text: "a".into(), is_final: true, speech_final: false }),
            r#"{"kind":"partial","text":"a","isFinal":true,"speechFinal":false}"#
        );
        assert_eq!(json(SttEvent::Done { text: "a".into(), duration_s: 1.5 }), r#"{"kind":"done","text":"a","durationS":1.5}"#);
        assert_eq!(json(SttEvent::Failed { reason: Reason::NoKey, status: None }), r#"{"kind":"failed","reason":"noKey"}"#);
        assert_eq!(
            json(SttEvent::Failed { reason: Reason::Auth, status: Some(401) }),
            r#"{"kind":"failed","reason":"auth","status":401}"#
        );
    }

    #[tokio::test]
    async fn a_refused_handshake_says_why() {
        for (status, body, reason) in [
            (401, "", Reason::Auth),
            (403, "forbidden", Reason::Auth),
            (402, "", Reason::Credit),
            (403, "Your team has no credits left", Reason::Credit),
            (429, "", Reason::Rate),
            (503, "", Reason::Unavailable),
            (500, "", Reason::Unavailable),
            (400, "bad parameter", Reason::Protocol),
        ] {
            let (port, _seen) = serve(Script { reject: Some((status, body)), ..Script::default() }).await;
            let sessions = Sessions::default();
            let events = Events::default();
            open(&sessions, port, &events, quick());
            let events = events.until("a failure", has_failed).await;
            assert_eq!(failed(&events), Some((reason, Some(status))), "{status} {body}");
            assert_eq!(events.len(), 1);
            assert_key_not_in(&events);
        }
    }

    #[tokio::test]
    async fn a_server_that_cannot_be_reached_or_is_silent_is_network_or_timeout() {
        // Nobody listens.
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            listener.local_addr().unwrap().port()
        };
        let sessions = Sessions::default();
        let events = Events::default();
        // Windows takes a second or two to report a refused connection, so the connection gets longer here than the other waits.
        open(&sessions, port, &events, Limits { connect: Duration::from_secs(8), ..quick() });
        for _ in 0..1000 {
            if has_failed(&events.all()) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(failed(&events.all()), Some((Reason::Network, None)));

        // The handshake is made, and `created` never comes.
        let (port, seen) = serve(Script::default()).await;
        let events = Events::default();
        open(&sessions, port, &events, quick());
        assert_eq!(failed(&events.until("a failure", has_failed).await), Some((Reason::Timeout, None)));
        // The session's socket is gone with it.
        for _ in 0..100 {
            if seen.lock().unwrap().closed == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(seen.lock().unwrap().closed, 1);

        // Created, audio ended, and `done` never comes.
        let (port, _seen) = serve(Script { done_text: None, ..Script::talking() }).await;
        let events = Events::default();
        let id = open(&sessions, port, &events, quick());
        events.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        sessions.end(id).unwrap();
        let all = events.until("a failure", |e| e.iter().any(|event| matches!(event, SttEvent::Failed { .. }))).await;
        assert_eq!(failed(&all), Some((Reason::Timeout, None)));
    }

    #[tokio::test]
    async fn an_error_from_the_server_ends_the_session_as_protocol_and_the_socket_closes() {
        let script = Script { error_after: Some((2, format!("bad request for {KEY}"))), ..Script::talking() };
        let (port, seen) = serve(script).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let id = open(&sessions, port, &events, quick());
        events.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        sessions.send(id, frame(1)).unwrap();
        sessions.send(id, frame(2)).unwrap();
        let all = events.until("a failure", has_failed).await;
        assert_eq!(failed(&all), Some((Reason::Protocol, None)));
        // A server that echoes the key in its error does not carry it to the page: a failure has no text.
        assert_key_not_in(&all);
        for _ in 0..100 {
            if seen.lock().unwrap().closed == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(seen.lock().unwrap().closed, 1);
    }

    #[tokio::test]
    async fn without_a_key_nothing_is_opened() {
        let (port, seen) = serve(Script::talking()).await;
        let sessions = Sessions::default();
        let events = Events::default();
        for key in [None, Some("".to_string()), Some("   ".to_string())] {
            assert_eq!(sessions.start(key, url(port), quick(), events.emit()), Err(Reason::NoKey));
        }
        assert_eq!(events.all().len(), 3);
        assert!(events.all().iter().all(|event| *event == SttEvent::Failed { reason: Reason::NoKey, status: None }));
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(seen.lock().unwrap().handshakes.is_empty(), "the server was reached");
        assert!(lock(&sessions.live).is_empty());
    }

    #[tokio::test]
    async fn after_a_cancel_no_event_arrives_and_the_socket_closes() {
        let (port, seen) = serve(Script { chatty: true, ..Script::talking() }).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let id = open(&sessions, port, &events, quick());
        events.until("a partial", |e| e.iter().any(|event| matches!(event, SttEvent::Partial { .. }))).await;
        sessions.cancel(id);
        let at_cancel = events.all().len();
        // The server keeps talking every 30 ms; nothing of it gets to the page.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(events.all().len(), at_cancel);
        for _ in 0..100 {
            if seen.lock().unwrap().closed == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(seen.lock().unwrap().closed, 1, "the socket stayed open");
        assert!(sessions.send(id, frame(1)).is_err());
        assert!(lock(&sessions.live).is_empty());
    }

    #[tokio::test]
    async fn without_audio_for_a_while_rust_ends_the_audio_itself() {
        let (port, seen) = serve(Script::talking()).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let id = open(&sessions, port, &events, quick());
        events.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        sessions.send(id, frame(1)).unwrap();
        // The page goes quiet and says nothing: `idle` (300 ms here, 3 s in the product) closes the audio.
        let all = events.until("done", |e| e.iter().any(|event| matches!(event, SttEvent::Done { .. }))).await;
        assert!(matches!(all.last(), Some(SttEvent::Done { .. })));
        assert_eq!(seen.lock().unwrap().texts, vec![r#"{"type":"audio.done"}"#.to_string()]);
    }

    #[tokio::test]
    async fn frames_sent_after_the_audio_ended_do_not_turn_the_wait_for_done_into_backpressure() {
        // The server takes 3 s to answer `audio.done` (the sleeps below last longer than they say on Windows); the idle limit ends the audio after 100 ms, and the page, which did not notice, goes
        // on sending: 80 frames, more than the queue holds.
        let (port, _seen) = serve(Script { done_delay: Duration::from_secs(3), ..Script::talking() }).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let limits = Limits { idle: Duration::from_millis(100), done: Duration::from_secs(5), ..quick() };
        let id = open(&sessions, port, &events, limits);
        events.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        sessions.send(id, frame(1)).unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        for _ in 0..80 {
            // An error here would be the queue filling up.
            assert_eq!(sessions.send(id, frame(2)), Ok(()));
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let all = events.until("done", |e| e.iter().any(|event| matches!(event, SttEvent::Done { .. })) || has_failed(e)).await;
        assert!(matches!(all.last(), Some(SttEvent::Done { .. })), "{all:?}");
        assert_eq!(failed(&all), None);
    }

    #[tokio::test]
    async fn a_session_that_never_stops_is_ended_at_the_total_limit() {
        let (port, seen) = serve(Script::talking()).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let limits = Limits { total: Duration::from_millis(400), idle: Duration::from_secs(5), ..quick() };
        let id = open(&sessions, port, &events, limits);
        events.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        // Audio keeps coming, so the idle limit never fires; the total one does.
        for _ in 0..40 {
            if sessions.send(id, frame(1)).is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        events.until("done", |e| e.iter().any(|event| matches!(event, SttEvent::Done { .. }))).await;
        assert_eq!(seen.lock().unwrap().texts, vec![r#"{"type":"audio.done"}"#.to_string()]);
    }

    #[tokio::test]
    async fn a_third_session_is_refused_and_closing_the_app_closes_the_others() {
        let (port, seen) = serve(Script { chatty: false, ..Script::talking() }).await;
        let sessions = Sessions::default();
        let first = Events::default();
        let second = Events::default();
        let third = Events::default();
        let limits = Limits { idle: Duration::from_secs(30), ..quick() };
        open(&sessions, port, &first, limits);
        open(&sessions, port, &second, limits);
        // A local limit, not the server's: `busy`, which is not `unavailable` (a 503, after which the page pauses the streaming).
        assert_eq!(sessions.start(Some(KEY.into()), url(port), limits, third.emit()), Err(Reason::Busy));
        assert_eq!(failed(&third.all()), Some((Reason::Busy, None)));
        assert_eq!(serde_json::to_string(&third.all()[0]).unwrap(), r#"{"kind":"failed","reason":"busy"}"#);
        first.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        second.until("ready", |e| e.contains(&SttEvent::Ready)).await;
        sessions.close_all();
        assert!(lock(&sessions.live).is_empty());
        for _ in 0..100 {
            if seen.lock().unwrap().closed == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(seen.lock().unwrap().closed, 2);
        // A slot is free again.
        let again = Events::default();
        assert!(sessions.start(Some(KEY.into()), url(port), limits, again.emit()).is_ok());
        sessions.close_all();
    }

    #[tokio::test]
    async fn a_page_more_than_the_queue_ahead_ends_the_session_as_backpressure() {
        // Created never comes, so nothing is read from the queue: the 51st frame does not fit.
        let (port, _seen) = serve(Script::default()).await;
        let sessions = Sessions::default();
        let events = Events::default();
        let limits = Limits { created: Duration::from_secs(10), ..quick() };
        let id = open(&sessions, port, &events, limits);
        let mut refused = None;
        for n in 0..=QUEUE_FRAMES {
            if let Err(error) = sessions.send(id, frame(1)) {
                refused = Some((n, error));
                break;
            }
        }
        assert_eq!(refused, Some((QUEUE_FRAMES, "backpressure".to_string())));
        let all = events.until("a failure", has_failed).await;
        assert_eq!(failed(&all), Some((Reason::Backpressure, None)));
    }

    #[test]
    fn a_frame_is_the_raw_body_with_the_id_in_a_header_or_json_as_a_fallback() {
        let raw = InvokeBody::Raw(vec![1, 2, 3]);
        assert_eq!(frame_of(&raw, Some("7")), Ok((7, vec![1, 2, 3])));
        assert!(frame_of(&raw, None).is_err());
        assert!(frame_of(&raw, Some("seven")).is_err());
        let json = InvokeBody::Json(serde_json::json!({ "id": 9, "bytes": [0, 255, 16] }));
        assert_eq!(frame_of(&json, None), Ok((9, vec![0, 255, 16])));
        assert!(frame_of(&InvokeBody::Json(serde_json::json!({ "bytes": [1] })), None).is_err());
        assert!(frame_of(&InvokeBody::Json(serde_json::json!({ "id": 1, "bytes": [256] })), None).is_err());
        assert!(frame_of(&InvokeBody::Json(serde_json::json!({ "id": 1 })), None).is_err());
    }

    #[test]
    fn a_frame_too_big_is_refused_before_it_is_queued() {
        let sessions = Sessions::default();
        assert!(sessions.send(1, vec![0; MAX_FRAME_BYTES + 1]).is_err());
        // And a session that does not exist says so.
        assert_eq!(sessions.send(1, vec![0; 10]), Err("sessione chiusa o sconosciuta".to_string()));
        assert_eq!(sessions.end(1), Err("sessione chiusa o sconosciuta".to_string()));
        sessions.cancel(1);
    }

    #[test]
    fn what_could_reach_a_log_loses_the_key() {
        assert_eq!(scrub(&format!("failed with {KEY} in the url"), KEY), "failed with ••• in the url");
        assert_eq!(scrub("no key here", KEY), "no key here");
        assert_eq!(scrub("anything", ""), "anything");
    }

    #[test]
    fn the_status_of_a_refusal_maps_to_the_reasons_the_page_knows() {
        assert_eq!(classify_status(401, ""), Reason::Auth);
        assert_eq!(classify_status(403, "Forbidden"), Reason::Auth);
        assert_eq!(classify_status(403, "Insufficient BALANCE"), Reason::Credit);
        assert_eq!(classify_status(402, ""), Reason::Credit);
        assert_eq!(classify_status(429, ""), Reason::Rate);
        assert_eq!(classify_status(502, ""), Reason::Unavailable);
        assert_eq!(classify_status(404, ""), Reason::Protocol);
        for reason in [Reason::Auth, Reason::Credit, Reason::Rate, Reason::Unavailable, Reason::Network, Reason::Timeout, Reason::Protocol, Reason::Backpressure] {
            assert!(!reason.code().is_empty());
        }
        assert_eq!(Reason::NoKey.code(), "no-key");
        assert_eq!(Reason::Busy.code(), "busy");
    }

    /// The key is read by Rust and goes to one place. The page can ask for a session, never for a key: nothing that reads it is a command, and
    /// nothing that is sent to the page carries text from a server.
    #[test]
    fn the_key_never_leaves_rust() {
        let this = include_str!("stt_stream.rs");
        let lib = include_str!("lib.rs");
        let secrets = include_str!("secrets.rs");
        let production = &this[..this.find("#[cfg(test)]").unwrap()];
        // Read in one place, by the code that opens the session.
        assert_eq!(production.matches("value_of_env(").count(), 1);
        // The readers are not commands, and the page's invoke list does not name them.
        for reader in ["fn value_for_env", "fn value_of_env"] {
            let at = secrets.find(reader).expect(reader);
            let before = &secrets[..at];
            assert!(!before.trim_end().ends_with("#[tauri::command]"), "{reader} is a command");
            assert!(before.trim_end().lines().last().is_some_and(|line| !line.contains("tauri::command")));
        }
        assert!(!lib.contains("value_of_env") && !lib.contains("value_for_env"));
        // The events that reach the page carry no free text but the transcript.
        let events = &production[production.find("pub enum SttEvent").unwrap()..production.find("pub type Emit").unwrap()];
        assert!(!events.contains("message") && !events.contains("error") && !events.contains("key"));
        // Every command is in the page's invoke list, so nothing else about the module is reachable.
        for command in ["stt_stream_open", "stt_stream_send", "stt_stream_end", "stt_stream_cancel"] {
            assert!(lib.contains(&format!("stt_stream::{command}")), "{command} is not registered");
        }
    }
}
