//! The gateways' core: one task per bot and platform that is switched on.
//!
//! Each task reads its adapter and decides, here in Rust, what reaches the
//! page: a message from an authorized sender, in a private chat, from a
//! person and not a bot. Anything else stops here, so a stranger's text never
//! becomes a turn: a stranger gets a pairing code instead (`authz.rs`), and
//! becomes authorized only when the user types it in ADE. The page answers with `send`, which goes only to chats an
//! authorized sender wrote from and loses every known secret on the way out.
//!
//! Nothing here needs the app: the events, the log and the secrets to hide
//! come through `Env`, the keychain through `Vault`, so the tests drive it
//! with a fake adapter and no token of any real service.

use super::adapter::{admits, Adapter, AdapterError, Button, Capabilities, Inbound, Platform};
use super::authz::{self, Request};
use super::redact::redact;
use super::store::{Authorized, LinkState, Store};
use crate::secrets::Vault;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// A message for the page: from an authorized sender, secrets already out.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayMessage {
    pub bot: String,
    pub platform: Platform,
    pub chat: String,
    pub sender: MessageSender,
    pub text: String,
    pub id: String,
    /// A known secret was taken out of the text or the name: the page tells the
    /// user it was hidden and not used, or they would not know why.
    pub redacted: bool,
    /// A button was pressed; `text` is the data it carried.
    pub button: bool,
}

/// How many buttons a message may carry, and how long their parts may be:
/// Telegram's callback data is at most 64 bytes.
const MAX_BUTTONS: usize = 12;
const MAX_BUTTON_DATA: usize = 64;
const MAX_BUTTON_LABEL: usize = 64;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct MessageSender {
    pub id: String,
    pub name: String,
}

/// How a running link is doing, sent to the page as it changes.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub bot: String,
    pub platform: Platform,
    /// False once a fatal error stopped it: it stays on, but nothing reads.
    pub running: bool,
    pub connected: bool,
    pub last_error: Option<String>,
    pub last_message_ms: Option<u64>,
}

/// What the panel shows of a gateway. No token: only whether there is one.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusInfo {
    pub bot: String,
    pub platform: Platform,
    pub enabled: bool,
    pub running: bool,
    pub connected: bool,
    pub has_token: bool,
    pub project: Option<String>,
    pub last_error: Option<String>,
    pub last_message_ms: Option<u64>,
    pub authorized: Vec<MessageSender>,
    /// The running adapter's: how long a message may be, whether it can be edited.
    pub capabilities: Option<Capabilities>,
}

/// A stranger asked to pair: for the panel, which asks the user for the code.
/// The code itself is only in the stranger's chat.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingRequest {
    pub bot: String,
    pub platform: Platform,
    /// For refusing it; unrelated to the code.
    pub request: String,
    pub sender: MessageSender,
    pub created_ms: u64,
    pub expires_ms: u64,
}

/// What the panel shows of a link's pairing: who waits, who is in, and
/// whether wrong codes locked it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    /// Whether a stranger writing now gets a code.
    pub open: bool,
    pub open_until_ms: Option<u64>,
    pub pending: Vec<PairingRequest>,
    pub authorized: Vec<AuthorizedInfo>,
    pub locked_until_ms: Option<u64>,
    pub attempts_left: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedInfo {
    pub id: String,
    pub name: String,
    pub added_ms: u64,
}

/// What a stranger reads: the only text a gateway sends on its own.
fn code_message(code: &str) -> String {
    let code = authz::show(code);
    format!(
        "Codice di abbinamento: {code}\nPer collegare questo account al bot, inseriscilo in ADE, nella scheda del bot, alla voce Gateway. Scade tra un'ora.\n\nPairing code: {code}\nTo link this account to the bot, enter it in ADE, in the bot's Gateway section. It expires in one hour."
    )
}

const PAIRED_MESSAGE: &str = "Abbinamento fatto: ora questo bot ti risponde.\nPaired: this bot now answers you.";

/// Where the hub reports, and what it hides.
pub trait Env: Send + Sync {
    fn message(&self, message: &GatewayMessage);
    fn pairing(&self, request: &PairingRequest);
    fn status(&self, status: &LinkStatus);
    /// A diagnostic line. Called with metadata only: never a message's text or a token.
    fn log(&self, line: &str);
    /// Secret values besides the gateway tokens: the keys in the keychain,
    /// nikcli's provider keys, the keys in ADE's environment.
    fn secrets(&self) -> Vec<String>;
    fn now_ms(&self) -> u64;
}

#[derive(Clone, Default)]
struct Live {
    connected: bool,
    last_error: Option<String>,
    last_message_ms: Option<u64>,
    /// A fatal error ended the task: switched on, but not reading or answering.
    stopped: bool,
}

struct Running {
    adapter: Arc<dyn Adapter>,
    stop: watch::Sender<bool>,
    live: Arc<Mutex<Live>>,
}

/// Builds a platform's adapter from the bot's token and where its stream was
/// last read up to.
pub type Connect = Arc<dyn Fn(Platform, &str, Option<String>) -> Result<Arc<dyn Adapter>, String> + Send + Sync>;

pub struct Hub {
    env: Arc<dyn Env>,
    vault: Arc<dyn Vault>,
    /// The keychain service the tokens are filed under, apart from the API keys.
    service: String,
    store: Arc<Store>,
    connect: Connect,
    links: Mutex<HashMap<(String, Platform), Running>>,
    /// Links switched on that could not start (no token, a platform refused):
    /// the panel shows why, and they stay on for the user to fix.
    failed: Mutex<HashMap<(String, Platform), String>>,
    /// Whether the page listens for messages. Until it does, no gateway
    /// reads: a message read then would be handed to nobody, and its
    /// position saved as if it had been.
    ready: watch::Sender<bool>,
    /// The first pause after a failed read, and the longest.
    backoff: (Duration, Duration),
}

/// A bot as the keychain names it: a hash, since a file path can be long and
/// hold characters a credential name may not.
pub fn bot_key(bot: &str) -> String {
    hex(&Sha256::digest(bot.as_bytes()))[..32].to_string()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn token_name(bot: &str, platform: Platform) -> String {
    format!("{}:{}", platform.id(), bot_key(bot))
}

fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

pub fn check_bot(bot: &str) -> Result<(), String> {
    if bot.trim().is_empty() || bot.len() > 1024 || bot.chars().any(char::is_control) {
        return Err("bot non valido".into());
    }
    Ok(())
}

fn check_token(token: &str) -> Result<(), String> {
    let length = token.chars().count();
    if !(8..=1024).contains(&length) || token.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("token non valido: incollalo intero, senza spazi".into());
    }
    Ok(())
}

impl Hub {
    pub fn new(env: Arc<dyn Env>, vault: Arc<dyn Vault>, service: String, store: Arc<Store>, connect: Connect) -> Hub {
        Hub {
            env,
            vault,
            service,
            store,
            connect,
            links: Mutex::new(HashMap::new()),
            failed: Mutex::new(HashMap::new()),
            ready: watch::channel(false).0,
            backoff: (Duration::from_secs(1), Duration::from_secs(300)),
        }
    }

    #[cfg(test)]
    fn with_backoff(mut self, first: Duration, max: Duration) -> Hub {
        self.backoff = (first, max);
        self
    }

    fn links(&self) -> std::sync::MutexGuard<'_, HashMap<(String, Platform), Running>> {
        self.links.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn failed(&self) -> std::sync::MutexGuard<'_, HashMap<(String, Platform), String>> {
        self.failed.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /* ── the token ─────────────────────────────────────────────────────── */

