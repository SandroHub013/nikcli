//! Slack, through Socket Mode and its Web API.
//!
//! - Two tokens. The bot's (`xoxb-`) makes every Web API call; the App-Level
//!   Token (`xapp-`, with `connections:write`) only opens the socket, with
//!   `apps.connections.open`. The user creates the second one by hand, in the
//!   app's Basic Information; the manifest cannot.
//! - Reading: one socket. Every envelope that carries an `envelope_id` is
//!   acknowledged the moment it arrives, before anything is decided about it —
//!   who wrote, whether a turn follows. Slack wants the answer «within three
//!   seconds» (<https://docs.slack.dev/apis/events-api/>, «Your app should
//!   respond to the event request with an HTTP 2xx within three seconds»), and
//!   in Socket Mode the answer is `{"envelope_id": …}` on the socket
//!   (<https://docs.slack.dev/apis/events-api/using-socket-mode>): without it
//!   the event comes again, and a trust dialog or a slow turn would each cost
//!   one more copy of the message.
//! - There is no heartbeat, identify or session to resume: a dropped socket is
//!   a new `apps.connections.open`. A `disconnect` with `warning` comes shortly
//!   before Slack closes the socket, so the next one is opened at once rather
//!   than after the usual wait; `refresh_requested` is the same, now;
//!   `link_disabled` means Socket Mode was switched off in the app, which no
//!   reconnection can fix.
//! - The silence. A scope the app lacks or an event it is not subscribed to
//!   gives no error at all: Slack sends nothing and the bot seems deaf. So the
//!   bot's scopes are read at the start, from the `x-oauth-scopes` header of
//!   `auth.test`, and a missing one is the first thing the panel's «Prova» and
//!   the gateway's status say, with «reinstalla l'app».
//! - Sending: pieces of 3.900 characters (Slack takes 40.000 in one message, but
//!   a wall of text is not read), at most `MAX_PIECES` of them, cut so a code
//!   block survives, the rest really left out and said to be in ADE.
//! - What arrives: direct messages (`message.im`) and, from channels, only
//!   the messages that name the bot (`app_mention`). The bot does not read the
//!   rest of a channel it sits in, which a `*:history` scope for every kind of
//!   channel would hand it, to be thrown away here: least given, least held.
//! - Nothing in a reply can ping anyone. Slack has no `allowed_mentions`: what
//!   pings is markup, `<!channel>`, `<!here>`, `<@U…>`. `&`, `<` and `>` are
//!   escaped in every text this adapter sends, as Slack asks
//!   (<https://docs.slack.dev/messaging/formatting-message-text>), so a reply
//!   that says `<!channel>` shows it and rings nothing.
//! - A 429 waits the `Retry-After` asked (a minute at most) and tries again.
//! - The chat commands are slash commands. Slack takes a message that starts
//!   with `/` for a command of an app and never sends it as a message, so
//!   `/ferma` typed to the bot reaches it only because the manifest registers
//!   it; it arrives in a `slash_commands` envelope and goes on as its text.
//!
//! The tokens are in the `Authorization` header, never in a URL. Errors are
//! built without them, and the hub hides them again anyway.

use super::adapter::{Adapter, AdapterError, Button, Capabilities, Inbound, Sender};
use super::chunk;
use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;

pub const API: &str = "https://slack.com/api";
/// A piece of a reply, in characters.
pub const MAX_LEN: usize = 3_900;
/// How many messages one reply may become; past that the last says the rest is in ADE.
const MAX_PIECES: usize = 8;
/// What a section block holds: a question with buttons longer than this goes
/// as text, and the buttons in a message of their own under it.
const SECTION_MAX: usize = 3_000;
/// Events and envelopes remembered to recognise one Slack sends again. Both
/// go in the one list, an event twice (its envelope and its own id), so a
/// busy minute of a few hundred must not push out what Slack may still send
/// again (G10 delta, BASSO).
const SEEN_EVENTS: usize = 512;
/// How long a sender's name is waited for. It is asked inside the socket's
/// reading loop, where every moment spent holds the acks of the envelopes
/// behind it, and Slack's limit for those is three seconds.
const NAME_WAIT: Duration = Duration::from_secs(1);
/// How long an id whose name did not come stands for it before Slack is asked
/// again. Without it every message from that sender waited `NAME_WAIT` anew,
/// holding the acks behind it each time (G10 delta, BASSO).
const NAME_RETRY: Duration = Duration::from_secs(5 * 60);
const MAX_WAIT: Duration = Duration::from_secs(60);
const RETRIES: usize = 3;
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const USER_AGENT: &str = concat!("nikcli-ade/", env!("CARGO_PKG_VERSION"), " (gateway)");

/// The bot scopes this adapter uses, and the only ones the manifest asks for:
/// `app_mentions:read` for a mention in a channel, `im:history` for a direct
/// message, `chat:write` sends and edits, `commands` brings the slash
/// commands, `users:read` gives a sender's name. `connections:write` is not
/// here: it belongs to the App-Level Token, not to the bot.
pub const BOT_SCOPES: &[&str] = &["app_mentions:read", "chat:write", "commands", "im:history", "users:read"];

/// The chat commands (`policy.ts`), registered as the app's slash commands.
pub const SLASH_COMMANDS: &[(&str, &str)] = &[
    ("/nuova", "Ricomincia la conversazione con il bot"),
    ("/ferma", "Ferma il turno in corso e svuota la coda"),
    ("/stato", "Dice cosa sta facendo il bot"),
    ("/aiuto", "Mostra i comandi del bot"),
];

/// The events the manifest subscribes to: a mention in any channel the bot is
/// in, and a direct message. Not `message.channels`, `message.groups` or
/// `message.mpim`: they bring every message of a channel, and a mention would
/// come twice, once of them and once as `app_mention` (G10 review).
pub const BOT_EVENTS: &[&str] = &["app_mention", "message.im"];

/// The manifest of the user's Slack app for a bot called `name`: Socket Mode,
/// the scopes and events above, and the Messages tab open so a person can
/// write to the bot directly.
pub fn manifest(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect();
    // Slack takes an app name of 35 characters at most.
    let short: String = cleaned.trim().chars().take(35).collect();
    let name = if short.trim().is_empty() { "ADE bot".to_string() } else { short.trim().to_string() };
    let commands: Vec<Value> = SLASH_COMMANDS
        .iter()
        .map(|(command, description)| json!({ "command": command, "description": description, "should_escape": false }))
        .collect();
    let manifest = json!({
        "display_information": { "name": name, "description": "Un bot di ADE" },
        "features": {
            "app_home": { "messages_tab_enabled": true, "messages_tab_read_only_enabled": false },
            "bot_user": { "display_name": name, "always_online": true },
            "slash_commands": commands,
        },
        "oauth_config": { "scopes": { "bot": BOT_SCOPES } },
        "settings": {
            "event_subscriptions": { "bot_events": BOT_EVENTS },
            "interactivity": { "is_enabled": true },
            "org_deploy_enabled": false,
            "socket_mode_enabled": true,
            "token_rotation_enabled": false,
        },
    });
    serde_json::to_string_pretty(&manifest).unwrap_or_default()
}

/// The bot scopes missing from `granted`, the `x-oauth-scopes` header.
fn missing_scopes(granted: &str) -> Vec<&'static str> {
    let granted: Vec<&str> = granted.split(',').map(str::trim).collect();
    BOT_SCOPES.iter().copied().filter(|scope| !granted.contains(scope)).collect()
}

/// What the user reads when scopes are missing: which, and the remedy.
fn doctor_line(missing: &[&str]) -> String {
    format!(
        "All'app Slack mancano gli scope {}: aggiungili (il manifest di ADE li ha già) e reinstalla l'app nel workspace. Senza, Slack non manda niente e il bot tace",
        missing.join(", ")
    )
}

/// Why a Web API call failed, before it becomes the adapter's error.
#[derive(Debug)]
enum Failure {
    Network { timeout: bool, connect: bool, text: String },
    Api { status: u16, error: String, needed: Option<String>, retry_after: Option<u64> },
}

/// Slack's error code in words, with the code kept for a search.
fn explain(error: &str, needed: Option<&str>) -> String {
    match error {
        "invalid_auth" | "not_authed" => format!("il token non è valido ({error})"),
        "token_revoked" | "token_expired" | "account_inactive" => {
            format!("il token non vale più: l'app è stata disinstallata o il token revocato ({error})")
        }
        "not_allowed_token_type" => {
            format!("il token è del tipo sbagliato: il bot vuole xoxb-, il socket xapp- ({error})")
        }
        "missing_scope" => format!(
            "all'app manca lo scope {}: aggiungilo e reinstalla l'app ({error})",
            needed.unwrap_or("richiesto")
        ),
        "not_in_channel" => format!("il bot non è nel canale: invitalo con /invite ({error})"),
        "channel_not_found" => format!("canale non trovato, o il bot non lo vede ({error})"),
        "ratelimited" => format!("troppe richieste, Slack chiede di aspettare ({error})"),
        other => other.to_string(),
    }
}

impl Failure {
    fn code(&self) -> &str {
        match self {
            Failure::Api { error, .. } => error,
            Failure::Network { .. } => "",
        }
    }

    fn text(&self) -> String {
        match self {
            Failure::Network { text, .. } => format!("Slack non raggiungibile: {text}"),
            Failure::Api { error, needed, .. } => format!("Slack: {}", explain(error, needed.as_deref())),
        }
    }

