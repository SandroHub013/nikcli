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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

/// One live pseudo-terminal, kept only so later calls can reach it.
struct Session {
    /*
     * Absent for a piped process (`pipe`), which has no terminal to resize. Shared so that a resize can leave the
     * registry's lock before it talks to the console host (RS-8).
     */
    master: Option<Arc<Mutex<Box<dyn MasterPty + Send>>>>,
    /*
     * A queue and not the pipe itself: a write to a pty blocks for as long as the child refuses to read its stdin,
     * and a suspended agent is an ordinary thing rather than a rare one. See `WriteQueue`.
     */
    writer: Arc<WriteQueue>,
    child: Box<dyn Child + Send + Sync>,
    /// What ends the tree if ADE dies without saying so. See `PaneJob`.
    #[allow(dead_code)]
    job: Option<PaneJob>,
}

/// How much may wait for a pane that is not reading before a write is refused.
///
/// Far above anything a person types, or a mail delivery sends, into one pane in the time a healthy child takes to
/// read it. A single write larger than this still goes through when nothing is waiting: a big paste into a pane that
/// is reading is not what this limit is for.
const MAX_QUEUED_WRITE: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct WriteState {
    queued: AtomicUsize,
    /// The session is gone: what is still queued is for nobody.
    closed: AtomicBool,
    failure: Mutex<Option<String>>,
}

/**
 * One session's input: a queue, and one thread that alone touches the pipe.
 *
 * `pty_write` used to write from the async command itself. A child that stops reading blocked `write_all` on a tokio
 * worker with no time limit, and every further keystroke parked another worker on the writer's mutex; once as many
 * keys as cores had been typed, every async command of the window waited, the mailbox's included, until that one
 * child read again. The mutex also let the keys through in whatever order the workers woke (RS-5, RS-6, SES-6).
 *
 * Here the command only enqueues, and a stalled pane costs one parked thread of its own. When the session goes, the
 * pipe breaks under the thread and it ends; anything still queued is dropped, as nobody is left to read it.
 */
struct WriteQueue {
    tx: Sender<Vec<u8>>,
    state: Arc<WriteState>,
}

impl WriteQueue {
    fn new(writer: Box<dyn Write + Send>) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let state = Arc::new(WriteState::default());
        let thread_state = Arc::clone(&state);
        std::thread::spawn(move || write_in_order(writer, &rx, &thread_state));
        Self { tx, state }
    }

    /// Queues `bytes` and returns at once. Never waits for the child.
    fn enqueue(&self, bytes: Vec<u8>) -> Result<(), String> {
        if let Some(failure) = self.state.failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone() {
            return Err(failure);
        }
        let len = bytes.len();
        let waiting = self.state.queued.fetch_add(len, Ordering::SeqCst);
        if waiting > 0 && waiting + len > MAX_QUEUED_WRITE {
            self.state.queued.fetch_sub(len, Ordering::SeqCst);
            return Err(format!("il terminale non sta leggendo: {} KB già in coda", waiting / 1024));
        }
        self.tx.send(bytes).map_err(|_| "sessione chiusa".to_string())
    }
}

impl Drop for WriteQueue {
    fn drop(&mut self) {
        self.state.closed.store(true, Ordering::SeqCst);
    }
}

/// The body of a session's writer thread: every write whole and in the order it was queued.
fn write_in_order(mut writer: Box<dyn Write + Send>, queue: &Receiver<Vec<u8>>, state: &WriteState) {
    while let Ok(bytes) = queue.recv() {
        if state.closed.load(Ordering::SeqCst) {
            return;
        }
        let written = writer.write_all(&bytes).and_then(|_| writer.flush());
        state.queued.fetch_sub(bytes.len(), Ordering::SeqCst);
        if let Err(error) = written {
            // Told to the next write: the page's call has already returned.
            *state.failure.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(format!("scrittura fallita: {error}"));
            return;
        }
    }
}

/*
 * What ends a pane's process tree when ADE itself goes without ending it.
 *
 * `kill_tree` needs ADE alive to run. A crash, a kill from Task Manager or `test:app stop`, or the NSIS setup that
 * ends every `ade-desktop.exe` by name left the agents running headless, with their MCP servers and dev servers
 * holding ports and worktree files (RS-4). A job with KILL_ON_JOB_CLOSE closes when ADE's last handle to it does, and
 * the kernel closes that however the process ends. The descendants inherit the job; ADE itself is never in it, or
 * the job would take the update's installer with it.
 *
 * Only for that. Dropping this value, which only a living ADE can do, takes the kill back first, so a pane that ends
 * while ADE runs ends as it always has: `kill_tree` for a close, nothing for a program that exits by itself. Closing
 * a Terminal pane must not take with it the VS Code that `code .` started from it, nor a daemon that other panes
 * share. No process is meant to outlive a deliberate relaunch either: suspending, relaunching and restoring a pane
 * all kill the old tree and spawn a new one, under a new job, and resume by conversation id.
 *
 * A job that cannot be made or joined is no reason to refuse a pane: it runs unguarded, as before. The child is
 * joined right after it starts, not started suspended (portable-pty has no such option), so anything it created in
 * those microseconds would stay out: a process that has not finished loading has not created anything yet.
 */
struct PaneJob(crate::ChildTreeGuard);

impl PaneJob {
    fn around(pid: Option<u32>) -> Option<Self> {
        let job = crate::ChildTreeGuard::for_pane().ok()?;
        job.assign_pid(pid?).ok()?;
        Some(Self(job))
    }
}

impl Drop for PaneJob {
    fn drop(&mut self) {
        self.0.release();
    }
}

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, Session>>, AtomicU64);

impl Registry {
    fn generation(&self) -> u64 {
        self.1.load(Ordering::SeqCst)
    }

    fn insert_current(&self, _born: u64, id: String, session: Session) -> Result<(), Session> {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(id, session);
        Ok(())
    }

    /// Takes every session out, so nothing can reach them any more.
    fn take_all(&self) -> Vec<Session> {
        let mut sessions = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        sessions.drain().map(|(_, session)| session).collect()
    }

    /*
     * Ends every session: for when the page that started them is gone.
     *
     * The page is the only owner of a pty. It holds the ids, the listeners
     * and the panes; Rust holds the process. A reload (F5, Ctrl+R and the
     * context menu's Reload all work in a release: WebView2's accelerator
     * keys and default menus are left on) throws the page away and the new
     * one restores its panes by spawning again, so every process of the old
     * page ran on with no one to read it or kill it: four cmd for two panes.
     * Closing ADE did not end them either, beyond what ConPTY's own
     * teardown does to the direct child.
     *
     * The whole tree, as closing a pane does: an agent's own children
     * outlive a kill of the agent alone.
     */
    pub fn end_all(&self) -> usize {
        end_sessions(self.take_all(), END_WAIT)
    }

    /*
     * The same, with the killing off the calling thread.
     *
     * The sessions are taken at once, on the caller's thread: a page-load
     * handler that only started a thread could have that thread take a
     * session the new page had already spawned. Walking the process table
     * for each tree is what takes time, and that is what moves off.
     */
    pub fn end_all_in_background(&self) -> usize {
        let sessions = self.take_all();
        let count = sessions.len();
        if count > 0 {
            std::thread::spawn(move || end_sessions(sessions, END_WAIT));
        }
        count
    }
}

/// How long ending sessions waits for them.
const END_WAIT: Duration = Duration::from_secs(5);

/*
 * Ends these sessions and their trees, within `limit`, and says how many there were.
 *
 * One look at the process table for all of them: it is a walk of the whole system, and one per pane added up (RS-12).
 * Then each waits on a thread of its own, because `wait()` has no limit and closing a pseudo console waits for its
 * console host. On `RunEvent::Exit` that is the main thread, and before an update it is what the setup is waiting for,
 * so one stuck session held ADE's end and every other session's (RS2-3).
 *
 * A thread still stuck past the limit keeps its session, and with it the job, the last of the fields: when ADE exits
 * the kernel closes the job and the tree dies.
 */
fn end_sessions(sessions: Vec<Session>, limit: Duration) -> usize {
    let count = sessions.len();
    if count == 0 {
        return 0;
    }
    let roots: Vec<u32> = sessions.iter().filter_map(|session| session.child.process_id()).collect();
    kill_trees_keeping(&roots, true);
    let (answer, answers) = std::sync::mpsc::channel::<()>();
    for mut session in sessions {
        let answer = answer.clone();
        std::thread::spawn(move || {
            let _ = session.child.kill();
            // Reaped here: the reader thread's lookup now misses, and nobody else will wait on it.
            let _ = session.child.wait();
            drop(session);
            let _ = answer.send(());
        });
    }
    drop(answer);
    let deadline = Instant::now() + limit;
    for _ in 0..count {
        if answers.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() {
            break;
        }
    }
    count
}

/*
 * What a session says to its page, on a channel of its own (`host/shell.ts` reads it).
 *
 * Not events. An event reaches the page as a script with the whole payload as a literal inside, and V8 keeps a script's
 * source and its literals in the old space, about twice the bytes of a flood: 2 GB of output took the renderer past
 * 2 GB (live test of 2026-11-02). A channel's message over 8 KB is fetched by a small script instead.
 *
 * The exit shares the channel because a channel delivers by index: it cannot overtake a chunk still being fetched, and
 * the page stops reading at the exit.
 */
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyEvent {
    Data {
        /// Raw terminal output, escape sequences included: the emulator on the other
        /// side needs them, so nothing here tries to be helpful and strip them.
        data: String,
        /// How many bytes `data` is in UTF-8: what the page hands back to `pty_ack` once the terminal has written it.
        bytes: usize,
    },
    Exit {
        code: Option<i32>,
    },
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
    "claude", "codex", "opencode", "ragu", "grok", "agy", "kimi", "prime", "pi", "ohmypi",
    "hermes",
    "freebuff", "cline", "crush", "kilo", "goose", "copilot", "t3", "cursor-agent",
    // The other names of `ALTERNATIVE_COMMANDS`: what the new-session form looks up when the first name is absent.
    "prime-agent", "omp",
];

/// The other names an agent's program goes by, tried in order after the name the page asks for.
///
/// Prime Agent's installer puts `prime-agent` on PATH and oh-my-pi's puts `omp`, while ADE started with `prime` and
/// `ohmypi`. The page keeps asking for the first name (a key, a hook, the activity extension are all keyed on it) and
/// the program that starts is the first of these that exists. Keep in step with `alternatives` in
/// `src/session-new/agents.ts`; `allowlist.test.ts` compares them.
const ALTERNATIVE_COMMANDS: &[(&str, &[&str])] = &[("prime", &["prime-agent"]), ("ohmypi", &["omp"])];

/// `command` resolved through `which`: itself (`ragu` falling back to the nikcli of before the rename), else the
/// first of its alternative names that exists.
fn resolve_command(command: &str, which: impl Fn(&str) -> Option<String>) -> Option<String> {
    crate::legacy_cli::resolve(command, &which).or_else(|| {
        let name = command_stem(command.trim());
        ALTERNATIVE_COMMANDS
            .iter()
            .find(|(first, _)| first.eq_ignore_ascii_case(name))
            .and_then(|(_, others)| others.iter().find_map(|other| which(*other)))
    })
}

/// Environment ADE sets for one agent CLI, whatever the user's shell has.
///
/// ragu attaches to a shared background server by default (`ragu serve
/// --service`), started by whichever ragu ran first, even from another pane
/// or another day. Its tools then run in that server's process, with that
/// process's environment: `ade-msg` answered for the wrong pane (a reply was
/// refused as "not made to this session"), read another pane's inbox (the
/// reminders never stopped), or was not on PATH at all. `RAGU_SERVICE=0` is
/// ragu's own switch for a private in-process server, which is the pane's
/// process and carries the pane's `ADE_PANE_ID`, token and PATH.
///
/// Claude Code 2.1.284, drawn full screen, takes the whole mouse: one click
/// on a menu entry chose and confirmed it, a permission among them.
/// `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` is Claude's own switch that keeps the
/// wheel and drops the clicks; the pane gives the left button back to ADE
/// (`programHasWheelOnly` in `terminal/registry.ts`), where a click takes two
/// (`menu-click.ts`). Only in the panes ADE starts: never the user's settings.
///
/// `CLAUDE_CODE_NATIVE_CURSOR=1`: Claude Code hides the terminal's cursor unless
/// a remote flag says otherwise, and ADE reads its input box by that cursor
/// (`session/composer.ts`). Without it the reading rests on the position alone.
fn agent_env(command: &str) -> &'static [(&'static str, &'static str)] {
    let stem = command_stem(command.trim());
    // Both names, and the nikcli of before ragu's rename too (`legacy_cli`).
    if crate::legacy_cli::is_cli_stem(stem) {
        &[("RAGU_SERVICE", "0"), ("NIKCLI_SERVICE", "0")]
    } else if stem.eq_ignore_ascii_case("claude") {
        &[("CLAUDE_CODE_DISABLE_MOUSE_CLICKS", "1"), ("CLAUDE_CODE_NATIVE_CURSOR", "1")]
    } else {
        &[]
    }
}

/// Variables an `account-plan` or `account-key` spawn must not inherit (B10).
///
/// A subscription must not silently spend a key ADE was started with. A key
/// mode strips the same names first, then sets the one key the user chose.
const CLAUDE_ACCOUNT_VARS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "AWS_BEARER_TOKEN_BEDROCK",
];
const CODEX_ACCOUNT_VARS: &[&str] = &["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"];

/// The variables `flags` take out of the inherited environment, or why one is refused.
///
/// The only flags are an account's (B10). ragu's bot turns used to run with
/// their rules in a variable named by a flag (`RAGU_PERMISSION`); they run
/// on ADE's ragu server now, with the rules of their session (B8d,
/// `serve-rules.ts`), and no spawn sets a variable by name.
///
/// `secret_names` are key names. `secret_envs` are the variables those names
/// stand for, from the index, never their values. A wrong variable is named
/// in the error; a value is not an argument of this function.
pub(crate) fn spawn_flag_effect(
    command: &str,
    flags: &[String],
    secret_names: &[String],
    secret_envs: &[String],
) -> Result<Vec<&'static str>, String> {
    let agent = command_stem(command.trim()).to_ascii_lowercase();
    let mut account: Option<&str> = None;
    for flag in flags {
        if (flag != "account-plan" && flag != "account-key") || account.is_some() || (agent != "claude" && agent != "codex") {
            return Err(format!("opzione di avvio non consentita per {command}: {flag}"));
        }
        account = Some(flag.as_str());
    }
    let remove: Vec<&'static str> = match (account, agent.as_str()) {
        (Some(_), "claude") => CLAUDE_ACCOUNT_VARS.to_vec(),
        (Some(_), "codex") => CODEX_ACCOUNT_VARS.to_vec(),
        (Some(flag), _) => return Err(format!("opzione di avvio non consentita per {command}: {flag}")),
        (None, _) => Vec::new(),
    };
    match account {
        Some("account-key") => {
            if secret_names.len() != 1 {
                return Err("modalità chiave senza una chiave".into());
            }
            // An empty list means the index has not been read yet. `pty_spawn`
            // asks again once `env_for` has named the variable. A value is
            // never an argument of this function.
            if !secret_envs.is_empty() {
                if secret_envs.len() != 1 {
                    return Err("modalità chiave senza una chiave".into());
                }
                let env = secret_envs[0].as_str();
                if agent == "claude" && env != "ANTHROPIC_API_KEY" {
                    return Err("modalità chiave: attesa la variabile ANTHROPIC_API_KEY".into());
                }
                if agent == "codex" && env != "CODEX_API_KEY" && env != "OPENAI_API_KEY" {
                    return Err("modalità chiave: attesa la variabile CODEX_API_KEY o OPENAI_API_KEY".into());
                }
            }
        }
        Some("account-plan") if !secret_names.is_empty() => {
            return Err("un abbonamento non riceve chiavi".into());
        }
        _ => {}
    }
    Ok(remove)
}