    /// Saves the bot's token for `platform` in the keychain. The same token on
    /// another bot or platform is refused: two gateways reading one bot
    /// account would each take half of its messages. A gateway switched on
    /// starts again with the new token; the old one is no longer read.
    pub fn set_token(&self, bot: &str, platform: Platform, token: &str) -> Result<(), String> {
        check_bot(bot)?;
        let token = token.trim();
        check_token(token)?;
        let hash = token_hash(token);
        let taken = |others: &[LinkState]| others.iter().any(|other| other.token_hash.as_deref() == Some(hash.as_str()));
        if taken(&self.store.read().links.into_iter().filter(|l| !(l.bot == bot && l.platform == platform)).collect::<Vec<_>>()) {
            return Err("questo token è già di un altro bot o di un'altra piattaforma".into());
        }
        self.vault.set(&self.service, &token_name(bot, platform), token)?;
        self.store.update(bot, platform, |link, others| {
            if taken(others) {
                return Err("questo token è già di un altro bot o di un'altra piattaforma".into());
            }
            link.token_hash = Some(hash.clone());
            Ok(())
        })?;
        if self.store.link(bot, platform).is_some_and(|link| link.enabled) {
            self.relaunch(bot, platform);
        }
        Ok(())
    }

    /// Forgets the token: the gateway stops and is switched off.
    pub fn clear_token(&self, bot: &str, platform: Platform) -> Result<(), String> {
        check_bot(bot)?;
        self.halt(bot, platform);
        self.failed().remove(&(bot.to_string(), platform));
        self.vault.delete(&self.service, &token_name(bot, platform))?;
        self.store.update(bot, platform, |link, _| {
            link.token_hash = None;
            link.enabled = false;
            Ok(())
        })
    }

    /// The token, for building the platform's adapter. Rust only: never sent to the page.
    pub fn token(&self, bot: &str, platform: Platform) -> Result<Option<String>, String> {
        self.vault.get(&self.service, &token_name(bot, platform))
    }

    /// Every value that must not leave through a gateway: the tokens and the keychain's keys.
    fn secrets(&self) -> Vec<String> {
        let mut secrets = self.env.secrets();
        for link in self.store.read().links.iter().filter(|link| link.token_hash.is_some()) {
            if let Ok(Some(token)) = self.vault.get(&self.service, &token_name(&link.bot, link.platform)) {
                secrets.push(token);
            }
        }
        secrets
    }

    /// The panel's «Prova»: the bot's name as the platform knows it, with the
    /// saved token. Never the token; the name cleaned like a sender's.
    pub async fn probe(&self, bot: &str, platform: Platform) -> Result<String, String> {
        check_bot(bot)?;
        let adapter = self.connect(bot, platform)?;
        match adapter.whoami().await {
            Ok(name) => Ok(authz::clean_name(&redact(&name, &self.secrets()))),
            Err(error) => Err(redact(&error.message(), &self.secrets())),
        }
    }

    /* ── on and off ────────────────────────────────────────────────────── */

    /// Switches the gateway on, its turns fixed to `project`.
    pub fn start(&self, bot: &str, platform: Platform, project: &str) -> Result<(), String> {
        check_bot(bot)?;
        if project.trim().is_empty() {
            return Err("scegli il progetto in cui gireranno i turni da chat".into());
        }
        let adapter = self.connect(bot, platform)?;
        self.halt(bot, platform);
        self.store.update(bot, platform, |link, _| {
            link.enabled = true;
            link.project = Some(project.to_string());
            Ok(())
        })?;
        self.launch(bot, platform, adapter);
        Ok(())
    }

    /// The platform's adapter, with the bot's token and the saved position.
    fn connect(&self, bot: &str, platform: Platform) -> Result<Arc<dyn Adapter>, String> {
        let token = self.token(bot, platform)?.ok_or_else(|| "manca il token del bot per questa piattaforma".to_string())?;
        let cursor = self.store.link(bot, platform).and_then(|link| link.cursor);
        (self.connect)(platform, &token, cursor).map_err(|error| redact(&error, &[token]))
    }

    /// Starts every gateway the user left switched on: ADE opened. Each waits
    /// for the page to listen before it reads.
    pub fn resume(&self) {
        for link in self.store.read().links.into_iter().filter(|link| link.enabled) {
            self.relaunch(&link.bot, link.platform);
        }
    }

    /// The page listens for `gateway:message`: the gateways may read.
    pub fn ready(&self) {
        self.ready.send_replace(true);
    }

    /// The page is loading again (a reload, a renderer that crashed): its
    /// listener is gone until the new page says `ready`. Until then nothing is
    /// handed on, and a batch already read waits, its position unsaved.
    pub fn unready(&self) {
        self.ready.send_replace(false);
    }

    /// Starts a link that is switched on again, from what is saved: after a
    /// new token, or when ADE opens. If it cannot, it stays on with the reason.
    fn relaunch(&self, bot: &str, platform: Platform) {
        self.halt(bot, platform);
        match self.connect(bot, platform) {
            Ok(adapter) => self.launch(bot, platform, adapter),
            Err(error) => {
                self.env.log(&format!("gateway {} {}: non riparte: {error}", platform.id(), &bot_key(bot)[..8]));
                self.env.status(&LinkStatus {
                    bot: bot.to_string(),
                    platform,
                    running: false,
                    connected: false,
                    last_error: Some(error.clone()),
                    last_message_ms: None,
                });
                self.failed().insert((bot.to_string(), platform), error);
            }
        }
    }

    fn launch(&self, bot: &str, platform: Platform, adapter: Arc<dyn Adapter>) {
        self.failed().remove(&(bot.to_string(), platform));
        let (stop, stopped) = watch::channel(false);
        let live = Arc::new(Mutex::new(Live::default()));
        let task = Task {
            env: self.env.clone(),
            store: self.store.clone(),
            adapter: adapter.clone(),
            bot: bot.to_string(),
            platform,
            live: live.clone(),
            secrets: self.secrets(),
            backoff: self.backoff,
        };
        tokio::spawn(task.run(stopped, self.ready.subscribe()));
        self.links().insert((bot.to_string(), platform), Running { adapter, stop, live });
    }

    /// Switches the gateway off, and remembers it is off.
    pub fn stop(&self, bot: &str, platform: Platform) -> Result<(), String> {
        check_bot(bot)?;
        self.halt(bot, platform);
        self.failed().remove(&(bot.to_string(), platform));
        self.store.update(bot, platform, |link, _| {
            link.enabled = false;
            Ok(())
        })
    }

    fn halt(&self, bot: &str, platform: Platform) {
        if let Some(running) = self.links().remove(&(bot.to_string(), platform)) {
            let _ = running.stop.send(true);
        }
    }

    /// ADE is closing: every task ends, and each gateway stays as the user left it.
    pub fn shutdown(&self) {
        for (_, running) in self.links().drain() {
            let _ = running.stop.send(true);
        }
    }

    /* ── replies ───────────────────────────────────────────────────────── */

    /// The running adapter, when `chat` is one an authorized sender wrote from.
    fn reply_target(&self, bot: &str, platform: Platform, chat: &str) -> Result<Arc<dyn Adapter>, String> {
        let (adapter, live) = self
            .links()
            .get(&(bot.to_string(), platform))
            .map(|running| (running.adapter.clone(), running.live.lock().map(|live| live.clone()).unwrap_or_default()))
            .ok_or_else(|| "il gateway di questo bot è spento".to_string())?;
        if live.stopped {
            return Err(format!("il gateway di questo bot si è fermato: {}", live.last_error.unwrap_or_default()));
        }
        let known = self.store.link(bot, platform).is_some_and(|link| link.knows_chat(chat));
        if !known {
            return Err("questa chat non ha mai scritto al bot da un account autorizzato".into());
        }
        Ok(adapter)
    }

    pub async fn send(&self, bot: &str, platform: Platform, chat: &str, text: &str) -> Result<String, String> {
        let adapter = self.reply_target(bot, platform, chat)?;
        let secrets = self.secrets();
        adapter.send(chat, &redact(text, &secrets)).await.map_err(|error| redact(&error.message(), &secrets))
    }