    /// The token is refused: trying again cannot help.
    fn refuses_token(&self) -> bool {
        matches!(
            self.code(),
            "invalid_auth" | "not_authed" | "token_revoked" | "token_expired" | "account_inactive" | "not_allowed_token_type"
        )
    }

    fn for_sending(self) -> AdapterError {
        match self {
            Failure::Network { timeout: true, .. } => AdapterError::Transient(
                "Slack non ha risposto in tempo: il messaggio potrebbe essere arrivato lo stesso".into(),
            ),
            Failure::Network { .. } => AdapterError::Transient(self.text()),
            Failure::Api { .. } => AdapterError::Fatal(self.text()),
        }
    }

    fn for_reading(self) -> AdapterError {
        if self.refuses_token() {
            AdapterError::Fatal(self.text())
        } else {
            AdapterError::Transient(self.text())
        }
    }
}

/// A Web API answer: the body, and the scopes the token has when Slack says.
struct Answer {
    body: Value,
    scopes: Option<String>,
}

/// Who the bot is, from `auth.test`.
struct Me {
    user_id: String,
    name: String,
    missing: Vec<&'static str>,
}

fn characters(text: &str) -> usize {
    text.chars().count()
}

fn is_loopback(api: &str) -> bool {
    api.starts_with("http://127.0.0.1") || api.starts_with("http://localhost")
}

/// Locks a mutex, taking a poisoned one rather than panicking.
fn hold<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `text` as Slack shows it literally: its three control characters escaped.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The text of a message as it was typed: Slack sends the three escaped.
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// Whether `text` names `bot` in Slack's mention syntax, `<@U…>` or
/// `<@U…|name>`. The text, not a list: a quote of the bot is not a mention.
fn names_bot(text: &str, bot: &str) -> bool {
    text.contains(&format!("<@{bot}>")) || text.contains(&format!("<@{bot}|"))
}

/// The length Slack counts: the text as it is sent, with its three characters escaped.
fn escaped_characters(text: &str) -> usize {
    characters(&escape(text))
}

/// The last message of a reply that did not fit.
fn rest_in_ade(dropped: usize) -> String {
    format!("(il resto, {dropped} caratteri, è in ADE: la risposta si è fermata a {MAX_PIECES} messaggi)")
}

/// What may still go after `sent` messages: `queue` as it is when it fits,
/// otherwise the pieces that fit before one last message saying where the
/// rest is, and how many characters that rest holds (added to `dropped`).
fn capped(sent: usize, mut queue: VecDeque<String>, dropped: usize) -> (VecDeque<String>, usize) {
    let room = MAX_PIECES.saturating_sub(sent);
    if dropped == 0 && queue.len() <= room {
        return (queue, 0);
    }
    // One message goes to saying where the rest is.
    let keep = room.saturating_sub(1).min(queue.len());
    let more: usize = queue.iter().skip(keep).map(|piece| characters(piece)).sum();
    queue.truncate(keep);
    (queue, dropped + more)
}

/// `text` in pieces Slack shows well, measured as Slack counts them, cut so a
/// code block survives, at most `MAX_PIECES` of them; past that the last one
/// says where the rest is.
fn pieces(text: &str) -> Vec<String> {
    let (kept, dropped) = capped(0, chunk::split(text, MAX_LEN, escaped_characters).into(), 0);
    let mut kept: Vec<String> = kept.into();
    if dropped > 0 {
        kept.push(rest_in_ade(dropped));
    }
    kept
}

/// `text` in two halves, cut on a character.
fn cut_in_half(text: &str) -> (String, String) {
    let at = text.char_indices().nth(characters(text) / 2).map(|(index, _)| index).unwrap_or(text.len());
    (text[..at].to_string(), text[at..].to_string())
}

/// The blocks of a question: its text, then a row of buttons.
fn button_blocks(text: Option<&str>, buttons: &[Button]) -> Value {
    let elements: Vec<Value> = buttons
        .iter()
        .enumerate()
        .map(|(index, button)| {
            json!({
                "type": "button",
                "action_id": format!("ade-{index}"),
                "text": { "type": "plain_text", "text": button.label, "emoji": true },
                "value": button.data,
            })
        })
        .collect();
    let mut blocks = Vec::new();
    if let Some(text) = text {
        blocks.push(json!({ "type": "section", "text": { "type": "mrkdwn", "text": escape(text) } }));
    }
    blocks.push(json!({ "type": "actions", "elements": elements }));
    Value::Array(blocks)
}

/// A direct message or a mention as the hub sees it, or `None` for what the
/// gateway does not take: an edit, a deletion, a join, a message with no text,
/// and a channel's other messages.
fn to_inbound(event: &Value, bot: Option<&str>) -> Option<Inbound> {
    let kind = event["type"].as_str()?;
    if kind != "message" && kind != "app_mention" {
        return None;
    }
    // Every change to a message and every notice has a subtype; a message a
    // person wrote has none.
    if !event["subtype"].is_null() {
        return None;
    }
    let raw = event["text"].as_str().unwrap_or_default();
    if raw.is_empty() {
        return None;
    }
    let chat = event["channel"].as_str()?.to_string();
    let user = event["user"].as_str()?.to_string();
    // A direct message is `im`; an event without the type is told by the
    // channel's id, which for a direct message starts with D.
    let private = match event["channel_type"].as_str() {
        Some(kind) => kind == "im",
        None => chat.starts_with('D'),
    };
    // From a channel only the mention, which Slack sends as `app_mention`: a
    // channel's `message` would be the same mention a second time, from an
    // app whose manifest still subscribes to it. And a mention in a direct
    // message is that message, which has already come as `message.im`.
    if (kind == "message") != private {
        return None;
    }
    Some(Inbound {
        id: event["ts"].as_str()?.to_string(),
        chat,
        private,
        // Read in the text as well: what Slack calls a mention is what names the bot.
        mentioned: kind == "app_mention" && bot.is_some_and(|bot| names_bot(raw, bot)),
        sender: Sender {
            is_bot: !event["bot_id"].is_null() || bot == Some(user.as_str()),
            // The name comes from `users.info`; the id until then.
            name: user.clone(),
            id: user,
        },
        text: unescape(raw),
        button: false,
    })
}

/// A button pressed under one of the bot's messages, from an `interactive`
/// envelope. The data comes back as the text.
fn to_press(payload: &Value) -> Option<Inbound> {
    if payload["type"].as_str() != Some("block_actions") {
        return None;
    }
    let action = payload["actions"].get(0)?;
    let data = action["value"].as_str()?;
    let user = &payload["user"];
    let chat = payload["channel"]["id"].as_str().or_else(|| payload["container"]["channel_id"].as_str())?;
    let id = action["action_ts"].as_str().or_else(|| payload["container"]["message_ts"].as_str())?;
    let name = user["username"].as_str().or_else(|| user["name"].as_str()).unwrap_or_default();
    Some(Inbound {
        id: id.to_string(),
        chat: chat.to_string(),
        private: chat.starts_with('D'),
        mentioned: false,
        sender: Sender { id: user["id"].as_str()?.to_string(), name: name.to_string(), is_bot: false },
        text: data.to_string(),
        button: true,
    })
}

/// One of the chat commands, from a `slash_commands` envelope: its text is the
/// command, with what was typed after it. A command is addressed to the bot by
/// its nature, so in a channel it counts as naming it.
fn to_command(payload: &Value) -> Option<Inbound> {
    let command = payload["command"].as_str()?;
    if !SLASH_COMMANDS.iter().any(|(known, _)| *known == command) {
        return None;
    }
    let chat = payload["channel_id"].as_str()?;
    let rest = payload["text"].as_str().unwrap_or_default().trim();
    let text = if rest.is_empty() { command.to_string() } else { format!("{command} {}", unescape(rest)) };
    Some(Inbound {
        id: payload["trigger_id"].as_str()?.to_string(),
        chat: chat.to_string(),
        private: chat.starts_with('D'),
        mentioned: true,
        sender: Sender {
            id: payload["user_id"].as_str()?.to_string(),
            name: payload["user_name"].as_str().unwrap_or_default().to_string(),
            is_bot: false,
        },
        text,
        button: false,
    })
}

/// What the socket task and the hub's calls share.
struct Inner {
    api: String,
    bot_token: String,
    app_token: String,
    calls: reqwest::Client,
    /// The bot's own user id, from `auth.test`, to recognise a mention of it.
    bot_user: Mutex<Option<String>>,
    /// Senders' names by id, from `users.info`.
    names: Mutex<HashMap<String, String>>,
    /// Senders whose name did not come, and when: not asked again for `NAME_RETRY`.
    unnamed: Mutex<HashMap<String, std::time::Instant>>,
    /// What a message last showed, per `chat/ts`: an edit that changes nothing is not sent.
    preview: Mutex<HashMap<String, String>>,
    /// The last events handed on, to drop one Slack sends again.
    seen: Mutex<VecDeque<String>>,
}

/// Which token a call goes with.
#[derive(Clone, Copy)]
enum Token {
    Bot,
    App,
}

