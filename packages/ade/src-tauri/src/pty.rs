/// Agent CLIs, run in a real terminal.
///
/// The shell plugin can already start a process and read its pipes, and for git
/// that is exactly right. It is wrong for an agent: every one of these CLIs asks
/// whether it is talking to a terminal, and when the answer is "a pipe" they all
/// change into something else. Claude Code switches itself into `--print`, waits
/// three seconds for piped input and exits 1; the others drop their prompt, or
/// their colours, or their permission questions. A session that cannot be typed
/// into is not a session, so ADE gives each one a pseudo-terminal instead.
///
/// The web side owns the terminal emulator and the session ids. This module owns
/// only the ConPTY (or the unix pty), one reader thread per session, and the
/// registry that lets `write`, `resize` and `kill` find their master again.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::{AppHandle, Emitter, Manager};

/// One live pseudo-terminal, kept only so later calls can reach it.
struct Session {
    master: Box<dyn MasterPty + Send>,
    /*
     * Behind a lock of its own, so writing to one session never holds the lock
     * that every other session's spawn, resize and kill has to take. A write to
     * a pty blocks for as long as the child refuses to read its stdin, and a
     * suspended agent is an ordinary thing rather than a rare one.
     */
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Session>>);

#[derive(Clone, serde::Serialize)]
struct Chunk {
    id: String,
    /// Raw terminal output, escape sequences included: the emulator on the other
    /// side needs them, so nothing here tries to be helpful and strip them.
    data: String,
}

#[derive(Clone, serde::Serialize)]
struct Exit {
    id: String,
    code: Option<i32>,
}

/*
 * What this window is allowed to start.
 *
 * `capabilities/default.json` allowlists the shell plugin and lib.rs calls that
 * allowlist the security model, but none of it reaches this far: a pty is opened
 * by the command below, not by the plugin, so without a list of its own
 * `pty_spawn` starts whatever it is handed. That matters because the caller is
 * not only ADE's own interface — anything running in the browser pane's frame
 * can invoke it, and "whatever it is handed" is then the whole machine.
 *
 * Bare names, matched before the PATH lookup adds a directory or an extension.
 * Keep in step with `src/session-new/agents.ts`, the catalogue the new-session
 * form offers: a name added there and not here cannot start.
 */
const ALLOWED_AGENTS: &[&str] = &[
    "claude", "codex", "opencode", "nikcli", "agy", "kimi", "prime", "pi", "ohmypi",
    "hermes",
];

/// Environment an agent must not inherit from whatever launched ADE.
///
/// Prefixes, matched from the start of the name: a session marker set by one
/// agent CLI is not something the next one should read, and the messaging
/// socket and token under `CLAUDE_CODE_` are credentials scoped to a session
/// that is not this one.
const INHERITED_SESSION_MARKERS: &[&str] = &["CLAUDE_CODE_", "CLAUDECODE", "CLAUDE_PID"];

/// Colour switches that describe the output of whatever launched ADE, not the
/// pty an agent is given.
///
/// Whole names, any case. A shell whose output goes to a pipe — an agent's
/// tool shell, a bench runner — sets these, and ADE inherits them. Claude Code
/// reads `NO_COLOR` without `FORCE_COLOR` as "no colour at all", so a session in
/// a pane that is a real 24-bit terminal came out white on black, logo included.
/// Without them each CLI decides from the terminal it is actually in.
const INHERITED_COLOUR_SWITCHES: &[&str] = &["NO_COLOR", "FORCE_COLOR", "NODE_DISABLE_COLORS"];

fn is_launcher_colour_switch(key: &str) -> bool {
    INHERITED_COLOUR_SWITCHES
        .iter()
        .any(|name| name.eq_ignore_ascii_case(key))
}

/*
 * How often a session's output reaches the window, and how much may wait.
 *
 * Roughly one animation frame. Below this the extra messages are redraws
 * nobody sees; above it a person typing feels the terminal lag behind their
 * keystrokes, which is the one thing a terminal may not do.
 */
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

/// A burst past this goes out immediately rather than waiting for the tick.
const MAX_PENDING: usize = 256 * 1024;

/**
 * The event a session's output arrives on.
 *
 * One topic per session rather than one shared `pty:data` that every pane
 * filters. With six sessions running, a shared topic meant every chunk woke
 * six listeners so that five of them could compare an id and return — per
 * chunk, per frame, on the thread that draws.
 */
pub fn data_topic(id: &str) -> String {
    format!("pty:data:{id}")
}