    /// A reply with buttons under it. A press comes back as a message with
    /// `button: true`, and only from an authorized sender.
    pub async fn send_buttons(&self, bot: &str, platform: Platform, chat: &str, text: &str, buttons: &[Button]) -> Result<String, String> {
        if buttons.is_empty() || buttons.len() > MAX_BUTTONS {
            return Err(format!("da 1 a {MAX_BUTTONS} bottoni per messaggio"));
        }
        if buttons.iter().any(|button| {
            button.label.trim().is_empty() || button.label.chars().count() > MAX_BUTTON_LABEL || button.data.is_empty() || button.data.len() > MAX_BUTTON_DATA
        }) {
            return Err(format!("ogni bottone vuole un'etichetta (al massimo {MAX_BUTTON_LABEL} caratteri) e dati di al massimo {MAX_BUTTON_DATA} byte"));
        }
        let adapter = self.reply_target(bot, platform, chat)?;
        let secrets = self.secrets();
        let buttons: Vec<Button> = buttons
            .iter()
            .map(|button| Button { label: redact(&button.label, &secrets), data: button.data.clone() })
            .collect();
        adapter
            .send_buttons(chat, &redact(text, &secrets), &buttons)
            .await
            .map_err(|error| redact(&error.message(), &secrets))
    }

    /// Returns the id of the message that now holds the end of `text`.
    pub async fn edit(&self, bot: &str, platform: Platform, chat: &str, message: &str, text: &str) -> Result<String, String> {
        let adapter = self.reply_target(bot, platform, chat)?;
        let secrets = self.secrets();
        adapter
            .edit(chat, message, &redact(text, &secrets))
            .await
            .map_err(|error| redact(&error.message(), &secrets))
    }

    pub async fn typing(&self, bot: &str, platform: Platform, chat: &str) -> Result<(), String> {
        let adapter = self.reply_target(bot, platform, chat)?;
        adapter.typing(chat).await.map_err(|error| redact(&error.message(), &self.secrets()))
    }

    /* ── pairing ───────────────────────────────────────────────────────── */

    pub fn pairing_list(&self, bot: &str, platform: Platform) -> Result<PairingInfo, String> {
        check_bot(bot)?;
        let now = self.env.now_ms();
        let link = self.store.link(bot, platform).unwrap_or_else(|| LinkState::new(bot, platform));
        let mut pairing = link.pairing.clone();
        pairing.prune(now);
        Ok(PairingInfo {
            open: pairing.is_open(!link.authorized.is_empty(), now),
            open_until_ms: pairing.open_until_ms,
            pending: pairing.pending.iter().map(|pending| pairing_request(bot, platform, pending)).collect(),
            authorized: link
                .authorized
                .into_iter()
                .map(|a| AuthorizedInfo { id: a.id, name: a.name, added_ms: a.added_ms })
                .collect(),
            locked_until_ms: pairing.locked_until_ms,
            attempts_left: pairing.attempts_left(now),
        })
    }

    /// The user typed a code in ADE. Its sender becomes authorized, and their
    /// chat may be answered; a running gateway tells them so.
    pub async fn pairing_approve(&self, bot: &str, platform: Platform, code: &str) -> Result<AuthorizedInfo, String> {
        check_bot(bot)?;
        let now = self.env.now_ms();
        // A wrong code is saved too: it counts toward the lockout even across a restart.
        let outcome = self.store.update(bot, platform, |link, _| {
            let pending = match link.pairing.approve(code, now) {
                Ok(pending) => pending,
                Err(error) => return Ok(Err(error)),
            };
            if !link.is_authorized(&pending.sender) {
                link.authorized.push(Authorized { id: pending.sender.clone(), name: pending.name.clone(), added_ms: now });
            }
            link.remember_chat(&pending.chat, &pending.sender);
            Ok(Ok(pending))
        })?;
        let tag = format!("gateway {} {}", platform.id(), &bot_key(bot)[..8]);
        let pending = match outcome {
            Ok(pending) => pending,
            Err(error) => {
                self.env.log(&format!("{tag}: codice di abbinamento rifiutato"));
                return Err(error);
            }
        };
        self.env.log(&format!("{tag}: abbinamento approvato in ADE"));
        let running = self.links().get(&(bot.to_string(), platform)).map(|running| running.adapter.clone());
        if let Some(adapter) = running {
            if let Err(error) = adapter.send(&pending.chat, PAIRED_MESSAGE).await {
                self.env.log(&format!("{tag}: conferma dell'abbinamento non mandata: {}", redact(&error.message(), &self.secrets())));
            }
        }
        Ok(AuthorizedInfo { id: pending.sender, name: pending.name, added_ms: now })
    }

    /// Takes `sender` off the authorized: their messages stop reaching the
    /// page, and their chats can no longer be answered. Nothing is sent to them.
    pub fn pairing_revoke(&self, bot: &str, platform: Platform, sender: &str) -> Result<(), String> {
        check_bot(bot)?;
        self.store.update(bot, platform, |link, _| {
            if !link.is_authorized(sender) {
                return Err("questo account non è tra gli autorizzati".into());
            }
            link.authorized.retain(|entry| entry.id != sender);
            link.chats.retain(|chat| chat.sender != sender);
            Ok(())
        })?;
        self.env.log(&format!("gateway {} {}: autorizzazione revocata in ADE", platform.id(), &bot_key(bot)[..8]));
        Ok(())
    }

    /// The user asks to pair one more account: for 10 minutes, or until one is
    /// approved, a stranger writing gets a code. Returns until when.
    pub fn pairing_open(&self, bot: &str, platform: Platform) -> Result<u64, String> {
        check_bot(bot)?;
        let now = self.env.now_ms();
        self.store.update(bot, platform, |link, _| Ok(link.pairing.open(now)))
    }

    /// The user refused a request from the panel. Nothing is sent to the stranger.
    pub fn pairing_reject(&self, bot: &str, platform: Platform, request: &str) -> Result<(), String> {
        check_bot(bot)?;
        self.store.update(bot, platform, |link, _| link.pairing.reject(request).map(|_| ()))
    }

    /* ── the panel ─────────────────────────────────────────────────────── */

    pub fn status(&self) -> Vec<StatusInfo> {
        let links = self.links();
        let failed = self.failed();
        self.store
            .read()
            .links
            .into_iter()
            .map(|link| {
                let running = links.get(&(link.bot.clone(), link.platform));
                let live = running.map(|running| running.live.lock().map(|live| live.clone()).unwrap_or_default()).unwrap_or_default();
                // A task a fatal error ended is not running, though the link stays on.
                let running = running.filter(|_| !live.stopped);
                StatusInfo {
                    capabilities: running.map(|running| running.adapter.capabilities()),
                    running: running.is_some(),
                    connected: live.connected,
                    last_error: live.last_error.or_else(|| failed.get(&(link.bot.clone(), link.platform)).cloned()),
                    last_message_ms: live.last_message_ms,
                    has_token: link.token_hash.is_some(),
                    enabled: link.enabled,
                    project: link.project,
                    authorized: link.authorized.into_iter().map(|a| MessageSender { id: a.id, name: a.name }).collect(),
                    bot: link.bot,
                    platform: link.platform,
                }
            })
            .collect()
    }
}

fn pairing_request(bot: &str, platform: Platform, pending: &authz::Pending) -> PairingRequest {
    PairingRequest {
        bot: bot.to_string(),
        platform,
        request: pending.request.clone(),
        sender: MessageSender { id: pending.sender.clone(), name: pending.name.clone() },
        created_ms: pending.created_ms,
        expires_ms: pending.expires_ms,
    }
}

/// Waits until the page listens; false when the gateway is stopped first.
/// `biased`: when a stop and something else are both ready, the stop wins.
async fn listening(stopped: &mut watch::Receiver<bool>, ready: &mut watch::Receiver<bool>) -> bool {
    if *stopped.borrow() {
        return false;
    }
    tokio::select! {
        biased;
        _ = stopped.changed() => false,
        _ = ready.wait_for(|ready| *ready) => true,
    }
}

/// One gateway's reading loop.
struct Task {
    env: Arc<dyn Env>,
    store: Arc<Store>,
    adapter: Arc<dyn Adapter>,
    bot: String,
    platform: Platform,
    live: Arc<Mutex<Live>>,
    /// Taken at start; an error or a text holding one of these is cleaned before it is shown.
    secrets: Vec<String>,
    backoff: (Duration, Duration),
}

