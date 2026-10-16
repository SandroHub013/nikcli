//! Each bot's own gateway: the bot, reachable from the chat apps the user set up for it.
//!
//! Rust holds the connection, the token (from the keychain, never sent to the
//! page) and the decision of who may write; the page runs the turn and
//! answers through `gateway_send`. See `hub.rs` for the rules, `adapter.rs`
//! for what a platform provides, `store.rs` for what is kept on disk and
//! `redact.rs` for what never leaves.
//!
//! Telegram (`telegram.rs`, with `chunk.rs` and `markdown_v2.rs`), Discord
//! (`discord.rs`) and Slack (`slack.rs`, which needs a second token).

mod adapter;
mod authz;
mod chunk;
mod discord;
mod hub;
pub use hub::forget_all_tokens;
mod known;
mod markdown_v2;
mod pairing_link;
mod redact;
mod slack;
mod store;
mod telegram;

pub use adapter::Platform;
use adapter::Adapter;
use hub::{AuthorizedInfo, Env, GatewayMessage, Hub, LinkStatus, PairingInfo, PairingLink, PairingRequest, StatusInfo, TokenKind, Tokens};
use serde::Deserialize;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// The hub, made on first use with the app's folders and keychain.
#[derive(Default)]
pub struct Gateway(OnceLock<Arc<Hub>>);

impl Gateway {
    /// The main window is loading a page: the old one's listener is gone.
    pub fn page_loading(&self) {
        if let Some(hub) = self.0.get() {
            hub.unready();
        }
    }

    /// Whether any bot's gateway is switched on: closing the window then
    /// leaves ADE in the tray (G11).
    pub fn any_on(&self) -> bool {
        self.0.get().is_some_and(|hub| hub.any_on())
    }

    /// ADE is closing: every gateway's task ends.
    pub fn shutdown(&self) {
        if let Some(hub) = self.0.get() {
            hub.shutdown();
        }
    }
}

struct AppEnv {
    app: AppHandle,
}

impl Env for AppEnv {
    fn message(&self, message: &GatewayMessage) {
        let _ = self.app.emit("gateway:message", message);
    }
    fn pairing(&self, request: &PairingRequest) {
        let _ = self.app.emit("gateway:pairing", request);
    }
    fn status(&self, status: &LinkStatus) {
        let _ = self.app.emit("gateway:status", status);
    }
    fn log(&self, line: &str) {
        eprintln!("ADE: {line}");
    }
    /// The keys in ADE's keychain, ragu's provider keys and the keys in ADE's environment.
    fn secrets(&self) -> Vec<String> {
        let mut values = crate::secrets::values(&self.app);
        values.extend(known::values());
        values
    }
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
    }
    /// The bot is the path of its file (`bot` in every gateway command).
    fn bot_exists(&self, bot: &str) -> bool {
        std::path::Path::new(bot).is_file()
    }
}

/// ADE opened: the hub is made now, and the gateways the user left on start
/// again. Each reads once the page says it listens (`gateway_ready`).
pub fn resume(app: &AppHandle) {
    match hub(app) {
        Ok(hub) => {
            tauri::async_runtime::spawn(async move { hub.resume() });
        }
        Err(error) => eprintln!("ADE: gateway non avviato: {error}"),
    }
}

fn hub(app: &AppHandle) -> Result<Arc<Hub>, String> {
    let state = app.state::<Gateway>();
    if let Some(hub) = state.0.get() {
        return Ok(hub.clone());
    }
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cartella dei dati: {e}"))?
        .join("gateway")
        .join("state.json");
    // Apart from the API keys: a gateway token is never given to an agent.
    let service = format!("{}.gateway", app.config().identifier);
    // An unreadable state put aside is told to the page as it happens, and kept for the page to take at its start.
    let told = app.clone();
    let store = store::Store::new(path).on_set_aside(move |copy| {
        let _ = told.emit("gateway:state-aside", copy.display().to_string());
    });
    let made = Hub::new(
        Arc::new(AppEnv { app: app.clone() }),
        Arc::new(crate::secrets::SystemVault),
        service,
        Arc::new(store),
        Arc::new(adapter_for),
    );
    let hub_arc = Arc::new(made);
    hub::spawn_time_jump_monitor(hub_arc.clone());
    Ok(state.0.get_or_init(|| hub_arc).clone())
}