impl Inner {
    async fn call(&self, method: reqwest::Method, path: &str, token: Token, body: Option<&Value>) -> Result<Answer, Failure> {
        let network = |error: reqwest::Error| Failure::Network {
            timeout: error.is_timeout(),
            connect: error.is_connect(),
            text: error.without_url().to_string(),
        };
        let token = match token {
            Token::Bot => &self.bot_token,
            Token::App => &self.app_token,
        };
        let mut request = self
            .calls
            .request(method, format!("{}{path}", self.api))
            .header("Authorization", format!("Bearer {token}"))
            .header(reqwest::header::USER_AGENT, USER_AGENT);
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json; charset=utf-8")
                .body(body.to_string());
        }
        let response = request.send().await.map_err(network)?;
        let status = response.status().as_u16();
        let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
        let retry_after = header("retry-after").and_then(|value| value.trim().parse::<f64>().ok()).map(|s| s.ceil() as u64);
        let scopes = header("x-oauth-scopes");
        let bytes = response.bytes().await.map_err(network)?;
        let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status == 429 {
            return Err(Failure::Api { status, error: "ratelimited".into(), needed: None, retry_after });
        }
        // Slack answers 200 with `ok: false` for its own errors.
        if !(200..300).contains(&status) || parsed["ok"].as_bool() != Some(true) {
            let error = parsed["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("errore HTTP {status}"));
            let needed = parsed["needed"].as_str().map(str::to_string);
            return Err(Failure::Api { status, error, needed, retry_after });
        }
        Ok(Answer { body: parsed, scopes })
    }

    /// A call that waits out the limits and a refused connection (nothing was
    /// sent), but not a timeout (something may have been).
    async fn call_patiently(&self, method: reqwest::Method, path: &str, token: Token, body: Option<&Value>) -> Result<Answer, Failure> {
        let mut tries = 0;
        loop {
            tries += 1;
            match self.call(method.clone(), path, token, body).await {
                Err(Failure::Api { status: 429, error, needed, retry_after }) if tries <= RETRIES => {
                    let wait = Duration::from_secs(retry_after.unwrap_or(1));
                    if wait > MAX_WAIT {
                        return Err(Failure::Api { status: 429, error, needed, retry_after });
                    }
                    tokio::time::sleep(wait).await;
                }
                Err(Failure::Network { connect: true, .. }) if tries <= 1 => tokio::time::sleep(Duration::from_secs(1)).await,
                other => return other,
            }
        }
    }

    fn bot_user(&self) -> Option<String> {
        hold(&self.bot_user).clone()
    }

    async fn auth_test(&self) -> Result<Me, Failure> {
        let answer = self.call_patiently(reqwest::Method::POST, "/auth.test", Token::Bot, None).await?;
        let user_id = answer.body["user_id"].as_str().unwrap_or_default().to_string();
        // Without the bot's id no mention of it is ever recognised, and
        // nothing would say so: a failure to try again, not a bot (G10
        // review, BASSO 2).
        if user_id.is_empty() {
            return Err(Failure::Api {
                status: 200,
                error: "auth.test non ha dato l'id del bot".into(),
                needed: None,
                retry_after: None,
            });
        }
        let name = answer.body["user"].as_str().unwrap_or_default().to_string();
        // No header is no answer about scopes, not every scope missing.
        let missing = answer.scopes.as_deref().map(missing_scopes).unwrap_or_default();
        Ok(Me { user_id, name, missing })
    }

    /// The socket's address, with the App-Level Token.
    async fn open_socket(&self) -> Result<String, Failure> {
        let answer = self.call_patiently(reqwest::Method::POST, "/apps.connections.open", Token::App, None).await?;
        answer.body["url"].as_str().map(str::to_string).ok_or(Failure::Api {
            status: 200,
            error: "Slack non ha dato l'indirizzo del socket".into(),
            needed: None,
            retry_after: None,
        })
    }

    /// Whether this event is handed on for the first time.
    fn first_time(&self, event: &str) -> bool {
        let mut seen = hold(&self.seen);
        if seen.iter().any(|known| known == event) {
            return false;
        }
        seen.push_back(event.to_string());
        if seen.len() > SEEN_EVENTS {
            seen.pop_front();
        }
        true
    }

    /// A sender's name, from `users.info`, remembered; the id when Slack does
    /// not say in time. One call, waited for `NAME_WAIT` at most, and none of
    /// `call_patiently`'s retries: the reading loop waits for it, and with the
    /// retries a slow Slack held the next envelopes' acks for tens of seconds,
    /// so they came again (G10 review, 1).
    async fn name_of(&self, user: &str) -> String {
        if let Some(name) = hold(&self.names).get(user) {
            return name.clone();
        }
        // Slack's user ids are capitals and digits: anything else is not put
        // in a URL, and the id stands for the name (G10 review, BASSO 1).
        if user.is_empty() || !user.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) {
            return user.to_string();
        }
        if hold(&self.unnamed).get(user).is_some_and(|since| since.elapsed() < NAME_RETRY) {
            return user.to_string();
        }
        let path = format!("/users.info?user={user}");
        let Ok(Ok(answer)) = tokio::time::timeout(NAME_WAIT, self.call(reqwest::Method::GET, &path, Token::Bot, None)).await else {
            let mut unnamed = hold(&self.unnamed);
            unnamed.retain(|_, since| since.elapsed() < NAME_RETRY);
            unnamed.insert(user.to_string(), std::time::Instant::now());
            return user.to_string();
        };
        hold(&self.unnamed).remove(user);
        let person = &answer.body["user"];
        let name = [&person["profile"]["display_name"], &person["real_name"], &person["name"]]
            .iter()
            .filter_map(|value| value.as_str())
            .find(|name| !name.trim().is_empty())
            .unwrap_or(user)
            .to_string();
        hold(&self.names).insert(user.to_string(), name.clone());
        name
    }

    /// An `events_api` envelope's message, once.
    async fn event(&self, payload: &Value) -> Option<Inbound> {
        let id = payload["event_id"].as_str()?;
        if !self.first_time(id) {
            return None;
        }
        let mut inbound = to_inbound(&payload["event"], self.bot_user().as_deref())?;
        if !inbound.sender.is_bot {
            inbound.sender.name = self.name_of(&inbound.sender.id).await;
        }
        Some(inbound)
    }

    async fn post(&self, chat: &str, text: &str, blocks: Option<Value>) -> Result<String, Failure> {
        let mut body = json!({ "channel": chat, "text": escape(text), "unfurl_links": false, "unfurl_media": false });
        if let Some(blocks) = blocks {
            body["blocks"] = blocks;
        }
        let sent = self.call_patiently(reqwest::Method::POST, "/chat.postMessage", Token::Bot, Some(&body)).await?;
        sent.body["ts"].as_str().map(str::to_string).ok_or(Failure::Api {
            status: 200,
            error: "Slack non ha dato l'id del messaggio".into(),
            needed: None,
            retry_after: None,
        })
    }

    /// Sends `text` in pieces, with `buttons` under the last, and returns the
    /// id of the message that holds the end of it.
    async fn send_all(&self, chat: &str, text: &str, buttons: Option<&[Button]>) -> Result<String, AdapterError> {
        let (mut queue, mut dropped) = capped(0, chunk::split(text, MAX_LEN, escaped_characters).into(), 0);
        if queue.is_empty() && dropped == 0 {
            return Err(AdapterError::Fatal("il messaggio è vuoto".into()));
        }
        let mut last = String::new();
        let mut placed = buttons.is_none();
        // Messages Slack took, for the cap: a piece cut in two is one more.
        let mut sent = 0;
        let mut noted = false;
        loop {
            let piece = match queue.pop_front() {
                Some(piece) => piece,
                None if dropped > 0 && !noted => {
                    noted = true;
                    rest_in_ade(dropped)
                }
                None => break,
            };
            let final_one = queue.is_empty() && (dropped == 0 || noted);
            // The last piece carries the buttons when it fits in a section.
            let blocks = match buttons {
                Some(buttons) if final_one && escaped_characters(&piece) <= SECTION_MAX => {
                    placed = true;
                    Some(button_blocks(Some(&piece), buttons))
                }
                _ => None,
            };
            match self.post(chat, &piece, blocks).await {
                Ok(id) => {
                    last = id;
                    sent += 1;
                }
                Err(failure) if failure.code() == "msg_too_long" => {
                    let (head, tail) = cut_in_half(&piece);
                    if tail.is_empty() || noted {
                        return Err(failure.for_sending());
                    }
                    placed = buttons.is_none();
                    queue.push_front(tail);
                    queue.push_front(head);
                    // Two halves are one message more: still within the cap, or the rest is said to be in ADE.
                    (queue, dropped) = capped(sent, queue, dropped);
                }
                Err(failure) => return Err(failure.for_sending()),
            }
        }
        if let (Some(buttons), false) = (buttons, placed) {
            last = self
                .post(chat, "Scegli qui sotto.", Some(button_blocks(None, buttons)))
                .await
                .map_err(Failure::for_sending)?;
        }
        hold(&self.preview).insert(format!("{chat}/{last}"), text.to_string());
        Ok(last)
    }
}

/// How a socket ended.
enum Ending {
    /// Stop, and tell the user why.
    Stopped(String),
    /// The socket dropped: another after the wait, which starts again from one
    /// second when this one had said hello.
    Dropped { greeted: bool },
    /// Slack asked for a new socket: at once, without the wait.
    Refresh,
    /// The adapter is gone, the gateway switched off: the socket said goodbye.
    LetGo,
}

