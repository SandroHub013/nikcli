//! A gateway's state on disk, in the app data folder.
//!
//! Per bot and platform: whether it is on, the project its turns run in (fixed
//! when it was switched on), who may write and who asked to, the chats they
//! wrote from, where the platform's stream was read up to, and a hash of the
//! token — to refuse the same token on a second bot without keeping the token
//! itself. The token is in the keychain and nowhere else.
//!
//! Written whole to a temporary file and renamed over the old one: a crash
//! mid-write leaves the previous state, never half of one.

use super::adapter::Platform;
use super::authz::Pairing;
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
    /// The same for Slack's App-Level Token, the second secret its socket
    /// needs; never set for the other platforms.
    #[serde(default)]
    pub app_token_hash: Option<String>,
    #[serde(default)]
    pub authorized: Vec<Authorized>,
    /// Chats an authorized sender wrote from: the only ones a reply may go to.
    #[serde(default)]
    pub chats: Vec<Chat>,
    /// Where the platform's stream was read up to (Telegram's offset, or a
    /// Discord session), saved after the message was handed on.
    #[serde(default)]
    pub cursor: Option<String>,
    /// When that cursor was written, in epoch milliseconds. A Discord session
    /// cannot be resumed for ever, so the adapter needs to know how old the
    /// session it is handed is and start a new one instead of resuming.
    #[serde(default)]
    pub cursor_saved_ms: Option<u64>,
    /// Strangers' requests waiting for the user, and the limits on them.
    #[serde(default)]
    pub pairing: Pairing,
}

impl LinkState {
    pub fn new(bot: &str, platform: Platform) -> LinkState {
        LinkState {
            bot: bot.into(),
            platform,
            enabled: false,
            project: None,
            token_hash: None,
            app_token_hash: None,
            authorized: Vec::new(),
            chats: Vec::new(),
            cursor: None,
            cursor_saved_ms: None,
            pairing: Pairing::default(),
        }
    }

    pub fn is_authorized(&self, sender: &str) -> bool {
        self.authorized.iter().any(|entry| entry.id == sender)
    }

    /// Whether `sender` is authorized and the owner. A sender who is not authorized is nobody's owner.
    pub fn is_owner(&self, sender: &str) -> bool {
        self.authorized.iter().any(|entry| entry.id == sender && entry.owner)
    }

    pub fn knows_chat(&self, chat: &str) -> bool {
        self.chats.iter().any(|known| known.id == chat)
    }

    /// `chat` may be answered from now on, as long as `sender` stays authorized.
    pub fn remember_chat(&mut self, chat: &str, sender: &str) {
        if !self.chats.iter().any(|known| known.id == chat && known.sender == sender) {
            self.chats.push(Chat { id: chat.into(), sender: sender.into() });
        }
    }
}

/// A chat a reply may go to, and the authorized sender it is there for: revoking
/// them forgets it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Chat {
    pub id: String,
    pub sender: String,
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
    /// The owner of the account the bot runs on: paired from ADE by the person at the computer (D92: so far the only
    /// way anyone is paired). What the page is told with each of their messages (S16). A state saved before this field
    /// held only such accounts, so it reads as true.
    #[serde(default = "is_owner_by_default")]
    pub owner: bool,
}

fn is_owner_by_default() -> bool {
    true
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

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The state as saved. A missing file is an empty state; one that cannot be
    /// parsed is logged, preserved as state.corrupt-<ms>.json, and recovered cleanly as an empty state.
    pub fn read(&self) -> State {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        read_file(&self.path).unwrap_or_default()
    }

    pub fn link(&self, bot: &str, platform: Platform) -> Option<LinkState> {
        self.read().links.into_iter().find(|link| link.bot == bot && link.platform == platform)
    }

    /// Changes the link for `bot` on `platform` (created if new) and saves.
    /// Refused when the file cannot be accessed (I/O error). If unparseable,
    /// it recovers cleanly from an empty state.
    pub fn update<R>(&self, bot: &str, platform: Platform, change: impl FnOnce(&mut LinkState, &[LinkState]) -> Result<R, String>) -> Result<R, String> {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = match read_file(&self.path) {
            Some(state) => state,
            None if self.path.exists() => return Err("lo stato del gateway su disco non si legge: non lo sovrascrivo".into()),
            None => State::default(),
        };
        // What is on disk, to see whether the change made any difference: every message of a stranger came through here
        // and rewrote the file whether or not it had (full review 2026-10-06, rust minor).
        let before = serde_json::to_string(&state).ok();
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
        if before.is_some() && serde_json::to_string(&state).ok() == before {
            return Ok(value);
        }
        write_file(&self.path, &state)?;
        Ok(value)
    }
}

