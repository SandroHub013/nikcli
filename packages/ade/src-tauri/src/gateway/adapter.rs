//! What a chat platform has to do for a bot's gateway, whatever it is.
//!
//! One adapter per bot and platform: it owns the connection (a long poll, a
//! socket) and speaks the platform's API. Everything else — who may write,
//! which chats may be answered, what the page is told, the secrets taken out
//! of a reply — is the same for every platform and lives in `hub.rs`.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// The platforms a gateway can connect to. An adapter for each comes in its
/// own piece (Telegram first); until then enabling one is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Telegram,
    Discord,
    Slack,
    /// The tests' platform: no network, no token of any real service.
    #[cfg(test)]
    Fake,
}

impl Platform {
    pub fn id(self) -> &'static str {
        match self {
            Platform::Telegram => "telegram",
            Platform::Discord => "discord",
            Platform::Slack => "slack",
            #[cfg(test)]
            Platform::Fake => "fake",
        }
    }
}

/// Who wrote: the platform's fixed id, never the user name, which can change hands.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sender {
    pub id: String,
    /// What the platform shows. Untrusted text: for display only.
    pub name: String,
    /// Another bot, the gateway's own included. Never answered.
    pub is_bot: bool,
}

/// A message as it arrived, before anything decided about it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inbound {
    /// The platform's id for the message.
    pub id: String,
    pub chat: String,
    /// A one-to-one chat with the bot. A private chat needs no more than this
    /// to be answered.
    pub private: bool,
    /// The bot was named in the text of a message that is not a private chat,
    /// so a group channel can be answered when the author says so. Decided on
    /// the raw `<@id>` token and never on the platform's mention list, because
    /// a reply that quotes the bot puts it in that list without the author
    /// having written its name.
    pub mentioned: bool,
    pub sender: Sender,
    /// The message's text; for a button, the data it carries.
    pub text: String,
    /// A button under one of the bot's messages was pressed. Whoever pressed
    /// it is checked like a sender; a stranger's press gets no pairing code.
    pub button: bool,
}

/// Whether the hub hands a message to the page.
///
/// A private chat is a conversation the user opened with the bot, so it is
/// answered. A group channel is answered only when the author named the bot:
/// without that, the bot would answer every message in a room it happens to sit
/// in. A platform that cannot tell the two apart says so with `private`, and
/// the same rule as Telegram applies.
pub fn admits(inbound: &Inbound) -> bool {
    inbound.private || inbound.mentioned
}

/// A button under a message: what it shows, and what comes back when pressed.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Button {
    pub label: String,
    pub data: String,
}

/// What a platform can do beyond sending text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Characters per message; longer replies are split (with the platform's adapter).
    pub max_len: usize,
    pub edit: bool,
    pub typing: bool,
    pub buttons: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdapterError {
    /// The platform has no such operation.
    Unsupported,
    /// Worth trying again after a pause: the network, a timeout, a 5xx.
    Transient(String),
    /// Not worth trying again: a refused token, a token in use elsewhere.
    Fatal(String),
}

impl AdapterError {
    pub fn message(&self) -> String {
        match self {
            AdapterError::Unsupported => "operazione non disponibile su questa piattaforma".into(),
            AdapterError::Transient(text) | AdapterError::Fatal(text) => text.clone(),
        }
    }
}

