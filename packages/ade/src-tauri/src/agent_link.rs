//! The two file paths behind "the agent tells ADE which conversation it opened".
//!
//! The reasoning is in `src/session-new/agent-link.ts` and
//! `src/session-new/agent-hooks.ts`; this side only moves bytes. It exists
//! because those files live outside anything the webview may touch — the drop
//! directory is ADE's own application data, and the hook configuration belongs
//! to another program entirely — so both need a command with the paths fixed
//! in Rust rather than supplied by the frontend.
//!
//! Two rules keep that honest:
//!
//! - the drop file is addressed by its nonce, and a nonce is hex, so nothing
//!   the frontend sends can escape the directory;
//! - the hook configuration is addressed by an agent id that must appear in
//!   [`HOOK_TARGETS`], so the only files reachable are the two listed there.
//!
//! Neither install nor removal happens on its own. Both are commands, invoked
//! from the settings panel, because they edit files ADE does not own.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::Manager;

/// Where the hooks drop their reports, under ADE's own application data.
///
/// Not the temp directory: a report is a few hundred bytes that has to survive
/// exactly as long as it takes the frontend to poll for it, and a cleaner
/// running between the two would turn a resumable session into a fresh one for
/// no visible reason.
const LINK_SUBDIR: &str = "agent-sessions";

/// How long a drop file that nobody claimed is kept.
///
/// Claimed ones are deleted the moment they are read. This is for the rest:
/// a session that ADE lost interest in, or one whose window closed between the
/// hook writing and the poll arriving. A day is long enough that the sweep
/// never races a live session and short enough that the directory does not
/// accumulate.
const LINK_TTL: Duration = Duration::from_secs(60 * 60 * 24);

/// Filename of the script ADE installs. Mirrors `HOOK_MARKER` in `agent-hooks.ts`.
const SCRIPT_NAME: &str = "ade-agent-session.ps1";

/// A CLI ADE knows how to install a reporting hook into.
///
/// Mirrors `HOOK_TARGETS` in `src/session-new/agent-hooks.ts`, which decides
/// what to write; this table decides where. They are checked against each other
/// by `src/session-new/agent-hooks.test.ts` — add a CLI to one and the other
/// fails until it is added there too.
struct HookTarget {
    id: &'static str,
    config: &'static [&'static str],
    script: &'static [&'static str],
}

const HOOK_TARGETS: &[HookTarget] = &[
    HookTarget {
        id: "claude-code",
        config: &[".claude", "settings.json"],
        script: &[".claude", "hooks", SCRIPT_NAME],
    },
    HookTarget {
        id: "codex",
        config: &[".codex", "hooks.json"],
        script: &[".codex", SCRIPT_NAME],
    },
];

/// The directory the hooks write into, created if it is not there yet.
pub fn link_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let base = app.path().app_local_data_dir().ok()?;
    let dir = base.join(LINK_SUBDIR);
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Deletes drop files nobody came back for.
///
/// Called once at startup rather than on a timer: the directory grows by one
/// small file per agent session that ADE did not read the report of, which is
/// a rate that does not need watching.
pub fn sweep(app: &tauri::AppHandle) {
    let Some(dir) = link_dir(app) else { return };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .is_some_and(|age| age > LINK_TTL);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// A nonce is 24 hex characters, and anything else is not one.
///
/// The check is here and not only at the caller because this is what stops a
/// path from being built out of frontend input: without it, `..\\..\\` in place
/// of a nonce would read any file on the disk through a command whose whole
/// purpose is to read one known-shaped file.
fn nonce_file(nonce: &str) -> Result<String, String> {
    if nonce.is_empty() || nonce.len() > 64 || !nonce.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("nonce non valido".to_string());
    }
    Ok(format!("{nonce}.json"))
}

fn nonce_path(app: &tauri::AppHandle, nonce: &str) -> Result<PathBuf, String> {
    let name = nonce_file(nonce)?;
    let dir = link_dir(app).ok_or_else(|| "cartella sessioni non disponibile".to_string())?;
    Ok(dir.join(name))
}

