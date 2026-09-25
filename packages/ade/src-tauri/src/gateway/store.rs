//! A gateway's state on disk, in the app data folder.
//!
//! Per bot and platform: whether it is on, the project its turns run in (fixed
//! when it was switched on), who may write, the chats they wrote from, where
//! the platform's stream was read up to, and a hash of the token — to refuse
//! the same token on a second bot without keeping the token itself. The token
//! is in the keychain and nowhere else.
//!
//! Written whole to a temporary file and renamed over the old one: a crash
//! mid-write leaves the previous state, never half of one.

use super::adapter::Platform;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct State {
    #[serde(default)]
    pub links: Vec<LinkState>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkState {
    /// The bot's file path, as the Bot section names bots.
    pub bot: String,
    pub platform: Platform,
    #[serde(default)]
    pub enabled: bool,
    /// Where its turns run, chosen when the gateway was switched on.
    #[serde(default)]
    pub project: Option<String>,
    /// SHA-256 of the token, hex. Never the token.
    #[serde(default)]
    pub token_hash: Option<String>,
    #[serde(default)]
    pub authorized: Vec<Authorized>,
    /// Chats an authorized sender wrote from: the only ones a reply may go to.
    #[serde(default)]
    pub chats: Vec<String>,
    /// Where the platform's stream was read up to (Telegram's offset), saved
    /// after the message was handed on.
    #[serde(default)]
    pub cursor: Option<String>,
}

impl LinkState {
    pub fn new(bot: &str, platform: Platform) -> LinkState {
        LinkState {
            bot: bot.into(),
            platform,
            enabled: false,
            project: None,
            token_hash: None,
            authorized: Vec::new(),
            chats: Vec::new(),
            cursor: None,
        }
    }

    pub fn is_authorized(&self, sender: &str) -> bool {
        self.authorized.iter().any(|entry| entry.id == sender)
    }
}

/// Someone who may write to the bot on that platform, by the platform's fixed id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Authorized {
    pub id: String,
    /// The name shown when they were approved; for the panel only.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub added_ms: u64,
}

pub struct Store {
    path: PathBuf,
    /// One writer at a time: two updates at once would each drop the other's change.
    lock: Mutex<()>,
}

impl Store {
    pub fn new(path: PathBuf) -> Store {
        Store { path, lock: Mutex::new(()) }
    }

    /// The state as saved. A missing file is an empty state; so is one that
    /// does not parse — nobody authorized, which is the safe reading.
    pub fn read(&self) -> State {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        read_file(&self.path).unwrap_or_default()
    }

    pub fn link(&self, bot: &str, platform: Platform) -> Option<LinkState> {
        self.read().links.into_iter().find(|link| link.bot == bot && link.platform == platform)
    }

    /// Changes the link for `bot` on `platform` (created if new) and saves.
    /// Refused when the file exists but cannot be read: writing over it would
    /// throw away every approval in it.
    pub fn update<R>(&self, bot: &str, platform: Platform, change: impl FnOnce(&mut LinkState, &[LinkState]) -> Result<R, String>) -> Result<R, String> {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = match read_file(&self.path) {
            Some(state) => state,
            None if self.path.exists() => return Err("lo stato del gateway su disco non si legge: non lo sovrascrivo".into()),
            None => State::default(),
        };
        let index = match state.links.iter().position(|link| link.bot == bot && link.platform == platform) {
            Some(index) => index,
            None => {
                state.links.push(LinkState::new(bot, platform));
                state.links.len() - 1
            }
        };
        let mut link = state.links.remove(index);
        let result = change(&mut link, &state.links);
        state.links.insert(index, link);
        let value = result?;
        write_file(&self.path, &state)?;
        Ok(value)
    }
}

fn read_file(path: &Path) -> Option<State> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_file(path: &Path, state: &State) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("stato del gateway: {e}"))?;
    }
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, text).map_err(|e| format!("stato del gateway: {e}"))?;
    std::fs::rename(&temp, path).map_err(|e| format!("stato del gateway: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ade-gateway-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("gateway").join("state.json")
    }

    #[test]
    fn an_update_survives_a_new_store_on_the_same_file() {
        let path = temp_path("persist");
        let store = Store::new(path.clone());
        store
            .update("C:/p/.nikcli/agent/a.md", Platform::Fake, |link, _| {
                link.enabled = true;
                link.authorized.push(Authorized { id: "42".into(), name: "Ale".into(), added_ms: 1 });
                Ok(())
            })
            .unwrap();
        let again = Store::new(path.clone()).link("C:/p/.nikcli/agent/a.md", Platform::Fake).unwrap();
        assert!(again.enabled);
        assert!(again.is_authorized("42"));
        assert!(!again.is_authorized("43"));
        // Nothing left half-written beside it.
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn a_refused_change_is_not_saved() {
        let path = temp_path("refused");
        let store = Store::new(path.clone());
        let result: Result<(), String> = store.update("b", Platform::Fake, |link, _| {
            link.enabled = true;
            Err("no".into())
        });
        assert!(result.is_err());
        assert!(!path.exists());
    }

    #[test]
    fn an_unreadable_file_means_nobody_authorized_and_is_not_overwritten() {
        let path = temp_path("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "{ non json").unwrap();
        let store = Store::new(path.clone());
        assert!(store.link("b", Platform::Fake).is_none());
        assert!(store.update("b", Platform::Fake, |_, _| Ok(())).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ non json");
    }
}
