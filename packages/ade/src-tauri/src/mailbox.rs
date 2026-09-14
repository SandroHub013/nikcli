//! Sessions talking to each other, whatever CLI each one runs.
//!
//! No CLI has a way to talk to another CLI, and ADE cannot add one to each of
//! them. What they all have is a shell tool and a terminal, so the channel is
//! built from exactly those two things:
//!
//! - every session ADE starts finds `ade-msg` on its PATH, with its own pane id
//!   in `ADE_PANE_ID` and the mailbox in `ADE_MAILBOX`;
//! - `ade-msg send|ask|spawn|reply` drops a JSON file in `outbox/` and waits
//!   for a receipt; `ade-msg list` and `agents` print what ADE last published;
//! - the frontend takes the outbox, types each message into the target pane's
//!   terminal as if the user had, and writes the receipt;
//! - `ask` and `spawn` then keep waiting, the way a subagent call does, for
//!   `results/<id>.txt`, which ADE writes when the other session runs
//!   `ade-msg reply <id>`. The waiter claims it by renaming it; one that is
//!   still there a moment later had nobody waiting, and ADE takes it back
//!   (`<id>.typed`) and types it into the caller instead.
//!
//! This side only moves files. Deciding who a message is for, and what it
//! looks like when it lands, is `src/session/mailbox.ts`, where it is tested.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::Manager;

const MAILBOX_SUBDIR: &str = "mailbox";

/// Receipts and results nobody collected are removed after this long.
const LEFTOVER_TTL: Duration = Duration::from_secs(60 * 60 * 24);

/// A message larger than this is not a message; the file is dropped unread.
const MAX_MESSAGE_BYTES: u64 = 64 * 1024;

pub fn mailbox_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?.join(MAILBOX_SUBDIR);
    for sub in ["outbox", "receipts", "results", "bin"] {
        fs::create_dir_all(dir.join(sub)).ok()?;
    }
    Some(dir)
}

/// The directory prepended to every session's PATH.
pub fn bin_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    mailbox_dir(app).map(|dir| dir.join("bin"))
}

/// Writes the `ade-msg` scripts and clears old leftovers. Called at startup.
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
    for sub in ["receipts", "results"] {
        let Ok(entries) = fs::read_dir(dir.join(sub)) else { continue };
        for entry in entries.flatten() {
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > LEFTOVER_TTL);
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

/// Writes `dir/<name>` whole: a reader polling for the final name never sees half of it.
fn write_whole(dir: PathBuf, name: &str, text: &str) -> Result<(), String> {
    let part = dir.join(format!("{name}.part"));
    fs::write(&part, text).map_err(|e| format!("scrittura fallita: {e}"))?;
    fs::rename(&part, dir.join(name)).map_err(|e| format!("scrittura fallita: {e}"))
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

/// Tells the waiting `ade-msg` what happened to its message.
#[tauri::command]
pub async fn mailbox_receipt(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id messaggio non valido".into());
    }
    let dir = mailbox_dir(&app).ok_or("casella non disponibile")?.join("receipts");
    write_whole(dir, &format!("{id}.txt"), &text)
}

/// The answer to request `id`, for the `ade-msg ask|spawn|wait` blocked on it.
#[tauri::command]
pub async fn mailbox_result(app: tauri::AppHandle, id: String, text: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("id richiesta non valido".into());
    }
    let dir = mailbox_dir(&app).ok_or("casella non disponibile")?.join("results");
    write_whole(dir, &format!("{id}.txt"), &text)
}

/// Takes back an answer nobody claimed, and returns it to be typed instead.
///
/// A rename, like the waiter's claim, so exactly one of the two wins. The
/// answer stays as `<id>.typed`, where a later `ade-msg wait` still finds it.
#[tauri::command]
pub async fn mailbox_result_reclaim(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    if !valid_id(&id) {
        return Err("id richiesta non valido".into());
    }
    let dir = mailbox_dir(&app).ok_or("casella non disponibile")?.join("results");
    let typed = dir.join(format!("{id}.typed"));
    if fs::rename(dir.join(format!("{id}.txt")), &typed).is_err() {
        return Ok(None);
    }
    Ok(fs::read_to_string(&typed).ok())
}

/// Publishes a list `ade-msg` prints: `sessions` for `list`, `agents` for `agents`.
#[tauri::command]
pub async fn mailbox_publish(app: tauri::AppHandle, name: Option<String>, text: String) -> Result<(), String> {
    let name = match name.as_deref() {
        None | Some("sessions") => "sessions",
        Some("agents") => "agents",
        Some(_) => return Err("elenco sconosciuto".into()),
    };
    let dir = mailbox_dir(&app).ok_or("casella non disponibile")?;
    write_whole(dir, &format!("{name}.txt"), &text)
}

