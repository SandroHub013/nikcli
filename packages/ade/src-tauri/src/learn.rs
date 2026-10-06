//! The learner's progress for «Impara»: one JSON document in the app's local data, per user and not per project.
//!
//! The lesson page runs in a frame with an opaque origin, so it has no `localStorage` of its own and can write no file. What it keeps
//! travels on the port it was given, and these two commands are what is done with it: `learn_progress_get` when the panel opens, and
//! `learn_progress_set` each time an exercise is answered. Nothing else about ADE is reachable from here.
//!
//! What makes it a document and not a scratch file:
//!
//! - **A ceiling.** `MAX_PROGRESS_BYTES` of JSON. A progress is XP, days and a record per exercise; a bigger one is not a progress.
//! - **JSON, or nothing.** A value that does not parse is refused, so a document that was damaged is never overwritten by a value
//!   read out of it.
//! - **A rename, not a write.** The document goes to `progress.json.part` and is renamed over the old one, so a reader sees the old
//!   progress or the new one and never half of one, and a write that dies leaves the last good document where it was.
//! - **The version is ADE's to read.** The file says which shape it is (`{"v": 1, …}`) and the host checks it before writing
//!   (`src/nikverse/learn/page/learn.js`, `isProgress`), because an older or a newer document is not something to write over.
//!
//! **It is the user's data.** `learn/` is in the app's local data folder, next to the sessions and the settings, and a normal
//! uninstall leaves it: `--clean-caches` takes the voices, NikVerse's assets and the plugins' files, never this
//! (`uninstall.rs`). Only Tauri's own «elimina i dati» takes it, with everything else of the folder.

use crate::plugin_install::main_only;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// The folder of the learner's own data, under the app's local data.
pub const PROGRESS_DIR: &str = "learn";

/// The document inside it.
pub const PROGRESS_FILE: &str = "progress.json";

/// The staging file of a write: the document goes here first and is renamed over the old one.
pub const PROGRESS_PART: &str = "progress.json.part";

/// The most the document may weigh, in bytes. A progress of a few hundred exercises stays far under it.
pub const MAX_PROGRESS_BYTES: u64 = 256 * 1024;

/// The shape the document is in. The page refuses to write anything else (`isProgress`).
pub const PROGRESS_VERSION: i64 = 1;

/// Where the document is, given the app's local data folder.
pub fn progress_file(local: &Path) -> PathBuf {
    local.join(PROGRESS_DIR).join(PROGRESS_FILE)
}

