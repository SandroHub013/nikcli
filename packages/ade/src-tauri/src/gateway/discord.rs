//! Discord, through its Gateway WebSocket and its REST API.
//!
//! - Reading: one socket the bot holds open. Discord numbers the events it
//!   sends, hands out a session in `READY`, and lets a client that kept the
//!   session pick up where it left off with a Resume instead of a fresh
//!   Identify. Identifies are limited to a thousand a day, so a dropped
//!   connection is resumed whenever there is anything to resume with.
//! - Intents: `GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES`, and deliberately not
//!   `MESSAGE_CONTENT`, which is a privileged intent the user would have to
//!   switch on in the developer portal and whose absence costs nothing here: a
//!   private message and a message that names the bot both arrive with their
//!   text. What a group channel costs is that one mention is one turn.
//! - Sending: in pieces of 2000 characters, which is what Discord counts (an
//!   emoji is one, not two), cut so a code block is not broken. A reply becomes
//!   at most `MAX_PIECES` messages; past that the last one says the rest is in
//!   ADE, and the text is really left out rather than announced and sent.
//! - Every message carries `allowed_mentions` with nothing parsed: an answer
//!   that happens to contain `@everyone` would otherwise ring every bell in
//!   the channel.
//! - A message over the limit is Discord that says so, not this adapter: the
//!   API answers 50035, and the piece is cut in two and sent again.
//! - A 429 waits the `retry_after` asked (a minute at most) and tries again; a
//!   send that timed out is not tried again, as it may have arrived. The nonce
//!   that goes with it is the same on the retry, so a repeat returns the first
//!   message instead of posting it twice.
//!
//! The token is in the `Authorization` header, never in a URL. Errors are built
//! without it, and the hub hides it again anyway.

use super::adapter::{Adapter, AdapterError, Button, Capabilities, Inbound, Sender};
use super::chunk;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

pub const API: &str = "https://discord.com/api/v10";
/// Discord counts characters, not UTF-16 units: an emoji is one.
pub const MAX_LEN: usize = 2000;
/// How many messages one reply may become. A degenerate turn once produced
/// 60.698 characters in 31 messages of a row, which is a channel flooded, so
/// the ceiling keeps the first pieces and the last one says where the rest is.
const MAX_PIECES: usize = 8;
/// Identifies are limited to a thousand a day. Resuming keeps that budget for
/// real starts; this stops a socket that connects and never reaches `READY`
/// from spending it overnight.
const MAX_IDENTIFIES_WITHOUT_READY: usize = 3;
/// How long a cursor is worth resuming. Past this a new session is opened, as a
/// session the other end has forgotten cannot be resumed.
const SESSION_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_WAIT: Duration = Duration::from_secs(60);
const RETRIES: usize = 3;
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const USER_AGENT: &str = concat!("nikcli-ade/", env!("CARGO_PKG_VERSION"), " (gateway)");

/// The intents this adapter asks for.
///
/// `GUILDS` (1 << 0) so the bot knows its channels, `GUILD_MESSAGES` (1 << 9)
/// for messages in them, `DIRECT_MESSAGES` (1 << 12) for private ones. The sum
/// is 4609, and `MESSAGE_CONTENT` (1 << 15) is left out on purpose: it is
/// privileged, and both a private message and a message that names the bot
/// arrive with their text without it. A test holds this number.
const INTENTS: u64 = (1 << 0) | (1 << 9) | (1 << 12);

/// Close codes that stop the gateway, with what the user is told.
///
/// The list is deliberately short and holds only codes that could be sourced
/// rather than remembered. Discord publishes the whole table at
/// <https://docs.discord.com/developers/events/gateway#close-codes> and it is
/// to be transcribed from there. A code not on this list is treated as worth
/// another try, which costs an identify only when there is no session to
/// resume with, and the budget above stops that loop.
const FATAL_CLOSE: &[(u16, &str)] = &[
    // The token is wrong, revoked, or belongs to no bot.
    (4004, "Discord rifiuta il token del bot: controllalo nella pagina del bot"),
    // A privileged intent is off in the developer portal. This adapter asks for
    // none, so seeing it means the portal changed under it.
    (
        4014,
        "Discord ha rifiutato gli intent del bot: nella pagina del bot gli intent privilegiati sono chiusi, e questo bot non ne chiede",
    ),
];

/// A frame as Discord sends it.
#[derive(Debug, Deserialize)]
struct Frame {
    #[serde(default)]
    op: i64,
    #[serde(default)]
    t: Option<String>,
    #[serde(default)]
    s: Option<i64>,
    #[serde(default)]
    d: Value,
}

/// The session a dropped socket picks up with, as `READY` handed it out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Session {
    session_id: String,
    /// The last sequence number received; a resume that skips is refused.
    seq: i64,
    /// Where to reconnect, as `READY` said, not the address first used.
    resume_url: String,
    /// When it was written. A session the other end has forgotten cannot be
    /// resumed, and age is the only thing that says so.
    #[serde(default)]
    at_ms: u64,
}

/// Why a REST call failed, before it becomes the adapter's error.
#[derive(Debug)]
enum Failure {
    Network { timeout: bool, connect: bool, text: String },
    Api { status: u16, description: String, retry_after: Option<u64> },
}

impl Failure {
    fn description(&self) -> &str {
        match self {
            Failure::Api { description, .. } => description,
            Failure::Network { text, .. } => text,
        }
    }

    fn text(&self) -> String {
        match self {
            Failure::Network { text, .. } => format!("Discord non raggiungibile: {text}"),
            Failure::Api { description, .. } => format!("Discord: {description}"),
        }
    }

    fn for_sending(self) -> AdapterError {
        match self {
            Failure::Network { timeout: true, .. } => AdapterError::Transient(
                "Discord non ha risposto in tempo: il messaggio potrebbe essere arrivato lo stesso".into(),
            ),
            Failure::Network { .. } => AdapterError::Transient(self.text()),
            Failure::Api { .. } => AdapterError::Fatal(self.text()),
        }
    }

    /// Discord refuses a token with 401, and an unauthorized one with 403.
    fn for_reading(self) -> AdapterError {
        match self {
            Failure::Api { status: 401 | 403, description, .. } => {
                AdapterError::Fatal(format!("Discord rifiuta il token del bot: {description}"))
            }
            other => AdapterError::Transient(other.text()),
        }
    }
}

/// Discord's own word for "this text is too long": code 50035, and its message
/// names the limit. The count this adapter made is a guess; this is the truth.
fn is_too_long(description: &str) -> bool {
    description.contains("50035") || description.contains("2000 or fewer")
}

/// Discord counts characters; a piece is this many of them.
fn characters(text: &str) -> usize {
    text.chars().count()
}

fn id_text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string).or_else(|| value.as_i64().map(|id| id.to_string()))
}

fn is_loopback(api: &str) -> bool {
    api.starts_with("http://127.0.0.1") || api.starts_with("http://localhost")
}

/// Whether `text` names `bot` in Discord's mention syntax.
///
/// The text is searched for `<@id>` and `<@!id>`, and the platform's mention
/// list is not consulted: a reply that quotes the bot puts it in that list
/// without the author having written its name, and two bots that trust the
/// list take turns answering each other for ever.
fn names_bot(text: &str, bot: &str) -> bool {
    ["<@", "<@!"].iter().any(|open| text.contains(&format!("{open}{bot}>")))
}

