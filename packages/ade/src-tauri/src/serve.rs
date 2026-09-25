/// The nikcli server ADE talks to.
///
/// ADE drives agent CLIs through a pty, which is right for a terminal and
/// useless for anything that needs structure: the chat section and the voice
/// assistant both want sessions, messages, models and permissions as data, not
/// as bytes on a screen. nikcli already serves exactly that over HTTP, so ADE
/// starts one and uses the SDK against it.
///
/// This lives in Rust because the obvious alternative does not work. The SDK's
/// own `createNikcliServer` spawns with `node:child_process`, and there is no
/// such thing inside a WebView2 renderer. The renderer gets a URL from here and
/// speaks plain `fetch` to it from then on.
///
/// One server per window: a `nikcli serve` of ADE's own, started on demand
/// and killed — with everything it started — when ADE exits. It is
/// deliberately not the `pty_spawn` path — that one hands a terminal to a
/// human, and this one is a background service whose stdout is a protocol.
///
/// Never the background service nikcli registers in its state folder, even
/// when one answers (decided in the C5 review): it was started from an
/// environment ADE does not know, and one started with `--auto` says yes to
/// every «ask», so the chat's permission rules would not hold there. ADE's
/// own server is started without those flags (`AUTO_APPROVE`).
///
/// The page never talks to the server itself (C1). In a release its origin is
/// `tauri.localhost`, which the server's CORS does not list, and ADE's own
/// server has a random password the page must not hold. `serve_proxy.rs`
/// makes every call from here instead; the page gets the address, never the
/// password.
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    Condvar, Mutex, MutexGuard,
    mpsc::{RecvTimeoutError, channel},
};
use std::time::Duration;

use tauri::Manager;

use crate::pty::which_on_path;

/*
 * How long to wait for the server to announce itself.
 *
 * Generous, and it has to be: `nikcli serve` loads the config chain, the
 * project and the provider list before it binds, and on a cold start with a
 * large workspace that is comfortably past ten seconds. A timeout that fires
 * early does not fail safely — it leaves an orphan server running on a port
 * nobody recorded.
 */
const READY_TIMEOUT: Duration = Duration::from_secs(45);

/// The line `serve` prints once it is actually listening.
const READY_PREFIX: &str = "nikcli server listening";

/// The user name ADE's own server is started with; the password is random.
const USERNAME: &str = "nikcli";

/// Variables that make nikcli say yes to every «ask» (`util/src/flag.ts`,
/// `permission/next.ts`): set by `--auto`, `--yolo` and
/// `--dangerously-skip-permissions`, and inherited by ADE from any terminal
/// that had them. With either one the chat's permission rules would not count,
/// and the chat would not know.
const AUTO_APPROVE: [&str; 2] = ["NIKCLI_AUTO_APPROVE", "NIKCLI_DANGEROUSLY_SKIP_PERMISSIONS"];

/// The small model ADE's server gets when the user has not chosen one.
///
/// nikcli calls its small model on its own, without being asked: to title a
/// session and to summarise every turn (`session/prompt-title.ts`,
/// `session/summary.ts`). Unset, it picks one by provider, and that can be a
/// paid one. No spending without the user's say (Master, C4): a free one here,
/// the same for every such call. A `small_model` the user wrote — in their
/// global config, in `NIKCLI_CONFIG` or in `NIKCLI_CONFIG_CONTENT`, even an
/// empty one, which turns it off — is left as it is.
///
/// The project's config is not read here. `NIKCLI_CONFIG_CONTENT` is merged
/// after `nikcli.json` at the project's root, so a `small_model` there gives
/// way to this free one; `<project>/.nikcli/nikcli.json` and
/// `NIKCLI_CONFIG_DIR` are merged after it (`config/config.ts`, the
/// `directories` loop) and win. Should this model go away, only those calls
/// fail, quietly: nikcli does not fall back to a paid one.
pub(crate) const FREE_SMALL_MODEL: &str = "openrouter/nvidia/nemotron-3-super-120b-a12b:free";

