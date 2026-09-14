//! Sessions sending each other messages, whatever CLI each one runs.
//!
//! No CLI has a way to talk to another CLI, and ADE cannot add one to each of
//! them. What they all have is a shell tool and a terminal, so the channel is
//! built from exactly those two things:
//!
//! - every session ADE starts finds `ade-msg` on its PATH, with its own pane id
//!   in `ADE_PANE_ID` and the mailbox in `ADE_MAILBOX`;
//! - `ade-msg send <to> <text>` drops a JSON file in `outbox/` and waits for a
//!   receipt; `ade-msg list` prints the sessions ADE last published;
//! - the frontend takes the outbox, types each message into the target pane's
//!   terminal as if the user had, and writes the receipt.
//!
//! Typing is the only delivery every agent understands, and it is how the
//! recipient learns the reply command: the delivered line says it.
//!
//! This side only moves files. Deciding who a message is for, and what it
//! looks like when it lands, is `src/session/mailbox.ts`, where it is tested.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::Manager;

const MAILBOX_SUBDIR: &str = "mailbox";

/// Receipts nobody waited for are removed after this long.
const RECEIPT_TTL: Duration = Duration::from_secs(60 * 10);

/// A message larger than this is not a message; the file is dropped unread.
const MAX_MESSAGE_BYTES: u64 = 64 * 1024;

pub fn mailbox_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?.join(MAILBOX_SUBDIR);
    for sub in ["outbox", "receipts", "bin"] {
        fs::create_dir_all(dir.join(sub)).ok()?;
    }
    Some(dir)
}

/// The directory prepended to every session's PATH.
pub fn bin_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    mailbox_dir(app).map(|dir| dir.join("bin"))
}

/// Writes the `ade-msg` scripts and clears old receipts. Called at startup.
///
/// Rewritten every launch rather than only when missing, so a session always
/// runs the version that matches the ADE that will read its messages.
pub fn install(app: &tauri::AppHandle) {
    let Some(dir) = mailbox_dir(app) else { return };
    let bin = dir.join("bin");
    let _ = fs::write(bin.join("ade-msg.ps1"), PS1);
    let _ = fs::write(bin.join("ade-msg.cmd"), CMD);
    let _ = fs::write(bin.join("ade-msg"), SH);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(bin.join("ade-msg"), fs::Permissions::from_mode(0o755));
    }

    let now = SystemTime::now();
    if let Ok(entries) = fs::read_dir(dir.join("receipts")) {
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > RECEIPT_TTL);
            if old {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// A message id names a file, so it is held to a shape that cannot be a path.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Serialize)]
pub struct Outgoing {
    id: String,
    /// The JSON the script wrote, unparsed: judging it is the frontend's job.
    body: String,
}

/// Takes every complete message out of the outbox.
///
/// Only `*.json`: the scripts write `*.part` and rename, so a file with the
/// final name is always whole. Each one is removed as it is read, which is
/// what makes a message delivered at most once.
#[tauri::command]
pub async fn mailbox_take(app: tauri::AppHandle) -> Result<Vec<Outgoing>, String> {
    let dir = mailbox_dir(&app).ok_or("casella non disponibile")?.join("outbox");
    let mut out = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|e| format!("casella non leggibile: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(str::to_string) else {
            continue;
        };
        let too_big = entry.metadata().map(|m| m.len() > MAX_MESSAGE_BYTES).unwrap_or(true);
        let body = if too_big { None } else { fs::read_to_string(&path).ok() };
        let _ = fs::remove_file(&path);
        if let (true, Some(body)) = (valid_id(&id), body) {
            out.push(Outgoing { id, body });
        }
    }
    Ok(out)
}

/// Tells the waiting `ade-msg send` what happened to its message.
#[tauri::command]
pub async fn mailbox_receipt(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id messaggio non valido".into());
    }
    let dir = mailbox_dir(&app).ok_or("casella non disponibile")?.join("receipts");
    let part = dir.join(format!("{id}.part"));
    fs::write(&part, text).map_err(|e| format!("ricevuta non scritta: {e}"))?;
    fs::rename(&part, dir.join(format!("{id}.txt"))).map_err(|e| format!("ricevuta non scritta: {e}"))
}

/// Publishes the list `ade-msg list` prints.
#[tauri::command]
pub async fn mailbox_publish(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let dir = mailbox_dir(&app).ok_or("casella non disponibile")?;
    let part = dir.join("sessions.part");
    fs::write(&part, text).map_err(|e| format!("elenco non scritto: {e}"))?;
    fs::rename(&part, dir.join("sessions.txt")).map_err(|e| format!("elenco non scritto: {e}"))
}

