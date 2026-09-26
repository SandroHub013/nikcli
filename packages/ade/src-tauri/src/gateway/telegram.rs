//! Telegram, through its Bot API: long polling, no webhook, no public address.
//!
//! - Reading: `getWebhookInfo` once. A bot whose messages already go to
//!   another service through a webhook is left alone, and the gateway stops
//!   saying so: deleting the webhook would break that service without a word.
//!   Then `getUpdates` in a long poll of 30 s, from the offset saved after the
//!   last batch was handed on.
//! - Only messages and button presses are asked for. A press is answered at
//!   once, so the button stops spinning, and comes back as a `button` message;
//!   the hub checks who pressed it.
//! - Sending: in pieces of 4096 UTF-16 units that do not break a code block,
//!   as MarkdownV2; a piece Telegram cannot parse is sent again as plain text.
//! - Limits: a 429 waits the `retry_after` Telegram asks (a minute at most)
//!   and tries again; a send that timed out is not tried again, as it may
//!   have arrived.
//! - A 409 means another program reads this bot (another ADE, a script): that
//!   stops the gateway with the reason, as does a refused token.
//!
//! The token is in every URL. Errors are built without it: reqwest's own
//! carry the URL and are stripped of it, and the hub hides it again anyway.

use super::adapter::{Adapter, AdapterError, Button, Capabilities, Inbound, Sender};
use super::chunk::{split, utf16};
use super::markdown_v2::to_markdown_v2;
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

pub const API: &str = "https://api.telegram.org";
const POLL_SECS: u64 = 30;
pub const MAX_LEN: usize = 4096;
/// The longest a `retry_after` is waited: beyond that the send fails and says so.
const MAX_WAIT: Duration = Duration::from_secs(60);
const RETRIES: usize = 3;
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub struct Telegram {
    /// `{api}/bot{token}`: every method is a path under it.
    base: String,
    /// For the long poll: its timeout is the poll's, plus a margin.
    poll: Client,
    calls: Client,
    poll_secs: u64,
    /// The offset for the next `getUpdates`: past the last update received.
    next: Mutex<Option<i64>>,
    /// No webhook was found on the bot: long polling may go on.
    webhook_checked: AtomicBool,
}

/// Why a call failed, before it becomes the adapter's error.
#[derive(Debug)]
enum Failure {
    Network { timeout: bool, connect: bool, text: String },
    Api { code: i64, description: String, retry_after: Option<u64> },
}

impl Failure {
    fn text(&self) -> String {
        match self {
            Failure::Network { text, .. } => format!("Telegram non raggiungibile: {text}"),
            Failure::Api { description, .. } => format!("Telegram: {description}"),
        }
    }

    /// For reading: which failures stop the gateway, which are tried again.
    fn for_reading(self) -> AdapterError {
        match self {
            Failure::Api { code: 401 | 404, .. } => {
                AdapterError::Fatal("Telegram rifiuta il token del bot: controllalo nella scheda del bot".into())
            }
            Failure::Api { code: 409, .. } => AdapterError::Fatal(
                "il token è in uso altrove: un altro programma, o un'altra ADE, legge già questo bot".into(),
            ),
            other => AdapterError::Transient(other.text()),
        }
    }

    fn for_sending(self) -> AdapterError {
        match self {
            Failure::Network { timeout: true, .. } => {
                AdapterError::Transient("Telegram non ha risposto in tempo: il messaggio potrebbe essere arrivato lo stesso".into())
            }
            Failure::Network { .. } => AdapterError::Transient(self.text()),
            Failure::Api { .. } => AdapterError::Fatal(self.text()),
        }
    }

    fn is_parse_error(&self) -> bool {
        matches!(self, Failure::Api { code: 400, description, .. } if description.contains("can't parse entities"))
    }
}