/// `text` in as many pieces as Discord accepts, cut so a code block survives,
/// and at most `MAX_PIECES` of them.
///
/// Past the ceiling the last piece says how many characters were left in ADE,
/// so what is in the channel is a whole sentence and not the start of one.
fn pieces(text: &str) -> Vec<String> {
    let all = chunk::split(text, MAX_LEN, characters);
    if all.len() <= MAX_PIECES {
        return all;
    }
    let dropped: usize = all.iter().skip(MAX_PIECES - 1).map(|piece| characters(piece)).sum();
    // The whole pieces first, then one that says where the rest went: the
    // ceiling is the number of messages, and the last is the notice.
    let mut kept: Vec<String> = all.into_iter().take(MAX_PIECES - 1).collect();
    kept.push(format!(
        "(il resto, {dropped} caratteri, è in ADE: la risposta si è fermata a {MAX_PIECES} messaggi)"
    ));
    kept
}

/// `text` in two halves that each fit in a message, cut on a character.
fn cut_in_half(text: &str) -> (String, String) {
    let at = text.char_indices().nth(characters(text) / 2).map(|(index, _)| index).unwrap_or(text.len());
    (text[..at].to_string(), text[at..].to_string())
}

/// A nonce, the same for every try at the same message, so that a send
/// repeated after a timeout returns the message already posted.
fn nonce(seed: u64, attempt: u64) -> String {
    format!("{seed:016x}{attempt:016x}")
}

/// Locks a mutex, taking a poisoned one rather than panicking: a thread that
/// died holding it left the state whole, and the hub is the one that decides.
fn hold<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The state the socket task and the hub's calls both touch.
struct Shared {
    session: Mutex<Option<Session>>,
    /// The bot's own user id, from `READY`, to recognise a mention of itself.
    bot: Mutex<Option<String>>,
    /// The cursor as the hub saves it, written when the session moves.
    cursor: Mutex<Option<String>>,
    /// What a message last showed, per `chat/id`: an edit that changes nothing
    /// is not sent, because it would spend a slot in Discord's edit rate limit
    /// on a request that cannot do anything.
    preview: Mutex<HashMap<String, String>>,
    /// Bumped for every session, so an edit made before a drop does not write
    /// its text onto the message of the session that follows.
    epoch: AtomicU64,
    /// Set when a session reached `READY`, and taken by the loop that watches
    /// the identify budget: a socket that started is not a failed attempt, and
    /// the flag is what says so across the inner loop that set it.
    ready: AtomicBool,
}

impl Shared {
    fn mark_ready(&self) {
        self.ready.store(true, Ordering::SeqCst);
    }

    /// Whether a session became ready since the last time this was asked.
    fn take_ready(&self) -> bool {
        self.ready.swap(false, Ordering::SeqCst)
    }
}

impl Shared {
    fn bot_id(&self) -> Option<String> {
        hold(&self.bot).clone()
    }

    /// The session, if it is one worth resuming: a cursor too old is no cursor.
    fn resumable(&self, now: u64) -> Option<Session> {
        let session = hold(&self.session).clone()?;
        (now.saturating_sub(session.at_ms) <= SESSION_MAX_AGE_MS).then_some(session)
    }

    /// Records where a session is, and writes the cursor if it moved.
    fn remember(&self, session: Session) {
        let moved = {
            let mut held = hold(&self.session);
            if held.as_ref() == Some(&session) {
                false
            } else {
                *held = Some(session);
                true
            }
        };
        if !moved {
            return;
        }
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Some(reading) = hold(&self.session).clone() {
            *hold(&self.cursor) = serde_json::to_string(&reading).ok();
        }
    }

    /// Moves the sequence on. Discord refuses a resume whose sequence skips, so
    /// a number that went backwards is not one to keep.
    fn note_seq(&self, seq: i64) {
        let moved = {
            let mut held = hold(&self.session);
            match held.as_mut() {
                Some(session) if seq > session.seq => {
                    session.seq = seq;
                    Some(session.clone())
                }
                _ => None,
            }
        };
        if let Some(session) = moved {
            // The timestamp is kept: the session is the same one, only further
            // along, and it must not look freshly started.
            self.remember(session);
        }
    }

    fn forget_session(&self) {
        *hold(&self.session) = None;
        *hold(&self.cursor) = None;
    }
}

pub struct Discord {
    api: String,
    /// Where the socket goes, from `GET /gateway/bot`.
    socket: String,
    token: String,
    calls: reqwest::Client,
    shared: Arc<Shared>,
    /// Where the socket task's messages arrive.
    inbox: tokio::sync::Mutex<mpsc::Receiver<Result<Inbound, AdapterError>>>,
    sender: mpsc::Sender<Result<Inbound, AdapterError>>,
    /// The socket task, started by the first read and not before.
    started: AtomicBool,
    /// This adapter, so the socket task can hold it too without a cycle.
    me: Mutex<Weak<Discord>>,
    /// The first heartbeat waits this many thousandths of the interval, so a
    /// share of it: 1000 is the whole interval, 0 is none. Discord disconnects
    /// a client that heartbeats at once, and a test has to be able to predict
    /// the wait, so the share is a field and not a draw.
    jitter: AtomicU64,
    /// Epoch milliseconds, so a test can write a cursor of a chosen age.
    #[cfg(test)]
    now_ms: AtomicU64,
}

fn real_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

impl Discord {
    /// The adapter for the bot with `token`, reading on from `cursor`.
    pub fn new(token: &str, cursor: Option<String>) -> Result<Arc<Discord>, String> {
        Discord::at("wss://gateway.discord.gg", API, token, cursor)
    }

