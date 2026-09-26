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

/// How long a second caller waits for a start under way: as long as one can
/// take, two servers and the catalog between them (`spawn_own`), so it is not
/// told the server did not answer while the start is still going and then
/// succeeds (modello assente review, B2).
const START_WAIT: Duration = Duration::from_secs(2 * 45 + 15 + 5);

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
/// `directories` loop) and win.
///
/// The same holds for `model` (`free_models_content`): a model chosen in the
/// project's root `nikcli.json` does not count for ADE's server, which uses
/// the free one; to choose one for it, put it in `<project>/.nikcli/nikcli.json`.
/// It errs on the free side, as for `small_model` (modello assente, second
/// reading, BASSO 2).
///
/// Models leave the catalog (`nex-agi/nex-n2.5-mini:free` did), and a small
/// model that is not there makes those calls fail quietly: nikcli does not
/// fall back to another. So the one ADE gives is chosen from the server's own
/// catalog when it starts (`pick_small_model`), and this is only the fixed
/// fallback, for a catalog that cannot be read.
pub(crate) const FREE_SMALL_MODEL: &str = KNOWN_FREE_SMALL[0];

/// Free models known to answer as a small model, best first: Nemotron 3.5
/// Lightning answered in 12 s on 2026-09-26, Nemotron 3 Super titled and
/// summarised the Chat's recorded conversation (C4).
const KNOWN_FREE_SMALL: [&str; 2] = [
    "openrouter/nvidia/nemotron-3.5-lightning:free",
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
];

/// The small model chosen from the catalog, for the next server of this run:
/// asked for again only when it is not the one a server started with.
static CHOSEN_SMALL_MODEL: Mutex<Option<String>> = Mutex::new(None);

/// How long the catalog may take; past it the server keeps the model it has.
const CATALOG_TIMEOUT: Duration = Duration::from_secs(15);

/// The catalog is a few hundred kilobytes; past this it is not read at all.
const CATALOG_LIMIT: usize = 32 * 1024 * 1024;

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
                    .wait_timeout(slot, START_WAIT)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                slot = next;
                if timeout.timed_out() {
                    return Err(format!(
                        "nikcli serve non ha risposto entro {} secondi.",
                        START_WAIT.as_secs()
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
/// text of the config files the user writes. Two keys get the free `model`
/// passed here when nobody chose them, each on its own:
///
/// - `small_model`, see `FREE_SMALL_MODEL`. A file only has to mention the
///   key: a commented-out line counting as a choice errs on the user's side.
/// - `model`, the one a prompt without a model gets (modello assente review,
///   point 1): a bot with no model in its file, in its agent or in the config
///   fell on the provider's default, with OpenRouter a paid one. Here only a
///   top-level `model` counts, read as JSONC (`top_level_key`): `"model"`
///   also appears inside `agent` blocks, and taking that for a choice would
///   leave the paid default in place. A file that cannot be read counts as
///   a choice.
///
/// Content that is not a JSON object is not touched: nikcli refuses it anyway.
fn free_models_content(inherited: Option<&str>, user_files: &[String], model: &str) -> Option<String> {
    let mut content = match inherited.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) => match serde_json::from_str::<serde_json::Value>(text) {
            Ok(serde_json::Value::Object(object)) => object,
            _ => return None,
        },
        None => serde_json::Map::new(),
    };
    let mut changed = false;
    if !content.contains_key("small_model") && !user_files.iter().any(|text| text.contains("\"small_model\"")) {
        content.insert("small_model".into(), serde_json::Value::String(model.into()));
        changed = true;
    }
    if !content.contains_key("model") && !user_files.iter().any(|text| top_level_key(text, "model")) {
        content.insert("model".into(), serde_json::Value::String(model.into()));
        changed = true;
    }
    changed.then(|| serde_json::Value::Object(content).to_string())
}

/// Whether the JSONC `text` has `key` at its top level. Comments and trailing
/// commas are dropped first; text that still does not parse counts as having
/// it, which leaves the user's file in charge.
fn top_level_key(text: &str, key: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(&plain_json(text)) {
        Ok(serde_json::Value::Object(object)) => object.contains_key(key),
        Ok(_) => false,
        Err(_) => text.contains(&format!("\"{key}\"")),
    }
}

/// JSONC as JSON: `//` and `/* */` comments and trailing commas removed,
/// strings left as they are. Comments first, then commas: in `1, // nota`
/// before a `}` the comma is only trailing once the comment is gone
/// (modello assente, second reading, BASSO 1).
fn plain_json(text: &str) -> String {
    without_trailing_commas(&without_comments(text))
}

/// Walks `text` outside its strings: `step` sees each character there with
/// the rest of the text, and says how many characters it took and what to
/// write for them. Strings, escapes included, are copied as they are.
fn outside_strings(text: &str, mut step: impl FnMut(&[char], usize) -> (usize, Option<char>)) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let (mut at, mut in_string) = (0, false);
    while at < chars.len() {
        let c = chars[at];
        if in_string {
            out.push(c);
            if c == '\\' && at + 1 < chars.len() {
                out.push(chars[at + 1]);
                at += 1;
            } else if c == '"' {
                in_string = false;
            }
            at += 1;
        } else if c == '"' {
            in_string = true;
            out.push(c);
            at += 1;
        } else {
            let (taken, written) = step(&chars, at);
            out.extend(written);
            at += taken.max(1);
        }
    }
    out
}

