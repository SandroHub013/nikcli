//! Each bot's own gateway: the bot, reachable from the chat apps the user set up for it.
//!
//! Rust holds the connection, the token (from the keychain, never sent to the
//! page) and the decision of who may write; the page runs the turn and
//! answers through `gateway_send`. See `hub.rs` for the rules, `adapter.rs`
//! for what a platform provides, `store.rs` for what is kept on disk and
//! `redact.rs` for what never leaves.
//!
//! The platforms' adapters come in their own pieces, Telegram first: until
//! one exists, switching a gateway on for it is refused.

mod adapter;
mod authz;
mod hub;
mod redact;
mod store;

pub use adapter::Platform;
use adapter::Adapter;
use hub::{check_bot, AuthorizedInfo, Env, GatewayMessage, Hub, LinkStatus, PairingInfo, PairingRequest, StatusInfo};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// The hub, made on first use with the app's folders and keychain.
#[derive(Default)]
pub struct Gateway(OnceLock<Arc<Hub>>);

impl Gateway {
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
    fn secrets(&self) -> Vec<String> {
        crate::secrets::values(&self.app)
    }
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
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
    );
    Ok(state.0.get_or_init(|| Arc::new(made)).clone())
}

/// The adapter for `platform`. None exists yet: each comes with its own piece.
fn adapter_for(platform: Platform, _token: &str) -> Result<Arc<dyn Adapter>, String> {
    Err(format!("il gateway per {} non è ancora disponibile", platform.id()))
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
    check_bot(&bot)?;
    let hub = hub(&app)?;
    if !enabled {
        return hub.stop(&bot, platform);
    }
    let token = hub.token(&bot, platform)?.ok_or_else(|| "manca il token del bot per questa piattaforma".to_string())?;
    let adapter = adapter_for(platform, &token)?;
    hub.start(&bot, platform, project.as_deref().unwrap_or_default(), adapter)
}

/// A reply to a chat an authorized sender wrote from; known secrets are taken out first.
#[tauri::command]
pub async fn gateway_send(app: AppHandle, bot: String, platform: Platform, chat: String, text: String) -> Result<String, String> {
    hub(&app)?.send(&bot, platform, &chat, &text).await
}

#[tauri::command]
pub async fn gateway_edit(
    app: AppHandle,
    bot: String,
    platform: Platform,
    chat: String,
    message: String,
    text: String,
) -> Result<(), String> {
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

#[tauri::command]
pub async fn gateway_pairing_reject(app: AppHandle, bot: String, platform: Platform, request: String) -> Result<(), String> {
    hub(&app)?.pairing_reject(&bot, platform, &request)
}
