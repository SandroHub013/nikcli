//! Secrets ADE did not save but a gateway may still meet: the provider keys
//! nikcli keeps in its `auth.json`, and the keys in ADE's own environment.
//!
//! Read here, in Rust, each time the gateway needs the list, and never kept,
//! logged or sent to the page: they are only what `redact` looks for.
//!
//! Claude's and Codex's credential files are not opened, not even to hide
//! what is in them: ADE does not touch them (D7). A key of theirs that is
//! already in ADE's environment is hidden like any other: that reads no file
//! of theirs, and hiding it is only safer.

use std::path::PathBuf;

/// Shorter strings in `auth.json` are ids or flags, not keys.
const MIN_AUTH_LEN: usize = 16;
/// As `redact` would skip anything shorter anyway.
const MIN_ENV_LEN: usize = 8;

/// Where nikcli keeps `auth.json`, on each system.
fn nikcli_auth_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for dir in [dirs::data_local_dir(), dirs::data_dir()].into_iter().flatten() {
        paths.push(dir.join("nikcli").join("auth.json"));
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".config").join("nikcli").join("auth.json"));
        paths.push(home.join(".nikcli").join("auth.json"));
    }
    paths.dedup();
    paths
}

/// A field whose value is a credential: `key`, `apiKey`, `token`, an OAuth
/// `access` or `refresh`, a `secret`.
fn is_secret_field(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(name.as_str(), "access" | "refresh") || ["key", "token", "secret"].iter().any(|end| name.ends_with(end))
}

/// The credentials in an `auth.json`: string values of credential fields, at
/// any depth. A file that does not parse gives none.
fn auth_values(text: &str) -> Vec<String> {
    fn walk(value: &serde_json::Value, field: Option<&str>, out: &mut Vec<String>) {
        match value {
            serde_json::Value::String(text) if field.is_some_and(is_secret_field) && text.trim().chars().count() >= MIN_AUTH_LEN => {
                out.push(text.trim().to_string());
            }
            serde_json::Value::Object(map) => map.iter().for_each(|(name, value)| walk(value, Some(name), out)),
            serde_json::Value::Array(items) => items.iter().for_each(|item| walk(item, field, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        walk(&value, None, &mut out);
    }
    out
}

/// Variables that are credentials by their name, Claude's and Codex's included.
fn env_values(vars: impl IntoIterator<Item = (String, String)>) -> Vec<String> {
    vars.into_iter()
        .filter(|(name, _)| {
            let name = name.to_ascii_uppercase();
            ["_API_KEY", "_TOKEN", "_SECRET"].iter().any(|end| name.ends_with(end))
        })
        .map(|(_, value)| value.trim().to_string())
        .filter(|value| value.chars().count() >= MIN_ENV_LEN)
        .collect()
}

/// Every secret of nikcli's and of ADE's environment, read now.
pub fn values() -> Vec<String> {
    let mut values = Vec::new();
    for path in nikcli_auth_paths() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            values.extend(auth_values(&text));
        }
    }
    let vars = std::env::vars_os().filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)));
    values.extend(env_values(vars));
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    /* Fake values only: no real auth.json or variable is read by these tests. */

    #[test]
    fn the_keys_and_tokens_in_a_fake_auth_json_and_nothing_else() {
        let text = r#"{
            "openrouter": { "type": "api", "key": "sk-or-v1-finta-chiave-0123456789" },
            "altro": { "type": "oauth", "access": "finto-access-token-abcdef", "refresh": "finto-refresh-token-abcdef", "expires": 1757880000 },
            "vecchio": { "apiKey": "finta-api-key-9876543210", "accountId": "account-id-lungo-ma-non-segreto" },
            "corto": { "key": "abc" },
            "elenco": [{ "token": "finto-token-in-un-elenco-42" }],
            "nome": "un nome lungo che non è una chiave"
        }"#;
        let mut values = auth_values(text);
        values.sort();
        assert_eq!(
            values,
            vec![
                "finta-api-key-9876543210",
                "finto-access-token-abcdef",
                "finto-refresh-token-abcdef",
                "finto-token-in-un-elenco-42",
                "sk-or-v1-finta-chiave-0123456789",
            ]
        );
        assert!(auth_values("{ non json").is_empty());
    }

    #[test]
    fn the_variables_named_as_keys_claudes_and_codexs_included() {
        let vars = [
            ("OPENROUTER_API_KEY", "sk-or-v1-finta-variabile"),
            ("GITHUB_TOKEN", "ghp_finto_token_0123"),
            ("my_service_secret", "finto-segreto-minuscolo"),
            ("CLAUDE_SESSION_TOKEN", "finto-di-claude-nell-ambiente"),
            ("CODEX_API_KEY", "finto-di-codex-nell-ambiente"),
            ("PATH", "C:/Windows/system32"),
            ("SHORT_TOKEN", "1234"),
        ]
        .map(|(name, value)| (name.to_string(), value.to_string()));
        assert_eq!(
            env_values(vars),
            vec![
                "sk-or-v1-finta-variabile",
                "ghp_finto_token_0123",
                "finto-segreto-minuscolo",
                "finto-di-claude-nell-ambiente",
                "finto-di-codex-nell-ambiente",
            ]
        );
    }

    #[test]
    fn nikclis_auth_json_is_looked_for_where_nikcli_keeps_it() {
        let paths = nikcli_auth_paths();
        assert!(!paths.is_empty());
        for path in &paths {
            let folder = path.parent().and_then(|dir| dir.file_name()).and_then(|name| name.to_str());
            assert!(path.ends_with("auth.json") && matches!(folder, Some("nikcli" | ".nikcli")), "{path:?}");
        }
    }
}