impl Store {
    /// Takes away every link of `bot`, with who was authorized and the chats
    /// it knew. Refused, like `update`, when the file cannot be read.
    pub fn forget(&self, bot: &str) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut state = match read_file(&self.path) {
            Some(state) => state,
            None if self.path.exists() => return Err("lo stato del gateway su disco non si legge: non lo sovrascrivo".into()),
            None => return Ok(()),
        };
        let before = state.links.len();
        state.links.retain(|link| link.bot != bot);
        if state.links.len() == before {
            return Ok(());
        }
        write_file(&self.path, &state)
    }
}

fn read_file(path: &Path) -> Option<State> {
    if !path.exists() {
        return Some(State::default());
    }
    let raw = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return None,
    };
    match serde_json::from_slice::<State>(&raw) {
        Ok(state) => Some(state),
        Err(error) => {
            let ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let file_name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("state");
            let mut corrupt_path = path.with_file_name(format!("{file_name}.corrupt-{ms}.json"));
            if corrupt_path.exists() {
                let mut counter = 1;
                while corrupt_path.exists() {
                    corrupt_path = path.with_file_name(format!("{file_name}.corrupt-{ms}-{counter}.json"));
                    counter += 1;
                }
            }
            if let Err(rename_err) = std::fs::rename(path, &corrupt_path) {
                eprintln!(
                    "ADE: impossibile mettere da parte lo stato corrotto in {} ({rename_err}): non lo sovrascrivo",
                    corrupt_path.display()
                );
                return None;
            }
            eprintln!(
                "ADE: stato del gateway non interpretabile ({error}), {} byte messi da parte in {}; riparto pulito",
                raw.len(),
                corrupt_path.display()
            );
            Some(State::default())
        }
    }
}