/// The shells a terminal pane may open. Named per platform because the list is
/// the point: `$SHELL` is attacker-controllable on a machine already lost, and
/// an arbitrary interpreter is exactly what the allowlist exists to refuse.
#[cfg(windows)]
const ALLOWED_SHELLS: &[&str] = &["cmd", "powershell", "pwsh"];
#[cfg(not(windows))]
const ALLOWED_SHELLS: &[&str] = &["sh", "bash", "zsh", "fish"];

/// The OpenSSH client, for remote Spaces. Its arguments go through `check_args`.
const ALLOWED_REMOTE: &[&str] = &["ssh"];

/// The switches a shell may be started with. Anything else is refused.
///
/// A shell name on the list is not enough: `cmd /c <anything>`,
/// `powershell -EncodedCommand <anything>` and `sh -c <anything>` run a command
/// without ever showing a prompt, and PowerShell also accepts any unambiguous
/// prefix of a parameter (`-enc`, `-comm`) and a bare positional as a command.
/// So shells get a short list of switches that only change how the prompt
/// behaves, compared whole and case-insensitively.
#[cfg(windows)]
const SHELL_SWITCHES: &[(&str, &[&str])] = &[
    ("cmd", &["/q", "/d", "/a", "/u"]),
    ("powershell", &["-nologo", "-noprofile", "-noexit", "-interactive"]),
    ("pwsh", &["-nologo", "-noprofile", "-noexit", "-interactive", "-login", "-l"]),
];
#[cfg(not(windows))]
const SHELL_SWITCHES: &[(&str, &[&str])] = &[
    ("sh", &["-l", "-i", "--login"]),
    ("bash", &["-l", "-i", "--login"]),
    ("zsh", &["-l", "-i", "--login"]),
    ("fish", &["-l", "-i", "--login"]),
];

/// The name `command` is known by: no directory, one executable extension off.
fn command_stem(command: &str) -> &str {
    let name = command.trim();
    match name.rsplit_once('.') {
        Some((head, ext)) if is_executable_extension(ext) => head,
        _ => name,
    }
}

/// A `[user@]host` an ssh session may be opened to, as `~/.ssh/config` and
/// `known_hosts` spell them. Nothing that starts with a dash, so it can never be
/// read as an option.
fn is_ssh_destination(value: &str) -> bool {
    let (user, host) = match value.split_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, value),
    };
    let user_ok = user.map_or(true, |u| {
        !u.is_empty() && u.len() <= 64 && u.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    });
    let host_ok = !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || "._-:[]%".contains(c));
    user_ok && host_ok && !value.starts_with('-')
}

/// The remote command ADE sends to open a shell in a folder, and nothing else.
///
/// `cd -- '<dir>' && exec "$SHELL" -l`, with the folder free of quotes, so the
/// only thing a caller chooses is a path.
fn is_ssh_remote_cd(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("cd -- '") else {
        return false;
    };
    let Some(dir) = rest.strip_suffix("' && exec \"$SHELL\" -l") else {
        return false;
    };
    !dir.is_empty() && dir.len() <= 1024 && !dir.contains('\'') && !dir.chars().any(|c| c.is_control())
}

/// Whether `args` are ones `command` may be started with.
///
/// Agents keep their arguments: they are the programs the user asked for, and
/// what they do next is already theirs to decide. Shells and ssh do not, because
/// for them an argument is a command to run.
///
/// ssh takes `-p <port>`, `-l <user>`, `-t`/`-T`, `-J <destination>`, then one
/// destination and optionally the folder-changing command above. No `-o`, `-F`
/// or `-L`/`-R`/`-D`: `-o ProxyCommand=` and `-F <file>` run a local command,
/// and forwards open ports nobody asked for.
fn check_args(command: &str, args: &[String]) -> Result<(), String> {
    let stem = command_stem(command).to_ascii_lowercase();
    if stem == "ssh" {
        let mut destination = false;
        let mut i = 0;
        while i < args.len() {
            let arg = args[i].as_str();
            if destination {
                if i + 1 == args.len() && is_ssh_remote_cd(arg) {
                    return Ok(());
                }
                return Err(format!("argomento ssh non consentito: {arg}"));
            }
            match arg {
                "-t" | "-T" | "-tt" => {}
                "-p" => {
                    let port = args.get(i + 1).ok_or("porta ssh mancante")?;
                    if port.parse::<u16>().map_or(true, |p| p == 0) {
                        return Err(format!("porta ssh non valida: {port}"));
                    }
                    i += 1;
                }
                "-l" | "-J" => {
                    let value = args.get(i + 1).ok_or("valore ssh mancante")?;
                    let ok = if arg == "-l" {
                        is_ssh_destination(value) && !value.contains('@')
                    } else {
                        value.split(',').all(is_ssh_destination)
                    };
                    if !ok {
                        return Err(format!("valore ssh non valido: {value}"));
                    }
                    i += 1;
                }
                "--" => {}
                _ if is_ssh_destination(arg) => destination = true,
                _ => return Err(format!("argomento ssh non consentito: {arg}")),
            }
            i += 1;
        }
        return if destination { Ok(()) } else { Err("ssh senza destinazione".to_string()) };
    }
    if let Some((_, switches)) = SHELL_SWITCHES.iter().find(|(shell, _)| *shell == stem) {
        for arg in args {
            let lowered = arg.to_ascii_lowercase();
            if !switches.contains(&lowered.as_str()) {
                return Err(format!("argomento della shell non consentito: {arg}"));
            }
        }
    }
    Ok(())
}