/// A chat id as Telegram wants it: a number when it is one.
fn chat_id(chat: &str) -> Value {
    chat.parse::<i64>().map(Value::from).unwrap_or_else(|_| Value::from(chat))
}

fn id_text(value: &Value) -> Option<String> {
    value.as_i64().map(|id| id.to_string()).or_else(|| value.as_str().map(str::to_string))
}

fn sender(from: &Value) -> Option<Sender> {
    let id = id_text(&from["id"])?;
    let first = from["first_name"].as_str().unwrap_or_default();
    let last = from["last_name"].as_str().unwrap_or_default();
    let mut name = format!("{first} {last}").trim().to_string();
    if name.is_empty() {
        name = from["username"].as_str().unwrap_or_default().to_string();
    }
    Some(Sender { id, name, is_bot: from["is_bot"].as_bool().unwrap_or(false) })
}

/// An update as the hub sees it; `None` for what the gateway does not take
/// (no text, an edit, a channel post).
fn inbound(update: &Value) -> Option<Inbound> {
    if let Some(message) = update.get("message") {
        let text = message["text"].as_str().or_else(|| message["caption"].as_str())?;
        return Some(Inbound {
            id: id_text(&message["message_id"])?,
            chat: id_text(&message["chat"]["id"])?,
            private: message["chat"]["type"] == "private",
            // A Telegram group is not answered at all in V1, so there is no
            // mention to look for.
            mentioned: false,
            sender: sender(&message["from"])?,
            text: text.to_string(),
            button: false,
        });
    }
    let press = update.get("callback_query")?;
    let message = press.get("message")?;
    Some(Inbound {
        id: id_text(&press["id"])?,
        chat: id_text(&message["chat"]["id"])?,
        private: message["chat"]["type"] == "private",
        mentioned: false,
        sender: sender(&press["from"])?,
        text: press["data"].as_str().unwrap_or_default().to_string(),
        button: true,
    })
}

fn is_loopback(api: &str) -> bool {
    api.starts_with("http://127.0.0.1") || api.starts_with("http://localhost")
}

impl Telegram {
    /// The adapter for the bot with `token`, reading on from `cursor`.
    pub fn new(token: &str, cursor: Option<String>) -> Result<Telegram, String> {
        Telegram::at(API, token, cursor, POLL_SECS, CALL_TIMEOUT)
    }

    fn at(api: &str, token: &str, cursor: Option<String>, poll_secs: u64, call_timeout: Duration) -> Result<Telegram, String> {
        crate::serve_proxy::tls_ready();
        let client = |timeout: Duration| {
            let builder = Client::builder().connect_timeout(CONNECT_TIMEOUT).timeout(timeout);
            // The tests' server is on this machine: a system proxy must not see it.
            let builder = if is_loopback(api) { builder.no_proxy() } else { builder };
            builder.build().map_err(|error| format!("client HTTP non disponibile: {}", error.without_url()))
        };
        Ok(Telegram {
            base: format!("{api}/bot{token}"),
            poll: client(Duration::from_secs(poll_secs + 15))?,
            calls: client(call_timeout)?,
            poll_secs,
            next: Mutex::new(cursor.and_then(|cursor| cursor.parse().ok())),
            webhook_checked: AtomicBool::new(false),
        })
    }

    async fn call(&self, client: &Client, method: &str, body: &Value) -> Result<Value, Failure> {
        let network = |error: reqwest::Error| Failure::Network {
            timeout: error.is_timeout(),
            connect: error.is_connect(),
            text: error.without_url().to_string(),
        };
        let response = client
            .post(format!("{}/{method}", self.base))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(network)?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.map_err(network)?;
        let reply: Value = serde_json::from_slice(&bytes).map_err(|_| Failure::Api {
            code: i64::from(status),
            description: format!("risposta non valida (HTTP {status})"),
            retry_after: None,
        })?;
        if reply["ok"] == true {
            return Ok(reply["result"].clone());
        }
        Err(Failure::Api {
            code: reply["error_code"].as_i64().unwrap_or(i64::from(status)),
            description: reply["description"].as_str().unwrap_or("errore senza descrizione").to_string(),
            retry_after: reply["parameters"]["retry_after"].as_u64(),
        })
    }