pub(crate) struct Serving {
    pub(crate) url: String,
    /// Basic-auth credentials. The password never leaves this process.
    pub(crate) auth: Option<(String, String)>,
    pub(crate) version: Option<String>,
    /// ADE's own server: always one it started, and ends.
    child: Child,
}

impl Serving {
    fn info(&self) -> ServerInfo {
        ServerInfo {
            url: self.url.clone(),
            version: self.version.clone(),
        }
    }

    /// Ends ADE's own server and whatever it started.
    fn end(&mut self) {
        // `nikcli` can be an npm shim, and killing the shim alone would
        // leave the real server listening.
        crate::pty::kill_tree(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// What the page is told about the server: never the password.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub url: String,
    pub version: Option<String>,
}

/*
 * Three states, not two, because starting takes time.
 *
 * With a plain `Option<Serving>` the only way to keep two callers from
 * starting two servers was to hold the mutex for the whole start-up — the
 * forty-five second wait included. `Starting` says "one is on its way" out
 * loud, so the second caller waits on the condvar with the lock released
 * instead of blocking every other command behind it.
 */
enum Slot {
    Idle,
    Starting,
    Running(Serving),
}

pub struct Server {
    slot: Mutex<Slot>,
    /// Signalled whenever the slot stops being `Starting`.
    settled: Condvar,
}

impl Default for Server {
    fn default() -> Self {
        Self {
            slot: Mutex::new(Slot::Idle),
            settled: Condvar::new(),
        }
    }
}

impl Server {
    /// The slot, taking the guard even from a poisoned lock.
    ///
    /// A poisoned lock means a thread panicked while holding it. The child on
    /// the other side still has to be reachable — refusing the guard would
    /// leave a live server nobody can stop.
    fn lock(&self) -> MutexGuard<'_, Slot> {
        match self.slot.lock() {
            Ok(slot) => slot,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Kills the server, if one is running. Safe to call more than once.
    ///
    /// A start in flight is cancelled rather than waited for: the slot goes
    /// back to `Idle`, and the starter — which checks that its claim survived
    /// before installing anything — kills the child it just started.
    pub fn shutdown(&self) {
        {
            let mut slot = self.lock();
            if let Slot::Running(mut serving) = std::mem::replace(&mut *slot, Slot::Idle) {
                serving.end();
            }
        }
        self.settled.notify_all();
    }

    #[cfg(test)]
    fn lock_info(&self) -> Option<ServerInfo> {
        match &*self.lock() {
            Slot::Running(serving) => Some(serving.info()),
            _ => None,
        }
    }

    /// Where calls go, and with which credentials, when a server is up.
    pub(crate) fn endpoint(&self) -> Option<(String, Option<(String, String)>)> {
        let mut slot = self.lock();
        let Slot::Running(serving) = &mut *slot else { return None };
        if !still_alive(serving) {
            return None;
        }
        Some((serving.url.clone(), serving.auth.clone()))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.slot.lock() {
            if let Slot::Running(mut serving) = std::mem::replace(&mut *slot, Slot::Idle) {
                serving.end();
            }
        }
    }
}

/// Releases the `Starting` claim however the start-up ends, exception or
/// early return included. Without it one failed attempt would leave every
/// later caller waiting on a server nobody is starting.
struct Claim<'a>(&'a Server);

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        {
            let mut slot = self.0.lock();
            if matches!(*slot, Slot::Starting) {
                *slot = Slot::Idle;
            }
        }
        self.0.settled.notify_all();
    }
}

/// Reads `url` out of the readiness line, which carries it whole.
fn parse_ready_line(line: &str) -> Option<String> {
    if !line.starts_with(READY_PREFIX) {
        return None;
    }
    let start = line.find("http://").or_else(|| line.find("https://"))?;
    let url = line[start..].split_whitespace().next()?;
    Some(url.trim_end_matches('/').to_string())
}