/// Windows: the implementation. Plain PowerShell 5.1, no modules.
///
/// `$args`, not a `param` block: with named parameters a message containing
/// `-To` or `-Command` would be bound as one of them.
const PS1: &str = r#"# ade-msg — talk to the other ADE sessions. Written by ADE; do not edit.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$utf8 = New-Object Text.UTF8Encoding $false
$box = $env:ADE_MAILBOX
if (-not $box -or -not (Test-Path $box)) { [Console]::Error.WriteLine('ade-msg: questa shell non e'' una sessione avviata da ADE (ADE_MAILBOX mancante).'); exit 2 }

function Usage {
  Write-Output "uso:`n  ade-msg list                            sessioni aperte`n  ade-msg send  <sessione> <testo>        nota, non aspetta risposta`n  ade-msg ask   <sessione> <richiesta>    aspetta la risposta e la stampa`n  ade-msg spawn <agente> <compito>        nuova sessione (subagent), aspetta il risultato`n  ade-msg reply <id> <risultato>          risponde a una richiesta ricevuta`n  ade-msg wait  <id>                      riprende l'attesa di una richiesta`n  ade-msg agents | whoami`nask/spawn/wait accettano --timeout <secondi> (predefinito 110)"
  exit 1
}

$all = @($args | ForEach-Object { [string]$_ })
$cmd = if ($all.Count -gt 0) { $all[0] } else { '' }
$timeout = 110
$pos = New-Object System.Collections.Generic.List[string]
for ($i = 1; $i -lt $all.Count; $i++) {
  if ($pos.Count -le 1 -and $all[$i] -eq '--timeout' -and ($i + 1) -lt $all.Count) {
    try { $timeout = [int]$all[$i + 1] } catch { Usage }
    $i++
    continue
  }
  $pos.Add($all[$i])
}
$head = if ($pos.Count -gt 0) { $pos[0] } else { '' }
$text = if ($pos.Count -gt 1) { ($pos.GetRange(1, $pos.Count - 1)) -join ' ' } else { '' }

function Post($fields) {
  $id = ('{0}-{1}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), ([guid]::NewGuid().ToString('N').Substring(0, 8)))
  $fields['from'] = $env:ADE_PANE_ID
  $json = $fields | ConvertTo-Json -Compress
  $out = Join-Path $box 'outbox'
  $part = Join-Path $out "$id.part"
  [IO.File]::WriteAllText($part, $json, $utf8)
  Move-Item -LiteralPath $part -Destination (Join-Path $out "$id.json")
  return $id
}

# The receipt: what ADE did with the message. $null when ADE has not answered yet.
function Receipt($id) {
  $receipt = Join-Path (Join-Path $box 'receipts') "$id.txt"
  for ($i = 0; $i -lt 50; $i++) {
    if (Test-Path $receipt) {
      $r = [IO.File]::ReadAllText($receipt, $utf8)
      Remove-Item -LiteralPath $receipt -ErrorAction SilentlyContinue
      return $r.Trim()
    }
    Start-Sleep -Milliseconds 200
  }
  return $null
}

# Blocks until the answer to $id arrives, and prints it as this command's output.
function Await($id) {
  $dir = Join-Path $box 'results'
  $ready = Join-Path $dir "$id.txt"
  $taken = Join-Path $dir "$id.taken"
  $typed = Join-Path $dir "$id.typed"
  $deadline = [DateTime]::UtcNow.AddSeconds($timeout)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path $ready) {
      $claimed = $true
      try { Move-Item -LiteralPath $ready -Destination $taken -Force } catch { $claimed = $false }
      if ($claimed) {
        $r = [IO.File]::ReadAllText($taken, $utf8)
        Remove-Item -LiteralPath $taken -ErrorAction SilentlyContinue
        Write-Output $r
        exit 0
      }
    }
    if (Test-Path $typed) {
      $r = [IO.File]::ReadAllText($typed, $utf8)
      Remove-Item -LiteralPath $typed -ErrorAction SilentlyContinue
      Write-Output $r
      exit 0
    }
    Start-Sleep -Milliseconds 250
  }
  Write-Output "ancora in corso: la richiesta $id non ha ancora una risposta. Riprendi l'attesa con: ade-msg wait $id (se la risposta arriva mentre non stai aspettando, ADE la scrive nel tuo terminale)"
  exit 0
}