/// The report a hook left for this spawn, if it has run yet.
///
/// `None` is the normal answer: the frontend polls for a while after starting
/// an agent, and most of those polls arrive before the CLI has got as far as
/// its own `SessionStart`. Left on disk rather than consumed, so a report that
/// does not parse is still there to be looked at.
#[tauri::command]
pub async fn agent_link_read(app: tauri::AppHandle, nonce: String) -> Result<Option<String>, String> {
    let path = nonce_path(&app, &nonce)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("rapporto non leggibile: {error}")),
    }
}

/// Whether the agent of this spawn is in a turn, as its last `UserPromptSubmit`
/// or `Stop` hook wrote it; `None` until either has run. Not consumed: it is a
/// state, overwritten by the next turn, and read as often as it is needed.
#[tauri::command]
pub async fn agent_activity_read(app: tauri::AppHandle, nonce: String) -> Result<Option<String>, String> {
    let json = nonce_path(&app, &nonce)?;
    let path = json.with_extension("activity");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("attività non leggibile: {error}")),
    }
}

/// The most nonces one `agent_activity_read_many` reads: more panes than a grid holds.
const ACTIVITY_BATCH_MAX: usize = 64;

/// Every hooked session's activity in one call, in the order asked (P1-C2a).
///
/// The mail pass read each pane's file with its own `agent_activity_read`: 4.2
/// invokes a second with seven panes open, for files of a few bytes. The same
/// reads, one round trip. An unreadable file or a nonce that is not one is
/// `None` at its place, as the single read's error is `null` to the frontend.
#[tauri::command]
pub async fn agent_activity_read_many(app: tauri::AppHandle, nonces: Vec<String>) -> Result<Vec<Option<String>>, String> {
    if nonces.len() > ACTIVITY_BATCH_MAX {
        return Err("troppe sessioni in una lettura".to_string());
    }
    let dir = link_dir(&app).ok_or_else(|| "cartella sessioni non disponibile".to_string())?;
    Ok(read_activities(&dir, &nonces))
}

fn read_activities(dir: &Path, nonces: &[String]) -> Vec<Option<String>> {
    nonces
        .iter()
        .map(|nonce| {
            let name = nonce_file(nonce).ok()?;
            fs::read_to_string(dir.join(name).with_extension("activity")).ok()
        })
        .collect()
}

/// Forgets a report the frontend has taken.
#[tauri::command]
pub async fn agent_link_clear(app: tauri::AppHandle, nonce: String) -> Result<(), String> {
    let path = nonce_path(&app, &nonce)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("rapporto non rimosso: {error}")),
    }
}

/// What the settings panel needs to show one CLI's row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookFiles {
    /// Absolute path of the CLI's configuration file.
    pub config_path: String,
    /// Its current contents, or `None` if the CLI has never written one.
    pub config_text: Option<String>,
    /// Absolute path ADE's script goes at.
    pub script_path: String,
    /// Whether that script is on disk right now.
    pub script_present: bool,
}

fn target(agent: &str) -> Result<&'static HookTarget, String> {
    HOOK_TARGETS
        .iter()
        .find(|target| target.id == agent)
        .ok_or_else(|| format!("nessun hook noto per {agent}"))
}

fn under_home(segments: &[&str]) -> Result<PathBuf, String> {
    let home = dirs_home().ok_or_else(|| "cartella utente non trovata".to_string())?;
    Ok(segments.iter().fold(home, |path, segment| path.join(segment)))
}

/// The user's home directory.
///
/// Read from the environment rather than through Tauri's path resolver so the
/// tests below can point it somewhere harmless: these functions write into the
/// real `~/.claude`, and a test that did that would be a bug report from the
/// user's next Claude Code session.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    let candidates = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let candidates = ["HOME"];
    for key in candidates {
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
}