/// What the CLI's reporting hook needs to know about this spawn.
///
/// Only the two identifiers: the directory it writes into is ADE's to choose,
/// and is resolved in `pty_spawn` rather than carried here.
#[derive(serde::Deserialize)]
pub struct SpawnLink {
    pub pane: String,
    pub nonce: String,
}

/// True when `command` names something ADE may start.
///
/// The comparison is against the bare name and is case-insensitive, because on
/// Windows `codex` reaches the disk as `codex.cmd` and the caller may have typed
/// either. A name carrying a path separator is refused outright: spelling a
/// binary by its full path is precisely how you would reach one that is not on
/// the list.
fn is_allowed_command(command: &str) -> bool {
    let name = command.trim();
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return false;
    }
    // Strip one trailing executable extension so `cmd.exe` and `cmd` both pass,
    // while `evil.exe.cmd` — two extensions, not a name we know — does not.
    let stem = command_stem(name);
    ALLOWED_AGENTS
        .iter()
        .chain(ALLOWED_SHELLS.iter())
        .chain(ALLOWED_REMOTE.iter())
        .any(|allowed| allowed.eq_ignore_ascii_case(stem))
}

fn is_executable_extension(ext: &str) -> bool {
    ["exe", "cmd", "bat", "com", "ps1"]
        .iter()
        .any(|known| known.eq_ignore_ascii_case(ext))
}

/// Takes everything decodable out of `tail`, leaving at most one incomplete
/// character behind for the next read to finish.
///
/// Two different things make `from_utf8` fail here and they need opposite
/// treatment, which is the whole reason this is a function with tests rather
/// than four lines inside the read loop.
///
/// A read can land in the middle of a multi-byte character — an accented
/// letter, a box-drawing glyph — and that is not an error, it is a boundary:
/// the bytes are kept and the next read completes them. That case was handled.
///
/// A byte that is simply not UTF-8 is a different thing, and it was not. The
/// code drained only up to `valid_up_to()` and never stepped over the bad
/// byte, so with one at the head of the buffer `valid_up_to()` was zero, the
/// drain removed nothing, and every later read failed at the same offset
/// forever: the pane froze on its last frame while the process kept running
/// and burning tokens, and `tail` grew without bound. A `git log` over a
/// latin-1 commit message is enough to do it. Now the bad byte is replaced
/// and skipped — which is what "lossy" was supposed to mean — so the loop
/// always makes progress and `tail` never holds more than three bytes.
fn decode_stream_chunk(tail: &mut Vec<u8>) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(tail) {
            Ok(whole) => {
                text.push_str(whole);
                tail.clear();
                return text;
            }
            Err(error) => {
                let good = error.valid_up_to();
                text.push_str(&String::from_utf8_lossy(&tail[..good]));
                match error.error_len() {
                    // Truncated at the buffer's edge: keep it for next time.
                    None => {
                        tail.drain(..good);
                        return text;
                    }
                    // Genuinely invalid: mark it, step over it, keep going —
                    // one read can carry more than one bad byte.
                    Some(bad) => {
                        text.push('\u{FFFD}');
                        tail.drain(..good + bad);
                    }
                }
            }
        }
    }
}

/// Starts `command` under a pty and streams it to the window as `pty:data`.
///
/// `id` comes from the caller rather than from here because the pane that will
/// display this session already has one, and matching them means the listener
/// can be attached before the first byte arrives — a CLI that greets you in
/// under a millisecond would otherwise lose its greeting.
///
/// `async` for the reason given on `pty_write`: opening a ConPTY, scanning PATH
/// and starting a process are all blocking, and a synchronous command does them
/// on the thread that draws the window.
#[tauri::command]
/*
 * The arguments are the IPC message, so they are not ours to group.
 *
 * Clippy is right that nine is a lot, and wrong about the remedy here:
 * bundling them into a struct changes the shape of the JSON the frontend
 * sends, for the benefit of a signature nobody calls from Rust.
 */