switch ($cmd) {
  'list' { $f = Join-Path $box 'sessions.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessuna sessione pubblicata' }; exit 0 }
  'agents' { $f = Join-Path $box 'agents.txt'; if (Test-Path $f) { [IO.File]::ReadAllText($f, $utf8) } else { Write-Output 'nessun agente pubblicato' }; exit 0 }
  'whoami' { Write-Output $env:ADE_PANE_ID; exit 0 }
  'send' {
    if (-not $head -or -not $text) { Usage }
    $id = Post ([ordered]@{ kind = 'send'; to = $head; text = $text })
    $r = Receipt $id
    if ($null -eq $r) { Write-Output 'in coda: ADE non ha ancora confermato la consegna'; exit 0 }
    Write-Output $r
    if ($r.StartsWith('ok')) { exit 0 } else { exit 1 }
  }
  { $_ -eq 'ask' -or $_ -eq 'spawn' } {
    if (-not $head -or -not $text) { Usage }
    $fields = if ($cmd -eq 'ask') { [ordered]@{ kind = 'ask'; to = $head; text = $text } } else { [ordered]@{ kind = 'spawn'; agent = $head; text = $text } }
    $id = Post $fields
    $r = Receipt $id
    if ($null -ne $r -and -not $r.StartsWith('ok')) { Write-Output $r; exit 1 }
    if ($null -eq $r) { [Console]::Error.WriteLine("ade-msg: richiesta $id in coda, ADE non l'ha ancora consegnata") }
    else { [Console]::Error.WriteLine("ade-msg: $r (richiesta $id), in attesa della risposta...") }
    Await $id
  }
  'reply' {
    if (-not $head -or -not $text) { Usage }
    $id = Post ([ordered]@{ kind = 'reply'; ref = $head; text = $text })
    $r = Receipt $id
    if ($null -eq $r) { Write-Output 'in coda: ADE non ha ancora confermato la risposta'; exit 0 }
    Write-Output $r
    if ($r.StartsWith('ok')) { exit 0 } else { exit 1 }
  }
  'wait' {
    if (-not $head -or $head -notmatch '^[A-Za-z0-9_-]{1,80}$') { Usage }
    Await $head
  }
  default { Usage }
}
"#;

/// Windows, for shells that look for `.cmd` (cmd, PowerShell via PATHEXT).
const CMD: &str = "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0ade-msg.ps1\" %*\r\n";