/// Variables every terminal ADE opens carries, whatever runs in it.
///
/// `PSExecutionPolicyPreference=Bypass`: the user's choice, D77 A (2026-09-23).
/// `ade-msg` in a PowerShell pane runs `ade-msg.ps1`, not the `.cmd` or sh
/// wrappers that already pass `-ExecutionPolicy Bypass`, and ADE does not
/// launch it: the pane does. On a stock Windows the policy is `Restricted` and
/// no pane could run it; under `RemoteSigned`, an unsigned script in a folder
/// PowerShell treats as remote (Favorites, where ADE Test keeps its mailbox)
/// is refused. `powershell` and `pwsh` read this variable at start as the
/// `Process` scope, which comes before `CurrentUser` and `LocalMachine`, and
/// every PowerShell started under the pane inherits it — agents' shells and
/// hooks too. It is what Claude Code already sets for its own shells.
///
/// The cost, accepted by the user: in ADE's terminals any script runs without
/// a signature check, the same as in Claude Code's shells, and a user in a
/// Terminal pane already runs whatever they like. A policy set by Group Policy
/// (`MachinePolicy`, `UserPolicy`) still wins over this; only signing the
/// script would help there. See `briefs/S78-correzione.md`.
const PANE_ENV: &[(&str, &str)] = &[("PSExecutionPolicyPreference", "Bypass")];

fn apply_pane_env(builder: &mut CommandBuilder) {
    for (key, value) in PANE_ENV {
        builder.env(key, value);
    }
}

/// Environment an agent must not inherit from whatever launched ADE.
///
/// Whole names, any case: a session marker set by one agent CLI is not
/// something the next one should read, and the messaging socket and token are
/// credentials scoped to a session that is not this one. `ADE_MAILBOX_ROOT` is
/// `test:app`'s choice for one ADE Test: a `native:dev` started from a session
/// inside it would otherwise share that mailbox.
///
/// Not the whole `CLAUDE_CODE_` prefix any more (review, MEDIO 7): under it are
/// the user's own settings too — `CLAUDE_CODE_USE_BEDROCK`, `_USE_VERTEX`,
/// the OAuth token's variable, `CLAUDE_CODE_GIT_BASH_PATH` — and Claude Code in
/// a pane lost them: another provider, another login, no Git Bash. (The token's
/// name is spelt in pieces in the test: ADE's source never names a CLI's
/// credential, `bots/terms.test.ts`.)
///
/// The Claude Code names are the ones it puts on every command it runs
/// (2.1.283: `CLAUDECODE`, `AI_AGENT`, `CLAUDE_CODE_SESSION_ID`,
/// `_CHILD_SESSION`, `_SESSION_ATTENDED`, `CLAUDE_PID`, `TRACEPARENT`,
/// `_EXECPATH`, `CLAUDE_EFFORT`, `_INVOKED_SKILLS`), plus its messaging and IDE
/// ones. Not `GIT_EDITOR`, `TMP` and the like, which it sets too: those are
/// also the user's.
const INHERITED_SESSION_MARKERS: &[&str] = &[
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_INVOKED_SKILLS",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
    "TRACEPARENT",
    "ADE_MAILBOX_ROOT",
    // The identity an ADE gives its own panes. An ADE launched from an agent's pane (ADE Test, driven by an
    // agent) inherits the outer one's: the bots and the auxiliary spawns, which get no pane of their own, would
    // write into the outer ADE's mailbox and activity, a pane «at work» that is not, and resume the wrong
    // conversation (full review 2026-10-06, Rust 10). A pane that has an identity is given its own, after this.
    "ADE_PANE_ID",
    "ADE_PANE_TOKEN",
    "ADE_MAILBOX",
    "ADE_SPAWN_NONCE",
    "ADE_SESSION_DIR",
];

/// Whether `key`, inherited from whatever launched ADE, is another session's.
///
/// Besides the names above, the shapes a new one of Claude Code's takes, so it
/// does not reach the child just because it is new: anything under
/// `CLAUDE_CODE_SESSION_` (its id, its access token, its kind, name and
/// origin) and any `CLAUDE_CODE_…_SESSION_ID` or `_SESSION_UUID` (a bridge's,
/// a host's, a remote or cloud session's). The user's settings that mention a
/// session have other shapes: `_PER_SESSION`, `_SESSIONEND_…`,
/// `_SUPPRESS_SESSION_…`.
fn is_session_marker(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    INHERITED_SESSION_MARKERS.contains(&upper.as_str())
        || upper.starts_with("CLAUDE_CODE_SESSION_")
        || (upper.starts_with("CLAUDE_CODE_") && (upper.ends_with("_SESSION_ID") || upper.ends_with("_SESSION_UUID")))
}

/// Takes out of `builder` what the child must not inherit of `inherited`: other
/// sessions' markers, the launcher's colour switches, and the names the
/// account in use removes.
fn scrub_inherited(builder: &mut CommandBuilder, inherited: impl IntoIterator<Item = String>, account_remove: &[&str]) {
    for key in inherited {
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
        let dropped_for_account = account_remove.iter().any(|name| name.eq_ignore_ascii_case(&key));
        if is_session_marker(&key) || is_launcher_colour_switch(&key) || dropped_for_account {
            builder.env_remove(&key);
        }
    }
}

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
 * Flow control, page to sender (RS-7).
 *
 * `emit` never blocks, so the sender drained the reader as fast as the child wrote and every chunk waited in the
 * event loop and the webview's script queue with no cap: a `cat` of a 2 GB log, or an agent stuck printing, while the
 * terminal could not keep up, grew the memory of ADE and of the renderer by gigabytes. And xterm itself discards what
 * is past its own write buffer (50 MB), which is output lost without a word.
 *
 * Now the sender counts the bytes it has handed to the page and the page says, from the terminal's own write
 * callback, how many it has written (`pty_ack`). Past `FLOW_HIGH_WATER` in flight the sender waits, the bounded
 * channel in front of it fills, the reader stops reading, and ConPTY applies backpressure to the child. While the page
 * keeps answering nothing is dropped: output waits, it is not thrown away.
 *
 * A page that never answers (a reload in progress, a listener that is gone) must not freeze the pane for ever, so a
 * wait that sees no acknowledgement for `FLOW_STALL` forgets the debt and goes on, as it did before this existed. What
 * that lets through can pass xterm's limit, and xterm refuses it (`src/terminal/registry.ts`).
 *
 * The high water mark is also how far behind a key can fall. A page handles its messages one by one, so the echo of a
 * key in another pane waits behind everything this one has in flight: a median of 172 ms at 4 MiB, 140 ms at 1 MiB and 86 ms
 * at 512 KiB, with a maximum of 326, 198 and 123 ms, against 32 ms at rest. A flood is no slower for it.
 */
const FLOW_HIGH_WATER: usize = 512 * 1024;
const FLOW_STALL: Duration = Duration::from_secs(5);
/// How many reads may wait between the reader and the sender (each is at most 8 KB): about a megabyte.
const CHUNK_QUEUE: usize = 128;

struct Flow {
    in_flight: Mutex<usize>,
    moved: std::sync::Condvar,
}

impl Flow {
    fn new() -> Self {
        Flow { in_flight: Mutex::new(0), moved: std::sync::Condvar::new() }
    }

    /// Counts `bytes` as on their way to the page, once fewer than `high` are; waits for acknowledgements until then.
    fn admit(&self, bytes: usize, high: usize, stall: Duration) {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        while *in_flight >= high {
            let before = *in_flight;
            let (guard, result) = self.moved.wait_timeout(in_flight, stall).unwrap_or_else(|e| e.into_inner());
            in_flight = guard;
            // No acknowledgement for the whole stall: the page is gone or not answering. Forget the debt, go on.
            if result.timed_out() && *in_flight >= before {
                *in_flight = 0;
                break;
            }
        }
        *in_flight += bytes;
    }

    /// The page wrote `bytes` into the terminal.
    fn acknowledge(&self, bytes: usize) {
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        *in_flight = in_flight.saturating_sub(bytes);
        self.moved.notify_all();
    }
}

/// The flows of the sessions whose output is still being sent, by id: not in `Registry` (RS-8, see `pty_spawn`).
fn flows() -> &'static Mutex<HashMap<String, Arc<Flow>>> {
    static FLOWS: std::sync::OnceLock<Mutex<HashMap<String, Arc<Flow>>>> = std::sync::OnceLock::new();
    FLOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Says that the page has written `bytes` of this session's output into its terminal (RS-7).
///
/// `async` like the rest, and it never touches the registry: it only wakes the sender.
#[tauri::command]
pub async fn pty_ack(id: String, bytes: usize) -> Result<(), String> {
    let flow = flows().lock().map_err(|_| "registro bloccato")?.get(&id).cloned();
    // A session whose output is all out has nothing left to hold back.
    if let Some(flow) = flow {
        flow.acknowledge(bytes);
    }
    Ok(())
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

/// The only CLI that may run without a terminal: see `pipe` in `pty_spawn`.
fn is_pipe_command(command: &str) -> bool {
    command_stem(command).eq_ignore_ascii_case("claude")
}

/// What a started process gives back, whichever way it was started.
struct Spawned {
    child: Box<dyn Child + Send + Sync>,
    master: Option<Box<dyn MasterPty + Send>>,
    reader: Result<Box<dyn Read + Send>, String>,
    writer: Result<Box<dyn Write + Send>, String>,
    errors: Option<Box<dyn Read + Send>>,
}

/// A start the system refused, as the pane says it. portable-pty writes its
/// failure with Rust's debug form — «CreateProcessW `"ohmypi\0"` in cwd
/// `Some("…\0")` failed: … (os error 2)» — and that text reached the strip
/// over the terminal as it was. A program that is not there (errors 2 and 3)
/// is named as such; anything else keeps only the system's own reason.
fn spawn_failure(command: &str, error: &str) -> String {
    let code = error
        .rsplit_once("(os error ")
        .and_then(|(_, rest)| rest.split(')').next())
        .and_then(|code| code.trim().parse::<i32>().ok());
    if matches!(code, Some(2) | Some(3)) {
        return format!("programma non trovato: {command}");
    }
    let reason = error.rsplit_once(" failed: ").map_or(error, |(_, reason)| reason);
    format!("{command} non parte: {}", reason.replace('\0', "").trim())
}

fn spawn_in_pty(builder: CommandBuilder, rows: u16, cols: u16) -> Result<Spawned, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty non creata: {e}"))?;
    let child = pair.slave.spawn_command(builder).map_err(|e| e.to_string())?;
    // The slave handle has done its job; holding it open would keep the pty
    // alive after the child dies and the reader would never see EOF.
    drop(pair.slave);
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string());
    let writer = pair.master.take_writer().map_err(|e| e.to_string());
    Ok(Spawned {
        child,
        master: Some(pair.master),
        reader,
        writer,
        errors: None,
    })
}