/// The learner's progress, or `null` when there is none yet: a file that is not there is not an error, it is a first day.
pub fn get(local: &Path) -> Result<Value, String> {
    let file = progress_file(local);
    match std::fs::metadata(&file) {
        // The size first: a file that grew outside is refused without reading it into memory.
        Ok(meta) if meta.len() > MAX_PROGRESS_BYTES => Err(format!(
            "i progressi pesano {} byte: il tetto è {MAX_PROGRESS_BYTES}",
            meta.len()
        )),
        Ok(_) => {
            let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|_| "i progressi non sono JSON".to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

/// Replaces the progress with `json`, which must be JSON and no bigger than the ceiling.
pub fn set(local: &Path, json: &str) -> Result<(), String> {
    if json.len() as u64 > MAX_PROGRESS_BYTES {
        return Err(format!("i progressi pesano {} byte: il tetto è {MAX_PROGRESS_BYTES}", json.len()));
    }
    serde_json::from_str::<Value>(json).map_err(|_| "il valore non è JSON".to_string())?;
    let dir = local.join(PROGRESS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let part = dir.join(PROGRESS_PART);
    std::fs::write(&part, json).map_err(|e| e.to_string())?;
    std::fs::rename(&part, dir.join(PROGRESS_FILE)).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        e.to_string()
    })
}

#[tauri::command]
pub async fn learn_progress_get(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<Value, String> {
    main_only(window.label())?;
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || get(&dir)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn learn_progress_set(window: tauri::WebviewWindow, app: tauri::AppHandle, json: String) -> Result<(), String> {
    main_only(window.label())?;
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || set(&dir, &json)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A local data folder of its own under the temp dir, gone when the test ends.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Scratch {
            static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!("ade-learn-{tag}-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).expect("cartella di prova");
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn progress() -> String {
        r#"{"v":1,"xp":120,"giorni":["2026-10-05","2026-10-06"],"esercizi":{"l01-e01":{"viste":3,"giuste":2,"intervallo":4,"dovuta":"2026-10-10"}}}"#.to_string()
    }

    #[test]
    fn a_learner_who_never_opened_a_lesson_has_no_document_and_no_folder() {
        let scratch = Scratch::new("vuoto");
        assert_eq!(get(&scratch.0).unwrap(), Value::Null);
        assert!(!scratch.0.join(PROGRESS_DIR).exists(), "la lettura non crea la cartella");
    }

    #[test]
    fn what_is_written_comes_back_whole() {
        let scratch = Scratch::new("scritto");
        set(&scratch.0, &progress()).unwrap();
        let letto = get(&scratch.0).unwrap();
        assert_eq!(letto["v"], PROGRESS_VERSION);
        assert_eq!(letto["xp"], 120);
        assert_eq!(letto["giorni"][1], "2026-10-06");
        assert_eq!(letto["esercizi"]["l01-e01"]["dovuta"], "2026-10-10");
        // A value that is not an object is a value: the page reads a progress out of it or starts from the empty one.
        set(&scratch.0, "3").unwrap();
        assert_eq!(get(&scratch.0).unwrap(), serde_json::json!(3));
    }

    #[test]
    fn the_document_is_never_half_written_and_leaves_no_staging_file() {
        let scratch = Scratch::new("atomico");
        set(&scratch.0, r#"{"v":1,"xp":10}"#).unwrap();
        let file = progress_file(&scratch.0);
        assert!(file.is_file());
        assert!(!file.parent().unwrap().join(PROGRESS_PART).exists(), "il file di passaggio è rimasto");
        set(&scratch.0, &progress()).unwrap();
        assert!(!file.parent().unwrap().join(PROGRESS_PART).exists());
        // And what a reader sees is one of the two documents, never a mixture.
        assert_eq!(get(&scratch.0).unwrap()["xp"], 120);
    }

    #[test]
    fn over_the_ceiling_is_refused_and_the_last_good_document_stays() {
        let scratch = Scratch::new("tetto");
        set(&scratch.0, &progress()).unwrap();
        let grande = format!("{{\"v\":1,\"xp\":\"{}\"}}", "a".repeat(MAX_PROGRESS_BYTES as usize));
        let errore = set(&scratch.0, &grande).unwrap_err();
        assert!(errore.contains("tetto"), "{errore}");
        assert_eq!(get(&scratch.0).unwrap()["xp"], 120);
        // Exactly at the ceiling is written: the last byte counts too.
        let guscio = r#"{"v":1,"f":""}"#;
        let al_tetto = format!("{{\"v\":1,\"f\":\"{}\"}}", "a".repeat(MAX_PROGRESS_BYTES as usize - guscio.len()));
        assert_eq!(al_tetto.len() as u64, MAX_PROGRESS_BYTES);
        assert!(set(&scratch.0, &al_tetto).is_ok());
    }

    #[test]
    fn what_is_not_json_is_refused_and_nothing_is_touched() {
        let scratch = Scratch::new("rotto");
        set(&scratch.0, &progress()).unwrap();
        for testo in ["", "{", "undefined", "{'v':1}", "[1,]", "NaN", "{\"v\":1} rubbish"] {
            assert!(set(&scratch.0, testo).is_err(), "{testo:?}");
        }
        assert_eq!(get(&scratch.0).unwrap()["xp"], 120);
        assert!(!progress_file(&scratch.0).parent().unwrap().join(PROGRESS_PART).exists());
    }

    #[test]
    fn a_document_that_was_damaged_or_grew_outside_is_an_error_and_not_a_crash() {
        let scratch = Scratch::new("dannato");
        set(&scratch.0, &progress()).unwrap();
        std::fs::write(progress_file(&scratch.0), b"{non json").unwrap();
        assert!(get(&scratch.0).unwrap_err().contains("JSON"));
        std::fs::write(progress_file(&scratch.0), vec![b' '; MAX_PROGRESS_BYTES as usize + 1]).unwrap();
        assert!(get(&scratch.0).unwrap_err().contains("tetto"));
    }

    #[test]
    fn it_is_the_users_data_and_an_uninstall_leaves_it() {
        let scratch = Scratch::new("utente");
        // The folder as the app leaves it: the voices (a cache) next to `learn/` (the user's).
        let local = scratch.0.join("ai.nikcli.ade");
        std::fs::create_dir_all(local.join("tts")).unwrap();
        std::fs::write(local.join("tts/x"), b"voce").unwrap();
        set(&local, &progress()).unwrap();
        assert!(progress_file(&local).is_file());
        // `clean_caches` takes the voices, the assets and the plugins' files: not this. A normal uninstall must find the progress
        // still there, and only Tauri's «elimina i dati» takes it, with the rest of the folder.
        let done = crate::uninstall::clean_caches(&local);
        assert!(done.failed.is_empty());
        assert!(!local.join("tts").exists(), "le voci sono una cache");
        assert!(progress_file(&local).is_file(), "i progressi sono dati dell'utente");
    }

    #[test]
    fn the_commands_answer_to_the_main_window_and_no_other() {
        let source = include_str!("learn.rs");
        let body = source.split("#[cfg(test)]").next().unwrap();
        let commands: Vec<&str> = body.split("#[tauri::command]").skip(1).collect();
        assert_eq!(commands.len(), 2, "get and set");
        for command in commands {
            let header = command.lines().find(|line| line.contains("pub async fn learn_progress_")).expect("a command follows");
            assert!(header.contains("window: tauri::WebviewWindow"), "{header}");
            let start = command.find("pub async fn learn_progress_").unwrap();
            assert_eq!(command[start..].lines().nth(1).unwrap_or("").trim(), "main_only(window.label())?;", "{header}");
        }
        // Both are in the handler, and neither is a command towards a session.
        let lib = include_str!("lib.rs");
        assert!(lib.contains("learn::learn_progress_get") && lib.contains("learn::learn_progress_set"));
    }
}