#[allow(clippy::too_many_arguments)]
pub async fn pty_spawn(
    app: AppHandle,
    registry: tauri::State<'_, Registry>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    /*
     * Which pane this is, and which spawn, for the CLI's own reporting hook.
     *
     * Absent when ADE has no hook installed for this agent, which is the
     * normal case: the variables are then not set at all, and a hook the user
     * installed for some other tool sees nothing of ADE's. See
     * `src/session-new/agent-link.ts`.
     */
    link: Option<SpawnLink>,
    /*
     * The pane this process belongs to, for `ade-msg`. The pty id is ADE's
     * own handle and means nothing to another session; the pane id is what
     * `ade-msg list` shows and what a reply is addressed to.
     */
    pane: Option<String>,
    /*
     * A secret for this spawn, which `ade-msg` sends with every message. The
     * pane id is printed by `ade-msg list` for anyone to copy; the token is
     * only in this process tree's environment, so a message that carries it
     * really comes from this pane.
     */
    pane_token: Option<String>,
) -> Result<(), String> {
    if !is_allowed_command(&command) {
        return Err(format!("comando non consentito: {command}"));
    }
    check_args(&command, &args)?;

    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty non creata: {e}"))?;

    /*
     * Resolved here rather than left to the spawner, so the binary that starts
     * is the same one the new-session form said was installed. On Windows that
     * is not a formality: the agent CLIs ship as several files of the same name
     * in the same directory, and only the one PATHEXT picks can actually run.
     */
    let resolved = which_on_path(&command).unwrap_or_else(|| command.clone());
    let mut builder = CommandBuilder::new(&resolved);
    for arg in &args {
        builder.arg(arg);
    }
    if let Some(dir) = cwd.as_ref().filter(|d| !d.is_empty()) {
        builder.cwd(dir);
    }
    /*
     * Two variables every one of these CLIs reads before deciding how to draw.
     * Without TERM the fancier ones fall back to a dumb line mode that renders
     * as a wall of escape codes in the pane; without COLORTERM the ones that do
     * detect truecolour give up on it and the output looks nothing like the same
     * agent run from a real terminal.
     */
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");

    /*
     * Somebody else's session does not come along.
     *
     * ADE can be started from a terminal that already belongs to an agent
     * session, and `CommandBuilder` inherits the environment it finds. The
     * child then reads the parent's markers and behaves as a continuation of
     * it rather than as a new session: Claude Code turns transcript saving off
     * on seeing CLAUDE_CODE_CHILD_SESSION and prints a banner saying so, and
     * every agent ADE starts is handed the parent's live IPC socket and its
     * token — a session-scoped credential, given to processes that have no
     * business with it.
     *
     * The contract at the top of this file is that an agent starts bare, "in a
     * real terminal, exactly as the user would start it themselves". These are
     * the variables that made that untrue.
     */
    for (key, _) in std::env::vars() {
        let is_session_marker = INHERITED_SESSION_MARKERS
            .iter()
            .any(|marker| key == *marker || key.starts_with(marker));

        /*
         * The colour switches belong in the same sweep, and were not in it.
         *
         * `INHERITED_COLOUR_SWITCHES` and `is_launcher_colour_switch` were
         * written for this loop, documented the exact symptom — a session in
         * a real 24-bit pane rendering white on black, logo included — and
         * were then never called from anywhere. The compiler said so, twice,
         * as a `dead_code` warning that had become part of the scenery.
         *
         * They matter because of how ADE is launched: from a shell whose own
         * output goes to a pipe, or from a bench runner, both of which set
         * `NO_COLOR`. The pane is not that pipe.
         */
        if is_session_marker || is_launcher_colour_switch(&key) {
            builder.env_remove(&key);
        }
    }

    /*
     * How the CLI reports which conversation it opened.
     *
     * Set last, after the scrub above, so the loop cannot take them back out.
     * All three or none: the script installed in the CLI's own configuration
     * exits on the first one it does not find, which is what makes it safe to
     * leave installed while the user runs that CLI from an ordinary terminal.
     *
     * The directory is resolved here rather than sent by the frontend, so the
     * only place a hook can write is ADE's own application data.
     */
    /*
     * Messages between sessions: `ade-msg` first on PATH, the mailbox, and
     * who this session is. Also after the scrub, for the same reason as the
     * hook variables below. See `mailbox.rs`.
     */
    if let (Some(pane), Some(bin), Some(box_dir)) = (
        pane.as_ref().filter(|p| !p.is_empty()),
        crate::mailbox::bin_dir(&app),
        crate::mailbox::mailbox_dir(&app),
    ) {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut parts = vec![bin];
        parts.extend(std::env::split_paths(&path));
        if let Ok(joined) = std::env::join_paths(parts) {
            builder.env("PATH", joined);
        }
        builder.env("ADE_PANE_ID", pane);
        builder.env("ADE_MAILBOX", box_dir.as_os_str());
        if let Some(token) = pane_token.as_ref().filter(|t| !t.is_empty()) {
            builder.env("ADE_PANE_TOKEN", token);
        }
    }

    if let Some(link) = link.as_ref() {
        if let Some(dir) = crate::agent_link::link_dir(&app) {
            builder.env("ADE_PANE_ID", &link.pane);
            builder.env("ADE_SPAWN_NONCE", &link.nonce);
            builder.env("ADE_SESSION_DIR", dir.as_os_str());
        }
    }

    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("{command} non parte: {e}"))?;
    // The slave handle has done its job; holding it open would keep the pty
    // alive after the child dies and the reader below would never see EOF.
    drop(pair.slave);

    /*
     * The process is running now, so every failure below has to take it with
     * it. Returning early would drop the handle without ending the process, and
     * dropping a handle does not kill anything on Windows: the child would stay
     * alive with no way to reach it, because the registry never learned its id.
     */
    macro_rules! abort_with {
        ($message:expr) => {{
            let _ = child.kill();
            let _ = child.wait();
            return Err($message);
        }};
    }

    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => abort_with!(format!("pty non leggibile: {e}")),
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => abort_with!(format!("pty non scrivibile: {e}")),
    };

    {
        let mut sessions = match registry.0.lock() {
            Ok(sessions) => sessions,
            Err(_) => abort_with!("registro bloccato".to_string()),
        };
        sessions.insert(
            id.clone(),
            Session {
                master: pair.master,
                writer: Arc::new(Mutex::new(writer)),
                child,
            },
        );
    }

    /*
     * Two threads, not one: a reader that never waits, and a sender that
     * decides how often the window hears about it.
     *
     * One thread emitting per read was one IPC message per 8 KB, and a
     * full-screen agent redrawing its frame produces those faster than the
     * webview can take them: every message is serialised, crosses the
     * boundary, wakes JavaScript, and is written into xterm — for frames the
     * user never sees, because the next one lands in the same animation
     * frame. Coalescing them costs a few milliseconds of latency and takes
     * the flood down to sixty messages a second whatever the agent does.
     *
     * The split is what makes the coalescing safe. A single thread would have
     * to decide whether to flush *before* its next blocking read, and an
     * agent that prints one line and falls silent would leave that line sitting
     * in the buffer until it spoke again. The sender's `recv_timeout` has no
     * such problem: the wait ends on its own.
     */
    let (chunk_tx, chunk_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        // See `decode_stream_chunk`.
        let mut buffer = [0u8; 8192];
        /*
         * Output is forwarded as lossy UTF-8 rather than bytes. A read can split
         * a multi-byte character, and `from_utf8_lossy` would then plant a
         * replacement character in the middle of a word that the next read
         * completes. Carrying the tail over keeps the split invisible.
         */
        let mut tail: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    tail.extend_from_slice(&buffer[..n]);
                    let text = decode_stream_chunk(&mut tail);
                    if text.is_empty() {
                        continue;
                    }
                    // The channel closing means the sender is gone, which only
                    // happens when the window is going away.
                    if chunk_tx.send(text).is_err() {
                        break;
                    }
                }
            }
        }
        // Dropping `chunk_tx` here is what tells the sender the pty reached
        // EOF, so it can flush the last frame and report the exit.
    });

    let emitter = app.clone();
    let stream_id = id.clone();
    std::thread::spawn(move || {
        let topic = data_topic(&stream_id);
        let mut pending = String::new();

        let flush = |pending: &mut String| {
            if pending.is_empty() {
                return;
            }
            let _ = emitter.emit(
                &topic,
                Chunk {
                    id: stream_id.clone(),
                    data: std::mem::take(pending),
                },
            );
        };

        loop {
            match chunk_rx.recv_timeout(FLUSH_INTERVAL) {
                Ok(text) => {
                    pending.push_str(&text);
                    // A burst larger than the cap goes out without waiting:
                    // holding megabytes to save a message helps nobody, and a
                    // `cat` of a large file is exactly that case.
                    if pending.len() >= MAX_PENDING {
                        flush(&mut pending);
                    }
                }
                Err(RecvTimeoutError::Timeout) => flush(&mut pending),
                Err(RecvTimeoutError::Disconnected) => {
                    // The last thing it said, before the exit is announced.
                    flush(&mut pending);
                    break;
                }
            }
        }

        let code = app
            .state::<Registry>()
            .0
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&stream_id))
            .and_then(|mut session| session.child.wait().ok())
            .map(|status| status.exit_code() as i32);

        let _ = emitter.emit(
            "pty:exit",
            Exit {
                id: stream_id,
                code,
            },
        );
    });

    Ok(())
}

