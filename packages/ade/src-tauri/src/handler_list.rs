//! The commands of ADE's own that `lib.rs` hands to Tauri (`tauri::generate_handler![ … ]`), read from its source.
//!
//! `build.rs` includes this file (`#[path]`) to declare them as the app's ACL manifest, so the list is never written
//! twice; the tests below check that the capability of the `main` window grants exactly them. Nothing here depends on the
//! rest of the crate.
//!
//! Why every command and not only the sensitive ones (S7): once the app declares an ACL manifest at all, Tauri checks
//! every command of the app against it, and one that is not declared and granted is refused for everybody. A manifest
//! of the gateway's commands alone would take every other command away from the window.

/// The name of every command `generate_handler!` lists in `source` (the last segment of its path), in order.
///
/// Panics on what it cannot read with certainty, so a build never goes on with a list that might lack a command: an
/// attribute inside the list (a `#[cfg]` would make a command exist only sometimes), or no list at all.
pub fn handler_commands(source: &str) -> Vec<String> {
    const OPEN: &str = "tauri::generate_handler![";
    let start = source.find(OPEN).expect("lib.rs non ha tauri::generate_handler![") + OPEN.len();
    assert!(source[start..].find(OPEN).is_none(), "lib.rs ha piu di una tauri::generate_handler![");
    let end = start + source[start..].find(']').expect("la lista di generate_handler! non si chiude");
    let mut commands = Vec::new();
    for line in source[start..end].lines() {
        let line = line.split("//").next().unwrap_or("");
        assert!(!line.contains("#[") && !line.contains("/*"), "un attributo o un commento a blocco dentro generate_handler!: {line}");
        for entry in line.split(',') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            assert!(
                entry.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == ':'),
                "una voce di generate_handler! che non e un percorso: {entry}"
            );
            commands.push(entry.rsplit("::").next().unwrap_or(entry).to_string());
        }
    }
    commands
}

/// The permission Tauri makes for an app command declared in the manifest: `allow-` and the name with dashes.
pub fn allow_permission(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const LIB: &str = include_str!("lib.rs");
    const CAPABILITY: &str = include_str!("../capabilities/default.json");

    #[test]
    fn the_list_is_read_by_the_last_segment_and_what_it_cannot_be_sure_of_stops_the_build() {
        let source = "x(tauri::generate_handler![\n    a_one,\n    m::b_two, // note, with a comma\n    n::o::c_three,\n])";
        assert_eq!(handler_commands(source), ["a_one", "b_two", "c_three"]);
        assert_eq!(allow_permission("gateway_pairing_link"), "allow-gateway-pairing-link");
        for broken in [
            "tauri::generate_handler![\n    #[cfg(unix)]\n    a,\n]",
            "tauri::generate_handler![\n    /* a */ b,\n]",
            "tauri::generate_handler![\n    a(b),\n]",
            "niente",
            "tauri::generate_handler![ a, tauri::generate_handler![ b ]",
        ] {
            assert!(std::panic::catch_unwind(|| handler_commands(broken)).is_err(), "{broken}");
        }
    }

    #[test]
    fn lib_rs_lists_the_commands_once_each_and_they_are_the_ones_the_review_named() {
        let commands = handler_commands(LIB);
        assert!(commands.len() > 100, "{} comandi: la lista e stata letta male?", commands.len());
        let unique: BTreeSet<&String> = commands.iter().collect();
        assert_eq!(unique.len(), commands.len(), "un comando due volte nella lista");
        // The ones S7 names: they must be there to be granted.
        for named in ["gateway_pairing_link", "gateway_pairing_approve", "gateway_pairing_open", "gateway_preview", "system_notify"] {
            assert!(commands.iter().any(|command| command == named), "{named} non e registrato");
        }
    }

    /// The `allow-…` permissions the main window's capability grants to the app's own commands (not a plugin's).
    fn granted() -> BTreeSet<String> {
        let capability: serde_json::Value = serde_json::from_str(CAPABILITY).expect("capabilities/default.json");
        capability["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .filter_map(|permission| permission.as_str())
            .filter(|permission| permission.starts_with("allow-"))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn the_main_window_is_granted_every_command_that_is_registered_and_nothing_that_is_not() {
        let registered: BTreeSet<String> = handler_commands(LIB).iter().map(|command| allow_permission(command)).collect();
        let granted = granted();
        let missing: Vec<&String> = registered.difference(&granted).collect();
        assert!(
            missing.is_empty(),
            "comandi registrati in lib.rs e non concessi in capabilities/default.json (aggiungi i permessi): {missing:?}"
        );
        let stale: Vec<&String> = granted.difference(&registered).collect();
        assert!(stale.is_empty(), "permessi concessi per comandi che lib.rs non registra piu (toglili): {stale:?}");
    }

    #[test]
    fn the_capability_is_the_main_window_only_with_a_local_origin() {
        let capability: serde_json::Value = serde_json::from_str(CAPABILITY).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("webviews").is_none(), "una capacita per webview non e questa");
        // `remote` is what would open the app's commands to a page loaded from a web address.
        assert!(capability.get("remote").is_none(), "nessuna origine remota ha accesso ai comandi dell'app");
    }

    #[test]
    fn the_build_script_declares_the_manifest_from_this_same_list() {
        let build = include_str!("../build.rs");
        assert!(build.contains("handler_list::handler_commands"), "build.rs deve leggere la lista da qui");
        assert!(build.contains("app_manifest"), "build.rs deve dichiarare il manifest dell'app");
    }
}