/// The same command, environment and folder the terminal would have had, on pipes.
fn spawn_piped(program: &str, builder: &CommandBuilder) -> Result<Spawned, String> {
    use std::process::Stdio;
    let mut command = std::process::Command::new(program);
    command.args(builder.get_argv().iter().skip(1));
    if let Some(dir) = builder.get_cwd() {
        command.current_dir(dir);
    }
    command.env_clear();
    command.envs(builder.iter_full_env_as_str());
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let writer = child
        .stdin
        .take()
        .map(|stdin| Box::new(stdin) as Box<dyn Write + Send>)
        .ok_or_else(|| "stdin assente".to_string());
    let reader = child
        .stdout
        .take()
        .map(|stdout| Box::new(stdout) as Box<dyn Read + Send>)
        .ok_or_else(|| "stdout assente".to_string());
    let errors = child.stderr.take().map(|stderr| Box::new(stderr) as Box<dyn Read + Send>);
    Ok(Spawned {
        child: Box::new(child),
        master: None,
        reader,
        writer,
        errors,
    })
}

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
/// only thing a caller chooses is a path. Home-relative folders are spelled
/// `cd -- "$HOME"/'<dir>'`, and the home itself `cd -- "$HOME"`, because a
/// quoted `~` does not expand. Mirrors `remoteCd` in `src/remote/ssh.ts`.
fn is_ssh_remote_cd(value: &str) -> bool {
    const SHELL: &str = " && exec \"$SHELL\" -l";
    let Some(cd) = value.strip_prefix("cd -- ").and_then(|rest| rest.strip_suffix(SHELL)) else {
        return false;
    };
    if cd == "\"$HOME\"" {
        return true;
    }
    let quoted = cd.strip_prefix("\"$HOME\"/").unwrap_or(cd);
    let Some(dir) = quoted.strip_prefix('\'').and_then(|d| d.strip_suffix('\'')) else {
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

/*
 * The two questions ConPTY asks before it lets a process speak.
 *
 * portable-pty opens the pseudo console with `PSEUDOCONSOLE_INHERIT_CURSOR`,
 * and with it ConPTY starts by asking the terminal where the cursor is
 * (`ESC[6n`) and what it is (`ESC[c`), and holds every byte of the child's
 * output until both are answered or three seconds pass. Nobody answers a voice
 * or bot turn, which has no terminal, and a pane's xterm answers only after
 * the round trip through the window: `cmd /c echo` took 3.04 s to print in a
 * pty and 32 ms once answered here, and a spoken question waited those three
 * seconds before Claude Code even started.
 *
 * So the first of each, within `STARTUP_QUERY_WINDOW` of the spawn, is
 * answered here and taken out of the output: a fresh terminal's cursor is at
 * 1;1. The device attributes must claim VT level 61 or above: xterm's own
 * `ESC[?1;2c` does not release the output (measured, still 3 s), which is why
 * panes waited too although xterm answers. The window never sees the
 * question, so it never sends a second answer into the child's input.
 * Later queries (an agent asking for itself) pass through untouched.
 *
 * Only ConPTY asks these on its own. Elsewhere the same bytes come from the
 * child itself (Codex, nvim asking where the cursor is), and a made-up answer
 * would be a lie told to a program that then draws by it: off Windows
 * nothing is answered. Level 61 with no extensions (`ESC[?61c`) is enough to
 * release ConPTY; claiming sixel (`;4`) would invite an agent to send images
 * the pane may not draw.
 */
const STARTUP_QUERY_WINDOW: Duration = Duration::from_secs(5);
const CURSOR_QUERY: &str = "\x1b[6n";
const CURSOR_REPLY: &str = "\x1b[1;1R";
const DEVICE_QUERY: &str = "\x1b[c";
const DEVICE_REPLY: &str = "\x1b[?61c";

struct StartupQueries {
    cursor_answered: bool,
    device_answered: bool,
}

impl StartupQueries {
    /// `conpty`: whether the pty is ConPTY, whose questions these are. When not,
    /// there is nothing to answer and everything passes through.
    fn new(conpty: bool) -> Self {
        Self {
            cursor_answered: !conpty,
            device_answered: !conpty,
        }
    }

    fn done(&self) -> bool {
        self.cursor_answered && self.device_answered
    }

    /// `text` without the startup questions it answered, and the answer to send.
    fn take(&mut self, text: &str) -> (String, String) {
        let mut forward = text.to_string();
        let mut reply = String::new();
        if !self.cursor_answered {
            if let Some(at) = forward.find(CURSOR_QUERY) {
                forward.replace_range(at..at + CURSOR_QUERY.len(), "");
                reply.push_str(CURSOR_REPLY);
                self.cursor_answered = true;
            }
        }
        if !self.device_answered {
            if let Some(at) = forward.find(DEVICE_QUERY) {
                forward.replace_range(at..at + DEVICE_QUERY.len(), "");
                reply.push_str(DEVICE_REPLY);
                self.device_answered = true;
            }
        }
        (forward, reply)
    }
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

/// Starts `command` under a pty and streams it to the page on `events`.
///
/// `id` comes from the caller rather than from here because the pane that will
/// display this session already has one, and matching them means the listener
/// can be attached before the first byte arrives — a CLI that greets you in
/// under a millisecond would otherwise lose its greeting.
///
/// `async` because opening a ConPTY, scanning PATH and starting a process are
/// all blocking, and a synchronous command does them on the thread that draws
/// the window.
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
    /*
     * API keys for this session, by name. Only names cross the IPC: the values
     * are read here from the system keychain (`secrets.rs`) and go straight
     * into the child's environment. Which keys a session gets is chosen per
     * key, per agent, in Impostazioni › Chiavi API, and checked again here
     * against the agent the command starts. A bot in key mode passes one
     * name; a subscription passes none, and the account flag strips inherited
     * keys so a key ADE was started with is not spent by surprise.
     */
    secrets: Option<Vec<String>>,
    /*
     * Pipes instead of a terminal, for Claude Code only.
     *
     * The top of this file explains why agents get a terminal. The exception
     * is a Claude Code kept running between spoken requests, which reads one
     * JSON message per line on stdin (`--input-format stream-json`) and
     * refuses to when stdin is a terminal. See `src/bots/warm.ts`.
     */
    pipe: Option<bool>,
    /*
     * An account's switch (`account-plan`, `account-key`, B10), and nothing
     * else. Not an environment: the page cannot set anything through here.
     */
    flags: Option<Vec<String>>,
    /* Where this session's output and exit go: see `PtyEvent`. */
    events: Channel<PtyEvent>,
) -> Result<(), String> {
    if !is_allowed_command(&command) {
        return Err(format!("comando non consentito: {command}"));
    }
    check_args(&command, &args)?;
    let secret_names = secrets.clone().unwrap_or_default();
    let flag_list = flags.clone().unwrap_or_default();
    // Count and shape before the keychain: a plan must not even read a key.
    let _ = spawn_flag_effect(&command, &flag_list, &secret_names, &[])?;
    let keyed = if secret_names.is_empty() {
        Vec::new()
    } else {
        crate::secrets::env_for(&app, &command, &secret_names)?
    };
    let secret_envs: Vec<String> = keyed.iter().map(|(env, _)| env.clone()).collect();
    let account_remove = spawn_flag_effect(&command, &flag_list, &secret_names, &secret_envs)?;
    let pipe = pipe == Some(true);
    if pipe && !is_pipe_command(&command) {
        return Err(format!("{command} non si avvia senza terminale"));
    }

    /*
     * Resolved here rather than left to the spawner, so the binary that starts
     * is the same one the new-session form said was installed. On Windows that
     * is not a formality: the agent CLIs ship as several files of the same name
     * in the same directory, and only the one PATHEXT picks can actually run.
     */
    // `ragu` falls back to the nikcli of before the rename (`legacy_cli`).
    let resolved = resolve_command(&command, which_on_path).unwrap_or_else(|| command.clone());
    /*
     * Prime Agent and pi report their turns through an extension ADE passes on
     * the command line, and only to a spawn that has a nonce to report under.
     * Added here, before `launch_plan` quotes the line for cmd.exe, and after
     * `check_args`, which judges what the page sent and not what ADE adds.
     */
    let mut args = args;
    if link.is_some() {
        if let Some(extension) = crate::agent_link::activity_extension(&app, command_stem(&command)) {
            args.push("-e".to_string());
            args.push(extension.to_string_lossy().into_owned());
        }
    }
    /*
     * A `.cmd` or `.bat` is run by cmd.exe, which reads its command line again
     * with its own rules (B1, audit A1): `&` ran a second command, `%VAR%`
     * expanded, and everything after a line break was lost — a bot's first
     * Codex turn never reached the question. See `launch_plan`.
     */
    let (program, args) = launch_plan(&resolved, &args)?;
    let mut builder = CommandBuilder::new(&program);
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
    scrub_inherited(&mut builder, std::env::vars().map(|(key, _)| key), &account_remove);
    /*
     * The chosen key, after the sweep and the account removals, so it is not
     * taken back out and no inherited key of the same name survives (B10).
     */
    for (name, value) in &keyed {
        builder.env(name, value);
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
        crate::mailbox::mailbox_path(&app),
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
    // After the scrub too: a `RAGU_SERVICE=1` in the user's shell would
    // otherwise send this pane's tools back to the shared server.
    for (key, value) in agent_env(&command) {
        builder.env(key, value);
    }
    // After the scrub as well, so the user's own shell cannot take it back.
    apply_pane_env(&mut builder);

    if let Some(link) = link.as_ref() {
        if let Some(dir) = crate::agent_link::link_dir(&app) {
            builder.env("ADE_PANE_ID", &link.pane);
            builder.env("ADE_SPAWN_NONCE", &link.nonce);
            builder.env("ADE_SESSION_DIR", dir.as_os_str());
        }
    }

    let spawned = if pipe {
        spawn_piped(&program, &builder).map_err(|e| spawn_failure(&command, &e))?
    } else {
        spawn_in_pty(builder, rows, cols).map_err(|e| spawn_failure(&command, &e))?
    };
    let Spawned { mut child, master, reader, writer, errors } = spawned;
    let job = PaneJob::around(child.process_id());

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

    let (mut reader, writer) = match (reader, writer) {
        (Ok(reader), Ok(writer)) => (reader, Arc::new(WriteQueue::new(writer))),
        (Err(e), _) => abort_with!(format!("uscita non leggibile: {e}")),
        (_, Err(e)) => abort_with!(format!("ingresso non scrivibile: {e}")),
    };
    // The reader answers ConPTY's startup questions with it: see `StartupQueries`. In the same queue as the keys, and
    // without keeping it open once the session has gone.
    let answerer = Arc::downgrade(&writer);
    let spawned_at = Instant::now();
    // The sender waits on it, and `pty_ack` wakes it through `flows()`.
    let flow = Arc::new(Flow::new());
    let sender_flow = Arc::clone(&flow);

    {
        let mut sessions = match registry.0.lock() {
            Ok(sessions) => sessions,
            Err(_) => abort_with!("registro bloccato".to_string()),
        };
        sessions.insert(
            id.clone(),
            Session {
                master: master.map(|master| Arc::new(Mutex::new(master))),
                writer,
                child,
                job,
            },
        );
    }

    // Not in the registry: the waiter holds its lock across `ClosePseudoConsole` (RS-8), and an acknowledgement that
    // waited behind it would leave the sender, and with it the reader and the child, waiting for it. Taken out by
    // the sender when it is done, so the page can go on acknowledging output that is still in flight after the exit.
    if let Ok(mut map) = flows().lock() {
        map.insert(id.clone(), flow);
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
    let (chunk_tx, chunk_rx) = std::sync::mpsc::sync_channel::<String>(CHUNK_QUEUE);
    /*
     * How the waiter wakes the sender when the child has exited: an empty chunk, which the readers never send. It is
     * kept in a slot, not held by the waiter, so that the channel still counts as closed when the readers are done:
     * the main reader empties the slot when it ends, and only then does the sender see the hang-up. Held by the
     * waiter, which lives until the child exits, it would have delayed every exit that EOF announces first.
     */
    let wake: std::sync::Arc<Mutex<Option<std::sync::mpsc::SyncSender<String>>>> =
        std::sync::Arc::new(Mutex::new(Some(chunk_tx.clone())));
    let wake_reader = std::sync::Arc::clone(&wake);
    // A piped process's errors go to the same stream: that is where a terminal would have shown them.
    if let Some(mut errors) = errors {
        let error_tx = chunk_tx.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut tail: Vec<u8> = Vec::new();
            while let Ok(n) = errors.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buffer[..n]);
                let text = decode_stream_chunk(&mut tail);
                if !text.is_empty() && error_tx.send(text).is_err() {
                    break;
                }
            }
        });
    }
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
        // Only ConPTY asks its startup questions; a pipe has nobody to ask.
        let mut queries = StartupQueries::new(cfg!(windows) && !pipe);
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    tail.extend_from_slice(&buffer[..n]);
                    let mut text = decode_stream_chunk(&mut tail);
                    if !queries.done() && spawned_at.elapsed() < STARTUP_QUERY_WINDOW {
                        let (forward, reply) = queries.take(&text);
                        if !reply.is_empty() {
                            if let Some(queue) = answerer.upgrade() {
                                let _ = queue.enqueue(reply.into_bytes());
                            }
                        }
                        text = forward;
                    }
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
        // EOF, so it can flush the last frame and report the exit: the waiter's way in goes with it.
        if let Ok(mut slot) = wake_reader.lock() {
            slot.take();
        }
    });

    // For the waiter thread below; taken before `app` moves into the sender.
    let waiter = app.clone();
    let waited_id = id.clone();
    // The waiter hands the exit it saw to the sender, which says it after the last output: see `drain_then_exit`.
    let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();

    let stream_id = id.clone();
    std::thread::spawn(move || {
        drain_then_exit(
            &chunk_rx,
            |data| {
                let bytes = data.len();
                // Waits while the page is far behind (RS-7); the reader then stops reading and the child slows down.
                sender_flow.admit(bytes, FLOW_HIGH_WATER, FLOW_STALL);
                let _ = events.send(PtyEvent::Data { data, bytes });
            },
            || {
                let taken = app
                    .state::<Registry>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|mut sessions| sessions.remove(&stream_id));
                taken.map(|mut session| session.child.wait().ok().map(|status| status.exit_code() as i32))
            },
            &exit_rx,
            EXIT_DRAIN,
            |code| {
                let _ = events.send(PtyEvent::Exit { code });
            },
        );
        if let Ok(mut map) = flows().lock() {
            map.remove(&stream_id);
        }
    });

    /*
     * A third thread: the one that notices the process is gone.
     *
     * On Windows the reader above does not see EOF when the child exits.
     * ConPTY keeps its console host — OpenConsole.exe — alive until the pseudo
     * console is closed, and the pseudo console is closed by dropping the
     * master, which the registry holds until the exit is known: each wait
     * depends on the other, and a `ragu run` that printed its answer and
     * exited left a pane that said "working" forever, with an OpenConsole
     * process for every turn. So the child is asked directly, twice a second;
     * once it has gone the session is dropped — which is what lets the
     * reader finish — and the real code is handed to the sender, which
     * reports the exit once the last output is out.
     * On unix this is merely redundant: EOF arrives first, the reader takes
     * the session, and this thread finds nothing and stops.
     */
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(500));
        let (code, gone) = {
            let registry = waiter.state::<Registry>();
            let Ok(mut sessions) = registry.0.lock() else {
                break;
            };
            let Some(session) = sessions.get_mut(&waited_id) else {
                break;
            };
            match session.child.try_wait() {
                Ok(None) => continue,
                Ok(Some(status)) => (Some(status.exit_code() as i32), sessions.remove(&waited_id)),
                Err(_) => (None, sessions.remove(&waited_id)),
            }
        };
        // Not said from here: the sender may still have output queued, and the page stops listening at the exit.
        let _ = exit_tx.send(code);
        // The sender may be waiting for output that will never come (no EOF): it looks at the code when it is woken.
        if let Ok(slot) = wake.lock() {
            if let Some(tx) = slot.as_ref() {
                // `try_send`: with the queue full the sender is busy, and looks at the exit before it waits again.
                let _ = tx.try_send(String::new());
            }
        }
        // Past the lock: dropping it closes the pseudo console, which waits for conhost, and every spawn, write,
        // resize and kill of every other pane would wait behind it (RS-8). After the exit is out: a slow close then
        // costs the sender its grace and no more.
        drop(gone);
        break;
    });

    Ok(())
}

/*
 * What the sender does from start to end: the output, then the exit, in that order.
 *
 * The exit used to be said by whichever thread saw it first. On Windows that is the waiter, which notices the
 * process is gone up to half a second late and drops the session while the sender still holds up to a frame
 * (16 ms, 256 KB) of the command's last output; the page stops reading at the exit, so a short command's
 * final lines were lost. Now the exit is only ever said here, after `pump` has returned and the last frame is out.
 *
 * `take_session` removes the session if it is still registered and returns the exit code of its child (the
 * unix case: EOF came first). If it is gone, the waiter took it and `late` carries the code it saw; if `pty_kill`
 * took it, the waiter ends without sending and nothing is said, as before.
 *
 * The wait for the output has a limit once the exit is known. The waiter was made to break the dependence on EOF
 * (a console host that outlives its child keeps the pipe open), and an exit that waited for EOF without limit
 * brought the pane that says «working» for ever back whenever EOF did not come: a pipe handle inherited by another
 * process, a slow `ClosePseudoConsole` (Architect's review of F6a, O2). So when the code arrives the sender drains for
 * at most `grace` more, then says the exit with what it has.
 */
fn drain_then_exit(
    chunks: &Receiver<String>,
    emit: impl FnMut(String),
    take_session: impl FnOnce() -> Option<Option<i32>>,
    late: &Receiver<Option<i32>>,
    grace: Duration,
    emit_exit: impl FnOnce(Option<i32>),
) {
    drain_then_exit_capped(chunks, emit, take_session, late, grace, EXIT_HELD_MAX, emit_exit)
}

/// `drain_then_exit`, with the most that waiting for the page may add to the grace.
fn drain_then_exit_capped(
    chunks: &Receiver<String>,
    emit: impl FnMut(String),
    take_session: impl FnOnce() -> Option<Option<i32>>,
    late: &Receiver<Option<i32>>,
    grace: Duration,
    held_max: Duration,
    emit_exit: impl FnOnce(Option<i32>),
) {
    // The code and the moment the grace ends, once the waiter has sent it.
    let seen: std::cell::Cell<Option<(Option<i32>, Instant)>> = std::cell::Cell::new(None);
    // How long `emit` has taken since the exit was known: the sender waits there for the page (RS-7), and that wait is
    // not the child's silence, so it does not count against the grace. Capped, so output that never stops cannot hold
    // the exit for ever.
    let held = std::cell::Cell::new(Duration::ZERO);
    let ended = || {
        if seen.get().is_none() {
            if let Ok(code) = late.try_recv() {
                seen.set(Some((code, Instant::now() + grace)));
            }
        }
        seen.get().map(|(_, at)| at + held.get().min(held_max))
    };
    let mut emit = emit;
    let timed_emit = |data: String| {
        let started = Instant::now();
        emit(data);
        if seen.get().is_some() {
            held.set(held.get() + started.elapsed());
        }
    };
    pump_until(chunks, timed_emit, &ended);
    let code = match take_session() {
        Some(code) => code,
        None => match seen.get() {
            Some((code, _)) => code,
            // The waiter ends, with or without sending, within a tick of the session being gone: the cap is only a net.
            None => match late.recv_timeout(Duration::from_secs(5)) {
                Ok(code) => code,
                Err(_) => return,
            },
        },
    };
    emit_exit(code);
}