/// Types `data` into the session exactly as given.
///
/// No newline is appended. What reaches a pty is keystrokes, and an agent's
/// menu answers "y", arrow keys and Ctrl-C are all keystrokes that would be
/// ruined by a helpful terminator: deciding when a line ends belongs to whoever
/// is typing.
///
/// `async` because a synchronous `#[tauri::command]` is dispatched on the
/// thread that owns the window. The write below blocks for as long as the child
/// refuses to read, so on that thread a single suspended agent stopped the
/// whole interface from repainting — every pane, not only its own.
#[tauri::command]
pub async fn pty_write(
    registry: tauri::State<'_, Registry>,
    id: String,
    data: String,
) -> Result<(), String> {
    /*
     * The registry lock is taken to find the writer and released before using
     * it. `write_all` on a pty blocks for as long as the child is not reading
     * its stdin — suspended, or sitting on a prompt nobody answered — and
     * holding the global lock across that would freeze spawn, resize and kill
     * for every other session in the window.
     *
     * The guard lives in a block of its own rather than being dropped by hand:
     * an early `?` between the lookup and the write must release it too.
     */
    let writer = {
        let sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
        let session = sessions.get(&id).ok_or("sessione non trovata")?;
        Arc::clone(&session.writer)
    };

    let mut writer = writer.lock().map_err(|_| "scrittore bloccato")?;
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("scrittura fallita: {e}"))?;
    writer.flush().map_err(|e| format!("flush fallito: {e}"))
}

