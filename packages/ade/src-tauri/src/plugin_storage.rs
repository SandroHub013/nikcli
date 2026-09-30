//! A plugin's own document: `storage.json` in its folder, which ADE reads and writes on the plugin's behalf (`storage.get`, `storage.set`
//! of the plugin API, permission `storage`).
//!
//! A plugin has no other place to keep anything: its frame has an opaque origin, so no `localStorage` of its own survives, and it can write
//! no file. What it keeps is one JSON value, at most `MAX_STORAGE_BYTES`, written to a `.tmp` and renamed over the old one so a reader sees the
//! old document or the new one and never half of one. The id comes from the panel, never from the plugin, and only a plugin that is
//! installed (or under development) has a document: a made-up id makes no folder. It goes with the plugin's folder when it is uninstalled.

use crate::plugin_install::main_only;
use crate::plugin_scheme::{self as scheme, Store};
use serde_json::Value;

/// The file of a plugin's folder that holds its document.
pub const STORAGE_FILE: &str = "storage.json";

/// The most a plugin's document may weigh: the size of its JSON, in bytes.
pub const MAX_STORAGE_BYTES: u64 = 1_000_000;

/// Whether the plugin is one ADE knows: installed with a version to serve, or the one under development.
fn known(store: &Store, id: &str) -> bool {
    store.pointer(id, scheme::CURRENT).is_some()
        || store.pointer(id, scheme::PENDING).is_some()
        || store.dev_plugin().map(|dev| dev.id == id).unwrap_or(false)
}