/// Closes the socket as a client that is leaving, with a 1000: Slack sees it
/// go rather than a connection that vanishes. At most a second, so a peer
/// that does not read cannot hold the task.
async fn say_goodbye<S: SinkExt<Message> + Unpin>(sink: &mut S) {
    let close = Message::Close(Some(CloseFrame { code: CloseCode::Normal, reason: "".into() }));
    let _ = tokio::time::timeout(Duration::from_secs(1), sink.send(close)).await;
}

fn ack(envelope: &str) -> String {
    json!({ "envelope_id": envelope }).to_string()
}

/// One socket: `auth.test` the first time, `apps.connections.open`, then read
/// and acknowledge until it closes.
async fn socket_session(
    inner: &Inner,
    sender: &mpsc::Sender<Result<Inbound, AdapterError>>,
    alive: &mut watch::Receiver<()>,
) -> Ending {
    // The adapter can go at any wait below: `alive` is watched at each, and
    // once the socket is open it closes with a goodbye.
    if inner.bot_user().is_none() {
        let me = tokio::select! {
            _ = alive.changed() => return Ending::LetGo,
            me = inner.auth_test() => me,
        };
        match me {
            Ok(me) => {
                *hold(&inner.bot_user) = Some(me.user_id);
                if !me.missing.is_empty() {
                    // Not a stop: what the bot can do it does, and the panel says what is missing.
                    let _ = sender.send(Err(AdapterError::Transient(doctor_line(&me.missing)))).await;
                }
            }
            Err(failure) if failure.refuses_token() => {
                return Ending::Stopped(format!("Slack rifiuta il token del bot: {}", failure.text()))
            }
            Err(failure) => {
                let _ = sender.send(Err(AdapterError::Transient(failure.text()))).await;
                return Ending::Dropped { greeted: false };
            }
        }
    }
    let opened = tokio::select! {
        _ = alive.changed() => return Ending::LetGo,
        opened = inner.open_socket() => opened,
    };
    let address = match opened {
        Ok(address) => address,
        Err(failure) if failure.refuses_token() => {
            return Ending::Stopped(format!(
                "Slack rifiuta l'App-Level Token: {}. Si crea in Basic Information › App-Level Tokens, con lo scope connections:write",
                failure.text()
            ))
        }
        Err(failure) => {
            let _ = sender.send(Err(AdapterError::Transient(failure.text()))).await;
            return Ending::Dropped { greeted: false };
        }
    };
    let connected = tokio::select! {
        _ = alive.changed() => return Ending::LetGo,
        connected = tokio_tungstenite::connect_async(&address) => connected,
    };
    let (mut sink, mut source) = match connected {
        Ok((socket, _handshake)) => socket.split(),
        // The address carries a ticket: the error is said without it.
        Err(_) => {
            let _ = sender.send(Err(AdapterError::Transient("Slack non raggiungibile: il socket non si apre".into()))).await;
            return Ending::Dropped { greeted: false };
        }
    };
    let mut greeted = false;
    let mut warned = false;
    loop {
        let incoming = tokio::select! {
            _ = alive.changed() => {
                say_goodbye(&mut sink).await;
                return Ending::LetGo;
            }
            incoming = source.next() => incoming,
        };
        let Some(incoming) = incoming else { break };
        let Ok(frame) = incoming else { break };
        match frame {
            Message::Ping(payload) => {
                let _ = sink.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => break,
            Message::Text(text) => {
                let Ok(frame) = serde_json::from_str::<Value>(text.as_ref()) else { continue };
                // The ack first, before anything is decided about the envelope:
                // Slack's three seconds do not wait for a trust dialog.
                if let Some(envelope) = frame["envelope_id"].as_str() {
                    if sink.send(Message::Text(ack(envelope).into())).await.is_err() {
                        break;
                    }
                    // An envelope Slack sends again is acknowledged again and
                    // handed on once: a command or a press has no event id to
                    // tell a repeat by (G10 review, 1).
                    if !inner.first_time(&format!("envelope:{envelope}")) {
                        continue;
                    }
                }
                let handed = match frame["type"].as_str().unwrap_or_default() {
                    "hello" => {
                        greeted = true;
                        None
                    }
                    "disconnect" => match frame["reason"].as_str() {
                        Some("link_disabled") => {
                            return Ending::Stopped(
                                "Slack ha chiuso il socket: Socket Mode è spento nell'app. Riaccendilo nelle impostazioni dell'app e riaccendi il gateway".into(),
                            )
                        }
                        // The socket closes shortly: go on reading until it
                        // does, then open the next one at once.
                        Some("warning") => {
                            warned = true;
                            None
                        }
                        _ => return Ending::Refresh,
                    },
                    "events_api" => inner.event(&frame["payload"]).await,
                    "interactive" => to_press(&frame["payload"]),
                    "slash_commands" => to_command(&frame["payload"]),
                    _ => None,
                };
                if let Some(inbound) = handed {
                    if sender.send(Ok(inbound)).await.is_err() {
                        // Nobody reads any more: the adapter is gone.
                        return Ending::Stopped(String::new());
                    }
                }
            }
            _ => {}
        }
    }
    if warned {
        Ending::Refresh
    } else {
        Ending::Dropped { greeted }
    }
}

/// The socket task: sockets one after the other until the adapter is dropped
/// or the user must be told why it cannot go on.
async fn run_socket(inner: Arc<Inner>, sender: mpsc::Sender<Result<Inbound, AdapterError>>, mut alive: watch::Receiver<()>, first_wait: Duration) {
    let mut backoff = first_wait;
    loop {
        // The session watches `alive` itself, to close its socket with a goodbye.
        match socket_session(&inner, &sender, &mut alive).await {
            Ending::LetGo => return,
            Ending::Stopped(why) => {
                if !why.is_empty() {
                    let _ = sender.send(Err(AdapterError::Fatal(why))).await;
                }
                return;
            }
            Ending::Refresh => backoff = first_wait,
            Ending::Dropped { greeted } => {
                if greeted {
                    backoff = first_wait;
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

pub struct Slack {
    inner: Arc<Inner>,
    inbox: tokio::sync::Mutex<mpsc::Receiver<Result<Inbound, AdapterError>>>,
    sender: mpsc::Sender<Result<Inbound, AdapterError>>,
    /// The socket task, started by the first read and not before.
    started: AtomicBool,
    /// Dropped with the adapter, which ends the socket task: switching the
    /// gateway off must not leave a socket reading for nobody.
    alive: watch::Sender<()>,
    /// The wait after a dropped socket, before it doubles.
    first_wait: Duration,
}

impl Slack {
    /// The adapter for the bot with `bot_token`, its socket opened with `app_token`.
    pub fn new(bot_token: &str, app_token: Option<&str>) -> Result<Arc<Slack>, String> {
        Slack::at(API, bot_token, app_token)
    }

    fn at(api: &str, bot_token: &str, app_token: Option<&str>) -> Result<Arc<Slack>, String> {
        // Said before any call: each token has its prefix, and the two are
        // easily swapped in a form with two fields.
        if !bot_token.starts_with("xoxb-") {
            return Err("il token del bot di Slack comincia con xoxb- (OAuth & Permissions › Bot User OAuth Token)".into());
        }
        let Some(app_token) = app_token.filter(|token| token.starts_with("xapp-")) else {
            return Err("l'App-Level Token di Slack comincia con xapp- (Basic Information › App-Level Tokens, con connections:write)".into());
        };
        crate::serve_proxy::tls_ready();
        let builder = reqwest::Client::builder().connect_timeout(CONNECT_TIMEOUT).timeout(CALL_TIMEOUT);
        // The tests' server is on this machine: a system proxy must not see it.
        let builder = if is_loopback(api) { builder.no_proxy() } else { builder };
        let calls = builder.build().map_err(|error| format!("client HTTP non disponibile: {}", error.without_url()))?;
        let (sender, inbox) = mpsc::channel(256);
        Ok(Arc::new(Slack {
            inner: Arc::new(Inner {
                api: api.to_string(),
                bot_token: bot_token.to_string(),
                app_token: app_token.to_string(),
                calls,
                bot_user: Mutex::new(None),
                names: Mutex::new(HashMap::new()),
                unnamed: Mutex::new(HashMap::new()),
                preview: Mutex::new(HashMap::new()),
                seen: Mutex::new(VecDeque::new()),
            }),
            inbox: tokio::sync::Mutex::new(inbox),
            sender,
            started: AtomicBool::new(false),
            alive: watch::channel(()).0,
            first_wait: Duration::from_secs(1),
        }))
    }
}

#[async_trait]
impl Adapter for Slack {
    fn capabilities(&self) -> Capabilities {
        // Slack has no «sta scrivendo» a bot can send through the Web API.
        Capabilities { max_len: MAX_LEN, edit: true, typing: false, buttons: true }
    }

    async fn receive(&self) -> Result<Vec<Inbound>, AdapterError> {
        // The socket opens with the first read, not with `new`: a gateway that
        // is only probed never holds one.
        if !self.started.swap(true, Ordering::SeqCst) {
            let (inner, sender, alive) = (self.inner.clone(), self.sender.clone(), self.alive.subscribe());
            let first_wait = self.first_wait;
            tokio::spawn(async move { run_socket(inner, sender, alive, first_wait).await });
        }
        let mut inbox = self.inbox.lock().await;
        match inbox.recv().await {
            Some(Ok(message)) => Ok(vec![message]),
            Some(Err(error)) => Err(error),
            None => Err(AdapterError::Fatal("il gateway Slack si è fermato".into())),
        }
    }

    async fn send(&self, chat: &str, text: &str) -> Result<String, AdapterError> {
        self.inner.send_all(chat, text, None).await
    }

    async fn send_buttons(&self, chat: &str, text: &str, buttons: &[Button]) -> Result<String, AdapterError> {
        self.inner.send_all(chat, text, Some(buttons)).await
    }

    async fn edit(&self, chat: &str, message: &str, text: &str) -> Result<String, AdapterError> {
        let key = format!("{chat}/{message}");
        if hold(&self.inner.preview).get(&key).map(String::as_str) == Some(text) {
            return Ok(message.to_string());
        }
        let all = pieces(text);
        let Some(first) = all.first() else {
            return Err(AdapterError::Fatal("il messaggio è vuoto".into()));
        };
        // Only the first piece, as on Discord: an edit is the live text, and
        // the rest goes out once, with the sending call at the end of the turn.
        let body = json!({ "channel": chat, "ts": message, "text": escape(first) });
        self.inner
            .call_patiently(reqwest::Method::POST, "/chat.update", Token::Bot, Some(&body))
            .await
            .map_err(Failure::for_sending)?;
        hold(&self.inner.preview).insert(key, text.to_string());
        Ok(message.to_string())
    }

    async fn whoami(&self) -> Result<String, AdapterError> {
        let me = self.inner.auth_test().await.map_err(Failure::for_reading)?;
        if me.name.is_empty() {
            return Err(AdapterError::Fatal("Slack non ha detto il nome del bot".into()));
        }
        // The missing scopes are the first line: the name alone would say the
        // bot works, and it would stay silent.
        if !me.missing.is_empty() {
            return Err(AdapterError::Fatal(format!("{}. Il token è di @{}", doctor_line(&me.missing), me.name)));
        }
        Ok(format!("@{}", me.name))
    }
}

#[cfg(test)]
mod tests {
    use super::super::adapter::admits;
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::Instant;
    use tokio_tungstenite::tungstenite::Message as Ws;

    /* Two servers on this machine: no real Slack, no real token. */

    const BOT_TOKEN: &str = "xoxb-FINTO-0000000000-token-del-bot";
    const APP_TOKEN: &str = "xapp-1-FINTO-0000000000-token-app";
    const BOT: &str = "UBOT42";
    const ALL_SCOPES: &str = "app_mentions:read,chat:write,commands,im:history,users:read";

    /// The fake's header for a reply sent this many milliseconds late.
    const LATE: &str = "x-finto-ritardo-ms";

    #[derive(Clone)]
    struct Reply {
        status: u16,
        body: String,
        headers: Vec<(String, String)>,
    }

    fn ok(body: Value) -> Reply {
        Reply { status: 200, body: body.to_string(), headers: Vec::new() }
    }

    fn with_header(mut reply: Reply, name: &str, value: &str) -> Reply {
        reply.headers.push((name.into(), value.into()));
        reply
    }

    /// One request as the fake saw it.
    #[derive(Clone, Debug)]
    struct Seen {
        path: String,
        authorization: String,
        body: Value,
    }

    /// Slack's Web API on localhost. Each path has its own queue of answers,
    /// and a default once the queue is empty.
    struct FakeApi {
        address: String,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl FakeApi {
        fn start(socket: &str, mut queues: HashMap<&'static str, Vec<Reply>>) -> FakeApi {
            let listener = TcpListener::bind("127.0.0.1:0").expect("porta libera");
            let address = format!("http://{}", listener.local_addr().expect("indirizzo"));
            let seen = Arc::new(Mutex::new(Vec::new()));
            let thread_seen = seen.clone();
            let socket = socket.to_string();
            let mut queues: HashMap<String, VecDeque<Reply>> =
                queues.drain().map(|(path, replies)| (path.to_string(), replies.into())).collect();
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let (head, body) = read_request(&mut stream);
                    let first = head.lines().next().unwrap_or_default().to_string();
                    let path = first.split(' ').nth(1).unwrap_or_default().split('?').next().unwrap_or_default().to_string();
                    let authorization = head
                        .lines()
                        .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
                        .map(|line| line["authorization:".len()..].trim().to_string())
                        .unwrap_or_default();
                    hold(&thread_seen).push(Seen {
                        path: path.clone(),
                        authorization,
                        body: serde_json::from_str(&body).unwrap_or(Value::Null),
                    });
                    let reply = queues.get_mut(&path).and_then(VecDeque::pop_front).unwrap_or_else(|| match path.as_str() {
                        "/auth.test" => with_header(ok(json!({ "ok": true, "user_id": BOT, "user": "bot_di_prova" })), "x-oauth-scopes", ALL_SCOPES),
                        "/apps.connections.open" => ok(json!({ "ok": true, "url": socket })),
                        "/users.info" => ok(json!({ "ok": true, "user": { "name": "qualcuno", "profile": { "display_name": "Qualcuno" } } })),
                        _ => ok(json!({ "ok": true, "ts": "1700000000.000100" })),
                    });
                    // A reply can be late on purpose: the fake's own header, not sent.
                    if let Some((_, ms)) = reply.headers.iter().find(|(name, _)| name == LATE) {
                        std::thread::sleep(Duration::from_millis(ms.parse().unwrap_or(0)));
                    }
                    let mut response = format!("HTTP/1.1 {} X\r\ncontent-type: application/json\r\n", reply.status);
                    for (name, value) in reply.headers.iter().filter(|(name, _)| name != LATE) {
                        response.push_str(&format!("{name}: {value}\r\n"));
                    }
                    response.push_str(&format!("content-length: {}\r\nconnection: close\r\n\r\n{}", reply.body.len(), reply.body));
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                }
            });
            FakeApi { address, seen }
        }

        fn seen(&self) -> Vec<Seen> {
            hold(&self.seen).clone()
        }

        fn to(&self, path: &str) -> Vec<Seen> {
            self.seen().into_iter().filter(|seen| seen.path == path).collect()
        }
    }

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
        (head, String::from_utf8_lossy(&body).to_string())
    }

    /// What happened on one connection of the fake socket.
    #[derive(Clone, Debug, Default)]
    struct Connection {
        opened: Option<Instant>,
        /// When the fake sent its close, or saw the client go.
        ended: Option<Instant>,
        /// What the client wrote, and when.
        received: Vec<(Instant, Value)>,
        /// The client closed it, rather than the fake's time running out.
        closed_by_client: bool,
        /// The code of the close frame the client sent, if it sent one.
        goodbye: Option<u16>,
    }

    /// Slack's socket on localhost: one script of frames per connection, then
    /// reading until the client goes or `hold_ms` runs out.
    struct FakeSocket {
        address: String,
        connections: Arc<Mutex<Vec<Connection>>>,
    }

    impl FakeSocket {
        fn start(script: Vec<Vec<Ws>>, hold_ms: u64) -> FakeSocket {
            let listener = TcpListener::bind("127.0.0.1:0").expect("porta libera");
            let address = format!("ws://{}/link", listener.local_addr().expect("indirizzo"));
            let connections = Arc::new(Mutex::new(Vec::new()));
            let log = connections.clone();
            let queue = Arc::new(Mutex::new(VecDeque::from(script)));
            std::thread::spawn(move || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else { return };
                for incoming in listener.incoming() {
                    let Ok(stream) = incoming else { continue };
                    if stream.set_nonblocking(true).is_err() {
                        continue;
                    }
                    let frames = hold(&queue).pop_front().unwrap_or_default();
                    let log = log.clone();
                    runtime.block_on(async move {
                        let Ok(stream) = tokio::net::TcpStream::from_std(stream) else { return };
                        let Ok(socket) = tokio_tungstenite::accept_async(stream).await else { return };
                        let index = {
                            let mut all = hold(&log);
                            all.push(Connection { opened: Some(Instant::now()), ..Connection::default() });
                            all.len() - 1
                        };
                        let (mut sink, mut source) = socket.split();
                        for frame in frames {
                            let closing = matches!(frame, Ws::Close(_));
                            if sink.send(frame).await.is_err() {
                                return;
                            }
                            if closing {
                                hold(&log)[index].ended = Some(Instant::now());
                            }
                        }
                        let until = tokio::time::Instant::now() + Duration::from_millis(hold_ms);
                        loop {
                            tokio::select! {
                                incoming = source.next() => {
                                    match incoming {
                                        Some(Ok(Ws::Text(text))) => {
                                            let parsed = serde_json::from_str::<Value>(text.as_ref()).unwrap_or(Value::Null);
                                            hold(&log)[index].received.push((Instant::now(), parsed));
                                        }
                                        Some(Ok(Ws::Close(Some(close)))) => {
                                            hold(&log)[index].goodbye = Some(u16::from(close.code));
                                        }
                                        Some(Ok(_)) => {}
                                        _ => {
                                            let mut all = hold(&log);
                                            all[index].closed_by_client = true;
                                            all[index].ended.get_or_insert(Instant::now());
                                            break;
                                        }
                                    }
                                }
                                _ = tokio::time::sleep_until(until) => break,
                            }
                        }
                        let _ = sink.close().await;
                    });
                }
            });
            FakeSocket { address, connections }
        }

        fn connections(&self) -> Vec<Connection> {
            hold(&self.connections).clone()
        }

        /// Every envelope id acknowledged, on any connection.
        fn acks(&self) -> Vec<String> {
            self.connections()
                .iter()
                .flat_map(|connection| connection.received.iter())
                .filter_map(|(_, frame)| frame["envelope_id"].as_str().map(str::to_string))
                .collect()
        }
    }

    fn text(frame: Value) -> Ws {
        Ws::Text(frame.to_string().into())
    }

    fn hello() -> Ws {
        text(json!({ "type": "hello", "num_connections": 1, "connection_info": { "app_id": "A1" } }))
    }

    fn disconnect(reason: &str) -> Ws {
        text(json!({ "type": "disconnect", "reason": reason, "debug_info": { "host": "finto" } }))
    }

    /// A message event, as Socket Mode wraps it.
    fn envelope(envelope_id: &str, event_id: &str, channel: &str, kind: &str, user: &str, words: &str) -> Ws {
        text(json!({
            "envelope_id": envelope_id,
            "type": "events_api",
            "accepts_response_payload": false,
            "retry_attempt": 0,
            "payload": {
                "type": "event_callback",
                "event_id": event_id,
                "event": {
                    "type": "message", "channel": channel, "channel_type": kind,
                    "user": user, "text": words, "ts": format!("17000.{event_id}"),
                },
            },
        }))
    }

    fn adapter(api: &FakeApi) -> Arc<Slack> {
        Slack::at(&api.address, BOT_TOKEN, Some(APP_TOKEN)).expect("adapter")
    }

    async fn eventually(what: &str, check: impl Fn() -> bool) {
        for _ in 0..300 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("non è successo: {what}");
    }

    fn channel_event(words: &str) -> Value {
        json!({ "type": "message", "channel": "C1", "channel_type": "channel", "user": "U1", "text": words, "ts": "1.1" })
    }

    fn mention(channel: &str, words: &str) -> Value {
        json!({ "type": "app_mention", "channel": channel, "user": "U1", "text": words, "ts": "1.4", "event_ts": "1.4" })
    }

    /* Reading. */

    #[tokio::test]
    async fn every_envelope_is_acknowledged_before_anything_is_decided_about_it() {
        let socket = FakeSocket::start(
            vec![vec![
                hello(),
                // A channel message the bot is not given: nothing follows from
                // it, and it is acknowledged all the same.
                envelope("e1", "Ev1", "C1", "channel", "U9", "si parla d'altro"),
                envelope("e2", "Ev2", "D1", "im", "U9", "ciao"),
            ]],
            1_500,
        );
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        let started = Instant::now();
        // One read only, to start the socket: the second message is never
        // asked for, and its ack must not wait for that.
        let first = tokio::time::timeout(Duration::from_secs(3), slack.receive()).await.expect("in tempo").expect("letto");
        assert_eq!(first[0].text, "ciao", "il messaggio del canale non passa");
        eventually("i due ack", || socket.acks().len() == 2).await;
        assert_eq!(socket.acks(), vec!["e1".to_string(), "e2".to_string()]);
        let connection = &socket.connections()[0];
        for (at, _) in &connection.received {
            assert!(at.duration_since(started) < Duration::from_secs(3), "ack oltre i tre secondi");
        }
    }

    #[tokio::test]
    async fn a_slow_name_does_not_hold_the_acks_behind_it() {
        // G10 review, 1: the name of a sender is asked inside the reading loop,
        // and Slack sends again what is not acknowledged within three seconds.
        let socket = FakeSocket::start(
            vec![vec![
                hello(),
                envelope("e1", "Ev1", "D1", "im", "U9", "ciao"),
                envelope("e2", "Ev2", "D1", "im", "U9", "ancora"),
            ]],
            3_000,
        );
        let mut queues = HashMap::new();
        queues.insert(
            "/users.info",
            vec![with_header(ok(json!({ "ok": true, "user": { "name": "lento" } })), LATE, "5000")],
        );
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        let started = Instant::now();
        let first = slack.receive().await.expect("letto");
        assert_eq!(first[0].sender.name, "U9", "senza risposta in tempo, l'id");
        eventually("i due ack", || socket.acks().len() == 2).await;
        let second = socket.connections()[0].received[1].0;
        assert!(second.duration_since(started) < Duration::from_millis(2_500), "l'ack dietro al nome e' arrivato dopo {:?}", second.duration_since(started));
    }

    #[tokio::test]
    async fn a_name_that_did_not_come_in_time_is_not_waited_for_again() {
        let socket = FakeSocket::start(vec![], 100);
        let mut queues = HashMap::new();
        queues.insert("/users.info", vec![with_header(ok(json!({ "ok": true, "user": { "name": "lento" } })), LATE, "3000")]);
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        assert_eq!(slack.inner.name_of("U9").await, "U9");
        // The next message from the same sender: its id at once, not another second.
        let again = Instant::now();
        assert_eq!(slack.inner.name_of("U9").await, "U9");
        assert!(again.elapsed() < Duration::from_millis(300), "aspettato di nuovo: {:?}", again.elapsed());
    }

    #[tokio::test]
    async fn a_repeat_is_still_known_after_two_hundred_events_between() {
        let socket = FakeSocket::start(vec![], 100);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        // Two hundred messages, each an envelope and an event: four hundred names.
        assert!(slack.inner.first_time("envelope:primo"));
        assert!(slack.inner.first_time("Ev-primo"));
        for n in 0..199 {
            assert!(slack.inner.first_time(&format!("envelope:e{n}")));
            assert!(slack.inner.first_time(&format!("Ev{n}")));
        }
        assert!(!slack.inner.first_time("envelope:primo"), "il primo è già dimenticato");
    }

    #[tokio::test]
    async fn a_user_id_that_is_not_one_never_reaches_a_url() {
        let socket = FakeSocket::start(vec![], 100);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        assert_eq!(slack.inner.name_of("U1&user=U2").await, "U1&user=U2");
        assert_eq!(slack.inner.name_of("").await, "");
        assert!(api.to("/users.info").is_empty(), "un id che non e' di Slack e' finito in un indirizzo");
        assert_eq!(slack.inner.name_of("U09AB").await, "Qualcuno");
    }

    #[tokio::test]
    async fn a_bot_whose_id_slack_does_not_give_is_tried_again_not_taken() {
        let socket = FakeSocket::start(vec![vec![hello(), envelope("e1", "Ev1", "D1", "im", "U9", "ciao")]], 1_500);
        let mut queues = HashMap::new();
        queues.insert("/auth.test", vec![with_header(ok(json!({ "ok": true, "user": "bot_di_prova" })), "x-oauth-scopes", ALL_SCOPES)]);
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        let first = slack.receive().await.unwrap_err();
        assert!(matches!(&first, AdapterError::Transient(why) if why.contains("id del bot")), "{first:?}");
        assert!(slack.inner.bot_user().is_none(), "un id vuoto preso per buono");
        // The next try gets it, and reads.
        let message = tokio::time::timeout(Duration::from_secs(4), slack.receive()).await.expect("in tempo").expect("letto");
        assert_eq!(message[0].text, "ciao");
        assert_eq!(slack.inner.bot_user().as_deref(), Some(BOT));
    }

    #[tokio::test]
    async fn a_command_slack_sends_again_is_handed_on_once() {
        let command = |envelope: &str| {
            text(json!({
                "envelope_id": envelope, "type": "slash_commands", "accepts_response_payload": true,
                "payload": { "command": "/ferma", "text": "", "trigger_id": "T1", "user_id": "U9", "channel_id": "D9" },
            }))
        };
        let socket = FakeSocket::start(vec![vec![hello(), command("s1"), command("s1"), command("s2")]], 1_500);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        assert_eq!(slack.receive().await.expect("letto")[0].id, "T1");
        eventually("tre ack", || socket.acks().len() == 3).await;
        // The repeat of s1 was acknowledged and not handed on: the next is s2.
        let next = tokio::time::timeout(Duration::from_secs(2), slack.receive()).await.expect("in tempo").expect("letto");
        assert_eq!(next.len(), 1);
        assert_eq!(socket.acks(), vec!["s1".to_string(), "s1".to_string(), "s2".to_string()]);
        let pending = tokio::time::timeout(Duration::from_millis(300), slack.receive()).await;
        assert!(pending.is_err(), "il doppione di s1 e' stato consegnato");
    }

    #[tokio::test]
    async fn an_event_slack_sends_again_is_handed_on_once() {
        let socket = FakeSocket::start(
            vec![vec![
                hello(),
                envelope("e1", "Ev1", "D1", "im", "U9", "ciao"),
                // The same event in a new envelope, as a retry comes.
                envelope("e2", "Ev1", "D1", "im", "U9", "ciao"),
                envelope("e3", "Ev3", "D1", "im", "U9", "e poi"),
            ]],
            1_500,
        );
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        let first = slack.receive().await.expect("letto");
        let second = slack.receive().await.expect("letto");
        assert_eq!(first[0].text, "ciao");
        assert_eq!(second[0].text, "e poi", "il doppione non passa");
        eventually("tre ack", || socket.acks().len() == 3).await;
        assert_eq!(first[0].sender.name, "Qualcuno", "il nome viene da users.info");
    }

    #[tokio::test]
    async fn the_app_token_opens_the_socket_and_nothing_else() {
        let socket = FakeSocket::start(vec![vec![hello(), envelope("e1", "Ev1", "D1", "im", "U9", "ciao")]], 800);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        slack.receive().await.expect("letto");
        slack.send("D1", "ciao").await.expect("inviato");
        for seen in api.seen() {
            let expected = if seen.path == "/apps.connections.open" { APP_TOKEN } else { BOT_TOKEN };
            assert_eq!(seen.authorization, format!("Bearer {expected}"), "{}", seen.path);
        }
        assert_eq!(api.to("/apps.connections.open").len(), 1);
    }

    #[tokio::test]
    async fn a_disconnect_warning_only_brings_the_next_socket_forward() {
        let socket = FakeSocket::start(
            vec![
                vec![hello(), disconnect("warning"), Ws::Close(None)],
                vec![hello(), envelope("e1", "Ev1", "D1", "im", "U9", "sono ancora qui")],
            ],
            1_500,
        );
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        let message = tokio::time::timeout(Duration::from_secs(3), slack.receive()).await.expect("in tempo").expect("letto");
        assert_eq!(message[0].text, "sono ancora qui", "il gateway non si e' fermato");
        let connections = socket.connections();
        let gap = connections[1].opened.unwrap().duration_since(connections[0].ended.unwrap());
        // A plain drop waits a second before the next socket; a warning does not.
        assert!(gap < Duration::from_millis(700), "la riconnessione ha aspettato {gap:?}");
    }

    #[tokio::test]
    async fn socket_mode_switched_off_stops_the_gateway_and_says_why() {
        let socket = FakeSocket::start(vec![vec![hello(), disconnect("link_disabled")]], 800);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        let error = tokio::time::timeout(Duration::from_secs(3), slack.receive()).await.expect("in tempo").unwrap_err();
        assert!(matches!(&error, AdapterError::Fatal(why) if why.contains("Socket Mode")), "{error:?}");
    }

    #[tokio::test]
    async fn a_refused_app_token_stops_the_gateway_without_showing_it() {
        let socket = FakeSocket::start(vec![], 100);
        let mut queues = HashMap::new();
        queues.insert("/apps.connections.open", vec![ok(json!({ "ok": false, "error": "invalid_auth" }))]);
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        let error = tokio::time::timeout(Duration::from_secs(3), slack.receive()).await.expect("in tempo").unwrap_err();
        let AdapterError::Fatal(why) = error else { panic!("doveva fermarsi") };
        assert!(why.contains("App-Level Token") && why.contains("connections:write"), "{why}");
        assert!(!why.contains(APP_TOKEN) && !why.contains(BOT_TOKEN));
    }

    #[tokio::test]
    async fn dropping_the_adapter_ends_its_socket() {
        let socket = FakeSocket::start(vec![vec![hello(), envelope("e1", "Ev1", "D1", "im", "U9", "ciao")]], 3_000);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        slack.receive().await.expect("letto");
        drop(slack);
        eventually("il socket si chiude", || socket.connections().first().is_some_and(|c| c.closed_by_client)).await;
        // With a goodbye, the code of a client that leaves.
        assert_eq!(socket.connections()[0].goodbye, Some(1000));
    }

    #[test]
    fn from_a_channel_only_a_mention_comes_and_a_direct_message_always() {
        let named = to_inbound(&mention("C1", &format!("ciao <@{BOT}> guarda")), Some(BOT)).expect("menzione");
        assert!(named.mentioned && !named.private && admits(&named));
        let with_label = to_inbound(&mention("C1", &format!("ciao <@{BOT}|bot>")), Some(BOT)).expect("menzione");
        assert!(with_label.mentioned);
        // A channel's message is not taken, named or not: the mention comes as
        // `app_mention`, and taking both would be two turns of one message.
        assert!(to_inbound(&channel_event(&format!("ciao <@{BOT}>")), Some(BOT)).is_none());
        assert!(to_inbound(&channel_event("si parla d'altro"), Some(BOT)).is_none());
        let group = json!({ "type": "message", "channel": "G1", "channel_type": "mpim", "user": "U1", "text": "ciao", "ts": "1.3" });
        assert!(to_inbound(&group, Some(BOT)).is_none());
        let direct = json!({ "type": "message", "channel": "D1", "channel_type": "im", "user": "U1", "text": "ciao", "ts": "1.2" });
        let direct = to_inbound(&direct, Some(BOT)).expect("messaggio");
        assert!(direct.private && admits(&direct));
        // A mention in a direct message is that message, already come.
        assert!(to_inbound(&mention("D1", &format!("<@{BOT}> ciao")), Some(BOT)).is_none());
        // Without the bot's id a mention is not taken for one.
        assert!(!admits(&to_inbound(&mention("C1", &format!("<@{BOT}>")), None).expect("menzione")));
    }

    #[test]
    fn edits_notices_and_bots_are_not_turns() {
        let edited = json!({ "type": "message", "subtype": "message_changed", "channel": "D1", "channel_type": "im", "ts": "1" });
        assert!(to_inbound(&edited, Some(BOT)).is_none());
        let joined = json!({ "type": "message", "subtype": "channel_join", "channel": "C1", "user": "U1", "text": "è entrato", "ts": "1" });
        assert!(to_inbound(&joined, Some(BOT)).is_none());
        let from_bot = json!({ "type": "message", "channel": "D1", "channel_type": "im", "user": "U5", "bot_id": "B1", "text": "ciao", "ts": "1" });
        assert!(to_inbound(&from_bot, Some(BOT)).expect("messaggio").sender.is_bot);
        let itself = json!({ "type": "message", "channel": "D1", "channel_type": "im", "user": BOT, "text": "ciao", "ts": "1" });
        assert!(to_inbound(&itself, Some(BOT)).expect("messaggio").sender.is_bot);
    }

    #[test]
    fn the_text_reaches_the_turn_as_it_was_typed() {
        let typed = to_inbound(&mention("C1", &format!("<@{BOT}> a &lt; b &amp;&amp; c &gt; d")), Some(BOT)).expect("menzione");
        assert_eq!(typed.text, format!("<@{BOT}> a < b && c > d"));
    }

    #[test]
    fn a_press_comes_back_with_its_data() {
        let payload = json!({
            "type": "block_actions",
            "user": { "id": "U1", "username": "qualcuno" },
            "channel": { "id": "D1" },
            "container": { "type": "message", "message_ts": "5.5", "channel_id": "D1" },
            "actions": [{ "type": "button", "action_id": "ade-0", "value": "q1:0", "action_ts": "6.6" }],
        });
        let press = to_press(&payload).expect("pressione");
        assert!(press.button && press.private);
        assert_eq!((press.text.as_str(), press.sender.id.as_str()), ("q1:0", "U1"));
        assert!(to_press(&json!({ "type": "view_submission" })).is_none());
    }

    #[test]
    fn a_chat_command_arrives_as_a_slash_command_and_goes_on_as_its_text() {
        let payload = json!({
            "command": "/ferma", "text": "", "trigger_id": "T1", "user_id": "U1", "user_name": "qualcuno",
            "channel_id": "D1", "team_id": "W1",
        });
        let command = to_command(&payload).expect("comando");
        assert_eq!((command.text.as_str(), command.chat.as_str(), command.sender.id.as_str()), ("/ferma", "D1", "U1"));
        assert!(command.private && admits(&command));
        // In a channel a command is addressed to the bot, as a mention is.
        let in_channel = to_command(&json!({ "command": "/stato", "trigger_id": "T2", "user_id": "U1", "channel_id": "C1" })).expect("comando");
        assert!(!in_channel.private && admits(&in_channel));
        let with_words = to_command(&json!({ "command": "/nuova", "text": "a &lt; b", "trigger_id": "T3", "user_id": "U1", "channel_id": "D1" }))
            .expect("comando");
        assert_eq!(with_words.text, "/nuova a < b");
        // Another app's command is not ours.
        assert!(to_command(&json!({ "command": "/giphy", "trigger_id": "T4", "user_id": "U1", "channel_id": "D1" })).is_none());
    }

    #[tokio::test]
    async fn a_slash_command_envelope_is_acknowledged_and_handed_on() {
        let socket = FakeSocket::start(
            vec![vec![
                hello(),
                text(json!({
                    "envelope_id": "s1", "type": "slash_commands", "accepts_response_payload": true,
                    "payload": { "command": "/aiuto", "text": "", "trigger_id": "T9", "user_id": "U9", "user_name": "qualcuno", "channel_id": "D9" },
                })),
            ]],
            800,
        );
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        assert_eq!(slack.receive().await.expect("letto")[0].text, "/aiuto");
        eventually("l'ack", || socket.acks() == vec!["s1".to_string()]).await;
    }

    /* The doctor. */

    #[tokio::test]
    async fn a_missing_scope_is_the_first_line_of_the_probe() {
        let socket = FakeSocket::start(vec![], 100);
        let mut queues = HashMap::new();
        queues.insert(
            "/auth.test",
            vec![with_header(ok(json!({ "ok": true, "user_id": BOT, "user": "bot_di_prova" })), "x-oauth-scopes", "chat:write,users:read")],
        );
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        let error = slack.whoami().await.unwrap_err().message();
        let first = error.lines().next().unwrap_or_default();
        assert!(first.contains("app_mentions:read") && first.contains("im:history"), "{error}");
        assert!(first.contains("reinstalla l'app"), "{error}");
        assert!(!first.contains("chat:write,"), "uno scope che c'e' non e' fra i mancanti: {error}");
        // With every scope, the name.
        assert_eq!(slack.whoami().await.expect("nome"), "@bot_di_prova");
    }

    #[tokio::test]
    async fn a_missing_scope_is_said_by_the_gateway_too_and_it_goes_on() {
        let socket = FakeSocket::start(vec![vec![hello(), envelope("e1", "Ev1", "D1", "im", "U9", "ciao")]], 800);
        let mut queues = HashMap::new();
        queues.insert(
            "/auth.test",
            vec![with_header(ok(json!({ "ok": true, "user_id": BOT, "user": "bot_di_prova" })), "x-oauth-scopes", "chat:write")],
        );
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        let warning = slack.receive().await.unwrap_err();
        assert!(matches!(&warning, AdapterError::Transient(why) if why.contains("reinstalla")), "{warning:?}");
        assert_eq!(slack.receive().await.expect("e poi legge")[0].text, "ciao");
    }

    #[test]
    fn the_manifest_asks_for_what_the_doctor_checks() {
        let parsed: Value = serde_json::from_str(&manifest("Aiuto\u{7}")).expect("json");
        let scopes: Vec<&str> = parsed["oauth_config"]["scopes"]["bot"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(scopes, BOT_SCOPES);
        assert!(!scopes.contains(&"connections:write"), "e' dell'App-Level Token, non del bot");
        let events: Vec<&str> =
            parsed["settings"]["event_subscriptions"]["bot_events"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert_eq!(events, BOT_EVENTS);
        assert!(events.contains(&"app_mention") && !events.contains(&"message.channels"), "una menzione arriverebbe due volte");
        assert!(!scopes.contains(&"channels:history"), "il bot non legge il resto dei canali");
        let commands: Vec<&str> =
            parsed["features"]["slash_commands"].as_array().unwrap().iter().filter_map(|c| c["command"].as_str()).collect();
        assert_eq!(commands, ["/nuova", "/ferma", "/stato", "/aiuto"]);
        assert_eq!(parsed["settings"]["socket_mode_enabled"], true);
        assert_eq!(parsed["features"]["app_home"]["messages_tab_enabled"], true);
        assert_eq!(parsed["display_information"]["name"], "Aiuto");
        assert!(missing_scopes(&BOT_SCOPES.join(",")).is_empty());
        let long: Value = serde_json::from_str(&manifest(&"x".repeat(80))).expect("json");
        assert_eq!(long["display_information"]["name"].as_str().unwrap().chars().count(), 35);
    }

    #[test]
    fn tokens_of_the_wrong_kind_are_refused_before_any_call() {
        let swapped = Slack::at("http://127.0.0.1:9", APP_TOKEN, Some(BOT_TOKEN)).err().expect("rifiutato");
        assert!(swapped.contains("xoxb-"));
        let without = Slack::at("http://127.0.0.1:9", BOT_TOKEN, None).err().expect("rifiutato");
        assert!(without.contains("xapp-"));
        assert!(!swapped.contains("FINTO") && !without.contains("FINTO"));
    }

    /* Sending. */

    #[tokio::test]
    async fn nothing_in_a_reply_can_ping_anyone() {
        let socket = FakeSocket::start(vec![], 100);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        slack.send("C1", "<!channel> <!here> <@U1> a & b").await.expect("inviato");
        let body = &api.to("/chat.postMessage")[0].body;
        assert_eq!(body["text"], "&lt;!channel&gt; &lt;!here&gt; &lt;@U1&gt; a &amp; b");
        assert_eq!(body["unfurl_links"], false);
        slack.edit("C1", "1.1", "<!everyone>").await.expect("modificato");
        assert_eq!(api.to("/chat.update")[0].body["text"], "&lt;!everyone&gt;");
    }

    #[tokio::test]
    async fn a_reply_is_cut_at_3900_and_stops_at_eight_messages() {
        let socket = FakeSocket::start(vec![], 100);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        slack.send("C1", &"a".repeat(5_000)).await.expect("inviato");
        let sent = api.to("/chat.postMessage");
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|seen| characters(seen.body["text"].as_str().unwrap()) <= MAX_LEN));
        let text = "b".repeat(40_000);
        slack.send("C1", &text).await.expect("inviato");
        let sent = api.to("/chat.postMessage");
        assert_eq!(sent.len(), 2 + MAX_PIECES);
        let last = sent.last().unwrap().body["text"].as_str().unwrap().to_string();
        assert!(last.contains("in ADE"), "{last}");
        let total: usize = sent[2..].iter().map(|seen| characters(seen.body["text"].as_str().unwrap())).sum();
        assert!(total < characters(&text), "il resto non e' stato mandato lo stesso");
    }

    #[tokio::test]
    async fn a_429_waits_what_slack_asks_and_tries_again() {
        let socket = FakeSocket::start(vec![], 100);
        let mut queues = HashMap::new();
        queues.insert(
            "/chat.postMessage",
            vec![with_header(Reply { status: 429, body: "{}".into(), headers: Vec::new() }, "retry-after", "0")],
        );
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        assert_eq!(slack.send("C1", "ciao").await.expect("inviato"), "1700000000.000100");
        assert_eq!(api.to("/chat.postMessage").len(), 2, "il 429 e poi il tentativo");
    }

    #[test]
    fn a_piece_is_measured_as_slack_counts_it_escaped() {
        // 3 000 `<` are 12 000 characters once escaped: one piece of them was over Slack's limit.
        for text in ["<".repeat(3_000), format!("```\n{}\n```", "a < b && c > d\n".repeat(600))] {
            let all = pieces(&text);
            assert!(all.len() <= MAX_PIECES, "{} messaggi", all.len());
            for piece in &all {
                assert!(escaped_characters(piece) <= MAX_LEN, "un pezzo di {} caratteri con gli escape", escaped_characters(piece));
            }
        }
    }

    #[tokio::test]
    async fn a_piece_cut_in_two_never_goes_past_the_cap() {
        let socket = FakeSocket::start(vec![], 100);
        let mut queues = HashMap::new();
        queues.insert("/chat.postMessage", vec![ok(json!({ "ok": false, "error": "msg_too_long" }))]);
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        // Eight pieces exactly, and Slack refuses the first: its halves would make nine.
        let text = format!("{}\n", "e".repeat(3_800)).repeat(MAX_PIECES);
        assert_eq!(pieces(&text).len(), MAX_PIECES);
        slack.send("C1", &text).await.expect("inviato");
        let sent = api.to("/chat.postMessage");
        let taken = &sent[1..];
        assert!(taken.len() <= MAX_PIECES, "{} messaggi oltre il rifiuto", taken.len());
        let last = taken.last().unwrap().body["text"].as_str().unwrap().to_string();
        assert!(last.contains("in ADE"), "{last}");
        assert!(taken.iter().all(|seen| characters(seen.body["text"].as_str().unwrap()) <= MAX_LEN));
    }

    #[tokio::test]
    async fn too_long_for_slack_is_cut_in_two_and_sent_again() {
        let socket = FakeSocket::start(vec![], 100);
        let mut queues = HashMap::new();
        queues.insert("/chat.postMessage", vec![ok(json!({ "ok": false, "error": "msg_too_long" }))]);
        let api = FakeApi::start(&socket.address, queues);
        let slack = adapter(&api);
        slack.send("C1", &"c".repeat(3_000)).await.expect("inviato");
        let sent = api.to("/chat.postMessage");
        assert_eq!(sent.len(), 3, "un rifiuto e i due mezzi");
        assert_eq!(characters(sent[1].body["text"].as_str().unwrap()), 1_500);
    }

    #[tokio::test]
    async fn a_question_carries_its_buttons_and_an_edit_that_changes_nothing_is_not_sent() {
        let socket = FakeSocket::start(vec![], 100);
        let api = FakeApi::start(&socket.address, HashMap::new());
        let slack = adapter(&api);
        let buttons = [Button { label: "Sì".into(), data: "q1:0".into() }, Button { label: "No".into(), data: "q1:1".into() }];
        slack.send_buttons("D1", "Posso <procedere>?", &buttons).await.expect("inviato");
        let blocks = &api.to("/chat.postMessage")[0].body["blocks"];
        assert_eq!(blocks[0]["text"]["text"], "Posso &lt;procedere&gt;?");
        assert_eq!(blocks[1]["elements"][1]["value"], "q1:1");
        assert_eq!(blocks[1]["elements"][0]["text"]["text"], "Sì");
        // A question too long for a section: the text, then the buttons alone.
        slack.send_buttons("D1", &"d".repeat(3_500), &buttons).await.expect("inviato");
        let sent = api.to("/chat.postMessage");
        assert_eq!(sent.len(), 3);
        assert!(sent[1].body["blocks"].is_null());
        assert_eq!(sent[2].body["blocks"][0]["type"], "actions");

        slack.edit("D1", "9.9", "testo nuovo").await.expect("modificato");
        slack.edit("D1", "9.9", "testo nuovo").await.expect("modificato");
        assert_eq!(api.to("/chat.update").len(), 1, "lo stesso testo non viaggia");
    }
}