/// The adapter for `platform`, reading on from `cursor`.
fn adapter_for(platform: Platform, tokens: &Tokens, cursor: Option<String>) -> Result<Arc<dyn Adapter>, String> {
    match platform {
        Platform::Telegram => Ok(Arc::new(telegram::Telegram::new(&tokens.bot, cursor)?)),
        // `new` already hands back a reference, as the socket task keeps one too.
        Platform::Discord => Ok(discord::Discord::new(&tokens.bot, cursor)? as Arc<dyn Adapter>),
        // Slack keeps no position: an event not acknowledged comes again.
        Platform::Slack => Ok(slack::Slack::new(&tokens.bot, tokens.app.as_deref())? as Arc<dyn Adapter>),
        #[cfg(test)]
        other => Err(format!("il gateway per {} non è ancora disponibile", other.id())),
    }
}

/// The page listens for `gateway:message`: the gateways may start reading.
#[tauri::command]
pub async fn gateway_ready(app: AppHandle) -> Result<(), String> {
    hub(&app)?.ready();
    Ok(())
}

#[tauri::command]
pub async fn gateway_status(app: AppHandle) -> Result<Vec<StatusInfo>, String> {
    Ok(hub(&app)?.status())
}

/// Saves the bot's token in the keychain, or with `kind: "app"` Slack's
/// App-Level Token. Neither is ever read back by the page.
#[tauri::command]
pub async fn gateway_set_token(
    app: AppHandle,
    bot: String,
    platform: Platform,
    token: String,
    kind: Option<TokenKind>,
) -> Result<(), String> {
    let hub = hub(&app)?;
    match kind.unwrap_or(TokenKind::Bot) {
        TokenKind::Bot => hub.set_token(&bot, platform, &token),
        TokenKind::App => hub.set_app_token(&bot, platform, &token),
    }
}

/// The panel's «Prova»: the bot's name on the platform, with the saved token.
#[tauri::command]
pub async fn gateway_probe(app: AppHandle, bot: String, platform: Platform) -> Result<String, String> {
    hub(&app)?.probe(&bot, platform).await
}

#[tauri::command]
pub async fn gateway_clear_token(app: AppHandle, bot: String, platform: Platform) -> Result<(), String> {
    hub(&app)?.clear_token(&bot, platform)
}

/// A bot deleted: its gateways, tokens and links go, who was authorized with them.
#[tauri::command]
pub async fn gateway_forget_bot(app: AppHandle, bot: String) -> Result<(), String> {
    hub(&app)?.forget_bot(&bot)
}

/// Switches a bot's gateway on (its turns fixed to `project`) or off.
#[tauri::command]
pub async fn gateway_set_enabled(
    app: AppHandle,
    bot: String,
    platform: Platform,
    enabled: bool,
    project: Option<String>,
) -> Result<(), String> {
    let hub = hub(&app)?;
    if !enabled {
        return hub.stop(&bot, platform);
    }
    hub.start(&bot, platform, project.as_deref().unwrap_or_default())
}

/// A reply to a chat an authorized sender wrote from; known secrets are taken out first.
#[tauri::command]
/// With `buttons`, they go under the last message; a press comes back as a
/// `gateway:message` with `button: true`.
pub async fn gateway_send(
    app: AppHandle,
    bot: String,
    platform: Platform,
    chat: String,
    text: String,
    buttons: Option<Vec<adapter::Button>>,
    final_turn: Option<bool>,
    preview_fallback: Option<String>,
) -> Result<String, String> {
    let hub = hub(&app)?;
    match buttons {
        Some(buttons) => hub.send_buttons(&bot, platform, &chat, &text, &buttons).await,
        None => hub.send_with(&bot, platform, &chat, &text, final_turn.unwrap_or(false), preview_fallback.as_deref()).await,
    }
}

#[tauri::command]
pub async fn gateway_edit(
    app: AppHandle,
    bot: String,
    platform: Platform,
    chat: String,
    message: String,
    text: String,
) -> Result<String, String> {
    hub(&app)?.edit(&bot, platform, &chat, &message, &text).await
}

/// One entry of the menu of commands the page gives: the command with no slash, and what it does, in ADE's language.
#[derive(Deserialize)]
pub struct MenuEntry {
    command: String,
    description: String,
}

/// The menu of commands (`policy.ts`) for the bot's messaging app, once its gateway is running; Telegram shows it
/// next to the message box. The same list is not sent twice.
#[tauri::command]
pub async fn gateway_set_commands(app: AppHandle, bot: String, platform: Platform, commands: Vec<MenuEntry>) -> Result<(), String> {
    let commands: Vec<(String, String)> = commands.into_iter().map(|entry| (entry.command, entry.description)).collect();
    hub(&app)?.set_commands(&bot, platform, &commands).await
}