/// Reads one CLI's hook configuration so the frontend can decide what to write.
#[tauri::command]
pub async fn agent_hook_read(agent: String) -> Result<HookFiles, String> {
    let target = target(&agent)?;
    let config = under_home(target.config)?;
    let script = under_home(target.script)?;
    Ok(HookFiles {
        config_text: fs::read_to_string(&config).ok(),
        config_path: config.to_string_lossy().to_string(),
        script_present: script.is_file(),
        script_path: script.to_string_lossy().to_string(),
    })
}

/// Writes back the configuration, and installs or removes the script.
///
/// `script: None` means removal. The configuration is written either way and
/// the frontend has already taken ADE's entry out of it, so the two halves
/// cannot disagree: there is never a config pointing at a script that is not
/// there, nor a script nothing invokes.
///
/// The configuration is written through a temporary file in the same
/// directory. It belongs to another program which may be running right now,
/// and a half-written `settings.json` is a CLI that will not start.
#[tauri::command]
pub async fn agent_hook_write(
    app: tauri::AppHandle,
    agent: String,
    config_text: String,
    script: Option<String>,
) -> Result<(), String> {
    let target = target(&agent)?;
    let config = under_home(target.config)?;
    let script_path = under_home(target.script)?;

    tauri::async_runtime::spawn_blocking(move || {
        write_hook_files(&config, &script_path, &config_text, script.as_deref(), |script_path| {
            let brand = crate::brand::name();
            let question = format!(
                "{brand} vuole installare o aggiornare il suo hook per {agent}:\n\n{}\n\nLo script viene eseguito da {agent} a ogni sessione, per dire a {brand} quale conversazione ha aperto. Consentire?",
                script_path.display()
            );
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            app.dialog()
                .message(question)
                .title(format!("Hook di {}", crate::brand::name()))
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("Consenti".into(), "Annulla".into()))
                .blocking_show()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/*
 * The body of `agent_hook_write`, with the confirmation handed in so a test
 * can stand in for the dialog.
 *
 * The dialog can stay open for as long as the user leaves it, and the file
 * belongs to another program: whatever it or the user wrote to it meanwhile
 * was overwritten by a configuration built from the copy read before
 * (audit 0.7.7, point 0 of the post-0.7.7 list). So the file is read again
 * after the dialog, and if it is no longer the one the check passed on,
 * nothing is written: the caller gets an error and tries again, from what is
 * on disk now. Nothing is merged — the configuration was built from the old
 * copy, and guessing how the two fit together is how someone's settings get
 * damaged.
 */
fn write_hook_files(
    config: &Path,
    script_path: &Path,
    config_text: &str,
    script: Option<&str>,
    confirm: impl FnOnce(&Path) -> bool,
) -> Result<(), String> {
    /*
     * This writes a program another CLI runs and the configuration that makes
     * it run, so it must not be a way to install any program.
     *
     * The configuration may differ from what is on disk only in ADE's own
     * entries, and those must invoke ADE's script exactly as `hookCommand`
     * spells it. The script's text is the part no rule can check, so a script
     * that is not already the one on disk is shown to the user first, in a
     * native dialog nothing in the webview can click.
     */
    let current = fs::read_to_string(config).ok();
    check_hook_config(current.as_deref(), config_text, &hook_command(script_path))?;
    if let Some(text) = script {
        let on_disk = fs::read_to_string(script_path).ok();
        if on_disk.as_deref() != Some(text) {
            if !confirm(script_path) {
                return Err("installazione dell'hook annullata".to_string());
            }
            // Read again: the dialog may have been open for minutes.
            let now = fs::read_to_string(config).ok();
            if now != current {
                return Err(format!(
                    "{} è cambiato mentre il dialogo era aperto: riprova",
                    config.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()
                ));
            }
        }
    }

    match script {
        Some(text) => {
            if let Some(parent) = script_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("cartella hook non creata: {e}"))?;
            }
            write_atomic(script_path, text.as_bytes())?;
        }
        None => match fs::remove_file(script_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("script non rimosso: {error}")),
        },
    }

    if let Some(parent) = config.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cartella configurazione non creata: {e}"))?;
    }
    write_atomic(config, config_text.as_bytes())
}