/// The plugin's document, or `null` when it never wrote one.
pub fn get(store: &Store, id: &str) -> Result<Value, String> {
    let dir = store.plugin_dir(id).ok_or("plugin non valido")?;
    if !known(store, id) {
        return Err("il plugin non è installato".into());
    }
    let file = dir.join(STORAGE_FILE);
    match std::fs::metadata(&file) {
        Ok(meta) if meta.len() > MAX_STORAGE_BYTES => Err("i dati del plugin sono troppo grandi".into()),
        Ok(_) => {
            let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
            serde_json::from_str(&text).map_err(|_| "i dati del plugin non sono JSON".to_string())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

/// Replaces the plugin's document with `json`, which must be JSON and no bigger than the ceiling.
pub fn set(store: &Store, id: &str, json: &str) -> Result<(), String> {
    let dir = store.plugin_dir(id).ok_or("plugin non valido")?;
    if json.len() as u64 > MAX_STORAGE_BYTES {
        return Err(format!("il valore pesa {} byte: il tetto è {MAX_STORAGE_BYTES}", json.len()));
    }
    serde_json::from_str::<Value>(json).map_err(|_| "il valore non è JSON".to_string())?;
    if !known(store, id) {
        return Err("il plugin non è installato".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let temp = dir.join(format!("{STORAGE_FILE}.tmp"));
    std::fs::write(&temp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, dir.join(STORAGE_FILE)).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })
}

#[tauri::command]
pub async fn plugin_storage_get(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String) -> Result<Value, String> {
    main_only(window.label())?;
    tauri::async_runtime::spawn_blocking(move || get(scheme::store(&app), &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plugin_storage_set(window: tauri::WebviewWindow, app: tauri::AppHandle, id: String, json: String) -> Result<(), String> {
    main_only(window.label())?;
    tauri::async_runtime::spawn_blocking(move || set(scheme::store(&app), &id, &json)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_scheme::tests::{install_by_hand, Scratch};

    fn installed() -> (Scratch, Store) {
        let scratch = Scratch::new();
        let store = Store::new(scratch.0.clone());
        install_by_hand(&store, "alpha", "1.0.0", &[("index.html", b"<html></html>")], &["storage"]);
        (scratch, store)
    }

    #[test]
    fn a_plugin_that_never_wrote_has_null() {
        let (_scratch, store) = installed();
        assert_eq!(get(&store, "alpha"), Ok(Value::Null));
    }

    #[test]
    fn what_is_set_comes_back() {
        let (_scratch, store) = installed();
        set(&store, "alpha", r#"{"visto":[1,2,{"a":null}]}"#).unwrap();
        assert_eq!(get(&store, "alpha").unwrap(), serde_json::json!({"visto": [1, 2, {"a": null}]}));
        set(&store, "alpha", "3").unwrap();
        assert_eq!(get(&store, "alpha").unwrap(), serde_json::json!(3));
    }

    #[test]
    fn it_is_written_with_a_rename_and_leaves_no_temp_file() {
        let (scratch, store) = installed();
        set(&store, "alpha", r#"{"a":1}"#).unwrap();
        let dir = scratch.0.join("alpha");
        assert!(dir.join(STORAGE_FILE).is_file());
        assert!(!dir.join(format!("{STORAGE_FILE}.tmp")).exists());
    }

    #[test]
    fn a_value_over_a_megabyte_is_refused_and_the_old_document_stays() {
        let (_scratch, store) = installed();
        set(&store, "alpha", r#"{"a":1}"#).unwrap();
        let big = format!("\"{}\"", "a".repeat(MAX_STORAGE_BYTES as usize));
        assert!(set(&store, "alpha", &big).unwrap_err().contains("tetto"));
        assert_eq!(get(&store, "alpha").unwrap(), serde_json::json!({"a": 1}));
        // Exactly at the ceiling is kept: two bytes are the quotes.
        let edge = format!("\"{}\"", "a".repeat(MAX_STORAGE_BYTES as usize - 2));
        assert!(set(&store, "alpha", &edge).is_ok());
    }

    #[test]
    fn what_is_not_json_is_refused() {
        let (_scratch, store) = installed();
        for text in ["", "{", "undefined", "{'a':1}", "[1,]", "NaN"] {
            assert!(set(&store, "alpha", text).is_err(), "{text:?}");
        }
        assert_eq!(get(&store, "alpha"), Ok(Value::Null));
    }

    #[test]
    fn a_document_that_grew_or_was_damaged_outside_is_an_error_not_a_crash() {
        let (scratch, store) = installed();
        let file = scratch.0.join("alpha").join(STORAGE_FILE);
        std::fs::write(&file, vec![b' '; MAX_STORAGE_BYTES as usize + 1]).unwrap();
        assert!(get(&store, "alpha").unwrap_err().contains("troppo grandi"));
        std::fs::write(&file, "{not json").unwrap();
        assert!(get(&store, "alpha").unwrap_err().contains("JSON"));
    }

    #[test]
    fn an_id_that_is_not_a_plugin_makes_no_folder_and_reads_nothing() {
        let (scratch, store) = installed();
        for id in ["", "..", "a/b", "A", "x", "nope-not-installed"] {
            assert!(set(&store, id, "1").is_err(), "{id:?}");
            assert!(get(&store, id).is_err(), "{id:?}");
        }
        assert!(!scratch.0.join("nope-not-installed").exists());
    }

    #[test]
    fn a_plugin_that_is_only_pending_may_keep_a_document_but_an_absent_one_may_not() {
        let scratch = Scratch::new();
        let store = Store::new(scratch.0.clone());
        install_by_hand(&store, "beta", "1.0.0", &[("index.html", b"x")], &[]);
        store.set_pointer("beta", scheme::PENDING, "1.0.0").unwrap();
        store.clear_pointer("beta", scheme::CURRENT);
        assert!(set(&store, "beta", "1").is_ok());
        assert!(set(&store, "gamma", "1").is_err());
    }

    #[test]
    fn the_plugin_under_development_has_a_document_too() {
        let scratch = Scratch::new();
        let dev = scratch.0.join("dev");
        std::fs::create_dir_all(&dev).unwrap();
        std::fs::write(dev.join("plugin.json"), r#"{"id":"hello","version":"0.0.1","permissions":["storage"]}"#).unwrap();
        let store = Store::new(scratch.0.join("plugins")).with_dev(Some(dev));
        assert!(set(&store, "hello", r#"{"n":1}"#).is_ok());
        assert_eq!(get(&store, "hello").unwrap(), serde_json::json!({"n": 1}));
        assert!(set(&store, "other", "1").is_err());
    }

    #[test]
    fn the_commands_answer_to_the_main_window_and_no_other() {
        let source = include_str!("plugin_storage.rs");
        let body = source.split("#[cfg(test)]").next().unwrap();
        let commands: Vec<&str> = body.split("#[tauri::command]").skip(1).collect();
        assert_eq!(commands.len(), 2, "get and set");
        for command in commands {
            let header = command.lines().find(|l| l.contains("pub async fn plugin_storage_")).expect("a command follows");
            assert!(header.contains("window: tauri::WebviewWindow"), "{header}");
            let start = command.find("pub async fn plugin_storage_").unwrap();
            let first_statement = command[start..].lines().nth(1).unwrap_or("").trim();
            assert_eq!(first_statement, "main_only(window.label())?;", "{header}");
        }
        let lib = include_str!("lib.rs");
        assert!(lib.contains("plugin_storage::plugin_storage_get") && lib.contains("plugin_storage::plugin_storage_set"));
    }
}