    fn at(socket: &str, api: &str, token: &str, cursor: Option<String>) -> Result<Arc<Discord>, String> {
        crate::serve_proxy::tls_ready();
        let builder = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).timeout(CALL_TIMEOUT);
        // The tests' server is on this machine: a system proxy must not see it.
        let builder = if is_loopback(api) { builder.no_proxy() } else { builder };
        let calls = builder.build().map_err(|error| format!("client HTTP non disponibile: {}", error.without_url()))?;
        let (sender, inbox) = mpsc::channel(256);
        // A cursor that does not parse is a cursor that is not there: a file
        // half written, or a state from a future version. Either way the safe
        // reading is to open a session, not to refuse to start.
        let session = cursor.as_deref().and_then(|raw| serde_json::from_str::<Session>(raw).ok());
        let adapter = Arc::new(Discord {
            api: api.to_string(),
            socket: socket.to_string(),
            token: token.to_string(),
            calls,
            shared: Arc::new(Shared {
                session: Mutex::new(session),
                bot: Mutex::new(None),
                cursor: Mutex::new(cursor),
                preview: Mutex::new(HashMap::new()),
                epoch: AtomicU64::new(0),
                ready: AtomicBool::new(false),
            }),
            inbox: tokio::sync::Mutex::new(inbox),
            sender,
            started: AtomicBool::new(false),
            me: Mutex::new(Weak::new()),
            jitter: AtomicU64::new(500),
            #[cfg(test)]
            now_ms: AtomicU64::new(0),
        });
        *hold(&adapter.me) = Arc::downgrade(&adapter);
        Ok(adapter)
    }

    fn now(&self) -> u64 {
        #[cfg(test)]
        {
            self.now_ms.load(Ordering::SeqCst)
        }
        #[cfg(not(test))]
        {
            real_now_ms()
        }
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<&Value>) -> Result<Value, Failure> {
        let network = |error: reqwest::Error| Failure::Network {
            timeout: error.is_timeout(),
            connect: error.is_connect(),
            text: error.without_url().to_string(),
        };
        let mut request = self
            .calls
            .request(method, format!("{}{path}", self.api))
            .header("Authorization", format!("Bot {}", self.token))
            .header(reqwest::header::USER_AGENT, USER_AGENT);
        if let Some(body) = body {
            request = request.header(reqwest::header::CONTENT_TYPE, "application/json").body(body.to_string());
        }
        let response = request.send().await.map_err(network)?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<f64>().ok())
            .map(|seconds| seconds.ceil() as u64);
        let bytes = response.bytes().await.map_err(network)?;
        if !(200..300).contains(&status) {
            let described: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let mut description = described["message"].as_str().unwrap_or("errore senza descrizione").to_string();
            // Some errors carry the code only in the body, and the length error
            // is one of them: it is named in the message, not in a field.
            if let Some(code) = described["code"].as_i64() {
                description = format!("{description} ({code})");
            }
            return Err(Failure::Api { status, description, retry_after });
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| Failure::Api {
            status,
            description: "risposta non valida".into(),
            retry_after: None,
        })
    }

    /// A call that waits out the limits and a refused connection (nothing was
    /// sent), but not a timeout (something may have been).
    async fn call_patiently(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, Failure> {
        let mut tries = 0;
        loop {
            tries += 1;
            match self.call(method.clone(), path, body).await {
                Err(Failure::Api { status, retry_after, description }) if status == 429 && tries <= RETRIES => {
                    let wait = Duration::from_secs(retry_after.unwrap_or(1));
                    if wait > MAX_WAIT {
                        return Err(Failure::Api { status, description, retry_after });
                    }
                    tokio::time::sleep(wait).await;
                }
                Err(Failure::Network { connect: true, .. }) if tries <= 1 => {
                    tokio::time::sleep(Duration::from_secs(1)).await
                }
                other => return other,
            }
        }
    }

    /// One message, with nothing in it Discord would read as a mention.
    fn body(text: &str) -> Value {
        json!({ "content": text, "allowed_mentions": { "parse": [] } })
    }

    async fn post(&self, chat: &str, body: &Value) -> Result<String, Failure> {
        let sent = self
            .call_patiently(reqwest::Method::POST, &format!("/channels/{chat}/messages"), Some(body))
            .await?;
        id_text(&sent["id"]).ok_or(Failure::Api {
            status: 200,
            description: "Discord non ha dato l'id del messaggio".into(),
            retry_after: None,
        })
    }

    /// Sends `text` in pieces, stopping at the ceiling, and returns the id of
    /// the message that now holds the end of it.
    async fn send_all(&self, chat: &str, text: &str, extra: Option<&Value>) -> Result<String, AdapterError> {
        let seed = self.shared.epoch.load(Ordering::SeqCst);
        let mut queue: VecDeque<String> = pieces(text).into();
        if queue.is_empty() {
            return Err(AdapterError::Fatal("il messaggio è vuoto".into()));
        }
        let mut attempt = 0u64;
        let mut last = String::new();
        while let Some(piece) = queue.pop_front() {
            let mut body = Discord::body(&piece);
            // The same nonce for every try at one piece: a repeat returns the
            // message already posted instead of posting it twice.
            body["nonce"] = Value::from(nonce(seed, attempt));
            attempt += 1;
            match self.post(chat, &body).await {
                Ok(id) => last = id,
                // Discord is the one that says the text is too long. Cut the
                // piece in two and send the head, which fits.
                Err(failure) if is_too_long(failure.description()) => {
                    let (head, tail) = cut_in_half(&piece);
                    if tail.is_empty() {
                        return Err(failure.for_sending());
                    }
                    queue.push_front(tail);
                    queue.push_front(head);
                }
                Err(failure) => return Err(failure.for_sending()),
            }
        }
        if let Some(extra) = extra {
            // The buttons go on the last message, whatever the text became.
            // A patch without a content leaves the text as it is.
            let body = json!({ "components": extra["components"].clone(), "allowed_mentions": { "parse": [] } });
            if let Err(failure) = self
                .call_patiently(reqwest::Method::PATCH, &format!("/channels/{chat}/messages/{last}"), Some(&body))
                .await
            {
                let unchanged =
                    matches!(&failure, Failure::Api { description, .. } if description.contains("not modified"));
                if !unchanged {
                    return Err(failure.for_sending());
                }
            }
        }
        hold(&self.shared.preview).insert(format!("{chat}/{last}"), text.to_string());
        Ok(last)
    }
}

/// How a socket session ended.
enum Ending {
    /// Stop, and tell the user why.
    Stopped(String),
    /// The socket dropped: go round again.
    Dropped,
}

/// What the user is told about a close code, if it is one to stop for.
fn fatal_close(code: u16) -> Option<&'static str> {
    FATAL_CLOSE.iter().find(|(known, _)| *known == code).map(|(_, why)| *why)
}