fn write_file(path: &Path, state: &State) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("stato del gateway: {e}"))?;
    }
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temp).map_err(|e| format!("stato del gateway: {e}"))?;
    use std::io::Write;
    file.write_all(text.as_bytes()).map_err(|e| format!("stato del gateway: {e}"))?;
    file.sync_all().map_err(|e| format!("stato del gateway: {e}"))?;
    drop(file);
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

    // Full review 2026-10-06, rust (minor): every message of a stranger rewrote state.json, changed or not.
    #[test]
    fn an_update_that_changes_nothing_writes_nothing() {
        let path = temp_path("unchanged");
        let store = Store::new(path.clone());
        store.update("C:/p/.nikcli/agent/a.md", Platform::Fake, |link, _| {
            link.enabled = true;
            Ok(())
        })
        .unwrap();
        let written = std::fs::metadata(&path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(60));
        store.update("C:/p/.nikcli/agent/a.md", Platform::Fake, |_, _| Ok(())).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), written, "il file è stato riscritto");
        // A real change is still written.
        store
            .update("C:/p/.nikcli/agent/a.md", Platform::Fake, |link, _| {
                link.enabled = false;
                Ok(())
            })
            .unwrap();
        assert!(!Store::new(path).link("C:/p/.nikcli/agent/a.md", Platform::Fake).unwrap().enabled);
    }

    #[test]
    fn an_update_survives_a_new_store_on_the_same_file() {
        let path = temp_path("persist");
        let store = Store::new(path.clone());
        store
            .update("C:/p/.nikcli/agent/a.md", Platform::Fake, |link, _| {
                link.enabled = true;
                link.authorized.push(Authorized { id: "42".into(), name: "Ale".into(), added_ms: 1, owner: true });
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

    fn corrupt_files(dir: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("state.corrupt-") && name.ends_with(".json") {
                        files.push(p);
                    }
                }
            }
        }
        files.sort();
        files
    }

    #[test]
    fn an_unparseable_json_file_is_put_aside_with_timestamp_and_recovers_cleanly() {
        let path = temp_path("corrupt-recover");
        let dir = path.parent().unwrap();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(&path, "{ primo non json").unwrap();
        let store = Store::new(path.clone());
        assert!(store.link("b", Platform::Fake).is_none());

        // A11: Gateway must not halt with an error; it starts clean and allows update:
        store
            .update("b", Platform::Fake, |link, _| {
                link.enabled = true;
                Ok(())
            })
            .expect("lo stato non interpretabile deve ripartire pulito senza fermare il gateway");
        let link = store.link("b", Platform::Fake).expect("il link deve esistere dopo il recupero pulito");
        assert!(link.enabled);

        let corrupt1 = corrupt_files(dir);
        assert_eq!(corrupt1.len(), 1, "un file corrotto messo da parte con timestamp");
        assert_eq!(std::fs::read_to_string(&corrupt1[0]).unwrap(), "{ primo non json");

        // A second unparseable file does not overwrite the first:
        std::fs::write(&path, "{ secondo non json").unwrap();
        let store2 = Store::new(path.clone());
        assert!(store2.link("b", Platform::Fake).is_none());
        store2
            .update("b", Platform::Fake, |link, _| {
                link.enabled = true;
                Ok(())
            })
            .expect("anche il secondo stato non interpretabile riparte pulito");

        let corrupt2 = corrupt_files(dir);
        assert_eq!(corrupt2.len(), 2, "il secondo file corrotto non sovrascrive il primo");
        let contents: Vec<String> = corrupt2.iter().map(|p| std::fs::read_to_string(p).unwrap()).collect();
        assert!(contents.contains(&"{ primo non json".to_string()));
        assert!(contents.contains(&"{ secondo non json".to_string()));
    }

    #[cfg(windows)]
    #[test]
    fn an_io_error_is_not_treated_as_corrupted_and_refuses_to_overwrite() {
        use std::os::windows::fs::OpenOptionsExt;
        let path = temp_path("io-error");
        let dir = path.parent().unwrap();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(&path, r#"{"links":[{"bot":"b","platform":"fake","enabled":true}]}"#).unwrap();

        // Lock the file exclusively to simulate an I/O error (e.g. Defender or sharing violation):
        let locked_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0) // Deny read, write, delete
            .open(&path)
            .unwrap();

        let store = Store::new(path.clone());
        // On I/O error, read returns empty state ("si legge come vuoto"):
        assert!(store.link("b", Platform::Fake).is_none());

        // And update refuses to write ("e si rifiuta di scrivere"):
        let err = store.update("b", Platform::Fake, |link, _| {
            link.enabled = false;
            Ok(())
        });
        assert!(err.is_err(), "l'aggiornamento deve essere rifiutato per errore di I/O");

        // No corrupt file was created:
        assert_eq!(corrupt_files(dir).len(), 0, "un errore di I/O non crea state.corrupt-*.json");

        drop(locked_file);
        // After lock is released, original file is intact and readable:
        assert!(store.link("b", Platform::Fake).unwrap().enabled);
    }

    #[cfg(windows)]
    #[test]
    fn if_rename_of_corrupt_file_fails_it_refuses_to_overwrite() {
        let path = temp_path("corrupt-rename-fail");
        let dir = path.parent().unwrap();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(&path, "{ non json").unwrap();

        use std::os::windows::fs::OpenOptionsExt;
        // Holding OpenOptions with share_mode(1) allows reading, but forbids renaming/deleting (no FILE_SHARE_DELETE):
        let open_file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();

        let store = Store::new(path.clone());
        let err = store.update("b", Platform::Fake, |link, _| {
            link.enabled = true;
            Ok(())
        });
        // If rename of corrupt file fails, update MUST fail and refuse to overwrite:
        assert!(err.is_err(), "se il rename fallisce, l'aggiornamento deve essere rifiutato");

        drop(open_file);
        // Original corrupt content was not overwritten:
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ non json");
    }
}