/// How a CLI's configuration invokes ADE's script. Mirrors `hookCommand` in `agent-hooks.ts`.
fn hook_command(script_path: &Path) -> String {
    format!("powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"", script_path.display())
}

/// How one configuration entry invokes its program, as a single command line.
///
/// The same entry can be written two ways: a shell-shaped one, where `command`
/// holds the whole line, and the exec form, where `command` is the program and
/// `args` are its arguments. ADE installs the exec form because the script's
/// path may contain spaces, and in that form the script's name is nowhere in
/// `command` — which is how this module missed its own entries and refused to
/// write the configuration.
///
/// Mirrors `commandOf` in `agent-hooks.ts`, quoting included, so the string it
/// returns is directly comparable with `hook_command`.
fn command_of(leaf: &serde_json::Value) -> Option<String> {
    use serde_json::Value;
    let map = leaf.as_object()?;
    let command = map.get("command")?.as_str()?;
    let args = match map.get("args").and_then(Value::as_array) {
        Some(args) if !args.is_empty() && args.iter().all(Value::is_string) => args,
        _ => return Some(command.to_string()),
    };
    let last = args[args.len() - 1].as_str().unwrap_or_default();
    let rest = args[..args.len() - 1]
        .iter()
        .map(|arg| arg.as_str().unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!("{command} {rest} \"{last}\""))
}

/// A configuration with ADE's entries taken out, remembering what their going emptied.
#[derive(Debug)]
enum Stripped {
    /// ADE's own entry.
    Gone,
    /// A container that held something and holds nothing now that ADE's entries are out: a
    /// hook group whose `hooks` held only ADE's, whatever `matcher` it keeps, counts too.
    Emptied,
    Object(std::collections::BTreeMap<String, Stripped>),
    Array(Vec<Stripped>),
    Leaf(serde_json::Value),
}

/// The configuration with every ADE entry taken out (see `Stripped`).
///
/// Only what ADE's going emptied is marked as such. An empty container the
/// user wrote stays one, so a write that adds or drops `"permissions": {}` is
/// a change like any other (audit 0.7.7, C2 BASSO); and a hook group left as
/// `{matcher}` once ADE's entry is out is emptied, not a group that stays
/// (MEDIO 15): Claude Code's groups carry a `matcher`, and every install on a
/// file without ADE's group was refused as "changes more than the hooks".
fn without_ade(value: &serde_json::Value) -> Stripped {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            // ADE's own entry, whichever form it is written in: the script's
            // name is in the command line, or among the arguments.
            if command_of(value).is_some_and(|c| c.contains(SCRIPT_NAME)) {
                return Stripped::Gone;
            }
            let mut touched = false;
            let mut hooks_emptied = false;
            let mut kept = std::collections::BTreeMap::new();
            for (key, child) in map {
                match without_ade(child) {
                    Stripped::Gone => touched = true,
                    Stripped::Emptied => {
                        touched = true;
                        hooks_emptied |= key == "hooks" && child.is_array();
                        kept.insert(key.clone(), Stripped::Emptied);
                    }
                    other => {
                        kept.insert(key.clone(), other);
                    }
                }
            }
            if touched && hooks_emptied {
                Stripped::Emptied
            } else {
                Stripped::Object(kept)
            }
        }
        Value::Array(items) => {
            let mut touched = false;
            let mut kept = Vec::new();
            for item in items {
                match without_ade(item) {
                    Stripped::Gone | Stripped::Emptied => touched = true,
                    other => kept.push(other),
                }
            }
            if touched && kept.is_empty() {
                Stripped::Emptied
            } else {
                Stripped::Array(kept)
            }
        }
        other => Stripped::Leaf(other.clone()),
    }
}

