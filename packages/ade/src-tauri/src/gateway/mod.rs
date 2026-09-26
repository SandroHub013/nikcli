//! Each bot's own gateway: the bot, reachable from the chat apps the user set up for it.
//!
//! Rust holds the connection, the token (from the keychain, never sent to the
//! page) and the decision of who may write; the page runs the turn and
//! answers through `gateway_send`. See `hub.rs` for the rules, `adapter.rs`
//! for what a platform provides, `store.rs` for what is kept on disk and
//! `redact.rs` for what never leaves.
//!
//! Telegram is the first platform (`telegram.rs`, with `chunk.rs` and
//! `markdown_v2.rs`); Discord and Slack come in their own pieces, and until
//! then switching a gateway on for them is refused.

mod adapter;
mod authz;
mod chunk;
mod discord;
mod hub;
mod known;
mod markdown_v2;
mod redact;
mod store;
mod telegram;

pub use adapter::Platform;
use adapter::Adapter;
use hub::{AuthorizedInfo, Env, GatewayMessage, Hub, LinkStatus, PairingInfo, PairingRequest, StatusInfo};
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
    /// The keys in ADE's keychain, nikcli's provider keys and the keys in ADE's environment.
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
    let made = Hub::new(
        Arc::new(AppEnv { app: app.clone() }),
        Arc::new(crate::secrets::SystemVault),
        service,
        Arc::new(store::Store::new(path)),
        Arc::new(adapter_for),
    );
    Ok(state.0.get_or_init(|| Arc::new(made)).clone())
}

/// The adapter for `platform`, reading on from `cursor`. Slack comes in
/// its own piece.
fn adapter_for(platform: Platform, token: &str, cursor: Option<String>) -> Result<Arc<dyn Adapter>, String> {
    match platform {
        Platform::Telegram => Ok(Arc::new(telegram::Telegram::new(token, cursor)?)),
        // `new` already hands back a reference, as the socket task keeps one too.
        Platform::Discord => Ok(discord::Discord::new(token, cursor)? as Arc<dyn Adapter>),
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

/// Saves the bot's token in the keychain. It is never read back by the page.
#[tauri::command]
pub async fn gateway_set_token(app: AppHandle, bot: String, platform: Platform, token: String) -> Result<(), String> {
    hub(&app)?.set_token(&bot, platform, &token)
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
) -> Result<String, String> {
    let hub = hub(&app)?;
    match buttons {
        Some(buttons) => hub.send_buttons(&bot, platform, &chat, &text, &buttons).await,
        None => hub.send(&bot, platform, &chat, &text).await,
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

#[tauri::command]
pub async fn gateway_typing(app: AppHandle, bot: String, platform: Platform, chat: String) -> Result<(), String> {
    hub(&app)?.typing(&bot, platform, &chat).await
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

#[tauri::command]
pub async fn gateway_pairing_reject(app: AppHandle, bot: String, platform: Platform, request: String) -> Result<(), String> {
    hub(&app)?.pairing_reject(&bot, platform, &request)
}
