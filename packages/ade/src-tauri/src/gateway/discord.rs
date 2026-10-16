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
use super::authz;
use super::chunk;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

pub const API: &str = "https://discord.com/api/v10";
pub const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=10&encoding=json";
/// Discord counts characters, not UTF-16 units: an emoji is one.
pub const MAX_LEN: usize = 2000;

/// Appends Discord gateway protocol parameters (?v=10&encoding=json) if not already present.
fn with_gateway_params(url: &str) -> String {
    if url.contains("v=") && url.contains("encoding=") {
        return url.to_string();
    }
    let sep = if url.contains('?') {
        "&"
    } else if url.ends_with('/') {
        "?"
    } else {
        "/?"
    };
    format!("{url}{sep}v=10&encoding=json")
}

/// The scheme and the host (with a port, if any) of an address; `None` when it has a user part or no `://`.
fn scheme_and_authority(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), authority.to_ascii_lowercase()))
}

/// Whether the address Discord gave to resume a session may be followed (S14): `wss` on a host under `discord.gg`.
/// The address is read from a saved cursor and from `READY`, so it is data from outside, and a socket opened on it
/// would carry the bot's token (`IDENTIFY`/`RESUME`) to whoever answers. The address the adapter itself was made
/// with is its own as well (in production that is `gateway.discord.gg`; the tests' gateway is on this machine).
fn trusted_resume(url: &str, base: &str) -> bool {
    let Some((scheme, authority)) = scheme_and_authority(url) else { return false };
    if scheme_and_authority(base).is_some_and(|own| own == (scheme.clone(), authority.clone())) {
        return true;
    }
    let host = authority.strip_suffix(":443").unwrap_or(&authority);
    scheme == "wss"
        && host.len() > ".discord.gg".len()
        && host.ends_with(".discord.gg")
        && host.split('.').all(|label| !label.is_empty() && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
}

/// A Discord id for a path or an address: digits only (a snowflake is a 64-bit number), never anything that could
/// add a segment, a query or a way up (S14). The value comes from the page or from Discord, and `/channels/{chat}`
/// is built from it.
fn check_id<'a>(what: &str, value: &'a str) -> Result<&'a str, AdapterError> {
    if (1..=20).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit()) {
        Ok(value)
    } else {
        Err(AdapterError::Fatal(format!("{what} di Discord non valido: devono essere solo cifre")))
    }
}

/// Discord's message flag that keeps a message's links from being embedded.
const SUPPRESS_EMBEDS: u64 = 1 << 2;
/// Discord Developer Docs: Resources / Channel / Message / Message Flags:
/// `SUPPRESS_NOTIFICATIONS` = 1 << 12 (4096).
/// Do not include any notifications when the message is created (no sound/ping).
const SUPPRESS_NOTIFICATIONS: u64 = 1 << 12;
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
const USER_AGENT: &str = concat!("ragu-ade/", env!("CARGO_PKG_VERSION"), " (gateway)");

/// The intents this adapter asks for.
///
/// `GUILDS` (1 << 0) so the bot knows its channels, `GUILD_MESSAGES` (1 << 9)
/// for messages in them, `DIRECT_MESSAGES` (1 << 12) for private ones. The sum
/// is 4609, and `MESSAGE_CONTENT` (1 << 15) is left out on purpose: it is
/// privileged, and both a private message and a message that names the bot
/// arrive with their text without it. A test holds this number.
const INTENTS: u64 = (1 << 0) | (1 << 9) | (1 << 12);

/// What to do about a close code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// Go round again, resuming the session as it is.
    Again,
    /// Go round again with a **new** session: this one is spent, and resuming
    /// it would only be refused the same way.
    Fresh,
    /// Stop, and tell the user why, because trying again cannot help.
    Stop(&'static str),
}

/// Every close code of the Gateway event, what it means, and what is done
/// about it, from
/// <https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes>.
///
/// A code not on this list is treated as Verdict::Again: the cost is an
/// identify only when there is no session to resume with, and the budget above
/// stops that loop.
const CLOSE_CODES: &[(u16, &str, Verdict)] = &[
    (4000, "errore sconosciuto", Verdict::Again),
    (4001, "opcode sconosciuto", Verdict::Again),
    (4002, "errore nella decodifica", Verdict::Again),
    // A socket that authenticated nothing: another connection of ours may have
    // taken the session. Worth another go.
    (4003, "non autenticato", Verdict::Again),
    // The token is wrong, revoked, or belongs to no bot.
    (
        4004,
        "autenticazione fallita",
        Verdict::Stop("Discord rifiuta il token del bot: controllalo nella pagina del bot"),
    ),
    (4005, "già autenticato", Verdict::Again),
    // The sequence number was refused, so this session is spent.
    (4007, "numero di sequenza non valido", Verdict::Fresh),
    (4008, "troppo veloce, attento al rate limit", Verdict::Again),
    // The session expired on Discord's side: it will not be resumed.
    (4009, "sessione scaduta", Verdict::Fresh),
    (
        4010,
        "shard non valido",
        Verdict::Stop("Discord ha rifiutato lo shard del bot, e questo bot non ne chiede uno"),
    ),
    (
        4011,
        "shard obbligatorio",
        Verdict::Stop("Discord vuole che il bot sia diviso in shard, e questo bot gira su una connessione sola"),
    ),
    (
        4012,
        "versione della API non valida",
        Verdict::Stop("Discord ha rifiutato la versione della API con cui parlo: è un problema di ADE, non del tuo bot"),
    ),
    (
        4013,
        "intent non validi",
        Verdict::Stop("Discord ha rifiutato gli intent del bot: sono richiesti solo quelli di base, apri la pagina del bot e controlla"),
    ),
    // A privileged intent is off in the developer portal. This adapter asks for
    // none, so seeing it means the portal changed under it.
    (
        4014,
        "intent privilegiati non consentiti",
        Verdict::Stop(
            "Discord ha rifiutato gli intent del bot: nella pagina del bot gli intent privilegiati sono chiusi, e questo bot non ne chiede",
        ),
    ),
];