/// `//` to the end of the line and `/* */`, each left as one space.
fn without_comments(text: &str) -> String {
    outside_strings(text, |chars, at| match (chars[at], chars.get(at + 1)) {
        ('/', Some('/')) => {
            let end = chars[at..].iter().position(|c| *c == '\n').map_or(chars.len(), |n| at + n);
            (end - at, Some(' '))
        }
        ('/', Some('*')) => {
            let end = (at + 2..chars.len().saturating_sub(1))
                .find(|&i| chars[i] == '*' && chars[i + 1] == '/')
                .map_or(chars.len(), |i| i + 2);
            (end - at, Some(' '))
        }
        (c, _) => (1, Some(c)),
    })
}

/// A comma followed, past any whitespace, by `}` or `]` is dropped.
fn without_trailing_commas(text: &str) -> String {
    outside_strings(text, |chars, at| {
        let c = chars[at];
        let trailing = c == ',' && matches!(chars[at + 1..].iter().find(|next| !next.is_whitespace()), Some('}') | Some(']'));
        (1, (!trailing).then_some(c))
    })
}

/// Whether a model of the catalog can title and summarise for free: free by
/// its id and with no price above 0 where the catalog gives one (modello
/// assente review, B1), a text model that calls tools, not on its way out.
fn fit_small_model(id: &str, model: &serde_json::Value) -> bool {
    let capabilities = &model["capabilities"];
    let priced = |side: &str| model["cost"][side].as_f64().is_some_and(|cost| cost > 0.0);
    id.ends_with(":free")
        && !priced("input")
        && !priced("output")
        && model["status"].as_str() != Some("deprecated")
        && capabilities["toolcall"].as_bool() == Some(true)
        && capabilities["output"]["text"].as_bool() != Some(false)
}