impl Task {
    /// `gateway telegram 3f2a…:` — the bot by the first characters of its key, never its path.
    fn tag(&self) -> String {
        format!("gateway {} {}", self.platform.id(), &bot_key(&self.bot)[..8])
    }

    fn report(&self, change: impl FnOnce(&mut Live)) {
        let live = {
            let mut live = self.live.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            change(&mut live);
            live.clone()
        };
        self.env.status(&LinkStatus {
            bot: self.bot.clone(),
            platform: self.platform,
            running: !live.stopped,
            connected: live.connected,
            last_error: live.last_error,
            last_message_ms: live.last_message_ms,
        });
    }

    async fn run(self, mut stopped: watch::Receiver<bool>, mut ready: watch::Receiver<bool>) {
        let mut pause = self.backoff.0;
        loop {
            // Nobody listens yet (ADE opening, the page reloading): nothing is read.
            if !listening(&mut stopped, &mut ready).await {
                break;
            }
            let read = tokio::select! {
                biased;
                _ = stopped.changed() => break,
                read = self.adapter.receive() => read,
            };
            // Stopped while the batch came in: it is the next adapter's to hand on.
            if *stopped.borrow() {
                break;
            }
            match read {
                Ok(batch) => {
                    pause = self.backoff.0;
                    if !self.live.lock().map(|live| live.connected).unwrap_or(false) {
                        self.report(|live| {
                            live.connected = true;
                            live.last_error = None;
                        });
                    }
                    // The page may have reloaded during a long poll: the batch waits for it.
                    if !batch.is_empty() && !listening(&mut stopped, &mut ready).await {
                        break;
                    }
                    for message in batch {
                        self.deliver(message).await;
                    }
                    self.save_cursor();
                }
                Err(AdapterError::Transient(error)) => {
                    let error = redact(&error, &self.secrets);
                    self.env.log(&format!("{}: lettura non riuscita, riprovo tra {} s: {error}", self.tag(), pause.as_secs()));
                    self.report(|live| {
                        live.connected = false;
                        live.last_error = Some(error);
                    });
                    tokio::select! {
                        biased;
                        _ = stopped.changed() => break,
                        _ = tokio::time::sleep(pause) => {}
                    }
                    pause = (pause * 2).min(self.backoff.1);
                }
                Err(error) => {
                    let error = redact(&error.message(), &self.secrets);
                    self.env.log(&format!("{}: fermo: {error}", self.tag()));
                    self.report(|live| {
                        live.connected = false;
                        live.last_error = Some(error);
                        live.stopped = true;
                    });
                    break;
                }
            }
        }
    }

    /// The batch was handed on: the platform need not send it again.
    fn save_cursor(&self) {
        let Some(cursor) = self.adapter.cursor() else { return };
        if self.store.link(&self.bot, self.platform).is_some_and(|link| link.cursor.as_deref() == Some(cursor.as_str())) {
            return;
        }
        let written_at = self.env.now_ms();
        if let Err(error) = self.store.update(&self.bot, self.platform, |link, _| {
            link.cursor = Some(cursor.clone());
            // When, so a platform whose cursor carries a session can tell an
            // old one from a fresh one instead of resuming a session the
            // other end has already forgotten.
            link.cursor_saved_ms = Some(written_at);
            Ok(())
        }) {
            self.env.log(&format!("{}: posizione non salvata: {error}", self.tag()));
        }
    }

    /// Hands `message` to the page, answers a stranger with a pairing code, or
    /// drops it. Only metadata reaches the log.
    async fn deliver(&self, message: Inbound) {
        let tag = self.tag();
        if message.sender.is_bot {
            self.env.log(&format!("{tag}: ignorato un messaggio di un bot"));
            return;
        }
        if !admits(&message) {
            self.env.log(&format!("{tag}: ignorato un messaggio che non era per il bot"));
            return;
        }
        let authorized = self.store.link(&self.bot, self.platform).is_some_and(|link| link.is_authorized(&message.sender.id));
        if !authorized && message.button {
            // A press under a message a stranger can see only if it was forwarded: never theirs to make.
            self.env.log(&format!("{tag}: ignorato un bottone premuto da un non autorizzato"));
            return;
        }
        if !authorized {
            self.pair(message).await;
            return;
        }
        let remembered = self.store.update(&self.bot, self.platform, |link, _| {
            // Revoked between the check and now: not theirs to hand on.
            if !link.is_authorized(&message.sender.id) {
                return Err("mittente non più autorizzato".into());
            }
            link.remember_chat(&message.chat, &message.sender.id);
            Ok(())
        });
        if let Err(error) = remembered {
            self.env.log(&format!("{tag}: messaggio non consegnato, stato non salvato: {error}"));
            return;
        }
        let at = self.env.now_ms();
        self.env.log(&format!("{tag}: messaggio da un mittente autorizzato ({} caratteri)", message.text.chars().count()));
        let name = redact(&message.sender.name, &self.secrets);
        let text = redact(&message.text, &self.secrets);
        let redacted = name != message.sender.name || text != message.text;
        // Whoever writes chose that name: no control or direction characters, not too long.
        let name = authz::clean_name(&name);
        self.env.message(&GatewayMessage {
            bot: self.bot.clone(),
            platform: self.platform,
            chat: message.chat,
            sender: MessageSender { id: message.sender.id, name },
            text,
            id: message.id,
            redacted,
            button: message.button,
        });
        self.report(|live| live.last_message_ms = Some(at));
    }

    /// A stranger wrote: a code in their chat, and a request in ADE. Their
    /// text goes nowhere. While they wait, and past the limits, silence.
    async fn pair(&self, message: Inbound) {
        let tag = self.tag();
        let now = self.env.now_ms();
        let name = redact(&message.sender.name, &self.secrets);
        let outcome = self.store.update(&self.bot, self.platform, |link, _| {
            let anyone_paired = !link.authorized.is_empty();
            link.pairing.request(&message.sender.id, &name, &message.chat, anyone_paired, now, &mut authz::os_random)
        });
        let (code, pending) = match outcome {
            Ok(Request::Code { code, pending }) => (code, pending),
            Ok(Request::Waiting) => {
                self.env.log(&format!("{tag}: ignorato un mittente non autorizzato, codice già mandato"));
                return;
            }
            Ok(Request::Closed) => {
                self.env.log(&format!("{tag}: ignorato un mittente non autorizzato, abbinamento chiuso"));
                return;
            }
            Err(error) => {
                self.env.log(&format!("{tag}: codice di abbinamento non creato: {error}"));
                return;
            }
        };
        if let Err(error) = self.adapter.send(&message.chat, &code_message(&code)).await {
            self.env.log(&format!("{tag}: codice di abbinamento non mandato: {}", redact(&error.message(), &self.secrets)));
            return;
        }
        self.env.log(&format!("{tag}: codice di abbinamento mandato a un mittente non autorizzato"));
        self.env.pairing(&pairing_request(&self.bot, self.platform, &pending));
    }
}

#[cfg(test)]
mod tests {
    use super::super::adapter::fake::{FakeAdapter, Feed};
    use super::super::adapter::Sender;
    use super::super::store::Authorized;
    use super::*;
    use std::collections::BTreeMap;

    const TOKEN: &str = "123456789:FINTO-token-di-prova_AbCdEfGhIjKlMnOp";
    const KEY: &str = "sk-finta-chiave-0123456789";
    const BOT: &str = "C:/progetto/.nikcli/agent/aiuto.md";