/// Whether nothing but ADE's going is left: emptied, or an object of emptied things.
fn ade_only(s: &Stripped) -> bool {
    match s {
        Stripped::Emptied | Stripped::Gone => true,
        Stripped::Object(map) => !map.is_empty() && map.values().all(ade_only),
        _ => false,
    }
}

/// Whether two stripped configurations say the same thing. What ADE emptied
/// matches a missing key or an empty container of either kind, and nothing else.
fn same_without_ade(before: &Stripped, after: &Stripped) -> bool {
    use Stripped::*;
    let empty = |s: &Stripped| match s {
        Object(map) => map.is_empty() || ade_only(s),
        Array(items) => items.is_empty(),
        other => ade_only(other),
    };
    match (before, after) {
        (Emptied | Gone, other) | (other, Emptied | Gone) => empty(other),
        (Object(b), Object(a)) => b.keys().chain(a.keys()).all(|key| match (b.get(key), a.get(key)) {
            (Some(x), Some(y)) => same_without_ade(x, y),
            (Some(only), None) | (None, Some(only)) => ade_only(only),
            (None, None) => true,
        }),
        (Array(b), Array(a)) => b.len() == a.len() && b.iter().zip(a).all(|(x, y)| same_without_ade(x, y)),
        (Leaf(b), Leaf(a)) => b == a,
        _ => false,
    }
}

/// Every invocation in the configuration that belongs to ADE, as whole command
/// lines, so each one can be compared with the line ADE is supposed to write.
///
/// An entry is ADE's when the script's name appears in it, in the command line
/// or among the arguments; what comes out is the joined form either way, so a
/// matching script behind a different program, or with an argument added, is
/// still a mismatch rather than a pass.
fn ade_commands(value: &serde_json::Value, out: &mut Vec<String>) {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            if let Some(command) = command_of(value).filter(|c| c.contains(SCRIPT_NAME)) {
                out.push(command);
                // The entry itself: nothing inside it is another entry.
                return;
            }
            for v in map.values() {
                ade_commands(v, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|v| ade_commands(v, out)),
        _ => {}
    }
}