    /// A call that waits out Telegram's limits and a refused connection
    /// (nothing was sent), but not a timeout (something may have been).
    async fn call_patiently(&self, method: &str, body: &Value) -> Result<Value, Failure> {
        let mut tries = 0;
        loop {
            tries += 1;
            match self.call(&self.calls, method, body).await {
                Err(Failure::Api { code: 429, retry_after, description }) if tries <= RETRIES => {
                    let wait = Duration::from_secs(retry_after.unwrap_or(1));
                    if wait > MAX_WAIT {
                        return Err(Failure::Api { code: 429, retry_after, description });
                    }
                    tokio::time::sleep(wait).await;
                }
                Err(Failure::Network { connect: true, .. }) if tries <= 1 => tokio::time::sleep(Duration::from_secs(1)).await,
                other => return other,
            }
        }
    }

    /// One piece, as MarkdownV2, or as plain text when Telegram cannot parse it.
    async fn send_piece(&self, chat: &str, piece: &str, markup: Option<&Value>) -> Result<String, AdapterError> {
        let mut body = json!({ "chat_id": chat_id(chat), "text": to_markdown_v2(piece), "parse_mode": "MarkdownV2" });
        if let Some(markup) = markup {
            body["reply_markup"] = markup.clone();
        }
        let sent = match self.call_patiently("sendMessage", &body).await {
            Err(failure) if failure.is_parse_error() => {
                body["text"] = Value::from(piece);
                body.as_object_mut().map(|fields| fields.remove("parse_mode"));
                self.call_patiently("sendMessage", &body).await
            }
            other => other,
        };
        let sent = sent.map_err(Failure::for_sending)?;
        id_text(&sent["message_id"]).ok_or_else(|| AdapterError::Fatal("Telegram non ha dato l'id del messaggio".into()))
    }

    async fn send_all(&self, chat: &str, text: &str, markup: Option<Value>) -> Result<String, AdapterError> {
        let pieces = split(text, MAX_LEN, utf16);
        let Some(last) = pieces.len().checked_sub(1) else {
            return Err(AdapterError::Fatal("il messaggio è vuoto".into()));
        };
        let mut id = String::new();
        for (index, piece) in pieces.iter().enumerate() {
            id = self.send_piece(chat, piece, if index == last { markup.as_ref() } else { None }).await?;
        }
        Ok(id)
    }
}

#[async_trait]
impl Adapter for Telegram {
    fn capabilities(&self) -> Capabilities {
        Capabilities { max_len: MAX_LEN, edit: true, typing: true, buttons: true }
    }

    async fn receive(&self) -> Result<Vec<Inbound>, AdapterError> {
        if !self.webhook_checked.load(Ordering::SeqCst) {
            let info = self.call(&self.calls, "getWebhookInfo", &json!({})).await.map_err(Failure::for_reading)?;
            if info["url"].as_str().is_some_and(|url| !url.is_empty()) {
                return Err(AdapterError::Fatal(
                    "questo bot manda già i suoi messaggi a un altro servizio (un webhook): toglilo da lì, oppure usa per ADE un altro bot".into(),
                ));
            }
            self.webhook_checked.store(true, Ordering::SeqCst);
        }
        let offset = *self.next.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut body = json!({ "timeout": self.poll_secs, "allowed_updates": ["message", "callback_query"] });
        if let Some(offset) = offset {
            body["offset"] = Value::from(offset);
        }
        let updates = match self.call(&self.poll, "getUpdates", &body).await {
            Ok(updates) => updates,
            Err(Failure::Api { code: 429, retry_after, .. }) => {
                tokio::time::sleep(Duration::from_secs(retry_after.unwrap_or(1)).min(MAX_WAIT)).await;
                return Ok(Vec::new());
            }
            Err(failure) => return Err(failure.for_reading()),
        };
        let mut batch = Vec::new();
        for update in updates.as_array().map(Vec::as_slice).unwrap_or_default() {
            if let Some(id) = update["update_id"].as_i64() {
                let mut next = self.next.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                *next = Some(next.map_or(id + 1, |next| next.max(id + 1)));
            }
            if let Some(press) = update.get("callback_query") {
                // Stops the button spinning; who pressed it is the hub's to judge.
                let _ = self.call(&self.calls, "answerCallbackQuery", &json!({ "callback_query_id": press["id"] })).await;
            }
            if let Some(message) = inbound(update) {
                batch.push(message);
            }
        }
        Ok(batch)
    }