/// Git Bash on Windows (Claude Code's shell there) forwards to the PowerShell
/// script; on macOS and Linux it is the implementation.
const SH: &str = r#"#!/bin/sh
# ade-msg — talk to the other ADE sessions. Written by ADE; do not edit.
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*)
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$(dirname "$0")/ade-msg.ps1" 2>/dev/null || echo "$(dirname "$0")/ade-msg.ps1")" "$@" ;;
esac
box="$ADE_MAILBOX"
if [ -z "$box" ] || [ ! -d "$box" ]; then echo "ade-msg: questa shell non e' una sessione avviata da ADE (ADE_MAILBOX mancante)." >&2; exit 2; fi
usage() {
  printf 'uso:\n  ade-msg list\n  ade-msg send  <sessione> <testo>\n  ade-msg ask   <sessione> <richiesta>\n  ade-msg spawn <agente> <compito>\n  ade-msg reply <id> <risultato>\n  ade-msg wait  <id>\n  ade-msg agents | whoami\nask/spawn/wait accettano --timeout <secondi> (predefinito 110)\n'
  exit 1
}
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//'; }
cmd="$1"; [ $# -gt 0 ] && shift
timeout=110
[ "$1" = "--timeout" ] && [ -n "$2" ] && { timeout="$2"; shift 2; }
head="$1"; [ $# -gt 0 ] && shift
[ "$1" = "--timeout" ] && [ -n "$2" ] && { timeout="$2"; shift 2; }
text="$*"

post() {
  id="$(date +%s)000-$$"
  printf '{"from":"%s",%s,"text":"%s"}' "$(esc "$ADE_PANE_ID")" "$1" "$(esc "$text")" > "$box/outbox/$id.part"
  mv "$box/outbox/$id.part" "$box/outbox/$id.json"
}
receipt() {
  r=""; i=0
  while [ $i -lt 50 ]; do
    if [ -f "$box/receipts/$id.txt" ]; then r="$(cat "$box/receipts/$id.txt")"; rm -f "$box/receipts/$id.txt"; return 0; fi
    sleep 0.2; i=$((i+1))
  done
  return 1
}
await() {
  end=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$end" ]; do
    if [ -f "$box/results/$1.txt" ] && mv "$box/results/$1.txt" "$box/results/$1.taken" 2>/dev/null; then
      cat "$box/results/$1.taken"; echo; rm -f "$box/results/$1.taken"; exit 0
    fi
    if [ -f "$box/results/$1.typed" ]; then cat "$box/results/$1.typed"; echo; rm -f "$box/results/$1.typed"; exit 0; fi
    sleep 0.25
  done
  echo "ancora in corso: la richiesta $1 non ha ancora una risposta. Riprendi l'attesa con: ade-msg wait $1"
  exit 0
}

case "$cmd" in
  list) if [ -f "$box/sessions.txt" ]; then cat "$box/sessions.txt"; else echo "nessuna sessione pubblicata"; fi ;;
  agents) if [ -f "$box/agents.txt" ]; then cat "$box/agents.txt"; else echo "nessun agente pubblicato"; fi ;;
  whoami) echo "$ADE_PANE_ID" ;;
  send|reply)
    [ -n "$head" ] && [ -n "$text" ] || usage
    if [ "$cmd" = send ]; then post "\"kind\":\"send\",\"to\":\"$(esc "$head")\""; else post "\"kind\":\"reply\",\"ref\":\"$(esc "$head")\""; fi
    if receipt; then echo "$r"; case "$r" in ok*) exit 0 ;; *) exit 1 ;; esac; fi
    echo "in coda: ADE non ha ancora confermato la consegna" ;;
  ask|spawn)
    [ -n "$head" ] && [ -n "$text" ] || usage
    if [ "$cmd" = ask ]; then post "\"kind\":\"ask\",\"to\":\"$(esc "$head")\""; else post "\"kind\":\"spawn\",\"agent\":\"$(esc "$head")\""; fi
    if receipt; then
      case "$r" in ok*) echo "ade-msg: $r (richiesta $id), in attesa della risposta..." >&2 ;; *) echo "$r"; exit 1 ;; esac
    else
      echo "ade-msg: richiesta $id in coda" >&2
    fi
    await "$id" ;;
  wait)
    case "$head" in ''|*[!A-Za-z0-9_-]*) usage ;; esac
    await "$head" ;;
  *) usage ;;
esac
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /*
     * The whole channel rests on this: the PATH set on the builder is the one
     * the child sees. On Windows the inherited variable is spelled `Path`, and
     * a second `PATH` entry beside it would be a coin toss for the child.
     */
    #[cfg(windows)]
    #[test]
    fn a_session_finds_ade_msg_on_its_path() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Read;

        let bin = std::env::temp_dir().join(format!("ade-msg-path-{}", std::process::id()));
        fs::create_dir_all(&bin).expect("a directory");
        fs::write(bin.join("ade-msg-probe.cmd"), "@echo off\r\necho found-it\r\n").expect("a script");

        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize { rows: 24, cols: 200, pixel_width: 0, pixel_height: 0 })
            .expect("a pty");
        let mut builder = CommandBuilder::new("cmd.exe");
        builder.args(["/c", "ade-msg-probe"]);
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut parts = vec![bin.clone()];
        parts.extend(std::env::split_paths(&path));
        builder.env("PATH", std::env::join_paths(parts).expect("a PATH"));

        let mut child = pair.slave.spawn_command(builder).expect("cmd starts");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("a reader");
        let collector = std::thread::spawn(move || {
            let mut out = String::new();
            let mut buf = [0u8; 4096];
            let started = std::time::Instant::now();
            while started.elapsed() < Duration::from_secs(10) {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        out.push_str(&String::from_utf8_lossy(&buf[..n]));
                        if out.contains("found-it") {
                            break;
                        }
                    }
                }
            }
            out
        });
        let _ = child.wait();
        drop(pair.master);
        let out = collector.join().expect("output");
        let _ = fs::remove_dir_all(&bin);
        assert!(out.contains("found-it"), "the child did not find the script: {out}");
    }

    #[test]
    fn a_message_id_cannot_become_a_path() {
        assert!(valid_id("1757860000000-ab12cd34"));
        assert!(valid_id("1757860000000-4242"));
        for bad in ["", "../x", "a/b", "a\\b", "a.json", &"1".repeat(81)] {
            assert!(!valid_id(bad), "{bad} was accepted");
        }
    }
}