/// Windows: the implementation. Plain PowerShell 5.1, no modules.
const PS1: &str = r#"# ade-msg — send a message to another ADE session. Written by ADE; do not edit.
param([Parameter(Position = 0)][string]$Command, [Parameter(Position = 1)][string]$To, [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$box = $env:ADE_MAILBOX
if (-not $box -or -not (Test-Path $box)) { [Console]::Error.WriteLine('ade-msg: questa shell non e'' una sessione avviata da ADE (ADE_MAILBOX mancante).'); exit 2 }
function Usage { Write-Output "uso:`n  ade-msg list                      sessioni aperte in ADE`n  ade-msg send <sessione> <testo>   manda un messaggio (id, numero, titolo o nome dell'agente)`n  ade-msg whoami                    questa sessione"; exit 1 }
switch ($Command) {
  'list' { $f = Join-Path $box 'sessions.txt'; if (Test-Path $f) { Get-Content -Raw -Encoding UTF8 $f } else { Write-Output 'nessuna sessione pubblicata' }; exit 0 }
  'whoami' { Write-Output $env:ADE_PANE_ID; exit 0 }
  'send' {
    $text = ($Rest -join ' ')
    if (-not $To -or -not $text) { Usage }
    $id = ('{0}-{1}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), ([guid]::NewGuid().ToString('N').Substring(0, 8)))
    $json = [ordered]@{ from = $env:ADE_PANE_ID; to = $To; text = $text } | ConvertTo-Json -Compress
    $out = Join-Path $box 'outbox'
    $part = Join-Path $out "$id.part"
    [IO.File]::WriteAllText($part, $json, (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $part -Destination (Join-Path $out "$id.json")
    $receipt = Join-Path (Join-Path $box 'receipts') "$id.txt"
    for ($i = 0; $i -lt 50; $i++) {
      if (Test-Path $receipt) { $r = Get-Content -Raw -Encoding UTF8 $receipt; Remove-Item -LiteralPath $receipt -ErrorAction SilentlyContinue; Write-Output $r.Trim(); if ($r.StartsWith('ok')) { exit 0 } else { exit 1 } }
      Start-Sleep -Milliseconds 200
    }
    Write-Output 'in coda: ADE non ha ancora confermato la consegna'
    exit 0
  }
  default { Usage }
}
"#;

/// Windows, for shells that look for `.cmd` (cmd, PowerShell via PATHEXT).
const CMD: &str = "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0ade-msg.ps1\" %*\r\n";

/// Git Bash on Windows (Claude Code's shell there) forwards to the PowerShell
/// script; on macOS and Linux it is the implementation.
const SH: &str = r#"#!/bin/sh
# ade-msg — send a message to another ADE session. Written by ADE; do not edit.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$(dirname "$0")/ade-msg.ps1" 2>/dev/null || echo "$(dirname "$0")/ade-msg.ps1")" "$@" ;;
esac
box="$ADE_MAILBOX"
if [ -z "$box" ] || [ ! -d "$box" ]; then echo "ade-msg: questa shell non e' una sessione avviata da ADE (ADE_MAILBOX mancante)." >&2; exit 2; fi
usage() { printf 'uso:\n  ade-msg list\n  ade-msg send <sessione> <testo>\n  ade-msg whoami\n'; exit 1; }
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//'; }
case "$1" in
  list) if [ -f "$box/sessions.txt" ]; then cat "$box/sessions.txt"; else echo "nessuna sessione pubblicata"; fi ;;
  whoami) echo "$ADE_PANE_ID" ;;
  send)
    to="$2"; shift 2 2>/dev/null || usage; text="$*"
    [ -n "$to" ] && [ -n "$text" ] || usage
    id="$(date +%s)000-$$"
    printf '{"from":"%s","to":"%s","text":"%s"}' "$(esc "$ADE_PANE_ID")" "$(esc "$to")" "$(esc "$text")" > "$box/outbox/$id.part"
    mv "$box/outbox/$id.part" "$box/outbox/$id.json"
    i=0
    while [ $i -lt 50 ]; do
      if [ -f "$box/receipts/$id.txt" ]; then r="$(cat "$box/receipts/$id.txt")"; rm -f "$box/receipts/$id.txt"; echo "$r"; case "$r" in ok*) exit 0 ;; *) exit 1 ;; esac; fi
      sleep 0.2; i=$((i+1))
    done
    echo "in coda: ADE non ha ancora confermato la consegna" ;;
  *) usage ;;
esac
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_id_cannot_become_a_path() {
        assert!(valid_id("1757860000000-ab12cd34"));
        assert!(valid_id("1757860000000-4242"));
        for bad in ["", "../x", "a/b", "a\\b", "a.json", &"1".repeat(81)] {
            assert!(!valid_id(bad), "{bad} was accepted");
        }
    }
}
