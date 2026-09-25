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
/// One server per window: the background service nikcli already runs, when
/// `service.json` names one that answers, or else a `nikcli serve` of ADE's
/// own, started on demand and killed — with everything it started — when ADE
/// exits. It is deliberately not the `pty_spawn` path — that one hands a
/// terminal to a human, and this one is a background service whose stdout is a
/// protocol.
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

/// How long a discovered service gets to prove it is alive and ours to use.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) struct Serving {
    pub(crate) url: String,
    /// Basic-auth credentials. The password never leaves this process.
    pub(crate) auth: Option<(String, String)>,
    pub(crate) version: Option<String>,
    /// ADE's own server. `None` for the shared background service, which the
    /// user's other clients are using too and is not ADE's to stop.
    child: Option<Child>,
}

impl Serving {
    fn info(&self) -> ServerInfo {
        ServerInfo {
            url: self.url.clone(),
            version: self.version.clone(),
            shared: self.child.is_none(),
        }
    }

    /// Ends ADE's own server and whatever it started. Leaves a shared one be.
    fn end(&mut self) {
        if let Some(child) = self.child.as_mut() {
            // `nikcli` can be an npm shim, and killing the shim alone would
            // leave the real server listening.
            crate::pty::kill_tree(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// What the page is told about the server: never the password.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub url: String,
    pub version: Option<String>,
    /// The user's background service rather than ADE's own.
    pub shared: bool,
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
    pub(crate) fn endpoint(&self) -> Option<(String, Option<(String, String)>, bool)> {
        let mut slot = self.lock();
        let Slot::Running(serving) = &mut *slot else { return None };
        if !still_alive(serving) {
            return None;
        }
        Some((serving.url.clone(), serving.auth.clone(), serving.child.is_none()))
    }

    /// Drops a shared service that stopped answering, so the next start looks
    /// again — and starts ADE's own if there is nothing to find.
    pub(crate) fn forget_shared(&self, url: &str) {
        let mut slot = self.lock();
        if matches!(&*slot, Slot::Running(serving) if serving.child.is_none() && serving.url == url) {
            *slot = Slot::Idle;
        }
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
/// A shared service has no child here; a call that finds it gone forgets it.
fn still_alive(serving: &mut Serving) -> bool {
    match serving.child.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => true,
    }
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

/// 32 random bytes, in hex: the password of ADE's own server.
fn random_password() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| format!("nessuna sorgente casuale per la password: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// The `nikcli serve` command line. The password goes in the environment, as
/// Desktop's sidecar does it, never in the arguments: those are visible to
/// every process on the machine.
fn serve_command(program: &str, directory: Option<&str>, password: &str) -> Command {
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

/// Where nikcli writes `service.json`: `Global.Path.state` in `@nikcli-ai/util`.
fn state_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join("AppData").join("Local")))?;
        return Some(local.join("State").join("nikcli"));
    }
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| dirs::home_dir().map(|home| home.join(".local").join("state")))?;
    Some(base.join("nikcli"))
}

/// The address in a service registration, if it is one ADE may call: plain
/// HTTP on this machine. Anything else is refused, not trusted — the file is
/// writable by any process running as the user.
pub(crate) fn registration_url(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let url = value.get("url")?.as_str()?.trim_end_matches('/');
    loopback_http(url).then(|| url.to_string())
}

/// `http://` to 127.0.0.1, `localhost` or `[::1]`, with a port and nothing else.
pub(crate) fn loopback_http(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return false };
    let host_ok = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    parsed.scheme() == "http"
        && host_ok
        && parsed.port().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && matches!(parsed.path(), "" | "/")
        && parsed.query().is_none()
}

/// The shared background service, if `service.json` names one that answers
/// its health check and lets ADE in.
///
/// Its password, when it has one, is the user's `NIKCLI_SERVER_PASSWORD`: the
/// service inherits it from the environment it was started in, and so does
/// ADE. A service that still refuses is left alone, and ADE starts its own.
fn discover() -> Option<Serving> {
    let text = std::fs::read_to_string(state_dir()?.join("service.json")).ok()?;
    let url = registration_url(&text)?;
    let auth = std::env::var("NIKCLI_SERVER_PASSWORD")
        .ok()
        .map(|password| password.trim().to_string())
        .filter(|password| !password.is_empty())
        .map(|password| {
            let user = std::env::var("NIKCLI_SERVER_USERNAME").unwrap_or_else(|_| USERNAME.to_string());
            (user, password)
        });
    let version = tauri::async_runtime::block_on(probe(&url, auth.clone()))?;
    Some(Serving {
        url,
        auth,
        version: Some(version),
        child: None,
    })
}

/// The server's version when `/global/health` answers healthy and an
/// authenticated call goes through; `None` otherwise.
///
/// Health alone is not enough: it is public, so a service with a password
/// ADE does not know would pass it and then refuse every real call.
pub(crate) async fn probe(url: &str, auth: Option<(String, String)>) -> Option<String> {
    let client = crate::serve_proxy::client_with_timeout(PROBE_TIMEOUT).ok()?;
    let health: serde_json::Value = client
        .get(format!("{url}/global/health"))
        .send()
        .await
        .ok()
        .filter(|response| response.status().is_success())?
        .json()
        .await
        .ok()?;
    if health.get("healthy").and_then(|value| value.as_bool()) != Some(true) {
        return None;
    }
    let mut check = client.get(format!("{url}/project/current"));
    if let Some((user, password)) = auth {
        check = check.basic_auth(user, Some(password));
    }
    let response = check.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    Some(health.get("version").and_then(|value| value.as_str()).unwrap_or_default().to_string())
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

    // The service the user's other clients already share: its engine is warm,
    // and a second server would load it all again.
    if let Some(shared) = discover() {
        return install(server, shared);
    }
    spawn_own(server, directory)
}

/// Starts ADE's own `nikcli serve`, with a password of its own, and installs
/// it. The caller holds the `Starting` claim.
fn spawn_own(server: &Server, directory: Option<String>) -> Result<ServerInfo, String> {
    let program = which_on_path("nikcli")
        .ok_or_else(|| "nikcli non è nel PATH: installalo per usare chat e assistente.".to_string())?;
    let password = random_password()?;
    let mut command = serve_command(&program, directory.as_deref(), &password);

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
                child: Some(child),
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
        Claim, Server, ServerInfo, Serving, Slot, claim_start, install, loopback_http, parse_ready_line,
        registration_url, serve_command,
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
            child: Some(child),
        }
    }

    fn info(url: &str) -> ServerInfo {
        ServerInfo {
            url: url.to_string(),
            version: None,
            shared: false,
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
        let command = serve_command("nikcli", None, "finta-password");
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
    fn every_server_gets_its_own_random_password() {
        let one = super::random_password().unwrap();
        let two = super::random_password().unwrap();
        assert_eq!(one.len(), 64);
        assert!(one.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(one, two);
    }

    #[test]
    fn reads_the_address_out_of_a_service_registration() {
        let text = r#"{"id":"x","pid":1,"url":"http://127.0.0.1:49374","version":"1.384.0","startedAt":1}"#;
        assert_eq!(registration_url(text), Some("http://127.0.0.1:49374".to_string()));
        assert_eq!(
            registration_url(r#"{"url":"http://localhost:4096/"}"#),
            Some("http://localhost:4096".to_string())
        );
    }

    #[test]
    fn a_registration_pointing_off_this_machine_is_refused() {
        // Any process running as the user can write service.json.
        for text in [
            r#"{"url":"http://evil.example:4096"}"#,
            r#"{"url":"https://127.0.0.1:4096"}"#,
            r#"{"url":"http://user:pw@127.0.0.1:4096"}"#,
            r#"{"url":"http://127.0.0.1:4096/altro"}"#,
            r#"{"url":"http://127.0.0.1"}"#,
            r#"{"pid":1}"#,
            "non json",
        ] {
            assert_eq!(registration_url(text), None, "accettato: {text}");
        }
        assert!(loopback_http("http://[::1]:4096"));
    }

    #[test]
    fn a_healthy_service_that_lets_ade_in_is_used() {
        use crate::serve_proxy::test_server::{plain, serve};
        let (url, requests) = serve(vec![
            plain("200 OK", r#"{"healthy":true,"version":"1.384.0"}"#),
            plain("200 OK", r#"{"id":"p"}"#),
        ]);
        let version = tauri::async_runtime::block_on(super::probe(&url, Some(("nikcli".into(), "finta".into()))));
        assert_eq!(version.as_deref(), Some("1.384.0"));
        let _ = requests.recv_timeout(Duration::from_secs(5)).unwrap();
        let check = requests.recv_timeout(Duration::from_secs(5)).unwrap().to_ascii_lowercase();
        assert!(check.starts_with("get /project/current"), "{check}");
        assert!(check.contains("authorization: basic "), "{check}");
    }

    #[test]
    fn a_service_that_refuses_ade_is_not_used() {
        use crate::serve_proxy::test_server::{plain, serve};
        // Health is public, so it passes even where every real call would not.
        let (url, _) = serve(vec![
            plain("200 OK", r#"{"healthy":true,"version":"1.384.0"}"#),
            plain("401 Unauthorized", "{}"),
        ]);
        assert_eq!(tauri::async_runtime::block_on(super::probe(&url, None)), None);
    }

    #[test]
    fn a_shared_service_is_forgotten_not_killed_and_ades_own_is_kept() {
        let server = Server::default();
        *server.lock() = Slot::Running(Serving {
            url: "http://127.0.0.1:5".into(),
            auth: None,
            version: Some("1".into()),
            child: None,
        });
        assert_eq!(server.endpoint().map(|(_, _, shared)| shared), Some(true));
        server.forget_shared("http://127.0.0.1:5");
        assert!(matches!(*server.lock(), Slot::Idle));

        running(&server, "http://127.0.0.1:6", sleeper());
        server.forget_shared("http://127.0.0.1:6");
        assert!(matches!(*server.lock(), Slot::Running(_)));
        server.shutdown();
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
        let (base, auth, _) = server.endpoint().expect("nessun server");
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

    /// The real nikcli: its shared service when there is one, then a server
    /// of ADE's own. Health and `provider.list` only — no model is called.
    /// `cargo test --lib -- --ignored live_`
    #[test]
    #[ignore]
    fn live_health_and_provider_list() {
        let shared = Server::default();
        match super::discover() {
            Some(found) => {
                *shared.lock() = Slot::Running(found);
                assert_eq!(live_status(&shared, "/global/health", true), 200);
                assert_eq!(live_status(&shared, "/provider", true), 200);
                println!("servizio condiviso: {:?}", shared.lock_info());
                shared.shutdown();
            }
            None => println!("nessun servizio condiviso che risponda"),
        }

        let dir = std::env::temp_dir().join(format!("ade-c1-live-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let own = Server::default();
        assert_eq!(claim_start(&own).unwrap(), None);
        let started = {
            let _claim = Claim(&own);
            super::spawn_own(&own, Some(dir.to_string_lossy().into_owned())).unwrap()
        };
        assert!(!started.shared);
        assert_eq!(live_status(&own, "/global/health", false), 200);
        assert_eq!(live_status(&own, "/provider", true), 200);
        // Without the password it is refused: the random one is enforced.
        assert_eq!(live_status(&own, "/provider", false), 401);
        own.shutdown();
        assert!(own.endpoint().is_none());
    }
}