/// Refuses a configuration that changes anything but ADE's own hook entries.
fn check_hook_config(current: Option<&str>, next: &str, command: &str) -> Result<(), String> {
    let parse = |text: &str| -> Result<serde_json::Value, String> {
        if text.trim().is_empty() {
            return Ok(serde_json::Value::Object(Default::default()));
        }
        serde_json::from_str(text).map_err(|e| format!("configurazione non valida: {e}"))
    };
    let before = parse(current.unwrap_or(""))?;
    let after = parse(next)?;
    if !same_without_ade(&without_ade(&before), &without_ade(&after)) {
        return Err(format!("la configurazione cambia più degli hook di {}: scrittura rifiutata", crate::brand::name()));
    }
    let mut commands = Vec::new();
    ade_commands(&after, &mut commands);
    if let Some(bad) = commands.iter().find(|c| c.as_str() != command) {
        return Err(format!("comando hook non riconosciuto: {bad}"));
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let staging = path.with_extension("ade-part");
    {
        let mut file =
            fs::File::create(&staging).map_err(|e| format!("{} non scrivibile: {e}", path.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("{} non scritto: {e}", path.display()))?;
        file.sync_all()
            .map_err(|e| format!("{} non salvato: {e}", path.display()))?;
    }
    fs::rename(&staging, path).map_err(|e| {
        let _ = fs::remove_file(&staging);
        format!("{} non sostituito: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hook_write_may_only_touch_ade_entries() {
        let script = Path::new("C:\\Users\\x\\.claude\\hooks").join(SCRIPT_NAME);
        let command = hook_command(&script);
        let entry = |cmd: &str| format!(r#"{{"type":"command","command":{}}}"#, serde_json::to_string(cmd).unwrap());
        let current = r#"{"model":"opus","hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify"}]}]}}"#;
        let installed = format!(
            r#"{{"model":"opus","hooks":{{"Stop":[{{"hooks":[{{"type":"command","command":"notify"}}]}},{{"hooks":[{}]}}],"SessionStart":[{{"hooks":[{}]}}]}}}}"#,
            entry(&command),
            entry(&command)
        );
        assert!(check_hook_config(Some(current), &installed, &command).is_ok());
        assert!(check_hook_config(Some(&installed), current, &command).is_ok());
        assert!(check_hook_config(None, &format!(r#"{{"hooks":{{"SessionStart":[{{"hooks":[{}]}}]}}}}"#, entry(&command)), &command).is_ok());

        let widened = installed.replace(r#""model":"opus""#, r#""model":"opus","permissions":{"allow":["Bash"]}"#);
        assert!(check_hook_config(Some(current), &widened, &command).is_err());
        let foreign = installed.replace("notify", "calc");
        assert!(check_hook_config(Some(current), &foreign, &command).is_err());
        let hijacked = installed.replace("powershell -NoProfile", "calc & powershell -NoProfile");
        assert!(check_hook_config(Some(current), &hijacked, &command).is_err());
    }

    #[test]
    fn a_hook_group_with_a_matcher_goes_with_ades_entry() {
        // Audit 0.7.7, MEDIO 15: Claude Code's groups carry a matcher, and `{matcher}` used to stay behind.
        let script = Path::new("C:\\Users\\x\\.claude\\hooks").join(SCRIPT_NAME);
        let command = hook_command(&script);
        let group = format!(
            r#"{{"matcher":"startup|resume|clear","hooks":[{{"type":"command","command":{}}}]}}"#,
            serde_json::to_string(&command).unwrap()
        );
        let user = r#"{"matcher":"startup","hooks":[{"type":"command","command":"notify"}]}"#;
        // Installed on a file with no hooks, with an empty hooks object, beside a group of the user's.
        assert!(check_hook_config(Some(r#"{"model":"opus"}"#), &format!(r#"{{"model":"opus","hooks":{{"SessionStart":[{group}]}}}}"#), &command).is_ok());
        assert!(check_hook_config(Some(r#"{"hooks":{}}"#), &format!(r#"{{"hooks":{{"SessionStart":[{group}]}}}}"#), &command).is_ok());
        let beside = format!(r#"{{"hooks":{{"SessionStart":[{user},{group}]}}}}"#);
        assert!(check_hook_config(Some(&format!(r#"{{"hooks":{{"SessionStart":[{user}]}}}}"#)), &beside, &command).is_ok());
        // And taken out again.
        assert!(check_hook_config(Some(&beside), &format!(r#"{{"hooks":{{"SessionStart":[{user}]}}}}"#), &command).is_ok());
        // The user's group loses its hooks: not ADE's doing, refused.
        let emptied_user = r#"{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[]}]}}"#;
        assert!(check_hook_config(Some(&format!(r#"{{"hooks":{{"SessionStart":[{user}]}}}}"#)), emptied_user, &command).is_err());
    }

    #[test]
    fn the_users_empty_containers_are_not_absent() {
        // C2 BASSO: an empty object or array the user wrote is part of the file like anything else.
        let command = hook_command(&Path::new("C:\\h").join(SCRIPT_NAME));
        assert!(check_hook_config(Some(r#"{"x":{}}"#), "{}", &command).is_err());
        assert!(check_hook_config(Some("{}"), r#"{"permissions":{"allow":[]}}"#, &command).is_err());
        assert!(check_hook_config(Some(r#"{"x":{}}"#), r#"{"x":{}}"#, &command).is_ok());
    }

    /// A settings file and a script path in a fresh folder of their own, under the test TEMP.
    fn hook_scratch(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "ade-hook-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        (dir.join("settings.json"), dir.join("hooks").join(SCRIPT_NAME), dir)
    }

    #[test]
    fn many_activities_are_read_in_one_call_each_at_its_place() {
        let (_, _, dir) = hook_scratch("activities");
        let busy = "aaaaaaaaaaaaaaaaaaaaaaaa".to_string();
        let idle = "bbbbbbbbbbbbbbbbbbbbbbbb".to_string();
        let silent = "cccccccccccccccccccccccc".to_string();
        fs::write(dir.join(format!("{busy}.activity")), r#"{"state":"busy"}"#).unwrap();
        fs::write(dir.join(format!("{idle}.activity")), r#"{"state":"idle"}"#).unwrap();
        // A report is not an activity, and a path is not a nonce.
        fs::write(dir.join(format!("{silent}.json")), "{}").unwrap();
        let read = read_activities(&dir, &[idle, silent, "..\\..\\x".to_string(), busy]);
        assert_eq!(
            read,
            vec![Some(r#"{"state":"idle"}"#.to_string()), None, None, Some(r#"{"state":"busy"}"#.to_string())]
        );
    }

    #[test]
    fn a_settings_file_changed_while_the_dialog_was_open_is_not_written() {
        let (config, script, dir) = hook_scratch("changed");
        fs::write(&config, r#"{"model":"opus"}"#).unwrap();
        let external = r#"{"model":"opus","theme":"dark"}"#;
        let mut asked = 0;
        let result = write_hook_files(&config, &script, r#"{"model":"opus"}"#, Some("# script"), |_| {
            asked += 1;
            // Someone saves the file while the dialog waits for an answer.
            fs::write(&config, external).unwrap();
            true
        });
        let error = result.expect_err("a changed file was overwritten");
        assert!(error.contains("è cambiato mentre il dialogo era aperto"), "{error}");
        assert_eq!(asked, 1);
        // The change made meanwhile survives, and nothing of ADE's was written.
        assert_eq!(fs::read_to_string(&config).unwrap(), external);
        assert!(!script.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_settings_file_left_as_it_was_is_written_as_before() {
        let (config, script, dir) = hook_scratch("same");
        fs::write(&config, r#"{"model":"opus"}"#).unwrap();
        let next = r#"{"model":"opus"}"#;
        write_hook_files(&config, &script, next, Some("# script"), |_| true).expect("an unchanged file is written");
        assert_eq!(fs::read_to_string(&config).unwrap(), next);
        assert_eq!(fs::read_to_string(&script).unwrap(), "# script");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn the_file_is_read_again_after_the_dialog_not_before() {
        let (config, script, dir) = hook_scratch("order");
        fs::write(&config, r#"{"model":"opus"}"#).unwrap();
        let mut asked = false;
        // A change before the dialog is caught by the first check; one inside it only by a read after it.
        let result = write_hook_files(&config, &script, r#"{"model":"opus"}"#, Some("# script"), |_| {
            asked = true;
            fs::write(&config, r#"{"model":"sonnet"}"#).unwrap();
            true
        });
        assert!(asked, "the dialog was not shown");
        assert!(result.is_err(), "the read after the dialog did not happen");
        // Refused and not asked: nothing written either.
        fs::write(&config, r#"{"model":"opus"}"#).unwrap();
        let refused = write_hook_files(&config, &script, r#"{"model":"opus"}"#, Some("# script"), |_| false);
        assert!(refused.is_err());
        assert!(!script.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn every_target_has_a_script_this_module_recognises() {
        for target in HOOK_TARGETS {
            assert_eq!(target.script.last(), Some(&SCRIPT_NAME));
            assert!(!target.config.is_empty());
        }
    }

    #[test]
    fn a_nonce_that_is_not_hex_never_becomes_a_path() {
        assert_eq!(nonce_file("a1b2c3").as_deref(), Ok("a1b2c3.json"));
        for bad in ["", "../../../windows/win.ini", "a1b2/c3", "a1b2.json", &"f".repeat(65)] {
            assert!(nonce_file(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn an_unknown_agent_has_no_files_to_touch() {
        assert!(target("gemini").is_err());
        assert!(target("../../etc").is_err());
    }

    #[test]
    fn a_config_path_stays_under_the_home_directory() {
        let home = dirs_home().expect("a home directory");
        for entry in HOOK_TARGETS {
            let config = under_home(entry.config).expect("a path");
            let script = under_home(entry.script).expect("a path");
            assert!(config.starts_with(&home), "{} escaped", config.display());
            assert!(script.starts_with(&home), "{} escaped", script.display());
        }
    }

    #[test]
    fn write_atomic_replaces_a_file_without_leaving_its_staging_copy() {
        let dir = std::env::temp_dir().join(format!("ade-hook-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("a directory");
        let path = dir.join("settings.json");
        fs::write(&path, b"prima").expect("a file");

        write_atomic(&path, b"dopo").expect("the write to land");

        assert_eq!(fs::read_to_string(&path).expect("the file"), "dopo");
        assert!(!path.with_extension("ade-part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// The entry ADE installs now: program in `command`, script in `args`.
    fn exec_entry(program: &str, script: &Path, extra: &[&str]) -> serde_json::Value {
        let mut args = vec![
            "-NoProfile".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            script.to_string_lossy().to_string(),
        ];
        args.extend(extra.iter().map(|arg| arg.to_string()));
        serde_json::json!({
            "type": "command",
            "command": program,
            "args": args,
            "timeout": 10
        })
    }

    /// A configuration like the user's: someone else's `Stop` hook, and ADE's
    /// own entry at the end of `SessionStart` under a matcher.
    fn with_ade_entry(leaf: serde_json::Value) -> String {
        serde_json::json!({
            "model": "opus",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "notify" }] }],
                "SessionStart": [{
                    "matcher": "startup|resume|clear",
                    "hooks": [leaf]
                }]
            }
        })
        .to_string()
    }

    /// The migration that was silently failing: the entry on disk written the
    /// old way, the one ADE is about to write with the script among the args.
    /// While the exec entry was taken for a stranger's, the configuration
    /// looked changed and every write was refused.
    #[test]
    fn an_exec_form_entry_is_recognised_as_ades_own() {
        let script = Path::new("C:\\Users\\x\\.claude\\hooks").join(SCRIPT_NAME);
        let command = hook_command(&script);
        let string_form = with_ade_entry(serde_json::json!({
            "type": "command",
            "command": command,
            "timeout": 5
        }));
        let exec_form = with_ade_entry(exec_entry("powershell", &script, &[]));

        assert!(check_hook_config(Some(&string_form), &exec_form, &command).is_ok());
        assert!(check_hook_config(Some(&exec_form), &string_form, &command).is_ok());
    }

    #[test]
    fn an_exec_form_entry_that_runs_another_program_is_refused() {
        let script = Path::new("C:\\Users\\x\\.claude\\hooks").join(SCRIPT_NAME);
        let command = hook_command(&script);
        let current = with_ade_entry(exec_entry("powershell", &script, &[]));
        let next = with_ade_entry(exec_entry("cmd", &script, &[]));

        let error = check_hook_config(Some(&current), &next, &command).expect_err("cmd was accepted");
        assert!(error.contains("non riconosciuto"), "{error}");
    }

    #[test]
    fn an_exec_form_entry_with_an_extra_argument_is_refused() {
        let script = Path::new("C:\\Users\\x\\.claude\\hooks").join(SCRIPT_NAME);
        let command = hook_command(&script);
        let current = with_ade_entry(exec_entry("powershell", &script, &[]));
        let next = with_ade_entry(exec_entry("powershell", &script, &["-Verbose"]));

        let error = check_hook_config(Some(&current), &next, &command).expect_err("-Verbose was accepted");
        assert!(error.contains("non riconosciuto"), "{error}");
    }
}