/// What a close code means in Discord's words, and what is done about it.
fn close_code(code: u16) -> (&'static str, Verdict) {
    match CLOSE_CODES.iter().find(|(known, _, _)| *known == code) {
        Some((_, what, verdict)) => (*what, *verdict),
        // A code nobody has written down is not a reason to give up.
        None => ("codice sconosciuto", Verdict::Again),
    }
}

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
            Failure::Api { status: 429, .. } => AdapterError::Flood(self.text()),
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
    description.contains("2000 or fewer")
        || (description.contains("50035") && description.to_lowercase().contains("content"))
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
fn nonce(seed: u64, seq: u64) -> String {
    format!("{:012x}{:08x}", seed & 0x0000_ffff_ffff_ffff, seq & 0xffff_ffff)
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
    /// The message currently being edited as live preview per chat.
    active_preview: Mutex<HashMap<String, String>>,
    /// Per-chat lock to serialize preview updates and sends.
    chat_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// Generation counter per chat, incremented at the end of each turn, to drop stale previews.
    chat_generations: Mutex<HashMap<String, u64>>,
    /// Bumped for every session, so an edit made before a drop does not write
    /// its text onto the message of the session that follows.
    epoch: AtomicU64,
    /// Set when a session reached `READY`, and taken by the loop that watches
    /// the identify budget: a socket that started is not a failed attempt, and
    /// the flag is what says so across the inner loop that set it.
    ready: AtomicBool,
    /// Random seed chosen when the adapter is born, to prevent nonce collisions after restarts.
    nonce_seed: u64,
    /// Monotonic sequence for message nonces to guarantee uniqueness across messages.
    nonce_counter: AtomicU64,
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

/// The adapter as the hub holds it. The socket task holds only the `Core`, so
/// when the hub lets go of this (the gateway switched off, a new token, ADE
/// closing) `alive` goes with it and the task closes its socket. It used to
/// hold the whole adapter, which kept itself alive: a gateway switched off
/// went on reading, and reconnecting, for nobody.
pub struct Discord {
    core: Arc<Core>,
    /// Dropped with the adapter; the socket task ends when it is.
    alive: watch::Sender<()>,
}

impl std::ops::Deref for Discord {
    type Target = Core;
    fn deref(&self) -> &Core {
        &self.core
    }
}

/// Everything but the life of the socket task, which the task shares.
pub struct Core {
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
    /// The first heartbeat waits this many thousandths of the interval, so a
    /// share of it: 1000 is the whole interval, 0 is none. Discord disconnects
    /// a client that heartbeats at once, and a test has to be able to predict
    /// the wait, so the share is a field and not a draw.
    jitter: AtomicU64,
    /// Epoch milliseconds, so a test can write a cursor of a chosen age.
    #[cfg(test)]
    now_ms: AtomicU64,
    #[cfg(test)]
    now_step_ms: AtomicU64,
}

fn real_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

fn random_nonce_seed() -> u64 {
    let mut buf = [0u8; 8];
    let _ = authz::os_random(&mut buf);
    let random_val = u64::from_le_bytes(buf);
    let ms = real_now_ms();
    ms.wrapping_mul(0x517c_c1b7_2722_0a95) ^ random_val
}

impl Discord {
    /// The adapter for the bot with `token`, reading on from `cursor`.
    pub fn new(token: &str, cursor: Option<String>) -> Result<Arc<Discord>, String> {
        Discord::at(GATEWAY_URL, API, token, cursor)
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
        let core = Arc::new(Core {
            api: api.to_string(),
            socket: socket.to_string(),
            token: token.to_string(),
            calls,
            shared: Arc::new(Shared {
                session: Mutex::new(session),
                bot: Mutex::new(None),
                cursor: Mutex::new(cursor),
                preview: Mutex::new(HashMap::new()),
                active_preview: Mutex::new(HashMap::new()),
                chat_locks: Mutex::new(HashMap::new()),
                chat_generations: Mutex::new(HashMap::new()),
                epoch: AtomicU64::new(0),
                ready: AtomicBool::new(false),
                nonce_seed: random_nonce_seed(),
                nonce_counter: AtomicU64::new(0),
            }),
            inbox: tokio::sync::Mutex::new(inbox),
            sender,
            started: AtomicBool::new(false),
            jitter: AtomicU64::new(500),
            #[cfg(test)]
            now_ms: AtomicU64::new(0),
            #[cfg(test)]
            now_step_ms: AtomicU64::new(0),
        });
        Ok(Arc::new(Discord { core, alive: watch::channel(()).0 }))
    }
}

impl Core {
    fn chat_lock(&self, chat: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = hold(&self.shared.chat_locks);
        locks.entry(chat.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }

    fn now(&self) -> u64 {
        #[cfg(test)]
        {
            let step = self.now_step_ms.load(Ordering::SeqCst);
            if step > 0 {
                self.now_ms.fetch_add(step, Ordering::SeqCst)
            } else {
                self.now_ms.load(Ordering::SeqCst)
            }
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
            if !described["errors"].is_null() {
                description = format!("{description}: {}", described["errors"]);
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

    /// One message, with nothing in it Discord would read as a mention, and
    /// no embed: `SUPPRESS_EMBEDS` (security review, ALTO A1). Discord fetches
    /// a link in a message to embed it as soon as the message is posted, so a
    /// URL in an agent's reply, one a prompt injection put there with data in
    /// its query included, was fetched without anyone clicking it.
    fn body(text: &str) -> Value {
        json!({ "content": text, "allowed_mentions": { "parse": [] }, "flags": SUPPRESS_EMBEDS })
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

    async fn delete(&self, chat: &str, message_id: &str) -> Result<(), Failure> {
        self.call_patiently(reqwest::Method::DELETE, &format!("/channels/{chat}/messages/{message_id}"), None)
            .await
            .map(|_| ())
    }

    /// Sends `text` in pieces, stopping at the ceiling, and returns the id of
    /// the message that now holds the end of it.
    async fn send_all(&self, chat: &str, text: &str, extra: Option<&Value>, final_turn: bool) -> Result<String, AdapterError> {
        check_id("il canale", chat)?;
        let lock = self.chat_lock(chat);
        let _guard = lock.lock().await;
        let seed = self.shared.nonce_seed.wrapping_add(self.shared.epoch.load(Ordering::SeqCst));
        if final_turn {
            *hold(&self.shared.chat_generations).entry(chat.to_string()).or_default() += 1;
        }
        let existing_preview = if final_turn {
            hold(&self.shared.active_preview).remove(chat)
        } else {
            None
        };

        let post_result = async {
            let mut queue: VecDeque<String> = pieces(text).into();
            if queue.is_empty() {
                return Err(AdapterError::Fatal("il messaggio è vuoto".into()));
            }
            let mut last = String::new();
            while let Some(piece) = queue.pop_front() {
                let mut body = Core::body(&piece);
                if !queue.is_empty() {
                    body["flags"] = json!(SUPPRESS_EMBEDS | SUPPRESS_NOTIFICATIONS);
                }
                let seq = self.shared.nonce_counter.fetch_add(1, Ordering::SeqCst);
                // The same nonce for every try at one piece: a repeat returns the
                // message already posted instead of posting it twice.
                body["nonce"] = Value::from(nonce(seed, seq));
                body["enforce_nonce"] = json!(true);
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
                // The id comes from Discord's answer and goes into a path.
                check_id("il messaggio", &last)?;
                // The buttons go on the last message, whatever the text became.
                // A patch without a content leaves the text as it is.
                let body = json!({ "components": extra["components"].clone(), "allowed_mentions": { "parse": [] }, "flags": SUPPRESS_EMBEDS });
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
            Ok(last)
        }
        .await;

        let last = match post_result {
            Ok(last) => last,
            Err(err) => {
                if let Some(preview_id) = existing_preview {
                    hold(&self.shared.active_preview).insert(chat.to_string(), preview_id);
                }
                return Err(err);
            }
        };

        if let Some(preview_id) = existing_preview {
            if self.delete(chat, &preview_id).await.is_err() {
                let _ = self.edit(chat, &preview_id, "(risposta inviata sotto)").await;
            }
        }
        chunk::remember(&mut hold(&self.shared.preview), format!("{chat}/{last}"), text.to_string());
        Ok(last)
    }

    async fn edit(&self, chat: &str, message: &str, text: &str) -> Result<String, AdapterError> {
        check_id("il canale", chat)?;
        check_id("il messaggio", message)?;
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
        let body = Core::body(first);
        if let Err(failure) = self
            .call_patiently(
                reqwest::Method::PATCH,
                &format!("/channels/{chat}/messages/{message}"),
                Some(&body),
            )
            .await
        {
            let unchanged = matches!(&failure, Failure::Api { description, .. } if description.contains("not modified"));
            if !unchanged {
                return Err(failure.for_sending());
            }
        }
        chunk::remember(&mut hold(&self.shared.preview), key, text.to_string());
        Ok(message.to_string())
    }
}

/// How long a Discord session must stay connected/greeted before
/// a disconnect resets the reconnection backoff to 1 second (N-A2).
/// Below this duration (e.g. repeated immediate 4007/4009 disconnects),
/// the backoff continues to double up to 300 seconds to protect the token
/// from being revoked by Discord's 1000 identifies/day limit.
const LIVE_SESSION_RESET_MS: u64 = 30_000;

/// How a socket session ended.
enum Ending {
    /// Stop, and tell the user why.
    Stopped(String),
    /// The socket dropped: go round again.
    Dropped { greeted: bool, reset_backoff: bool },
    /// The adapter is gone, the gateway switched off: the socket said goodbye.
    LetGo,
}

/// Closes the socket as a client that is leaving, with a 1000: Discord ends
/// the session and the bot shows offline at once. Only when the gateway is
/// switched off: a 1000 also makes the session one that cannot be resumed,
/// so a socket that drops to come back just goes, without it. At most a
/// second, so a peer that does not read cannot hold the task.
async fn say_goodbye<S: SinkExt<Message> + Unpin>(sink: &mut S) {
    let close = Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: "".into() }));
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.send(close)).await;
}

/// One run of the socket: connect, resume or identify, read, heartbeat, until
/// the socket closes or the user is told why it cannot go on.
async fn socket_session(
    adapter: &Arc<Core>,
    sender: &mpsc::Sender<Result<Inbound, AdapterError>>,
    first: &str,
    alive: &mut watch::Receiver<()>,
) -> Ending {
    let mut fresh_identifies = 0usize;
    let mut greeted = false;
    let mut greeted_at: Option<u64> = None;
    let finish_dropped = |greeted: bool, greeted_at: Option<u64>| {
        let reset_backoff = greeted_at.is_some_and(|at| adapter.now().saturating_sub(at) >= LIVE_SESSION_RESET_MS);
        Ending::Dropped { greeted, reset_backoff }
    };
    loop {
        // Read at every turn, not once at the start: a session that lives for
        // days has to age, or a cursor from yesterday still looks resumable.
        let now = adapter.now();
        // A session that came up puts the count of failed attempts back to
        // zero: what the budget is there to stop is a socket that never starts.
        if adapter.shared.take_ready() {
            fresh_identifies = 0;
            greeted = true;
            if greeted_at.is_none() {
                greeted_at = Some(adapter.now());
            }
        }
        if fresh_identifies > MAX_IDENTIFIES_WITHOUT_READY {
            return Ending::Stopped(format!(
                "Discord ha chiuso la connessione {MAX_IDENTIFIES_WITHOUT_READY} volte di fila prima di un avvio: il gateway resta fermo, e i tentativi non sono infiniti per non esaurire il limite di mille avvii al giorno"
            ));
        }
        let (address, resume) = match adapter.shared.resumable(now) {
            // The address to resume on is not Discord's (a saved cursor can say anything): it is not followed and
            // the session is dropped, so this turn spends an identify on the base address (S14).
            Some(session) if !trusted_resume(&session.resume_url, first) => {
                adapter.shared.forget_session();
                let _ = sender
                    .send(Err(AdapterError::Transient(
                        "Discord: l'indirizzo per riprendere la sessione non è di Discord, quindi non lo seguo: la sessione riparte da zero"
                            .into(),
                    )))
                    .await;
                fresh_identifies += 1;
                (with_gateway_params(first), None)
            }
            Some(session) => (with_gateway_params(&session.resume_url), Some(session)),
            // Nothing to resume with, so this turn spends an identify.
            None => {
                fresh_identifies += 1;
                (with_gateway_params(first), None)
            }
        };
        let connected = tokio::select! {
            // The adapter is gone, and `alive` with it: nothing is open yet.
            _ = alive.changed() => return Ending::LetGo,
            connected = tokio_tungstenite::connect_async(&address) => connected,
        };
        let (mut sink, mut source) = match connected {
            Ok((socket, _handshake)) => socket.split(),
            Err(error) => {
                let _ = sender.send(Err(AdapterError::Transient(format!("Discord non raggiungibile: {error}")))).await;
                return finish_dropped(greeted, greeted_at);
            }
        };

        // The first frame is the Hello, which carries the heartbeat interval.
        // A socket that goes before the Hello leaves `hello` unset, and the
        // connection is one to go round on rather than to give up on.
        let hello: Option<Frame> = loop {
            let incoming = tokio::select! {
                _ = alive.changed() => {
                    say_goodbye(&mut sink).await;
                    return Ending::LetGo;
                }
                incoming = source.next() => incoming,
            };
            let Some(incoming) = incoming else { break None };
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
            return finish_dropped(greeted, greeted_at);
        }

        // The first heartbeat waits a share of the interval, since a client
        // that heartbeats at once is disconnected; every one after it waits the
        // whole interval. The share used to be the period of every beat, so
        // with a small share the socket beat every millisecond, and against a
        // server slow to acknowledge it looked dead and was dropped with the
        // frames still unread (the Discord test that failed one run in fifteen).
        let share = adapter.jitter.load(Ordering::SeqCst).min(1000);
        let wait = Duration::from_millis(interval * share / 1000).max(Duration::from_millis(1));
        let period = Duration::from_millis(interval.max(1));
        let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + wait, period);
        beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut acked = true;

        loop {
            tokio::select! {
                _ = alive.changed() => {
                    say_goodbye(&mut sink).await;
                    return Ending::LetGo;
                }
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
                            let Some(CloseFrame { code, .. }) = close else { break };
                            return match close_code(u16::from(code)).1 {
                                Verdict::Stop(why) => Ending::Stopped(why.to_string()),
                                // The session is spent: resuming it again would
                                // be refused the same way.
                                Verdict::Fresh => {
                                    adapter.shared.forget_session();
                                    finish_dropped(greeted, greeted_at)
                                }
                                Verdict::Again => finish_dropped(greeted, greeted_at),
                            };
                        }
                        Message::Ping(payload) => {
                            let _ = sink.send(Message::Pong(payload)).await;
                        }
                        Message::Text(text) => {
                            let Ok(frame) = serde_json::from_str::<Frame>(text.as_ref()) else { continue };
                            if let Some(seq) = frame.s {
                                adapter.shared.note_seq(seq);
                            }
                            // On the opcode first: only a dispatch carries the
                            // name of an event. HEARTBEAT, RECONNECT,
                            // INVALID_SESSION and HEARTBEAT_ACK arrive with a
                            // null event, and reading them by name meant the
                            // acknowledgement never arrived, so every socket
                            // looked dead at the second beat.
                            match frame.op {
                                // A dispatch, named by its event.
                                0 => {
                                    let kind = frame.t.clone().unwrap_or_default();
                                    match kind.as_str() {
                                        "READY" => {
                                            let session_id =
                                                frame.d["session_id"].as_str().unwrap_or_default().to_string();
                                            if !session_id.is_empty() {
                                                if let Some(id) = id_text(&frame.d["user"]["id"]) {
                                                    *hold(&adapter.shared.bot) = Some(id);
                                                }
                                                let resume_url = frame.d["resume_gateway_url"]
                                                    .as_str()
                                                    .unwrap_or(&address)
                                                    .to_string();
                                                adapter.shared.remember(Session {
                                                    session_id,
                                                    seq: 0,
                                                    resume_url,
                                                    at_ms: adapter.now(),
                                                });
                                            }
                                            adapter.shared.mark_ready();
                                            greeted = true;
                                            if greeted_at.is_none() {
                                                greeted_at = Some(adapter.now());
                                            }
                                        }
                                        "RESUMED" => {
                                            adapter.shared.mark_ready();
                                            greeted = true;
                                            if greeted_at.is_none() {
                                                greeted_at = Some(adapter.now());
                                            }
                                        }
                                        "MESSAGE_CREATE" => {
                                            if let Some(inbound) = to_inbound(&frame.d, &adapter.shared, frame.s) {
                                                if sender.send(Ok(inbound)).await.is_err() {
                                                    break;
                                                }
                                            }
                                        }
                                        "INTERACTION_CREATE" => {
                                            let cursor = frame.s.and_then(|s| {
                                                hold(&adapter.shared.session).clone().and_then(|mut sess| {
                                                    sess.seq = s;
                                                    serde_json::to_string(&sess).ok()
                                                })
                                            });
                                            if let Some(press) = to_press(&frame.d, cursor) {
                                                // Answered here, on the spot: Discord
                                                // wants the confirmation within three
                                                // seconds, and the hub may be busy.
                                                if let Some((path, body)) = confirm_press(&frame.d) {
                                                    let _ =
                                                        adapter.call(reqwest::Method::POST, &path, Some(&body)).await;
                                                }
                                                let _ = sender.send(Ok(press)).await;
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                // Discord asking for a beat at once: it is about
                                // to drop this socket, so the answer goes now.
                                1 => {
                                    if sink.send(Message::Text(json!({ "op": 1, "d": null }).to_string().into())).await.is_err() {
                                        break;
                                    }
                                    acked = false;
                                }
                                // Discord wants the socket back: reconnect and
                                // resume, which is what the outer loop does.
                                7 => break,
                                // The session is no longer good. A false in the
                                // payload means it cannot be resumed at all.
                                9 => {
                                    let resumable = frame.d.as_bool().unwrap_or(false);
                                    if !resumable {
                                        adapter.shared.forget_session();
                                    }
                                    // Discord asks for one to five seconds
                                    // before trying again, so that a gateway
                                    // that is restarting is not hammered.
                                    tokio::time::sleep(Duration::from_millis(1000)).await;
                                    break;
                                }
                                // The beat arrived: the socket is alive.
                                11 => acked = true,
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
/// between that grows, so a gateway that is down is not hammered. It ends, and
/// its socket with it, when the adapter is dropped.
async fn run_socket(
    adapter: Arc<Core>,
    sender: mpsc::Sender<Result<Inbound, AdapterError>>,
    first: String,
    mut alive: watch::Receiver<()>,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        // The session watches `alive` itself, to close its socket with a goodbye.
        match socket_session(&adapter, &sender, &first, &mut alive).await {
            Ending::LetGo => return,
            Ending::Stopped(why) => {
                let _ = sender.send(Err(AdapterError::Fatal(why))).await;
                return;
            }
            Ending::Dropped { greeted: _, reset_backoff } => {
                if reset_backoff {
                    backoff = Duration::from_secs(1);
                }
                tokio::select! {
                    _ = alive.changed() => return,
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(Duration::from_secs(300));
            }
        }
    }
}

/// A message as the hub sees it, or `None` for what the gateway does not take.
fn to_inbound(d: &Value, shared: &Shared, seq: Option<i64>) -> Option<Inbound> {
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
    let cursor = seq.and_then(|s| {
        hold(&shared.session).clone().and_then(|mut sess| {
            sess.seq = s;
            serde_json::to_string(&sess).ok()
        })
    });
    Some(Inbound {
        id: id_text(&d["id"])?,
        chat,
        // A direct message is a conversation the user opened, and it belongs to
        // no guild; a channel needs the bot named in it, or the bot would
        // answer a room it sits in.
        private: d["guild_id"].is_null(),
        mentioned: shared.bot_id().is_some_and(|id| names_bot(text, &id)),
        sender: Sender {
            id: id_text(&author["id"])?,
            name,
            // Another bot, this one included, and anything a webhook posted.
            is_bot: author["bot"].as_bool().unwrap_or(false) || !d["webhook_id"].is_null(),
        },
        text: text.to_string(),
        button: false,
        cursor,
        timestamp_ms: None,
    })
}

/// The confirmation an interaction has to be given: Discord expects one
/// within three seconds, and shows «Interazione non riuscita» without it.
///
/// The token in the path is a temporary credential, so it goes nowhere else:
/// not in a log, not in an error.
///
/// Returns the path to post to and the body to post.
fn confirm_press(d: &Value) -> Option<(String, Value)> {
    let id = id_text(&d["id"])?;
    let token = d["token"].as_str()?;
    // Both go into the path of the answer: an id of digits, a token of the characters Discord's are made of.
    if check_id("l'interazione", &id).is_err()
        || token.is_empty()
        || !token.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    {
        return None;
    }
    // 6 is DEFERRED_UPDATE_MESSAGE: the button is answered, the message stays
    // as it is for ADE to edit later.
    Some((format!("/interactions/{id}/{token}/callback"), json!({ "type": 6 })))
}

/// A button press: not a message, and the data comes back as the text.
fn to_press(d: &Value, cursor: Option<String>) -> Option<Inbound> {
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
        // An interaction has no channel type of its own: what tells a private
        // chat is that it belongs to no guild.
        private: d["guild_id"].is_null(),
        mentioned: false,
        sender: Sender { id: id_text(&who["id"])?, name, is_bot: false },
        text: data.to_string(),
        button: true,
        cursor,
        timestamp_ms: None,
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
            let (core, alive) = (self.core.clone(), self.alive.subscribe());
            let sender = self.sender.clone();
            let first = self.socket.clone();
            tokio::spawn(async move { run_socket(core, sender, first, alive).await });
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
        self.send_with(chat, text, false).await
    }

    async fn send_with(&self, chat: &str, text: &str, final_turn: bool) -> Result<String, AdapterError> {
        self.send_all(chat, text, None, final_turn).await
    }

    async fn send_buttons(&self, chat: &str, text: &str, buttons: &[Button]) -> Result<String, AdapterError> {
        let components: Vec<Value> = buttons
            .chunks(5)
            .take(5)
            .map(|row| {
                let row: Vec<Value> = row
                    .iter()
                    .map(|button| json!({ "type": 2, "style": 1, "label": button.label, "custom_id": button.data }))
                    .collect();
                json!({ "type": 1, "components": row })
            })
            .collect();
        self.send_all(chat, text, Some(&json!({ "components": components })), false).await
    }

    async fn preview_end(&self, chat: &str) -> Result<(), AdapterError> {
        check_id("il canale", chat)?;
        let lock = self.chat_lock(chat);
        let _guard = lock.lock().await;
        *hold(&self.shared.chat_generations).entry(chat.to_string()).or_default() += 1;
        let existing = hold(&self.shared.active_preview).remove(chat);
        if let Some(msg_id) = existing {
            if self.delete(chat, &msg_id).await.is_err() {
                let _ = self.edit(chat, &msg_id, "(interrotto)").await;
            }
        }
        Ok(())
    }

    async fn edit(&self, chat: &str, message: &str, text: &str) -> Result<String, AdapterError> {
        self.core.edit(chat, message, text).await
    }

    async fn typing(&self, chat: &str) -> Result<(), AdapterError> {
        check_id("il canale", chat)?;
        self.call_patiently(reqwest::Method::POST, &format!("/channels/{chat}/typing"), Some(&json!({})))
            .await
            .map(|_| ())
            .map_err(Failure::for_sending)
    }

    async fn preview(&self, chat: &str, text: &str) -> Result<(), AdapterError> {
        check_id("il canale", chat)?;
        let gen = hold(&self.shared.chat_generations).get(chat).copied().unwrap_or(0);
        let lock = self.chat_lock(chat);
        let _guard = lock.lock().await;
        if hold(&self.shared.chat_generations).get(chat).copied().unwrap_or(0) != gen {
            return Ok(());
        }
        let existing = hold(&self.shared.active_preview).get(chat).cloned();
        match existing {
            Some(msg_id) => {
                self.edit(chat, &msg_id, text).await.map(|_| ())
            }
            None => {
                let pieces_vec = pieces(text);
                let Some(first) = pieces_vec.first() else {
                    return Err(AdapterError::Fatal("il messaggio è vuoto".into()));
                };
                let mut body = Core::body(first);
                // Discord Developer Docs: Resources / Channel / Message / Message Flags:
                // SUPPRESS_NOTIFICATIONS = 1 << 12 (4096).
                // "Do not include any notifications when the message is created (no sound/ping)."
                body["flags"] = json!(SUPPRESS_EMBEDS | SUPPRESS_NOTIFICATIONS);
                let seed = self.shared.nonce_seed.wrapping_add(self.shared.epoch.load(Ordering::SeqCst));
                let seq = self.shared.nonce_counter.fetch_add(1, Ordering::SeqCst);
                body["nonce"] = Value::from(nonce(seed, seq));
                body["enforce_nonce"] = json!(true);
                let id = self.post(chat, &body).await.map_err(Failure::for_sending)?;
                if hold(&self.shared.chat_generations).get(chat).copied().unwrap_or(0) != gen {
                    return Ok(());
                }
                hold(&self.shared.active_preview).insert(chat.to_string(), id.clone());
                chunk::remember(&mut hold(&self.shared.preview), format!("{chat}/{id}"), first.to_string());
                Ok(())
            }
        }
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
        acking: Arc<AtomicBool>,
        /// A connection the client closed before the fake's own time ran out.
        left: Arc<AtomicBool>,
        /// The code of the close frame the client sent, if it sent one.
        goodbye: Arc<Mutex<Option<u16>>>,
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
            let acking = Arc::new(AtomicBool::new(false));
            let for_the_fake = acking.clone();
            let left = Arc::new(AtomicBool::new(false));
            let for_the_test = left.clone();
            let goodbye = Arc::new(Mutex::new(None));
            let goodbye_seen = goodbye.clone();
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
                    let acking = acking.clone();
                    let left = left.clone();
                    let goodbye = goodbye.clone();
                    // One connection at a time: the client reconnects after the
                    // one before it is gone.
                    runtime.block_on(async move {
                        let Ok(stream) = tokio::net::TcpStream::from_std(stream) else { return };
                        let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
                        let (mut sink, mut source) = socket.split();
                        // One list per connection: the frames for the next one
                        // are still waiting for the next one.
                        let frames = queue.lock().unwrap().pop_front().unwrap_or_default();
                        for frame in frames {
                            if sink.send(frame).await.is_err() {
                                return;
                            }
                        }
                        // Then read and answer for a while: the client answers
                        // the Hello, resumes or identifies, and beats, and this
                        // is where a beat gets its op 11 the way Discord sends
                        // it. One loop, because the writer has to be here to
                        // answer and the reader has to be here to see.
                        let until = tokio::time::Instant::now() + Duration::from_millis(900);
                        loop {
                            tokio::select! {
                                incoming = source.next() => {
                                    let Some(Ok(frame)) = incoming else {
                                        left.store(true, Ordering::SeqCst);
                                        break;
                                    };
                                    if let Ws::Close(Some(close)) = &frame {
                                        *goodbye.lock().unwrap() = Some(u16::from(close.code));
                                    }
                                    let Ws::Text(text) = frame else { continue };
                                    let Ok(parsed) = serde_json::from_str::<Value>(text.as_ref()) else { continue };
                                    if parsed["op"].as_i64() == Some(1) && acking.load(Ordering::SeqCst) {
                                        let ack = json!({ "op": 11, "d": null, "t": null, "s": null });
                                        if sink.send(Ws::Text(ack.to_string().into())).await.is_err() {
                                            break;
                                        }
                                    }
                                    seen.lock().unwrap().push(parsed);
                                }
                                _ = tokio::time::sleep_until(until) => break,
                            }
                        }
                        // The stream is split, so this is the sink's own close.
                        let _ = sink.close().await;
                    });
                }
            });
            FakeGateway { address, seen, queue: mine, acking: for_the_fake, left: for_the_test, goodbye: goodbye_seen }
        }

        /// Says what the next connection will be sent.
        fn push(&self, frames: Vec<Ws>) {
            self.queue.lock().unwrap().push_back(frames);
        }

        /// Whether a connection answers every beat with an op 11, as Discord
        /// does. Without it a socket looks dead at the second beat, which is
        /// what the old tests were really measuring.
        fn acking(&self, on: bool) {
            self.acking.store(on, Ordering::SeqCst);
        }

        fn frames(&self) -> Vec<Value> {
            hold(&self.seen).clone()
        }

        /// Whether the client closed a connection before the fake did.
        fn client_left(&self) -> bool {
            self.left.load(Ordering::SeqCst)
        }

        /// The code the client closed a connection with, if it said one.
        fn goodbye(&self) -> Option<u16> {
            *self.goodbye.lock().unwrap()
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

    /// A message as Discord sends it. `guild` is the server it was written
    /// in, and a direct message has none: that is what tells the two apart.
    fn message(id: &str, channel: &str, guild: Option<&str>, author: &str, text: &str) -> Ws {
        Ws::Text(
            json!({ "op": 0, "t": "MESSAGE_CREATE", "s": 2, "d": {
                "id": id, "channel_id": channel,
                "guild_id": guild.map(Value::from).unwrap_or(Value::Null),
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
            active_preview: Mutex::new(HashMap::new()),
            chat_locks: Mutex::new(HashMap::new()),
            chat_generations: Mutex::new(HashMap::new()),
            epoch: AtomicU64::new(0),
            ready: AtomicBool::new(false),
            nonce_seed: 0,
            nonce_counter: AtomicU64::new(0),
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
            "id": "c1", "channel_id": "4001", "guild_id": "9001",
            "content": "ciao <@42>", "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        let named = to_inbound(&named, &shared, None).expect("messaggio");
        assert!(named.mentioned, "una menzione in un canale abilita il canale");
        assert!(!named.private);
        assert!(admits(&named));

        let quiet: Value = json!({
            "id": "c2", "channel_id": "4001", "guild_id": "9001",
            "content": "si parla di altro", "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        let quiet = to_inbound(&quiet, &shared, None).expect("messaggio");
        assert!(!quiet.mentioned);
        assert!(!admits(&quiet), "senza menzione il canale non e' per il bot");

        let direct: Value = json!({
            "id": "c3", "channel_id": "d1", "guild_id": Value::Null,
            "content": "ciao", "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        let direct = to_inbound(&direct, &shared, None).expect("messaggio");
        assert!(direct.private);
        assert!(admits(&direct), "una chat privata non ha bisogno di menzione");
    }

    #[test]
    fn a_quote_of_the_bot_is_not_taken_for_a_mention() {
        // The mention list would have the bot in it, the text has not: two bots
        // that trust the list answer each other for ever.
        let shared = shared();
        let quoted: Value = json!({
            "id": "c9", "channel_id": "4001", "guild_id": "9001",
            "content": "come stai?",
            "mentions": [{ "id": BOT }],
            "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        assert!(!to_inbound(&quoted, &shared, None).expect("messaggio").mentioned);
    }

    #[test]
    fn a_bot_and_a_webhook_are_never_answered() {
        let shared = shared();
        let from_bot: Value = json!({
            "id": "b1", "channel_id": "d1", "content": "ciao",
            "author": { "id": "u2", "username": "robot", "bot": true },
        });
        assert!(to_inbound(&from_bot, &shared, None).expect("messaggio").sender.is_bot);
        let from_hook: Value = json!({
            "id": "b2", "channel_id": "d1", "content": "ciao",
            "webhook_id": "w1", "author": { "id": "u3", "username": "hook", "bot": false },
        });
        assert!(to_inbound(&from_hook, &shared, None).expect("messaggio").sender.is_bot);
    }

    #[test]
    fn a_message_without_text_is_not_a_message() {
        let shared = shared();
        // Without MESSAGE_CONTENT a guild message the bot was not named in
        // arrives with no text at all: it must not become an empty turn.
        let empty: Value = json!({
            "id": "m2", "channel_id": "4001", "guild_id": "9001", "content": "",
            "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        assert!(to_inbound(&empty, &shared, None).is_none());
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
        discord.send("4001", &"a".repeat(4500)).await.expect("inviato");
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
        discord.send("4001", "@everyone @here guardate questo").await.expect("inviato");
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
        let last = discord.send("4001", &text).await.expect("inviato");
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
        discord.send("4001", &text).await.expect("inviato");
        for nth in 0..2 {
            let content = rest.body_of(nth)["content"].as_str().unwrap_or_default().to_string();
            assert_eq!(content.matches("```").count() % 2, 0, "fence aperto in un pezzo: {content}");
        }
    }

    #[tokio::test]
    async fn discord_says_the_text_is_too_long_and_the_piece_is_cut_in_two() {
        let rest = FakeRest::start(vec![
            refused(&json!({
                "code": 50035,
                "message": "Invalid Form Body",
                "errors": {
                    "content": {
                        "_errors": [
                            {
                                "code": "BASE_TYPE_MAX_LENGTH",
                                "message": "Must be 2000 or fewer in length."
                            }
                        ]
                    }
                }
            }).to_string()),
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "2" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        // Short enough for the adapter's own count, and Discord says otherwise:
        // the platform is the one that decides the limit.
        let last = discord.send("4001", &"c".repeat(1900)).await.expect("inviato");
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
        let last = discord.send("4001", "ciao").await.expect("inviato");
        assert_eq!(last, "9");
        assert_eq!(rest.count(), 2, "il 429 e poi il tentativo");
        let first = nonce_of(&rest.body_of(0));
        let second = nonce_of(&rest.body_of(1));
        assert_eq!(first, second, "il nonce resta lo stesso fra un tentativo e l'altro");
    }

    #[tokio::test]
    async fn nonce_is_under_twenty_five_chars_enforces_nonce_and_differs_across_messages() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "2" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        discord.send("4001", "msg1").await.expect("inviato 1");
        discord.send("4001", "msg2").await.expect("inviato 2");

        let body1 = rest.body_of(0);
        let body2 = rest.body_of(1);

        let nonce1 = body1["nonce"].as_str().expect("nonce1 presente");
        let nonce2 = body2["nonce"].as_str().expect("nonce2 presente");

        assert!(nonce1.len() <= 25, "nonce1 length {} <= 25", nonce1.len());
        assert!(nonce2.len() <= 25, "nonce2 length {} <= 25", nonce2.len());
        assert_eq!(body1["enforce_nonce"], json!(true));
        assert_eq!(body2["enforce_nonce"], json!(true));
        assert_ne!(nonce1, nonce2, "nonces must differ across separate messages");
    }

    #[tokio::test]
    async fn two_adapters_simulating_a_restart_generate_different_nonces_on_first_message() {
        let rest1 = FakeRest::start(vec![ok(&json!({ "id": "1" }).to_string())]);
        let gateway1 = FakeGateway::start(vec![]);
        let discord1 = adapter(&rest1, &gateway1);
        discord1.send("4001", "msg").await.expect("inviato 1");
        let nonce1 = rest1.body_of(0)["nonce"].as_str().unwrap().to_string();

        let rest2 = FakeRest::start(vec![ok(&json!({ "id": "2" }).to_string())]);
        let gateway2 = FakeGateway::start(vec![]);
        let discord2 = adapter(&rest2, &gateway2);
        discord2.send("4001", "msg").await.expect("inviato 2");
        let nonce2 = rest2.body_of(0)["nonce"].as_str().unwrap().to_string();

        assert_ne!(nonce1, nonce2, "due adapter che simulano un riavvio devono produrre nonce diversi al primo messaggio");
    }

    #[test]
    fn gateway_url_and_resume_url_include_v10_and_json_encoding() {
        let discord = Discord::new(TOKEN, None).expect("discord");
        assert!(discord.core.socket.contains("v=10"), "initial gateway URL must specify API v10");
        assert!(discord.core.socket.contains("encoding=json"), "initial gateway URL must specify json encoding");

        let formatted = with_gateway_params("wss://us-east1.gateway.discord.gg");
        assert_eq!(formatted, "wss://us-east1.gateway.discord.gg/?v=10&encoding=json");

        let already_formatted = with_gateway_params("wss://gateway.discord.gg/?v=10&encoding=json");
        assert_eq!(already_formatted, "wss://gateway.discord.gg/?v=10&encoding=json");
    }

    #[tokio::test]
    async fn no_message_the_bot_writes_lets_discord_embed_its_links() {
        // Security review, ALTO A1: an embed is Discord fetching the URL as the message is posted, no click needed.
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "2" }).to_string()),
            ok(&json!({ "id": "2" }).to_string()),
            ok(&json!({ "id": "1" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        let link = "guarda https://esempio.invalid/?dati=segreti";
        discord.send("4001", link).await.expect("inviato");
        discord.send_buttons("4001", link, &[Button { label: "Si'".into(), data: "si".into() }]).await.expect("inviato");
        discord.edit("4001", "1", &format!("{link} e ancora")).await.expect("modificato");
        assert_eq!(rest.count(), 4, "un invio, un invio con la patch dei pulsanti, una modifica");
        for nth in 0..rest.count() {
            let body = rest.body_of(nth);
            assert_eq!(body["flags"], json!(4), "{body}");
        }
    }

    #[tokio::test]
    async fn an_edit_that_changes_nothing_is_not_sent() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "1" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        let last = discord.send("4001", "prima versione").await.expect("inviato");
        discord.edit("4001", &last, "una versione nuova").await.expect("modificato");
        let after_first = rest.count();
        discord.edit("4001", &last, "una versione nuova").await.expect("modificato");
        assert_eq!(rest.count(), after_first, "lo stesso testo non viaggia: ogni modifica costa un posto nel limite");
    }

    #[tokio::test]
    async fn a_long_edit_moves_only_its_first_piece() {
        // An edit is the live text. Posting the rest on every call would put one
        // message more in the channel each time the text grows, which with a
        // streaming preview is a flood. What does not fit goes out once, at the
        // end of the turn, with the sending call.
        let rest = FakeRest::start(vec![ok("{}"), ok(&json!({ "id": "8" }).to_string())]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        let last = discord.edit("4001", "7", &"d".repeat(4500)).await.expect("modificato");
        assert_eq!(rest.count(), 1, "una modifica e nient'altro");
        assert_eq!(last, "7", "l'id non cambia: e' la stessa risposta che si aggiorna");
        assert!(rest.requests()[0].0.contains("PATCH"));
        let body = rest.body_of(0);
        let content = body["content"].as_str().unwrap_or_default();
        assert!(characters(content) <= MAX_LEN, "il pezzo mandato resta nel limite");
    }

    /// A press as Discord sends it, with the fields the documents give it:
    /// an id, a token, the guild it happened in, and the author either under
    /// `member` in a server or directly in a private chat.
    fn interaction(guild: bool) -> Value {
        let who = json!({ "id": "u1", "username": "qualcuno", "global_name": "Qualcuno" });
        json!({
            "id": "5001",
            "application_id": "3001",
            "type": 3,
            "token": "TOKEN-INTERAZIONE-DA-NON-MOSTRARE",
            "version": 1,
            "channel_id": "4001",
            "guild_id": if guild { json!("9001") } else { Value::Null },
            "member": if guild { json!({ "user": who }) } else { Value::Null },
            "user": if guild { Value::Null } else { who },
            "data": { "custom_id": "continua", "component_type": 2 },
            "message": { "id": "4001", "content": "vuoi continuare?" },
        })
    }

    #[tokio::test]
    async fn a_press_is_confirmed_and_a_private_one_is_a_chat_with_no_guild() {
        // The fake refuses, so there is an error to look at.
        let rest = FakeRest::start(vec![unauthorized(&json!({ "message": "401: Unauthorized" }).to_string())]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        // A press in a private chat: no guild, the author at the top level.
        let press = to_press(&interaction(false), None).expect("pressione");
        assert!(press.private, "una interazione privata non ha guild_id");
        assert!(admits(&press), "una pressione in privato deve passare: e' il caso di G5");
        // And it is confirmed, with the deferred type, on the documented path.
        let (path, body) = confirm_press(&interaction(false)).expect("conferma");
        assert_eq!(path, "/interactions/5001/TOKEN-INTERAZIONE-DA-NON-MOSTRARE/callback");
        assert_eq!(body["type"], 6);
        // The token of the interaction is a credential and stays out of errors.
        let error = discord
            .call(reqwest::Method::POST, "/interactions/5001/xyz/callback", Some(&body))
            .await
            .err()
            .expect("il finto non risponde a una rotta sconosciuta")
            .text();
        assert!(!error.contains("TOKEN-INTERAZIONE"), "il token dell'interazione compare: {error}");

        // In a server the press has a guild, so it is not a private chat: it
        // gets through because the hub checks the author and the code.
        let in_server = to_press(&interaction(true), None).expect("pressione");
        assert!(!in_server.private, "una pressione in un canale ha guild_id");
        assert!(admits(&in_server), "una pressione arriva comunque: e' ADE ad averla messa");
    }

    #[test]
    fn a_message_is_private_when_it_belongs_to_no_guild() {
        let shared = shared();
        let direct: Value = json!({
            "id": "m1", "channel_id": "d1", "content": "ciao",
            // A direct message: no guild. There is no channel type to read.
            "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        assert!(to_inbound(&direct, &shared, None).expect("messaggio").private);
        let in_server: Value = json!({
            "id": "m2", "channel_id": "4001", "guild_id": "9001",
            "content": "ciao <@42>", "author": { "id": "u1", "username": "qualcuno", "bot": false },
        });
        let in_server = to_inbound(&in_server, &shared, None).expect("messaggio");
        assert!(!in_server.private, "in un canale di un server non e' privato");
        assert!(in_server.mentioned, "ma la menzione lo abilita");
    }

    #[tokio::test]
    async fn an_edit_carries_no_mentions_either() {
        let rest = FakeRest::start(vec![ok("{}")]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        discord.edit("4001", "7", "@everyone guardate").await.expect("modificato");
        let body = rest.body_of(0);
        assert!(body["content"].as_str().unwrap_or_default().contains("@everyone"));
        assert_eq!(
            body["allowed_mentions"]["parse"],
            json!([]),
            "un edit ricalcola le menzioni dal testo nuovo: devono essere spente anche li'"
        );
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
            .send_buttons("4001", "vuoi continuare?", &[Button { label: "Si'".into(), data: "continua".into() }])
            .await
            .expect("inviato");
        let component = &rest.body_of(1)["components"][0]["components"][0];
        assert_eq!(component["custom_id"], "continua");
        assert_eq!(component["label"], "Si'");
    }

    #[tokio::test]
    async fn button_components_respect_action_row_limits() {
        let rest = FakeRest::start(vec![
            ok(&json!({ "id": "1" }).to_string()),
            ok(&json!({ "id": "1" }).to_string()),
        ]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        let buttons: Vec<Button> = (0..30)
            .map(|i| Button { label: format!("b{i}"), data: format!("d{i}") })
            .collect();
        discord
            .send_buttons("4001", "scegli", &buttons)
            .await
            .expect("inviato");
        let body = rest.body_of(1);
        let rows = body["components"].as_array().expect("array di righe");
        assert_eq!(rows.len(), 5, "massimo 5 action row");
        for (r_idx, row) in rows.iter().enumerate() {
            assert_eq!(row["type"], 1, "tipo ActionRow");
            let comps = row["components"].as_array().expect("array pulsanti");
            assert_eq!(comps.len(), 5, "5 pulsanti per riga");
            for (c_idx, btn) in comps.iter().enumerate() {
                let expected_idx = r_idx * 5 + c_idx;
                assert_eq!(btn["type"], 2);
                assert_eq!(btn["custom_id"], format!("d{expected_idx}"));
                assert_eq!(btn["label"], format!("b{expected_idx}"));
            }
        }
    }

    #[tokio::test]
    async fn socket_session_marks_greeted_on_ready_and_resumed() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        gateway.push(vec![hello(60), ready("SESSIONE", &gateway.address), closed(1001)]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 500);
        let (sender, _receiver) = mpsc::channel(16);
        let (_alive_tx, mut alive_rx) = watch::channel(());
        let ending = socket_session(&discord.core, &sender, &gateway.address, &mut alive_rx).await;
        match ending {
            Ending::Dropped { greeted, .. } => assert!(greeted, "dovrebbe essere greeted dopo READY"),
            _ => panic!("atteso Dropped, ottenuto altro"),
        }
    }

    #[tokio::test]
    async fn backoff_resets_only_after_30_seconds_of_live_session() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 500);
        let (sender, _receiver) = mpsc::channel(16);
        let (_alive_tx, mut alive_rx) = watch::channel(());

        // 1. Session drops immediately after READY: backoff must NOT reset (reset_backoff is false)
        gateway.push(vec![hello(60), ready("SESSIONE1", &gateway.address), closed(1001)]);
        let ending = socket_session(&discord.core, &sender, &gateway.address, &mut alive_rx).await;
        match ending {
            Ending::Dropped { greeted, reset_backoff } => {
                assert!(greeted);
                assert!(!reset_backoff, "una caduta immediata dopo READY non deve azzerare il backoff");
            }
            _ => panic!("atteso Dropped"),
        }

        // 2. Session drops after >= 30 seconds of live session: backoff DOES reset (reset_backoff is true)
        discord.now_step_ms.store(35_000, Ordering::SeqCst);
        gateway.push(vec![hello(60), ready("SESSIONE2", &gateway.address), closed(1001)]);
        let ending = socket_session(&discord.core, &sender, &gateway.address, &mut alive_rx).await;
        match ending {
            Ending::Dropped { greeted, reset_backoff } => {
                assert!(greeted);
                assert!(reset_backoff, "dopo almeno 30 s di sessione viva il backoff torna a 1 s");
            }
            _ => panic!("atteso Dropped"),
        }
    }


    #[test]
    fn a_press_becomes_a_message_with_its_data_and_a_command_does_not() {
        let press: Value = json!({
            "id": "i1", "channel_id": "4001", "channel_type": 0, "type": 3,
            "data": { "custom_id": "continua" },
            "member": { "user": { "id": "u1", "username": "qualcuno" } },
        });
        let inbound = to_press(&press, None).expect("pressione");
        assert!(inbound.button);
        assert_eq!(inbound.text, "continua");
        assert_eq!(inbound.sender.id, "u1");
        // A slash command is not a press under a message.
        let command: Value = json!({ "id": "i2", "channel_id": "4001", "type": 2, "data": { "custom_id": "x" } });
        assert!(to_press(&command, None).is_none());
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
        // The fake records a frame when it gets to reading it, not when the client sends it.
        assert!(gateway.wait_for(2, 1).await, "l'identify e' stato mandato");
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
    async fn a_gateway_let_go_of_closes_its_socket() {
        // The hub lets go of the adapter when the gateway is switched off. The
        // socket must go with it, or it reads and reconnects for nobody.
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        gateway.push(vec![hello(60_000), ready("S1", &gateway.address), message("m1", "d1", None, "u1", "ciao")]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 500);
        gateway.acking(true);
        discord.receive().await.expect("un messaggio");
        assert!(!gateway.client_left());
        drop(discord);
        for _ in 0..50 {
            if gateway.client_left() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(gateway.client_left(), "il socket resta aperto con il gateway spento");
    }

    #[tokio::test]
    async fn a_gateway_switched_off_says_goodbye_with_1000_and_one_that_drops_does_not() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        // A socket whose beat is never answered drops, to come back and resume.
        gateway.push(vec![hello(60), ready("S1", &gateway.address), message("m1", "d1", None, "u1", "ciao")]);
        gateway.push(vec![hello(60_000), message("m2", "d1", None, "u1", "ancora")]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 500);
        discord.receive().await.expect("il primo");
        discord.receive().await.expect("il secondo, dopo la ripresa");
        /*
         * Waited for, not read at once: the fake sends a connection's frames
         * before it reads any, so the client can have the second message
         * while its resume is still unread on the fake's side. Under load the
         * record came up empty (seen in a full `cargo test`).
         */
        assert!(gateway.wait_for(6, 1).await, "la ripresa");
        assert_eq!(gateway.op(6).map(|resume| resume["d"]["session_id"].clone()), Some(json!("S1")));
        assert_eq!(gateway.goodbye(), None, "chiuso con un codice che non si riprende");
        // Switched off: a goodbye, with the code of a client that leaves.
        drop(discord);
        for _ in 0..100 {
            if gateway.goodbye().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(gateway.goodbye(), Some(1000));
    }

    #[tokio::test]
    async fn after_the_first_beat_the_next_one_waits_the_whole_interval() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        // A share of nothing: the first beat goes at once, and the next one is
        // due a whole interval later, not a share of it again.
        gateway.push(vec![hello(400), ready("S1", &gateway.address)]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 0);
        gateway.acking(true);
        start(&discord).await;
        assert!(gateway.wait_for(1, 1).await, "il primo battito arriva");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(gateway.ops(1), 1, "il secondo battito aspetta l'intervallo intero");
        assert!(gateway.wait_for(1, 2).await, "e poi arriva");
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

    /* S14: what is put into a path or an address is checked first. */

    #[test]
    fn a_resume_address_is_followed_only_on_discord_over_wss() {
        let base = "wss://gateway.discord.gg/?v=10&encoding=json";
        for good in [
            "wss://gateway-us-east1-b.discord.gg",
            "wss://gateway-us-east1-b.discord.gg/?v=10&encoding=json",
            "wss://gateway-us-east1-b.discord.gg:443/",
            "WSS://Gateway.Discord.GG/",
        ] {
            assert!(trusted_resume(good, base), "{good}");
        }
        for bad in [
            "ws://gateway.discord.gg",
            "wss://evil.example.com/",
            "wss://evil.example.com/.discord.gg",
            "wss://evil.example.com?x=.discord.gg",
            "wss://evil.example.com#.discord.gg",
            "wss://gateway.discord.gg@evil.example.com/",
            "wss://gateway.discord.gg.evil.example.com/",
            "wss://gateway.discord.gg:8443/",
            "wss://discord.gg/",
            "wss://.discord.gg/",
            "wss://a..discord.gg/",
            "wss://evil.example.com:443@gateway.discord.gg/",
            "https://gateway.discord.gg/",
            "gateway.discord.gg",
            "",
        ] {
            assert!(!trusted_resume(bad, base), "{bad}");
        }
        // The address the adapter itself was made with is its own: the tests' gateway is on this machine.
        assert!(trusted_resume("ws://127.0.0.1:5000/?v=10", "ws://127.0.0.1:5000"));
        assert!(!trusted_resume("ws://127.0.0.1:5001/", "ws://127.0.0.1:5000"));
    }

    #[tokio::test]
    async fn a_saved_session_with_a_foreign_resume_address_identifies_on_the_base_address_instead() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![vec![hello(60)]]);
        let cursor = serde_json::to_string(&Session {
            session_id: "S-ALTRUI".into(),
            seq: 9,
            resume_url: "wss://evil.example.com/".into(),
            at_ms: 0,
        })
        .expect("cursore");
        let discord = Discord::at(&gateway.address, &rest.address, TOKEN, Some(cursor)).expect("adapter");
        set_jitter(&discord, 0);
        start(&discord).await;
        assert!(gateway.wait_for(2, 1).await, "un indirizzo che non e' di Discord non si segue: si identifica sulla base");
        assert_eq!(gateway.op(6), None, "nessun resume verso un indirizzo estraneo");
        let saved = discord.cursor().unwrap_or_default();
        assert!(!saved.contains("evil.example.com"), "{saved}");
    }

    #[test]
    fn only_digits_are_an_id_for_a_path() {
        assert!(check_id("canale", "123456789012345678").is_ok());
        for bad in ["", "ch1", "1/../../users/@me", "12 34", "1?x=1", "1#", "١٢٣", "-1", "123456789012345678901234567890"] {
            assert!(check_id("canale", bad).is_err(), "{bad:?}");
        }
        assert!(confirm_press(&json!({ "id": "5001", "token": "abc_DEF-123.x" })).is_some());
        assert!(confirm_press(&json!({ "id": "5001", "token": "../../channels/1" })).is_none());
        assert!(confirm_press(&json!({ "id": "5001/../x", "token": "abc" })).is_none());
    }

    #[tokio::test]
    async fn a_value_that_is_not_an_id_never_reaches_the_rest_api() {
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        let discord = adapter(&rest, &gateway);
        assert!(discord.send("1/../../users/@me", "ciao").await.is_err());
        assert!(discord.send_buttons("ch1", "ciao", &[]).await.is_err());
        assert!(discord.edit("4001", "7/../../x", "ciao").await.is_err());
        assert!(discord.edit("..", "7", "ciao").await.is_err());
        assert!(discord.typing("4001?x=1").await.is_err());
        assert!(rest.requests().is_empty(), "{:?}", rest.requests());
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
            message("m1", "d1", None, "u1", "ciao, sono qui"),
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
    /* The close codes, one row at a time. */

    /// One test per row of the table, so that a row cannot be changed, dropped
    /// or given the wrong meaning without one of these turning red.
    #[test]
    fn every_close_code_is_told_apart() {
        // (code, what Discord calls it, reconnects, needs a new session)
        let rows: &[(u16, &str, bool, bool)] = &[
            (4000, "errore sconosciuto", true, false),
            (4001, "opcode sconosciuto", true, false),
            (4002, "errore nella decodifica", true, false),
            (4003, "non autenticato", true, false),
            (4004, "autenticazione fallita", false, false),
            (4005, "già autenticato", true, false),
            (4007, "numero di sequenza non valido", true, true),
            (4008, "troppo veloce, attento al rate limit", true, false),
            (4009, "sessione scaduta", true, true),
            (4010, "shard non valido", false, false),
            (4011, "shard obbligatorio", false, false),
            (4012, "versione della API non valida", false, false),
            (4013, "intent non validi", false, false),
            (4014, "intent privilegiati non consentiti", false, false),
        ];
        assert_eq!(rows.len(), CLOSE_CODES.len(), "una riga della tabella non ha un test, o un test non ha una riga");
        for (code, what, reconnects, fresh) in rows {
            let (found, verdict) = close_code(*code);
            assert_eq!(found, *what, "il codice {code} non ha il nome che Discord gli dà");
            match verdict {
                Verdict::Again => {
                    assert!(*reconnects, "il codice {code} deve essere ritentato");
                    assert!(!*fresh, "il codice {code} non può chiedere una sessione nuova");
                }
                Verdict::Fresh => {
                    assert!(*reconnects, "il codice {code} deve essere ritentato");
                    assert!(*fresh, "il codice {code} deve aprire una sessione nuova");
                }
                Verdict::Stop(why) => {
                    assert!(!*reconnects, "il codice {code} non deve essere ritentato");
                    assert!(!*fresh, "il codice {code} non deve aprire una sessione nuova");
                    // Whatever the user is told, the token is not in it.
                    assert!(!why.contains(TOKEN), "il token compare nel messaggio del codice {code}");
                }
            }
        }
    }

    #[test]
    fn a_code_nobody_wrote_down_is_not_a_reason_to_give_up() {
        // 4999 is not in Discord's table. Retrying costs an identify only when
        // there is no session to resume, and the budget stops that loop.
        let (what, verdict) = close_code(4999);
        assert_eq!(what, "codice sconosciuto");
        assert_eq!(verdict, Verdict::Again);
        // A 1000 is a normal close: also worth another go.
        assert_eq!(close_code(1001).1, Verdict::Again);
    }

    #[tokio::test]
    async fn a_spent_session_opens_a_new_one_instead_of_being_resumed() {
        // 4009 is "session timed out": the session is gone on Discord's side, so
        // resuming it would be refused the same way. The next attempt has to
        // identify again.
        for (code, name) in [(4007u16, "sequenza rifiutata"), (4009, "sessione scaduta")] {
            let rest = FakeRest::start(vec![]);
            let gateway = FakeGateway::start(vec![]);
            gateway.push(vec![hello(60), ready("S1", &gateway.address), closed(code)]);
            gateway.push(vec![hello(60)]);
            let discord = adapter(&rest, &gateway);
            set_jitter(&discord, 500);
            start(&discord).await;
            // A second identify, and no resume: the session was spent.
            assert!(gateway.wait_for(2, 1).await, "{name}: il gateway si identifica di nuovo");
            assert_eq!(gateway.op(6), None, "{name}: la sessione spesa non viene ripresa");
        }
    }

    #[tokio::test]
    async fn a_code_that_stops_the_gateway_says_what_to_do_about_it() {
        for (code, name) in [
            (4004u16, "autenticazione fallita"),
            (4010, "shard non valido"),
            (4011, "shard obbligatorio"),
            (4012, "versione della API non valida"),
            (4013, "intent non validi"),
            (4014, "intent privilegiati non consentiti"),
        ] {
            let rest = FakeRest::start(vec![]);
            let gateway = FakeGateway::start(vec![vec![hello(60), closed(code)]]);
            let discord = adapter(&rest, &gateway);
            let text = discord.receive().await.err().expect("il gateway si ferma").message();
            assert!(!text.is_empty(), "{name}: il fermo deve dire qualcosa");
            assert!(!text.contains(TOKEN), "{name}: il token non compare");
        }
    }

    #[tokio::test]
    async fn a_code_that_is_only_a_bad_moment_goes_on_being_tried() {
        for code in [4000u16, 4001, 4002, 4003, 4005, 4008] {
            let rest = FakeRest::start(vec![]);
            let gateway = FakeGateway::start(vec![]);
            gateway.push(vec![hello(60), ready("S1", &gateway.address), closed(code)]);
            gateway.push(vec![hello(60)]);
            let discord = adapter(&rest, &gateway);
            set_jitter(&discord, 500);
            start(&discord).await;
            // The session was not spent, so it is resumed rather than started
            // over: an identify here would spend one of the thousand a day.
            assert!(gateway.wait_for(6, 1).await, "il codice {code} deve essere ritentato con la ripresa");
        }
    }

    /* The opcodes, which are not events. */

    #[tokio::test]
    async fn a_socket_that_is_answered_stays_open_for_five_beats() {
        // The bug this catches: the acknowledgement is an opcode, not an event,
        // so reading it by name meant every socket looked dead at the second
        // beat and the gateway resumed for ever. A server that answers op 11
        // every time, as Discord does, and the socket has to still be the same
        // one after five intervals.
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        // Forty milliseconds a beat, so five of them are a moment.
        gateway.push(vec![hello(40), ready("S5", &gateway.address)]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 500);
        gateway.acking(true);
        start(&discord).await;
        for _ in 0..300 {
            if gateway.ops(1) >= 6 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(gateway.ops(1) >= 5, "il socket deve battere: ne ha mandati {}", gateway.ops(1));
        assert_eq!(gateway.ops(6), 0, "un socket sano non si riprende");
        assert_eq!(gateway.ops(2), 1, "un socket sano si identifica una volta sola");
    }

    #[tokio::test]
    async fn a_beat_asked_for_by_discord_is_answered_at_once() {
        // op 1 from the server: Discord wants a beat now. The client answers
        // without waiting for its own turn.
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        gateway.push(vec![hello(60_000), ready("S1", &gateway.address)]);
        gateway.push(vec![Ws::Text(json!({ "op": 1, "d": null, "t": null, "s": null }).to_string().into())]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 0);
        start(&discord).await;
        // One beat is the answer to the one that was asked for; the interval is
        // a minute, so any second beat could only be the answer.
        assert!(gateway.wait_for(1, 1).await, "op 1 dal server resta senza risposta");
    }

    #[tokio::test]
    async fn a_reconnect_asked_for_by_discord_resumes_the_session() {
        // op 7: Discord wants the socket back. The session is good, so the next
        // connection resumes it rather than spending an identify.
        let rest = FakeRest::start(vec![]);
        let gateway = FakeGateway::start(vec![]);
        gateway.push(vec![
            hello(60_000),
            ready("S7", &gateway.address),
            Ws::Text(json!({ "op": 7, "d": null, "t": null, "s": null }).to_string().into()),
        ]);
        gateway.push(vec![hello(60_000)]);
        let discord = adapter(&rest, &gateway);
        set_jitter(&discord, 500);
        gateway.acking(true);
        start(&discord).await;
        assert!(gateway.wait_for(6, 1).await, "op 7 non porta a riprendere la sessione");
        let resume = gateway.op(6).expect("resume");
        assert_eq!(resume["d"]["session_id"], "S7");
    }

    #[tokio::test]
    async fn a_session_discord_will_not_resume_opens_a_new_one() {
        // op 9 with false: the session is not resumable, so the next connection
        // has to identify. Discord asks for one to five seconds first.
        for (payload, still_good, name) in [
            (json!({ "op": 9, "d": false, "t": null, "s": null }), false, "non riprendibile"),
            (json!({ "op": 9, "d": true, "t": null, "s": null }), true, "ancora riprendibile"),
        ] {
            let rest = FakeRest::start(vec![]);
            let gateway = FakeGateway::start(vec![]);
            gateway.push(vec![hello(60_000), ready("S9", &gateway.address), Ws::Text(payload.to_string().into())]);
            gateway.push(vec![hello(60_000)]);
            let discord = adapter(&rest, &gateway);
            set_jitter(&discord, 500);
            gateway.acking(true);
            start(&discord).await;
            if still_good {
                assert!(gateway.wait_for(6, 1).await, "{name}: la sessione si riprende");
            } else {
                assert!(gateway.wait_for(2, 1).await, "{name}: si identifica di nuovo");
                assert_eq!(gateway.op(6), None, "{name}: la sessione non viene ripresa");
            }
        }
    }

    #[tokio::test]
    async fn preview_sends_silent_message_then_edits_and_final_message_posts_new_and_deletes_preview() {
        let rest = FakeRest::start(vec![
            ok(r#"{"id": "111"}"#), // preview 1 POST
            ok(r#"{"id": "111"}"#), // preview 2 PATCH
            ok(r#"{"id": "222"}"#), // final piece 1 POST
            ok(r#"{"id": "333"}"#), // final piece 2 POST
            ok(r#""#),              // DELETE preview 111
        ]);
        let gateway = FakeGateway::start(vec![]);
        let d = adapter(&rest, &gateway);

        // 1. First preview: sends new silent message (SUPPRESS_NOTIFICATIONS | SUPPRESS_EMBEDS = 4100)
        d.preview("123", "prima anteprima").await.unwrap();
        assert_eq!(rest.count(), 1);
        let req1 = rest.requests();
        assert!(req1[0].0.starts_with("POST /channels/123/messages"));
        assert_eq!(rest.body_of(0)["content"], "prima anteprima");
        assert_eq!(rest.body_of(0)["flags"], json!(4100), "anteprima deve avere SUPPRESS_NOTIFICATIONS | SUPPRESS_EMBEDS (4100)");

        // 2. Second preview: edits that message in-place
        d.preview("123", "seconda anteprima più lunga").await.unwrap();
        assert_eq!(rest.count(), 2);
        let req2 = rest.requests();
        assert!(req2[1].0.starts_with("PATCH /channels/123/messages/111"));
        assert_eq!(rest.body_of(1)["content"], "seconda anteprima più lunga");

        // 3. Final message: long enough to have 2 pieces (> 2000 chars)
        let long_final = format!("{}\n\n{}", "A".repeat(1990), "B".repeat(500));
        let last_id = d.send_with("123", &long_final, true).await.unwrap();
        assert_eq!(last_id, "333");
        assert_eq!(rest.count(), 5);
        let reqs = rest.requests();
        assert!(reqs[2].0.starts_with("POST /channels/123/messages"));
        assert_eq!(rest.body_of(2)["flags"], json!(4100), "pezzi prima dell'ultimo devono silenziare le notifiche (4100)");
        assert!(reqs[3].0.starts_with("POST /channels/123/messages"));
        assert_eq!(rest.body_of(3)["flags"], json!(4), "l'ultimo pezzo suona (solo SUPPRESS_EMBEDS 4)");
        assert!(reqs[4].0.starts_with("DELETE /channels/123/messages/111"), "anteprima deve essere cancellata dopo il finale");
        assert_eq!(hold(&d.shared.active_preview).get("123"), None);
    }

    #[tokio::test]
    async fn preview_deletion_failure_falls_back_to_editing_notice() {
        let rest = FakeRest::start(vec![
            ok(r#"{"id": "111"}"#), // preview 1 POST
            ok(r#"{"id": "222"}"#), // final message POST
            refused(r#"{"message": "cannot delete"}"#), // DELETE fails
            ok(r#"{"id": "111"}"#), // PATCH fallback notice
        ]);
        let gateway = FakeGateway::start(vec![]);
        let d = adapter(&rest, &gateway);

        d.preview("123", "anteprima").await.unwrap();
        let last_id = d.send_with("123", "risposta finale", true).await.unwrap();
        assert_eq!(last_id, "222");
        assert_eq!(rest.count(), 4);
        let reqs = rest.requests();
        assert!(reqs[2].0.starts_with("DELETE /channels/123/messages/111"));
        assert!(reqs[3].0.starts_with("PATCH /channels/123/messages/111"));
        assert_eq!(rest.body_of(3)["content"], "(risposta inviata sotto)");
        assert_eq!(hold(&d.shared.active_preview).get("123"), None);
    }

    #[tokio::test]
    async fn failed_final_message_preserves_active_preview_for_preview_end() {
        let rest = FakeRest::start(vec![
            ok(r#"{"id": "111"}"#), // preview 1 POST
            refused(r#"{"message": "rate limited or bad payload"}"#), // final message POST fails!
            ok(r#"{"id": "111"}"#), // DELETE during preview_end
        ]);
        let gateway = FakeGateway::start(vec![]);
        let d = adapter(&rest, &gateway);

        d.preview("123", "anteprima").await.unwrap();
        assert_eq!(hold(&d.shared.active_preview).get("123").map(String::as_str), Some("111"));

        // final message fails
        let res = d.send_with("123", "risposta finale", true).await;
        assert!(res.is_err());

        // active_preview was restored so preview_end can clean it up
        assert_eq!(hold(&d.shared.active_preview).get("123").map(String::as_str), Some("111"));

        d.preview_end("123").await.unwrap();
        assert_eq!(hold(&d.shared.active_preview).get("123"), None);

        let reqs = rest.requests();
        assert_eq!(reqs.len(), 3);
        assert!(reqs[0].0.starts_with("POST /channels/123/messages"));
        assert!(reqs[1].0.starts_with("POST /channels/123/messages"));
        assert!(reqs[2].0.starts_with("DELETE /channels/123/messages/111"));
    }

    #[tokio::test]
    async fn intermediate_messages_do_not_consume_active_preview() {
        let rest = FakeRest::start(vec![
            ok(r#"{"id": "111"}"#), // preview 1 POST
            ok(r#"{"id": "222"}"#), // send_buttons POST
            ok(r#"{"id": "222"}"#), // send_buttons PATCH components
            ok(r#"{"id": "333"}"#), // send "in coda" POST
            ok(r#"{"id": "111"}"#), // preview 2 PATCH on 111
        ]);
        let gateway = FakeGateway::start(vec![]);
        let d = adapter(&rest, &gateway);

        // 1. Preview 1
        d.preview("123", "prima anteprima").await.unwrap();

        // 2. Mid-turn approval question with buttons: must post as NEW message, not touch preview 111
        let btn = Button { label: "Sì".into(), data: "yes".into() };
        let btn_id = d.send_buttons("123", "Approvi?", &[btn]).await.unwrap();
        assert_eq!(btn_id, "222");

        // 3. Mid-turn notice ("in coda"): must post as NEW message, not touch preview 111
        let queued_id = d.send("123", "In coda").await.unwrap();
        assert_eq!(queued_id, "333");

        // 4. Preview 2: should still update original preview message 111!
        d.preview("123", "seconda anteprima dopo la domanda").await.unwrap();

        let reqs = rest.requests();
        assert_eq!(reqs.len(), 5);
        assert!(reqs[0].0.starts_with("POST /channels/123/messages"), "req 0 deve essere POST");
        assert!(reqs[1].0.starts_with("POST /channels/123/messages"), "req 1 (buttons post) deve essere POST");
        assert!(reqs[2].0.starts_with("PATCH /channels/123/messages/222"), "req 2 (buttons patch) deve essere PATCH su 222");
        assert!(reqs[3].0.starts_with("POST /channels/123/messages"), "req 3 (queued) deve essere POST");
        assert!(reqs[4].0.starts_with("PATCH /channels/123/messages/111"), "req 4 (preview 2) deve essere PATCH su 111");
    }

    #[tokio::test]
    async fn case_b_stale_delayed_preview_from_old_turn_is_discarded_by_generation() {
        let rest = FakeRest::start(vec![
            ok(r#"{"id": "111"}"#), // preview 1
            ok(r#"{"id": "222"}"#), // final turn send
            ok(r#""#),              // delete preview 111
        ]);
        let gateway = FakeGateway::start(vec![]);
        let d = adapter(&rest, &gateway);

        // Turn 1 starts: first preview creates message 111
        d.preview("123", "anteprima turno 1").await.unwrap();
        assert_eq!(hold(&d.shared.active_preview).get("123").map(String::as_str), Some("111"));

        // Turn 1 ends: final message sent, bumps generation and clears active_preview
        d.send_with("123", "risposta finale turno 1", true).await.unwrap();
        assert_eq!(hold(&d.shared.active_preview).get("123"), None);

        // Generation in chat is now bumped
        let gen_now = hold(&d.shared.chat_generations).get("123").copied().unwrap_or(0);
        assert!(gen_now > 0, "la generazione deve essere avanzata");

        // If a delayed preview from turn 1 (which had old gen) acquires lock after final:
        // We simulate this by setting generation back for the check or by checking that bumping generation drops it:
        // Bump generation to simulate next turn having ended
        *hold(&d.shared.chat_generations).entry("123".to_string()).or_default() += 1;
        // With rest queue having no more responses, if an HTTP call were attempted it would panic!
        // Calling preview when generation changed while waiting for lock drops without HTTP call:
        let lock = d.chat_lock("123");
        let guard = lock.lock().await;
        // Launch a delayed preview in background while lock is held
        let d_clone = d.clone();
        let handle = tokio::spawn(async move {
            d_clone.preview("123", "anteprima ritardata").await
        });
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
        // Bump generation while lock is held, simulating turn completion
        *hold(&d.shared.chat_generations).entry("123".to_string()).or_default() += 1;
        drop(guard); // release lock so delayed preview can proceed

        // It must succeed without making any REST call (rest has no responses left)
        handle.await.unwrap().unwrap();
        assert_eq!(rest.count(), 3);
        assert_eq!(hold(&d.shared.active_preview).get("123"), None);
    }

    #[test]
    fn discord_429_produces_structured_flood_error() {
        let f = Failure::Api { status: 429, description: "You are being rate limited.".into(), retry_after: Some(2) };
        assert!(matches!(f.for_sending(), AdapterError::Flood(msg) if msg.contains("rate limited")));
    }
}