/// One run of the socket: connect, resume or identify, read, heartbeat, until
/// the socket closes or the user is told why it cannot go on.
async fn socket_session(adapter: &Arc<Discord>, sender: &mpsc::Sender<Result<Inbound, AdapterError>>, first: &str) -> Ending {
    let now = adapter.now();
    let mut fresh_identifies = 0usize;
    loop {
        // A session that came up puts the count of failed attempts back to
        // zero: what the budget is there to stop is a socket that never starts.
        if adapter.shared.take_ready() {
            fresh_identifies = 0;
        }
        if fresh_identifies > MAX_IDENTIFIES_WITHOUT_READY {
            return Ending::Stopped(format!(
                "Discord ha chiuso la connessione {MAX_IDENTIFIES_WITHOUT_READY} volte di fila prima di un avvio: il gateway resta fermo, e i tentativi non sono infiniti per non esaurire il limite di mille avvii al giorno"
            ));
        }
        let (address, resume) = match adapter.shared.resumable(now) {
            Some(session) => (session.resume_url.clone(), Some(session)),
            // Nothing to resume with, so this turn spends an identify.
            None => {
                fresh_identifies += 1;
                (first.to_string(), None)
            }
        };
        let (mut sink, mut source) = match tokio_tungstenite::connect_async(&address).await {
            Ok((socket, _handshake)) => socket.split(),
            Err(error) => {
                let _ = sender.send(Err(AdapterError::Transient(format!("Discord non raggiungibile: {error}")))).await;
                return Ending::Dropped;
            }
        };

        // The first frame is the Hello, which carries the heartbeat interval.
        // A socket that goes before the Hello leaves `hello` unset, and the
        // connection is one to go round on rather than to give up on.
        let hello: Option<Frame> = loop {
            let Some(incoming) = source.next().await else { break None };
            let Ok(frame) = incoming else { break None };
            let Message::Text(text) = frame else { continue };
            match serde_json::from_str::<Frame>(text.as_ref()) {
                Ok(frame) if frame.op == 10 => break Some(frame),
                // Anything before the Hello is not a Hello.
                _ => continue,
            }
        };
        let Some(hello) = hello else { continue };
        let interval = hello.d["heartbeat_interval"].as_u64().unwrap_or(41_250);
        let announce = match resume {
            Some(session) => json!({ "op": 6, "d": {
                "token": adapter.token, "session_id": session.session_id, "seq": session.seq,
            } }),
            None => json!({ "op": 2, "d": {
                "token": adapter.token,
                "intents": INTENTS,
                "properties": { "os": std::env::consts::OS, "browser": "ade", "device": "ade" },
                "compress": false,
                "large_threshold": 250,
            } }),
        };
        if sink.send(Message::Text(announce.to_string().into())).await.is_err() {
            return Ending::Dropped;
        }

        // The first heartbeat waits a share of the interval: a client that
        // heartbeats at once is disconnected.
        let share = adapter.jitter.load(Ordering::SeqCst).min(1000);
        let wait = Duration::from_millis(interval * share / 1000).max(Duration::from_millis(1));
        let mut beat = tokio::time::interval(wait);
        beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // An interval's first tick is due at once: take it, so the beat that
        // follows is one full period from now.
        beat.tick().await;
        let mut acked = true;

        loop {
            tokio::select! {
                incoming = source.next() => {
                    let Some(incoming) = incoming else { break };
                    let frame = match incoming {
                        Ok(frame) => frame,
                        // The code of a close arrives in the frame below; an
                        // error here means the socket is already gone.
                        Err(_) => break,
                    };
                    match frame {
                        Message::Close(close) => {
                            if let Some(CloseFrame { code, .. }) = close {
                                return match fatal_close(u16::from(code)) {
                                    Some(why) => Ending::Stopped(why.to_string()),
                                    None => Ending::Dropped,
                                };
                            }
                            break;
                        }
                        Message::Ping(payload) => {
                            let _ = sink.send(Message::Pong(payload)).await;
                        }
                        Message::Text(text) => {
                            let Ok(frame) = serde_json::from_str::<Frame>(text.as_ref()) else { continue };
                            if let Some(seq) = frame.s {
                                adapter.shared.note_seq(seq);
                            }
                            let kind = frame.t.clone().unwrap_or_default();
                            match kind.as_str() {
                                "READY" => {
                                    let session_id = frame.d["session_id"].as_str().unwrap_or_default().to_string();
                                    if !session_id.is_empty() {
                                        if let Some(id) = id_text(&frame.d["user"]["id"]) {
                                            *hold(&adapter.shared.bot) = Some(id);
                                        }
                                        let resume_url = frame.d["resume_gateway_url"].as_str().unwrap_or(&address).to_string();
                                        adapter.shared.remember(Session {
                                            session_id,
                                            seq: 0,
                                            resume_url,
                                            at_ms: adapter.now(),
                                        });
                                    }
                                    adapter.shared.mark_ready();
                                }
                                // Discord asking for a heartbeat at once means
                                // it is about to drop this socket: answer now.
                                "HEARTBEAT" => {
                                    if sink.send(Message::Text(json!({ "op": 1, "d": null }).to_string().into())).await.is_err() {
                                        break;
                                    }
                                    acked = false;
                                }
                                "HEARTBEAT_ACK" => acked = true,
                                "MESSAGE_CREATE" => {
                                    if let Some(inbound) = to_inbound(&frame.d, &adapter.shared) {
                                        if sender.send(Ok(inbound)).await.is_err() {
                                            break;
                                        }
                                    }
                                }
                                "INTERACTION_CREATE" => {
                                    if let Some(press) = to_press(&frame.d) {
                                        let _ = sender.send(Ok(press)).await;
                                    }
                                }
                                "RESUMED" => adapter.shared.mark_ready(),
                                // A session the other end will not resume: the
                                // only way on is a new identify.
                                "INVALID_SESSION" => {
                                    adapter.shared.forget_session();
                                    break;
                                }
                                _ => {}
                            }
                        }
                        _ => {}
                    }
                }
                _ = beat.tick() => {
                    if !acked {
                        // A heartbeat that was never acknowledged: the socket is
                        // alive on this side only. Go round rather than wait.
                        break;
                    }
                    acked = false;
                    if sink.send(Message::Text(json!({ "op": 1, "d": null }).to_string().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
}

/// The socket task's own loop: a session that drops is another one, with a wait
/// between that grows, so a gateway that is down is not hammered.
async fn run_socket(adapter: Arc<Discord>, sender: mpsc::Sender<Result<Inbound, AdapterError>>, first: String) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match socket_session(&adapter, &sender, &first).await {
            Ending::Stopped(why) => {
                let _ = sender.send(Err(AdapterError::Fatal(why))).await;
                return;
            }
            Ending::Dropped => {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(300));
            }
        }
    }
}

/// A message as the hub sees it, or `None` for what the gateway does not take.
fn to_inbound(d: &Value, shared: &Shared) -> Option<Inbound> {
    let text = d["content"].as_str().unwrap_or_default();
    if text.is_empty() {
        return None;
    }
    let chat = id_text(&d["channel_id"])?;
    let author = &d["author"];
    let name = author["global_name"]
        .as_str()
        .or_else(|| author["username"].as_str())
        .unwrap_or_default()
        .to_string();
    Some(Inbound {
        id: id_text(&d["id"])?,
        chat,
        // A direct message is a conversation the user opened; a channel needs
        // the bot named in it, or the bot would answer a room it sits in.
        private: d["channel_type"].as_i64() == Some(1),
        mentioned: shared.bot_id().is_some_and(|id| names_bot(text, &id)),
        sender: Sender {
            id: id_text(&author["id"])?,
            name,
            // Another bot, this one included, and anything a webhook posted.
            is_bot: author["bot"].as_bool().unwrap_or(false) || !d["webhook_id"].is_null(),
        },
        text: text.to_string(),
        button: false,
    })
}

/// A button press: not a message, and the data comes back as the text.
fn to_press(d: &Value) -> Option<Inbound> {
    // 3 is MESSAGE_COMPONENT, the only interaction a button under a message
    // makes; the others (a slash command, a modal) are not a press.
    if d["type"].as_i64() != Some(3) {
        return None;
    }
    let data = d["data"]["custom_id"].as_str()?;
    let who = if d["member"].is_null() { &d["user"] } else { &d["member"]["user"] };
    let name = who["global_name"].as_str().or_else(|| who["username"].as_str()).unwrap_or_default().to_string();
    Some(Inbound {
        id: id_text(&d["id"])?,
        chat: id_text(&d["channel_id"])?,
        private: d["channel_type"].as_i64() == Some(1),
        mentioned: false,
        sender: Sender { id: id_text(&who["id"])?, name, is_bot: false },
        text: data.to_string(),
        button: true,
    })
}

#[async_trait]
impl Adapter for Discord {
    fn capabilities(&self) -> Capabilities {
        Capabilities { max_len: MAX_LEN, edit: true, typing: true, buttons: true }
    }

    async fn receive(&self) -> Result<Vec<Inbound>, AdapterError> {
        // The socket task starts with the first read, not with `new`, which is
        // not async: opening a connection before the hub asks for one would
        // spend an identify on a gateway that may never be switched on.
        if !self.started.swap(true, Ordering::SeqCst) {
            let Some(me) = hold(&self.me).upgrade() else {
                return Err(AdapterError::Fatal("il gateway Discord non può tenere la sua connessione".into()));
            };
            let sender = self.sender.clone();
            let first = self.socket.clone();
            tokio::spawn(async move { run_socket(me, sender, first).await });
        }
        let mut inbox = self.inbox.lock().await;
        let mut batch = Vec::new();
        while batch.is_empty() {
            match inbox.recv().await {
                Some(Ok(message)) => batch.push(message),
                Some(Err(error)) => return Err(error),
                // The task is gone without saying why: nothing more will come.
                None => return Err(AdapterError::Fatal("il gateway Discord si è fermato".into())),
            }
        }
        Ok(batch)
    }

    async fn send(&self, chat: &str, text: &str) -> Result<String, AdapterError> {
        self.send_all(chat, text, None).await
    }

    async fn send_buttons(&self, chat: &str, text: &str, buttons: &[Button]) -> Result<String, AdapterError> {
        let components: Vec<Value> = buttons
            .chunks(2)
            .map(|row| {
                let row: Vec<Value> = row
                    .iter()
                    .map(|button| json!({ "type": 2, "style": 1, "label": button.label, "custom_id": button.data }))
                    .collect();
                json!([{ "type": 1, "components": row }])
            })
            .collect();
        self.send_all(chat, text, Some(&json!({ "components": components }))).await
    }

    async fn edit(&self, chat: &str, message: &str, text: &str) -> Result<String, AdapterError> {
        let key = format!("{chat}/{message}");
        if hold(&self.shared.preview).get(&key).map(String::as_str) == Some(text) {
            // The same text again. Discord would answer with an error and the
            // request would still spend a slot in the edit rate limit.
            return Ok(message.to_string());
        }
        let all = pieces(text);
        let Some(first) = all.first() else {
            return Err(AdapterError::Fatal("il messaggio è vuoto".into()));
        };
        // An edit keeps whatever the message already had, mentions included,
        // and there is nothing here to replace, so no field is sent but the
        // text: the mention list of a replaced answer is its own.
        if let Err(failure) = self
            .call_patiently(
                reqwest::Method::PATCH,
                &format!("/channels/{chat}/messages/{message}"),
                Some(&json!({ "content": first })),
            )
            .await
        {
            // A message that says the same thing is not a change; anything else
            // is worth saying.
            let unchanged = matches!(&failure, Failure::Api { description, .. } if description.contains("not modified"));
            if !unchanged {
                return Err(failure.for_sending());
            }
        }
        // What does not fit in one message goes on after it, never cut off.
        let mut last = message.to_string();
        for piece in &all[1..] {
            last = self.post(chat, &Discord::body(piece)).await.map_err(Failure::for_sending)?;
        }
        hold(&self.shared.preview).insert(key, text.to_string());
        Ok(last)
    }

    async fn typing(&self, chat: &str) -> Result<(), AdapterError> {
        self.call_patiently(reqwest::Method::POST, &format!("/channels/{chat}/typing"), Some(&json!({})))
            .await
            .map(|_| ())
            .map_err(Failure::for_sending)
    }

    async fn whoami(&self) -> Result<String, AdapterError> {
        let me = self.call_patiently(reqwest::Method::GET, "/users/@me", None).await.map_err(Failure::for_reading)?;
        match me["username"].as_str() {
            Some(username) if !username.is_empty() => Ok(format!("@{username}")),
            _ => Err(AdapterError::Fatal("Discord non ha detto il nome del bot".into())),
        }
    }

    fn cursor(&self) -> Option<String> {
        hold(&self.shared.cursor).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::adapter::admits;
    use std::collections::VecDeque;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::Message as Ws;

    /* Two servers on this machine: no token of a real bot, no network out. */

    const TOKEN: &str = "FINTO-token-discord-di-prova_000000000000";
    const BOT: &str = "42";

    /// One scripted answer per request: the status, the body, and an optional
    /// retry-after in seconds.
    #[derive(Clone)]
    struct Reply {
        status: u16,
        body: String,
        retry_after: Option<u64>,
    }

    fn ok(body: &str) -> Reply {
        Reply { status: 200, body: body.into(), retry_after: None }
    }

    fn refused(body: &str) -> Reply {
        Reply { status: 400, body: body.into(), retry_after: None }
    }

    fn unauthorized(body: &str) -> Reply {
        Reply { status: 401, body: body.into(), retry_after: None }
    }

    fn refused_with_wait(body: &str, seconds: u64) -> Reply {
        Reply { status: 429, body: body.into(), retry_after: Some(seconds) }
    }

    /// A Discord API on localhost: what was asked, and what to answer.
    struct FakeRest {
        address: String,
        seen: Arc<Mutex<Vec<(String, String)>>>,
    }

    impl FakeRest {
        fn start(replies: Vec<Reply>) -> FakeRest {
            let listener = TcpListener::bind("127.0.0.1:0").expect("porta libera");
            let address = format!("http://{}", listener.local_addr().expect("indirizzo"));
            let seen = Arc::new(Mutex::new(Vec::new()));
            let thread_seen = seen.clone();
            let queue = Arc::new(Mutex::new(VecDeque::from(replies)));
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let (head, body) = read_request(&mut stream);
                    thread_seen.lock().unwrap().push((head, body));
                    let reply = queue
                        .lock()
                        .unwrap()
                        .pop_front()
                        .unwrap_or_else(|| ok("{}"));
                    let mut response = format!(
                        "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                        reply.status,
                        reply.body.len(),
                        reply.body
                    );
                    if let Some(seconds) = reply.retry_after {
                        response = response.replace("X\r\n", &format!("retry-after: {seconds}\r\n"));
                    }
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                }
            });
            FakeRest { address, seen }
        }

        fn requests(&self) -> Vec<(String, String)> {
            hold(&self.seen).clone()
        }

        /// The body of the nth request, parsed.
        fn body_of(&self, nth: usize) -> Value {
            let requests = self.requests();
            serde_json::from_str(requests.get(nth).map(|(_, body)| body.as_str()).unwrap_or("{}")).unwrap_or(Value::Null)
        }

        fn count(&self) -> usize {
            hold(&self.seen).len()
        }
    }

    /// Reads one HTTP request: the first line, then the body as the headers say.
    fn read_request(stream: &mut TcpStream) -> (String, String) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while stream.read(&mut byte).unwrap_or(0) == 1 {
            head.push(byte[0]);
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        let head = String::from_utf8_lossy(&head).to_string();
        let length: usize = head
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-length:"))
            .and_then(|line| line.split(':').nth(1))
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        if length > 0 {
            let _ = stream.read_exact(&mut body);
        }
        (head.lines().next().unwrap_or_default().to_string(), String::from_utf8_lossy(&body).to_string())
    }

    /// A Discord Gateway on localhost. The script is a queue shared by every
    /// connection, so a test that expects a reconnect writes the frames of the
    /// second connection after the ones of the first.
    struct FakeGateway {
        address: String,
        seen: Arc<Mutex<Vec<Value>>>,
        queue: Arc<Mutex<VecDeque<Vec<Ws>>>>,
    }

    impl FakeGateway {
        fn start(script: Vec<Vec<Ws>>) -> FakeGateway {
            let listener = TcpListener::bind("127.0.0.1:0").expect("porta libera");
            let address = format!("ws://{}", listener.local_addr().expect("indirizzo"));
            let seen = Arc::new(Mutex::new(Vec::new()));
            let thread_seen = seen.clone();
            let queue = Arc::new(Mutex::new(VecDeque::from(script)));
            // The thread takes the queue by move: the fake keeps a copy of its
            // own, so a test can add frames after the thread has started.
            let mine = queue.clone();
            std::thread::spawn(move || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
                for incoming in listener.incoming() {
                    let Ok(stream) = incoming else { continue };
                    // Only the socket is handed to tokio, and only inside its
                    // runtime: outside it there is no reactor to register on.
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    let queue = queue.clone();
                    let seen = thread_seen.clone();
                    // One connection at a time: the client reconnects after the
                    // one before it is gone.
                    runtime.block_on(async move {
                        let Ok(stream) = tokio::net::TcpStream::from_std(stream) else { return };
                        let Ok(mut socket) = tokio_tungstenite::accept_async(stream).await else { return };
                        let (mut sink, mut source) = socket.split();
                        let reader_seen = seen.clone();
                        let reader = tokio::spawn(async move {
                            while let Some(Ok(frame)) = source.next().await {
                                if let Ws::Text(text) = frame {
                                    if let Ok(parsed) = serde_json::from_str::<Value>(text.as_ref()) {
                                        reader_seen.lock().unwrap().push(parsed);
                                    }
                                }
                            }
                        });
                        // One list per connection: the frames for the next
                        // one are still waiting for the next one.
                        let frames = queue.lock().unwrap().pop_front().unwrap_or_default();
                        for frame in frames {
                            if sink.send(frame).await.is_err() {
                                break;
                            }
                        }
                        // The client answers the Hello, resumes or identifies,
                        // and beats: the connection stays open long enough for
                        // those to arrive and be recorded.
                        tokio::time::sleep(Duration::from_millis(700)).await;
                        // The stream is split, so this is the sink's own close.
                        let _ = sink.close().await;
                        reader.abort();
                    });
                }
            });
            FakeGateway { address, seen, queue: mine }
        }

        /// Says what the next connection will be sent.
        fn push(&self, frames: Vec<Ws>) {
            self.queue.lock().unwrap().push_back(frames);
        }

        fn frames(&self) -> Vec<Value> {
            hold(&self.seen).clone()
        }

        /// The first frame with the given opcode.
        fn op(&self, op: i64) -> Option<Value> {
            self.frames().into_iter().find(|frame| frame["op"].as_i64() == Some(op))
        }

        fn ops(&self, op: i64) -> usize {
            self.frames().iter().filter(|frame| frame["op"].as_i64() == Some(op)).count()
        }

        /// Waits until the client has sent `count` frames with `op`.
        async fn wait_for(&self, op: i64, count: usize) -> bool {
            for _ in 0..300 {
                if self.ops(op) >= count {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            false
        }
    }

    fn hello(interval_ms: u64) -> Ws {
        Ws::Text(json!({ "op": 10, "d": { "heartbeat_interval": interval_ms } }).to_string().into())
    }

    fn ready(session_id: &str, resume_url: &str) -> Ws {
        Ws::Text(
            json!({ "op": 0, "t": "READY", "s": 1, "d": {
                "session_id": session_id,
                "resume_gateway_url": resume_url,
                "user": { "id": BOT, "username": "bot_di_prova" },
            } })
            .to_string()
            .into(),
        )
    }

    fn message(id: &str, channel: &str, channel_type: i64, author: &str, text: &str) -> Ws {
        Ws::Text(
            json!({ "op": 0, "t": "MESSAGE_CREATE", "s": 2, "d": {
                "id": id, "channel_id": channel, "channel_type": channel_type,
                "content": text,
                "author": { "id": author, "username": "qualcuno", "bot": false },
            } })
            .to_string()
            .into(),
        )
    }

    /// A close frame. Only the codes a real peer may send: 1006 is reserved and
    /// a socket that vanishes sends nothing at all, which the adapter reads as
    /// the stream ending.
    fn closed(code: u16) -> Ws {
        Ws::Close(Some(CloseFrame {
            code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Library(code),
            reason: "chiuso dalla prova".into(),
        }))
    }

    /// An adapter pointed at the two fakes, with no cursor.
    fn adapter(rest: &FakeRest, gateway: &FakeGateway) -> Arc<Discord> {
        Discord::at(&gateway.address, &rest.address, TOKEN, None).expect("adapter")
    }

    /// Sets the share of the interval the first heartbeat waits.
    fn set_jitter(discord: &Arc<Discord>, per_thousand: u64) {
        discord.jitter.store(per_thousand, Ordering::SeqCst);
    }

    /// The shared state a test of the reading side needs.
    fn shared() -> Shared {
        Shared {
            session: Mutex::new(None),
            bot: Mutex::new(Some(BOT.to_string())),
            cursor: Mutex::new(None),
            preview: Mutex::new(HashMap::new()),
            epoch: AtomicU64::new(0),
            ready: AtomicBool::new(false),
        }
    }

    /// Starts the socket and gives up waiting for a message: these tests watch
    /// the frames the adapter sent, and a read with nothing behind it would
    /// wait for ever.
    async fn start(discord: &Arc<Discord>) {
        let _ = tokio::time::timeout(Duration::from_millis(200), discord.receive()).await;
    }

    fn nonce_of(body: &Value) -> Option<String> {
        body["nonce"].as_str().map(str::to_string)
    }

    /* The intents, and the mention rule, without a socket. */

    #[test]
    fn the_intents_are_the_three_that_suffice_and_not_the_privileged_one() {
        // GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES.
        assert_eq!(INTENTS, (1 << 0) | (1 << 9) | (1 << 12));
        assert_eq!(INTENTS, 4609);
        // MESSAGE_CONTENT, the privileged one, is not in there.
        assert_eq!(INTENTS & (1 << 15), 0);
    }

    #[test]
    fn a_mention_is_read_from_the_text_and_not_from_the_mention_list() {
        assert!(names_bot("ciao <@42> guarda", BOT));
        assert!(names_bot("ciao <@!42> guarda", BOT));
        assert!(!names_bot("ciao <@43> guarda", BOT));
        // A name that merely contains the digits is not a mention.
        assert!(!names_bot("ciao utente420", BOT));
    }

    #[test]
    fn a_group_message_is_answered_only_when_it_names_the_bot() {
        let shared = shared();
        let named: Value = json!({
            "id": "c1", "channel_id": "ch1", "channel_type": 0,
            "content": "ciao <@42>", "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        let named = to_inbound(&named, &shared).expect("messaggio");
        assert!(named.mentioned, "una menzione in un canale abilita il canale");
        assert!(!named.private);
        assert!(admits(&named));

        let quiet: Value = json!({
            "id": "c2", "channel_id": "ch1", "channel_type": 0,
            "content": "si parla di altro", "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        let quiet = to_inbound(&quiet, &shared).expect("messaggio");
        assert!(!quiet.mentioned);
        assert!(!admits(&quiet), "senza menzione il canale non e' per il bot");

        let direct: Value = json!({
            "id": "c3", "channel_id": "d1", "channel_type": 1,
            "content": "ciao", "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        let direct = to_inbound(&direct, &shared).expect("messaggio");
        assert!(direct.private);
        assert!(admits(&direct), "una chat privata non ha bisogno di menzione");
    }

    #[test]
    fn a_quote_of_the_bot_is_not_taken_for_a_mention() {
        // The mention list would have the bot in it, the text has not: two bots
        // that trust the list answer each other for ever.
        let shared = shared();
        let quoted: Value = json!({
            "id": "c9", "channel_id": "ch1", "channel_type": 0,
            "content": "come stai?",
            "mentions": [{ "id": BOT }],
            "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        assert!(!to_inbound(&quoted, &shared).expect("messaggio").mentioned);
    }

    #[test]
    fn a_bot_and_a_webhook_are_never_answered() {
        let shared = shared();
        let from_bot: Value = json!({
            "id": "b1", "channel_id": "d1", "channel_type": 1, "content": "ciao",
            "author": { "id": "u2", "username": "robot", "bot": true },
        });
        assert!(to_inbound(&from_bot, &shared).expect("messaggio").sender.is_bot);
        let from_hook: Value = json!({
            "id": "b2", "channel_id": "d1", "channel_type": 1, "content": "ciao",
            "webhook_id": "w1", "author": { "id": "u3", "username": "hook", "bot": false },
        });
        assert!(to_inbound(&from_hook, &shared).expect("messaggio").sender.is_bot);
    }

    #[test]
    fn a_message_without_text_is_not_a_message() {
        let shared = shared();
        // Without MESSAGE_CONTENT a guild message the bot was not named in
        // arrives with no text at all: it must not become an empty turn.
        let empty: Value = json!({
            "id": "m2", "channel_id": "ch1", "channel_type": 0, "content": "",
            "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        assert!(to_inbound(&empty, &shared).is_none());
    }

    /* Sending. */

    #[tokio::test]
    async fn a_reply_that_does_not_fit_is_cut_and_mentions_are_off() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "2" }).to_string()),
            ok(&json!({ "id": "3" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        discord.send("ch1", &"a".repeat(4500)).await.expect("inviato");
        assert_eq!(rest.count(), 3);
        for nth in 0..3 {
            let body = rest.body_of(nth);
            let content = body["content"].as_str().unwrap_or_default();
            assert!(characters(content) <= MAX_LEN, "un pezzo supera il limite: {}", characters(content));
            // The security line: nothing in an answer may be read as a mention.
            assert_eq!(body["allowed_mentions"]["parse"], json!([]));
            assert!(nonce_of(&body).is_some(), "ogni invio porta un nonce");
        }
    }

    #[tokio::test]
    async fn an_answer_naming_everyone_still_does_not_ring_the_channel() {
        let rest = FakeRest::start(vec![ok(&json!({ "id": "1" }).to_string())]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        discord.send("ch1", "@everyone @here guardate questo").await.expect("inviato");
        let body = rest.body_of(0);
        assert!(body["content"].as_str().unwrap_or_default().contains("@everyone"));
        assert_eq!(
            body["allowed_mentions"]["parse"],
            json!([]),
            "il testo dice @everyone ma Discord non deve leggerlo come una menzione"
        );
    }

    #[tokio::test]
    async fn a_reply_stops_at_eight_messages_and_says_the_rest_is_in_ade() {
        let mut replies = Vec::new();
        for nth in 1..=9 {
            replies.push(ok(&json!({ "id": nth.to_string() }).to_string()));
        }
        let rest = FakeRest::start(replies);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        // 20.000 characters is ten full messages: the ceiling holds seven and
        // says where the rest went, and the rest is really left out.
        let text = "b".repeat(20_000);
        let last = discord.send("ch1", &text).await.expect("inviato");
        assert_eq!(rest.count(), MAX_PIECES);
        assert_eq!(last, "8");
        let final_body = rest.body_of(MAX_PIECES - 1);
        let content = final_body["content"].as_str().unwrap_or_default();
        assert!(content.contains("in ADE"), "l'ultimo pezzo dice dove sta il resto");
        assert!(characters(content) <= MAX_LEN, "l'ultimo pezzo resta nel limite");
        let sent: usize = (0..MAX_PIECES)
            .map(|nth| characters(rest.body_of(nth)["content"].as_str().unwrap_or_default()))
            .sum();
        assert!(sent < characters(&text), "il testo troncato non e' stato comunque inviato");
    }

    #[tokio::test]
    async fn a_code_block_is_cut_so_each_piece_still_shows_it_as_code() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "2" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        let text = format!("```rust\nlet x = 1;\n{}\n```", "let y = 2;\n".repeat(300));
        discord.send("ch1", &text).await.expect("inviato");
        for nth in 0..2 {
            let content = rest.body_of(nth)["content"].as_str().unwrap_or_default().to_string();
            assert_eq!(content.matches("```").count() % 2, 0, "fence aperto in un pezzo: {content}");
        }
    }

    #[tokio::test]
    async fn discord_says_the_text_is_too_long_and_the_piece_is_cut_in_two() {
        let rest = FakeRest::start(vec![
            refused(&json!({ "message": "Must be 2000 or fewer in length." }).to_string()),
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "2" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        // Short enough for the adapter's own count, and Discord says otherwise:
        // the platform is the one that decides the limit.
        let last = discord.send("ch1", &"c".repeat(1900)).await.expect("inviato");
        assert_eq!(rest.count(), 3, "un rifiuto e i due mezzi");
        assert_eq!(last, "2");
        for nth in 1..3 {
            let content = characters(rest.body_of(nth)["content"].as_str().unwrap_or_default());
            assert!(content <= MAX_LEN);
        }
    }

    #[tokio::test]
    async fn a_too_late_answer_is_waited_out_and_a_nonce_stays_the_same() {
        let rest = FakeRest::start(vec![refused_with_wait("{}", 0), ok(&json!({ "id": "9" }).to_string())]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        let last = discord.send("ch1", "ciao").await.expect("inviato");
        assert_eq!(last, "9");
        assert_eq!(rest.count(), 2, "il 429 e poi il tentativo");
        let first = nonce_of(&rest.body_of(0));
        let second = nonce_of(&rest.body_of(1));
        assert_eq!(first, second, "il nonce resta lo stesso fra un tentativo e l'altro");
    }

    #[tokio::test]
    async fn an_edit_that_changes_nothing_is_not_sent() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "1" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        let last = discord.send("ch1", "prima versione").await.expect("inviato");
        discord.edit("ch1", &last, "una versione nuova").await.expect("modificato");
        let after_first = rest.count();
        discord.edit("ch1", &last, "una versione nuova").await.expect("modificato");
        assert_eq!(rest.count(), after_first, "lo stesso testo non viaggia: ogni modifica costa un posto nel limite");
    }

    #[tokio::test]
    async fn an_edit_too_long_goes_on_in_new_messages_and_returns_the_last_id() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "7" }).to_string()),
            ok(&json!({ "id": "8" }).to_string()),
            ok(&json!({ "id": "9" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        let last = discord.edit("ch1", "7", &"d".repeat(4500)).await.expect("modificato");
        assert_eq!(rest.count(), 3, "una modifica e i due pezzi che non ci stanno");
        assert_eq!(last, "9", "l'id di chi tiene la fine del testo");
        assert!(rest.requests()[0].0.contains("PATCH"));
    }

    #[tokio::test]
    async fn a_button_lands_on_the_last_message_with_its_data() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "1" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        discord
            .send_buttons("ch1", "vuoi continuare?", &[Button { label: "Si'".into(), data: "continua".into() }])
            .await
            .expect("inviato");
        let component = &rest.body_of(1)["components"][0][0]["components"][0];
        assert_eq!(component["custom_id"], "continua");
        assert_eq!(component["label"], "Si'");
    }

    #[test]
    fn a_press_becomes_a_message_with_its_data_and_a_command_does_not() {
        let press: Value = json!({
            "id": "i1", "channel_id": "ch1", "channel_type": 0, "type": 3,
            "data": { "custom_id": "continua" },
            "member": { "user": { "id": "u1", "username": "qualcuno" } },
        });
        let inbound = to_press(&press).expect("pressione");
        assert!(inbound.button);
        assert_eq!(inbound.text, "continua");
        assert_eq!(inbound.sender.id, "u1");
        // A slash command is not a press under a message.
        let command: Value = json!({ "id": "i2", "channel_id": "ch1", "type": 2, "data": { "custom_id": "x" } });
        assert!(to_press(&command).is_none());
    }

    #[tokio::test]
    async fn whoami_asks_discord_and_a_refused_token_says_so_without_it() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1", "username": "bot_di_prova" }).to_string()),
            unauthorized(&json!({ "message": "401: Unauthorized" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        assert_eq!(discord.whoami().await.expect("nome"), "@bot_di_prova");
        let text = discord.whoami().await.err().expect("errore").message();
        assert!(text.contains("rifiuta il token"), "{text}");
        assert!(!text.contains(TOKEN), "il token non compare nell'errore: {text}");
    }

    /* The socket. */

    #[tokio::test]
    async fn the_socket_identifies_with_the_three_intents_and_nothing_privileged() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        gateway.push(vec![hello(200), ready("S1", &gateway.address)]);
        let discord = adapter(&rest, &gateway);
        start(&discord).await;
        let identify = gateway.op(2).expect("l'identify e' stato mandato");
        assert_eq!(identify["d"]["intents"], json!(INTENTS));
        assert_eq!(identify["d"]["token"], json!(TOKEN));
    }

    #[tokio::test]
    async fn the_first_heartbeat_waits_and_the_next_ones_do_not() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        // Half of a second is the wait: a client that beats at once is
        // disconnected, so the beat has to be late on purpose.
        gateway.push(vec![hello(1000), ready("S1", &gateway.address)]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 500);
        start(&discord).await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(gateway.ops(1), 0, "il primo battito aspetta: un client che batte subito viene chiuso");
        assert!(gateway.wait_for(1, 1).await, "il primo battito arriva");
    }

    #[tokio::test]
    async fn a_heartbeat_never_answered_means_the_socket_is_a_zombie() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        // The session is given the fake's own address, so that the connection
        // that comes back after the drop lands here and not on a name.
        gateway.push(vec![hello(60), ready("S1", &gateway.address)]);
        gateway.push(vec![hello(60)]);
        let discord = adapter(&rest, &gateway);
        // Half of the interval: long enough for the READY to be read, short
        // enough for the unacknowledged beat to come round.
        set_jitter(&discord, 500);
        start(&discord).await;
        // Without an ACK the socket is dropped rather than waited on, and the
        // next attempt resumes the session instead of identifying again.
        assert!(gateway.wait_for(6, 1).await, "la ripresa invece di un nuovo identify");
        let resume = gateway.op(6).expect("resume");
        assert_eq!(resume["d"]["session_id"], "S1");
    }

    #[tokio::test]
    async fn a_dropped_socket_is_resumed_and_a_cursor_is_kept_for_the_next_start() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        gateway.push(vec![hello(60), ready("SESSIONE", &gateway.address), closed(1001)]);
        gateway.push(vec![hello(60)]);
        let discord = adapter(&rest, &gateway);
        // Half of the interval, so the READY is read before anything drops.
        set_jitter(&discord, 500);
        start(&discord).await;
        assert!(gateway.wait_for(6, 1).await);
        let cursor = discord.cursor().expect("il cursore da salvare");
        let session: Session = serde_json::from_str(&cursor).expect("cursore leggibile");
        assert_eq!(session.session_id, "SESSIONE");
        assert_eq!(session.resume_url, gateway.address);
    }

    #[tokio::test]
    async fn a_cursor_handed_back_resumes_and_does_not_identify() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![vec![hello(60)]]);
        let cursor = serde_json::to_string(&Session {
            session_id: "S-VECCHIA".into(),
            seq: 40,
            resume_url: gateway.address.clone(),
            at_ms: 0,
        })
        .expect("cursore");
        let discord = Discord::at(&gateway.address, &rest.address, TOKEN, Some(cursor)).expect("adapter");
        set_jitter(&discord, 0);
        start(&discord).await;
        assert!(gateway.wait_for(6, 1).await);
        let resume = gateway.op(6).expect("resume");
        assert_eq!(resume["d"]["session_id"], "S-VECCHIA");
        assert_eq!(resume["d"]["seq"], 40);
        assert_eq!(gateway.op(2), None, "una sessione da riprendere non si identifica un'altra volta");
    }

    #[tokio::test]
    async fn a_session_too_old_is_not_resumed() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![vec![hello(60)]]);
        let cursor = serde_json::to_string(&Session {
            session_id: "S-MOLTO-VECCHIA".into(),
            seq: 3,
            resume_url: gateway.address.clone(),
            at_ms: 0,
        })
        .expect("cursore");
        let discord = Discord::at(&gateway.address, &rest.address, TOKEN, Some(cursor)).expect("adapter");
        // Now is far past the age a session is worth keeping.
        discord.now_ms.store(SESSION_MAX_AGE_MS * 10, Ordering::SeqCst);
        set_jitter(&discord, 0);
        start(&discord).await;
        assert!(gateway.wait_for(2, 1).await, "una sessione scaduta si identifica di nuovo");
    }

    #[tokio::test]
    async fn a_cursor_that_does_not_parse_is_treated_as_no_cursor() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![vec![hello(60)]]);
        let discord = Discord::at(&gateway.address, &rest.address, TOKEN, Some("{rotta".into())).expect("adapter");
        set_jitter(&discord, 0);
        start(&discord).await;
        assert!(gateway.wait_for(2, 1).await, "uno stato illeggibile non impedisce di partire");
    }

    #[tokio::test]
    async fn a_refused_token_stops_the_gateway_and_says_why() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![vec![hello(60), closed(4004)]]);
        let discord = adapter(&rest, &gateway);
        let text = discord.receive().await.err().expect("l'errore arriva").message();
        assert!(text.contains("rifiuta il token"), "{text}");
        assert!(!text.contains(TOKEN), "il token non compare: {text}");
    }

    #[tokio::test]
    async fn a_close_without_a_stop_code_is_tried_again() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        gateway.push(vec![hello(60), ready("S1", &gateway.address), closed(1001)]);
        gateway.push(vec![hello(60)]);
        let discord = adapter(&rest, &gateway);
        // Half of the interval, so the READY is read before the close.
        set_jitter(&discord, 500);
        // The gateway does not stop, so the read is still waiting for a message.
        let waiting = tokio::time::timeout(Duration::from_millis(300), discord.receive()).await;
        assert!(waiting.is_err(), "una chiusura da ritentare non ferma il gateway");
        // The reconnection takes a moment of its own, so the frame is waited for
        // rather than looked for straight away.
        assert!(gateway.wait_for(6, 1).await, "la ripresa, non un nuovo identify");
    }

    #[tokio::test]
    async fn a_message_from_the_socket_reaches_the_hub_as_it_is() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![vec![
            hello(60_000),
            ready("S1", "ws://x"),
            message("m1", "d1", 1, "u1", "ciao, sono qui"),
        ]]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 0);
        let batch = discord.receive().await.expect("un messaggio");
        assert_eq!(batch.len(), 1);
        let first = &batch[0];
        assert_eq!(first.id, "m1");
        assert_eq!(first.chat, "d1");
        assert_eq!(first.text, "ciao, sono qui");
        assert!(first.private);
        assert!(!first.mentioned);
        assert_eq!(first.sender.id, "u1");
        assert!(!first.sender.is_bot);
    }
}