/*
 * The sender's loop: coalesces what the reader hands over into at most one
 * `emit` per `FLUSH_INTERVAL`, and returns when the reader hangs up.
 *
 * It sleeps in `recv()` while nothing is waiting to go out. The loop it
 * replaced called `recv_timeout(16ms)` whatever the buffer held, so a silent
 * session — most of them, most of the time — woke sixty times a second to
 * find nothing to flush, and ten panes were six hundred wakeups a second of
 * an idle window. The timeout is only needed once there is something to send.
 *
 * The timeout now runs to a deadline set by the first byte waiting, rather
 * than restarting on every chunk. Restarting it meant an agent that printed
 * a token every ten milliseconds never left a sixteen-millisecond gap, so
 * nothing reached the pane until the 256 KB cap: the stream stalled for as
 * long as it was streaming. "One frame, at most, behind" is the promise the
 * comment on `FLUSH_INTERVAL` makes, and a deadline is what keeps it.
 *
 * Split out of `pty_spawn` so the rules can be tested with a channel and a
 * closure, without a window to emit into.
 */
fn pump(chunks: &Receiver<String>, emit: impl FnMut(String)) {
    pump_until(chunks, emit, &|| None)
}

/// How long the sender goes on draining once the child's exit is known, before the exit is said without the EOF.
const EXIT_DRAIN: Duration = Duration::from_secs(1);

/// The most that the sender's wait for the page may add to `EXIT_DRAIN` (RS-7): time spent inside `emit` is not the
/// child's silence, and a child that flooded and exited with the page behind would lose its last output.
const EXIT_HELD_MAX: Duration = Duration::from_secs(30);

/// `pump`, which also ends when `ended` gives a moment that has passed, flushing what it holds first.
///
/// With a live, silent process there is no deadline at all: the wait is a plain `recv()`, which is zero work until
/// something arrives. `ended` is asked once per message, and the waiter sends an empty one when the child exits.
fn pump_until(chunks: &Receiver<String>, mut emit: impl FnMut(String), ended: &dyn Fn() -> Option<Instant>) {
    let mut pending = String::new();
    // Set while `pending` holds something; the moment it must go out.
    let mut deadline: Option<Instant> = None;

    let mut flush = |pending: &mut String, deadline: &mut Option<Instant>| {
        *deadline = None;
        if !pending.is_empty() {
            emit(std::mem::take(pending));
        }
    };

    loop {
        let end = ended();
        if matches!(end, Some(at) if Instant::now() >= at) {
            flush(&mut pending, &mut deadline);
            return;
        }
        // The nearer of the frame's deadline and the end of the wait for the exit, when either is set.
        let limit = [deadline, end].into_iter().flatten().min();
        let received = match limit {
            None => chunks.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(at) => chunks.recv_timeout(at.saturating_duration_since(Instant::now())),
        };
        match received {
            // A wake-up from the waiter: the top of the loop looks at the exit.
            Ok(text) if text.is_empty() => {}
            Ok(text) => {
                pending.push_str(&text);
                // A burst larger than the cap goes out without waiting:
                // holding megabytes to save a message helps nobody, and a
                // `cat` of a large file is exactly that case.
                if pending.len() >= MAX_PENDING {
                    flush(&mut pending, &mut deadline);
                    continue;
                }
                match deadline {
                    None if !pending.is_empty() => deadline = Some(Instant::now() + FLUSH_INTERVAL),
                    // A queue that is never empty would otherwise keep
                    // `recv_timeout` answering `Ok` past the deadline.
                    Some(at) if Instant::now() >= at => flush(&mut pending, &mut deadline),
                    _ => {}
                }
            }
            Err(RecvTimeoutError::Timeout) => flush(&mut pending, &mut deadline),
            Err(RecvTimeoutError::Disconnected) => {
                // The last thing it said, before the exit is announced.
                flush(&mut pending, &mut deadline);
                return;
            }
        }
    }
}

/// Types `data` into the session exactly as given.
///
/// No newline is appended. What reaches a pty is keystrokes, and an agent's
/// menu answers "y", arrow keys and Ctrl-C are all keystrokes that would be
/// ruined by a helpful terminator: deciding when a line ends belongs to whoever
/// is typing.
///
/// Only queues: the session's own thread writes, for as long as the child takes
/// to read (see `WriteQueue`), so a pane that stopped reading holds nothing that
/// another pane or the mailbox needs. The page sends one write at a time and
/// waits for this answer (`orderedWrites`), because two invokes in flight could
/// reach the queue in either order.
#[tauri::command]
pub async fn pty_write(
    registry: tauri::State<'_, Registry>,
    id: String,
    data: String,
) -> Result<(), String> {
    let sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
    let session = sessions.get(&id).ok_or("sessione non trovata")?;
    session.writer.enqueue(data.into_bytes())
}

/// Tells the session how big its terminal is now.
///
/// A CLI that draws a full-screen interface reads this and nothing else: leave
/// it at the size the pane happened to be when it started and every redraw wraps
/// against a width that stopped being true the moment the user dragged anything.
///
/// `async` like the rest, and off the registry's lock and the async workers: a
/// resize arrives on every frame of a drag and talks to the console host, which
/// may be slow to answer (RS-8).
#[tauri::command]
pub async fn pty_resize(
    registry: tauri::State<'_, Registry>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let master = {
        let sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
        let session = sessions.get(&id).ok_or("sessione non trovata")?;
        session.master.clone()
    };
    let Some(master) = master else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let master = master.lock().map_err(|_| "terminale bloccato".to_string())?;
        master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize fallito: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One row of the process table, as far as walking a tree needs.
#[derive(Clone, Copy)]
struct ProcRow {
    pid: u32,
    parent: Option<u32>,
    /// Seconds since the epoch.
    started: u64,
}

/// `root` and every process below it, children before their parents.
///
/// Walked down from `root`, and a child counts only if it started no earlier
/// than its parent. Windows reuses pids and keeps a dead parent's id in its
/// children's records, so a process whose recorded parent id is ours but which
/// predates that parent is someone else's — `taskkill /T` follows the id alone
/// and could take an unrelated tree with it, ADE's own included.
fn tree_of(root: u32, rows: &[ProcRow]) -> Vec<u32> {
    let started = |pid: u32| rows.iter().find(|row| row.pid == pid).map(|row| row.started);
    let Some(_) = started(root) else { return Vec::new() };
    let mut order = vec![root];
    let mut next = 0;
    while next < order.len() {
        let parent = order[next];
        let parent_started = started(parent).unwrap_or(u64::MAX);
        for row in rows {
            if row.parent == Some(parent) && row.pid != parent && row.started >= parent_started && !order.contains(&row.pid) {
                order.push(row.pid);
            }
        }
        next += 1;
    }
    order.reverse();
    order
}

/// Kills `pid` and the processes it started, one by one (see `tree_of`).
///
/// A CLI turn that runs past its time has children of its own — a shell, an
/// `ade-msg ask` waiting, a node process — and killing only the CLI leaves them
/// running, holding the turn's mailbox identity and its files.
pub(crate) fn kill_tree(pid: u32) {
    kill_trees_keeping(&[pid], true);
}

/// The processes to kill for `root`: its tree, children first, with or without `root` itself.
fn victims(root: u32, rows: &[ProcRow], include_root: bool) -> Vec<u32> {
    let mut members = tree_of(root, rows);
    if !include_root {
        members.retain(|pid| *pid != root);
    }
    members
}

/// What `victims` gives for each of `roots`, over one table, with no process listed twice.
fn trees_of(roots: &[u32], rows: &[ProcRow], include_root: bool) -> Vec<u32> {
    let mut members = Vec::new();
    for root in roots {
        for pid in victims(*root, rows, include_root) {
            if !members.contains(&pid) {
                members.push(pid);
            }
        }
    }
    members
}

/// `kill_tree`, for several trees over one look at the process table, with the choice of leaving the roots to their owner.
///
/// A pane's own child is ended afterwards by `portable-pty`, which on unix sends SIGHUP and waits up to
/// 200 ms before SIGKILL: the agent gets to close its files. Killing the whole tree first, root included,
/// took that away (Dario's review of F3, N1), so there only the descendants go here.
fn kill_trees_keeping(roots: &[u32], include_root: bool) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let rows: Vec<ProcRow> = sys
        .processes()
        .values()
        .map(|process| ProcRow {
            pid: process.pid().as_u32(),
            parent: process.parent().map(|parent| parent.as_u32()),
            started: process.start_time(),
        })
        .collect();
    for member in trees_of(roots, &rows, include_root) {
        if let Some(process) = sys.process(Pid::from_u32(member)) {
            #[cfg(windows)]
            {
                // Not `process.kill()`: sysinfo runs `taskkill.exe /PID n /F` for each one, a process of its own per
                // victim, and a pane's tree is many (review, kv stall). The same kill without the detour.
                let _ = process;
                terminate(member);
            }
            #[cfg(not(windows))]
            process.kill();
        }
    }
}

/// Ends one process at once, as `taskkill /F` does, with no process started to do it. False when it could not be
/// opened or ended (already gone, or not ours to end).
#[cfg(windows)]
fn terminate(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    let Ok(handle) = (unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) }) else {
        return false;
    };
    let ended = unsafe { TerminateProcess(handle, 1) }.is_ok();
    let _ = unsafe { CloseHandle(handle) };
    ended
}

/// Ends the session. Safe to call on one that already ended.
///
/// With `tree`, the processes the child started go too (see `kill_tree`).
/// Panes ask for it, in every place a pane's process ends (closing it, «Termina
/// processo», a relaunch, the voice): closing a pane ends what the agent started
/// along with it, a dev server it left running included. Before the 2026-10-06
/// review they did not, and the agent's MCP servers and shells outlived the pane
/// with nothing left in the registry to find them.
///
/// `async`, with the work on the blocking pool: reading the process table,
/// `wait()` and closing the pseudo console all take as long as they take, and a
/// child slow to die would otherwise hold a worker every other command needs.
#[tauri::command]
pub async fn pty_kill(registry: tauri::State<'_, Registry>, id: String, tree: Option<bool>) -> Result<(), String> {
    let session = {
        let mut sessions = registry.0.lock().map_err(|_| "registro bloccato")?;
        sessions.remove(&id)
    };
    let Some(mut session) = session else {
        return Ok(());
    };
    tauri::async_runtime::spawn_blocking(move || {
        if tree == Some(true) {
            if let Some(pid) = session.child.process_id() {
                // On unix the root is left to `child.kill()` below (SIGHUP, a short wait, SIGKILL).
                kill_trees_keeping(&[pid], cfg!(windows));
            }
        }
        let _ = session.child.kill();
        /*
         * Reaped here rather than left to the reader thread, which cannot do it:
         * removing the session above is what makes that thread's own lookup miss,
         * so nobody else will ever wait on this child and on unix it stays a
         * zombie until ADE itself exits.
         */
        let _ = session.child.wait();
    })
    .await
    .map_err(|e| e.to_string())
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
    if !is_allowed_command(&command) && !is_install_prerequisite(&command) {
        return None;
    }
    crate::legacy_cli::resolve(&command, which_on_path)
}

/// The programs an agent's install command may need (`install.ts`'s `requires`).
///
/// Looked up, never started: `pty_spawn` does not take them, so the install panel can say «npm manca» without
/// opening a way to run npm. Keep in step with `Prerequisite` in `src/session-new/install.ts`.
const INSTALL_PREREQUISITES: &[&str] = &["npm", "winget", "brew"];

fn is_install_prerequisite(command: &str) -> bool {
    INSTALL_PREREQUISITES.contains(&command)
}

/// Rereads the PATH a program started now would get, into this process, and says whether it changed.
///
/// The new-session form calls it from «Ricontrolla», after the user installed an agent in a terminal pane: that
/// installer put its directory on the user's PATH, and ADE — started before — never saw it. Setting it here is what
/// reaches both ends: `pty_which` reads the process PATH, and every pane started afterwards inherits it.
///
/// Windows reads the registry (`windows_path.rs`). Elsewhere the login shell is asked again, as at start-up
/// (`import_login_path`), which may take a few seconds on a slow profile: off the async worker.
#[tauri::command]
pub async fn pty_refresh_path() -> bool {
    tauri::async_runtime::spawn_blocking(refresh_process_path).await.unwrap_or(false)
}

fn process_path() -> String {
    std::env::var_os("PATH").map(|path| path.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(windows)]
fn refresh_process_path() -> bool {
    let current = process_path();
    match crate::windows_path::refreshed(&current) {
        Some(next) if next != current => {
            std::env::set_var("PATH", &next);
            true
        }
        _ => false,
    }
}

#[cfg(unix)]
fn refresh_process_path() -> bool {
    let current = process_path();
    crate::import_login_path();
    process_path() != current
}

/// Whether CreateProcess would accept this file as a program.
///
/// On Windows an extensionless file on PATH is not a program, it is the shell
/// shim an installer left for Git Bash, and `CreateProcessW` refuses it with
/// "not a valid Win32 application" (193). Answering with it reports the agent
/// installed and fails every launch — which is what grok did on this machine,
/// where `~/bin/grok` (a `#!/usr/bin/env bash` shim) sits on PATH ahead of
/// `~/.grok/bin/grok.exe`. A PE image is recognised by its first two bytes,
/// `MZ`, which is the whole test: a script with the execute bit has neither.
#[cfg(windows)]
fn runnable_on_windows(candidate: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(candidate) else {
        return false;
    };
    let mut magic = [0u8; 2];
    file.read_exact(&mut magic).is_ok() && magic == *b"MZ"
}

/// Shared with `serve`, which has to find the same `ragu` this module would
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
        /*
         * The bare name, on the platforms where it means a program. On Windows
         * it is checked rather than trusted: a directory may hold nothing but a
         * Git Bash shim under that name, and taking it is the failure this
         * function's comment above describes.
         */
        #[cfg(windows)]
        if runnable_on_windows(&base) {
            return Some(base.to_string_lossy().into_owned());
        }
        #[cfg(not(windows))]
        if base.is_file() {
            return Some(base.to_string_lossy().into_owned());
        }
    }
    None
}