/// True when the child is still running, rather than merely still in the map.
fn still_alive(serving: &mut Serving) -> bool {
    matches!(serving.child.try_wait(), Ok(None))
}

/// Takes the right to start a server, or reports what is already there.
///
/// Returns `Ok(Some(url))` when a live server answers the question outright
/// and `Ok(None)` when the caller now holds the `Starting` claim and must go
/// on to spawn one. The lock is held only while deciding; the wait for
/// somebody else's start-up happens on the condvar, with the lock released.
fn claim_start(server: &Server) -> Result<Option<ServerInfo>, String> {
    enum Step {
        Ready(ServerInfo),
        Reap,
        Wait,
        Claim,
    }

    let mut slot = server.lock();
    loop {
        // Decided first and acted on after, so the borrow of the slot ends
        // before an arm that moves out of it or hands the guard to the condvar.
        let step = match &mut *slot {
            Slot::Running(serving) => {
                if still_alive(serving) {
                    Step::Ready(serving.info())
                } else {
                    Step::Reap
                }
            }
            Slot::Starting => Step::Wait,
            Slot::Idle => Step::Claim,
        };

        match step {
            Step::Ready(info) => return Ok(Some(info)),
            // A dead child left behind: reap it before starting another.
            Step::Reap => {
                if let Slot::Running(mut dead) = std::mem::replace(&mut *slot, Slot::Idle) {
                    dead.end();
                }
            }
            Step::Claim => {
                *slot = Slot::Starting;
                return Ok(None);
            }
            Step::Wait => {
                let (next, timeout) = server
                    .settled
                    .wait_timeout(slot, READY_TIMEOUT)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                slot = next;
                if timeout.timed_out() {
                    return Err(format!(
                        "nikcli serve non ha risposto entro {} secondi.",
                        READY_TIMEOUT.as_secs()
                    ));
                }
            }
        }
    }
}

/// Puts a started server in the slot, if the claim on it still stands.
fn install(server: &Server, mut serving: Serving) -> Result<ServerInfo, String> {
    let mut slot = server.lock();
    if !matches!(*slot, Slot::Starting) {
        /*
         * The claim is gone, so `nikcli_serve_stop` ran — or the window closed
         * — while this server was starting. Killing it is the only safe move:
         * the alternative is a server listening on a port nobody recorded.
         */
        drop(slot);
        serving.end();
        return Err("nikcli serve è stato fermato durante l'avvio.".to_string());
    }
    let info = serving.info();
    *slot = Slot::Running(serving);
    Ok(info)
}

/// Where nikcli reads the user's global config: `Global.Path.config` in
/// `@nikcli-ai/util`, then `nikcli.json` (`config.ts`, `global()`).
fn user_config_file() -> Option<PathBuf> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join("AppData").join("Roaming")))?
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| dirs::home_dir().map(|home| home.join(".config")))?
    };
    Some(base.join("nikcli").join("nikcli.json"))
}

/// `NIKCLI_CONFIG_CONTENT` for ADE's server, or `None` to leave the
/// environment as it is.
///
/// `inherited` is the variable ADE itself was started with, `user_files` the
/// text of the config files the user writes. A `small_model` in any of them
/// is theirs and stays; otherwise the inherited content gets `FREE_SMALL_MODEL`
/// added, or is made of it. A file only has to mention the key: nikcli reads
/// JSONC, and a commented-out line counting as a choice errs on the user's side.
/// Content that is not a JSON object is not touched: nikcli refuses it anyway.
fn small_model_content(inherited: Option<&str>, user_files: &[String]) -> Option<String> {
    let mut content = match inherited.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => match serde_json::from_str::<serde_json::Value>(text) {
            Ok(serde_json::Value::Object(object)) => object,
            _ => return None,
        },
        None => serde_json::Map::new(),
    };
    if content.contains_key("small_model") || user_files.iter().any(|text| text.contains("\"small_model\"")) {
        return None;
    }
    content.insert("small_model".into(), serde_json::Value::String(FREE_SMALL_MODEL.into()));
    Some(serde_json::Value::Object(content).to_string())
}