/// Tells the session how big its terminal is now.
///
/// A CLI that draws a full-screen interface reads this and nothing else: leave
/// it at the size the pane happened to be when it started and every redraw wraps
/// against a width that stopped being true the moment the user dragged anything.
///
/// `async` like the rest: a resize arrives on every frame of a drag, and it
/// asks the registry for a lock that a write may be holding.
#[tauri::command]
pub async fn pty_resize(
    registry: tauri::State<'_, Registry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
    let session = sessions.get(&id).ok_or("sessione non trovata")?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize fallito: {e}"))
}

/// Ends the session. Safe to call on one that already ended.
///
/// `async` because `wait()` below is exactly as blocking as the write is: a
/// child that takes its time dying would otherwise take the window with it.
#[tauri::command]
pub async fn pty_kill(registry: tauri::State<'_, Registry>, id: String) -> Result<(), String> {
    let mut session = {
        let mut sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
        sessions.remove(&id)
    };
    if let Some(session) = session.as_mut() {
        let _ = session.child.kill();
        /*
         * Reaped here rather than left to the reader thread, which cannot do it:
         * removing the session above is what makes that thread's own lookup miss,
         * so nobody else will ever wait on this child and on unix it stays a
         * zombie until ADE itself exits.
         */
        let _ = session.child.wait();
    }
    Ok(())
}

/// Reports whether `command` can be found and started at all.
///
/// Kept separate from `pty_spawn` because "is this agent installed" is a
/// question the new-session form asks about every agent at once, and doing it by
/// opening ten pseudo-terminals would be an absurd way to find out.
///
/// `async` for the same reason as the others, and here the cost is multiplied:
/// the form asks about every agent in the catalogue at once, so a synchronous
/// version walked the whole of PATH ten times over on the thread that draws it.
#[tauri::command]
pub async fn pty_which(command: String) -> Option<String> {
    // Same gate as `pty_spawn`: the form only ever asks about the catalogue, and
    // answering for anything else would turn this into a way to probe the disk
    // from a page loaded in the browser pane.
    if !is_allowed_command(&command) {
        return None;
    }
    which_on_path(&command)
}