/// The small model for ADE's server, from its catalog (`GET /provider`): the
/// first of `KNOWN_FREE_SMALL` it has, else its first free text model with
/// tool calls, by provider and then by id; `None` when it has none. Only a
/// connected provider's models count: the server runs no other.
fn pick_small_model(catalog: &serde_json::Value) -> Option<String> {
    let connected: Vec<&str> = catalog["connected"].as_array()?.iter().filter_map(|name| name.as_str()).collect();
    let providers: Vec<(&str, &serde_json::Map<String, serde_json::Value>)> = catalog["all"]
        .as_array()?
        .iter()
        .filter_map(|provider| Some((provider["id"].as_str()?, provider["models"].as_object()?)))
        .filter(|(name, _)| connected.contains(name))
        .collect();
    let known = KNOWN_FREE_SMALL.iter().find(|known| {
        known.split_once('/').is_some_and(|(provider, id)| {
            providers
                .iter()
                .any(|(name, models)| *name == provider && models.get(id).is_some_and(|model| fit_small_model(id, model)))
        })
    });
    if let Some(known) = known {
        return Some(known.to_string());
    }
    providers.iter().find_map(|(name, models)| {
        let mut ids: Vec<&String> = models.iter().filter(|(id, model)| fit_small_model(id, model)).map(|(id, _)| id).collect();
        ids.sort();
        ids.first().map(|id| format!("{name}/{id}"))
    })
}