/// Whether `path` is a script cmd.exe runs: `.cmd` or `.bat`, any case.
fn is_cmd_script(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// The characters cmd.exe gives a meaning to on a command line, plus the
/// control characters (a line break ends the command there).
fn unsafe_for_cmd(arg: &str) -> Option<char> {
    arg.chars().find(|c| "\"%!^&|<>()".contains(*c) || c.is_control())
}

/**
 * The JavaScript file an npm shim runs, when `shim` is one.
 *
 * npm writes every CLI it installs on Windows as a `.cmd` whose last line is
 * `… "%_prog%"  "%dp0%\<path>.js" %*`, `%_prog%` being `node.exe` next to the
 * shim or `node` on the PATH. That is the only shape recognised: the script
 * must sit under the shim's own folder, and anything else is not a shim.
 */
fn npm_shim_script(shim: &std::path::Path) -> Option<std::path::PathBuf> {
    let meta = std::fs::metadata(shim).ok()?;
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return None;
    }
    let text = std::fs::read_to_string(shim).ok()?;
    let line = text.lines().rev().find(|line| line.trim_end().ends_with("%*"))?;
    let node_first = line.contains("\"%_prog%\"") || line.to_ascii_lowercase().contains("\"%dp0%\\node.exe\"");
    if !node_first {
        return None;
    }
    const OPEN: &str = "\"%dp0%\\";
    let start = line.rfind(OPEN)? + OPEN.len();
    let rest = &line[start..];
    let end = rest.find('"')?;
    let relative = &rest[..end];
    if rest[end + 1..].trim() != "%*" {
        return None;
    }
    let lower = relative.to_ascii_lowercase();
    let script_like = lower.ends_with(".js") || lower.ends_with(".cjs") || lower.ends_with(".mjs");
    let clean = !relative.is_empty()
        && !relative.contains('%')
        && !relative.chars().any(|c| c.is_control())
        && relative.split(['\\', '/']).all(|part| !part.is_empty() && part != "." && part != "..");
    if !script_like || !clean {
        return None;
    }
    let script = shim.parent()?.join(relative.replace('\\', std::path::MAIN_SEPARATOR_STR));
    script.is_file().then_some(script)
}

/// The `node.exe` an npm shim would use: the one beside it, or the one on the PATH.
fn shim_node(shim: &std::path::Path) -> Option<String> {
    let beside = shim.parent()?.join("node.exe");
    if beside.is_file() {
        return Some(beside.to_string_lossy().into_owned());
    }
    which_on_path("node").filter(|node| !is_cmd_script(node))
}

/**
 * The program to start and its arguments, for a resolved command (B1).
 *
 * A program that is not a `.cmd` or `.bat` gets its arguments as they are.
 * One that is would be run by cmd.exe, which parses the command line a second
 * time: an argument with `&` ran what followed it, `%VAR%` expanded — a
 * secret's value included — and a line break cut the rest. So:
 *
 * - an npm shim (Codex, and Claude Code or ragu where installed that way)
 *   is started as what it would start, `node <script>.js`, and every argument
 *   arrives whole, line breaks included, with nothing for cmd.exe to read;
 * - any other script refuses an argument cmd.exe would read, rather than
 *   quoting it: quoting for cmd.exe cannot carry a line break, and a quote
 *   that is almost right is how the injection happened.
 */
pub(crate) fn launch_plan(resolved: &str, args: &[String]) -> Result<(String, Vec<String>), String> {
    if !is_cmd_script(resolved) {
        return Ok((resolved.to_string(), args.to_vec()));
    }
    let shim = std::path::Path::new(resolved);
    if let (Some(script), Some(node)) = (npm_shim_script(shim), shim_node(shim)) {
        let mut all = Vec::with_capacity(args.len() + 1);
        all.push(script.to_string_lossy().into_owned());
        all.extend(args.iter().cloned());
        return Ok((node, all));
    }
    for arg in args {
        if let Some(c) = unsafe_for_cmd(arg) {
            let shown = if c.is_control() { format!("U+{:04X}", c as u32) } else { c.to_string() };
            let name = shim.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            return Err(format!("argomento non sicuro per {name}: contiene {shown}, che cmd.exe interpreta"));
        }
    }
    Ok((resolved.to_string(), args.to_vec()))
}

#[cfg(test)]
mod cmd_script_tests {
    //! B1: what reaches a `.cmd` agent is what was sent, and nothing runs.
    //! Only a harmless `probe.cmd`/`probe.js` in a fresh folder; no agent is started.
    use super::{launch_plan, spawn_failure};
    use std::path::PathBuf;

    #[test]
    fn a_refused_start_is_said_without_the_debug_form() {
        let missing = "CreateProcessW `\"ohmypi\\0\"` in cwd `Some(\"C:/progetto\\0\")` failed: Impossibile trovare il file specificato. (os error 2)";
        assert_eq!(spawn_failure("ohmypi", missing), "programma non trovato: ohmypi");
        let no_path = "CreateProcessW `\"x\\0\"` in cwd `None` failed: Impossibile trovare il percorso specificato. (os error 3)";
        assert_eq!(spawn_failure("x", no_path), "programma non trovato: x");
        // std's own error, from the piped start: the same code, the same sentence.
        let piped = std::io::Error::from_raw_os_error(2).to_string();
        assert_eq!(spawn_failure("claude", &piped), "programma non trovato: claude");
        let denied = "CreateProcessW `\"x\\0\"` in cwd `Some(\"C:/p\\0\")` failed: Accesso negato. (os error 5)";
        let said = spawn_failure("x", denied);
        assert_eq!(said, "x non parte: Accesso negato. (os error 5)");
        assert!(!said.contains("Some(") && !said.contains('\0') && !said.contains("CreateProcessW"));
        assert_eq!(spawn_failure("x", "pty non creata: nessuna console"), "x non parte: pty non creata: nessuna console");
    }

    fn fresh_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("ade-b1-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const NPM_SHIM: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\lib\\probe.js\" %*\r\n";

    /// The arguments the audit ran commands with, and the line break that cut the message.
    fn hostile() -> Vec<String> {
        vec![
            "ciao&type nul > INIETTATO1".into(),
            "-c".into(),
            "model_reasoning_effort=\"high & type nul > INIETTATO3 & rem \"".into(),
            "dimmi \"ciao & type nul > INIETTATO4".into(),
            "valore %USERNAME% e %PATH%".into(),
            "Istruzioni del bot \"x\":\nriga due\n\n---\n\nla domanda (vera) ^ | < > !".into(),
        ]
    }

    #[test]
    fn an_npm_shim_runs_its_script_with_every_argument_whole_and_nothing_else() {
        let dir = fresh_dir("npm");
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(
            dir.join("lib").join("probe.js"),
            "require('fs').writeFileSync(process.env.PROBE_OUT, JSON.stringify(process.argv.slice(2)))\n",
        )
        .unwrap();
        let shim = dir.join("probe.cmd");
        std::fs::write(&shim, NPM_SHIM).unwrap();

        let args = hostile();
        let (program, plan) = launch_plan(&shim.to_string_lossy(), &args).expect("an npm shim is planned");
        assert!(!super::is_cmd_script(&program), "cmd.exe must not be the program: {program}");
        assert_eq!(plan[0], dir.join("lib").join("probe.js").to_string_lossy());
        assert_eq!(&plan[1..], &args[..]);

        if !std::path::Path::new(&program).is_file() {
            eprintln!("node non trovato: il piano è verificato, l'esecuzione no");
            return;
        }
        let out = dir.join("argv.json");
        let status = std::process::Command::new(&program)
            .args(&plan)
            .current_dir(&dir)
            .env("PROBE_OUT", &out)
            .status()
            .unwrap();
        assert!(status.success());
        let received: Vec<String> = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(received, args, "every argument arrives whole: &, %VAR%, quotes, line breaks");
        for n in ["INIETTATO1", "INIETTATO3", "INIETTATO4"] {
            assert!(!dir.join(n).exists(), "{n} was created: a command ran");
        }
    }

    #[test]
    fn another_cmd_script_refuses_what_cmd_would_read() {
        let dir = fresh_dir("plain");
        let script = dir.join("probe.cmd");
        std::fs::write(&script, "@echo %*\r\n").unwrap();
        let path = script.to_string_lossy().into_owned();
        for arg in hostile() {
            if arg == "-c" {
                continue;
            }
            let refused = launch_plan(&path, &[arg.clone()]);
            assert!(refused.is_err(), "not refused: {arg:?}");
        }
        assert!(launch_plan(&path, &["exec".into(), "--json".into()]).is_ok());
    }

    #[test]
    fn a_shim_whose_script_leaves_its_folder_is_not_a_shim() {
        let dir = fresh_dir("escape");
        std::fs::create_dir_all(dir.join("inner")).unwrap();
        std::fs::write(dir.join("x.js"), "").unwrap();
        let shim = dir.join("inner").join("probe.cmd");
        std::fs::write(&shim, NPM_SHIM.replace("lib\\probe.js", "..\\x.js")).unwrap();
        let refused = launch_plan(&shim.to_string_lossy(), &["a&b".into()]);
        assert!(refused.is_err(), "a script outside the shim's folder must fall back to refusing");
    }

    #[test]
    fn a_program_that_is_not_a_script_keeps_its_arguments() {
        let args = hostile();
        let (program, plan) = launch_plan("C:/x/codex.exe", &args).unwrap();
        assert_eq!(program, "C:/x/codex.exe");
        assert_eq!(plan, args);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session like `pty_spawn`'s, running a shell whose own child sleeps.
    fn sleeping_session() -> (Session, u32) {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = if cfg!(windows) { CommandBuilder::new("cmd") } else { CommandBuilder::new("sh") };
        if cfg!(windows) {
            cmd.args(["/c", "ping -n 60 127.0.0.1 >NUL"]);
        } else {
            cmd.args(["-c", "sleep 60; true"]);
        }
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let pid = child.process_id().unwrap();
        let writer = Arc::new(WriteQueue::new(pair.master.take_writer().unwrap()));
        (Session { master: Some(Arc::new(Mutex::new(pair.master))), writer, child, job: None }, pid)
    }

    /// A child that never ends: its `wait` does not return, and it has no process to find in the table.
    #[derive(Debug)]
    struct Stuck;

    impl portable_pty::ChildKiller for Stuck {
        fn kill(&mut self) -> std::io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Stuck)
        }
    }

    impl Child for Stuck {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(None)
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            loop {
                std::thread::park();
            }
        }

        fn process_id(&self) -> Option<u32> {
            None
        }

