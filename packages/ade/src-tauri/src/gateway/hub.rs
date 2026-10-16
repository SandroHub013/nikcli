//! The gateways' core: one task per bot and platform that is switched on.
//!
//! Each task reads its adapter and decides, here in Rust, what reaches the
//! page: a message from an authorized sender, in a private chat or mentioning
//! the bot in a group channel (or a button press), from a person and not a
//! bot. Anything else stops here, so a stranger's text never becomes a turn: a
//! stranger gets a pairing code instead (`authz.rs`), and becomes authorized
//! only when the user types it in ADE, or opens the link or QR ADE itself showed
//! (`/start <token>`, which only the owner's window can make). The page answers with `send`, which goes
//! only to chats an authorized sender wrote from and loses every known secret
//! on the way out.
//!
//! Nothing here needs the app: the events, the log and the secrets to hide
//! come through `Env`, the keychain through `Vault`, so the tests drive it
//! with a fake adapter and no token of any real service.

use super::adapter::{admits, Adapter, AdapterError, Button, Capabilities, Inbound, Platform};
use super::authz::{self, LinkUse, Request};
use super::pairing_link;
use super::redact::redact;
use super::store::{Authorized, LinkState, Store};
use crate::secrets::Vault;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

/// A message for the page: from an authorized sender, secrets already out.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    /// A one-to-one chat with the bot. A channel others read is not: no question about a command or a file goes
    /// there, whoever asked in it (review of the bots, S17).
    pub private: bool,
    #[serde(default)]
    pub recovered: bool,
}

/// How many buttons a message may carry, and how long their parts may be:
/// Telegram's callback data is at most 64 bytes.
const MAX_BUTTONS: usize = 12;
const MAX_BUTTON_DATA: usize = 64;
const MAX_BUTTON_LABEL: usize = 64;
const PENDING_CAP: usize = 1_000;
const DISK_PENDING_CAP: usize = 200;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    /// Slack's App-Level Token is saved. Always false on the other platforms.
    pub has_app_token: bool,
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
    /// The id of the account the last link or QR paired, until a new one is made: what the panel names as paired by it.
    pub linked_by: Option<String>,
}

/// The link and QR the panel shows to pair the owner's phone: the address, the picture of it, and when it stops
/// working. The token is in both and is never kept or logged in the clear.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingLink {
    pub url: String,
    /// The QR as a standalone SVG, to draw as an image.
    pub svg: String,
    pub expires_ms: u64,
}

// Not `Debug`: a stray `{:?}` must not put the token in a log.
impl std::fmt::Debug for PairingLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingLink").field("expires_ms", &self.expires_ms).finish_non_exhaustive()
    }
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

/// What a stranger reads when the link they opened no longer holds (wrong, expired or used): a new QR comes from ADE, and
/// the way of a plain `/start`, the code, follows if pairing is open.
const LINK_STALE_MESSAGE: &str = "Questo link non vale più: chiedine uno nuovo a chi gestisce il bot in ADE.\nThis link is no longer valid: ask for a new QR in ADE.";

const PAIRED_MESSAGE: &str = "Abbinamento fatto: ora questo bot ti risponde.\nPaired: this bot now answers you.";

/// Where the hub reports, and what it hides.
pub trait Env: Send + Sync {
    fn message(&self, message: &GatewayMessage);
    fn pairing(&self, request: &PairingRequest);
    fn status(&self, status: &LinkStatus);
    /// A diagnostic line. Called with metadata only: never a message's text or a token.
    fn log(&self, line: &str);
    /// Secret values besides the gateway tokens: the keys in the keychain,
    /// ragu's provider keys, the keys in ADE's environment.
    fn secrets(&self) -> Vec<String>;
    fn now_ms(&self) -> u64;
    /// Whether the bot's file is still there: a bot is its file.
    fn bot_exists(&self, bot: &str) -> bool;
}

#[derive(Clone, Default)]
struct Live {
    connected: bool,
    last_error: Option<String>,
    last_message_ms: Option<u64>,
    /// A fatal error ended the task: switched on, but not reading or answering.
    stopped: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PendingEntry {
    msg: GatewayMessage,
    cursor: Option<String>,
    #[serde(default)]
    acked: bool,
}

struct Running {
    adapter: Arc<dyn Adapter>,
    stop: watch::Sender<bool>,
    live: Arc<Mutex<Live>>,
    pending: Arc<Mutex<VecDeque<PendingEntry>>>,
}

/// Which of a link's secrets: the bot's token, or Slack's App-Level Token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TokenKind {
    Bot,
    App,
}

/// What an adapter is made with: the bot's token and, on Slack, the App-Level
/// Token its socket is opened with.
pub struct Tokens {
    pub bot: String,
    pub app: Option<String>,
}

/// Builds a platform's adapter from the bot's tokens and where its stream was
/// last read up to.
pub type Connect = Arc<dyn Fn(Platform, &Tokens, Option<String>) -> Result<Arc<dyn Adapter>, String> + Send + Sync>;

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
    /// Held around every change of a token: read what the keychain had,
    /// write, record, and put the old value back if the record refused.
    /// Two commands on the same entry at once would otherwise interleave, and
    /// the loser would restore its old value over the winner's.
    keychain: Mutex<()>,
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

fn pending_file_path(store_path: &std::path::Path, bot: &str, platform: Platform) -> std::path::PathBuf {
    let dir = store_path.parent().unwrap_or_else(|| std::path::Path::new("."));
    dir.join(format!("pending-{}-{}.json", &bot_key(bot)[..16], platform.id()))
}

fn write_pending_file(path: &std::path::Path, entries: &[PendingEntry]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("registro consegne: {e}"))?;
    }
    let text = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temp).map_err(|e| format!("registro consegne: {e}"))?;
    use std::io::Write;
    file.write_all(text.as_bytes()).map_err(|e| format!("registro consegne: {e}"))?;
    file.sync_all().map_err(|e| format!("registro consegne: {e}"))?;
    drop(file);
    std::fs::rename(&temp, path).map_err(|e| format!("registro consegne: {e}"))
}

fn read_pending_file(path: &std::path::Path) -> Vec<PendingEntry> {
    if !path.exists() {
        return Vec::new();
    }
    let raw = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    let mut entries = serde_json::from_slice::<Vec<PendingEntry>>(&raw).unwrap_or_default();
    if entries.len() > DISK_PENDING_CAP {
        let dropped = entries.len() - DISK_PENDING_CAP;
        entries.drain(0..dropped);
    }
    entries
}

fn remove_pending_file(path: &std::path::Path) {
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    let tmp = path.with_extension("json.tmp");
    if tmp.exists() {
        let _ = std::fs::remove_file(tmp);
    }
}

fn save_pending_to_disk(
    env: &dyn Env,
    store_path: &std::path::Path,
    bot: &str,
    platform: Platform,
    pending: &VecDeque<PendingEntry>,
) {
    let path = pending_file_path(store_path, bot, platform);
    let mut unacked: Vec<PendingEntry> = pending.iter().filter(|entry| !entry.acked).cloned().collect();
    if unacked.len() > DISK_PENDING_CAP {
        let dropped = unacked.len() - DISK_PENDING_CAP;
        unacked.drain(0..dropped);
        let tag = format!("gateway {} {}", platform.id(), &bot_key(bot)[..8]);
        env.log(&format!("{tag}: registro delle consegne su disco ha superato il tetto ({DISK_PENDING_CAP}): eliminati {dropped} messaggi più vecchi"));
    }
    if unacked.is_empty() {
        remove_pending_file(&path);
    } else {
        let _ = write_pending_file(&path, &unacked);
    }
}

/// Every token of every link in the gateway's state, out of the vault: for the uninstall that is asked to delete the data. The state file is
/// left to whoever removes the folder. A token the keychain will not give up is reported and does not stop the others.
pub fn forget_all_tokens(vault: &dyn Vault, service: &str, state: &std::path::Path) -> crate::secrets::Forgotten {
    let mut out = crate::secrets::Forgotten::default();
    for link in Store::new(state.to_path_buf()).read().links {
        remove_pending_file(&pending_file_path(state, &link.bot, link.platform));
        out.one(&token_name(&link.bot, link.platform), vault.delete(service, &token_name(&link.bot, link.platform)));
        if link.platform.needs_app_token() {
            let app = secret_name(&link.bot, link.platform, TokenKind::App);
            out.one(&app, vault.delete(service, &app));
        }
    }
    out
}

fn token_name(bot: &str, platform: Platform) -> String {
    format!("{}:{}", platform.id(), bot_key(bot))
}