    #[derive(Default)]
    struct MapVault(Mutex<BTreeMap<(String, String), String>>);
    impl Vault for MapVault {
        fn get(&self, service: &str, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(&(service.into(), name.into())).cloned())
        }
        fn set(&self, service: &str, name: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert((service.into(), name.into()), value.into());
            Ok(())
        }
        fn delete(&self, service: &str, name: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(&(service.into(), name.into()));
            Ok(())
        }
    }

    #[derive(Default)]
    struct Recorder {
        messages: Mutex<Vec<GatewayMessage>>,
        pairings: Mutex<Vec<PairingRequest>>,
        statuses: Mutex<Vec<LinkStatus>>,
        log: Mutex<Vec<String>>,
        /// Added to the clock, to move time on.
        later: std::sync::atomic::AtomicU64,
    }
    impl Env for Recorder {
        fn message(&self, message: &GatewayMessage) {
            self.messages.lock().unwrap().push(message.clone());
        }
        fn pairing(&self, request: &PairingRequest) {
            self.pairings.lock().unwrap().push(request.clone());
        }
        fn status(&self, status: &LinkStatus) {
            self.statuses.lock().unwrap().push(status.clone());
        }
        fn log(&self, line: &str) {
            self.log.lock().unwrap().push(line.into());
        }
        fn secrets(&self) -> Vec<String> {
            vec![KEY.into()]
        }
        fn now_ms(&self) -> u64 {
            1_000 + self.later.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    /// Every adapter the hub asked for, with the token and position it was given.
    type Made = Arc<Mutex<Vec<(String, Option<String>, Arc<FakeAdapter>, Feed)>>>;

    struct Setup {
        hub: Hub,
        env: Arc<Recorder>,
        path: std::path::PathBuf,
        made: Made,
    }

    fn setup(name: &str) -> Setup {
        let dir = std::env::temp_dir().join(format!("ade-gateway-hub-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        setup_at(dir.join("state.json"))
    }

    /// A hub on a state file that may already hold something: ADE started again.
    fn setup_at(path: std::path::PathBuf) -> Setup {
        setup_with(path, Arc::new(MapVault::default()))
    }

    fn setup_with(path: std::path::PathBuf, vault: Arc<MapVault>) -> Setup {
        let env = Arc::new(Recorder::default());
        let made: Made = Arc::default();
        let record = made.clone();
        let connect: Connect = Arc::new(move |_platform, token: &str, cursor: Option<String>| {
            let (adapter, feed) = FakeAdapter::new();
            record.lock().unwrap().push((token.to_string(), cursor, adapter.clone(), feed));
            Ok(adapter as Arc<dyn Adapter>)
        });
        let hub = Hub::new(env.clone(), vault, "ai.nikcli.ade.test.gateway".into(), Arc::new(Store::new(path.clone())), connect)
            .with_backoff(Duration::from_millis(5), Duration::from_millis(20));
        hub.ready();
        Setup { hub, env, path, made }
    }

    /// The last adapter the hub made, and the feed that drives it.
    fn last_made(setup: &Setup) -> (Arc<FakeAdapter>, Feed) {
        let made = setup.made.lock().unwrap();
        let (_, _, adapter, feed) = made.last().expect("nessun adapter creato");
        (adapter.clone(), feed.clone())
    }

    fn authorize(setup: &Setup, id: &str) {
        setup
            .hub
            .store
            .update(BOT, Platform::Fake, |link, _| {
                link.authorized.push(Authorized { id: id.into(), name: "Io".into(), added_ms: 1 });
                Ok(())
            })
            .unwrap();
    }

    fn message(id: &str, chat: &str, sender: &str, text: &str) -> Inbound {
        Inbound {
            id: id.into(),
            chat: chat.into(),
            private: true,
            mentioned: false,
            sender: Sender { id: sender.into(), name: format!("utente {sender}"), is_bot: false },
            text: text.into(),
            button: false,
        }
    }

    fn press(id: &str, chat: &str, sender: &str, data: &str) -> Inbound {
        Inbound { button: true, ..message(id, chat, sender, data) }
    }

    fn start(setup: &Setup) -> (Arc<FakeAdapter>, Feed) {
        if setup.hub.token(BOT, Platform::Fake).unwrap().is_none() {
            setup.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        }
        setup.hub.start(BOT, Platform::Fake, "C:/progetto").unwrap();
        last_made(setup)
    }

    /// The code in the pairing message sent to `chat`, as the stranger reads it.
    fn code_sent_to(adapter: &FakeAdapter, chat: &str) -> String {
        let sent = adapter.sent.lock().unwrap();
        let (_, text) = sent.iter().find(|(to, text)| to == chat && text.starts_with("Codice di abbinamento: ")).expect("nessun codice mandato");
        text["Codice di abbinamento: ".len()..][.."XXXX-XXXX".len()].to_string()
    }

    async fn eventually(what: &str, check: impl Fn() -> bool) {
        for _ in 0..400 {
            if check() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("non è successo: {what}");
    }

    #[tokio::test]
    async fn only_an_authorized_person_in_a_private_chat_reaches_the_page() {
        let s = setup("authorized");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        let mut group = message("3", "g1", "42", "nel gruppo");
        group.private = false;
        let mut robot = message("4", "c9", "9", "sono un bot");
        robot.sender.is_bot = true;
        feed.send(Ok(vec![message("1", "c7", "7", "sconosciuto"), group, robot, message("2", "c42", "42", "ciao")])).unwrap();
        eventually("il messaggio autorizzato arriva", || s.env.messages.lock().unwrap().len() == 1).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        let messages = s.env.messages.lock().unwrap().clone();
        assert_eq!(messages.len(), 1, "{messages:?}");
        assert_eq!(messages[0].chat, "c42");
        assert_eq!(messages[0].sender.id, "42");
        assert_eq!(messages[0].text, "ciao");
        assert_eq!(messages[0].bot, BOT);
        assert!(!messages[0].redacted);
        // Only its chat may be answered.
        let chats = s.hub.store.link(BOT, Platform::Fake).unwrap().chats;
        assert_eq!(chats.iter().map(|chat| (chat.id.as_str(), chat.sender.as_str())).collect::<Vec<_>>(), vec![("c42", "42")]);
    }

    #[tokio::test]
    async fn no_token_in_an_event_and_no_token_or_text_in_the_log() {
        let s = setup("leaks");
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        let text = format!("testo privato dell'utente con il token {TOKEN}");
        feed.send(Ok(vec![message("1", "c42", "42", &text), message("2", "c7", "7", "testo dello sconosciuto")])).unwrap();
        feed.send(Err(AdapterError::Transient(format!("rete giù per bot{TOKEN}")))).unwrap();
        eventually("l'errore arriva allo stato", || {
            s.env.statuses.lock().unwrap().iter().any(|status| status.last_error.is_some())
        })
        .await;
        let messages = s.env.messages.lock().unwrap().clone();
        assert_eq!(messages.len(), 1);
        // The page is told, so it can say the key was hidden and not used.
        assert!(messages[0].redacted);
        let event = serde_json::to_string(&messages[0]).unwrap();
        assert!(event.contains("\"redacted\":true"), "{event}");
        assert!(!event.contains(TOKEN), "{event}");
        assert!(event.contains("[nascosto]"), "{event}");
        let statuses = serde_json::to_string(&*s.env.statuses.lock().unwrap()).unwrap();
        assert!(!statuses.contains(TOKEN), "{statuses}");
        let log = s.env.log.lock().unwrap().join("\n");
        assert!(!log.is_empty());
        for leak in [TOKEN, "testo privato", "testo dello sconosciuto", "utente 42"] {
            assert!(!log.contains(leak), "{leak} nel log:\n{log}");
        }
        // Not in the state file either: only its hash.
        let saved = std::fs::read_to_string(&s.path).unwrap();
        assert!(!saved.contains(TOKEN));
        assert!(saved.contains(&token_hash(TOKEN)));
    }

    #[tokio::test]
    async fn a_reply_loses_every_known_secret_before_it_leaves() {
        let s = setup("redact");
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c42", "42", "leggimi il file .env")])).unwrap();
        eventually("il messaggio arriva", || s.env.messages.lock().unwrap().len() == 1).await;
        let id = s.hub.send(BOT, Platform::Fake, "c42", &format!("TOKEN={TOKEN}\nOPENAI_API_KEY={KEY}\nfine")).await.unwrap();
        assert_eq!(id, "m1");
        s.hub.edit(BOT, Platform::Fake, "c42", "m1", &format!("ancora {KEY}")).await.unwrap();
        let sent = adapter.sent.lock().unwrap().clone();
        assert_eq!(sent, vec![("c42".to_string(), "TOKEN=[nascosto]\nOPENAI_API_KEY=[nascosto]\nfine".to_string())]);
        assert_eq!(adapter.edited.lock().unwrap()[0].2, "ancora [nascosto]");
    }

    #[tokio::test]
    async fn a_reply_goes_only_to_a_chat_an_authorized_sender_wrote_from() {
        let s = setup("chats");
        authorize(&s, "42");
        assert!(s.hub.send(BOT, Platform::Fake, "c42", "x").await.unwrap_err().contains("spento"));
        let (adapter, feed) = start(&s);
        let refused = s.hub.send(BOT, Platform::Fake, "c999", "dati rubati").await.unwrap_err();
        assert!(refused.contains("non ha mai scritto"), "{refused}");
        assert!(s.hub.typing(BOT, Platform::Fake, "c999").await.is_err());
        feed.send(Ok(vec![message("1", "c42", "42", "ciao")])).unwrap();
        eventually("il messaggio arriva", || s.env.messages.lock().unwrap().len() == 1).await;
        s.hub.typing(BOT, Platform::Fake, "c42").await.unwrap();
        s.hub.send(BOT, Platform::Fake, "c42", "risposta").await.unwrap();
        assert_eq!(adapter.sent.lock().unwrap().len(), 1);
        assert_eq!(adapter.typing.lock().unwrap().clone(), vec!["c42".to_string()]);
    }

    #[tokio::test]
    async fn the_same_token_on_a_second_bot_is_refused_and_a_cleared_one_is_gone() {
        let s = setup("tokens");
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        // Saving it again on the same bot is fine.
        s.hub.set_token(BOT, Platform::Fake, &format!("  {TOKEN}\n")).unwrap();
        let other = "C:/progetto/.nikcli/agent/altro.md";
        assert!(s.hub.set_token(other, Platform::Fake, TOKEN).unwrap_err().contains("già"));
        assert!(s.hub.token(other, Platform::Fake).unwrap().is_none());
        assert!(s.hub.set_token(BOT, Platform::Fake, "con spazi dentro 123").is_err());
        assert_eq!(s.hub.token(BOT, Platform::Fake).unwrap().as_deref(), Some(TOKEN));
        let status = s.hub.status();
        assert!(status[0].has_token);
        assert!(!serde_json::to_string(&status).unwrap().contains(TOKEN));
        s.hub.clear_token(BOT, Platform::Fake).unwrap();
        assert!(s.hub.token(BOT, Platform::Fake).unwrap().is_none());
        assert!(!s.hub.status()[0].has_token);
        s.hub.set_token(other, Platform::Fake, TOKEN).unwrap();
    }

    #[tokio::test]
    async fn a_failed_read_is_tried_again_and_a_fatal_one_stops_the_gateway() {
        let s = setup("errors");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        feed.send(Err(AdapterError::Transient("timeout".into()))).unwrap();
        feed.send(Ok(vec![message("1", "c42", "42", "dopo il guasto")])).unwrap();
        eventually("arriva dopo il nuovo tentativo", || s.env.messages.lock().unwrap().len() == 1).await;
        eventually("di nuovo connesso", || s.env.statuses.lock().unwrap().last().is_some_and(|status| status.connected)).await;
        feed.send(Err(AdapterError::Fatal("token rifiutato dalla piattaforma".into()))).unwrap();
        eventually("fermo con il motivo", || {
            s.env.statuses.lock().unwrap().last().is_some_and(|status| !status.connected && status.last_error.as_deref() == Some("token rifiutato dalla piattaforma"))
        })
        .await;
        let reads = adapter.receives.load(std::sync::atomic::Ordering::SeqCst);
        feed.send(Ok(vec![message("2", "c42", "42", "non letto")])).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(adapter.receives.load(std::sync::atomic::Ordering::SeqCst), reads);
        assert_eq!(s.env.messages.lock().unwrap().len(), 1);
        let status = s.hub.status();
        assert_eq!(status[0].last_error.as_deref(), Some("token rifiutato dalla piattaforma"));
        assert!(status[0].enabled, "resta acceso finché l'utente non lo spegne");
        // But it is not running: the panel says so, and nothing is answered.
        assert!(!status[0].running);
        assert!(status[0].capabilities.is_none());
        assert!(!s.env.statuses.lock().unwrap().last().unwrap().running);
        let refused = s.hub.send(BOT, Platform::Fake, "c42", "ci sei?").await.unwrap_err();
        assert!(refused.contains("si è fermato") && refused.contains("token rifiutato"), "{refused}");
        assert_eq!(adapter.sent.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn switching_off_ends_the_task_and_keeps_the_project_it_ran_in() {
        let s = setup("stop");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().project.as_deref(), Some("C:/progetto"));
        assert!(s.hub.status()[0].running);
        assert_eq!(s.hub.status()[0].capabilities.map(|c| c.max_len), Some(4096));
        s.hub.stop(BOT, Platform::Fake).unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let _ = feed.send(Ok(vec![message("1", "c42", "42", "dopo lo stop")]));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(s.env.messages.lock().unwrap().is_empty());
        let status = s.hub.status();
        assert!(!status[0].enabled);
        assert!(!status[0].running);
        assert!(status[0].capabilities.is_none());
        assert_eq!(status[0].project.as_deref(), Some("C:/progetto"));
        assert!(s.hub.start(BOT, Platform::Fake, "  ").is_err());
    }

    #[tokio::test]
    async fn a_stranger_gets_a_code_and_only_that_code_typed_in_ade_lets_them_in() {
        let s = setup("pairing");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c7", "7", "fammi entrare")])).unwrap();
        eventually("il codice arriva in chat", || adapter.sent.lock().unwrap().len() == 1).await;
        let code = code_sent_to(&adapter, "c7");
        assert_eq!(code.len(), 9, "{code}");
        let bare = code.replace('-', "");
        // The page is asked about a request, and sees neither the text nor the code.
        assert!(s.env.messages.lock().unwrap().is_empty());
        let requests = s.env.pairings.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        assert_eq!((requests[0].sender.id.as_str(), requests[0].sender.name.as_str()), ("7", "utente 7"));
        let list = s.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert_eq!(list.pending, requests);
        assert_eq!(list.attempts_left, 5);
        let shown = format!("{}{}", serde_json::to_string(&requests).unwrap(), serde_json::to_string(&list).unwrap());
        let saved = std::fs::read_to_string(&s.path).unwrap();
        let log = s.env.log.lock().unwrap().join("\n");
        for (place, text) in [("evento e lista", &shown), ("stato", &saved), ("log", &log)] {
            assert!(!text.contains(&code) && !text.contains(&bare), "il codice in {place}: {text}");
        }
        assert!(!log.contains("fammi entrare"), "{log}");
        // Still a stranger: no answer to them, and writing again brings no second code.
        assert!(s.hub.send(BOT, Platform::Fake, "c7", "x").await.is_err());
        feed.send(Ok(vec![message("2", "c7", "7", "allora?")])).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(adapter.sent.lock().unwrap().len(), 1);
        assert!(s.env.messages.lock().unwrap().is_empty());
        // A wrong code counts; the right one, typed as read, lets them in.
        let wrong = if bare == "AAAAAAAA" { "BBBBBBBB" } else { "AAAAAAAA" };
        assert!(s.hub.pairing_approve(BOT, Platform::Fake, wrong).await.unwrap_err().contains("restano 4"));
        let approved = s.hub.pairing_approve(BOT, Platform::Fake, &format!(" {} ", code.to_lowercase())).await.unwrap();
        assert_eq!((approved.id.as_str(), approved.name.as_str()), ("7", "utente 7"));
        assert_eq!(adapter.sent.lock().unwrap()[1], ("c7".to_string(), PAIRED_MESSAGE.to_string()));
        let list = s.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert!(list.pending.is_empty());
        assert_eq!(list.attempts_left, 5);
        assert_eq!(list.authorized.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["7"]);
        s.hub.send(BOT, Platform::Fake, "c7", "benvenuto").await.unwrap();
        feed.send(Ok(vec![message("3", "c7", "7", "eccomi")])).unwrap();
        eventually("ora il suo messaggio arriva", || s.env.messages.lock().unwrap().len() == 1).await;
        assert_eq!(s.env.messages.lock().unwrap()[0].text, "eccomi");
        // Used once: typing it again does nothing.
        assert!(s.hub.pairing_approve(BOT, Platform::Fake, &code).await.is_err());
    }

    #[tokio::test]
    async fn approvals_requests_and_wrong_codes_survive_a_restart() {
        let s = setup("restart");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c7", "7", "io"), message("2", "c8", "8", "anch'io")])).unwrap();
        eventually("due codici", || adapter.sent.lock().unwrap().len() == 2).await;
        let code = code_sent_to(&adapter, "c7");
        s.hub.pairing_approve(BOT, Platform::Fake, &code).await.unwrap();
        for _ in 0..2 {
            assert!(s.hub.pairing_approve(BOT, Platform::Fake, "ZZZZZZZZ").await.is_err());
        }
        s.hub.shutdown();

        let again = setup_at(s.path.clone());
        let list = again.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert_eq!(list.authorized.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["7"]);
        assert_eq!(list.pending.iter().map(|p| p.sender.id.as_str()).collect::<Vec<_>>(), vec!["8"]);
        assert_eq!(list.attempts_left, 3);
        // Refusing from the panel is not a wrong code, and tells the stranger nothing.
        again.hub.pairing_reject(BOT, Platform::Fake, &list.pending[0].request).unwrap();
        let list = again.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert!(list.pending.is_empty());
        assert_eq!(list.attempts_left, 3);
        assert_eq!(adapter.sent.lock().unwrap().len(), 3, "due codici e la conferma di 7, nient'altro");
    }

    #[tokio::test]
    async fn a_new_token_on_a_running_gateway_starts_it_again_with_that_token() {
        let s = setup("new-token");
        authorize(&s, "42");
        let (old, old_feed) = start(&s);
        assert_eq!(s.made.lock().unwrap()[0].0, TOKEN);
        let new_token = "987654321:ALTRO-token-di-prova_ZyXwVuTsRqPoNm";
        s.hub.set_token(BOT, Platform::Fake, new_token).unwrap();
        assert_eq!(s.made.lock().unwrap().len(), 2);
        assert_eq!(s.made.lock().unwrap()[1].0, new_token);
        let (new, new_feed) = last_made(&s);
        // The old adapter is no longer read; the new one is, and answers go through it.
        let _ = old_feed.send(Ok(vec![message("1", "c42", "42", "al token vecchio")]));
        new_feed.send(Ok(vec![message("2", "c42", "42", "al token nuovo")])).unwrap();
        eventually("il messaggio al token nuovo", || s.env.messages.lock().unwrap().len() == 1).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        let texts: Vec<String> = s.env.messages.lock().unwrap().iter().map(|m| m.text.clone()).collect();
        assert_eq!(texts, vec!["al token nuovo"]);
        s.hub.send(BOT, Platform::Fake, "c42", "risposta").await.unwrap();
        assert_eq!(new.sent.lock().unwrap().len(), 1);
        assert!(old.sent.lock().unwrap().is_empty());
        // A gateway switched off stays off when its token changes.
        s.hub.stop(BOT, Platform::Fake).unwrap();
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        assert_eq!(s.made.lock().unwrap().len(), 2);
        assert!(!s.hub.status()[0].running);
    }

    #[tokio::test]
    async fn when_ade_opens_the_gateways_left_on_start_again_once_the_page_listens() {
        let dir = std::env::temp_dir().join(format!("ade-gateway-hub-resume-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("state.json");
        let vault = Arc::new(MapVault::default());
        let before = setup_with(path.clone(), vault.clone());
        authorize(&before, "42");
        start(&before);
        before.hub.store.update(BOT, Platform::Fake, |link, _| {
            link.cursor = Some("1001".into());
            Ok(())
        }).unwrap();
        // One switched on without a token, one switched off.
        let other = "C:/progetto/.nikcli/agent/senza-token.md";
        before.hub.store.update(other, Platform::Fake, |link, _| {
            link.enabled = true;
            link.project = Some("C:/progetto".into());
            Ok(())
        }).unwrap();
        before.hub.store.update("C:/progetto/.nikcli/agent/spento.md", Platform::Fake, |_, _| Ok(())).unwrap();
        before.hub.shutdown();

        // ADE opens again: same state file, same keychain, a new hub.
        let env = Arc::new(Recorder::default());
        let made: Made = Arc::default();
        let record = made.clone();
        let connect: Connect = Arc::new(move |_platform, token: &str, cursor: Option<String>| {
            let (adapter, feed) = FakeAdapter::new();
            record.lock().unwrap().push((token.to_string(), cursor, adapter.clone(), feed));
            Ok(adapter as Arc<dyn Adapter>)
        });
        let hub = Hub::new(env.clone(), vault, "ai.nikcli.ade.test.gateway".into(), Arc::new(Store::new(path.clone())), connect);
        let s = Setup { hub, env, path, made };
        s.hub.resume();
        {
            let made = s.made.lock().unwrap();
            assert_eq!(made.len(), 1, "solo quello acceso e con il token");
            assert_eq!((made[0].0.as_str(), made[0].1.as_deref()), (TOKEN, Some("1001")));
        }
        let (adapter, feed) = last_made(&s);
        feed.send(Ok(vec![message("1", "c42", "42", "mentre ADE si apre")])).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(adapter.receives.load(std::sync::atomic::Ordering::SeqCst), 0, "non legge prima che la pagina ascolti");
        s.hub.ready();
        eventually("il messaggio arriva quando la pagina ascolta", || s.env.messages.lock().unwrap().len() == 1).await;
        let status = s.hub.status();
        let running = status.iter().find(|status| status.bot == BOT).unwrap();
        assert!(running.enabled && running.running);
        let missing = status.iter().find(|status| status.bot == other).unwrap();
        assert!(missing.enabled && !missing.running);
        assert!(missing.last_error.as_deref().is_some_and(|error| error.contains("manca il token")), "{missing:?}");
        assert!(s.env.statuses.lock().unwrap().iter().any(|status| status.bot == other && status.last_error.is_some()));
    }

    #[tokio::test]
    async fn a_button_press_counts_only_from_an_authorized_sender_and_brings_no_code() {
        let s = setup("buttons");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c42", "42", "ciao")])).unwrap();
        eventually("il messaggio", || s.env.messages.lock().unwrap().len() == 1).await;
        let buttons = vec![Button { label: "Sì".into(), data: "ok:1".into() }, Button { label: format!("No {KEY}"), data: "no:1".into() }];
        s.hub.send_buttons(BOT, Platform::Fake, "c42", "Procedo?", &buttons).await.unwrap();
        let sent = adapter.buttons.lock().unwrap().clone();
        assert_eq!(sent[0].2[1].label, "No [nascosto]");
        assert!(s.hub.send_buttons(BOT, Platform::Fake, "c42", "x", &[Button { label: "a".into(), data: "d".repeat(65) }]).await.is_err());
        assert!(s.hub.send_buttons(BOT, Platform::Fake, "c42", "x", &[]).await.is_err());
        assert!(s.hub.send_buttons(BOT, Platform::Fake, "c999", "x", &buttons).await.is_err());
        // A stranger's press is dropped, and gets no pairing code either.
        feed.send(Ok(vec![press("2", "c7", "7", "ok:1"), press("3", "c42", "42", "ok:1")])).unwrap();
        eventually("la pressione dell'autorizzato", || s.env.messages.lock().unwrap().len() == 2).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        let messages = s.env.messages.lock().unwrap().clone();
        assert_eq!(messages.len(), 2);
        assert!(messages[1].button && messages[1].sender.id == "42" && messages[1].text == "ok:1");
        assert!(!messages[0].button);
        assert!(adapter.sent.lock().unwrap().is_empty(), "nessun codice per chi preme");
        assert!(s.env.pairings.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_position_is_saved_once_a_batch_was_handed_on() {
        let s = setup("cursor");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        *adapter.position.lock().unwrap() = Some("501".into());
        feed.send(Ok(vec![message("500", "c42", "42", "uno")])).unwrap();
        eventually("il messaggio", || s.env.messages.lock().unwrap().len() == 1).await;
        eventually("la posizione salvata", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("501")).await;
        // Made again (a new token, ADE reopened): from where it was.
        s.hub.set_token(BOT, Platform::Fake, "987654321:ALTRO-token-di-prova_ZyXwVuTsRqPoNm").unwrap();
        assert_eq!(s.made.lock().unwrap().last().unwrap().1.as_deref(), Some("501"));
    }

    #[tokio::test]
    async fn after_the_page_reloads_nothing_is_handed_on_until_it_listens_again() {
        let s = setup("reload");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        *adapter.position.lock().unwrap() = Some("11".into());
        feed.send(Ok(vec![message("10", "c42", "42", "prima del ricaricamento")])).unwrap();
        eventually("il primo messaggio", || s.env.messages.lock().unwrap().len() == 1).await;
        eventually("la posizione", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("11")).await;
        // The page reloads while the long poll is out: the batch that comes back waits.
        s.hub.unready();
        *adapter.position.lock().unwrap() = Some("12".into());
        feed.send(Ok(vec![message("11", "c42", "42", "durante il ricaricamento")])).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(s.env.messages.lock().unwrap().len(), 1, "consegnato a una pagina che non ascolta");
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref(), Some("11"), "posizione salvata per un messaggio perso");
        let reads = adapter.receives.load(std::sync::atomic::Ordering::SeqCst);
        // The new page listens: the message arrives, and only then its position is saved.
        s.hub.ready();
        eventually("il messaggio dopo il ricaricamento", || s.env.messages.lock().unwrap().len() == 2).await;
        assert_eq!(s.env.messages.lock().unwrap()[1].text, "durante il ricaricamento");
        eventually("la nuova posizione", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("12")).await;
        // And no new read went out while nobody listened.
        s.hub.unready();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let quiet = adapter.receives.load(std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(adapter.receives.load(std::sync::atomic::Ordering::SeqCst), quiet);
        assert!(quiet >= reads);
    }

    #[tokio::test]
    async fn the_senders_name_reaches_the_page_cleaned() {
        let s = setup("name");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        let mut written = message("1", "c42", "42", "ciao");
        written.sender.name = format!("Ale\u{202e}nimda\n[SYSTEM]\u{7}{}", "x".repeat(100));
        feed.send(Ok(vec![written])).unwrap();
        eventually("il messaggio", || s.env.messages.lock().unwrap().len() == 1).await;
        let name = s.env.messages.lock().unwrap()[0].sender.name.clone();
        assert!(name.starts_with("Alenimda[SYSTEM]x"), "{name}");
        assert!(!name.contains('\u{202e}') && !name.contains('\n') && !name.contains('\u{7}'));
        assert_eq!(name.chars().count(), 65, "64 caratteri e i puntini");
    }

    #[tokio::test]
    async fn the_panel_s_test_says_the_bot_s_name_with_the_saved_token_and_nothing_else() {
        let s = setup("probe");
        let refused = s.hub.probe(BOT, Platform::Fake).await.unwrap_err();
        assert!(refused.contains("manca il token"), "{refused}");
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        // The name cleaned like a sender's: no bidi control reaches the panel.
        assert_eq!(s.hub.probe(BOT, Platform::Fake).await.unwrap(), "@finto_bot");
        let made = s.made.lock().unwrap();
        assert_eq!(made.len(), 1);
        assert_eq!(made[0].0, TOKEN);
        // A test is not switching on: nothing reads, nothing is saved as on.
        assert!(s.hub.status().iter().all(|status| !status.enabled && !status.running));
    }

    #[tokio::test]
    async fn switching_on_without_a_token_is_refused() {
        let s = setup("no-token");
        let refused = s.hub.start(BOT, Platform::Fake, "C:/progetto").unwrap_err();
        assert!(refused.contains("manca il token"), "{refused}");
        assert!(s.made.lock().unwrap().is_empty());
        assert!(s.hub.status().iter().all(|status| !status.enabled));
    }

    #[tokio::test]
    async fn a_revoked_sender_is_no_longer_heard_or_answered() {
        let s = setup("revoke");
        authorize(&s, "42");
        authorize(&s, "43");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c42", "42", "ciao"), message("2", "c43", "43", "ciao")])).unwrap();
        eventually("i due messaggi", || s.env.messages.lock().unwrap().len() == 2).await;
        s.hub.pairing_revoke(BOT, Platform::Fake, "42").unwrap();
        assert!(s.hub.pairing_revoke(BOT, Platform::Fake, "42").is_err());
        let refused = s.hub.send(BOT, Platform::Fake, "c42", "ancora qui?").await.unwrap_err();
        assert!(refused.contains("non ha mai scritto"), "{refused}");
        // The other one is untouched.
        s.hub.send(BOT, Platform::Fake, "c43", "sì").await.unwrap();
        feed.send(Ok(vec![message("3", "c42", "42", "dopo la revoca"), message("4", "c43", "43", "io ci sono")])).unwrap();
        eventually("il messaggio dell'altro", || s.env.messages.lock().unwrap().len() == 3).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        let texts: Vec<String> = s.env.messages.lock().unwrap().iter().map(|m| m.text.clone()).collect();
        assert_eq!(texts, vec!["ciao", "ciao", "io ci sono"]);
        let list = s.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert_eq!(list.authorized.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["43"]);
        // Only the one reply to 43 went out; nothing told 42 of the revocation.
        assert!(adapter.sent.lock().unwrap().iter().all(|(chat, text)| chat != "c42" || text.starts_with("Codice di abbinamento")));
    }

    #[tokio::test]
    async fn once_an_account_is_paired_a_stranger_gets_silence_until_ade_opens_pairing() {
        let s = setup("window");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c7", "7", "chi sei?")])).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(adapter.sent.lock().unwrap().is_empty());
        assert!(s.env.pairings.lock().unwrap().is_empty());
        assert!(!s.hub.pairing_list(BOT, Platform::Fake).unwrap().open);
        // The user pairs a second account of theirs.
        let until = s.hub.pairing_open(BOT, Platform::Fake).unwrap();
        let list = s.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert!(list.open);
        assert_eq!(list.open_until_ms, Some(until));
        feed.send(Ok(vec![message("2", "c43", "43", "sono io")])).unwrap();
        eventually("il codice", || adapter.sent.lock().unwrap().len() == 1).await;
        let code = code_sent_to(&adapter, "c43");
        s.hub.pairing_approve(BOT, Platform::Fake, &code).await.unwrap();
        assert!(!s.hub.pairing_list(BOT, Platform::Fake).unwrap().open, "si chiude con l'abbinamento");
        feed.send(Ok(vec![message("3", "c8", "8", "e io?")])).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(adapter.sent.lock().unwrap().len(), 2, "il codice a 43 e la sua conferma, niente a 8");
    }

    #[tokio::test]
    async fn an_hour_later_the_request_is_gone_and_the_code_no_longer_works() {
        let s = setup("expiry");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c7", "7", "io")])).unwrap();
        eventually("il codice", || adapter.sent.lock().unwrap().len() == 1).await;
        let code = code_sent_to(&adapter, "c7");
        s.env.later.store(authz::CODE_TTL_MS, std::sync::atomic::Ordering::SeqCst);
        assert!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().pending.is_empty());
        assert!(s.hub.pairing_approve(BOT, Platform::Fake, &code).await.unwrap_err().contains("scaduto"));
        assert!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.is_empty());
        // Writing again, they get a new one.
        feed.send(Ok(vec![message("2", "c7", "7", "di nuovo")])).unwrap();
        eventually("un codice nuovo", || adapter.sent.lock().unwrap().len() == 2).await;
    }
}