        #[cfg(windows)]
        fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
            None
        }
    }

    fn stuck_session() -> Session {
        Session { master: None, writer: Arc::new(WriteQueue::new(Box::new(std::io::sink()))), child: Box::new(Stuck), job: None }
    }

    /// A pipe end that takes nothing until it is told to, then hands over what it got.
    struct StalledPipe {
        release: Receiver<()>,
        written: Arc<Mutex<Vec<u8>>>,
        entered: Arc<AtomicBool>,
    }

    impl Write for StalledPipe {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.entered.store(true, Ordering::SeqCst);
            let _ = self.release.recv();
            self.written.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn stalled_queue_entered() -> (WriteQueue, std::sync::mpsc::Sender<()>, Arc<Mutex<Vec<u8>>>, Arc<AtomicBool>) {
        let (open, release) = std::sync::mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        let entered = Arc::new(AtomicBool::new(false));
        let queue = WriteQueue::new(Box::new(StalledPipe {
            release,
            written: Arc::clone(&written),
            entered: Arc::clone(&entered),
        }));
        (queue, open, written, entered)
    }

    fn stalled_queue() -> (WriteQueue, std::sync::mpsc::Sender<()>, Arc<Mutex<Vec<u8>>>) {
        let (queue, open, written, _) = stalled_queue_entered();
        (queue, open, written)
    }

    fn wait_until(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /*
     * The incident's shape, RS-5: a child that stopped reading, and the user
     * still typing into it. Each write used to park a tokio worker until the
     * child read again; here all of them return while the pipe takes nothing.
     */
    #[test]
    fn a_pane_that_stopped_reading_blocks_no_writer() {
        let (queue, open, written) = stalled_queue();
        let start = Instant::now();
        for _ in 0..64 {
            queue.enqueue(b"x".to_vec()).unwrap();
        }
        assert!(start.elapsed() < Duration::from_secs(2), "a write waited for the child");
        assert!(written.lock().unwrap().is_empty());
        for _ in 0..64 {
            open.send(()).unwrap();
        }
        wait_until("the keys never reached the child", || written.lock().unwrap().len() == 64);
    }

    /// RS-6, SES-6: an Enter never lands before the text it ends, however long the child took.
    #[test]
    fn writes_reach_the_child_in_the_order_they_were_queued() {
        let (queue, open, written) = stalled_queue();
        let sent: Vec<u8> = (0..=255u8).cycle().take(2000).collect();
        for byte in &sent {
            queue.enqueue(vec![*byte]).unwrap();
        }
        for _ in 0..sent.len() {
            open.send(()).unwrap();
        }
        wait_until("the keys never reached the child", || written.lock().unwrap().len() == sent.len());
        assert_eq!(*written.lock().unwrap(), sent);
    }

    #[test]
    fn a_full_queue_refuses_at_once_and_counts_what_has_gone() {
        let (queue, open, written) = stalled_queue();
        queue.enqueue(vec![0; MAX_QUEUED_WRITE]).unwrap();
        let refused = queue.enqueue(vec![0; 1]).unwrap_err();
        assert!(refused.contains("non sta leggendo"), "{refused}");
        // What the child takes makes room again.
        open.send(()).unwrap();
        wait_until("the pipe never took it", || written.lock().unwrap().len() == MAX_QUEUED_WRITE);
        wait_until("the room never came back", || queue.state.queued.load(Ordering::SeqCst) == 0);
        queue.enqueue(vec![0; 1]).unwrap();
        // A write larger than the cap goes through when nothing is waiting: a big paste into a healthy pane.
        open.send(()).unwrap();
        wait_until("the room never came back", || queue.state.queued.load(Ordering::SeqCst) == 0);
        queue.enqueue(vec![0; MAX_QUEUED_WRITE + 1]).unwrap();
    }

    #[test]
    fn a_session_that_goes_drops_what_was_still_queued() {
        let (queue, open, written, entered) = stalled_queue_entered();
        queue.enqueue(b"first".to_vec()).unwrap();
        wait_until("the first write never began", || entered.load(Ordering::SeqCst));
        queue.enqueue(b"second".to_vec()).unwrap();
        drop(queue);
        // The write in progress finishes; the one behind it is for nobody, and nothing holds it back any more.
        open.send(()).unwrap();
        drop(open);
        wait_until("the first write never ended", || written.lock().unwrap().len() >= 5);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(*written.lock().unwrap(), b"first");
    }

    #[test]
    fn a_broken_pipe_is_told_to_the_next_write() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let queue = WriteQueue::new(Box::new(Broken));
        queue.enqueue(b"x".to_vec()).unwrap();
        wait_until("the failure was never recorded", || queue.state.failure.lock().unwrap().is_some());
        assert!(queue.enqueue(b"y".to_vec()).unwrap_err().contains("scrittura fallita"));
    }

    /// RS-8: the waiter's teardown is past the lock, and a resize takes the master out of it.
    #[test]
    fn the_console_host_is_never_waited_for_under_the_registry_lock() {
        let source = include_str!("pty.rs");
        let waiter = source.split("let (code, gone) = {").nth(1).expect("the waiter");
        let held = waiter.split("drop(gone);").next().expect("the drop");
        assert!(held.contains("sessions.remove(&waited_id)"));
        assert!(!held.contains("sessions.remove(&waited_id);"), "a removed session dropped under the lock");
        let resize = source.split("pub async fn pty_resize(").nth(1).expect("the command");
        let (held, talks) = resize.split_once("session.master.clone()").expect("the master taken out");
        assert!(!held.contains(".resize("));
        assert!(talks.split("pub ").next().unwrap().contains(".resize("));
    }

    // RS2-3: said first, so that a slow `ClosePseudoConsole` costs the sender its grace and the pane does not wait behind it.
    #[test]
    fn the_exit_is_said_before_the_console_host_is_closed() {
        let source = include_str!("pty.rs");
        let waiter = source.split("let (code, gone) = {").nth(1).expect("the waiter");
        let said = waiter.find("let _ = exit_tx.send(code);").expect("the exit");
        let closed = waiter.find("drop(gone);").expect("the drop");
        assert!(said < closed);
    }

    // RS-7: the sender waits for the page once too much is in flight, and a page that never answers cannot freeze it.
    #[test]
    fn the_sender_waits_for_the_page_when_too_much_is_in_flight() {
        let flow = Arc::new(Flow::new());
        flow.admit(100, 100, Duration::from_secs(5));
        let second = Arc::clone(&flow);
        let admitted = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&admitted);
        let waiter = std::thread::spawn(move || {
            second.admit(50, 100, Duration::from_secs(5));
            seen.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(150));
        assert!(!admitted.load(Ordering::SeqCst), "admitted with the debt still unpaid");
        flow.acknowledge(100);
        waiter.join().unwrap();
        assert!(admitted.load(Ordering::SeqCst));
    }

    #[test]
    fn under_the_high_water_mark_nothing_waits() {
        let flow = Flow::new();
        let started = Instant::now();
        flow.admit(10, 100, Duration::from_secs(5));
        flow.admit(10, 100, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_page_that_never_answers_does_not_freeze_the_sender_for_ever() {
        let flow = Flow::new();
        flow.admit(100, 100, Duration::from_millis(50));
        let started = Instant::now();
        flow.admit(100, 100, Duration::from_millis(50));
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(40), "did not wait at all: {waited:?}");
        assert!(waited < Duration::from_secs(2), "waited far past the stall: {waited:?}");
        // The old debt was forgotten, only the frame just let through is owed: its acknowledgement clears everything.
        flow.acknowledge(100);
        let started = Instant::now();
        flow.admit(1, 100, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn an_acknowledgement_is_never_more_than_what_is_owed() {
        let flow = Flow::new();
        flow.admit(10, 100, Duration::from_secs(5));
        flow.acknowledge(1_000);
        let started = Instant::now();
        flow.admit(100, 100, Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    // RS-7, end to end without a window: a fast producer, a slow page, a bounded queue; every byte arrives, in order.
    #[test]
    fn a_slow_page_holds_the_reader_back_and_loses_nothing() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(2);
        let flow = Arc::new(Flow::new());
        let sent = Arc::new(AtomicUsize::new(0));
        let produced = Arc::clone(&sent);
        let producer = std::thread::spawn(move || {
            for number in 0..60 {
                tx.send(format!("{number:04};")).unwrap();
                produced.fetch_add(1, Ordering::SeqCst);
            }
        });
        let consumer_flow = Arc::clone(&flow);
        let acker_flow = Arc::clone(&flow);
        let (note_tx, note_rx) = std::sync::mpsc::channel::<usize>();
        // The page: acknowledges each frame a little after it arrives.
        let acker = std::thread::spawn(move || {
            while let Ok(bytes) = note_rx.recv() {
                std::thread::sleep(Duration::from_millis(2));
                acker_flow.acknowledge(bytes);
            }
        });
        let mut received = String::new();
        pump(&rx, |data| {
            consumer_flow.admit(data.len(), 10, Duration::from_secs(5));
            received.push_str(&data);
            note_tx.send(data.len()).unwrap();
        });
        drop(note_tx);
        producer.join().unwrap();
        acker.join().unwrap();
        let expected: String = (0..60).map(|number| format!("{number:04};")).collect();
        assert_eq!(received, expected);
        assert_eq!(sent.load(Ordering::SeqCst), 60);
    }

    // RS-7: the queue in front of the sender has a bound, so a reader that outruns it waits instead of piling up.
    #[test]
    fn a_reader_that_outruns_the_sender_waits_at_the_queue_bound() {
        let (tx, rx) = std::sync::mpsc::sync_channel::<String>(CHUNK_QUEUE);
        let sent = Arc::new(AtomicUsize::new(0));
        let produced = Arc::clone(&sent);
        let producer = std::thread::spawn(move || {
            for number in 0..CHUNK_QUEUE * 3 {
                tx.send(number.to_string()).unwrap();
                produced.fetch_add(1, Ordering::SeqCst);
            }
        });
        std::thread::sleep(Duration::from_millis(200));
        // Nothing is reading: the queue is full and the producer is held at its bound.
        assert_eq!(sent.load(Ordering::SeqCst), CHUNK_QUEUE);
        let mut got = Vec::new();
        while let Ok(item) = rx.recv_timeout(Duration::from_secs(2)) {
            got.push(item);
            if got.len() == CHUNK_QUEUE * 3 {
                break;
            }
        }
        producer.join().unwrap();
        let expected: Vec<String> = (0..CHUNK_QUEUE * 3).map(|number| number.to_string()).collect();
        assert_eq!(got, expected);
    }

    // RS-7 and RS-8: an acknowledgement never waits behind the registry's lock, which the waiter holds across
    // ClosePseudoConsole, and stays reachable until the sender has sent the last of the output.
    #[test]
    fn an_acknowledgement_does_not_go_through_the_registry() {
        let source = include_str!("pty.rs");
        let ack = source.split("pub async fn pty_ack(").nth(1).expect("the command").split("\n}\n").next().unwrap();
        assert!(!ack.contains("registry"), "pty_ack takes the registry lock");
        assert!(ack.contains("flows()"));
        let sender = source.split("drain_then_exit(\n            &chunk_rx,").nth(1).expect("the sender");
        let sender = sender.split("\n    });\n").next().unwrap();
        assert!(sender.contains("map.remove(&stream_id)"), "the flow outlives its sender");
    }

    #[test]
    fn the_flow_is_registered_before_the_sender_starts() {
        let source = include_str!("pty.rs");
        let spawn = source.split("pub async fn pty_spawn(").nth(1).expect("the command");
        let registered = spawn.find("map.insert(id.clone(), flow)").expect("registered");
        let sender = spawn.find("drain_then_exit(").expect("the sender");
        assert!(registered < sender);
    }

    // RS-7: the pieces that no unit test above reaches are wired in the source.
    #[test]
    fn the_output_queue_is_bounded_and_the_page_has_a_way_to_acknowledge() {
        let source = include_str!("pty.rs");
        assert!(source.contains("sync_channel::<String>(CHUNK_QUEUE)"), "the reader's queue is unbounded");
        assert!(source.contains("sender_flow.admit("), "the sender does not wait for the page");
        let lib = include_str!("lib.rs");
        assert!(lib.contains("pty::pty_ack,"), "pty_ack is not registered");
    }

    /// Whether `pid` is running, whatever its children do.
    #[cfg(windows)]
    fn is_running(pid: u32) -> bool {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        sys.process(Pid::from_u32(pid)).is_some()
    }

    /// The kill that replaced `taskkill`: a real process, ended at once, and one that is not there is not an error.
    #[cfg(windows)]
    #[test]
    fn terminate_ends_a_process_without_starting_another() {
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "ping -n 60 127.0.0.1 >NUL"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(terminate(pid));
        let status = child.wait().unwrap();
        assert_eq!(status.code(), Some(1));
        // Gone and reaped: nothing to open.
        assert!(!terminate(pid));
    }

    /// A job's handle closing, which is what the kernel does when ADE dies: a pane's real ConPTY tree goes with it.
    #[cfg(windows)]
    #[test]
    fn a_job_that_closes_with_its_kill_on_ends_a_conpty_tree() {
        let (session, pid) = sleeping_session();
        // At once, as `pty_spawn` does: what the shell starts after this is in the job.
        let job = crate::ChildTreeGuard::for_pane().unwrap();
        job.assign_pid(pid).unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert!(tree_alive(pid));
        drop(job);
        wait_until("the tree outlived its job", || !tree_alive(pid));
        drop(session);
    }

    /// A pane ending while ADE runs keeps today's rules: dropping the job kills nothing, `kill_tree` does.
    #[cfg(windows)]
    #[test]
    fn a_pane_job_dropped_by_a_living_ade_kills_nothing() {
        let (session, pid) = sleeping_session();
        let job = PaneJob::around(Some(pid)).expect("the pane's job");
        std::thread::sleep(Duration::from_millis(500));
        drop(job);
        std::thread::sleep(Duration::from_millis(500));
        assert!(tree_alive(pid), "dropping the job killed the pane");
        end_sessions(vec![session], END_WAIT);
        wait_until("the tree outlived its session", || !tree_alive(pid));
    }

    /*
     * The real thing, RS-4: the owner of the job is another process, as ADE is, and it dies by force, with no Drop and
     * no exit handler. It is this test binary run again, told by a variable to play ADE: it starts a tree, puts it in
     * a pane's job, prints the pids and waits to be killed. The descendant's parent has gone by then, so a walk of
     * the process table could not have found it: only the job can.
     */
    #[cfg(windows)]
    #[test]
    fn a_forced_kill_of_ade_ends_the_panes_tree() {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        const OWNER: &str = "ADE_TEST_PLAY_JOB_OWNER";
        if std::env::var_os(OWNER).is_some() {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let root = Command::new("cmd")
                .args(["/c", "ping -n 2 127.0.0.1 >nul & start /b ping -n 120 127.0.0.1 >nul"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .unwrap();
            let job = PaneJob::around(Some(root.id())).expect("the pane's job");
            println!("pane-root {}", root.id());
            std::thread::sleep(Duration::from_secs(60));
            // Not reached: the test kills this process first. Dropped here, it would take the kill back.
            std::mem::forget(job);
            return;
        }
        let mut owner = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "pty::tests::a_forced_kill_of_ade_ends_the_panes_tree", "--nocapture", "--test-threads=1"])
            .env(OWNER, "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let root: u32 = std::io::BufReader::new(owner.stdout.take().unwrap())
            .lines()
            .map_while(Result::ok)
            .find_map(|line| line.split("pane-root ").nth(1).and_then(|pid| pid.trim().parse().ok()))
            .expect("the owner never said its pane's pid");
        // The child the root leaves behind, and the root gone: a detached process, as a dev server is.
        let descendant = {
            use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                let mut sys = System::new();
                sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::everything());
                let found = sys
                    .processes()
                    .values()
                    .find(|process| {
                        process.parent().map(|parent| parent.as_u32()) == Some(root)
                            && process.name().to_string_lossy().eq_ignore_ascii_case("ping.exe")
                            && process.cmd().iter().any(|arg| arg.to_string_lossy() == "120")
                    })
                    .map(|process| process.pid().as_u32());
                if let Some(pid) = found {
                    break pid;
                }
                assert!(Instant::now() < deadline, "the descendant never started");
                std::thread::sleep(Duration::from_millis(100));
            }
        };
        wait_until("the root never ended", || !is_running(root));
        assert!(is_running(descendant));
        owner.kill().unwrap();
        owner.wait().unwrap();
        wait_until("the descendant outlived ADE", || !is_running(descendant));
    }

    /// Whether `pid`, or any process it started, is still running.
    fn tree_alive(pid: u32) -> bool {
        use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        sys.processes().values().any(|process| {
            process.pid().as_u32() == pid || process.parent().map(|parent| parent.as_u32()) == Some(pid)
        })
    }

    #[test]
    fn a_reloaded_page_leaves_no_pty_of_the_old_one_running() {
        let registry = Registry::default();
        let (first, first_pid) = sleeping_session();
        let (second, second_pid) = sleeping_session();
        registry.0.lock().unwrap().insert("pty-old-1".into(), first);
        registry.0.lock().unwrap().insert("pty-old-2".into(), second);
        // Give the shells a moment to start their own child.
        std::thread::sleep(Duration::from_millis(500));
        assert!(tree_alive(first_pid) && tree_alive(second_pid));

        assert_eq!(registry.end_all(), 2);
        assert!(registry.0.lock().unwrap().is_empty());
        assert!(!tree_alive(first_pid), "the first shell or its child is still running");
        assert!(!tree_alive(second_pid), "the second shell or its child is still running");
        // Nothing left: a second page load ends nothing.
        assert_eq!(registry.end_all(), 0);
    }

    #[test]
    fn ending_in_the_background_empties_the_registry_at_once() {
        let registry = Registry::default();
        let (session, pid) = sleeping_session();
        registry.0.lock().unwrap().insert("pty-old".into(), session);
        assert_eq!(registry.end_all_in_background(), 1);
        // Taken before the call returned: a spawn of the new page cannot be caught by it.
        assert!(registry.0.lock().unwrap().is_empty());
        let deadline = Instant::now() + Duration::from_secs(10);
        while tree_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(!tree_alive(pid));
    }

    // RS2-3: on `RunEvent::Exit` this is the main thread, and before an update it is what the setup waits for.
    #[test]
    fn ending_every_session_has_a_time_limit() {
        let registry = Arc::new(Registry::default());
        let (session, pid) = sleeping_session();
        registry.0.lock().unwrap().insert("pty-asleep".into(), session);
        registry.0.lock().unwrap().insert("pty-stuck".into(), stuck_session());
        std::thread::sleep(Duration::from_millis(500));
        assert!(tree_alive(pid));

        let (returned, answer) = std::sync::mpsc::channel();
        let ending = Arc::clone(&registry);
        std::thread::spawn(move || {
            let _ = returned.send(ending.end_all());
        });
        assert_eq!(answer.recv_timeout(Duration::from_secs(15)), Ok(2), "one stuck session held every other one's end");
        assert!(!tree_alive(pid), "the healthy tree is still running");
    }

    #[test]
    fn ending_does_not_wait_out_the_limit_when_every_session_has_answered() {
        let (session, pid) = sleeping_session();
        std::thread::sleep(Duration::from_millis(500));
        let started = Instant::now();
        assert_eq!(end_sessions(vec![session], Duration::from_secs(60)), 1);
        assert!(started.elapsed() < Duration::from_secs(30), "every close of ADE would take the whole limit");
        assert!(!tree_alive(pid));
    }

    // RS2-1: a reload lands while a pane is still starting.
    #[test]
    fn a_spawn_that_outlives_its_page_is_ended_not_registered() {
        let registry = Registry::default();
        let born = registry.generation();
        registry.end_all_in_background();

        let (session, pid) = sleeping_session();
        std::thread::sleep(Duration::from_millis(500));
        let late = registry.insert_current(born, "pty-late".into(), session).expect_err("the old page's spawn was registered");
        assert!(registry.0.lock().unwrap().is_empty());
        assert_eq!(end_sessions(vec![late], END_WAIT), 1);
        assert!(!tree_alive(pid), "the old page's agent is still running");

        // A spawn of the new page is what the registry is for.
        let (session, pid) = sleeping_session();
        std::thread::sleep(Duration::from_millis(500));
        assert!(registry.insert_current(registry.generation(), "pty-new".into(), session).is_ok());
        assert_eq!(registry.end_all(), 1);
        assert!(!tree_alive(pid));
    }

    #[test]
    fn only_claude_runs_on_pipes() {
        assert!(is_pipe_command("claude"));
        assert!(is_pipe_command("claude.exe"));
        assert!(is_pipe_command("CLAUDE.cmd"));
        assert!(!is_pipe_command("codex"));
        assert!(!is_pipe_command("powershell"));
        assert!(!is_pipe_command("claude-evil"));
    }

    /*
     * The shim that hid grok. `~/bin/grok` is a bash script with no extension
     * and it comes before `~/.grok/bin/grok.exe` on PATH, so the lookup
     * answered with a file Windows cannot start: the card said "installato",
     * the launch said "non è un'applicazione di Win32 valida".
     */
    #[cfg(windows)]
    #[test]
    fn an_extensionless_shell_script_is_not_a_program() {
        let dir = std::env::temp_dir().join("ade-which-test");
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("grok");
        std::fs::write(&shim, "#!/usr/bin/env bash\nexec \"$HOME/.grok/bin/grok.exe\" \"$@\"\n").unwrap();
        let binary = dir.join("grok.exe");
        std::fs::write(&binary, b"MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00").unwrap();

        assert!(!runnable_on_windows(&shim), "a shell script is not a PE image");
        assert!(runnable_on_windows(&binary), "an .exe is");
        assert!(!runnable_on_windows(&dir.join("nothing-here")), "a missing file is neither");
        std::fs::remove_dir_all(&dir).ok();
    }

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

    /*
     * The sender's rules, without a stopwatch. Every chunk is queued and the
     * reader's end dropped before `pump` starts, so what it emits is decided
     * by the cap and the hang-up alone, never by how fast the machine is.
     */
    fn pumped(chunks: &[&str]) -> Vec<String> {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        for chunk in chunks {
            tx.send(chunk.to_string()).unwrap();
        }
        drop(tx);
        let mut emitted = Vec::new();
        pump(&rx, |data| emitted.push(data));
        emitted
    }

    // Full review 2026-10-06, rust 11: the exit is said after the last output, even when the waiter saw it first.
    #[test]
    fn the_exit_comes_after_the_last_output_even_when_the_waiter_saw_it_first() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();
        // The waiter has already reported (code 0) and the session is gone; the output is still queued.
        exit_tx.send(Some(0)).unwrap();
        tx.send("last line\n".to_string()).unwrap();
        drop(tx);
        let log = std::cell::RefCell::new(Vec::<String>::new());
        drain_then_exit(
            &rx,
            |data| log.borrow_mut().push(format!("data:{}", data.trim_end())),
            || None,
            &exit_rx,
            Duration::from_millis(50),
            |code| log.borrow_mut().push(format!("exit:{code:?}")),
        );
        assert_eq!(log.into_inner(), vec!["data:last line".to_string(), "exit:Some(0)".to_string()]);
    }

    #[test]
    fn a_session_the_sender_takes_itself_reports_the_code_it_waited_for() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (_exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();
        tx.send("x".to_string()).unwrap();
        drop(tx);
        let mut exits = Vec::new();
        drain_then_exit(&rx, |_| {}, || Some(Some(3)), &exit_rx, Duration::from_millis(50), |code| exits.push(code));
        assert_eq!(exits, vec![Some(3)]);
    }

    #[test]
    fn a_session_killed_by_pty_kill_says_no_exit() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();
        drop(tx);
        // The waiter found the session gone and ended without sending.
        drop(exit_tx);
        let mut exits = Vec::new();
        drain_then_exit(&rx, |_| {}, || None, &exit_rx, Duration::from_millis(50), |code| exits.push(code));
        assert!(exits.is_empty());
    }

    // Architect's review of F6a, O2: the exit does not wait for an EOF that never comes.
    #[test]
    fn the_exit_is_said_after_the_grace_even_when_the_output_never_ends() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();
        // The code has arrived, the last line is queued, and the channel is never closed: `tx` stays alive.
        exit_tx.send(Some(7)).unwrap();
        tx.send("last line\n".to_string()).unwrap();
        // As the waiter does after sending the code: the empty chunk that wakes a sender blocked in `recv()`.
        tx.send(String::new()).unwrap();
        let log = std::cell::RefCell::new(Vec::<String>::new());
        let started = Instant::now();
        drain_then_exit(
            &rx,
            |data| log.borrow_mut().push(format!("data:{}", data.trim_end())),
            || None,
            &exit_rx,
            Duration::from_millis(100),
            |code| log.borrow_mut().push(format!("exit:{code:?}")),
        );
        assert_eq!(log.into_inner(), vec!["data:last line".to_string(), "exit:Some(7)".to_string()]);
        // Neither the idle poll nor the grace is anywhere near the five seconds of the old net.
        assert!(started.elapsed() < Duration::from_millis(1500), "took {:?}", started.elapsed());
        drop(tx);
    }

    // Master, on O2: a live, silent process costs no wake-ups at all.
    #[test]
    fn a_silent_session_wakes_the_sender_never_until_the_exit_is_known() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let asked = Arc::new(AtomicUsize::new(0));
        let end: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let (asked_in, end_in) = (Arc::clone(&asked), Arc::clone(&end));
        let sender = std::thread::spawn(move || {
            let ended = move || {
                asked_in.fetch_add(1, Ordering::SeqCst);
                *end_in.lock().unwrap()
            };
            pump_until(&rx, |_| {}, &ended);
        });
        // Longer than a periodic poll would need to show itself several times over.
        std::thread::sleep(Duration::from_millis(900));
        assert_eq!(asked.load(Ordering::SeqCst), 1, "a silent live process must not wake the sender");
        assert!(!sender.is_finished());
        // The exit becomes known and the waiter wakes the sender: it ends at the end of the grace.
        *end.lock().unwrap() = Some(Instant::now() + Duration::from_millis(100));
        tx.send(String::new()).unwrap();
        let started = Instant::now();
        sender.join().unwrap();
        assert!(started.elapsed() < Duration::from_millis(600), "took {:?}", started.elapsed());
        drop(tx);
    }

    #[test]
    fn output_that_keeps_coming_does_not_hold_the_exit_past_the_grace() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();
        exit_tx.send(Some(0)).unwrap();
        // A grandchild that never stops writing: a line every few milliseconds, for longer than the grace.
        let writer = std::thread::spawn(move || {
            for _ in 0..200 {
                if tx.send("x".to_string()).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let mut said = false;
        let started = Instant::now();
        drain_then_exit(&rx, |_| {}, || None, &exit_rx, Duration::from_millis(100), |_| said = true);
        assert!(said);
        assert!(started.elapsed() < Duration::from_millis(900), "took {:?}", started.elapsed());
        drop(rx);
        let _ = writer.join();
    }

    // Review round 2, R2-B1: the sender now waits for the page inside `emit`, and that wait must not eat the grace.
    #[test]
    fn time_spent_waiting_for_the_page_does_not_count_against_the_exit_grace() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();
        exit_tx.send(Some(0)).unwrap();
        for _ in 0..4 {
            tx.send("x".repeat(MAX_PENDING)).unwrap();
        }
        drop(tx);
        let log = std::cell::RefCell::new(Vec::<String>::new());
        drain_then_exit(
            &rx,
            |data| {
                // A page that is behind: every frame takes as long as the whole grace.
                std::thread::sleep(Duration::from_millis(100));
                log.borrow_mut().push(format!("data:{}", data.len()));
            },
            || None,
            &exit_rx,
            Duration::from_millis(100),
            |code| log.borrow_mut().push(format!("exit:{code:?}")),
        );
        let log = log.into_inner();
        assert_eq!(log.len(), 5, "output lost before the exit: {log:?}");
        assert_eq!(log.last().unwrap(), "exit:Some(0)");
    }

    // The cap: a grandchild that never stops printing, with a page that is always slow, still cannot hold the exit for ever.
    #[test]
    fn waiting_for_the_page_cannot_hold_the_exit_for_ever() {
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<i32>>();
        exit_tx.send(Some(0)).unwrap();
        let writer = std::thread::spawn(move || {
            for _ in 0..400 {
                if tx.send("x".repeat(MAX_PENDING)).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let mut said = false;
        let started = Instant::now();
        drain_then_exit_capped(
            &rx,
            |_| std::thread::sleep(Duration::from_millis(50)),
            || None,
            &exit_rx,
            Duration::from_millis(50),
            Duration::from_millis(400),
            |_| said = true,
        );
        assert!(said);
        assert!(started.elapsed() < Duration::from_secs(3), "took {:?}", started.elapsed());
        drop(rx);
        let _ = writer.join();
    }

    #[test]
    fn a_session_that_says_nothing_emits_nothing() {
        assert!(pumped(&[]).is_empty());
    }

    #[test]
    fn the_last_words_go_out_when_the_reader_hangs_up() {
        // However the chunks were grouped on the way, none is lost or reordered.
        assert_eq!(pumped(&["a", "b", "c"]).concat(), "abc");
    }

    #[test]
    fn a_line_followed_by_silence_still_reaches_the_pane() {
        // The case the two-thread split exists for: output, then nothing, with
        // the reader still connected. Only an upper bound is asserted — two
        // seconds for a sixteen-millisecond deadline — so a slow machine passes.
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        let (out_tx, out_rx) = std::sync::mpsc::channel::<String>();
        let sender = std::thread::spawn(move || pump(&rx, |data| out_tx.send(data).unwrap()));

        tx.send("prompt> ".to_string()).unwrap();
        assert_eq!(out_rx.recv_timeout(Duration::from_secs(2)).as_deref(), Ok("prompt> "));

        drop(tx);
        sender.join().unwrap();
    }

    #[test]
    fn a_burst_past_the_cap_goes_out_without_waiting() {
        let big = "x".repeat(MAX_PENDING);
        let emitted = pumped(&[&big, "tail"]);
        assert_eq!(emitted, vec![big, "tail".to_string()]);
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
    fn a_session_says_what_the_page_reads() {
        // The shapes `host/shell.ts` reads on the other side. A name that did
        // not match would be a pane that draws nothing, with no error anywhere.
        let data = PtyEvent::Data { data: "ciao".to_string(), bytes: 4 };
        assert_eq!(
            serde_json::to_value(&data).unwrap(),
            serde_json::json!({ "kind": "data", "data": "ciao", "bytes": 4 })
        );
        let exit = PtyEvent::Exit { code: Some(3) };
        assert_eq!(serde_json::to_value(&exit).unwrap(), serde_json::json!({ "kind": "exit", "code": 3 }));
        let unknown = PtyEvent::Exit { code: None };
        assert_eq!(serde_json::to_value(&unknown).unwrap(), serde_json::json!({ "kind": "exit", "code": null }));
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
            "CLAUDE_CODE_SSE_PORT",
            "CLAUDECODE",
            "CLAUDE_PID",
            "ADE_MAILBOX_ROOT",
            "ADE_PANE_ID",
            "ADE_PANE_TOKEN",
            "ADE_MAILBOX",
            "ADE_SPAWN_NONCE",
            "ADE_SESSION_DIR",
            // Windows' names have no case.
            "claude_code_session_id",
        ] {
            assert!(is_session_marker(leaked), "{leaked} should not reach a spawned agent");
        }
    }

    #[test]
    fn a_session_variable_new_in_claude_code_does_not_reach_the_child() {
        // What Claude Code 2.1.283 puts on every command it runs, read from its
        // binary and from a session's own environment on 2026-09-27: the ones
        // that are its session's, not the user's.
        for leaked in [
            "CLAUDE_CODE_SESSION_ATTENDED",
            "CLAUDE_CODE_EXECPATH",
            "CLAUDE_CODE_INVOKED_SKILLS",
            "CLAUDE_EFFORT",
            "AI_AGENT",
            "TRACEPARENT",
        ] {
            assert!(is_session_marker(leaked), "{leaked} is the launching session's");
        }
        // Names the binary knows and ADE's list does not: a session's by their
        // shape. The last two are made up, as the next version could name them.
        for leaked in [
            "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
            "CLAUDE_CODE_SESSION_KIND",
            "CLAUDE_CODE_SESSION_NAME",
            "CLAUDE_CODE_SESSION_ORIGIN",
            "CLAUDE_CODE_BRIDGE_SESSION_ID",
            "CLAUDE_CODE_HOST_SESSION_ID",
            "CLAUDE_CODE_CLOUD_SESSION_ID",
            "CLAUDE_CODE_REMOTE_SESSION_UUID",
            "CLAUDE_CODE_SESSION_PARENT",
            "claude_code_teammate_session_id",
        ] {
            assert!(is_session_marker(leaked), "{leaked} is shaped like a session's own");
        }
        // The user's settings that mention a session keep reaching the child.
        for kept in [
            "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION",
            "CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS",
            "CLAUDE_CODE_SUPPRESS_SESSION_ATTRIBUTION",
            "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE",
            "CLAUDE_CODE_SCROLL_SPEED",
            "CLAUDE_CODE_TMPDIR",
            "GIT_EDITOR",
        ] {
            assert!(!is_session_marker(kept), "{kept} is the user's and must reach the child");
        }
    }

    #[test]
    fn a_setting_of_the_user_reaches_the_child_and_a_session_marker_does_not() {
        // Review, MEDIO 7: the whole `CLAUDE_CODE_` prefix went, the user's own
        // provider, login and Git Bash with it. Fake values only; the token's
        // name in pieces, as ADE's source never spells a CLI's credential.
        const OAUTH: &str = concat!("CLAUDE_CODE_", "OAUTH_TOKEN");
        let inherited = [
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("CLAUDE_CODE_USE_VERTEX", "1"),
            (OAUTH, "finto-token-di-prova"),
            ("CLAUDE_CODE_GIT_BASH_PATH", "C:/Git/bin/bash.exe"),
            ("CLAUDE_CODE_SESSION_ID", "sessione-di-un-altro"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "token-di-un-altro"),
            ("CLAUDECODE", "1"),
        ];
        let mut builder = CommandBuilder::new("agente");
        for (key, value) in inherited {
            builder.env(key, value);
        }
        scrub_inherited(&mut builder, inherited.iter().map(|(key, _)| key.to_string()), &[]);
        for kept in ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", OAUTH, "CLAUDE_CODE_GIT_BASH_PATH"] {
            assert!(builder.get_env(kept).is_some(), "{kept} is the user's setting and must reach the child");
        }
        for gone in ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDECODE"] {
            assert!(builder.get_env(gone).is_none(), "{gone} is another session's and must not reach the child");
        }
    }

    /// Full review 2026-10-06, Rust 10: another ADE's pane identity is not inherited.
    #[test]
    fn the_outer_ades_pane_identity_does_not_reach_a_spawn_that_has_none() {
        let inherited = [
            ("ADE_PANE_ID", "riquadro-esterno"),
            ("ADE_PANE_TOKEN", "token-esterno"),
            ("ADE_MAILBOX", "C:/esterna/posta"),
            ("ADE_SPAWN_NONCE", "nonce-esterno"),
            ("ADE_SESSION_DIR", "C:/esterna/sessioni"),
            ("ADE_MAILBOX_ROOT", "C:/esterna"),
            ("PATH", "C:/bin"),
        ];
        let mut builder = CommandBuilder::new("bot");
        for (key, value) in inherited {
            builder.env(key, value);
        }
        scrub_inherited(&mut builder, inherited.iter().map(|(key, _)| key.to_string()), &[]);
        for (gone, _) in &inherited[..6] {
            assert!(builder.get_env(gone).is_none(), "{gone} is the outer ADE's and must not reach the child");
        }
        assert!(builder.get_env("PATH").is_some());
        // The ones a pane is given afterwards are set after the scrub, so they survive it.
        builder.env("ADE_PANE_ID", "riquadro-proprio");
        assert_eq!(builder.get_env("ADE_PANE_ID").and_then(|v| v.to_str()), Some("riquadro-proprio"));
    }

    #[test]
    fn a_tree_is_walked_down_by_start_time_and_killed_children_first() {
        let row = |pid, parent, started| ProcRow { pid, parent, started };
        let rows = [
            row(100, Some(1), 1_000),
            row(110, Some(100), 1_001),
            row(111, Some(110), 1_002),
            row(120, Some(100), 1_000),
            // Claims 100 as its parent but started before it: an older process
            // whose real parent died and left the id to be reused.
            row(130, Some(100), 900),
            row(131, Some(130), 950),
            // Unrelated.
            row(200, Some(1), 500),
        ];
        let tree = tree_of(100, &rows);
        assert_eq!(tree.len(), 4);
        for pid in [100, 110, 111, 120] {
            assert!(tree.contains(&pid));
        }
        assert!(!tree.contains(&130) && !tree.contains(&131) && !tree.contains(&200));
        let at = |pid| tree.iter().position(|p| *p == pid).unwrap();
        assert!(at(111) < at(110) && at(110) < at(100) && at(120) < at(100));
        assert!(tree_of(999, &rows).is_empty());
    }

    #[test]
    fn a_pane_leaves_its_root_to_the_gentle_kill_but_the_tree_below_it_goes() {
        let row = |pid, parent, started| ProcRow { pid, parent, started };
        let rows = [row(100, Some(1), 1_000), row(110, Some(100), 1_001), row(111, Some(110), 1_002)];
        // Descendants only, deepest first: the root is left for `child.kill()`.
        assert_eq!(victims(100, &rows, false), vec![111, 110]);
        // The whole tree, root last, as `kill_tree` always did.
        assert_eq!(victims(100, &rows, true), vec![111, 110, 100]);
        // A root that is not in the table has nothing to kill, with or without it.
        assert!(victims(999, &rows, false).is_empty());
        assert!(victims(999, &rows, true).is_empty());
    }

    // RS-12: each tree used to be a look of its own at the whole process table.
    #[test]
    fn one_snapshot_kills_every_tree() {
        let row = |pid, parent, started| ProcRow { pid, parent, started };
        let rows = [
            row(100, Some(1), 1_000),
            row(110, Some(100), 1_001),
            // Claims 100 as its parent but started before it: the id was reused.
            row(130, Some(100), 900),
            row(200, Some(1), 1_000),
            row(210, Some(200), 1_001),
            row(211, Some(210), 1_002),
        ];
        assert_eq!(trees_of(&[100, 200, 100], &rows, true), vec![110, 100, 211, 210, 200]);
        assert_eq!(trees_of(&[100, 200], &rows, false), vec![110, 211, 210]);
        assert!(trees_of(&[999], &rows, true).is_empty());
    }

    /// B8d: ragu's bot turns run on ADE's server; no spawn sets a variable by name any more.
    #[test]
    fn no_flag_but_an_accounts_is_taken() {
        for flag in [
            "no-project-config",
            "bot-ask-shell",
            "bot-ask-outside",
            "bot-no-shell",
            "bot-read-only",
            "remote-ask-shell",
            "remote-no-shell",
            "PATH=C:/x",
            "RAGU_PERMISSION",
        ] {
            for agent in ["ragu", "claude", "codex"] {
                assert!(super::spawn_flag_effect(agent, &[flag.to_string()], &[], &[]).is_err(), "{agent} {flag}");
            }
        }
        assert!(super::spawn_flag_effect("ragu", &[], &[], &[]).unwrap().is_empty());
    }

    #[test]
    fn an_account_flag_removes_inherited_keys_and_never_names_a_value() {
        let fake = "sk-or-v1-VALORE-FINTO-NON-DEVE-USCIRE";
        let remove = super::spawn_flag_effect("claude", &["account-plan".to_string()], &[], &[]).unwrap();
        for name in [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_BEDROCK_BASE_URL",
            "ANTHROPIC_VERTEX_PROJECT_ID",
            "AWS_BEARER_TOKEN_BEDROCK",
        ] {
            assert!(remove.contains(&name), "{name}");
        }
        let remove = super::spawn_flag_effect("codex", &["account-plan".to_string()], &[], &[]).unwrap();
        for name in ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"] {
            assert!(remove.contains(&name), "{name}");
        }
        let missing = super::spawn_flag_effect("claude", &["account-key".to_string()], &[], &[]).unwrap_err();
        assert_eq!(missing, "modalità chiave senza una chiave");
        assert!(!missing.contains(fake));
        // One name, variable not known yet: the spawn looks it up, then checks.
        let pending = super::spawn_flag_effect(
            "claude",
            &["account-key".to_string()],
            &["finta".to_string()],
            &[],
        )
        .unwrap();
        assert!(pending.contains(&"ANTHROPIC_API_KEY"));
        let two = super::spawn_flag_effect(
            "claude",
            &["account-key".to_string()],
            &["a".to_string(), "b".to_string()],
            &["ANTHROPIC_API_KEY".to_string(), "ANTHROPIC_API_KEY".to_string()],
        )
        .unwrap_err();
        assert_eq!(two, "modalità chiave senza una chiave");
        let wrong = super::spawn_flag_effect(
            "claude",
            &["account-key".to_string()],
            &["finta".to_string()],
            &["OPENAI_API_KEY".to_string()],
        )
        .unwrap_err();
        assert!(wrong.contains("ANTHROPIC_API_KEY"), "{wrong}");
        assert!(!wrong.contains(fake), "{wrong}");
        assert!(!wrong.contains("OPENAI_API_KEY"), "{wrong}");
        let plan_with_key =
            super::spawn_flag_effect("claude", &["account-plan".to_string()], &["finta".to_string()], &[]).unwrap_err();
        assert_eq!(plan_with_key, "un abbonamento non riceve chiavi");
        assert!(super::spawn_flag_effect("ragu", &["account-plan".to_string()], &[], &[]).is_err());
        assert!(super::spawn_flag_effect("powershell", &["account-key".to_string()], &[], &[]).is_err());
        assert!(super::spawn_flag_effect(
            "claude",
            &["account-plan".to_string(), "account-key".to_string()],
            &[],
            &[]
        )
        .is_err());
        let ok = super::spawn_flag_effect(
            "codex",
            &["account-key".to_string()],
            &["finta".to_string()],
            &["CODEX_API_KEY".to_string()],
        )
        .unwrap();
        assert!(ok.contains(&"CODEX_API_KEY"));
    }

    #[test]
    fn ragu_runs_its_tools_in_the_pane_not_in_the_shared_server() {
        // Both names, and an installed nikcli of before ragu's rename too (`legacy_cli`, until 2026-12-01).
        for name in ["ragu", "RAGU", "ragu.exe", "ragu.cmd", "nikcli", "nikcli.cmd"] {
            assert_eq!(agent_env(name), &[("RAGU_SERVICE", "0"), ("NIKCLI_SERVICE", "0")], "{name}");
        }
        for name in ["codex", "opencode", "agy", "pwsh", "ragu-island", "claude-island"] {
            assert!(agent_env(name).is_empty(), "{name}");
        }
    }

    #[test]
    fn claude_is_started_with_its_clicks_off_and_its_wheel_on() {
        for name in ["claude", "Claude", "claude.exe", "claude.cmd"] {
            assert_eq!(
                agent_env(name),
                &[("CLAUDE_CODE_DISABLE_MOUSE_CLICKS", "1"), ("CLAUDE_CODE_NATIVE_CURSOR", "1")],
                "{name}"
            );
        }
    }

    #[test]
    fn a_new_pane_runs_powershell_scripts_under_bypass() {
        // The same step the spawn takes, on a builder that starts from this process's environment.
        let mut builder = if cfg!(windows) { CommandBuilder::new("powershell") } else { CommandBuilder::new("sh") };
        // Whatever the launching shell had, the pane gets Bypass.
        builder.env("PSExecutionPolicyPreference", "Restricted");
        apply_pane_env(&mut builder);
        assert_eq!(
            builder.get_env("PSExecutionPolicyPreference"),
            Some(std::ffi::OsStr::new("Bypass"))
        );
    }

    #[test]
    fn bypass_is_documented_as_the_users_choice() {
        // D77 A: the reason and the cost sit next to the line, and name the decision.
        let source = include_str!("pty.rs");
        let line = source.find("const PANE_ENV").expect("PANE_ENV is where the policy is set");
        let comment = &source[source[..line].rfind("/// Variables every terminal").expect("the comment above PANE_ENV")..line];
        for needed in ["D77 A", "PSExecutionPolicyPreference=Bypass", "Group Policy", "signature"] {
            assert!(comment.contains(needed), "the comment must say {needed}");
        }
    }

    #[test]
    fn scrubbing_leaves_the_rest_of_the_environment_alone() {
        // An agent needs the environment it would have had in a terminal —
        // PATH above all, plus whatever the user configured for it.
        for kept in [
            "PATH",
            "HOME",
            "USERPROFILE",
            "ANTHROPIC_API_KEY",
            "TERM",
            "CLAUDE_CODE_USE_BEDROCK",
            concat!("CLAUDE_CODE_", "OAUTH_TOKEN"),
            "CLAUDE_CODE_GIT_BASH_PATH",
        ] {
            assert!(!is_session_marker(kept), "{kept} must still be inherited");
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
        assert!(check_args("ssh", &strings(&["-t", "devbox", "cd -- \"$HOME\"/'app' && exec \"$SHELL\" -l"])).is_ok());
        assert!(check_args("ssh", &strings(&["-t", "devbox", "cd -- \"$HOME\" && exec \"$SHELL\" -l"])).is_ok());

        for bad in [
            &["devbox", "cd -- \"$HOME\"/$(calc) && exec \"$SHELL\" -l"][..],
            &["devbox", "cd -- \"$(calc)\" && exec \"$SHELL\" -l"],
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

    /// The install panel looks `npm`, `winget` and `brew` up to say one is missing; none of them may be started.
    #[test]
    fn an_install_prerequisite_can_be_looked_up_but_never_started() {
        for program in INSTALL_PREREQUISITES {
            assert!(is_install_prerequisite(program));
            assert!(!is_allowed_command(program), "{program} would be startable from the page");
        }
        for other in ["curl", "powershell.exe", "npm.cmd", "..\\npm", "npm "] {
            assert!(!is_install_prerequisite(other), "{other}");
        }
    }

    #[tokio::test]
    async fn the_lookup_refuses_a_program_that_is_neither_an_agent_nor_a_prerequisite() {
        assert_eq!(pty_which("curl".into()).await, None);
        assert_eq!(pty_which("C:\\Windows\\System32\\cmd".into()).await, None);
    }

    #[test]
    fn a_program_that_goes_by_another_name_is_found_by_it_after_its_own() {
        let on_path = |names: &'static [&'static str]| move |name: &str| names.contains(&name).then(|| format!("/bin/{name}"));
        assert_eq!(resolve_command("prime", on_path(&["prime", "prime-agent"])), Some("/bin/prime".into()));
        assert_eq!(resolve_command("prime", on_path(&["prime-agent"])), Some("/bin/prime-agent".into()));
        assert_eq!(resolve_command("ohmypi", on_path(&["omp"])), Some("/bin/omp".into()));
        assert_eq!(resolve_command("prime", on_path(&["omp"])), None);
        // The other way round is not a thing: an alternative name does not stand for its first.
        assert_eq!(resolve_command("prime-agent", on_path(&["prime"])), None);
        // And the lookup that came before still works.
        assert_eq!(resolve_command("ragu", on_path(&["nikcli"])), Some("/bin/nikcli".into()));
        assert_eq!(resolve_command("claude", on_path(&["claude"])), Some("/bin/claude".into()));
    }

    #[test]
    fn every_alternative_name_may_be_looked_up() {
        for (first, others) in ALTERNATIVE_COMMANDS {
            assert!(is_allowed_command(first), "{first}");
            for other in *others {
                assert!(is_allowed_command(other), "{other}");
            }
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

    #[test]
    fn conpty_startup_questions_are_answered_once_and_kept_from_the_window() {
        let mut queries = StartupQueries::new(true);
        let (forward, reply) = queries.take("\x1b[1t\x1b[6n\x1b[c\x1b[?1004h");
        assert_eq!(forward, "\x1b[1t\x1b[?1004h");
        assert_eq!(reply, "\x1b[1;1R\x1b[?61c");
        assert!(queries.done());
        // An agent asking later gets its question through, to the real terminal.
        let (forward, reply) = queries.take("\x1b[6n");
        assert_eq!((forward.as_str(), reply.as_str()), ("\x1b[6n", ""));
        // A secondary device-attributes query is not the startup one.
        let mut fresh = StartupQueries::new(true);
        let (forward, reply) = fresh.take("\x1b[>c");
        assert_eq!((forward.as_str(), reply.as_str()), ("\x1b[>c", ""));
    }

    #[test]
    fn without_conpty_a_child_asking_for_the_cursor_gets_the_real_terminal() {
        // On unix the question is Codex's or nvim's own, not the pty's.
        let mut queries = StartupQueries::new(false);
        assert!(queries.done());
        let (forward, reply) = queries.take("\x1b[6n\x1b[c");
        assert_eq!((forward.as_str(), reply.as_str()), ("\x1b[6n\x1b[c", ""));
    }

    /// How long a process in a pty takes to print, answering the startup questions as
    /// `pty_spawn` does or not. `cargo test --lib pty::tests::startup_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn startup_probe() {
        for answer in [false, true] {
            let pty = native_pty_system();
            let pair = pty.openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 }).unwrap();
            let mut cmd = if cfg!(windows) { CommandBuilder::new("cmd") } else { CommandBuilder::new("sh") };
            // PROBE_CMD: another command whose output ends in "pronto", e.g. `claude --version & echo pronto`.
            let line = std::env::var("PROBE_CMD").unwrap_or_else(|_| "echo pronto".into());
            if cfg!(windows) {
                cmd.args(["/c", &line]);
            } else {
                cmd.args(["-c", &line]);
            }
            let start = Instant::now();
            let mut child = pair.slave.spawn_command(cmd).unwrap();
            drop(pair.slave);
            let mut reader = pair.master.try_clone_reader().unwrap();
            let mut writer = pair.master.take_writer().unwrap();
            let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            let mut queries = StartupQueries::new(true);
            let mut seen = String::new();
            while let Ok(chunk) = rx.recv_timeout(Duration::from_secs(10)) {
                let text = String::from_utf8_lossy(&chunk).into_owned();
                if answer {
                    let (_, reply) = queries.take(&text);
                    if !reply.is_empty() {
                        writer.write_all(reply.as_bytes()).unwrap();
                        writer.flush().unwrap();
                    }
                }
                seen.push_str(&text);
                if seen.contains("pronto") {
                    break;
                }
            }
            println!("answer={answer} pronto={:?}", start.elapsed());
            let _ = child.kill();
        }
    }
}