/// The copies of the gateways' state put aside because it could not be read (`state.corrupt-<ms>.json`) since the page
/// last asked, as paths; emptied. The page says it once. Also sent as `gateway:state-aside` when it happens.
#[tauri::command]
pub fn gateway_state_set_aside(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(hub(&app)?.take_state_set_aside())
}

#[tauri::command]
pub async fn gateway_typing(app: AppHandle, bot: String, platform: Platform, chat: String) -> Result<(), String> {
    hub(&app)?.typing(&bot, platform, &chat).await
}

#[tauri::command]
pub async fn gateway_preview(app: AppHandle, bot: String, platform: Platform, chat: String, text: String) -> Result<(), String> {
    hub(&app)?.preview(&bot, platform, &chat, &text).await
}

#[tauri::command]
pub async fn gateway_preview_end(app: AppHandle, bot: String, platform: Platform, chat: String, fallback: Option<String>) -> Result<(), String> {
    hub(&app)?.preview_end(&bot, platform, &chat, fallback.as_deref()).await
}

/// Who waits to pair, who is paired, and whether wrong codes locked it. Never a code.
#[tauri::command]
pub async fn gateway_pairing_list(app: AppHandle, bot: String, platform: Platform) -> Result<PairingInfo, String> {
    hub(&app)?.pairing_list(&bot, platform)
}

/// The code a stranger got in the chat, typed by the user: the only way to authorize anyone.
#[tauri::command]
pub async fn gateway_pairing_approve(app: AppHandle, bot: String, platform: Platform, code: String) -> Result<AuthorizedInfo, String> {
    hub(&app)?.pairing_approve(&bot, platform, &code).await
}

/// A link and a QR for the owner's phone, good for ten minutes and once (Telegram only; the others keep the code).
/// The token is in the link and the QR the page draws, and nowhere else.
#[tauri::command]
pub async fn gateway_pairing_link(app: AppHandle, bot: String, platform: Platform) -> Result<PairingLink, String> {
    hub(&app)?.pairing_link(&bot, platform).await
}

/// The QR left ADE's screen: its token is cancelled. Nothing to cancel is no error.
#[tauri::command]
pub async fn gateway_pairing_link_cancel(app: AppHandle, bot: String, platform: Platform) -> Result<(), String> {
    hub(&app)?.pairing_link_cancel(&bot, platform)
}

/// Takes an account off the authorized: the bot stops hearing and answering it.
#[tauri::command]
pub async fn gateway_pairing_revoke(app: AppHandle, bot: String, platform: Platform, sender: String) -> Result<(), String> {
    hub(&app)?.pairing_revoke(&bot, platform, &sender)
}

/// Opens pairing for 10 minutes, to add one more account once one is paired.
/// Returns until when, in ms.
#[tauri::command]
pub async fn gateway_pairing_open(app: AppHandle, bot: String, platform: Platform) -> Result<u64, String> {
    hub(&app)?.pairing_open(&bot, platform)
}

/// The manifest of a Slack app for the bot called `name`, to paste in Slack's
/// «Create New App › From a manifest». Its scopes are the ones the probe checks.
#[tauri::command]
pub fn gateway_slack_manifest(name: String) -> String {
    slack::manifest(&name)
}

#[tauri::command]
pub async fn gateway_pairing_reject(app: AppHandle, bot: String, platform: Platform, request: String) -> Result<(), String> {
    hub(&app)?.pairing_reject(&bot, platform, &request)
}

/// The page acknowledged receipt of a message: the cursor can now be advanced in state.json.
#[tauri::command]
pub async fn gateway_ack(app: AppHandle, bot: String, platform: Platform, chat: String, id: String) -> Result<(), String> {
    hub(&app)?.ack(&bot, platform, &chat, &id)
}

/// Wakes all gateways or relaunches them immediately (network restore or system resume).
#[tauri::command]
pub async fn gateway_wake(app: AppHandle) -> Result<(), String> {
    hub(&app)?.wake_all();
    Ok(())
}

/// Retries connecting immediately, resetting backoff if waiting or relaunching if stopped.
#[tauri::command]
pub async fn gateway_retry(app: AppHandle, bot: String, platform: Platform) -> Result<(), String> {
    hub(&app)?.retry(&bot, platform)
}