/// Shared with `serve`, which has to find the same `nikcli` this module would
/// start — on Windows that means honouring PATHEXT rather than guessing `.exe`.
pub(crate) fn which_on_path(command: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    /*
     * On Windows the agent CLIs are npm shims, and only some of them are .exe.
     * PATHEXT is what the shell would consult, so consulting it here is what
     * makes `opencode` resolve to `opencode.cmd` rather than to nothing.
     */
    #[cfg(windows)]
    let extensions: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect();
    #[cfg(not(windows))]
    let extensions: Vec<String> = vec![String::new()];

    for dir in std::env::split_paths(&path) {
        /*
         * Extensions before the bare name, and that order is the whole point on
         * Windows. npm installs a CLI three times over: `codex.cmd`, `codex.ps1`
         * and an extensionless `codex` shell script for Git Bash. Only the first
         * can be started by CreateProcess, but the extensionless one sits in the
         * same directory and matches first if you look for it first — which
         * reports the agent as installed and then fails to run it.
         */
        for extension in &extensions {
            if extension.is_empty() {
                continue;
            }
            let candidate = dir.join(format!("{command}{extension}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        let base = dir.join(command);
        if base.is_file() {
            return Some(base.to_string_lossy().into_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_whole_chunk_and_keeps_nothing() {
        let mut tail = b"ciao\r\n".to_vec();
        assert_eq!(decode_stream_chunk(&mut tail), "ciao\r\n");
        assert!(tail.is_empty());
    }

    #[test]
    fn carries_a_split_character_over_to_the_next_read() {
        // "è" is two bytes; the read landed between them.
        let full = "perché".as_bytes();
        let split = full.len() - 1;

        let mut tail = full[..split].to_vec();
        let first = decode_stream_chunk(&mut tail);
        assert_eq!(first, "perch");
        // The incomplete character is held, not replaced.
        assert_eq!(tail.len(), 1);
        assert!(!first.contains('\u{FFFD}'));

        tail.extend_from_slice(&full[split..]);
        assert_eq!(decode_stream_chunk(&mut tail), "é");
        assert!(tail.is_empty());
    }

    /*
     * The freeze. A byte that is not UTF-8 at the head of the buffer left
     * `valid_up_to()` at zero, so the old code drained nothing and every
     * later read failed at the same offset: the pane stopped updating for
     * good while the process kept running, and the buffer grew without end.
     */
    #[test]
    fn steps_over_an_invalid_byte_instead_of_stalling_on_it() {
        let mut tail = vec![0xFF];
        tail.extend_from_slice(b"dopo");

        let text = decode_stream_chunk(&mut tail);

        assert!(text.contains('\u{FFFD}'), "the bad byte should be marked");
        assert!(text.ends_with("dopo"), "output after it must survive");
        assert!(tail.is_empty(), "the bad byte must not be left behind");
    }

    #[test]
    fn a_lone_invalid_byte_does_not_block_later_reads() {
        let mut tail = vec![0xFE];
        assert!(!decode_stream_chunk(&mut tail).is_empty());
        assert!(tail.is_empty());

        // The next read must behave as though nothing had happened.
        tail.extend_from_slice(b"ok");
        assert_eq!(decode_stream_chunk(&mut tail), "ok");
    }

    #[test]
    fn survives_several_invalid_bytes_in_one_read() {
        let mut tail = b"a".to_vec();
        tail.extend_from_slice(&[0xFF, 0xFE]);
        tail.extend_from_slice("b".as_bytes());

        let text = decode_stream_chunk(&mut tail);

        assert_eq!(text.matches('\u{FFFD}').count(), 2);
        assert!(text.starts_with('a') && text.ends_with('b'));
        assert!(tail.is_empty());
    }

    #[test]
    fn accepts_every_agent_in_the_catalogue() {
        for agent in ALLOWED_AGENTS {
            assert!(is_allowed_command(agent), "{agent} should be startable");
        }
        for shell in ALLOWED_SHELLS {
            assert!(is_allowed_command(shell), "{shell} should be startable");
        }
    }

    #[test]
    fn accepts_the_windows_spelling_of_an_allowed_name() {
        // What the caller has in hand may already carry the extension PATHEXT
        // would have added, and both spellings name the same binary.
        assert!(is_allowed_command("codex.cmd"));
        assert!(is_allowed_command("CLAUDE.EXE"));
        assert!(is_allowed_command("Claude"));
    }

    #[test]
    fn a_session_listens_on_a_topic_of_its_own() {
        // The shape `host/shell.ts` builds on the other side. A topic that
        // did not match would be a pane that draws nothing, with no error
        // anywhere: the listener simply never fires.
        assert_eq!(data_topic("n1700000000-1"), "pty:data:n1700000000-1");
    }

    #[test]
    fn refuses_a_command_that_is_not_in_the_catalogue() {
        assert!(!is_allowed_command("cmd.exe /c calc"));
        assert!(!is_allowed_command("curl"));
        assert!(!is_allowed_command("node"));
        assert!(!is_allowed_command(""));
        assert!(!is_allowed_command("   "));
    }

    #[test]
    fn refuses_a_path_even_when_it_ends_in_an_allowed_name() {
        // The whole point of naming binaries rather than paths: a page that can
        // write a file anywhere must not be able to name it back for execution.
        assert!(!is_allowed_command("/tmp/claude"));
        assert!(!is_allowed_command("C:\\Users\\Public\\claude.exe"));
        assert!(!is_allowed_command("./claude"));
        assert!(!is_allowed_command("..\\claude"));
    }

    #[test]
    fn the_markers_scrubbed_cover_what_a_parent_session_leaks() {
        // The names seen in the wild when ADE is launched from inside another
        // agent's terminal: the marker that makes the child disable transcript
        // saving, and the socket and token that are credentials for a session
        // this child has nothing to do with.
        for leaked in [
            "CLAUDE_CODE_CHILD_SESSION",
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_CODE_MESSAGING_SOCKET",
            "CLAUDE_CODE_MESSAGING_TOKEN",
            "CLAUDE_CODE_ENTRYPOINT",
            "CLAUDECODE",
            "CLAUDE_PID",
        ] {
            assert!(
                INHERITED_SESSION_MARKERS
                    .iter()
                    .any(|marker| leaked == *marker || leaked.starts_with(marker)),
                "{leaked} should not reach a spawned agent"
            );
        }
    }

    #[test]
    fn scrubbing_leaves_the_rest_of_the_environment_alone() {
        // An agent needs the environment it would have had in a terminal —
        // PATH above all, plus whatever the user configured for it.
        for kept in ["PATH", "HOME", "USERPROFILE", "ANTHROPIC_API_KEY", "TERM"] {
            assert!(
                !INHERITED_SESSION_MARKERS
                    .iter()
                    .any(|marker| kept == *marker || kept.starts_with(marker)),
                "{kept} must still be inherited"
            );
        }
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn a_shell_cannot_be_handed_a_command() {
        #[cfg(windows)]
        {
            assert!(check_args("cmd", &strings(&[])).is_ok());
            assert!(check_args("cmd.exe", &strings(&["/Q"])).is_ok());
            assert!(check_args("powershell", &strings(&["-NoLogo"])).is_ok());
            for bad in [&["/c", "calc"][..], &["/K", "calc"], &["/ccalc"]] {
                assert!(check_args("cmd", &strings(bad)).is_err(), "{bad:?}");
            }
            for bad in [&["-enc", "AAAA"][..], &["-Comm", "calc"], &["calc"], &["-File", "x.ps1"]] {
                assert!(check_args("powershell", &strings(bad)).is_err(), "{bad:?}");
                assert!(check_args("pwsh", &strings(bad)).is_err(), "{bad:?}");
            }
        }
        #[cfg(not(windows))]
        {
            assert!(check_args("zsh", &strings(&["-l"])).is_ok());
            assert!(check_args("sh", &strings(&["-c", "id"])).is_err());
            assert!(check_args("bash", &strings(&["script.sh"])).is_err());
        }
    }

    #[test]
    fn agents_keep_their_arguments() {
        assert!(check_args("claude", &strings(&["--model", "opus", "--resume", "x"])).is_ok());
    }

    #[test]
    fn ssh_opens_a_session_to_a_host_and_nothing_else() {
        assert!(check_args("ssh", &strings(&["devbox"])).is_ok());
        assert!(check_args("ssh", &strings(&["-p", "2222", "-l", "niko", "10.0.0.5"])).is_ok());
        assert!(check_args("ssh", &strings(&["-J", "bastion", "niko@host.example.com"])).is_ok());
        assert!(check_args(
            "ssh.exe",
            &strings(&["-t", "devbox", "cd -- '/srv/app' && exec \"$SHELL\" -l"])
        )
        .is_ok());

        for bad in [
            &[][..],
            &["-o", "ProxyCommand=calc", "devbox"],
            &["-oProxyCommand=calc", "devbox"],
            &["-F", "evil.conf", "devbox"],
            &["-L", "8080:localhost:80", "devbox"],
            &["devbox", "rm -rf ~"],
            &["devbox", "cd -- '/x'; rm -rf ~; ' && exec \"$SHELL\" -l"],
            &["-p", "nope", "devbox"],
            &["-J", "-oProxyCommand=calc", "devbox"],
        ] {
            assert!(check_args("ssh", &strings(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn refuses_a_name_that_only_borrows_an_allowed_one() {
        assert!(!is_allowed_command("claude-evil"));
        assert!(!is_allowed_command("notclaude"));
        assert!(!is_allowed_command("evil.exe.cmd"));
        // Stripping one known extension must not uncover a second name.
        assert!(!is_allowed_command("claude.evil"));
    }
}