    async fn send(&self, chat: &str, text: &str) -> Result<String, AdapterError> {
        self.send_all(chat, text, None).await
    }

    async fn send_buttons(&self, chat: &str, text: &str, buttons: &[Button]) -> Result<String, AdapterError> {
        let rows: Vec<Value> = buttons
            .chunks(2)
            .map(|row| Value::from(row.iter().map(|button| json!({ "text": button.label, "callback_data": button.data })).collect::<Vec<_>>()))
            .collect();
        self.send_all(chat, text, Some(json!({ "inline_keyboard": rows }))).await
    }

    async fn edit(&self, chat: &str, message: &str, text: &str) -> Result<String, AdapterError> {
        let message_id: i64 = message.parse().map_err(|_| AdapterError::Fatal("id del messaggio non valido".into()))?;
        let mut pieces = split(text, MAX_LEN, utf16).into_iter();
        let piece = pieces.next().ok_or_else(|| AdapterError::Fatal("il messaggio è vuoto".into()))?;
        let mut body = json!({ "chat_id": chat_id(chat), "message_id": message_id, "text": to_markdown_v2(&piece), "parse_mode": "MarkdownV2" });
        let edited = match self.call_patiently("editMessageText", &body).await {
            Err(failure) if failure.is_parse_error() => {
                body["text"] = Value::from(piece);
                body.as_object_mut().map(|fields| fields.remove("parse_mode"));
                self.call_patiently("editMessageText", &body).await
            }
            other => other,
        };
        match edited {
            Ok(_) => {}
            Err(Failure::Api { code: 400, description, .. }) if description.contains("message is not modified") => {}
            Err(failure) => return Err(failure.for_sending()),
        }
        // Past the limit the text goes on in new messages, never cut off.
        let mut last = message.to_string();
        for piece in pieces {
            last = self.send_piece(chat, &piece, None).await?;
        }
        Ok(last)
    }

    async fn whoami(&self) -> Result<String, AdapterError> {
        let me = self.call_patiently("getMe", &json!({})).await.map_err(Failure::for_reading)?;
        match (me["username"].as_str(), me["first_name"].as_str()) {
            (Some(username), _) if !username.is_empty() => Ok(format!("@{username}")),
            (_, Some(name)) => Ok(name.to_string()),
            _ => Err(AdapterError::Fatal("Telegram non ha detto il nome del bot".into())),
        }
    }

    async fn typing(&self, chat: &str) -> Result<(), AdapterError> {
        self.call_patiently("sendChatAction", &json!({ "chat_id": chat_id(chat), "action": "typing" }))
            .await
            .map(|_| ())
            .map_err(Failure::for_sending)
    }