/// A platform connection. Errors must not carry the token: the hub also takes
/// every known secret out of them, but an adapter does not put it there.
#[async_trait]
pub trait Adapter: Send + Sync {
    fn capabilities(&self) -> Capabilities;
    /// Waits for what arrived since the last call. An empty batch is a quiet
    /// period (a long poll that timed out), not an error.
    async fn receive(&self) -> Result<Vec<Inbound>, AdapterError>;
    /// Sends `text` to `chat`, in as many messages as the platform's limit
    /// needs; returns the platform's id for the last one.
    async fn send(&self, chat: &str, text: &str) -> Result<String, AdapterError>;
    /// The same, with buttons under the last message.
    async fn send_buttons(&self, _chat: &str, _text: &str, _buttons: &[Button]) -> Result<String, AdapterError> {
        Err(AdapterError::Unsupported)
    }
    /// Where the stream has been read up to, after the last `receive`: saved
    /// once that batch was handed on, and given back when the adapter is made
    /// again. None for a platform that does not need one.
    fn cursor(&self) -> Option<String> {
        None
    }
    /// Changes `message` to `text`. What does not fit in one message goes on
    /// in new ones after it; returns the id of the message that now holds the
    /// end of the text, for an answer that keeps growing to be edited there.
    async fn edit(&self, _chat: &str, _message: &str, _text: &str) -> Result<String, AdapterError> {
        Err(AdapterError::Unsupported)
    }
    /// «Sta scrivendo»; a platform without it does nothing.
    async fn typing(&self, _chat: &str) -> Result<(), AdapterError> {
        Ok(())
    }
    /// The bot's own name on the platform, for the panel's «Prova»: the token
    /// works, and it is this bot's.
    async fn whoami(&self) -> Result<String, AdapterError> {
        Err(AdapterError::Unsupported)
    }
}

/// The tests' adapter: batches go in through a channel, what is sent is kept.
#[cfg(test)]
pub mod fake {
    use super::*;
    use std::sync::Mutex;
    use tokio::sync::mpsc;

    pub struct FakeAdapter {
        inbox: tokio::sync::Mutex<mpsc::UnboundedReceiver<Result<Vec<Inbound>, AdapterError>>>,
        pub sent: Mutex<Vec<(String, String)>>,
        pub edited: Mutex<Vec<(String, String, String)>>,
        pub typing: Mutex<Vec<String>>,
        pub buttons: Mutex<Vec<(String, String, Vec<Button>)>>,
        pub receives: std::sync::atomic::AtomicUsize,
        /// What `cursor` reports: the tests set it with each batch.
        pub position: Mutex<Option<String>>,
    }

    pub type Feed = mpsc::UnboundedSender<Result<Vec<Inbound>, AdapterError>>;

    impl FakeAdapter {
        pub fn new() -> (std::sync::Arc<FakeAdapter>, Feed) {
            let (tx, rx) = mpsc::unbounded_channel();
            let adapter = FakeAdapter {
                inbox: tokio::sync::Mutex::new(rx),
                sent: Mutex::new(Vec::new()),
                edited: Mutex::new(Vec::new()),
                typing: Mutex::new(Vec::new()),
                buttons: Mutex::new(Vec::new()),
                receives: std::sync::atomic::AtomicUsize::new(0),
                position: Mutex::new(None),
            };
            (std::sync::Arc::new(adapter), tx)
        }
    }

    #[async_trait]
    impl Adapter for FakeAdapter {
        fn capabilities(&self) -> Capabilities {
            Capabilities { max_len: 4096, edit: true, typing: true, buttons: false }
        }
        async fn receive(&self) -> Result<Vec<Inbound>, AdapterError> {
            self.receives.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            match self.inbox.lock().await.recv().await {
                Some(batch) => batch,
                // The test dropped its feed: wait like a quiet long poll would.
                None => std::future::pending().await,
            }
        }
        async fn send(&self, chat: &str, text: &str) -> Result<String, AdapterError> {
            let mut sent = self.sent.lock().unwrap();
            sent.push((chat.into(), text.into()));
            Ok(format!("m{}", sent.len()))
        }
        async fn edit(&self, chat: &str, message: &str, text: &str) -> Result<String, AdapterError> {
            self.edited.lock().unwrap().push((chat.into(), message.into(), text.into()));
            Ok(message.into())
        }
        async fn typing(&self, chat: &str) -> Result<(), AdapterError> {
            self.typing.lock().unwrap().push(chat.into());
            Ok(())
        }
        async fn send_buttons(&self, chat: &str, text: &str, buttons: &[Button]) -> Result<String, AdapterError> {
            self.buttons.lock().unwrap().push((chat.into(), text.into(), buttons.to_vec()));
            Ok("b1".into())
        }
        fn cursor(&self) -> Option<String> {
            self.position.lock().unwrap().clone()
        }
        async fn whoami(&self) -> Result<String, AdapterError> {
            Ok("@finto_bot\u{202e}".into())
        }
    }
}