/// The small model the running server's catalog offers (`pick_small_model`),
/// or `None` when it cannot be read in time.
fn catalog_small_model(serving: &Serving) -> Option<String> {
    use crate::serve_proxy::{ProxyEvent, relay, target};
    let client = crate::serve_proxy::client_with_timeout(CATALOG_TIMEOUT).ok()?;
    let url = target(&serving.url, "/provider").ok()?;
    let mut body = Vec::new();
    let mut ok = false;
    tauri::async_runtime::block_on(relay(
        &client,
        url,
        reqwest::Method::GET,
        Vec::new(),
        None,
        serving.auth.clone(),
        |event| match event {
            ProxyEvent::Head { status, .. } => {
                ok = status == 200;
                ok
            }
            ProxyEvent::Chunk { bytes } => {
                body.extend_from_slice(&bytes);
                body.len() <= CATALOG_LIMIT
            }
            _ => true,
        },
    ));
    if !ok || body.len() > CATALOG_LIMIT {
        return None;
    }
    pick_small_model(&serde_json::from_slice(&body).ok()?)
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
///
/// When the small model is ADE's to give, the server's catalog says which:
/// the one it started with stays if the catalog would pick it; otherwise one
/// with the catalog's pick is started, once, and takes the first one's place
/// when it is up (`replace_when_ready`). The pick is kept for the next start
/// of this run, so the second server is the exception.
fn spawn_own(server: &Server, directory: Option<String>) -> Result<ServerInfo, String> {
    let program = which_on_path("nikcli")
        .ok_or_else(|| "nikcli non è nel PATH: installalo per usare chat e assistente.".to_string())?;
    let inherited = std::env::var("NIKCLI_CONFIG_CONTENT").ok();
    let serving = start_with_small_model(
        inherited.as_deref(),
        &user_config_texts(),
        &CHOSEN_SMALL_MODEL,
        |content| launch(&program, directory.as_deref(), content),
        catalog_small_model,
    )?;
    install(server, serving)
}

/// A started server with the small model `spawn_own` describes: `launch`
/// starts one with a `NIKCLI_CONFIG_CONTENT`, `catalog` reads its pick, and
/// `chosen` keeps the pick for the next start. Apart so that the tests can run
/// it with their own processes and catalog.
fn start_with_small_model(
    inherited: Option<&str>,
    user_files: &[String],
    chosen: &Mutex<Option<String>>,
    mut launch: impl FnMut(Option<&str>) -> Result<Serving, String>,
    catalog: impl Fn(&Serving) -> Option<String>,
) -> Result<Serving, String> {
    let started_with = chosen
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        .unwrap_or_else(|| FREE_SMALL_MODEL.to_string());
    let content = free_models_content(inherited, user_files, &started_with);
    let mut serving = launch(content.as_deref())?;
    if content.is_some() {
        if let Some(picked) = catalog(&serving) {
            *chosen.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(picked.clone());
            if picked != started_with {
                let content = free_models_content(inherited, user_files, &picked);
                serving = replace_when_ready(serving, || launch(content.as_deref()));
            }
        }
    }
    Ok(serving)
}

/// `serving`, or the server `relaunch` starts in its place once it is up.
///
/// The first one is ended only then: a replacement that does not start keeps
/// the server that works, with its small model, rather than leaving none
/// (modello assente review, M3). Neither is installed yet, so no client knows
/// either address and nothing of theirs is lost.
fn replace_when_ready(serving: Serving, relaunch: impl FnOnce() -> Result<Serving, String>) -> Serving {
    match relaunch() {
        Ok(replacement) => {
            let mut first = serving;
            first.end();
            replacement
        }
        Err(_) => serving,
    }
}

/// Starts one `nikcli serve` and waits for it to say where it listens.
fn launch(program: &str, directory: Option<&str>, content: Option<&str>) -> Result<Serving, String> {
    let password = random_password()?;
    let mut command = serve_command(program, directory, &password, content);

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
        Ok(Ok(url)) => Ok(Serving {
            url,
            auth: Some((USERNAME.to_string(), password)),
            version: None,
            child,
        }),
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
        use super::{FREE_SMALL_MODEL, free_models_content};
        let content = |inherited: Option<&str>, files: &[String]| {
            free_models_content(inherited, files, FREE_SMALL_MODEL).map(|text| serde_json::from_str::<serde_json::Value>(&text).unwrap())
        };
        // Nothing chosen anywhere: ADE's free one for both.
        let both = content(None, &[]).unwrap();
        assert_eq!(both["small_model"], FREE_SMALL_MODEL);
        assert_eq!(both["model"], FREE_SMALL_MODEL);
        // small_model chosen in a config file, even empty (off), or commented out in JSONC: theirs.
        for file in [
            r#"{"small_model":"anthropic/claude-haiku"}"#,
            r#"{"small_model":""}"#,
            "{\n  // \"small_model\": \"x/y\"\n}",
        ] {
            let got = content(None, &[file.into()]).unwrap();
            assert!(got.get("small_model").is_none(), "{file}");
        }
        // The inherited inline config: kept whole, with the free ones added only where it has none.
        let merged = content(Some(r#"{"model":"openrouter/a:free","enabled_providers":["openrouter"]}"#), &[]).unwrap();
        assert_eq!(merged["model"], "openrouter/a:free");
        assert_eq!(merged["enabled_providers"][0], "openrouter");
        assert_eq!(merged["small_model"], FREE_SMALL_MODEL);
        assert_eq!(content(Some(r#"{"small_model":"x/y","model":"x/z"}"#), &[]), None);
        assert_eq!(content(Some("non json"), &[]), None);
        assert!(FREE_SMALL_MODEL.ends_with(":free"));
    }

    /// Modello assente review, point 1: a prompt without a model never falls on a paid default.
    #[test]
    fn the_server_gets_a_free_model_when_no_config_has_one() {
        use super::{FREE_SMALL_MODEL, free_models_content, top_level_key};
        let model_of = |files: &[&str]| {
            let files: Vec<String> = files.iter().map(|file| file.to_string()).collect();
            free_models_content(None, &files, FREE_SMALL_MODEL)
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).unwrap().get("model").cloned())
        };
        // No model anywhere: the server's default is the free one.
        let free = model_of(&[]).unwrap();
        assert!(free.as_str().unwrap().ends_with(":free"));
        // A model only inside an agent block, or commented out, is not a default: the free one still goes.
        assert!(model_of(&[r#"{"agent":{"build":{"model":"openai/gpt-6-astra-pro"}}}"#]).is_some());
        assert!(model_of(&["{\n  // \"model\": \"openai/gpt-6\",\n  \"theme\": \"x\",\n}"]).is_some());
        // The user's own default, in plain JSON or JSONC with comments and trailing commas: theirs.
        assert!(model_of(&[r#"{"model":"anthropic/claude-x"}"#]).is_none());
        assert!(model_of(&["{\n  /* mio */ \"model\": \"anthropic/claude-x\", // sì\n  \"x\": [1, 2,],\n}"]).is_none());
        // A file that cannot be read and names the key: counts as theirs.
        assert!(model_of(&["{ \"model\": \"a/b\" oops"]).is_none());
        // Strings with slashes and commas are not taken for comments.
        assert!(top_level_key(r#"{"url":"http://a/b//c","model":"x, }"}"#, "model"));
        // BASSO 1: a trailing comma with a comment after it, and a model only in an agent: not the user's default.
        let commented = "{\n  \"agent\": { \"build\": { \"model\": \"openai/gpt-6-astra-pro\" } },\n  \"theme\": \"x\", // nota\n}";
        assert!(!top_level_key(commented, "model"));
        assert!(model_of(&[commented]).is_some());
        let block = "{\n  \"agent\": { \"build\": { \"model\": \"x/y\", /* sì */ } },\n  \"x\": [1, 2, /* fine */ ],\n}";
        assert!(model_of(&[block]).is_some());
        assert_eq!(super::plain_json("{\"a\":1, // nota\n}"), "{\"a\":1  \n}");
    }

    /// A catalog as `GET /provider` gives it: these models, of these providers,
    /// each a free text model with tool calls unless it says otherwise.
    fn catalog(connected: &[&str], models: &[(&str, serde_json::Value)]) -> serde_json::Value {
        let mut all: Vec<(String, serde_json::Map<String, serde_json::Value>)> = Vec::new();
        for (model, fields) in models {
            let (provider, id) = model.split_once('/').unwrap();
            let mut entry = serde_json::json!({ "id": id, "status": "active", "capabilities": { "toolcall": true, "output": { "text": true } } });
            for (key, value) in fields.as_object().unwrap() {
                entry[key] = value.clone();
            }
            match all.iter_mut().find(|(name, _)| name == provider) {
                Some((_, map)) => {
                    map.insert(id.to_string(), entry);
                }
                None => all.push((provider.to_string(), serde_json::Map::from_iter([(id.to_string(), entry)]))),
            }
        }
        serde_json::json!({
            "all": all.into_iter().map(|(id, models)| serde_json::json!({ "id": id, "models": models })).collect::<Vec<_>>(),
            "default": {},
            "connected": connected,
        })
    }

    #[test]
    fn the_small_model_is_chosen_from_the_catalog_a_known_one_first() {
        use super::{FREE_SMALL_MODEL, KNOWN_FREE_SMALL, pick_small_model};
        let plain = serde_json::json!({});
        // A known one, the first there, before any other free one.
        let both = catalog(&["openrouter"], &[("openrouter/a/aaa:free", plain.clone()), (KNOWN_FREE_SMALL[1], plain.clone()), (KNOWN_FREE_SMALL[0], plain.clone())]);
        assert_eq!(pick_small_model(&both).as_deref(), Some(KNOWN_FREE_SMALL[0]));
        let second = catalog(&["openrouter"], &[("openrouter/a/aaa:free", plain.clone()), (KNOWN_FREE_SMALL[1], plain.clone())]);
        assert_eq!(pick_small_model(&second).as_deref(), Some(KNOWN_FREE_SMALL[1]));
        // No known one: the first free text model with tool calls, by id; the rest are passed over.
        let others = catalog(
            &["openrouter"],
            &[
                ("openrouter/z/zeta:free", plain.clone()),
                ("openrouter/a/paid", plain.clone()),
                ("openrouter/a/safety:free", serde_json::json!({ "capabilities": { "toolcall": false, "output": { "text": true } } })),
                ("openrouter/a/image:free", serde_json::json!({ "capabilities": { "toolcall": true, "output": { "text": false } } })),
                ("openrouter/a/old:free", serde_json::json!({ "status": "deprecated" })),
                ("openrouter/m/mid:free", plain.clone()),
            ],
        );
        assert_eq!(pick_small_model(&others).as_deref(), Some("openrouter/m/mid:free"));
        // A known one that no longer calls tools is not taken for its name.
        let unfit = catalog(&["openrouter"], &[(KNOWN_FREE_SMALL[0], serde_json::json!({ "capabilities": { "toolcall": false } })), ("openrouter/b/beta:free", plain.clone())]);
        assert_eq!(pick_small_model(&unfit).as_deref(), Some("openrouter/b/beta:free"));
        // Free by its name but with a price: not taken (B1).
        let priced = catalog(&["openrouter"], &[(KNOWN_FREE_SMALL[0], serde_json::json!({ "cost": { "input": 0.5, "output": 0 } })), ("openrouter/c/gamma:free", serde_json::json!({ "cost": { "input": 0, "output": 0 } }))]);
        assert_eq!(pick_small_model(&priced).as_deref(), Some("openrouter/c/gamma:free"));
        // A provider that is not connected runs nothing.
        let unplugged = catalog(&[], &[(KNOWN_FREE_SMALL[0], plain.clone())]);
        assert_eq!(pick_small_model(&unplugged), None);
        // Nothing free, or no catalog: none, and the server keeps the fixed fallback.
        assert_eq!(pick_small_model(&catalog(&["openrouter"], &[("openrouter/a/paid", plain.clone())])), None);
        assert_eq!(pick_small_model(&serde_json::json!({ "error": "x" })), None);
        assert_eq!(FREE_SMALL_MODEL, KNOWN_FREE_SMALL[0]);
    }

    /// Modello assente review, M3 and B5: the start itself, with real processes and a catalog of the test's.
    #[test]
    fn the_catalogs_pick_goes_to_the_server_and_a_different_one_restarts_it_once() {
        use super::{FREE_SMALL_MODEL, start_with_small_model};
        use std::cell::RefCell;
        use std::sync::Mutex;
        let other = "openrouter/altro/modello:free";
        let alive = |serving: &mut Serving| serving.child.try_wait().unwrap().is_none();

        // The catalog picks the one it started with: one server, kept.
        let chosen = Mutex::new(None);
        let launched = RefCell::new(Vec::<Option<String>>::new());
        let launch = |content: Option<&str>| {
            launched.borrow_mut().push(content.map(str::to_string));
            Ok(own(&format!("http://127.0.0.1:{}", launched.borrow().len()), sleeper()))
        };
        let mut one = start_with_small_model(None, &[], &chosen, launch, |_| Some(FREE_SMALL_MODEL.to_string())).unwrap();
        assert_eq!(launched.borrow().len(), 1);
        assert!(launched.borrow()[0].as_deref().unwrap().contains(FREE_SMALL_MODEL));
        assert!(alive(&mut one));
        one.end();

        // Another pick: a second server with it takes the place of the first, which is ended.
        let chosen = Mutex::new(None);
        let launched = RefCell::new(Vec::<Option<String>>::new());
        let first_pid = RefCell::new(0);
        let launch = |content: Option<&str>| {
            launched.borrow_mut().push(content.map(str::to_string));
            let serving = own(&format!("http://127.0.0.1:{}", launched.borrow().len()), sleeper());
            if launched.borrow().len() == 1 {
                *first_pid.borrow_mut() = serving.child.id();
            }
            Ok(serving)
        };
        let mut two = start_with_small_model(None, &[], &chosen, launch, |_| Some(other.to_string())).unwrap();
        assert_eq!(launched.borrow().len(), 2);
        assert!(launched.borrow()[1].as_deref().unwrap().contains(other));
        assert_eq!(two.url, "http://127.0.0.1:2");
        assert!(alive(&mut two));
        let mut sys = sysinfo::System::new();
        sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, sysinfo::ProcessRefreshKind::nothing());
        assert!(sys.process(sysinfo::Pid::from_u32(*first_pid.borrow())).is_none(), "il primo server è rimasto in vita");
        assert_eq!(chosen.lock().unwrap().as_deref(), Some(other));
        two.end();

        // The next start begins with the pick: no second server.
        let launched = RefCell::new(Vec::<Option<String>>::new());
        let launch = |content: Option<&str>| {
            launched.borrow_mut().push(content.map(str::to_string));
            Ok(own("http://127.0.0.1:3", sleeper()))
        };
        let mut again = start_with_small_model(None, &[], &chosen, launch, |_| Some(other.to_string())).unwrap();
        assert_eq!(launched.borrow().len(), 1);
        assert!(launched.borrow()[0].as_deref().unwrap().contains(other));
        again.end();

        // The second server does not start: the first one stays, and it works.
        let chosen = Mutex::new(None);
        let calls = RefCell::new(0);
        let launch = |_: Option<&str>| {
            *calls.borrow_mut() += 1;
            if *calls.borrow() == 1 { Ok(own("http://127.0.0.1:4", sleeper())) } else { Err("non parte".to_string()) }
        };
        let mut kept = start_with_small_model(None, &[], &chosen, launch, |_| Some(other.to_string())).unwrap();
        assert_eq!(*calls.borrow(), 2);
        assert_eq!(kept.url, "http://127.0.0.1:4");
        assert!(alive(&mut kept), "senza server dove ce n'era uno");
        kept.end();

        // A small_model and a model the user chose: never replaced, and the catalog is not even read.
        let chosen = Mutex::new(None);
        let launched = RefCell::new(Vec::<Option<String>>::new());
        let launch = |content: Option<&str>| {
            launched.borrow_mut().push(content.map(str::to_string));
            Ok(own("http://127.0.0.1:5", sleeper()))
        };
        let theirs = [r#"{"small_model":"anthropic/claude-haiku","model":"anthropic/claude-x"}"#.to_string()];
        let mut own_choice = start_with_small_model(None, &theirs, &chosen, launch, |_| panic!("catalogo letto")).unwrap();
        assert_eq!(*launched.borrow(), vec![None]);
        own_choice.end();
    }

    /// Modello assente review, M3: a replacement that does not start keeps the server that works.
    #[test]
    fn the_first_server_is_ended_only_once_its_replacement_is_up() {
        use super::replace_when_ready;
        let kept = replace_when_ready(own("http://127.0.0.1:1", sleeper()), || Err("non parte".into()));
        let mut kept = kept;
        assert_eq!(kept.url, "http://127.0.0.1:1");
        assert!(kept.child.try_wait().unwrap().is_none(), "il server che funziona è stato chiuso");
        kept.end();

        let first = own("http://127.0.0.1:1", sleeper());
        let first_id = first.child.id();
        let mut replaced = replace_when_ready(first, || Ok(own("http://127.0.0.1:2", sleeper())));
        assert_eq!(replaced.url, "http://127.0.0.1:2");
        assert!(replaced.child.try_wait().unwrap().is_none());
        let mut sys = sysinfo::System::new();
        sys.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, sysinfo::ProcessRefreshKind::nothing());
        assert!(sys.process(sysinfo::Pid::from_u32(first_id)).is_none(), "il primo server è rimasto in vita");
        replaced.end();
    }

    /// Modello assente review, B2: a second caller waits as long as a start can take.
    #[test]
    fn a_waiting_caller_outlasts_a_start_with_a_replacement() {
        use super::{CATALOG_TIMEOUT, READY_TIMEOUT, START_WAIT};
        assert!(START_WAIT > READY_TIMEOUT * 2 + CATALOG_TIMEOUT);
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
        let picked = {
            let slot = own.lock();
            match &*slot {
                Slot::Running(serving) => super::catalog_small_model(serving),
                _ => None,
            }
        };
        println!("small model dal catalogo: {picked:?}");
        assert!(picked.is_some_and(|model| model.ends_with(":free")));
        // Without the password it is refused: the random one is enforced.
        assert_eq!(live_status(&own, "/provider", false), 401);
        own.shutdown();
        assert!(own.endpoint().is_none());
    }
}