/// The keychain entry of one of a link's secrets. The App-Level Token is a
/// second entry next to the bot's: the vault needs nothing new for it.
fn secret_name(bot: &str, platform: Platform, kind: TokenKind) -> String {
    match kind {
        TokenKind::Bot => token_name(bot, platform),
        TokenKind::App => format!("{}:app", token_name(bot, platform)),
    }
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
            keychain: Mutex::new(()),
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
        self.set_secret(bot, platform, TokenKind::Bot, token)
    }

    /// Saves Slack's App-Level Token, under the same rule: a value already
    /// saved anywhere, as either token of any link, is refused.
    pub fn set_app_token(&self, bot: &str, platform: Platform, token: &str) -> Result<(), String> {
        if !platform.needs_app_token() {
            return Err(format!("{} non usa un secondo token", platform.id()));
        }
        self.set_secret(bot, platform, TokenKind::App, token)
    }

    fn set_secret(&self, bot: &str, platform: Platform, kind: TokenKind, token: &str) -> Result<(), String> {
        check_bot(bot)?;
        let token = token.trim();
        check_token(token)?;
        self.write_secret(bot, platform, kind, token)?;
        // Outside the keychain's lock: starting a gateway again reads the token.
        if self.store.link(bot, platform).is_some_and(|link| link.enabled) {
            self.relaunch(bot, platform);
        }
        Ok(())
    }

    fn keychain(&self) -> std::sync::MutexGuard<'_, ()> {
        self.keychain.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_secret(&self, bot: &str, platform: Platform, kind: TokenKind, token: &str) -> Result<(), String> {
        let _keychain = self.keychain();
        let hash = token_hash(token);
        let held = |link: &LinkState| {
            link.token_hash.as_deref() == Some(hash.as_str()) || link.app_token_hash.as_deref() == Some(hash.as_str())
        };
        // Another link's token of either kind, or the other token of this one:
        // a bot token pasted where the App-Level Token goes is the same
        // mistake, and it is said as what it is, not as another bot's.
        let conflict = |link: &LinkState, others: &[LinkState]| -> Option<String> {
            if others.iter().any(held) {
                return Some("questo token è già di un altro bot o di un'altra piattaforma".into());
            }
            let other_slot = match kind {
                TokenKind::Bot => &link.app_token_hash,
                TokenKind::App => &link.token_hash,
            };
            (other_slot.as_deref() == Some(hash.as_str())).then(|| match kind {
                TokenKind::Bot => "questo token è già l'App-Level Token di questo bot: qui va il token del bot".into(),
                TokenKind::App => "questo token è già il token del bot: qui va l'App-Level Token, che comincia con xapp-".into(),
            })
        };
        let (this, others): (Vec<LinkState>, Vec<LinkState>) =
            self.store.read().links.into_iter().partition(|l| l.bot == bot && l.platform == platform);
        let this = this.into_iter().next().unwrap_or_else(|| LinkState::new(bot, platform));
        if let Some(why) = conflict(&this, &others) {
            return Err(why);
        }
        let name = secret_name(bot, platform, kind);
        let previous = self.vault.get(&self.service, &name)?;
        // The bot's updates are numbered by the bot: the same bot with a new secret goes on from where it was, another
        // bot would have its first messages confirmed and dropped by a position that is not its own (full review
        // 2026-10-06, rust 19). Telegram's token starts with the bot's id; elsewhere any other token is another start.
        let same_bot = previous.as_deref().is_some_and(|old| bot_id(old) == bot_id(token));
        self.vault.set(&self.service, &name, token)?;
        let recorded = self.store.update(bot, platform, |link, others| {
            if let Some(why) = conflict(link, others) {
                return Err(why);
            }
            match kind {
                TokenKind::Bot => {
                    link.token_hash = Some(hash.clone());
                    if !same_bot {
                        link.cursor = None;
                        link.cursor_saved_ms = None;
                    }
                }
                TokenKind::App => link.app_token_hash = Some(hash.clone()),
            }
            Ok(())
        });
        if let Err(error) = recorded {
            // Another command took the token between the check and the record:
            // the keychain goes back to what the record says, no entry without its hash.
            let restored = match previous {
                Some(old) => self.vault.set(&self.service, &name, &old),
                None => self.vault.delete(&self.service, &name),
            };
            if let Err(failed) = restored {
                self.env.log(&format!("gateway {}: portachiavi non ripristinato: {failed}", platform.id()));
            }
            return Err(error);
        }
        Ok(())
    }

    /// Forgets the token, and Slack's App-Level Token with it: the gateway
    /// stops and is switched off.
    pub fn clear_token(&self, bot: &str, platform: Platform) -> Result<(), String> {
        check_bot(bot)?;
        self.halt(bot, platform);
        self.failed().remove(&(bot.to_string(), platform));
        remove_pending_file(&pending_file_path(self.store.path(), bot, platform));
        let _keychain = self.keychain();
        self.vault.delete(&self.service, &token_name(bot, platform))?;
        if platform.needs_app_token() {
            self.vault.delete(&self.service, &secret_name(bot, platform, TokenKind::App))?;
        }
        // A platform the bot never had: nothing to write down. A deleted bot's
        // tokens are cleared on every platform, and each would leave a link.
        if self.store.link(bot, platform).is_none() {
            return Ok(());
        }
        self.store.update(bot, platform, |link, _| {
            link.token_hash = None;
            link.app_token_hash = None;
            link.enabled = false;
            // No token, no bot: nothing for a position to belong to.
            link.cursor = None;
            link.cursor_saved_ms = None;
            Ok(())
        })
    }

    /// A bot deleted: every gateway of it stops, its tokens leave the keychain,
    /// and its links go, with who was authorized and the chats it knew. A new
    /// bot made later at the same path starts from nothing: it does not
    /// inherit the senders someone let write to the old one.
    pub fn forget_bot(&self, bot: &str) -> Result<(), String> {
        check_bot(bot)?;
        let mut platforms = vec![Platform::Telegram, Platform::Discord, Platform::Slack];
        for link in self.store.read().links.into_iter().filter(|link| link.bot == bot) {
            if !platforms.contains(&link.platform) {
                platforms.push(link.platform);
            }
        }
        for platform in &platforms {
            remove_pending_file(&pending_file_path(self.store.path(), bot, *platform));
        }
        // Every platform is tried, whatever failed before it: one keychain
        // error must not leave the next platforms with their tokens.
        let failed: Vec<String> = platforms
            .into_iter()
            .filter_map(|platform| self.clear_token(bot, platform).err().map(|error| format!("{}: {error}", platform.label())))
            .collect();
        if !failed.is_empty() {
            // The links stay, token hashes and all, until a new try removes what is left.
            return Err(failed.join("; "));
        }
        self.store.forget(bot)
    }

    /// The token, for building the platform's adapter. Rust only: never sent to the page.
    pub fn token(&self, bot: &str, platform: Platform) -> Result<Option<String>, String> {
        self.vault.get(&self.service, &token_name(bot, platform))
    }

    /// Slack's App-Level Token, for the same use and under the same rule.
    pub fn app_token(&self, bot: &str, platform: Platform) -> Result<Option<String>, String> {
        self.vault.get(&self.service, &secret_name(bot, platform, TokenKind::App))
    }

    /// Every value that must not leave through a gateway: the tokens and the keychain's keys.
    fn secrets(&self) -> Vec<String> {
        let mut secrets = self.env.secrets();
        for link in self.store.read().links.iter().filter(|link| link.token_hash.is_some()) {
            if let Ok(Some(token)) = self.vault.get(&self.service, &token_name(&link.bot, link.platform)) {
                secrets.push(token);
            }
        }
        for link in self.store.read().links.iter().filter(|link| link.app_token_hash.is_some()) {
            if let Ok(Some(token)) = self.app_token(&link.bot, link.platform) {
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

    /// The platform's adapter, with the bot's tokens and the saved position.
    fn connect(&self, bot: &str, platform: Platform) -> Result<Arc<dyn Adapter>, String> {
        let token = self.token(bot, platform)?.ok_or_else(|| "manca il token del bot per questa piattaforma".to_string())?;
        let app = if platform.needs_app_token() {
            Some(self.app_token(bot, platform)?.ok_or_else(|| {
                "manca l'App-Level Token di Slack (xapp-…), quello con connections:write".to_string()
            })?)
        } else {
            None
        };
        let cursor = self.store.link(bot, platform).and_then(|link| link.cursor);
        let secrets: Vec<String> = std::iter::once(token.clone()).chain(app.clone()).collect();
        (self.connect)(platform, &Tokens { bot: token, app }, cursor).map_err(|error| redact(&error, &secrets))
    }

    /// Starts every gateway the user left switched on: ADE opened. Each waits
    /// for the page to listen before it reads. Not one whose bot is gone,
    /// deleted outside ADE or by a deletion that could not clear its token:
    /// its token would answer chats for a bot nobody sees in the roster.
    pub fn resume(&self) {
        for link in self.store.read().links.into_iter().filter(|link| link.enabled) {
            if !self.env.bot_exists(&link.bot) {
                let error = "il file del bot non c'è più".to_string();
                self.env.log(&format!("gateway {} {}: non riparte: {error}", link.platform.id(), &bot_key(&link.bot)[..8]));
                self.failed().insert((link.bot.clone(), link.platform), error);
                continue;
            }
            self.relaunch(&link.bot, link.platform);
        }
    }

    /// The page listens for `gateway:message`: the gateways may read.
    pub fn ready(&self) {
        let pending: Vec<GatewayMessage> = {
            let links = self.links();
            links
                .values()
                .flat_map(|r| {
                    r.pending
                        .lock()
                        .unwrap()
                        .iter_mut()
                        .filter(|entry| !entry.acked)
                        .map(|entry| {
                            entry.msg.recovered = true;
                            entry.msg.clone()
                        })
                        .collect::<Vec<_>>()
                })
                .collect()
        };
        for msg in pending {
            self.env.message(&msg);
        }
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
        let mut initial_pending: VecDeque<PendingEntry> =
            read_pending_file(&pending_file_path(self.store.path(), bot, platform)).into();
        let ready_now = *self.ready.borrow();
        if ready_now {
            for entry in initial_pending.iter_mut().filter(|entry| !entry.acked) {
                entry.msg.recovered = true;
                self.env.message(&entry.msg);
            }
        }
        let pending = Arc::new(Mutex::new(initial_pending));
        let started_at = self.env.now_ms();
        let task = Task {
            env: self.env.clone(),
            store: self.store.clone(),
            adapter: adapter.clone(),
            bot: bot.to_string(),
            platform,
            live: live.clone(),
            pending: pending.clone(),
            secrets: self.secrets(),
            backoff: self.backoff,
            started_at,
        };
        tokio::spawn(task.run(stopped, self.ready.subscribe()));
        self.links().insert((bot.to_string(), platform), Running { adapter, stop, live, pending });
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

    /// Whether any gateway is switched on, running or waiting to retry: the
    /// user wants the chats to reach their bots (G11, the tray).
    pub fn any_on(&self) -> bool {
        self.store.read().links.iter().any(|link| link.enabled)
    }

    /// ADE is closing: every task ends, and each gateway stays as the user left it.
    pub fn shutdown(&self) {
        for (_, running) in self.links().drain() {
            let _ = running.stop.send(true);
        }
    }

    /// The webview acknowledged receipt of a message: advance the cursor up to this message in state.json.
    pub fn ack(&self, bot: &str, platform: Platform, chat: &str, id: &str) -> Result<(), String> {
        check_bot(bot)?;
        let (adapter, pending_lock) = match self.links().get(&(bot.to_string(), platform)) {
            Some(r) => (r.adapter.clone(), r.pending.clone()),
            None => return Ok(()),
        };
        let mut cursor_to_save = None;
        {
            let mut pending = pending_lock.lock().unwrap();
            if let Some(entry) = pending.iter_mut().find(|entry| entry.msg.chat == chat && entry.msg.id == id) {
                entry.acked = true;
            }
            while pending.front().map_or(false, |entry| entry.acked) {
                let popped = pending.pop_front().unwrap();
                if popped.cursor.is_some() {
                    cursor_to_save = popped.cursor;
                }
            }
            save_pending_to_disk(&*self.env, self.store.path(), bot, platform, &pending);
        }
        if let Some(cursor) = cursor_to_save {
            adapter.ack(&cursor);
            let written_at = self.env.now_ms();
            self.store.update(bot, platform, |link, _| {
                if is_cursor_ahead(link.cursor.as_deref(), &cursor) {
                    link.cursor = Some(cursor.clone());
                    link.cursor_saved_ms = Some(written_at);
                }
                Ok(())
            })?;
        }
        Ok(())
    }
}

fn is_cursor_ahead(existing: Option<&str>, candidate: &str) -> bool {
    let Some(existing) = existing else {
        return true;
    };
    if let (Ok(c), Ok(e)) = (candidate.parse::<i64>(), existing.parse::<i64>()) {
        return c > e;
    }
    if let (Ok(c_val), Ok(e_val)) = (
        serde_json::from_str::<serde_json::Value>(candidate),
        serde_json::from_str::<serde_json::Value>(existing),
    ) {
        if let (Some(c_seq), Some(e_seq)) = (
            c_val.get("seq").and_then(|v| v.as_i64()),
            e_val.get("seq").and_then(|v| v.as_i64()),
        ) {
            return c_seq > e_seq;
        }
    }
    candidate != existing
}

impl Hub {

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
        self.send_with(bot, platform, chat, text, false, None).await
    }

    pub async fn send_with(
        &self,
        bot: &str,
        platform: Platform,
        chat: &str,
        text: &str,
        final_turn: bool,
        preview_fallback: Option<&str>,
    ) -> Result<String, String> {
        let adapter = self.reply_target(bot, platform, chat)?;
        let secrets = self.secrets();
        adapter
            .send_with(chat, &redact(text, &secrets), final_turn, preview_fallback)
            .await
            .map_err(|error| redact(&error.message(), &secrets))
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

    pub async fn preview(&self, bot: &str, platform: Platform, chat: &str, text: &str) -> Result<(), String> {
        let adapter = self.reply_target(bot, platform, chat)?;
        let secrets = self.secrets();
        adapter
            .preview(chat, &redact(text, &secrets))
            .await
            .map_err(|error| redact(&error.message(), &secrets))
    }

    pub async fn preview_end(&self, bot: &str, platform: Platform, chat: &str, fallback: Option<&str>) -> Result<(), String> {
        let adapter = self.reply_target(bot, platform, chat)?;
        adapter.preview_end(chat, fallback).await.map_err(|error| redact(&error.message(), &self.secrets()))
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
            linked_by: pairing.linked_by.clone(),
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

    /// A link and a QR for the owner's phone: a token only ADE's window can ask for, shown as `t.me/<bot>?start=<token>`
    /// and as its picture. It lasts ten minutes and works once; asking again makes a new one and cancels the old. Only
    /// Telegram has one; the others keep the code (`pairing_link.rs`). The bot's username comes from the platform, with
    /// the saved token, so the link is the one of the bot that is really there.
    pub async fn pairing_link(&self, bot: &str, platform: Platform) -> Result<PairingLink, String> {
        check_bot(bot)?;
        // The platform is checked before anything is asked of it or saved.
        pairing_link::has_link(platform)?;
        let adapter = self.connect(bot, platform)?;
        let whoami = adapter.whoami().await.map_err(|error| redact(&error.message(), &self.secrets()))?;
        // The username first: with none, no token is made for nothing.
        pairing_link::telegram_username(&whoami)?;
        let (token, expires_ms) = self.issue_link_token(bot, platform)?;
        let url = pairing_link::link_url(platform, &whoami, &token)?;
        let svg = pairing_link::qr_svg(&url)?;
        self.env.log(&format!("gateway {} {}: link di abbinamento creato in ADE", platform.id(), &bot_key(bot)[..8]));
        Ok(PairingLink { url, svg, expires_ms })
    }

    /// The QR is off ADE's screen (another tab, step, bot, the window closed): its token is cancelled, so a photo of it
    /// pairs nobody. Nothing to cancel is no error.
    pub fn pairing_link_cancel(&self, bot: &str, platform: Platform) -> Result<(), String> {
        check_bot(bot)?;
        self.store.update(bot, platform, |link, _| Ok(link.pairing.cancel_link())).map(|_| ())
    }

    /// A new link token for the bot's link, saved as a hash; the old one is gone.
    fn issue_link_token(&self, bot: &str, platform: Platform) -> Result<(String, u64), String> {
        let now = self.env.now_ms();
        self.store.update(bot, platform, |link, _| link.pairing.issue_link(now, &mut authz::os_random))
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
        // The moment the user pressed it: `open` counts the ten minutes from there, so a request that waited longer
        // than that still gets the refusal taken back by opening the pairing again (N6).
        let now = self.env.now_ms();
        self.store.update(bot, platform, |link, _| link.pairing.reject_at(request, now).map(|_| ()))
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
                    has_app_token: link.app_token_hash.is_some(),
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
    pending: Arc<Mutex<VecDeque<PendingEntry>>>,
    /// Taken at start; an error or a text holding one of these is cleaned before it is shown.
    secrets: Vec<String>,
    backoff: (Duration, Duration),
    started_at: u64,
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
        // A batch read and not handed on when the loop ended.
        let mut left_behind = 0;
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
            /*
             * Stopped while the batch came in: a platform with a cursor
             * (Telegram) gives it again to the next adapter, from the position
             * saved before it. One without (Slack) does not: it had its ack,
             * and the batch is lost. Counted in the log below, not handed on to
             * a gateway that was switched off (G10 review, 6).
             */
            if *stopped.borrow() {
                left_behind = read.as_ref().map(Vec::len).unwrap_or(0);
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
                        left_behind = batch.len();
                        break;
                    }
                    for message in batch {
                        self.deliver(message).await;
                    }
                    if self.pending.lock().unwrap().iter().all(|entry| entry.acked) {
                        self.save_cursor();
                    }
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
        self.count_left_behind(left_behind);
    }

    /// How many messages the platform confirmed and this gateway did not hand
    /// on, said in the log when it ends: a number, never their text. Nothing
    /// for a platform with a cursor, which sends them again.
    fn count_left_behind(&self, in_hand: usize) {
        if self.adapter.cursor().is_some() {
            return;
        }
        let left = in_hand + self.adapter.unread();
        if left > 0 {
            self.env.log(&format!("{}: fermato con {left} messaggi già confermati e non consegnati: la piattaforma non li rimanda", self.tag()));
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
            if is_cursor_ahead(link.cursor.as_deref(), &cursor) {
                link.cursor = Some(cursor.clone());
                link.cursor_saved_ms = Some(written_at);
            }
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
        // The token of a pairing link (`/start <token>`) never goes on as a message, whoever sends it: it is a secret
        // of ADE's window for ten minutes, and a page's thread is no place for it.
        if !message.button {
            if let Some(token) = link_token_of(&message.text) {
                if self.link_arrived(&message, token, authorized).await {
                    return;
                }
            }
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
        let recovered = message.timestamp_ms.is_some_and(|ts| ts < self.started_at);
        let msg = GatewayMessage {
            bot: self.bot.clone(),
            platform: self.platform,
            chat: message.chat,
            sender: MessageSender { id: message.sender.id, name },
            text,
            id: message.id,
            redacted,
            button: message.button,
            private: message.private,
            recovered,
        };
        let cursor = message.cursor.clone().or_else(|| self.adapter.cursor());
        let mut pending = self.pending.lock().unwrap();
        if pending.iter().any(|entry| entry.msg.chat == msg.chat && entry.msg.id == msg.id) {
            self.env.log(&format!("{tag}: ignorato un messaggio già in coda"));
            return;
        }
        if pending.len() >= PENDING_CAP {
            self.env.log(&format!("{tag}: coda dei messaggi in attesa piena ({PENDING_CAP}): messaggio scartato"));
            return;
        }
        pending.push_back(PendingEntry { msg: msg.clone(), cursor, acked: false });
        save_pending_to_disk(&*self.env, self.store.path(), &self.bot, self.platform, &pending);
        drop(pending);
        self.env.message(&msg);
        self.report(|live| live.last_message_ms = Some(at));
    }

    /// `/start <token>` arrived. True when it is dealt with here (the message goes no further).
    ///
    /// - from someone already paired: said again that they are, and nothing else (the token is not spent);
    /// - from a stranger in a private chat: a right token pairs them as a typed code would (same owner check: the token
    ///   only exists because the owner asked for it in ADE); a wrong, expired or used one counts for nothing (192 bits are
    ///   not guessed, and a count would only let a stranger shut the owner's link), the stranger is told the link no
    ///   longer holds and goes on to the ordinary way, a code if pairing is open: the code is the reserve;
    /// - in a group or channel the token is worth nothing, and nothing happens.
    ///
    /// The log has the fact and never the token.
    async fn link_arrived(&self, message: &Inbound, token: &str, authorized: bool) -> bool {
        let tag = self.tag();
        if authorized {
            self.env.log(&format!("{tag}: un link di abbinamento da un account già abbinato: non va avanti"));
            if message.private {
                if let Err(error) = self.adapter.send(&message.chat, PAIRED_MESSAGE).await {
                    self.env.log(&format!("{tag}: conferma non mandata: {}", redact(&error.message(), &self.secrets)));
                }
            }
            return true;
        }
        if !message.private {
            self.env.log(&format!("{tag}: un link di abbinamento in un canale non vale: ignorato"));
            return false;
        }
        let now = self.env.now_ms();
        let name = authz::clean_name(&redact(&message.sender.name, &self.secrets));
        let outcome = self.store.update(&self.bot, self.platform, |link, _| {
            let used = link.pairing.use_link(token, &message.sender.id, now);
            if used == LinkUse::Paired {
                if !link.is_authorized(&message.sender.id) {
                    link.authorized.push(Authorized { id: message.sender.id.clone(), name: name.clone(), added_ms: now });
                }
                link.remember_chat(&message.chat, &message.sender.id);
            }
            // Told the link no longer holds only after a link ADE made recently, and once each ten minutes: otherwise the
            // bot is as silent as for any stranger, and the way of a plain `/start` follows.
            let say = used == LinkUse::Wrong && link.pairing.may_say_stale(&message.sender.id, now);
            Ok((used, say))
        });
        match outcome {
            Ok((LinkUse::Paired, _)) => {
                self.env.log(&format!("{tag}: abbinamento fatto con il link di ADE"));
                if let Err(error) = self.adapter.send(&message.chat, PAIRED_MESSAGE).await {
                    self.env.log(&format!("{tag}: conferma dell'abbinamento non mandata: {}", redact(&error.message(), &self.secrets)));
                }
                true
            }
            Ok((LinkUse::Wrong, say)) => {
                self.env.log(&format!("{tag}: link di abbinamento sbagliato, scaduto o già usato"));
                if say {
                    if let Err(error) = self.adapter.send(&message.chat, LINK_STALE_MESSAGE).await {
                        self.env.log(&format!("{tag}: avviso del link non mandato: {}", redact(&error.message(), &self.secrets)));
                    }
                }
                false
            }
            Ok((LinkUse::NotAToken, _)) => false,
            Err(error) => {
                self.env.log(&format!("{tag}: link di abbinamento non verificato, stato non salvato: {error}"));
                false
            }
        }
    }

    /// A stranger wrote in private: a code in their chat, and a request in ADE.
    /// Their text goes nowhere. While they wait, past the limits, and anywhere
    /// but a private chat, silence.
    async fn pair(&self, message: Inbound) {
        let tag = self.tag();
        // A channel others read is no place for a code: the owner types it in ADE believing it is theirs, and the
        // stranger who mentioned the bot becomes authorized (review of the bots, S3). Silence there; a private chat
        // with the bot gets its code like any stranger.
        if !message.private {
            self.env.log(&format!("{tag}: ignorato un mittente non autorizzato in un canale: il codice solo in privato"));
            return;
        }
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
            // Nobody has a code: the request goes, and the stranger may write again at once (S12).
            let _ = self.store.update(&self.bot, self.platform, |link, _| {
                link.pairing.undo(&pending.request);
                Ok(())
            });
            return;
        }
        self.env.log(&format!("{tag}: codice di abbinamento mandato a un mittente non autorizzato"));
        self.env.pairing(&pairing_request(&self.bot, self.platform, &pending));
    }
}

/// The token in `/start <token>` (also `/start@name <token>`), when it has the shape of one. Telegram sends the payload
/// of a `t.me/<bot>?start=<payload>` link this way, to the private chat of whoever opened it.
fn link_token_of(text: &str) -> Option<&str> {
    let rest = text.trim().strip_prefix("/start")?;
    let payload = match rest.chars().next()? {
        c if c.is_whitespace() => rest,
        '@' => rest.split_once(char::is_whitespace)?.1,
        _ => return None,
    };
    let payload = payload.trim();
    authz::is_link_token(payload).then_some(payload)
}

/// The part of a token that says which bot it is: Telegram's token is `<bot id>:<secret>`, the others have no colon and
/// are whole.
fn bot_id(token: &str) -> &str {
    token.split(':').next().unwrap_or(token)
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

    /// The keychain in memory; a delete of a name that starts with one in `.1` fails.
    #[derive(Default)]
    struct MapVault(Mutex<BTreeMap<(String, String), String>>, Mutex<Vec<String>>);
    impl Vault for MapVault {
        fn get(&self, service: &str, name: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(&(service.into(), name.into())).cloned())
        }
        fn set(&self, service: &str, name: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert((service.into(), name.into()), value.into());
            Ok(())
        }
        fn delete(&self, service: &str, name: &str) -> Result<(), String> {
            if self.1.lock().unwrap().iter().any(|prefix| name.starts_with(prefix.as_str())) {
                return Err("portachiavi non disponibile".into());
            }
            self.0.lock().unwrap().remove(&(service.into(), name.into()));
            Ok(())
        }
    }

    #[test]
    fn forgetting_every_token_takes_each_links_secrets_out_and_nothing_of_another_service() {
        let dir = std::env::temp_dir().join(format!("ade-forget-tokens-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = dir.join("state.json");
        let store = Store::new(state.clone());
        store.update(BOT, Platform::Telegram, |_, _| Ok(())).unwrap();
        store.update(BOT, Platform::Slack, |_, _| Ok(())).unwrap();
        let vault = MapVault::default();
        vault.set("svc", &token_name(BOT, Platform::Telegram), TOKEN).unwrap();
        vault.set("svc", &token_name(BOT, Platform::Slack), "xoxb-finto").unwrap();
        vault.set("svc", &secret_name(BOT, Platform::Slack, TokenKind::App), "xapp-finto").unwrap();
        vault.set("svc", "altro-nome", "non-di-un-link").unwrap();
        vault.set("altro-servizio", &token_name(BOT, Platform::Telegram), "di-un-altra-app").unwrap();

        let gone = forget_all_tokens(&vault, "svc", &state);
        assert_eq!(gone.cleared, 3);
        assert!(gone.failed.is_empty());
        assert_eq!(vault.get("svc", &token_name(BOT, Platform::Telegram)).unwrap(), None);
        assert_eq!(vault.get("svc", &token_name(BOT, Platform::Slack)).unwrap(), None);
        assert_eq!(vault.get("svc", &secret_name(BOT, Platform::Slack, TokenKind::App)).unwrap(), None);
        assert!(vault.get("svc", "altro-nome").unwrap().is_some());
        assert!(vault.get("altro-servizio", &token_name(BOT, Platform::Telegram)).unwrap().is_some());
        // The state is the folder's, and a missing one is no links.
        assert!(state.exists());
        assert_eq!(forget_all_tokens(&vault, "svc", &dir.join("manca.json")), crate::secrets::Forgotten::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_token_the_keychain_refuses_is_reported_and_the_rest_still_go() {
        let dir = std::env::temp_dir().join(format!("ade-forget-refuse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let state = dir.join("state.json");
        let store = Store::new(state.clone());
        store.update(BOT, Platform::Telegram, |_, _| Ok(())).unwrap();
        store.update(BOT, Platform::Discord, |_, _| Ok(())).unwrap();
        let vault = MapVault::default();
        vault.set("svc", &token_name(BOT, Platform::Telegram), TOKEN).unwrap();
        vault.set("svc", &token_name(BOT, Platform::Discord), "discord-finto").unwrap();
        vault.1.lock().unwrap().push(token_name(BOT, Platform::Telegram));
        let gone = forget_all_tokens(&vault, "svc", &state);
        assert_eq!(gone.cleared, 1);
        assert_eq!(gone.failed.len(), 1);
        assert_eq!(vault.get("svc", &token_name(BOT, Platform::Discord)).unwrap(), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[derive(Default)]
    struct Recorder {
        messages: Mutex<Vec<GatewayMessage>>,
        pairings: Mutex<Vec<PairingRequest>>,
        statuses: Mutex<Vec<LinkStatus>>,
        log: Mutex<Vec<String>>,
        /// Added to the clock, to move time on.
        later: std::sync::atomic::AtomicU64,
        /// Bots whose file is gone.
        gone: Mutex<Vec<String>>,
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
        fn bot_exists(&self, bot: &str) -> bool {
            !self.gone.lock().unwrap().iter().any(|gone| gone == bot)
        }
    }

    /// Every adapter the hub asked for, with the token and position it was given.
    type Made = Arc<Mutex<Vec<(String, Option<String>, Arc<FakeAdapter>, Feed)>>>;

    struct Setup {
        hub: Hub,
        env: Arc<Recorder>,
        path: std::path::PathBuf,
        made: Made,
        vault: Arc<dyn Vault>,
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
        setup_vault(path, vault)
    }

    fn setup_vault(path: std::path::PathBuf, vault: Arc<dyn Vault>) -> Setup {
        let env = Arc::new(Recorder::default());
        let made: Made = Arc::default();
        let record = made.clone();
        let connect: Connect = Arc::new(move |_platform, tokens: &Tokens, cursor: Option<String>| {
            let (adapter, feed) = FakeAdapter::new();
            let token = match &tokens.app {
                Some(app) => format!("{}+{app}", tokens.bot),
                None => tokens.bot.clone(),
            };
            record.lock().unwrap().push((token, cursor, adapter.clone(), feed));
            Ok(adapter as Arc<dyn Adapter>)
        });
        let hub = Hub::new(env.clone(), vault.clone(), "ai.nikcli.ade.test.gateway".into(), Arc::new(Store::new(path.clone())), connect)
            .with_backoff(Duration::from_millis(5), Duration::from_millis(20));
        hub.ready();
        Setup { hub, env, path, made, vault }
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
            cursor: None,
            timestamp_ms: None,
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

    /* S3 (review of the bots): a pairing code never goes to a public channel. */
    #[tokio::test]
    async fn a_stranger_in_a_public_channel_gets_no_code_and_no_request() {
        let s = setup("public-pairing");
        let (adapter, feed) = start(&s);
        let public = |id: &str| Inbound { private: false, mentioned: true, ..message(id, "canale9", "9", "@bot fammi entrare") };
        feed.send(Ok(vec![public("1")])).unwrap();
        feed.send(Ok(vec![public("2")])).unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(adapter.sent.lock().unwrap().is_empty(), "un codice in un canale pubblico");
        assert!(s.env.pairings.lock().unwrap().is_empty());
        assert!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().pending.is_empty());
        assert!(s.env.messages.lock().unwrap().is_empty());
        // The same person in private is a stranger like any other: a code, there.
        feed.send(Ok(vec![message("3", "d9", "9", "ciao")])).unwrap();
        eventually("il codice arriva in privato", || adapter.sent.lock().unwrap().len() == 1).await;
        assert_eq!(adapter.sent.lock().unwrap()[0].0, "d9");
        assert_eq!(s.env.pairings.lock().unwrap().len(), 1);
    }

    /* S17: the page learns whether a message came from a private chat, so a channel never gets a question. */
    #[tokio::test]
    async fn the_page_is_told_whether_a_message_came_from_a_private_chat() {
        let s = setup("private-flag");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "d42", "42", "in privato")])).unwrap();
        feed.send(Ok(vec![Inbound { private: false, mentioned: true, ..message("2", "canale1", "42", "@bot in pubblico") }])).unwrap();
        eventually("arrivano entrambi", || s.env.messages.lock().unwrap().len() == 2).await;
        let seen = s.env.messages.lock().unwrap().iter().map(|m| (m.id.clone(), m.private)).collect::<Vec<_>>();
        assert_eq!(seen, vec![("1".to_string(), true), ("2".to_string(), false)]);
        let json = serde_json::to_string(&s.env.messages.lock().unwrap()[1]).unwrap();
        assert!(json.contains("\"private\":false"), "{json}");
    }

    /* G11: the window hides to the tray while a gateway is on. */
    #[tokio::test]
    async fn a_gateway_is_on_from_start_to_stop_even_when_its_task_is_not_running() {
        let s = setup("any-on");
        assert!(!s.hub.any_on(), "nessun gateway acceso");
        let _ = start(&s);
        assert!(s.hub.any_on());
        // ADE closing ends the tasks, and the gateway stays on for the next start.
        s.hub.shutdown();
        assert!(s.hub.any_on());
        s.hub.stop(BOT, Platform::Fake).unwrap();
        assert!(!s.hub.any_on());
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
    async fn switching_off_lets_go_of_the_adapter() {
        // A socket adapter closes its connection when nobody holds it any more
        // (`discord.rs`): switching off has to be that moment, for the link
        // and for its reading task alike.
        let s = setup("let-go");
        let (adapter, _feed) = start(&s);
        // Here: the list of adapters made, this test, the link, its task.
        eventually("il task tiene l'adapter", || Arc::strong_count(&adapter) == 4).await;
        s.hub.stop(BOT, Platform::Fake).unwrap();
        eventually("spento, restano solo la lista e il test", || Arc::strong_count(&adapter) == 2).await;
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

    /* G10: Slack has two secrets, the bot's token and the App-Level Token. */

    const SLACK_BOT: &str = "xoxb-FINTO-0000000000-token-del-bot";
    const SLACK_APP: &str = "xapp-1-FINTO-0000000000-token-app";

    #[tokio::test]
    async fn slack_keeps_two_tokens_and_either_one_taken_is_refused() {
        let s = setup("slack-tokens");
        let other = "C:/progetto/.nikcli/agent/altro.md";
        s.hub.set_token(BOT, Platform::Slack, SLACK_BOT).unwrap();
        // The bot's token where the App-Level Token goes: refused, and said as
        // this bot's other token, not another bot's.
        let same_link = s.hub.set_app_token(BOT, Platform::Slack, SLACK_BOT).unwrap_err();
        assert!(same_link.contains("già il token del bot"), "{same_link}");
        assert!(!same_link.contains("altro bot"), "l'altro token dello stesso bot non è di un altro bot: {same_link}");
        s.hub.set_app_token(BOT, Platform::Slack, SLACK_APP).unwrap();
        assert!(s.hub.set_token(BOT, Platform::Slack, SLACK_APP).unwrap_err().contains("già"));
        // Either of them on another bot, in either slot.
        assert!(s.hub.set_token(other, Platform::Slack, SLACK_APP).unwrap_err().contains("già"));
        assert!(s.hub.set_app_token(other, Platform::Slack, SLACK_BOT).unwrap_err().contains("già"));
        assert!(s.hub.set_token(other, Platform::Telegram, SLACK_APP).unwrap_err().contains("già"));
        assert!(s.hub.app_token(other, Platform::Slack).unwrap().is_none());
        // Only Slack has a second one.
        assert!(s.hub.set_app_token(other, Platform::Telegram, "xapp-1-UN-ALTRO-FINTO-0000").is_err());

        let status = s.hub.status();
        let slack = status.iter().find(|link| link.bot == BOT).expect("il collegamento");
        assert!(slack.has_token && slack.has_app_token);
        let shown = serde_json::to_string(&status).unwrap();
        assert!(!shown.contains(SLACK_BOT) && !shown.contains(SLACK_APP));
        let saved = std::fs::read_to_string(&s.path).unwrap();
        assert!(!saved.contains(SLACK_APP), "nel file solo l'hash");
        assert!(saved.contains(&token_hash(SLACK_APP)));

        // The adapter is made with both.
        s.hub.start(BOT, Platform::Slack, "C:/progetto").unwrap();
        assert_eq!(last_made_token(&s), format!("{SLACK_BOT}+{SLACK_APP}"));

        // Forgetting the token forgets both.
        s.hub.clear_token(BOT, Platform::Slack).unwrap();
        assert!(s.hub.token(BOT, Platform::Slack).unwrap().is_none());
        assert!(s.hub.app_token(BOT, Platform::Slack).unwrap().is_none());
        assert!(!s.hub.status()[0].has_app_token);
        s.hub.set_app_token(other, Platform::Slack, SLACK_APP).unwrap();
    }

    #[tokio::test]
    async fn slack_without_its_app_token_does_not_start_and_says_which_one() {
        let s = setup("slack-no-app");
        s.hub.set_token(BOT, Platform::Slack, SLACK_BOT).unwrap();
        let error = s.hub.start(BOT, Platform::Slack, "C:/progetto").unwrap_err();
        assert!(error.contains("App-Level Token") && error.contains("connections:write"), "{error}");
        assert!(s.made.lock().unwrap().is_empty());
        assert!(!error.contains(SLACK_BOT));
    }

    #[tokio::test]
    async fn a_reply_loses_the_app_token_too() {
        let s = setup("slack-redact");
        s.hub.set_token(BOT, Platform::Slack, SLACK_BOT).unwrap();
        s.hub.set_app_token(BOT, Platform::Slack, SLACK_APP).unwrap();
        s.hub
            .store
            .update(BOT, Platform::Slack, |link, _| {
                link.authorized.push(Authorized { id: "U42".into(), name: "Io".into(), added_ms: 1 });
                Ok(())
            })
            .unwrap();
        s.hub.start(BOT, Platform::Slack, "C:/progetto").unwrap();
        let (adapter, feed) = last_made(&s);
        feed.send(Ok(vec![message("1", "D42", "U42", "dimmi i token")])).unwrap();
        eventually("il messaggio arriva", || s.env.messages.lock().unwrap().len() == 1).await;
        s.hub.send(BOT, Platform::Slack, "D42", &format!("app={SLACK_APP} bot={SLACK_BOT}")).await.unwrap();
        assert_eq!(adapter.sent.lock().unwrap()[0].1, "app=[nascosto] bot=[nascosto]");
    }

    fn last_made_token(setup: &Setup) -> String {
        setup.made.lock().unwrap().last().expect("nessun adapter creato").0.clone()
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
    async fn a_bot_made_where_a_deleted_one_was_inherits_nobody() {
        let s = setup("forget");
        authorize(&s, "42");
        let (adapter, _feed) = start(&s);
        s.hub.forget_bot(BOT).unwrap();
        assert!(s.hub.status().iter().all(|link| link.bot != BOT), "il collegamento del bot cancellato resta");
        assert!(s.hub.token(BOT, Platform::Fake).unwrap().is_none());
        assert!(s.hub.links().is_empty(), "il gateway del bot cancellato gira ancora");
        drop(adapter);
        // A new bot, same path: nobody authorized, no token, off.
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        let fresh = s.hub.status().into_iter().find(|link| link.bot == BOT).expect("il bot nuovo");
        assert!(fresh.authorized.is_empty(), "ha ereditato gli autorizzati: {:?}", fresh.authorized);
        assert!(!fresh.enabled);
        // Another bot is left as it was.
        let other = "C:/progetto/.nikcli/agent/altro.md";
        s.hub.set_token(other, Platform::Fake, "987654321:ALTRO-token-di-prova_AbCdEfGhIj").unwrap();
        s.hub.forget_bot(BOT).unwrap();
        assert!(s.hub.status().iter().any(|link| link.bot == other && link.has_token));
    }

    /// A keychain that, at its first write, lets another command record the
    /// same token for another bot: the race between the check and the record.
    struct RacingVault {
        keys: MapVault,
        store: Mutex<Option<(Arc<Store>, String)>>,
    }
    impl Vault for RacingVault {
        fn get(&self, service: &str, name: &str) -> Result<Option<String>, String> {
            self.keys.get(service, name)
        }
        fn set(&self, service: &str, name: &str, value: &str) -> Result<(), String> {
            if let Some((store, other)) = self.store.lock().unwrap().take() {
                store
                    .update(&other, Platform::Fake, |link, _| {
                        link.token_hash = Some(token_hash(value));
                        Ok(())
                    })
                    .unwrap();
            }
            self.keys.set(service, name, value)
        }
        fn delete(&self, service: &str, name: &str) -> Result<(), String> {
            self.keys.delete(service, name)
        }
    }

    #[tokio::test]
    async fn a_token_lost_to_another_bot_leaves_the_keychain_as_the_record_says() {
        let dir = std::env::temp_dir().join(format!("ade-gateway-hub-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = Arc::new(RacingVault { keys: MapVault::default(), store: Mutex::new(None) });
        let s = setup_vault(dir.join("state.json"), vault.clone());
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        // The next write races: another bot records the new token first.
        let other = "C:/progetto/.nikcli/agent/altro.md";
        *vault.store.lock().unwrap() = Some((s.hub.store.clone(), other.to_string()));
        let contested = "555555555:CONTESO-token-di-prova_AbCdEfGhIjKl";
        assert!(s.hub.set_token(BOT, Platform::Fake, contested).unwrap_err().contains("altro bot"));
        assert_eq!(s.hub.token(BOT, Platform::Fake).unwrap().as_deref(), Some(TOKEN), "il portachiavi tiene il token perdente");
        // And a first token lost the same way leaves no entry at all.
        let third = "C:/progetto/.nikcli/agent/terzo.md";
        *vault.store.lock().unwrap() = Some((s.hub.store.clone(), other.to_string()));
        let again = "666666666:ANCORA-token-di-prova_AbCdEfGhIjKl";
        assert!(s.hub.set_token(third, Platform::Fake, again).is_err());
        assert!(s.hub.token(third, Platform::Fake).unwrap().is_none(), "voce orfana nel portachiavi");
    }

    /// A keychain whose write of one value holds for a while, and lets another
    /// bot record that value meanwhile: the command writing it will lose.
    struct SlowVault {
        keys: MapVault,
        slow: String,
        store: Mutex<Option<(Arc<Store>, String)>>,
        writing: std::sync::Barrier,
    }
    impl Vault for SlowVault {
        fn get(&self, service: &str, name: &str) -> Result<Option<String>, String> {
            self.keys.get(service, name)
        }
        fn set(&self, service: &str, name: &str, value: &str) -> Result<(), String> {
            self.keys.set(service, name, value)?;
            if value == self.slow {
                if let Some((store, other)) = self.store.lock().unwrap().take() {
                    store
                        .update(&other, Platform::Fake, |link, _| {
                            link.token_hash = Some(token_hash(value));
                            Ok(())
                        })
                        .unwrap();
                }
                // The other command starts now, while this one is between its write and its record.
                self.writing.wait();
                std::thread::sleep(Duration::from_millis(150));
            }
            Ok(())
        }
        fn delete(&self, service: &str, name: &str) -> Result<(), String> {
            self.keys.delete(service, name)
        }
    }

    #[test]
    fn two_commands_on_one_entry_leave_the_keychain_as_the_record_says() {
        let dir = std::env::temp_dir().join(format!("ade-gateway-hub-two-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let lost = "555555555:PERDENTE-token-di-prova_AbCdEfGhIjKl";
        let won = "777777777:VINCENTE-token-di-prova_AbCdEfGhIjKl";
        let vault = Arc::new(SlowVault {
            keys: MapVault::default(),
            slow: lost.into(),
            store: Mutex::new(None),
            writing: std::sync::Barrier::new(2),
        });
        let s = setup_vault(dir.join("state.json"), vault.clone());
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        // A writes a token another bot records meanwhile, so A will lose;
        // B writes its own on the same entry while A is between write and record.
        let other = "C:/progetto/.nikcli/agent/altro.md";
        *vault.store.lock().unwrap() = Some((s.hub.store.clone(), other.to_string()));
        std::thread::scope(|scope| {
            let a = scope.spawn(|| s.hub.set_token(BOT, Platform::Fake, lost));
            vault.writing.wait();
            let b = scope.spawn(|| s.hub.set_token(BOT, Platform::Fake, won));
            assert!(a.join().unwrap().unwrap_err().contains("altro bot"));
            b.join().unwrap().unwrap();
        });
        let recorded = s.hub.store.link(BOT, Platform::Fake).and_then(|link| link.token_hash);
        assert_eq!(recorded.as_deref(), Some(token_hash(won).as_str()));
        assert_eq!(s.hub.token(BOT, Platform::Fake).unwrap().as_deref(), Some(won), "il portachiavi non tiene il token registrato");
    }

    #[tokio::test]
    async fn a_stop_says_how_many_confirmed_messages_it_leaves() {
        let s = setup("left-behind");
        let (adapter, _feed) = start(&s);
        eventually("la prima lettura", || adapter.receives.load(std::sync::atomic::Ordering::SeqCst) > 0).await;
        adapter.waiting.store(3, std::sync::atomic::Ordering::SeqCst);
        s.hub.stop(BOT, Platform::Fake).unwrap();
        let said = || s.env.log.lock().unwrap().iter().any(|line| line.contains("3 messaggi già confermati"));
        eventually("la riga nel log", said).await;
        // A number only: no text of any message.
        assert!(s.env.log.lock().unwrap().iter().all(|line| !line.contains("ciao")));
        // A platform with a cursor gives them again: nothing to say.
        let t = setup("left-behind-cursor");
        let (kept, _feed) = start(&t);
        eventually("la prima lettura", || kept.receives.load(std::sync::atomic::Ordering::SeqCst) > 0).await;
        *kept.position.lock().unwrap() = Some("42".into());
        kept.waiting.store(3, std::sync::atomic::Ordering::SeqCst);
        t.hub.stop(BOT, Platform::Fake).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(t.env.log.lock().unwrap().iter().all(|line| !line.contains("già confermati")));
    }

    #[tokio::test]
    async fn a_failed_platform_does_not_stop_the_others_and_is_named() {
        let dir = std::env::temp_dir().join(format!("ade-gateway-hub-forget-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let vault = Arc::new(MapVault::default());
        let s = setup_with(dir.join("state.json"), vault.clone());
        authorize(&s, "42");
        let _started = start(&s);
        // Discord's delete fails; the Fake platform comes after it in the list.
        vault.1.lock().unwrap().push("discord:".into());
        let error = s.hub.forget_bot(BOT).unwrap_err();
        assert!(error.contains("Discord"), "l'errore non nomina la piattaforma: {error}");
        assert!(!error.contains("Telegram") && !error.contains("Fake"), "nomina piattaforme riuscite: {error}");
        assert!(s.hub.token(BOT, Platform::Fake).unwrap().is_none(), "dopo il fallimento di Discord il resto non e' stato tolto");
        assert!(s.hub.links().is_empty(), "il gateway gira ancora");
        // The links stay until everything is gone: a new try finishes the work.
        assert!(s.hub.status().iter().any(|link| link.bot == BOT), "il collegamento e' sparito prima del tempo");
        vault.1.lock().unwrap().clear();
        s.hub.forget_bot(BOT).unwrap();
        assert!(s.hub.status().iter().all(|link| link.bot != BOT));
    }

    #[tokio::test]
    async fn clearing_a_platform_the_bot_never_had_leaves_nothing_behind() {
        let s = setup("clear-nothing");
        start(&s);
        // A deleted bot's tokens are cleared on every platform, not only its own.
        s.hub.clear_token(BOT, Platform::Telegram).unwrap();
        s.hub.clear_token(BOT, Platform::Discord).unwrap();
        s.hub.clear_token(BOT, Platform::Fake).unwrap();
        let links = s.hub.status();
        assert_eq!(links.len(), 1, "un collegamento per ogni piattaforma svuotata");
        assert!(!links[0].enabled && !links[0].has_token && !links[0].running);
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
        let connect: Connect = Arc::new(move |_platform, tokens: &Tokens, cursor: Option<String>| {
            let (adapter, feed) = FakeAdapter::new();
            let token = match &tokens.app {
                Some(app) => format!("{}+{app}", tokens.bot),
                None => tokens.bot.clone(),
            };
            record.lock().unwrap().push((token, cursor, adapter.clone(), feed));
            Ok(adapter as Arc<dyn Adapter>)
        });
        let hub = Hub::new(env.clone(), vault.clone(), "ai.nikcli.ade.test.gateway".into(), Arc::new(Store::new(path.clone())), connect);
        let s = Setup { hub, env, path, made, vault };
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
    async fn when_ade_opens_a_gateway_whose_bot_is_gone_stays_off() {
        let dir = std::env::temp_dir().join(format!("ade-gateway-hub-gone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("state.json");
        let vault = Arc::new(MapVault::default());
        let before = setup_with(path.clone(), vault.clone());
        start(&before);
        before.hub.shutdown();

        // The bot's file was deleted while ADE was closed; its token is still there.
        let after = setup_with(path, vault);
        after.env.gone.lock().unwrap().push(BOT.into());
        after.hub.resume();
        assert!(after.made.lock().unwrap().is_empty(), "il gateway di un bot cancellato è ripartito");
        let status = after.hub.status();
        assert!(!status[0].running);
        assert!(status[0].last_error.as_deref().is_some_and(|error| error.contains("non c'è più")), "{:?}", status[0].last_error);
        let log = after.env.log.lock().unwrap();
        assert!(log.iter().any(|line| line.contains("non c'è più") && !line.contains(BOT)), "{log:?}");
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
        s.hub.ack(BOT, Platform::Fake, "c42", "500").unwrap();
        eventually("la posizione salvata", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("501")).await;
        // Made again (a new token, ADE reopened): from where it was.
        s.hub.set_token(BOT, Platform::Fake, "123456789:ALTRO-token-di-prova_ZyXwVuTsRqPoNm").unwrap();
        assert_eq!(s.made.lock().unwrap().last().unwrap().1.as_deref(), Some("501"));
    }

    // Full review 2026-10-06, rust 19: another bot's updates are numbered from elsewhere, and the old position would confirm and drop them.
    #[tokio::test]
    async fn another_bots_token_does_not_inherit_the_position_of_the_old_one() {
        let s = setup("cursor-other-bot");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        *adapter.position.lock().unwrap() = Some("501".into());
        feed.send(Ok(vec![message("500", "c42", "42", "uno")])).unwrap();
        eventually("il messaggio", || s.env.messages.lock().unwrap().len() == 1).await;
        s.hub.ack(BOT, Platform::Fake, "c42", "500").unwrap();
        eventually("la posizione salvata", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("501")).await;
        // The same bot with a new secret (revoked and made again): from where it was.
        s.hub.set_token(BOT, Platform::Fake, "123456789:RUOTATO-token-di-prova_ZyXwVuTsRqPoNm").unwrap();
        assert_eq!(s.made.lock().unwrap().last().unwrap().1.as_deref(), Some("501"));
        // Another bot's token: it starts from nothing.
        s.hub.set_token(BOT, Platform::Fake, "987654321:ALTRO-token-di-prova_ZyXwVuTsRqPoNm").unwrap();
        assert_eq!(s.made.lock().unwrap().last().unwrap().1, None);
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor, None);
    }

    #[tokio::test]
    async fn forgetting_the_token_forgets_the_position() {
        let s = setup("cursor-cleared");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        *adapter.position.lock().unwrap() = Some("501".into());
        feed.send(Ok(vec![message("500", "c42", "42", "uno")])).unwrap();
        eventually("il messaggio", || s.env.messages.lock().unwrap().len() == 1).await;
        s.hub.ack(BOT, Platform::Fake, "c42", "500").unwrap();
        eventually("la posizione salvata", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("501")).await;
        s.hub.clear_token(BOT, Platform::Fake).unwrap();
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor, None);
    }

    #[tokio::test]
    async fn after_the_page_reloads_nothing_is_handed_on_until_it_listens_again() {
        let s = setup("reload");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        *adapter.position.lock().unwrap() = Some("11".into());
        feed.send(Ok(vec![message("10", "c42", "42", "prima del ricaricamento")])).unwrap();
        eventually("il primo messaggio", || s.env.messages.lock().unwrap().len() == 1).await;
        s.hub.ack(BOT, Platform::Fake, "c42", "10").unwrap();
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
        s.hub.ack(BOT, Platform::Fake, "c42", "11").unwrap();
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
    async fn cursor_is_not_saved_until_explicit_gateway_ack_from_page() {
        let s = setup("ack-cursor");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        *adapter.position.lock().unwrap() = Some("501".into());
        feed.send(Ok(vec![message("500", "c42", "42", "uno")])).unwrap();
        eventually("il messaggio emesso", || s.env.messages.lock().unwrap().len() == 1).await;

        // Before ack, cursor MUST NOT be saved to store:
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor, None, "cursor must not be saved before ack");

        // Now page sends ack:
        s.hub.ack(BOT, Platform::Fake, "c42", "500").expect("ack riuscito");
        eventually("la posizione salvata dopo ack", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("501")).await;
    }

    #[tokio::test]
    async fn unacknowledged_messages_are_redelivered_after_page_reloads() {
        let s = setup("reemit-after-reload");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        *adapter.position.lock().unwrap() = Some("501".into());
        feed.send(Ok(vec![message("500", "c42", "42", "prima del ricaricamento")])).unwrap();
        eventually("il primo messaggio emesso", || s.env.messages.lock().unwrap().len() == 1).await;
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor, None);

        // Page reloads without sending ack:
        s.hub.unready();
        tokio::time::sleep(Duration::from_millis(30)).await;
        // Now page comes back ready:
        s.hub.ready();

        // The unacknowledged message MUST be re-emitted in order:
        eventually("il messaggio riemesso", || s.env.messages.lock().unwrap().len() == 2).await;
        assert_eq!(s.env.messages.lock().unwrap()[1].id, "500");
        assert_eq!(s.env.messages.lock().unwrap()[1].chat, "c42");
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor, None);

        // Mismatched chat or unknown id does not save cursor:
        s.hub.ack(BOT, Platform::Fake, "other-chat", "500").unwrap();
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor, None);
        s.hub.ack(BOT, Platform::Fake, "c42", "unknown-id").unwrap();
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor, None);

        s.hub.ack(BOT, Platform::Fake, "c42", "500").expect("ack riuscito");
        eventually("la posizione salvata dopo ack", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("501")).await;
    }

    #[tokio::test]
    async fn ack_only_saves_a_cursor_ahead_of_existing_cursor() {
        let s = setup("cursor-monotonic");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        // Pretend store already has cursor 501:
        s.hub.store.update(BOT, Platform::Fake, |link, _| {
            link.cursor = Some("501".into());
            Ok(())
        }).unwrap();

        // Feed message with older cursor 500:
        *adapter.position.lock().unwrap() = Some("500".into());
        feed.send(Ok(vec![message("499", "c42", "42", "vecchio")])).unwrap();
        eventually("il messaggio emesso", || s.env.messages.lock().unwrap().len() == 1).await;

        s.hub.ack(BOT, Platform::Fake, "c42", "499").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;

        // An older cursor must NOT overwrite a newer cursor:
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref(), Some("501"));

        // Feed message with newer cursor 502:
        *adapter.position.lock().unwrap() = Some("502".into());
        feed.send(Ok(vec![message("501", "c42", "42", "nuovo")])).unwrap();
        eventually("il secondo messaggio emesso", || s.env.messages.lock().unwrap().len() == 2).await;

        s.hub.ack(BOT, Platform::Fake, "c42", "501").unwrap();
        eventually("il cursore avanzato", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("502")).await;
    }

    #[tokio::test]
    async fn ack_only_removes_that_message_and_cursor_only_advances_when_preceding_are_confirmed() {
        let s = setup("sliding-window-ack");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);

        feed.send(Ok(vec![
            Inbound { cursor: Some("101".into()), ..message("100", "c42", "42", "primo") },
            Inbound { cursor: Some("103".into()), ..message("102", "c42", "42", "secondo") },
        ])).unwrap();
        eventually("due messaggi emessi", || s.env.messages.lock().unwrap().len() == 2).await;

        // Acknowledging the second message while the first is unacknowledged:
        s.hub.ack(BOT, Platform::Fake, "c42", "102").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;

        // The cursor must NOT advance to 103 yet, because message 100 before it is unconfirmed:
        assert_eq!(s.hub.store.link(BOT, Platform::Fake).unwrap().cursor, None);

        // Page reloads:
        s.hub.unready();
        tokio::time::sleep(Duration::from_millis(30)).await;
        s.hub.ready();

        // Only message 100 was unacknowledged, so only message 100 is re-emitted (total 3 messages):
        eventually("solo il primo riemesso", || s.env.messages.lock().unwrap().len() == 3).await;
        assert_eq!(s.env.messages.lock().unwrap()[2].id, "100");

        // Now acknowledge the first message:
        s.hub.ack(BOT, Platform::Fake, "c42", "100").unwrap();
        // Since both 100 and 102 are now confirmed, cursor advances to 103:
        eventually("il cursore avanza a 103", || s.hub.store.link(BOT, Platform::Fake).unwrap().cursor.as_deref() == Some("103")).await;
    }

    #[tokio::test]
    async fn a_message_sent_while_ade_was_closed_is_marked_as_recovered() {
        let s = setup("recovered-notice");
        authorize(&s, "42");
        s.env.later.store(100_000, std::sync::atomic::Ordering::SeqCst);
        let (_adapter, feed) = start(&s);

        // A message timestamped earlier than start:
        let old_msg = Inbound {
            timestamp_ms: Some(50_000),
            ..message("1", "c42", "42", "mentre ADE era chiusa")
        };
        // A live message timestamped after start:
        let live_msg = Inbound {
            timestamp_ms: Some(150_000),
            ..message("2", "c42", "42", "in diretta")
        };
        feed.send(Ok(vec![old_msg, live_msg])).unwrap();
        eventually("due messaggi emessi", || s.env.messages.lock().unwrap().len() == 2).await;

        let messages = s.env.messages.lock().unwrap().clone();
        assert!(messages[0].recovered, "il messaggio prima dell'avvio deve essere contrassegnato come recuperato");
        assert!(!messages[1].recovered, "il messaggio dopo l'avvio non deve essere contrassegnato come recuperato");
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

    /* ── the link or QR (scelta 3) ─────────────────────────────────────── */

    #[test]
    fn the_token_of_a_link_is_read_out_of_a_start_command_and_nothing_else() {
        let token = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
        assert_eq!(link_token_of(&format!("/start {token}")), Some(token));
        assert_eq!(link_token_of(&format!("  /start   {token}\n")), Some(token));
        assert_eq!(link_token_of(&format!("/start@mio_bot {token}")), Some(token));
        for text in [
            "/start",
            "/start ",
            "/start ciao",
            "/start@mio_bot",
            &format!("/starting {token}"),
            &format!("start {token}"),
            &format!("/start {token} altro"),
            &format!("ecco /start {token}"),
            token,
        ] {
            assert_eq!(link_token_of(text), None, "{text:?}");
        }
    }

    fn token_of(s: &Setup) -> String {
        s.hub.issue_link_token(BOT, Platform::Fake).unwrap().0
    }

    #[tokio::test]
    async fn the_link_pairs_the_owner_who_opens_it_without_a_code_and_the_token_is_nowhere() {
        let s = setup("link-pairs");
        let (adapter, feed) = start(&s);
        let token = token_of(&s);
        feed.send(Ok(vec![message("1", "c7", "7", &format!("/start {token}"))])).unwrap();
        eventually("l'abbinamento", || s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.iter().any(|a| a.id == "7")).await;
        // The same answer as a right code, and no code was made.
        eventually("la conferma", || adapter.sent.lock().unwrap().len() == 1).await;
        assert_eq!(adapter.sent.lock().unwrap()[0], ("c7".to_string(), PAIRED_MESSAGE.to_string()));
        assert!(s.env.pairings.lock().unwrap().is_empty());
        assert!(s.env.messages.lock().unwrap().is_empty(), "the token is not a message for the page");
        // From now on their messages arrive and ADE can answer them.
        feed.send(Ok(vec![message("2", "c7", "7", "eccomi")])).unwrap();
        eventually("il messaggio arriva", || s.env.messages.lock().unwrap().len() == 1).await;
        assert_eq!(s.env.messages.lock().unwrap()[0].text, "eccomi");
        s.hub.send(BOT, Platform::Fake, "c7", "benvenuto").await.unwrap();
        // The token is in no log, no saved state and no event.
        let saved = std::fs::read_to_string(&s.path).unwrap();
        let log = s.env.log.lock().unwrap().join("\n");
        let events = serde_json::to_string(&*s.env.messages.lock().unwrap()).unwrap();
        for (place, text) in [("stato", &saved), ("log", &log), ("eventi", &events)] {
            assert!(!text.contains(&token), "il token in {place}: {text}");
        }
        assert!(log.contains("abbinamento fatto con il link"), "{log}");
        // Used once: the same link from another account is a wrong one (and silence now: someone is in).
        feed.send(Ok(vec![message("3", "c9", "9", &format!("/start {token}"))])).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.iter().any(|a| a.id == "9"));
    }

    #[tokio::test]
    async fn a_link_in_a_group_or_a_channel_is_worth_nothing_and_counts_for_nothing() {
        let s = setup("link-group");
        let (adapter, feed) = start(&s);
        let token = token_of(&s);
        let group = Inbound { private: false, mentioned: true, ..message("1", "gruppo9", "9", &format!("/start {token}")) };
        feed.send(Ok(vec![group])).unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        let list = s.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert!(list.authorized.is_empty() && list.pending.is_empty());
        assert!(adapter.sent.lock().unwrap().is_empty(), "no code and no answer in a channel");
        let state = s.hub.store.link(BOT, Platform::Fake).unwrap();
        assert!(state.pairing.link.is_some(), "the token is still there for the owner's phone");
        // And the owner's own private chat still works with it.
        feed.send(Ok(vec![message("2", "c7", "7", &format!("/start {token}"))])).unwrap();
        eventually("l'abbinamento", || s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.iter().any(|a| a.id == "7")).await;
    }

    #[tokio::test]
    async fn an_expired_token_is_told_it_no_longer_holds_and_the_stranger_gets_the_code_as_before() {
        let s = setup("link-expired");
        let (adapter, feed) = start(&s);
        let token = token_of(&s);
        s.env.later.store(authz::LINK_TTL_MS, std::sync::atomic::Ordering::SeqCst);
        feed.send(Ok(vec![message("1", "c7", "7", &format!("/start {token}"))])).unwrap();
        // Expired: not paired; they are told, and then the code that is the way in when the link does not work arrives.
        eventually("l'avviso e il codice di riserva", || adapter.sent.lock().unwrap().len() == 2).await;
        assert_eq!(adapter.sent.lock().unwrap()[0], ("c7".to_string(), LINK_STALE_MESSAGE.to_string()));
        let code = code_sent_to(&adapter, "c7");
        assert!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.is_empty());
        // The typed code is unaffected, and has all its attempts.
        assert_eq!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().attempts_left, 5);
        s.hub.pairing_approve(BOT, Platform::Fake, &code).await.unwrap();
    }

    #[tokio::test]
    async fn ten_wrong_starts_of_a_stranger_leave_the_owner_qr_and_the_limits_of_the_codes_as_they_were() {
        let s = setup("link-ten-wrong");
        let (adapter, feed) = start(&s);
        let token = token_of(&s);
        for round in 0..10 {
            let wrong = format!("{:0>width$}", round, width = authz::LINK_TOKEN_LEN);
            feed.send(Ok(vec![message(&format!("w{round}"), "c9", "9", &format!("/start {wrong}"))])).unwrap();
        }
        eventually("l'avviso", || adapter.sent.lock().unwrap().iter().any(|(to, text)| to == "c9" && text == LINK_STALE_MESSAGE)).await;
        tokio::time::sleep(Duration::from_millis(60)).await;
        // Told once, not ten times; none counted: the codes have all their attempts and nothing is locked.
        let told = adapter.sent.lock().unwrap().iter().filter(|(to, text)| to == "c9" && text == LINK_STALE_MESSAGE).count();
        assert_eq!(told, 1);
        let list = s.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert_eq!(list.attempts_left, 5);
        assert!(list.locked_until_ms.is_none());
        assert!(list.authorized.is_empty());
        // The stranger is no one: no message reached the page, and the live token is the one ADE made.
        assert!(s.env.messages.lock().unwrap().is_empty());
        assert!(s.hub.store.link(BOT, Platform::Fake).unwrap().pairing.link.is_some());
        // And the owner's phone, opening the same QR now, pairs.
        feed.send(Ok(vec![message("o1", "c7", "7", &format!("/start {token}"))])).unwrap();
        eventually("l'abbinamento del proprietario", || {
            s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.iter().any(|a| a.id == "7")
        })
        .await;
        assert!(!s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.iter().any(|a| a.id == "9"));
        // The log has the facts and not one token.
        let log = s.env.log.lock().unwrap().join("\n");
        assert!(!log.contains(&token), "{log}");
    }

    #[tokio::test]
    async fn with_no_link_made_a_wrong_token_gets_what_any_stranger_gets_and_nothing_is_written() {
        let s = setup("link-none-made");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        let before = std::fs::read_to_string(&s.path).unwrap();
        for round in 0..5 {
            let wrong = format!("{:0>width$}", round, width = authz::LINK_TOKEN_LEN);
            feed.send(Ok(vec![message(&format!("w{round}"), "c9", "9", &format!("/start {wrong}"))])).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(80)).await;
        // Someone is in and no pairing is open: silence, nothing that says the bot is there, and the file is untouched.
        assert!(adapter.sent.lock().unwrap().is_empty(), "{:?}", adapter.sent.lock().unwrap());
        assert!(s.env.pairings.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(&s.path).unwrap(), before);
    }

    #[tokio::test]
    async fn a_dead_link_is_told_only_within_an_hour_of_the_last_one_made() {
        let s = setup("link-hour");
        authorize(&s, "42");
        let token = token_of(&s);
        s.env.later.store(authz::LINK_STALE_MS + 1, std::sync::atomic::Ordering::SeqCst);
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c9", "9", &format!("/start {token}"))])).unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(adapter.sent.lock().unwrap().is_empty(), "an hour on, the dead link gets silence: {:?}", adapter.sent.lock().unwrap());
    }

    #[tokio::test]
    async fn the_panel_is_told_which_account_the_link_paired_not_which_one_appeared() {
        let s = setup("link-linked-by");
        let (adapter, feed) = start(&s);
        let token = token_of(&s);
        assert_eq!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().linked_by, None);
        // Another account is approved with a code first; it is not the link's.
        feed.send(Ok(vec![message("1", "c8", "8", "io")])).unwrap();
        eventually("il codice", || adapter.sent.lock().unwrap().len() == 1).await;
        let code = code_sent_to(&adapter, "c8");
        s.hub.pairing_approve(BOT, Platform::Fake, &code).await.unwrap();
        assert_eq!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().linked_by, None);
        feed.send(Ok(vec![message("2", "c7", "7", &format!("/start {token}"))])).unwrap();
        eventually("l'abbinamento", || s.hub.pairing_list(BOT, Platform::Fake).unwrap().linked_by.as_deref() == Some("7")).await;
        let list = s.hub.pairing_list(BOT, Platform::Fake).unwrap();
        assert!(list.authorized.iter().any(|a| a.id == "8") && list.authorized.iter().any(|a| a.id == "7"));
        // The id says nothing a token could be made of.
        let saved = std::fs::read_to_string(&s.path).unwrap();
        assert!(!saved.contains(&token));
        // A new link forgets it.
        token_of(&s);
        assert_eq!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().linked_by, None);
    }

    #[tokio::test]
    async fn a_plain_start_from_a_stranger_does_what_it_always_did() {
        let s = setup("link-plain-start");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c7", "7", "/start")])).unwrap();
        eventually("il codice", || adapter.sent.lock().unwrap().len() == 1).await;
        assert_eq!(code_sent_to(&adapter, "c7").len(), 9);
    }

    #[tokio::test]
    async fn the_token_from_someone_already_paired_is_not_a_message_and_is_not_spent() {
        let s = setup("link-already");
        let (adapter, feed) = start(&s);
        authorize(&s, "7");
        let token = token_of(&s);
        feed.send(Ok(vec![message("1", "c7", "7", &format!("/start {token}"))])).unwrap();
        eventually("la conferma", || adapter.sent.lock().unwrap().len() == 1).await;
        assert_eq!(adapter.sent.lock().unwrap()[0].1, PAIRED_MESSAGE);
        assert!(s.env.messages.lock().unwrap().is_empty(), "the token never reaches the page's thread");
        assert!(s.hub.store.link(BOT, Platform::Fake).unwrap().pairing.link.is_some(), "not spent");
        let log = s.env.log.lock().unwrap().join("\n");
        assert!(!log.contains(&token), "{log}");
    }

    #[tokio::test]
    async fn a_cancelled_link_pairs_nobody_even_with_the_right_token() {
        let s = setup("link-cancelled");
        let (adapter, feed) = start(&s);
        let token = token_of(&s);
        s.hub.pairing_link_cancel(BOT, Platform::Fake).unwrap();
        // Cancelling again, or when there is none, is no error.
        s.hub.pairing_link_cancel(BOT, Platform::Fake).unwrap();
        feed.send(Ok(vec![message("1", "c7", "7", &format!("/start {token}"))])).unwrap();
        eventually("l'avviso", || adapter.sent.lock().unwrap().iter().any(|(_, text)| text == LINK_STALE_MESSAGE)).await;
        assert!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.is_empty());
        let log = s.env.log.lock().unwrap().join("\n");
        assert!(!log.contains(&token), "{log}");
    }

    #[tokio::test]
    async fn only_telegram_has_a_link_and_a_new_one_cancels_the_old() {
        let s = setup("link-platforms");
        for platform in [Platform::Discord, Platform::Slack, Platform::Fake] {
            let error = s.hub.pairing_link(BOT, platform).await.unwrap_err();
            assert!(error.contains("solo per Telegram") && error.contains("codice"), "{error}");
        }
        assert!(s.hub.store.link(BOT, Platform::Discord).is_none_or(|link| link.pairing.link.is_none()));
        let old = token_of(&s);
        let new = token_of(&s);
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c7", "7", &format!("/start {old}"))])).unwrap();
        // Told the link no longer holds, then the code that is the reserve.
        eventually("l'avviso e il codice di riserva", || adapter.sent.lock().unwrap().len() == 2).await;
        assert!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.is_empty(), "the old token is dead");
        feed.send(Ok(vec![message("2", "c7", "7", &format!("/start {new}"))])).unwrap();
        eventually("l'abbinamento", || s.hub.pairing_list(BOT, Platform::Fake).unwrap().authorized.iter().any(|a| a.id == "7")).await;
    }

    #[test]
    fn the_debug_of_a_link_does_not_print_the_token() {
        let link = PairingLink { url: "https://t.me/mio_bot?start=SEGRETO".into(), svg: "<svg>SEGRETO</svg>".into(), expires_ms: 5 };
        assert!(!format!("{link:?}").contains("SEGRETO"));
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

    /* S12 (review of the bots): a request whose code could not be sent is taken back. */
    #[tokio::test]
    async fn a_code_that_could_not_be_sent_leaves_no_request_and_the_stranger_may_write_again() {
        let s = setup("undo-send");
        let (adapter, feed) = start(&s);
        adapter.fail_sends.store(true, std::sync::atomic::Ordering::SeqCst);
        feed.send(Ok(vec![message("1", "c7", "7", "io")])).unwrap();
        eventually("il tentativo", || adapter.send_attempts.load(std::sync::atomic::Ordering::SeqCst) == 1).await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().pending.is_empty(), "una richiesta senza un codice mandato");
        assert!(s.env.pairings.lock().unwrap().is_empty());
        // The chat answers again: the same stranger gets a code at once, not after ten minutes.
        adapter.fail_sends.store(false, std::sync::atomic::Ordering::SeqCst);
        feed.send(Ok(vec![message("2", "c7", "7", "di nuovo")])).unwrap();
        eventually("il codice", || adapter.sent.lock().unwrap().len() == 1).await;
        assert_eq!(s.hub.pairing_list(BOT, Platform::Fake).unwrap().pending.len(), 1);
    }

    #[tokio::test]
    async fn when_pending_queue_reaches_cap_messages_are_dropped_and_logged() {
        let s = setup("pending-cap");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        {
            let links = s.hub.links();
            let running = links.get(&(BOT.to_string(), Platform::Fake)).unwrap();
            let mut pending = running.pending.lock().unwrap();
            for i in 0..PENDING_CAP {
                pending.push_back(PendingEntry {
                    msg: GatewayMessage {
                        bot: BOT.to_string(),
                        platform: Platform::Fake,
                        chat: "c42".into(),
                        sender: MessageSender { id: "42".into(), name: "utente".into() },
                        text: format!("msg {i}"),
                        id: format!("m{i}"),
                        redacted: false,
                        button: false,
                        private: true,
                        recovered: false,
                    },
                    cursor: None,
                    acked: false,
                });
            }
        }
        feed.send(Ok(vec![message("overflow", "c42", "42", "troppo")])).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let links = s.hub.links();
        let running = links.get(&(BOT.to_string(), Platform::Fake)).unwrap();
        assert_eq!(running.pending.lock().unwrap().len(), PENDING_CAP);
        let logs = s.env.log.lock().unwrap();
        assert!(logs.iter().any(|line| line.contains("coda dei messaggi in attesa piena") && line.contains("messaggio scartato")));
    }

    #[tokio::test]
    async fn unacknowledged_messages_are_saved_to_disk_and_redelivered_on_restart() {
        let s = setup("disk-pending");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c42", "42", "salvami")])).unwrap();
        eventually("il messaggio consegnato", || s.env.messages.lock().unwrap().len() == 1).await;

        let pending_path = pending_file_path(s.hub.store.path(), BOT, Platform::Fake);
        assert!(pending_path.exists(), "il file delle consegne pendenti su disco deve esistere");
        let content = std::fs::read_to_string(&pending_path).unwrap();
        assert!(content.contains("salvami"), "il file deve contenere il messaggio salvato");

        // Chiudiamo il primo hub senza mandare l'ack
        s.hub.shutdown();

        // Riapriamo ADE con lo stesso archivio e lo stesso portachiavi
        let again = setup_vault(s.path.clone(), s.vault.clone());
        again.hub.unready();
        again.hub.resume();

        // Finché la pagina non è pronta, nessun messaggio viene riemesso
        assert!(again.env.messages.lock().unwrap().is_empty());

        // La pagina dice ready: il messaggio viene riemesso con recovered = true
        again.hub.ready();
        eventually("il messaggio recuperato", || again.env.messages.lock().unwrap().len() == 1).await;
        let recovered_msg = &again.env.messages.lock().unwrap()[0];
        assert_eq!(recovered_msg.text, "salvami");
        assert!(recovered_msg.recovered, "il messaggio riemesso deve avere recovered = true");

        // Mandiamo l'ack dal frontend: il file su disco deve essere rimosso
        again.hub.ack(BOT, Platform::Fake, "c42", "1").unwrap();
        assert!(!pending_path.exists(), "il file pendente deve essere rimosso dopo l'ack di tutti i messaggi");
    }

    #[tokio::test]
    async fn disk_pending_cap_drops_oldest_messages_with_log() {
        let s = setup("disk-pending-cap");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);

        // Inviamo 205 messaggi
        let batch: Vec<Inbound> = (0..205)
            .map(|i| message(&format!("m{i}"), "c42", "42", &format!("testo {i}")))
            .collect();
        feed.send(Ok(batch)).unwrap();

        eventually("tutti i 205 messaggi consegnati", || s.env.messages.lock().unwrap().len() == 205).await;

        let pending_path = pending_file_path(s.hub.store.path(), BOT, Platform::Fake);
        assert!(pending_path.exists());
        let entries = read_pending_file(&pending_path);
        assert_eq!(entries.len(), DISK_PENDING_CAP, "su disco devono rimanere solo DISK_PENDING_CAP ({DISK_PENDING_CAP}) messaggi");
        // I primi 5 (più vecchi) devono essere stati eliminati
        assert_eq!(entries.first().unwrap().msg.id, "m5");
        assert_eq!(entries.last().unwrap().msg.id, "m204");

        let logs = s.env.log.lock().unwrap();
        assert!(logs.iter().any(|line| {
            line.contains("registro delle consegne su disco ha superato il tetto (200)") && line.contains("eliminati 5 messaggi più vecchi")
        }));
        // Nessun log deve contenere il testo dei messaggi
        assert!(!logs.iter().any(|line| line.contains("testo ")));
    }

    #[tokio::test]
    async fn forgetting_the_token_or_bot_removes_pending_file() {
        let s = setup("disk-pending-clear");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c42", "42", "da cancellare")])).unwrap();
        eventually("consegnato", || s.env.messages.lock().unwrap().len() == 1).await;

        let pending_path = pending_file_path(s.hub.store.path(), BOT, Platform::Fake);
        assert!(pending_path.exists());

        // clear_token cancella il file pendente
        s.hub.clear_token(BOT, Platform::Fake).unwrap();
        assert!(!pending_path.exists(), "clear_token deve cancellare il file pendente");

        // Ripristiniamo e inviamo un altro messaggio
        s.hub.set_token(BOT, Platform::Fake, TOKEN).unwrap();
        s.hub.start(BOT, Platform::Fake, "C:/progetto").unwrap();
        let (_adapter2, feed2) = last_made(&s);
        feed2.send(Ok(vec![message("2", "c42", "42", "da cancellare con forget")])).unwrap();
        eventually("secondo messaggio", || s.env.messages.lock().unwrap().len() == 2).await;
        assert!(pending_path.exists());

        // forget_bot cancella il file pendente
        s.hub.forget_bot(BOT).unwrap();
        assert!(!pending_path.exists(), "forget_bot deve cancellare il file pendente");
    }

    #[tokio::test]
    async fn messages_with_same_chat_and_id_are_deduplicated_in_deliver() {
        let s = setup("dedup-deliver");
        authorize(&s, "42");
        let (_adapter, feed) = start(&s);
        feed.send(Ok(vec![message("100", "c42", "42", "prima volta")])).unwrap();
        eventually("primo messaggio", || s.env.messages.lock().unwrap().len() == 1).await;

        // Invio dello stesso messaggio (stessa chat e stesso id) mentre è ancora in pending
        feed.send(Ok(vec![message("100", "c42", "42", "duplicato")])).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Deve essere scartato: messages rimane a 1
        assert_eq!(s.env.messages.lock().unwrap().len(), 1, "il duplicato con stesso chat e id deve essere scartato");
        let logs = s.env.log.lock().unwrap();
        assert!(logs.iter().any(|line| line.contains("ignorato un messaggio già in coda")));
    }

    #[tokio::test]
    async fn preview_forwards_redacted_text_to_adapter() {
        let s = setup("preview-hub");
        authorize(&s, "42");
        let (adapter, feed) = start(&s);
        feed.send(Ok(vec![message("1", "c42", "42", "ciao")])).unwrap();
        eventually("il messaggio arriva", || s.env.messages.lock().unwrap().len() == 1).await;
        s.hub.preview(BOT, Platform::Fake, "c42", "anteprima parziale").await.unwrap();
        let previews = adapter.previews.lock().unwrap();
        assert_eq!(*previews, vec![("c42".to_string(), "anteprima parziale".to_string())]);
    }
}