    fn cursor(&self) -> Option<String> {
        self.next.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).map(|next| next.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;

    /* A fake Bot API on localhost: no token of any real bot, no network. */

    const TOKEN: &str = "123456789:FINTO-token-di-prova_AbCdEfGhIjKlMnOp";

    /// Status, body, and how long to wait before answering.
    type Reply = (u16, String, u64);

    #[derive(Clone, Default)]
    struct FakeApi {
        url: String,
        /// Every call: the path it went to and its JSON body.
        calls: Arc<Mutex<Vec<(String, Value)>>>,
        script: Arc<Mutex<HashMap<String, VecDeque<Reply>>>>,
    }

    impl FakeApi {
        fn start() -> FakeApi {
            let listener = TcpListener::bind("127.0.0.1:0").expect("porta di prova");
            let api = FakeApi { url: format!("http://{}", listener.local_addr().unwrap()), ..FakeApi::default() };
            let serving = api.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let serving = serving.clone();
                    std::thread::spawn(move || serving.answer(stream));
                }
            });
            api
        }

        fn then(&self, method: &str, status: u16, body: Value) {
            self.then_after(method, status, body, 0);
        }

        fn then_after(&self, method: &str, status: u16, body: Value, delay_ms: u64) {
            self.script.lock().unwrap().entry(method.into()).or_default().push_back((status, body.to_string(), delay_ms));
        }

        fn calls_to(&self, method: &str) -> Vec<Value> {
            self.calls.lock().unwrap().iter().filter(|(path, _)| path.ends_with(&format!("/{method}"))).map(|(_, body)| body.clone()).collect()
        }

        fn answer(&self, mut stream: TcpStream) {
            let mut data = Vec::new();
            let mut buffer = [0u8; 4096];
            let head_end = loop {
                let Ok(read) = stream.read(&mut buffer) else { return };
                if read == 0 {
                    return;
                }
                data.extend_from_slice(&buffer[..read]);
                if let Some(at) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                    break at + 4;
                }
            };
            let head = String::from_utf8_lossy(&data[..head_end]).to_string();
            let length: usize = head
                .lines()
                .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse().unwrap_or(0)))
                .unwrap_or(0);
            while data.len() < head_end + length {
                let Ok(read) = stream.read(&mut buffer) else { return };
                if read == 0 {
                    break;
                }
                data.extend_from_slice(&buffer[..read]);
            }
            let path = head.split_whitespace().nth(1).unwrap_or_default().to_string();
            let body: Value = serde_json::from_slice(&data[head_end..]).unwrap_or(Value::Null);
            let method = path.rsplit('/').next().unwrap_or_default().to_string();
            self.calls.lock().unwrap().push((path, body));
            let scripted = self.script.lock().unwrap().get_mut(&method).and_then(VecDeque::pop_front);
            let (status, reply, delay) = scripted.unwrap_or_else(|| match method.as_str() {
                "getUpdates" => (200, json!({ "ok": true, "result": [] }).to_string(), 30),
                "sendMessage" => {
                    let sent = self.calls_to("sendMessage").len();
                    (200, json!({ "ok": true, "result": { "message_id": 100 + sent } }).to_string(), 0)
                }
                _ => (200, json!({ "ok": true, "result": true }).to_string(), 0),
            });
            std::thread::sleep(Duration::from_millis(delay));
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    }

    fn adapter(api: &FakeApi, cursor: Option<&str>) -> Telegram {
        Telegram::at(&api.url, TOKEN, cursor.map(str::to_string), 1, Duration::from_millis(500)).unwrap()
    }

    fn text_update(id: i64, chat_type: &str, from: i64, text: &str) -> Value {
        json!({ "update_id": id, "message": {
            "message_id": id * 10, "text": text,
            "chat": { "id": from, "type": chat_type },
            "from": { "id": from, "is_bot": false, "first_name": "Ale", "last_name": "B" }
        }})
    }

    #[tokio::test]
    async fn the_webhook_is_checked_first_then_a_long_poll_from_the_saved_offset_that_moves_on() {
        let api = FakeApi::start();
        api.then("getUpdates", 200, json!({ "ok": true, "result": [
            text_update(10, "private", 42, "ciao"),
            text_update(11, "group", 42, "nel gruppo"),
            { "update_id": 12, "message": { "message_id": 5, "chat": { "id": 42, "type": "private" }, "from": { "id": 42 }, "sticker": {} } }
        ]}));
        let telegram = adapter(&api, Some("7"));
        let batch = telegram.receive().await.unwrap();
        assert_eq!(batch.len(), 2, "lo sticker non è un messaggio: {batch:?}");
        assert_eq!(batch[0].text, "ciao");
        assert_eq!((batch[0].chat.as_str(), batch[0].sender.id.as_str(), batch[0].sender.name.as_str()), ("42", "42", "Ale B"));
        assert!(batch[0].private && !batch[1].private);
        assert!(!batch[0].button);
        assert_eq!(telegram.cursor().as_deref(), Some("13"));
        telegram.receive().await.unwrap();
        let calls = api.calls.lock().unwrap().clone();
        assert!(calls[0].0.ends_with("/getWebhookInfo"), "{calls:?}");
        assert!(calls.iter().all(|(path, _)| path.starts_with(&format!("/bot{TOKEN}/"))));
        let polls = api.calls_to("getUpdates");
        assert_eq!(polls[0]["offset"], 7);
        assert_eq!(polls[0]["timeout"], 1);
        assert_eq!(polls[0]["allowed_updates"], json!(["message", "callback_query"]));
        assert_eq!(polls[1]["offset"], 13);
        assert_eq!(api.calls_to("getWebhookInfo").len(), 1, "una volta sola");
        assert!(api.calls_to("deleteWebhook").is_empty());
    }

    #[tokio::test]
    async fn the_panel_s_test_asks_telegram_who_the_bot_is_and_a_refused_token_says_so() {
        let api = FakeApi::start();
        api.then("getMe", 200, json!({ "ok": true, "result": { "id": 1, "is_bot": true, "first_name": "Mio", "username": "mio_bot" } }));
        assert_eq!(adapter(&api, None).whoami().await.unwrap(), "@mio_bot");
        assert_eq!(api.calls_to("getMe").len(), 1);
        let api = FakeApi::start();
        api.then("getMe", 401, json!({ "ok": false, "error_code": 401, "description": "Unauthorized" }));
        let Err(AdapterError::Fatal(error)) = adapter(&api, None).whoami().await else { panic!("non fatale") };
        assert!(error.contains("rifiuta il token"), "{error}");
        assert!(!error.contains(TOKEN));
    }

    #[tokio::test]
    async fn a_409_is_the_token_in_use_elsewhere_and_a_401_a_refused_token() {
        let api = FakeApi::start();
        api.then("getUpdates", 409, json!({ "ok": false, "error_code": 409, "description": "Conflict: terminated by other getUpdates request" }));
        let Err(AdapterError::Fatal(error)) = adapter(&api, None).receive().await else { panic!("non fatale") };
        assert!(error.contains("in uso altrove"), "{error}");
        let api = FakeApi::start();
        api.then("getWebhookInfo", 401, json!({ "ok": false, "error_code": 401, "description": "Unauthorized" }));
        let Err(AdapterError::Fatal(error)) = adapter(&api, None).receive().await else { panic!("non fatale") };
        assert!(error.contains("rifiuta il token"), "{error}");
        let api = FakeApi::start();
        api.then("getUpdates", 502, json!({ "ok": false, "error_code": 502, "description": "Bad Gateway" }));
        assert!(matches!(adapter(&api, None).receive().await, Err(AdapterError::Transient(_))));
    }

    #[tokio::test]
    async fn a_bot_whose_messages_go_to_another_service_is_left_alone_and_the_gateway_says_why() {
        let api = FakeApi::start();
        api.then("getWebhookInfo", 200, json!({ "ok": true, "result": { "url": "https://altro-servizio.example/hook", "pending_update_count": 3 } }));
        let Err(AdapterError::Fatal(error)) = adapter(&api, None).receive().await else { panic!("non fatale") };
        assert!(error.contains("altro servizio"), "{error}");
        assert!(api.calls_to("deleteWebhook").is_empty(), "il webhook dell'altro servizio non si tocca");
        assert!(api.calls_to("getUpdates").is_empty());
    }

    #[tokio::test]
    async fn a_429_waits_what_telegram_asks_and_then_goes_on() {
        let api = FakeApi::start();
        let limited = json!({ "ok": false, "error_code": 429, "description": "Too Many Requests: retry after 1", "parameters": { "retry_after": 1 } });
        api.then("sendMessage", 429, limited.clone());
        api.then("getUpdates", 429, limited);
        let telegram = adapter(&api, None);
        let started = std::time::Instant::now();
        assert_eq!(telegram.send("42", "ciao").await.unwrap(), "102");
        assert!(started.elapsed() >= Duration::from_secs(1));
        assert_eq!(api.calls_to("sendMessage").len(), 2);
        let started = std::time::Instant::now();
        assert!(telegram.receive().await.unwrap().is_empty());
        assert!(started.elapsed() >= Duration::from_secs(1));
    }

    #[tokio::test]
    async fn a_long_reply_goes_in_pieces_and_its_code_block_stays_code() {
        let api = FakeApi::start();
        let code: String = (0..400).map(|n| format!("let valore_{n} = {n};\n")).collect();
        let text = format!("Ecco il file:\n```rust\n{code}```\nFatto.");
        let id = adapter(&api, None).send("42", &text).await.unwrap();
        let sent = api.calls_to("sendMessage");
        assert!(sent.len() >= 3, "{}", sent.len());
        assert_eq!(id, format!("{}", 100 + sent.len()));
        for body in &sent {
            assert_eq!(body["parse_mode"], "MarkdownV2");
            assert_eq!(body["chat_id"], 42);
            let text = body["text"].as_str().unwrap();
            // Telegram counts the text after the escapes are taken out.
            let mut shown = String::new();
            let mut chars = text.chars();
            while let Some(c) = chars.next() {
                shown.push(if c == '\\' { chars.next().unwrap_or(c) } else { c });
            }
            assert!(utf16(&shown) <= MAX_LEN, "{} unità dopo gli escape", utf16(&shown));
            assert_eq!(text.matches("```").count() % 2, 0, "{text}");
        }
        assert!(sent[1]["text"].as_str().unwrap().starts_with("```rust\n"));
    }

    #[tokio::test]
    async fn markdown_telegram_cannot_parse_is_sent_again_as_plain_text() {
        let api = FakeApi::start();
        api.then("sendMessage", 400, json!({ "ok": false, "error_code": 400, "description": "Bad Request: can't parse entities: Character '.' is reserved" }));
        adapter(&api, None).send("42", "Fatto. **quasi**").await.unwrap();
        let sent = api.calls_to("sendMessage");
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["text"], "Fatto\\. *quasi*");
        assert_eq!(sent[1]["text"], "Fatto. **quasi**");
        assert!(sent[1].get("parse_mode").is_none());
    }

    #[tokio::test]
    async fn a_send_that_timed_out_is_not_sent_twice_and_says_why() {
        let api = FakeApi::start();
        api.then_after("sendMessage", 200, json!({ "ok": true, "result": { "message_id": 1 } }), 1500);
        let Err(AdapterError::Transient(error)) = adapter(&api, None).send("42", "ciao").await else { panic!("non transitorio") };
        assert!(error.contains("potrebbe essere arrivato"), "{error}");
        assert_eq!(api.calls_to("sendMessage").len(), 1);
        assert!(!error.contains(TOKEN));
    }

    #[tokio::test]
    async fn an_unreachable_telegram_is_an_error_without_the_token() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let telegram = Telegram::at(&format!("http://127.0.0.1:{port}"), TOKEN, None, 1, Duration::from_millis(500)).unwrap();
        let Err(AdapterError::Transient(error)) = telegram.receive().await else { panic!("non transitorio") };
        assert!(!error.contains(TOKEN) && !error.contains("123456789"), "{error}");
        assert!(error.contains("non raggiungibile"), "{error}");
    }

    #[tokio::test]
    async fn an_edit_past_the_limit_goes_on_in_new_messages_instead_of_being_cut() {
        let api = FakeApi::start();
        let text: String = (0..900).map(|n| format!("riga {n}\n")).collect();
        let last = adapter(&api, None).edit("42", "77", &text).await.unwrap();
        let edits = api.calls_to("editMessageText");
        let sent = api.calls_to("sendMessage");
        assert_eq!(edits.len(), 1);
        assert_eq!(edits[0]["message_id"], 77);
        assert!(!sent.is_empty());
        assert_eq!(last, format!("{}", 100 + sent.len()), "l'id dell'ultimo messaggio, dove continuare");
        // Nothing lost: every line is in exactly one message.
        let all: String = edits.iter().chain(sent.iter()).map(|body| body["text"].as_str().unwrap().to_string()).collect::<Vec<_>>().join("\n");
        for n in [0, 450, 899] {
            assert_eq!(all.matches(&format!("riga {n}\n")).count() + usize::from(all.ends_with(&format!("riga {n}"))), 1, "riga {n}");
        }
    }

    #[tokio::test]
    async fn a_press_is_answered_at_once_and_comes_back_as_a_button() {
        let api = FakeApi::start();
        api.then("getUpdates", 200, json!({ "ok": true, "result": [{ "update_id": 20, "callback_query": {
            "id": "cb-1", "data": "ok:1",
            "from": { "id": 7, "is_bot": false, "first_name": "Sconosciuto" },
            "message": { "message_id": 99, "chat": { "id": 42, "type": "private" } }
        }}]}));
        let batch = adapter(&api, None).receive().await.unwrap();
        assert_eq!(batch.len(), 1);
        assert!(batch[0].button);
        assert_eq!((batch[0].text.as_str(), batch[0].sender.id.as_str(), batch[0].chat.as_str()), ("ok:1", "7", "42"));
        assert_eq!(api.calls_to("answerCallbackQuery")[0]["callback_query_id"], "cb-1");
    }

    #[tokio::test]
    async fn buttons_go_under_the_last_piece_and_edit_and_typing_work() {
        let api = FakeApi::start();
        let telegram = adapter(&api, None);
        let buttons = [("Sì", "ok"), ("No", "no"), ("Forse", "boh")].map(|(label, data)| Button { label: label.into(), data: data.into() });
        telegram.send_buttons("42", "Procedo?", &buttons).await.unwrap();
        let sent = api.calls_to("sendMessage");
        assert_eq!(
            sent[0]["reply_markup"],
            json!({ "inline_keyboard": [
                [{ "text": "Sì", "callback_data": "ok" }, { "text": "No", "callback_data": "no" }],
                [{ "text": "Forse", "callback_data": "boh" }]
            ]})
        );
        api.then("editMessageText", 400, json!({ "ok": false, "error_code": 400, "description": "Bad Request: message is not modified" }));
        assert_eq!(telegram.edit("42", "101", "Procedo?").await.unwrap(), "101");
        assert_eq!(telegram.edit("42", "101", "Fatto.").await.unwrap(), "101");
        let edits = api.calls_to("editMessageText");
        assert_eq!((edits[1]["message_id"].as_i64(), edits[1]["text"].as_str()), (Some(101), Some("Fatto\\.")));
        telegram.typing("42").await.unwrap();
        assert_eq!(api.calls_to("sendChatAction")[0]["action"], "typing");
        assert!(telegram.edit("42", "non-un-numero", "x").await.is_err());
        assert!(telegram.send("42", "   ").await.is_err());
    }
}