/// The user's own config files, as text: the global one and `NIKCLI_CONFIG`.
fn user_config_texts() -> Vec<String> {
    let custom = std::env::var_os("NIKCLI_CONFIG").map(PathBuf::from);
    user_config_file()
        .into_iter()
        .chain(custom)
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .collect()
}

/// 32 random bytes, in hex: the password of ADE's own server.
fn random_password() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("nessuna sorgente casuale per la password: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The `nikcli serve` command line. The password goes in the environment, as
/// Desktop's sidecar does it, never in the arguments: those are visible to
/// every process on the machine.
fn serve_command(program: &str, directory: Option<&str>, password: &str, config_content: Option<&str>) -> Command {
    let mut command = Command::new(program);
    command
        .arg("serve")
        .arg("--hostname=127.0.0.1")
        // Port 0 asks the OS for a free one; the readiness line reports which.
        // A fixed port would collide with a nikcli the user started themselves.
        .arg("--port=0")
        .env("NIKCLI_SERVER_USERNAME", USERNAME)
        .env("NIKCLI_SERVER_PASSWORD", password)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for name in AUTO_APPROVE {
        command.env_remove(name);
    }
    if let Some(content) = config_content {
        command.env("NIKCLI_CONFIG_CONTENT", content);
    }

    if let Some(dir) = directory.filter(|d| !d.is_empty()) {
        command.current_dir(dir);
    }

    #[cfg(windows)]
    {
        // No console window for a background service.
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Starts `nikcli serve`, or returns the URL of the one already running.
///
/// Idempotent on purpose: both the chat section and the voice assistant ask
/// for a server, they mount independently, and neither should have to know
/// whether the other got there first.
///
/// Blocking from beginning to end, and therefore never called on the thread
/// that draws the window — see `nikcli_serve_start`, which is the command.
fn start_blocking(server: &Server, directory: Option<String>) -> Result<ServerInfo, String> {
    if let Some(info) = claim_start(server)? {
        return Ok(info);
    }
    // From here on the slot says `Starting`, and this guard is what puts it
    // back however the function leaves.
    let _claim = Claim(server);
    spawn_own(server, directory)
}

/// Starts ADE's own `nikcli serve`, with a password of its own, and installs
/// it. The caller holds the `Starting` claim.
fn spawn_own(server: &Server, directory: Option<String>) -> Result<ServerInfo, String> {
    let program = which_on_path("nikcli")
        .ok_or_else(|| "nikcli non è nel PATH: installalo per usare chat e assistente.".to_string())?;
    let password = random_password()?;
    let inherited = std::env::var("NIKCLI_CONFIG_CONTENT").ok();
    let content = small_model_content(inherited.as_deref(), &user_config_texts());
    let mut command = serve_command(&program, directory.as_deref(), &password, content.as_deref());

    let mut child = command
        .spawn()
        .map_err(|error| format!("nikcli serve non è partito: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "nikcli serve non ha uno stdout leggibile".to_string())?;
    let stderr = child.stderr.take();

    let (ready_tx, ready_rx) = channel::<Result<String, String>>();

    /*
     * One thread reads stdout for the whole life of the server, not just until
     * it is ready.
     *
     * Stopping at the readiness line would leave nobody draining the pipe, and
     * a pipe nobody drains fills and blocks the writer — so the server would
     * wedge partway through its first busy minute, looking like a hang with no
     * error anywhere.
     */
    std::thread::spawn(move || {
        let mut announced = false;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !announced {
                if let Some(url) = parse_ready_line(&line) {
                    announced = true;
                    let _ = ready_tx.send(Ok(url));
                }
            }
        }
        if !announced {
            let _ = ready_tx.send(Err("nikcli serve è uscito senza annunciare una porta".into()));
        }
    });

    // stderr drained too, and kept: it is the only place a start-up failure
    // explains itself, and the message is what the user is shown.
    let (err_tx, err_rx) = channel::<String>();
    if let Some(stderr) = stderr {
        std::thread::spawn(move || {
            let mut collected = String::new();
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if collected.len() < 4096 {
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
            let _ = err_tx.send(collected);
        });
    }

    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(url)) => install(
            server,
            Serving {
                url,
                auth: Some((USERNAME.to_string(), password)),
                version: None,
                child,
            },
        ),
        Ok(Err(reason)) => {
            crate::pty::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            let detail = err_rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
            Err(if detail.trim().is_empty() {
                reason
            } else {
                format!("{reason}: {}", detail.trim())
            })
        }
        Err(RecvTimeoutError::Timeout) => {
            // Killed rather than left behind: an unreachable server holding a
            // port is worse than no server at all.
            crate::pty::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "nikcli serve non ha risposto entro {} secondi.",
                READY_TIMEOUT.as_secs()
            ))
        }
        Err(RecvTimeoutError::Disconnected) => {
            crate::pty::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
            Err("nikcli serve è terminato durante l'avvio.".into())
        }
    }
}

/*
 * All three commands are `async`, and the two that block go further and run
 * on a blocking worker.
 *
 * A synchronous `#[tauri::command]` is dispatched on the thread that owns the
 * window — the same lesson `pty.rs` learned and documents three times. Here it
 * was the worst case in the crate: `recv_timeout(45s)` on that thread, with
 * the mutex held, so a cold start froze the whole window and even asking for
 * the server's status queued behind it. `async` alone would only move it to an
 * async worker, where a forty-five second block still holds a slot the rest of
 * the runtime wants; `spawn_blocking` is the thread pool meant for exactly
 * this.
 */

/// Finds or starts the server, and says which. Never the password.
#[tauri::command]
pub async fn nikcli_serve_start(
    app: tauri::AppHandle,
    directory: Option<String>,
) -> Result<ServerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let server = app.state::<Server>();
        start_blocking(&server, directory)
    })
    .await
    .map_err(|_| "avvio del server interrotto".to_string())?
}

/// The running server, or nothing. Never starts one.
#[tauri::command]
pub async fn nikcli_serve_status(state: tauri::State<'_, Server>) -> Result<Option<ServerInfo>, String> {
    let mut slot = state.lock();
    let Slot::Running(serving) = &mut *slot else {
        return Ok(None);
    };
    Ok(still_alive(serving).then(|| serving.info()))
}

#[tauri::command]
pub async fn nikcli_serve_stop(app: tauri::AppHandle) {
    // `kill` and `wait` both block, briefly but really.
    let _ = tauri::async_runtime::spawn_blocking(move || app.state::<Server>().shutdown()).await;
}

#[cfg(test)]
mod tests {
    use super::{
        Claim, Server, ServerInfo, Serving, Slot, claim_start, install, parse_ready_line, serve_command,
    };
    use std::process::{Child, Command, Stdio};
    use std::time::Duration;

    /// A child that stays up long enough to be looked at, on either platform.
    fn sleeper() -> Child {
        let mut command = if cfg!(windows) {
            let mut it = Command::new("cmd");
            it.args(["/C", "ping -n 20 127.0.0.1"]);
            it
        } else {
            let mut it = Command::new("sh");
            it.args(["-c", "sleep 20"]);
            it
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("il processo di prova non è partito")
    }

    /// A child that has already exited and been reaped by nobody.
    fn finished() -> Child {
        let mut command = if cfg!(windows) {
            let mut it = Command::new("cmd");
            it.args(["/C", "exit 0"]);
            it
        } else {
            let mut it = Command::new("sh");
            it.args(["-c", "exit 0"]);
            it
        };
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("il processo di prova non è partito");
        let _ = child.wait();
        child
    }

    fn own(url: &str, child: Child) -> Serving {
        Serving {
            url: url.to_string(),
            auth: Some(("nikcli".into(), "finta".into())),
            version: None,
            child,
        }
    }

    fn info(url: &str) -> ServerInfo {
        ServerInfo {
            url: url.to_string(),
            version: None,
        }
    }

    fn running(server: &Server, url: &str, child: Child) {
        *server.lock() = Slot::Running(own(url, child));
    }

    #[test]
    fn a_live_server_answers_without_a_second_one_being_started() {
        let server = Server::default();
        running(&server, "http://127.0.0.1:1", sleeper());

        assert_eq!(claim_start(&server).unwrap(), Some(info("http://127.0.0.1:1")));
        // Still running: the caller was answered, not handed a claim.
        assert!(matches!(*server.lock(), Slot::Running(_)));
        server.shutdown();
    }

    #[test]
    fn a_dead_child_is_reaped_and_the_slot_is_claimed() {
        let server = Server::default();
        running(&server, "http://127.0.0.1:2", finished());

        assert_eq!(claim_start(&server).unwrap(), None);
        assert!(matches!(*server.lock(), Slot::Starting));
    }

    #[test]
    fn giving_up_the_claim_leaves_the_slot_free_for_the_next_caller() {
        let server = Server::default();
        assert_eq!(claim_start(&server).unwrap(), None);
        {
            let _claim = Claim(&server);
        }
        assert!(matches!(*server.lock(), Slot::Idle));
        // And the next caller can claim it in turn.
        assert_eq!(claim_start(&server).unwrap(), None);
    }

    #[test]
    fn a_second_caller_waits_for_the_start_instead_of_starting_another() {
        let server = Server::default();
        assert_eq!(claim_start(&server).unwrap(), None);

        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| claim_start(&server));
            // Long enough for the other thread to reach the condvar; if it
            // raced ahead instead it would have claimed the slot and returned
            // None, which is what the assertion below rules out.
            std::thread::sleep(Duration::from_millis(80));
            install(&server, own("http://127.0.0.1:3", sleeper())).unwrap();
            server.settled.notify_all();

            assert_eq!(waiting.join().unwrap().unwrap(), Some(info("http://127.0.0.1:3")));
        });

        server.shutdown();
    }

    #[test]
    fn a_server_stopped_while_it_was_starting_is_killed_rather_than_installed() {
        let server = Server::default();
        assert_eq!(claim_start(&server).unwrap(), None);
        // `nikcli_serve_stop` arriving mid-start: the claim is dropped.
        server.shutdown();

        let child = sleeper();
        let id = child.id();
        assert!(install(&server, own("http://127.0.0.1:4", child)).is_err());
        assert!(matches!(*server.lock(), Slot::Idle));

        // The child install refused is not left listening on a port nobody
        // recorded. It was killed and waited for inside `install`.
        let mut probe = if cfg!(windows) {
            let mut it = Command::new("cmd");
            it.args(["/C", &format!("tasklist /FI \"PID eq {id}\" | find \"{id}\"")]);
            it
        } else {
            let mut it = Command::new("sh");
            it.args(["-c", &format!("kill -0 {id}")]);
            it
        };
        let gone = probe
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| !status.success())
            .unwrap_or(true);
        assert!(gone, "il processo {id} è rimasto in vita");
    }

    #[test]
    fn shutdown_during_a_start_cancels_the_claim() {
        let server = Server::default();
        assert_eq!(claim_start(&server).unwrap(), None);
        server.shutdown();
        assert!(matches!(*server.lock(), Slot::Idle));
    }

    #[test]
    fn reads_the_url_out_of_the_readiness_line() {
        assert_eq!(
            parse_ready_line("nikcli server listening on http://127.0.0.1:52341"),
            Some("http://127.0.0.1:52341".to_string())
        );
    }

    #[test]
    fn drops_a_trailing_slash_so_the_sdk_does_not_double_it() {
        assert_eq!(
            parse_ready_line("nikcli server listening on http://127.0.0.1:4096/"),
            Some("http://127.0.0.1:4096".to_string())
        );
    }

    #[test]
    fn accepts_https_and_trailing_words() {
        assert_eq!(
            parse_ready_line("nikcli server listening on https://127.0.0.1:8443 (mdns)"),
            Some("https://127.0.0.1:8443".to_string())
        );
    }

    #[test]
    fn ignores_every_other_line() {
        // The server prints plenty before it binds; none of it is a URL to
        // connect to, and treating one as such would point the SDK at nothing.
        assert_eq!(parse_ready_line("loading config from ~/.config/nikcli"), None);
        assert_eq!(parse_ready_line(""), None);
        assert_eq!(parse_ready_line("see http://127.0.0.1:1234 for details"), None);
    }

    #[test]
    fn refuses_a_readiness_line_with_no_url() {
        assert_eq!(parse_ready_line("nikcli server listening"), None);
    }

    #[test]
    fn the_password_goes_in_the_environment_never_in_the_arguments() {
        let command = serve_command("nikcli", None, "finta-password", None);
        let args: Vec<String> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(args, ["serve", "--hostname=127.0.0.1", "--port=0"]);
        let envs: Vec<(String, String)> = command
            .get_envs()
            .filter_map(|(name, value)| Some((name.to_string_lossy().into_owned(), value?.to_string_lossy().into_owned())))
            .collect();
        assert!(envs.contains(&("NIKCLI_SERVER_PASSWORD".into(), "finta-password".into())));
        assert!(envs.contains(&("NIKCLI_SERVER_USERNAME".into(), "nikcli".into())));
    }

    #[test]
    fn a_free_small_model_only_when_the_user_chose_none() {
        use super::{FREE_SMALL_MODEL, small_model_content};
        let free = format!(r#"{{"small_model":"{FREE_SMALL_MODEL}"}}"#);
        // Nothing chosen anywhere: ADE's free one.
        assert_eq!(small_model_content(None, &[]).as_deref(), Some(free.as_str()));
        assert_eq!(small_model_content(None, &[r#"{"model":"openrouter/x"}"#.into()]).as_deref(), Some(free.as_str()));
        // Chosen in a config file, even empty (off), or commented out in JSONC: theirs.
        for file in [
            r#"{"small_model":"anthropic/claude-haiku"}"#,
            r#"{"small_model":""}"#,
            "{\n  // \"small_model\": \"x/y\"\n}",
        ] {
            assert_eq!(small_model_content(None, &[file.into()]), None, "{file}");
        }
        // The inherited inline config: kept whole, with the free one added only if it has none.
        let merged = small_model_content(Some(r#"{"model":"openrouter/a:free","enabled_providers":["openrouter"]}"#), &[]).unwrap();
        let merged: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(merged["model"], "openrouter/a:free");
        assert_eq!(merged["enabled_providers"][0], "openrouter");
        assert_eq!(merged["small_model"], FREE_SMALL_MODEL);
        assert_eq!(small_model_content(Some(r#"{"small_model":"x/y"}"#), &[]), None);
        assert_eq!(small_model_content(Some("non json"), &[]), None);
        assert!(FREE_SMALL_MODEL.ends_with(":free"));
    }

    #[test]
    fn the_inline_config_reaches_the_server_only_when_there_is_one() {
        let env_of = |command: &std::process::Command| {
            command
                .get_envs()
                .find(|(name, _)| *name == "NIKCLI_CONFIG_CONTENT")
                .map(|(_, value)| value.map(|v| v.to_string_lossy().into_owned()))
        };
        let without = serve_command("nikcli", None, "finta-password", None);
        assert_eq!(env_of(&without), None);
        let with = serve_command("nikcli", None, "finta-password", Some(r#"{"small_model":"x/y:free"}"#));
        assert_eq!(env_of(&with), Some(Some(r#"{"small_model":"x/y:free"}"#.to_string())));
    }

    #[test]
    fn the_server_never_inherits_an_approve_everything_flag() {
        let command = serve_command("nikcli", None, "finta-password", None);
        let removed: Vec<String> = command
            .get_envs()
            .filter(|(_, value)| value.is_none())
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect();
        assert!(removed.contains(&"NIKCLI_AUTO_APPROVE".to_string()), "{removed:?}");
        assert!(removed.contains(&"NIKCLI_DANGEROUSLY_SKIP_PERMISSIONS".to_string()), "{removed:?}");
    }

    #[test]
    fn the_chat_never_looks_for_a_server_ade_did_not_start() {
        // The code of both files, doc comments and this test module left out:
        // nothing reads nikcli's service registration or makes a server
        // without a child of ADE's.
        let registration = ["service", ".json"].concat();
        for (name, source) in [("serve.rs", include_str!("serve.rs")), ("serve_proxy.rs", include_str!("serve_proxy.rs"))] {
            let code: String = source
                .split("#[cfg(test)]")
                .next()
                .unwrap()
                .lines()
                .filter(|line| !line.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(!code.contains(&registration), "{name} legge la registrazione del servizio");
            assert!(!code.contains("child: None"), "{name} crea un server senza processo di ADE");
        }
    }

    #[test]
    fn every_server_gets_its_own_random_password() {
        let one = super::random_password().unwrap();
        let two = super::random_password().unwrap();
        assert_eq!(one.len(), 64);
        assert!(one.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(one, two);
    }

    #[test]
    fn stopping_ades_server_takes_what_it_started_with_it() {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        // `cmd` standing in for an npm shim, `ping` for the server it starts.
        let server = Server::default();
        let child = if cfg!(windows) {
            sleeper()
        } else {
            // `sh -c "sleep 20"` would exec in place and leave no grandchild.
            Command::new("sh")
                .args(["-c", "sleep 20 & wait"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("il processo di prova non è partito")
        };
        let shim = child.id();
        running(&server, "http://127.0.0.1:7", child);

        let mut sys = System::new();
        let mut grandchild = None;
        for _ in 0..50 {
            sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
            grandchild = sys
                .processes()
                .values()
                .find(|process| process.parent().map(|parent| parent.as_u32()) == Some(shim))
                .map(|process| process.pid().as_u32());
            if grandchild.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let grandchild = grandchild.expect("il processo figlio del finto shim non è partito");

        server.shutdown();
        std::thread::sleep(Duration::from_millis(300));
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        assert!(sys.process(Pid::from_u32(grandchild)).is_none(), "il processo {grandchild} è rimasto in vita");
    }

    /// Status of `path` on the running server, through the proxy's own code.
    fn live_status(server: &Server, path: &str, with_auth: bool) -> u16 {
        use crate::serve_proxy::{ProxyEvent, relay, target};
        let (base, auth) = server.endpoint().expect("nessun server");
        let client = crate::serve_proxy::client_with_timeout(Duration::from_secs(60)).unwrap();
        let mut status = 0;
        tauri::async_runtime::block_on(relay(
            &client,
            target(&base, path).unwrap(),
            reqwest::Method::GET,
            Vec::new(),
            None,
            if with_auth { auth } else { None },
            |event| {
                if let ProxyEvent::Head { status: code, .. } = event {
                    status = code;
                }
                true
            },
        ));
        status
    }

    /// The real nikcli: a server of ADE's own. Health and `provider.list`
    /// only — no model is called.
    /// `cargo test --lib -- --ignored live_`
    #[test]
    #[ignore]
    fn live_health_and_provider_list() {
        let dir = std::env::temp_dir().join(format!("ade-c1-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let own = Server::default();
        assert_eq!(claim_start(&own).unwrap(), None);
        let started = {
            let _claim = Claim(&own);
            super::spawn_own(&own, Some(dir.to_string_lossy().into_owned())).unwrap()
        };
        assert_eq!(own.lock_info().as_ref(), Some(&started));
        assert_eq!(live_status(&own, "/global/health", false), 200);
        assert_eq!(live_status(&own, "/provider", true), 200);
        // Without the password it is refused: the random one is enforced.
        assert_eq!(live_status(&own, "/provider", false), 401);
        own.shutdown();
        assert!(own.endpoint().is_none());
    }
}
