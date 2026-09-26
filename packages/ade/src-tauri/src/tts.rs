//! The voice assistant's own voice: Piper, offline, in a resident process.
//!
//! The Web Speech voices WebView2 offers on Windows are the OneCore ones
//! (Elsa, Cosimo), and the user heard them as a robot. S15 compared Windows,
//! Piper, Kokoro and a network voice on the same sentence
//! (`ade-team/results/voice-S15.md`): Piper was the natural voice that still
//! answers in under a second, and the user chose a male one.
//!
//! Piper is a separate program, not a library in the webview: its ~190 MB stay
//! out of the renderer, which Parakeet once pushed to 4.2 GB. It is kept
//! running between sentences because loading the voice is the slow part
//! (0.8–1.6 s cold against 0.2–0.35 s per sentence warm). It needs no cleanup
//! on exit: Piper reads sentences from its stdin and ends at end of file, which
//! is what it gets when ADE exits or is killed (checked with a killed parent).
//!
//! Nothing is bundled. The runtime and the voice are downloaded on first use,
//! from pinned URLs and checked against pinned SHA-256 digests, with the
//! `curl.exe`, `tar.exe` and `certutil.exe` every Windows 10+ ships, so no HTTP
//! or archive crate is added for a one-time download. The voices' licences are
//! the models' own; not redistributing them is part of why they are fetched.
//!
//! Windows only. Elsewhere the commands say so, and the front end keeps the
//! Web Speech voice.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;
use tauri::Manager;

mod kokoro;

/// What a local voice can do on this host, for the panel and for the panel's tests.
#[derive(serde::Serialize)]
pub struct LocalStatus {
    pub supported: bool,
    pub installed: bool,
    /// How much an install would fetch, for «Installa (… MB)». `None` when there
    /// is nothing to fetch, so a number never sits next to a button that has
    /// nothing to do.
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<u64>,
}

/// The status of a Kokoro voice: installed when this revision is whole, and never
/// "supported but not installed" — the pieces are one download and one folder.
#[tauri::command]
pub fn tts_local_status(app: tauri::AppHandle, provider: String) -> Result<LocalStatus, String> {
    let root = kokoro_root(&app)?;
    match provider.as_str() {
        kokoro::KOKORO => Ok(LocalStatus {
            supported: true,
            installed: kokoro::ready(&root),
            size_bytes: kokoro::download_size(&root),
        }),
        _ => Err(format!("{provider} non è un provider locale.")),
    }
}

/// Takes Kokoro away again, so the 219 MB do not stay for nothing.
///
/// Refused while an install is running, and the resident host is stopped first if
/// it is there: a process with the model open is a process that does not give the
/// model back.
///
/// Both locks are held for the whole removal, and that is the point of the two
/// lines below. Checking `install_running` and then removing is a check-then-act:
/// «Installa» followed at once by «Rimuovi» would delete the folder under the
/// installer that is writing into it. And the child lock is taken *before* the
/// host is stopped and kept until the folder is gone, so a synthesis that arrives
/// in between cannot start a new host with the model half deleted — which is a
/// DLL locked on Windows and a cancellation that removes half of it.
#[tauri::command]
pub fn tts_local_delete(app: tauri::AppHandle, state: tauri::State<'_, KokoroState>) -> Result<u64, String> {
    let root = kokoro_root(&app)?;
    let installer = app.state::<Piper>();
    let slot = installer.installer.slot(kokoro::KOKORO);
    // Il lock dell'installer, e da subito il lock del figlio: in quest'ordine,
    // cosi' nessuno dei due può essere messo in mezzo fra il controllo e la
    // cancellazione.
    let _install = installer.installer.hold(&slot);
    if installer.installer.install_running(kokoro::KOKORO) {
        return Err("C'è un'installazione di Kokoro in corso: fermala prima di cancellare.".into());
    }
    let mut child = state.0.lock();
    if let Some(host) = child.as_mut() {
        host.stop();
    }
    *child = None;
    let freed = kokoro::delete(&root, false)?;
    Ok(freed)
}

/// Kokoro's own folder, a sibling of Piper's: `…/tts/kokoro`.
fn kokoro_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("tts").join("kokoro"))
}

/// One Kokoro sentence, as WAV bytes, from the resident host.
///
/// `tts_local_*` and not another pair of commands: Piper's are the same commands
/// with `piper` as the provider, so a second voice is a second value and not a
/// second API to keep in step.
#[tauri::command]
pub async fn tts_local_speak(
    app: tauri::AppHandle,
    provider: String,
    voice_id: String,
    text: String,
    token: u64,
    lang: String,
) -> Result<tauri::ipc::Response, String> {
    if provider != kokoro::KOKORO {
        return Err(format!("{provider} non è un provider locale."));
    }
    let root = kokoro_root(&app)?;
    let text: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if text.trim().is_empty() {
        return Err("testo vuoto".into());
    }
    // L'host di Kokoro non annulla: una richiesta gia' mandata finisce e il suo
    // WAV si butta. L'unico momento in cui ADE risparmia il lavoro e' qui, prima
    // che la riga entri nel figlio, e il segno e' lo stesso che manda K5.
    if app.state::<Piper>().claim(token).is_err() {
        return Err(FRASE_ANNULLATA.into());
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KokoroState>();
        kokoro::speak_blocking(&root, &state, &voice_id, &text, token, &lang)
    })
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Ends the resident host, for the idle timer, a page reload and the exit of ADE.
#[tauri::command]
pub fn tts_local_stop(state: tauri::State<'_, KokoroState>) -> Result<(), String> {
    kokoro::stop(&state);
    Ok(())
}

/// The resident host, kept by Tauri so there is one of it for the whole app.
pub struct KokoroState(pub kokoro::Kokoro);

impl KokoroState {
    /// Ends the resident host, for the exit of ADE.
    ///
    /// Not the EOF on stdin, which is what the host would see on its own: the
    /// host that is still loading its model is not reading stdin, so it would keep
    /// 219 MB resident for as long as it takes, and the process outliving the app
    /// that started it is the thing this exists to avoid.
    pub fn stop(&self) {
        kokoro::stop(self);
    }
}

impl Default for KokoroState {
    fn default() -> Self {
        Self(kokoro::Kokoro::default())
    }
}

#[tauri::command]
pub async fn tts_local_install(
    app: tauri::AppHandle,
    provider: String,
) -> Result<(), String> {
    if provider != kokoro::KOKORO {
        return Err(format!("{provider} non è un provider locale."));
    }
    let state = app.state::<Piper>();
    let root = kokoro_root(&app)?;
    let slot = state.installer.slot(kokoro::KOKORO);
    let _one = state.installer.hold(&slot);
    let install = state.installer.begin(
        &slot,
        kokoro::STEPS,
        None,
        Instant::now() + state.installer.deadline(),
    );
    let mut closed = Closed { install: &install, closed: false };
    let outcome = kokoro::install_locked(&install, &root, &Curl, &Certutil);
    closed.report(&outcome);
    outcome
}

/// The digest of some bytes, in the spelling a manifest pins.
///
/// The files on disk are digested by `certutil`, which is what the installer's
/// `Fingerprint` is. This is for the bytes that are not a file yet — a model that
/// is prepared in memory, a vocabulary compiled into the executable — where
/// writing them out to be digested would be a step that exists only to be
/// measured.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// One file to fetch: where from, the digest it must have, and how many bytes
/// it weighs when it is whole.
///
/// The size is `None` where it is not known without asking the network, and
/// that is not a hole in the check: the digest is the gate, and the size buys
/// two things - a progress fraction the interface can draw, and the noticing
/// of a transfer that stopped early instead of waiting for a digest that will
/// never match. Every `Some` here was measured on a copy whose SHA-256 is the
/// pinned one, so it is the size the URL really serves.
struct Download {
    url: &'static str,
    sha256: &'static str,
    size: Option<u64>,
}

const RUNTIME: Download = Download {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
    // The archive is unpacked and deleted, so its size is not written down
    // anywhere on this machine: a guess here would fail a whole install on a
    // transfer that was fine. K4 pins the sizes it knows from the manifest.
    size: None,
};

/// A voice ADE knows how to fetch: the model and its config, pinned to a revision.
struct Voice {
    id: &'static str,
    /// The model's own page, where its licence is stated; opened from the settings.
    source: &'static str,
    model: Download,
    config: Download,
}

const VOICES: &[Voice] = &[
    Voice {
        id: "ugo",
        source: "https://huggingface.co/Einrich99/PiperTTS-UGO-Italian",
        model: Download {
            url: "https://huggingface.co/Einrich99/PiperTTS-UGO-Italian/resolve/3d165b2a45cb134e96eb3a30a85568b213848ad2/medium/it_IT-ugo-medium.onnx",
            sha256: "8be36a89f0f11f8a87751e7cf25ae5c07d1ff1c46c3ccb0fd3541102a1e9476d",
            size: Some(63_516_050),
        },
        config: Download {
            url: "https://huggingface.co/Einrich99/PiperTTS-UGO-Italian/resolve/3d165b2a45cb134e96eb3a30a85568b213848ad2/medium/it_IT-ugo-medium.onnx.json",
            sha256: "feb477322e426918b978c46a80c7eb02e21014c38131dd6878fd72a5e21e4081",
            size: Some(4_853),
        },
    },
    Voice {
        id: "paola",
        source: "https://huggingface.co/rhasspy/piper-voices/tree/main/it/it_IT/paola/medium",
        model: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/it/it_IT/paola/medium/it_IT-paola-medium.onnx",
            sha256: "6fc918b5a0ea6137382833dddfa567bffbe6a5060c02043c87192ee59c04210c",
            size: Some(63_511_038),
        },
        config: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json",
            sha256: "aea19c0a7fce29fbc359b93f10e7902854401e4c95ae2ea328ae516b15d296cf",
            size: Some(7_099),
        },
    },
    Voice {
        id: "lessac",
        source: "https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/medium",
        model: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
            sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
            // Nessuna copia di questa voce su questa macchina: la dimensione
            // resta ignota invece che inventata.
            size: None,
        },
        config: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
            sha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
            // Come il modello: nessuna copia su questa macchina.
            size: None,
        },
    },
];

fn voice(id: &str) -> Result<&'static Voice, String> {
    VOICES.iter().find(|v| v.id == id).ok_or_else(|| format!("voce sconosciuta: {id}"))
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("tts").join("piper"))
}

fn exe_path(root: &Path) -> PathBuf {
    root.join("piper").join("piper.exe")
}

/// Written after the runtime archive is fully extracted, holding its digest.
///
/// `piper.exe` alone does not prove an installation: an extraction cut short
/// can leave the executable without the DLLs and espeak data beside it, and a
/// check on the exe would then never repair it.
fn runtime_marker(root: &Path) -> PathBuf {
    root.join("piper").join(".ade-complete")
}

fn runtime_ready(root: &Path) -> bool {
    exe_path(root).is_file()
        && std::fs::read_to_string(runtime_marker(root)).map(|d| d.trim() == RUNTIME.sha256).unwrap_or(false)
}

fn model_path(root: &Path, id: &str) -> PathBuf {
    root.join("voices").join(format!("{id}.onnx"))
}

/// How long a sentence may keep the synthesizer waiting before the resident
/// process is considered stalled and dropped: twice the JS client's 15 s. The
/// client decides when to stop waiting; this decides when to kill, and has to
/// be the wider of the two.
pub const SYNTHESIS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The first sentence after a start: piper reads stdin only once it has loaded
/// its 63 MB model, and the first «Pronto.» took 22 s live. With the short
/// limit a cold piper was killed before it was warm, the wake-up prepare too.
pub const FIRST_SYNTHESIS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

/// The limit for the next sentence: the long one until the process has answered once.
fn synthesis_timeout(fresh: bool) -> std::time::Duration {
    if fresh {
        FIRST_SYNTHESIS_TIMEOUT
    } else {
        SYNTHESIS_TIMEOUT
    }
}

/// The piper process for one voice, with its pipes. Sentences go through it one at a time.
struct Resident {
    voice: String,
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    rx: std::sync::mpsc::Receiver<std::io::Result<String>>,
    /// True from start until the first answer: the model may still be loading.
    fresh: bool,
}

impl Drop for Resident {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Names the scratch file each sentence is written to; sentences run one at a time, so it only has to differ.
static SENTENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The sentence an abandoned phrase stops with: the host's own wording is not
/// the user's, and this one is what K5's bridge already knows.
const FRASE_ANNULLATA: &str = "frase annullata dal client";

/// The resident process, and the lock that keeps two installs apart.
#[derive(Default)]
pub struct Piper {
    resident: Mutex<Option<Resident>>,
    /// One installer for every provider, so a second voice is not held up by
    /// the first one's download and each provider's install is alone in its files.
    installer: Installer,
    /// Tokens the JS abandoned while their phrases waited in the queue: each is
    /// skipped, and removed, when its own request reaches the front.
    abandoned: Mutex<HashSet<u64>>,
}

impl Piper {
    /// Remembers that the JS will not wait for these phrases any more.
    fn abandon(&self, tokens: &[u64]) {
        if let Ok(mut set) = self.abandoned.lock() {
            set.extend(tokens.iter().copied());
        }
    }

    /// The phrase's turn, taken with the resident lock held and before any
    /// synthesis: an abandoned phrase stops here and never writes to Piper,
    /// and the mark is consumed by the skip that found it.
    fn claim(&self, token: u64) -> Result<(), String> {
        let mut set = self.abandoned.lock().map_err(|_| "voce bloccata")?;
        if set.remove(&token) {
            Err("frase annullata dal client".into())
        } else {
            Ok(())
        }
    }

    /// Forgets a mark set while the phrase with this token was already in
    /// corso: that phrase has had its turn, and nothing claims the token again.
    fn release(&self, token: u64) {
        if let Ok(mut set) = self.abandoned.lock() {
            set.remove(&token);
        }
    }

    /// Every mark, when the resident process ends: that queue is gone with
    /// it, and a mark left for a token no phrase will ever claim would skip,
    /// in silence, a later phrase that draws the same number.
    fn clear_abandoned_for_stop(&self) {
        if let Ok(mut set) = self.abandoned.lock() {
            set.clear();
        }
    }

    fn lock_resident(&self) -> std::sync::MutexGuard<'_, Option<Resident>> {
        self.resident.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn stop_resident(&self) -> PiperStop {
        let mut guard = match self.resident.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::WouldBlock) => return PiperStop { busy: true },
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        };
        if forget_resident(&mut guard) {
            self.clear_abandoned_for_stop();
        }
        PiperStop { busy: false }
    }
}

fn forget_resident<T>(slot: &mut Option<T>) -> bool {
    if slot.is_none() {
        return false;
    }
    *slot = None;
    true
}

/// Clears the abandonment mark of a phrase once it has had its turn, whether
/// it spoke or failed, so no mark outlives the request it was set for.
struct Release<'a>(&'a Piper, u64);

impl Drop for Release<'_> {
    fn drop(&mut self) {
        self.0.release(self.1);
    }
}

#[derive(Serialize)]
pub struct PiperStatus {
    supported: bool,
    installed: bool,
}

#[derive(Serialize)]
pub struct PiperStop {
    busy: bool,
}

#[tauri::command]
pub fn tts_piper_status(app: tauri::AppHandle, voice_id: String) -> Result<PiperStatus, String> {
    voice(&voice_id)?;
    if !cfg!(windows) {
        return Ok(PiperStatus { supported: false, installed: false });
    }
    let root = root(&app)?;
    let installed = runtime_ready(&root)
        && model_path(&root, &voice_id).is_file()
        && model_path(&root, &voice_id).with_extension("onnx.json").is_file();
    Ok(PiperStatus { supported: true, installed })
}

/// Downloads what is missing for `voice_id`: the runtime once, then the voice.
///
/// curl, tar and certutil block for seconds, so the work runs on Tauri's
/// blocking pool rather than on an async worker the other commands need.
#[tauri::command]
pub async fn tts_piper_install(app: tauri::AppHandle, voice_id: String) -> Result<(), String> {
    let wanted = voice(&voice_id)?;
    if !cfg!(windows) {
        return Err("La voce Piper è disponibile solo su Windows.".into());
    }
    tauri::async_runtime::spawn_blocking(move || install_blocking(&app, wanted))
        .await
        .map_err(|e| e.to_string())?
}

/// What an install is doing, for the panel that started it.
///
/// One command for every provider, so the front end reads it the same way for
/// Piper and for whatever comes next, and a provider nobody started answers
/// instead of failing: the panel asks before it has anything to show.
#[tauri::command]
pub fn tts_install_status(app: tauri::AppHandle, provider: String) -> Result<InstallProgress, String> {
    Ok(app.state::<Piper>().installer.progress_of(&provider))
}

/// Whether there was an install to stop.
#[derive(Serialize)]
pub struct InstallCancel {
    cancelled: bool,
}

/// Asks the install in flight to stop. Answers whether there was one, because
/// "nothing to cancel" and "cancelled" are different things to say in a panel.
#[tauri::command]
pub fn tts_install_cancel(app: tauri::AppHandle, provider: String) -> Result<InstallCancel, String> {
    let cancelled = app.state::<Piper>().installer.cancel_of(&provider);
    Ok(InstallCancel { cancelled })
}

/// Said when the install stopped without saying why.
///
/// A panic inside it crosses the Tauri command and leaves nobody to read the
/// reason, so this is what the panel is told instead: that it happened, which is
/// more than the panel used to get.
const PANICA: &str = "L'installazione si è interrotta in modo inatteso.";

/// Closes the install whatever happens to it, a panic included.
///
/// `running` is what the panel reads, and an install that is over must not leave
/// it true: the cancel would answer «nothing to cancel» and the bar would go on
/// filling for a download nobody is making. The normal path reports its own
/// outcome; this one exists for the paths where there is no outcome to report.
struct Closed<'a, 'b> {
    install: &'a InstallRun<'b>,
    closed: bool,
}

impl<'a, 'b> Closed<'a, 'b> {
    /// Reports how it went, and takes the closing off the drop.
    fn report(&mut self, outcome: &Result<(), String>) {
        self.install.finish(outcome);
        self.closed = true;
    }
}

impl Drop for Closed<'_, '_> {
    fn drop(&mut self) {
        if !self.closed {
            self.install.finish(&Err(PANICA.into()));
        }
    }
}

/// Where an install of one voice starts and ends, with the provider's lock not
/// held: the caller holds it.
///
/// This is the body of `install_blocking` with the `AppHandle` taken off it, so
/// the order the panel depends on is in something a test can call: the lock, and
/// only then the state, and the budget counted from the lock. A test that faked
/// the handle could only ever read those three lines; this way it runs them.
fn install_voice(
    installer: &Installer,
    slot: &Arc<ProviderSlot>,
    root: &Path,
    wanted: &'static Voice,
    curl: &dyn Fetcher,
    print: &dyn Fingerprint,
) -> Result<(), String> {
    let model = model_path(root, wanted.id);
    let config = model.with_extension("onnx.json");
    /*
     * The voice's own two files, and only them.
     *
     * The runtime used to be the first job, on a `piper.zip` that is never
     * there: it is fetched as `piper.zip.part` and deleted once `tar` has it.
     * A job list is a list of files to put in place, and that one has no
     * destination, so it was counted as missing for ever - which put its `None`
     * size into the total and left `bytes_total` empty on every install, warm
     * or cold, and left the bar at two files out of three. The runtime is a
     * step with a condition of its own instead, and `install_locked` says
     * whether it is done.
     */
    let voice_files: [(&Download, PathBuf); 2] = [(&wanted.config, config), (&wanted.model, model)];
    let files_total = 3;

    /*
     * And the size of the two of them, only where it is the whole story.
     *
     * A cold install fetches the runtime as well, and those bytes are published
     * like the others, so a total that counted only the voice's two files is a
     * bar that reaches its end during the runtime and then walks past it — which
     * is the first install, the one everybody sees. A runtime already in place
     * means the bytes leaving are the two files and nothing else, and then the
     * total is exact.
     *
     * So: no runtime, no total. The panel draws by files, which is what
     * `InstallProgress` says a `None` total means — nothing to draw, not nothing
     * downloaded. The alternative, pinning the runtime's size, is a fourth
     * number to keep right for a bar that files already count.
     */
    let bytes_total = if runtime_ready(root) { bytes_pending(&voice_files) } else { None };

    // The lock is already held here, and the state comes after it: see `hold`.
    // And the budget starts now, because an install that waited its turn has
    // not spent any of its time.
    let install = installer.begin(slot, files_total, bytes_total, Instant::now() + installer.deadline());
    // Closed however this ends: `running` is read by the panel, and an install
    // that is over must not leave it true.
    let mut closed = Closed { install: &install, closed: false };
    let outcome = install_locked(&install, root, &voice_files, curl, print);
    closed.report(&outcome);
    outcome
}

fn install_blocking(app: &tauri::AppHandle, wanted: &'static Voice) -> Result<(), String> {
    let state = app.state::<Piper>();
    let root = root(app)?;
    std::fs::create_dir_all(root.join("voices")).map_err(|e| e.to_string())?;

    let slot = state.installer.slot(PIPER);
    // The lock, and only then the body: see `hold`.
    let _one = state.installer.hold(&slot);
    install_voice(&state.installer, &slot, &root, wanted, &Curl, &Certutil)
}

/// The install itself, with the provider's lock already held.
///
/// The fetcher and the fingerprint come in as arguments, as they already do for
/// `bring`, so that the whole sequence — runtime first, then the voice's files —
/// can be walked in a test without a network and without `tar`.
fn install_locked(
    install: &InstallRun<'_>,
    root: &Path,
    voice_files: &[(&Download, PathBuf)],
    curl: &dyn Fetcher,
    print: &dyn Fingerprint,
) -> Result<(), String> {
    if !runtime_ready(root) {
        // Whatever an interrupted attempt left is discarded, not trusted.
        let _ = std::fs::remove_dir_all(root.join("piper"));
        let zip = root.join("piper.zip.part");
        // The archive is `tar`'s to unpack, so it is fetched and left in place
        // for `tar` rather than renamed: the marker is what says the runtime is
        // whole, and it is written only after the executable is there.
        install.fetch(&RUNTIME, &zip, curl, print)?;
        let extracted = run(system_tool("tar.exe"), &["-xf".as_ref(), zip.as_os_str(), "-C".as_ref(), root.as_os_str()]);
        let _ = std::fs::remove_file(&zip);
        extracted?;
        if !exe_path(root).is_file() {
            return Err("L'archivio di Piper non contiene piper.exe.".into());
        }
        std::fs::write(runtime_marker(root), RUNTIME.sha256).map_err(|e| e.to_string())?;
    }
    // Counted either way: the runtime is one of the three, and a bar that stops
    // at two thirds with the install finished is a bar that is lying.
    install.counted();
    for (download, path) in voice_files {
        // A cancel asked between one file and the next is still a cancel, and
        // the next download does not start. The fetcher asks again between its
        // own waits; this is about the gaps it never sees — a digest, a rename,
        // a file that was already in place.
        if let Some(reason) = install.stop() {
            return Err(reason);
        }
        install.bring(download, path, curl, print)?;
    }
    Ok(())
}

/// One sentence as WAV bytes, from the resident process (started, or restarted for another voice).
///
/// `token` names this request for `tts_piper_cancel`: if the JS abandoned it
/// while it waited its turn on the resident lock, it is skipped instead of
/// synthesised, so an abandoned reply never delays the next one.
///
/// On the blocking pool: the sentences of one reply are requested together and
/// wait for each other on the resident process's lock, and each wait would
/// otherwise hold an async worker.
#[tauri::command]
pub async fn tts_piper_speak(
    app: tauri::AppHandle,
    voice_id: String,
    text: String,
    token: u64,
) -> Result<tauri::ipc::Response, String> {
    voice(&voice_id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || speak_blocking(&app, &voice_id, &text, token))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

fn speak_blocking(app: &tauri::AppHandle, voice_id: &str, text: &str, token: u64) -> Result<Vec<u8>, String> {
    let state = app.state::<Piper>();
    let root = root(app)?;
    let scratch = root.join("scratch");
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    // One line per sentence is Piper's input format; a newline inside would split it.
    let text: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if text.trim().is_empty() {
        return Err("testo vuoto".into());
    }

    let mut guard = state.lock_resident();
    // The JS may have abandoned this phrase while it waited behind the others:
    // at its turn it is skipped, and the one in corso keeps going untouched.
    state.claim(token)?;
    let _release = Release(&state, token);
    if guard.as_ref().map(|r| r.voice != voice_id).unwrap_or(true) {
        *guard = None;
        if !runtime_ready(&root) {
            return Err("La voce Piper non è ancora installata.".into());
        }
        *guard = Some(start(&root, voice_id)?);
    }
    let out = scratch.join(format!("{}.wav", SENTENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    let result = synthesize(guard.as_mut().expect("started above"), &text, &out);
    forget_on_error(&mut guard, &result);
    drop(guard);
    let bytes = result.and_then(|_| std::fs::read(&out).map_err(|e| e.to_string()));
    let _ = std::fs::remove_file(&out);
    bytes
}

/// A process that failed once is not trusted with the next sentence: dropped, which kills it.
fn forget_on_error<T, R, E>(slot: &mut Option<T>, result: &Result<R, E>) {
    if result.is_err() {
        *slot = None;
    }
}

/// Opens the model's page in the browser: only the pages listed in `VOICES`, never a URL from the caller.
#[tauri::command]
pub async fn tts_open_voice_source(app: tauri::AppHandle, voice_id: String) -> Result<(), String> {
    // Le due pagine di Kokoro sono in una lista fissa, come i sorgenti delle voci
    // Piper: l'indirizzo non viene mai dall'interfaccia.
    let source = match kokoro::source_of(&voice_id) {
        Some(url) => url,
        None => voice(&voice_id)?.source,
    };
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app).open(source, None).map_err(|e| e.to_string())
}

/// Ends the resident process, freeing its memory until the next sentence.
/// Async and non-blocking: uses `try_lock` so an in-flight synthesis is never blocked,
/// and the main window never freezes. If busy, synthesis is in progress and stop is skipped
/// (JS will not re-arm the silence timer until another sentence finishes speaking).
///
/// The abandonment marks go with the process: nothing of that queue remains
/// to claim them, and a mark left behind would skip, in silence, whatever
/// phrase of a later reply draws the same token number.
#[tauri::command]
pub async fn tts_piper_stop(state: tauri::State<'_, Piper>) -> Result<PiperStop, String> {
    Ok(state.stop_resident())
}

/// The JS will not wait for these phrases any more (a cancelled reply): the
/// queued ones are skipped when they reach the front of the queue, the one in
/// corso finishes on its own. Called with the tokens of the in-flight requests
/// only — the ones asked for ahead of the next reply are never abandoned.
#[tauri::command]
pub fn tts_piper_cancel(state: tauri::State<'_, Piper>, tokens: Vec<u64>) {
    state.abandon(&tokens);
}

fn start(root: &Path, voice_id: &str) -> Result<Resident, String> {
    use std::process::{Command, Stdio};
    let exe = exe_path(root);
    let model = model_path(root, voice_id);
    if !exe.is_file() || !model.is_file() {
        return Err("La voce Piper non è ancora installata.".into());
    }
    let mut command = Command::new(&exe);
    command
        .arg("--model")
        .arg(&model)
        .arg("--json-input")
        .current_dir(exe.parent().unwrap_or(root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|e| format!("Piper non si avvia: {e}"))?;
    let stdin = child.stdin.take().ok_or("Piper senza stdin")?;
    let stdout = child.stdout.take().ok_or("Piper senza stdout")?;
    let rx = spawn_stdout_reader(stdout);
    Ok(Resident { voice: voice_id.to_string(), child, stdin, rx, fresh: true })
}

fn spawn_stdout_reader<R: std::io::Read + Send + 'static>(
    reader: R,
) -> std::sync::mpsc::Receiver<std::io::Result<String>> {
    use std::io::BufRead;
    let (tx, rx) = std::sync::mpsc::channel();
    let mut buf = std::io::BufReader::new(reader);
    let _ = std::thread::Builder::new()
        .name("piper-stdout-reader".into())
        .spawn(move || {
            loop {
                let mut line = String::new();
                match buf.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        if tx.send(Ok(line)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                        break;
                    }
                }
            }
        });
    rx
}

fn read_response_with_timeout(
    rx: &std::sync::mpsc::Receiver<std::io::Result<String>>,
    timeout: std::time::Duration,
) -> Result<String, String> {
    match rx.recv_timeout(timeout) {
        Ok(Ok(line)) => {
            if line.is_empty() {
                Err("Piper si è chiuso.".into())
            } else {
                Ok(line)
            }
        }
        Ok(Err(e)) => Err(format!("Piper non risponde: {e}")),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            Err(format!("Piper non ha risposto entro il timeout ({} s).", timeout.as_secs()))
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("Piper si è chiuso.".into()),
    }
}

/// Piper writes the sentence to `out` and prints that path when it is done.
fn synthesize(resident: &mut Resident, text: &str, out: &Path) -> Result<(), String> {
    let timeout = synthesis_timeout(resident.fresh);
    synthesize_with_timeout(resident, text, out, timeout)
}

fn synthesize_with_timeout(
    resident: &mut Resident,
    text: &str,
    out: &Path,
    timeout: std::time::Duration,
) -> Result<(), String> {
    use std::io::Write;
    let line = serde_json::json!({ "text": text, "output_file": out.to_string_lossy() }).to_string();
    writeln!(resident.stdin, "{line}").map_err(|e| format!("Piper non risponde: {e}"))?;
    resident.stdin.flush().map_err(|e| format!("Piper non risponde: {e}"))?;
    read_response_with_timeout(&resident.rx, timeout)?;
    resident.fresh = false;
    if !out.is_file() {
        return Err("Piper non ha scritto l'audio.".into());
    }
    Ok(())
}

fn system_tool(name: &str) -> PathBuf {
    let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    PathBuf::from(system_root).join("System32").join(name)
}

fn hide_window(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn run(program: PathBuf, args: &[&std::ffi::OsStr]) -> Result<String, String> {
    let mut command = std::process::Command::new(&program);
    command.args(args).stdin(std::process::Stdio::null());
    hide_window(&mut command);
    let output = command.output().map_err(|e| format!("{} non eseguibile: {e}", program.display()))?;
    if !output.status.success() {
        return Err(format!(
            "{} è fallito: {}",
            program.file_name().and_then(|n| n.to_str()).unwrap_or("comando"),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The hex digest in `certutil -hashfile` output: the line of 64 hex digits, spaces removed.
fn digest_in(listing: &str) -> Option<String> {
    listing
        .lines()
        .map(|line| line.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase())
        .find(|line| line.len() == 64 && line.chars().all(|c| c.is_ascii_hexdigit()))
}

/// How the bytes of one file arrive.
trait Fetcher {
    /// Writes the body of `url` into `part` and returns how many bytes it wrote.
    ///
    /// `report` is called with the total so far, as often as there is news.
    /// `stop` is asked before every wait: `None` to go on, otherwise the reason
    /// to give up - the user cancelled, or the install is past its deadline -
    /// and the transfer must stop there. A fetcher that ignores it is a fetcher
    /// that cannot be cancelled.
    fn fetch(
        &self,
        url: &str,
        part: &Path,
        report: &mut dyn FnMut(u64),
        stop: &dyn Fn() -> Option<String>,
    ) -> Result<u64, String>;
}

/// The digest of a file on disk.
trait Fingerprint {
    fn sha256(&self, path: &Path) -> Result<String, String>;
}

/// `curl.exe`, the one every Windows 10+ ships, watched while it writes.
struct Curl;

impl Fetcher for Curl {
    fn fetch(
        &self,
        url: &str,
        part: &Path,
        report: &mut dyn FnMut(u64),
        stop: &dyn Fn() -> Option<String>,
    ) -> Result<u64, String> {
        let mut command = std::process::Command::new(system_tool("curl.exe"));
        command
            .args([
                "-fsSL".as_ref(),
                "--retry".as_ref(),
                "2".as_ref(),
                "--connect-timeout".as_ref(),
                "20".as_ref(),
                // Bounded by progress, not by a total: the install lock is held
                // for the whole download, so a stalled connection left every
                // later request for this voice waiting, while a fixed ceiling
                // would also cut off a slow line that is still getting there.
                // Under 1 KB/s for a minute is stalled. The ceiling that is
                // missing here is the install's own deadline, in `stop`.
                "--speed-limit".as_ref(),
                "1024".as_ref(),
                "--speed-time".as_ref(),
                "60".as_ref(),
                // What actually landed, which is not what the file weighs if
                // the connection dropped: the difference is the whole point of
                // asking curl rather than measuring the file afterwards.
                "--write-out".as_ref(),
                "%{size_download}".as_ref(),
                "-o".as_ref(),
                part.as_os_str(),
                url.as_ref(),
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        hide_window(&mut command);
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {}
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(e.to_string());
                }
            }
            // Asked before every wait, so a cancel is at most one tick away.
            if let Some(reason) = stop() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(reason);
            }
            report(bytes_so_far(part));
            std::thread::sleep(PROGRESS_TICK);
        }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let written = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u64>()
            .map_err(|e| format!("curl non ha detto quanti byte ha scaricato: {e}"))?;
        report(written);
        Ok(written)
    }
}

/// `certutil -hashfile`, the other tool every Windows 10+ ships.
struct Certutil;

impl Fingerprint for Certutil {
    fn sha256(&self, path: &Path) -> Result<String, String> {
        let listing = run(system_tool("certutil.exe"), &["-hashfile".as_ref(), path.as_os_str(), "SHA256".as_ref()])?;
        digest_in(&listing).ok_or_else(|| "certutil non ha restituito il digest.".into())
    }
}

/// How often the staging file is measured while it grows.
const PROGRESS_TICK: std::time::Duration = std::time::Duration::from_millis(200);

/// The size of the file being written, or zero when it is not there yet.
fn bytes_so_far(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// The installer, the same for every provider
// ---------------------------------------------------------------------------

/// Piper's own name in the installer, so its progress and its cancel are
/// reachable with the word the front end already uses for it.
const PIPER: &str = "piper";

/// The whole install, first byte to marker. Generous on purpose: a deadline is
/// here to end a transfer that is never going to arrive, not to cut a slow line
/// that is still getting there - a line that stops moving is curl's own speed
/// bound, and it is a different failure with a different fix.
pub const INSTALL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(30 * 60);

const ANNULLATA: &str = "Installazione annullata.";
const SCADUTA: &str = "Installazione interrotta: il tempo è scaduto.";
const INTERROTTA: &str = "Il download si è interrotto prima del file atteso: scartato.";
const DIGEST: &str = "Il file scaricato non corrisponde a quello atteso: scartato.";

/// What the interface is told about an install, running or just finished.
#[derive(Serialize, Clone, Default)]
pub struct InstallProgress {
    provider: String,
    running: bool,
    /// Files already in place, over the files the install is made of. A file
    /// that was there before the install counts as done: the bar must not jump
    /// when the user opens the panel on a warm install.
    files_done: u32,
    files_total: u32,
    /// Bytes over the bytes still to be fetched, counted over every file of the
    /// install and not over the one being written, and `None` for the total
    /// while one of the files has no size written down. Nothing to draw is not
    /// the same as nothing downloaded, and the two are told apart by this being
    /// `None` rather than zero.
    bytes_done: u64,
    bytes_total: Option<u64>,
    /// The user asked for this to stop.
    cancelled: bool,
    /// Why the last install of this provider stopped, in the user's words.
    error: Option<String>,
}

/// One provider's install: the lock that keeps two of them apart, and what the
/// interface is told about it.
struct ProviderSlot {
    lock: Mutex<()>,
    progress: Mutex<InstallProgress>,
}

/// The installers, one slot per provider.
///
/// The lock is per provider and not global because a Piper install and a Kokoro
/// one write different files: with one lock, asking for a second voice while a
/// 63 MB download is in flight waited for it, and then for the one after that.
#[derive(Default)]
struct Installer {
    providers: Mutex<HashMap<String, Arc<ProviderSlot>>>,
    /// How long one install has. A field and not only the constant, so that the
    /// moment the budget starts counting is the moment the lock was taken
    /// rather than the moment the install was queued; `None` is the constant.
    deadline: Option<std::time::Duration>,
}

/// The providers this installer knows. Anything else is not a provider: the
/// strings arrive from the interface, and a slot per string is a map that grows
/// for as long as the app is open. K4 adds `kokoro` here and nowhere else.
const PROVIDERS: &[&str] = &[PIPER, "kokoro"];

/// Whether this name is a provider this installer can speak for.
fn is_provider(provider: &str) -> bool {
    PROVIDERS.contains(&provider)
}

impl Installer {
    /// The slot for a provider, and a new one for a name that is not a provider.
    ///
    /// The new one is not kept: nobody installs as a name the front end invented,
    /// so there is nothing to remember, and remembering it is how the map grew.
    fn slot(&self, provider: &str) -> Arc<ProviderSlot> {
        let fresh = || {
            Arc::new(ProviderSlot {
                lock: Mutex::new(()),
                progress: Mutex::new(InstallProgress { provider: provider.to_string(), ..Default::default() }),
            })
        };
        if !is_provider(provider) {
            return fresh();
        }
        let mut providers = self.providers.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        providers.entry(provider.to_string()).or_insert_with(fresh).clone()
    }

    /// What is known about this provider's install. Never fails: a provider
    /// nobody has installed yet has simply not started.
    /// Whether this provider has an install in flight, which is what makes a
    /// delete refuse: the installer is writing into the folder being removed.
    pub fn install_running(&self, provider: &str) -> bool {
        self.progress_of(provider).running
    }

    fn progress_of(&self, provider: &str) -> InstallProgress {
        self.slot(provider).progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// Asks the install in flight to stop, and says whether there was one.
    fn cancel_of(&self, provider: &str) -> bool {
        let slot = self.slot(provider);
        let mut progress = slot.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if !progress.running {
            return false;
        }
        progress.cancelled = true;
        true
    }

    /// Takes the provider's lock, so that two installs of it do not write the
    /// same files. Providers do not wait for each other.
    ///
    /// Before `begin` and never after it: `begin` writes everything the panel
    /// reads for this provider, and a second install writing that state while
    /// the first is still downloading is what made a cancel disappear, made
    /// `running` fall to false over a download that was running, and summed two
    /// transfers into one counter. Queued behind the lock, an install has not
    /// begun: the state belongs to the one that is going.
    ///
    /// A lock poisoned by a panic is taken anyway, like every other mutex in this
    /// file. Refusing it left the provider saying "installazione bloccata" for
    /// the rest of the session, and there is nothing in this install that a
    /// panic leaves half written: the staging file is never its destination.
    fn hold<'a>(&'a self, slot: &'a Arc<ProviderSlot>) -> MutexGuard<'a, ()> {
        slot.lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// How long an install has, counted from the moment it holds the lock. An
    /// install that waited its turn has not spent any of its time yet.
    fn deadline(&self) -> std::time::Duration {
        self.deadline.unwrap_or(INSTALL_DEADLINE)
    }

    fn begin<'a>(&self, slot: &'a Arc<ProviderSlot>, files_total: u32, bytes_total: Option<u64>, deadline: Instant) -> InstallRun<'a> {
        let mut progress = slot.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *progress = InstallProgress {
            provider: progress.provider.clone(),
            running: true,
            files_done: 0,
            files_total,
            bytes_done: 0,
            bytes_total,
            cancelled: false,
            error: None,
        };
        InstallRun { slot, deadline }
    }
}

/// One install in flight: the deadline, and the only place a cancel is read.
struct InstallRun<'a> {
    slot: &'a Arc<ProviderSlot>,
    deadline: Instant,
}

impl InstallRun<'_> {
    /// The reason to stop, or `None`. Asked by the fetcher between its waits, so
    /// a cancel is at most one tick away and a deadline is exact.
    fn stop(&self) -> Option<String> {
        let progress = self.slot.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if progress.cancelled {
            return Some(ANNULLATA.into());
        }
        if Instant::now() >= self.deadline {
            return Some(SCADUTA.into());
        }
        None
    }

    fn publish(&self, change: impl FnOnce(&mut InstallProgress)) {
        let mut progress = self.slot.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        change(&mut progress);
    }

    /// What the bar reads now, which is the base the next file adds to.
    fn bytes_done(&self) -> u64 {
        self.slot.progress.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).bytes_done
    }

    /// Fetches one file into its place: staging, progress, cancel, deadline,
    /// size, digest, rename. A file already in place is left exactly as it is.
    fn bring(
        &self,
        download: &Download,
        dest: &Path,
        curl: &dyn Fetcher,
        print: &dyn Fingerprint,
    ) -> Result<(), String> {
        if dest.is_file() {
            self.publish(|progress| progress.files_done += 1);
            return Ok(());
        }
        self.fetch(download, &staging(dest), curl, print)?;
        rename_into_place(&staging(dest), dest)?;
        self.publish(|progress| progress.files_done += 1);
        Ok(())
    }

    /// Fetches one file to a staging path the caller then goes on with: the
    /// Piper archive is unpacked by `tar`, so its staging file is not its
    /// destination and this stops before the rename.
    fn fetch(
        &self,
        download: &Download,
        part: &Path,
        curl: &dyn Fetcher,
        print: &dyn Fingerprint,
    ) -> Result<(), String> {
        // Whatever an interrupted attempt left goes: a `.part` is never
        // resumed, because the bytes in it are from a transfer nobody vouched
        // for, and a file that looks whole is the one case that would not be
        // caught by the digest later.
        let _ = std::fs::remove_file(part);
        /*
         * What the bar reads is what arrived before this file plus what this
         * file weighs now — not the sum of every report.
         *
         * The sum double-counted, and not by a little: `curl --retry 2` rewrites
         * the `.part` from zero after a drop, and each report is a growth against
         * the last one, so everything that grew again was added a second time.
         * A file that was discarded took its bytes with it and the bar said more
         * had been downloaded than ever had. With the base taken once per file a
         * retry makes the bar dip to where the transfer really restarted, which
         * is true, and grow from there once.
         */
        let before = self.bytes_done();
        let mut report = |bytes: u64| {
            let total = before + bytes;
            self.publish(|progress| progress.bytes_done = total);
        };
        let written = match curl.fetch(download.url, part, &mut report, &|| self.stop()) {
            Ok(written) => written,
            // A cancel and a deadline are this install's own reasons and they say
            // themselves: wrapped in "download non riuscito" a person would read
            // a choice of theirs, or a clock, as a broken connection. Every
            // other failure is curl's, and is named as one, as it always was.
            //
            // Nothing half-written is left for the next attempt to find: a .part
            // is never trusted, and litter that looks like progress is worse
            // than none.
            Err(reason) if reason == ANNULLATA || reason == SCADUTA => {
                let _ = std::fs::remove_file(part);
                return Err(reason);
            }
            Err(e) => {
                let _ = std::fs::remove_file(part);
                return Err(format!("Download della voce non riuscito: {e}"));
            }
        };
        if download.size.is_some_and(|expected| written != expected) {
            let _ = std::fs::remove_file(part);
            return Err(INTERROTTA.into());
        }
        /*
         * The two failures are different and are named differently.
         *
         * A tool that could not read the file is a tool that failed: certutil
         * not starting, Defender holding the 63 MB open for a scan, a listing
         * that did not come back. Reading that as "the file is not the one we
         * asked for" tells the user their download was the wrong file — which
         * is not true and which sends them looking for a problem that is not
         * there — and throws away a transfer that was fine. Before the common
         * installer this was a `?`, and the error said what it was.
         */
        let digest = match print.sha256(part) {
            Ok(digest) => digest,
            Err(problem) => {
                let _ = std::fs::remove_file(part);
                return Err(problem);
            }
        };
        if digest == download.sha256 {
            return Ok(());
        }
        let _ = std::fs::remove_file(part);
        Err(DIGEST.into())
    }

    /// The install is over: the reason, if it failed, is what the panel shows.
    fn finish(&self, outcome: &Result<(), String>) {
        self.publish(|progress| {
            progress.running = false;
            progress.error = outcome.as_ref().err().cloned();
            // A cancel that arrived too late is not an outcome. The install
            // finished, and an install that finished is not cancelled: left
            // standing, the next one for this provider would be cancelled before
            // its first tick, with nothing to show for it.
            if outcome.is_ok() {
                progress.cancelled = false;
            }
        });
    }

    /// Counts a file the install brought into place by itself, without going
    /// through `bring`: the runtime archive, which `tar` unpacks and which
    /// becomes several files the user never names.
    fn counted(&self) {
        self.publish(|progress| progress.files_done += 1);
    }
}

/// Where a file is written before it is whole. Never the destination: a reader
/// that finds a half-written model is worse than one that finds none.
fn staging(dest: &Path) -> PathBuf {
    dest.with_extension("part")
}

/// How many times a rename is tried, and how long between them.
const RENAME_TRIES: usize = 3;
const RENAME_WAIT: std::time::Duration = std::time::Duration::from_millis(200);

/// Moves a whole file to its place, and says which one when it cannot.
///
/// The rename comes right after curl has let go of the file, and on Windows that
/// is not always the end of it: the antivirus opens what has just been written to
/// look at it, and a rename onto a file someone else is holding fails with
/// «Access is denied. (os error 5)». That is a moment, not a verdict, so it is
/// tried a few times before it is believed — and the whole point of the retry is
/// that the alternative was throwing away 63 MB that had already arrived.
///
/// The staging file goes when it does not work out, like every other failure
/// here, and the message names the file, because «Access is denied» on its own
/// sends the user looking for permissions they do not have a problem with.
fn rename_into_place(from: &Path, dest: &Path) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 1..=RENAME_TRIES {
        match std::fs::rename(from, dest) {
            Ok(()) => return Ok(()),
            Err(problem) => {
                last = problem.to_string();
                if attempt < RENAME_TRIES {
                    std::thread::sleep(RENAME_WAIT);
                }
            }
        }
    }
    let _ = std::fs::remove_file(from);
    Err(format!(
        "Impossibile mettere in posto {}: {last}",
        file_name(dest)
    ))
}

/// The last piece of a path, for a message a person can act on.
fn file_name(path: &Path) -> String {
    path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// The bytes this install still has to fetch, when every one of them has a size
/// written down.
fn bytes_pending(jobs: &[(&Download, PathBuf)]) -> Option<u64> {
    jobs.iter().filter(|(_, path)| !path.is_file()).map(|(download, _)| download.size).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn certutil_output_yields_the_digest_in_either_spelling() {
        let modern = "SHA256 hash of piper.zip:\r\nf3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea\r\nCertUtil: -hashfile command completed successfully.\r\n";
        let spaced = "SHA256 hash of file x:\r\nf3 c5 89 06 40 2b 24 f3 a9 6d 92 14 5f 58 ac ba 6d 86 c9 b5 db 89 6d 20 7f 78 dc 80 81 1e fc ea\r\nCertUtil: ok";
        let expected = Some(RUNTIME.sha256.to_string());
        assert_eq!(digest_in(modern), expected);
        assert_eq!(digest_in(spaced), expected);
        assert_eq!(digest_in("CertUtil: error"), None);
    }

    #[test]
    fn a_runtime_without_its_completion_marker_is_not_installed() {
        let root = std::env::temp_dir().join(format!("ade-tts-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("piper")).unwrap();
        std::fs::write(exe_path(&root), b"exe").unwrap();
        // An extraction cut short: the exe is there, the marker is not.
        assert!(!runtime_ready(&root));
        std::fs::write(runtime_marker(&root), "not the digest").unwrap();
        assert!(!runtime_ready(&root));
        std::fs::write(runtime_marker(&root), RUNTIME.sha256).unwrap();
        assert!(runtime_ready(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_known_voices_and_pinned_urls() {
        assert!(voice("ugo").is_ok());
        assert!(voice("paola").is_ok());
        assert!(voice("lessac").is_ok());
        assert!(voice("giorgio").is_err());
        assert!(voice("../../evil").is_err());
        for v in VOICES {
            assert!(v.source.starts_with("https://huggingface.co/"));
            for d in [&v.model, &v.config] {
                assert!(d.url.starts_with("https://huggingface.co/"));
                assert!(!d.url.contains("/resolve/main/"), "{} is not pinned to a revision", d.url);
                assert_eq!(d.sha256.len(), 64);
            }
        }
    }

    #[test]
    fn synthesis_timeout_triggers_error_on_stalled_stdout() {
        struct StalledReader;
        impl std::io::Read for StalledReader {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(std::time::Duration::from_millis(500));
                Ok(0)
            }
        }
        let rx = spawn_stdout_reader(StalledReader);
        let res = read_response_with_timeout(&rx, std::time::Duration::from_millis(50));
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(err.contains("timeout"), "expected timeout error, got: {err}");
    }

    #[test]
    fn synthesis_reads_response_when_stdout_answers_in_time() {
        use std::io::Cursor;
        let rx = spawn_stdout_reader(Cursor::new(b"C:\\scratch\\0.wav\n"));
        let res = read_response_with_timeout(&rx, std::time::Duration::from_millis(500));
        assert_eq!(res.unwrap(), "C:\\scratch\\0.wav\n");
    }

    #[test]
    fn synthesis_reports_closed_process_on_eof() {
        use std::io::Cursor;
        let rx = spawn_stdout_reader(Cursor::new(b""));
        let res = read_response_with_timeout(&rx, std::time::Duration::from_millis(500));
        assert!(res.is_err());
        assert_eq!(res.unwrap_err(), "Piper si è chiuso.");
    }

    #[test]
    fn the_first_sentence_after_a_start_waits_longer() {
        assert_eq!(synthesis_timeout(true), FIRST_SYNTHESIS_TIMEOUT);
        assert_eq!(synthesis_timeout(false), SYNTHESIS_TIMEOUT);
        // Wider than the JS client's 15 s, which decides when to stop waiting.
        assert!(SYNTHESIS_TIMEOUT >= std::time::Duration::from_secs(30));
        assert!(FIRST_SYNTHESIS_TIMEOUT > std::time::Duration::from_secs(22));
    }

    #[test]
    fn a_phrase_the_js_abandoned_is_skipped_when_it_reaches_the_front() {
        let piper = std::sync::Arc::new(Piper::default());
        // The phrase in corso: it holds the lock, and it is allowed to finish.
        let front = piper.resident.lock().unwrap();
        let queued = piper.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _guard = queued.resident.lock().unwrap();
            let _ = tx.send(queued.claim(7).is_err());
        });
        // The JS abandons the queued phrase while it still waits for the lock.
        piper.abandon(&[7]);
        drop(front);
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(5)).expect("the queued phrase must reach its turn"),
            true,
            "an abandoned phrase must be skipped, not synthesised"
        );
        worker.join().unwrap();
    }

    #[test]
    fn the_skip_consumes_the_mark_and_leaves_the_other_phrases_alone() {
        let piper = Piper::default();
        piper.abandon(&[3, 4]);
        assert!(piper.claim(3).is_err(), "the abandoned phrase is skipped");
        assert!(piper.claim(5).is_ok(), "a phrase never abandoned reaches synthesis");
        assert!(piper.claim(4).is_err());
        assert!(piper.claim(4).is_ok(), "the mark is consumed by the claim that found it");
    }

    #[test]
    fn a_phrase_already_synthesising_clears_a_late_abandonment_of_its_own_token() {
        let piper = Piper::default();
        // Claimed at the front: the synthesis runs. The JS abandons it meanwhile.
        assert!(piper.claim(9).is_ok());
        piper.abandon(&[9]);
        // When it finishes the mark must not linger: nothing will claim token 9 again.
        piper.release(9);
        assert!(piper.claim(9).is_ok());
    }

    #[test]
    fn a_stop_reports_the_voice_it_could_not_free_and_forgets_nothing_until_it_could() {
        let piper = Piper::default();
        assert!(!piper.stop_resident().busy);
        piper.abandon(&[21]);
        let in_corso = piper.resident.lock().unwrap();
        assert!(piper.stop_resident().busy, "a stop that freed nothing must not answer as a stop");
        assert!(piper.claim(21).is_err(), "a busy stop leaves the queue of the live process alone");
        drop(in_corso);
        assert!(!piper.stop_resident().busy);
        piper.abandon(&[21]);
        assert!(piper.claim(21).is_err(), "only a process that was there takes its marks with it");
    }

    #[test]
    fn the_marks_go_with_the_process_that_was_there_to_end() {
        let resident = Mutex::new(Some(7_u8));
        {
            let mut guard = resident.lock().unwrap();
            assert!(forget_resident(&mut guard), "a resident was there, and it is gone");
            assert!(guard.is_none(), "the process is dropped, which kills it");
        }
        let empty = Mutex::new(None::<u8>);
        assert!(!forget_resident(&mut empty.lock().unwrap()), "there was no process to end");
    }

    #[test]
    fn a_stop_recovers_a_resident_lock_poisoned_by_a_panicking_synthesis() {
        let piper = std::sync::Arc::new(Piper::default());
        let worker = std::sync::Arc::clone(&piper);
        let _ = std::thread::spawn(move || {
            let _guard = worker.resident.lock().unwrap();
            panic!("la sintesi è andata storta");
        })
        .join();
        assert!(piper.resident.try_lock().is_err(), "the lock is poisoned after the panic");
        drop(piper.lock_resident());
        assert!(!piper.stop_resident().busy, "a poisoned lock read as a sentence in corso wedges the voice");
    }

    #[test]
    fn stopping_piper_forgets_every_abandonment_mark() {
        let piper = Piper::default();
        piper.abandon(&[11, 12]);
        // The resident is free: stop takes it and the marks with it.
        piper.clear_abandoned_for_stop();
        assert!(piper.claim(11).is_ok(), "a stop leaves no orphan mark behind");
        assert!(piper.claim(12).is_ok());
    }

    #[test]
    fn a_failed_sentence_drops_the_process_and_frees_the_lock() {
        let slot = Mutex::new(Some(7_u8));
        {
            let mut guard = slot.lock().unwrap();
            let failed: Result<(), String> = Err("Piper non ha risposto entro il timeout (30 s).".into());
            forget_on_error(&mut guard, &failed);
        }
        let guard = slot.try_lock().expect("the lock is free after a failure");
        assert!(guard.is_none());
        drop(guard);

        let kept = Mutex::new(Some(7_u8));
        forget_on_error(&mut kept.lock().unwrap(), &Ok::<(), String>(()));
        assert_eq!(*kept.lock().unwrap(), Some(7));
    }
    // -----------------------------------------------------------------------
    // The installer, with no network and no external tool
    //
    // `install_blocking` needs an app handle and runs curl, tar and certutil, so
    // what is proved here is the part that decides whether a file is kept: the
    // staging, the size, the digest, the cancel, the deadline and the
    // progress. What arrives is a `Scripted` fetcher and an in-process
    // fingerprint, and the filesystem is a directory of this machine's temp.
    // -----------------------------------------------------------------------

    /// A directory of its own for one test, removed and made again.
    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("ade-k3-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// 64 hex digits from the bytes, standing in for SHA-256.
    ///
    /// Not a digest anyone trusts: what the tests need is a value that changes
    /// when the file changes and holds when it does not, so that the *check* can
    /// be proved. SHA-256 itself is certutil's, and it has its own test above.
    fn digest_of(bytes: &[u8]) -> String {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        let mut out = String::new();
        for round in 0..4 {
            hash = hash.wrapping_mul(0x100_0000_01b3) ^ hash.rotate_left(17) ^ round;
            out.push_str(&format!("{hash:016x}"));
        }
        out
    }

    /// The in-process fingerprint the tests install with.
    struct FingerprintInProcess;

    impl Fingerprint for FingerprintInProcess {
        fn sha256(&self, path: &Path) -> Result<String, String> {
            Ok(digest_of(&std::fs::read(path).map_err(|e| e.to_string())?))
        }
    }

    /// What a `Scripted` transfer does, so each test can break it differently.
    #[derive(Clone, Copy)]
    enum Ending {
        /// Writes everything and says it landed.
        Whole,
        /// Writes everything and reports success while the file is short: a
        /// connection that dropped and curl that did not notice.
        Short,
        /// Reports failure the way curl does.
        Refused,
    }

    /// A transfer that writes `body` in `chunk` steps, asking `stop` between
    /// them exactly as the real one does.
    struct Scripted {
        body: Vec<u8>,
        chunk: usize,
        ending: Ending,
        started: Option<std::sync::mpsc::Sender<()>>,
        release: Option<Mutex<Option<std::sync::mpsc::Receiver<()>>>>,
        /// The urls it was asked for, and what the staging file weighed when
        /// each transfer walked in: a resume arrives at a file that is not empty,
        /// and a transfer that starts from zero arrives at nothing.
        asked: std::sync::Mutex<Vec<String>>,
        part_len_at_entry: std::sync::Mutex<Vec<u64>>,
    }

    impl Scripted {
        fn new(body: Vec<u8>, ending: Ending) -> Self {
            Self {
                body,
                chunk: 8,
                ending,
                started: None,
                release: None,
                asked: Mutex::new(Vec::new()),
                part_len_at_entry: Mutex::new(Vec::new()),
            }
        }

        fn signalling(mut self, started: std::sync::mpsc::Sender<()>) -> Self {
            self.started = Some(started);
            self
        }

        /// Holds the transfer still after its first piece, so another install can
        /// queue up behind it and the state have something da dire. Once, on
        /// purpose: after the permission the transfer goes on, and it is the
        /// next `stop()` that decides — which is the whole point of asking
        /// before every piece.
        fn gated(mut self, release: std::sync::mpsc::Receiver<()>) -> Self {
            self.release = Some(Mutex::new(Some(release)));
            self
        }
    }

    impl Fetcher for Scripted {
        fn fetch(
            &self,
            url: &str,
            part: &Path,
            report: &mut dyn FnMut(u64),
            stop: &dyn Fn() -> Option<String>,
        ) -> Result<u64, String> {
            self.asked.lock().unwrap().push(url.to_string());
            self.part_len_at_entry.lock().unwrap().push(bytes_so_far(part));
            let mut written: Vec<u8> = Vec::new();
            let mut pieces = 0;
            for piece in self.body.chunks(self.chunk.max(1)) {
                // Asked before every piece, the way the real fetcher asks before
                // every wait: a cancel is one tick away, never one file away.
                if let Some(reason) = stop() {
                    return Err(reason);
                }
                // The gate is after the first piece, so that the transfer has
                // already reported something before it is held still.
                if pieces > 0 {
                    if let Some(release) = &self.release {
                        let taken = release.lock().unwrap().take();
                        if let Some(gate) = taken {
                            let _ = gate.recv();
                        }
                    }
                }
                written.extend_from_slice(piece);
                std::fs::write(part, &written).map_err(|e| e.to_string())?;
                report(written.len() as u64);
                if let Some(started) = &self.started {
                    let _ = started.send(());
                }
                pieces += 1;
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            if let Some(reason) = stop() {
                return Err(reason);
            }
            match self.ending {
                Ending::Refused => Err("curl: (28) Operation timed out".into()),
                // Short says success and leaves a file that is not whole: the
                // case the size is there to catch, since the digest alone would
                // only say "this is not the file".
                Ending::Short => {
                    std::fs::write(part, &self.body[..self.body.len() / 2]).map_err(|e| e.to_string())?;
                    report((self.body.len() / 2) as u64);
                    Ok((self.body.len() / 2) as u64)
                }
                Ending::Whole => Ok(self.body.len() as u64),
            }
        }
    }

    /// A `Download` whose pinned digest is the one these bytes really have.
    ///
    /// `Box::leak` because `Download` borrows for `'static`, as the pinned
    /// artefacts do: a handful of bytes per test, and the alternative is a
    /// digest written out by hand and never checked by anyone.
    fn download_of(name: &str, body: &[u8], size: Option<u64>) -> Download {
        Download {
            url: Box::leak(format!("https://example.invalid/{name}").into_boxed_str()),
            sha256: Box::leak(digest_of(body).into_boxed_str()),
            size,
        }
    }

    /// Runs an install of `jobs` the way `install_blocking` does: the lock, then
    /// `begin`, then each file, then `finish`.
    fn run_install(
        installer: &Installer,
        provider: &str,
        jobs: &[(&Download, PathBuf)],
        scripted: &Scripted,
    ) -> Result<(), String> {
        let slot = installer.slot(provider);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, jobs.len() as u32, bytes_pending(jobs), far());
        let mut outcome = Ok(());
        for (download, path) in jobs {
            if let Err(problem) = install.bring(download, path, scripted, &FingerprintInProcess) {
                outcome = Err(problem);
                break;
            }
        }
        install.finish(&outcome);
        outcome
    }

    fn far() -> Instant {
        Instant::now() + std::time::Duration::from_secs(60)
    }

    #[test]
    fn a_download_that_stopped_early_is_named_and_leaves_nothing() {
        let root = test_root("interrotto");
        let installer = Installer::default();
        let body = b"un modello da sessanta megabyte, in questo caso venti byte".to_vec();
        let dest = root.join("voices").join("ugo.onnx");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        let jobs = [(&download_of("ugo.onnx", &body, Some(body.len() as u64)), dest.clone())];

        let problem = run_install(&installer, PIPER, &jobs, &Scripted::new(body, Ending::Short)).unwrap_err();
        assert_eq!(problem, INTERROTTA);
        assert!(!dest.is_file(), "un file scaricato a metà non può restare al suo posto");
        assert!(!staging(&dest).exists(), "il .part di un tentativo interrotto non resta");
        let progress = installer.progress_of(PIPER);
        assert!(!progress.running);
        assert_eq!(progress.error.as_deref(), Some(INTERROTTA));
        assert_eq!(progress.files_done, 0);
    }

    #[test]
    fn a_file_whose_digest_is_not_the_pinned_one_is_discarded() {
        let root = test_root("digest");
        let installer = Installer::default();
        let wanted = b"il file che il sito serve".to_vec();
        let served = b"il file che qualcuno ha servito".to_vec();
        let dest = root.join("ugo.onnx");
        // Whole, and not the file: the size cannot catch this one, only the digest.
        let jobs = [(&download_of("ugo.onnx", &wanted, Some(served.len() as u64)), dest.clone())];

        let problem = run_install(&installer, PIPER, &jobs, &Scripted::new(served, Ending::Whole)).unwrap_err();
        assert_eq!(problem, DIGEST);
        assert!(!dest.is_file());
        assert!(!staging(&dest).exists());
    }

    /// A `Fingerprint` that cannot read the file, the way certutil cannot when
    /// it does not start or when something else holds the file open.
    struct FingerprintUnavailable;

    impl Fingerprint for FingerprintUnavailable {
        fn sha256(&self, _path: &Path) -> Result<String, String> {
            Err("certutil non ha potuto leggere il file.".into())
        }
    }

    #[test]
    fn a_digest_that_could_not_be_read_is_not_a_wrong_digest() {
        let root = test_root("certutil");
        let installer = Installer::default();
        let body = b"un modello".to_vec();
        let dest = root.join("ugo.onnx");
        let jobs = [(&download_of("ugo.onnx", &body, Some(body.len() as u64)), dest.clone())];

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, 1, bytes_pending(&jobs), far());
        // Il file è giusto, e il controllo non è potuto arrivare: quello che si
        // dice è il motivo, non che il download sia sbagliato.
        let problem = install
            .bring(&jobs[0].0, &dest, &Scripted::new(body, Ending::Whole), &FingerprintUnavailable)
            .unwrap_err();
        install.finish(&Err(problem.clone()));
        assert_eq!(problem, "certutil non ha potuto leggere il file.");
        assert_ne!(problem, DIGEST, "un controllo non arrivato non è un file sbagliato");
        // Il mezzo file non resta li: come in ogni altro errore.
        assert!(!dest.is_file());
        assert!(!staging(&dest).exists());
        assert_eq!(installer.progress_of(PIPER).error.as_deref(), Some(problem.as_str()));
    }

    #[test]
    fn a_cancelled_install_stops_and_keeps_nothing() {
        let root = test_root("annullato");
        let installer = Installer::default();
        let body = b"un modello".to_vec();
        let dest = root.join("ugo.onnx");
        let jobs = [(&download_of("ugo.onnx", &body, Some(body.len() as u64)), dest.clone())];

        // The interface's own way in: the cancel arrives while the transfer runs.
        let installer = std::sync::Arc::new(installer);
        let (started, seen) = std::sync::mpsc::channel();
        let scripted = Scripted::new(body, Ending::Whole).signalling(started);
        let cancelling = {
            let installer = installer.clone();
            std::thread::spawn(move || {
                seen.recv_timeout(std::time::Duration::from_secs(5)).expect("il trasferimento deve partire");
                installer.cancel_of(PIPER)
            })
        };
        let problem = run_install(&installer, PIPER, &jobs, &scripted).unwrap_err();
        assert_eq!(problem, ANNULLATA);
        assert!(cancelling.join().unwrap(), "un annullamento senza installazione in corso non annulla niente");
        assert!(!dest.is_file());
        assert!(!staging(&dest).exists());
    }

    #[test]
    fn a_transfer_that_fails_is_named_the_way_it_always_was() {
        let root = test_root("rifiutato");
        let installer = Installer::default();
        let body = b"un modello".to_vec();
        let dest = root.join("ugo.onnx");
        let jobs = [(&download_of("ugo.onnx", &body, Some(body.len() as u64)), dest.clone())];

        // The one message this change must not touch: before it, every failure of
        // the download was named like this, and Piper's install said it too.
        let problem = run_install(&installer, PIPER, &jobs, &Scripted::new(body, Ending::Refused)).unwrap_err();
        assert_eq!(problem, "Download della voce non riuscito: curl: (28) Operation timed out");
        assert!(!dest.is_file());
        assert!(!staging(&dest).exists());
        assert_eq!(installer.progress_of(PIPER).error.as_deref(), Some(problem.as_str()));
    }

    #[test]
    fn a_part_left_by_an_earlier_attempt_is_never_resumed() {
        let root = test_root("ripreso");
        let installer = Installer::default();
        let body = b"il modello per intero".to_vec();
        let dest = root.join("ugo.onnx");
        let part = staging(&dest);
        // An attempt that got as far as a whole-looking `.part`, with bytes
        // nobody vouched for: the case a resume would trust.
        std::fs::write(&part, b"spazzatura di un tentativo passato").unwrap();
        let jobs = [(&download_of("ugo.onnx", &body, Some(body.len() as u64)), dest.clone())];
        let scripted = Scripted::new(body.clone(), Ending::Whole);

        run_install(&installer, PIPER, &jobs, &scripted).expect("l'installazione deve riuscire");
        assert_eq!(std::fs::read(&dest).unwrap(), body, "il file finale è quello scaricato adesso");
        assert_eq!(scripted.asked.lock().unwrap().len(), 1, "il download riparte da capo, non riprende");
        assert_eq!(
            scripted.part_len_at_entry.lock().unwrap()[0],
            0,
            "la spazzatura del tentativo passato non era lì quando il download è ripartito"
        );
        assert!(!part.exists());
    }

    #[test]
    fn an_install_past_its_deadline_stops_with_a_reason() {
        let root = test_root("scaduta");
        let installer = Installer::default();
        let body = b"un modello".to_vec();
        let dest = root.join("ugo.onnx");
        let wanted = download_of("ugo.onnx", &body, Some(body.len() as u64));
        // Already past: the deadline is absolute, not a count of retries.
        let past = Instant::now() - std::time::Duration::from_secs(1);

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, 1, bytes_pending(&[(&wanted, dest.clone())]), past);
        let problem = install
            .bring(&wanted, &dest, &Scripted::new(body, Ending::Whole), &FingerprintInProcess)
            .unwrap_err();
        install.finish(&Err(problem.clone()));
        assert_eq!(problem, SCADUTA);
        assert!(!dest.is_file());
    }

    #[test]
    fn a_file_already_in_place_is_left_alone_and_counted_as_done() {
        let root = test_root("gia");
        let installer = Installer::default();
        let body = b"il modello".to_vec();
        let dest = root.join("ugo.onnx");
        let config = root.join("ugo.onnx.json");
        std::fs::write(&dest, b"il modello di prima").unwrap();
        let jobs = [
            (&download_of("ugo.onnx", &body, Some(body.len() as u64)), dest.clone()),
            (&download_of("ugo.onnx.json", b"{}", Some(2)), config.clone()),
        ];
        let scripted = Scripted::new(b"{}".to_vec(), Ending::Whole);

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, jobs.len() as u32, bytes_pending(&jobs), far());
        // The one already there is not fetched again: a voice the user already
        // installed must not be downloaded because they opened the panel.
        assert_eq!(install.bring(&jobs[0].0, &dest, &scripted, &FingerprintInProcess), Ok(()));
        assert_eq!(install.bring(&jobs[1].0, &config, &scripted, &FingerprintInProcess), Ok(()));
        install.finish(&Ok(()));

        let asked = scripted.asked.lock().unwrap();
        assert_eq!(asked.len(), 1, "solo il file mancante si scarica");
        assert!(asked[0].ends_with("ugo.onnx.json"));
        assert_eq!(std::fs::read(&dest).unwrap(), b"il modello di prima");
    }

    #[test]
    fn the_progress_says_what_is_left_and_how_much_of_it_is_there() {
        let root = test_root("progresso");
        let installer = Installer::default();
        let body = vec![7_u8; 64];
        let model = root.join("ugo.onnx");
        let config = root.join("ugo.onnx.json");
        let jobs = [
            (&download_of("ugo.onnx", &body, Some(64)), model),
            (&download_of("ugo.onnx.json", &body, Some(64)), config),
        ];

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, 3, bytes_pending(&jobs), far());
        let started = installer.progress_of(PIPER);
        assert!(started.running);
        assert_eq!(started.files_total, 3, "i tre file dell'installazione, anche quello che c'è già");

        let scripted = Scripted::new(body, Ending::Whole);
        install.bring(&jobs[0].0, &jobs[0].1, &scripted, &FingerprintInProcess).unwrap();
        let after_one = installer.progress_of(PIPER);
        assert_eq!(after_one.files_done, 1);
        assert_eq!(after_one.bytes_done, 64);
        assert_eq!(after_one.bytes_total, Some(128), "solo i byte ancora da scaricare");
        assert!(after_one.error.is_none());

        // The second file reports its own bytes from zero, and what the panel
        // reads still goes up: a bar that fell back here would show an install
        // going backwards halfway through.
        install.bring(&jobs[1].0, &jobs[1].1, &scripted, &FingerprintInProcess).unwrap();
        let after_two = installer.progress_of(PIPER);
        assert_eq!(after_two.files_done, 2);
        assert_eq!(after_two.bytes_done, 128, "i byte di tutti i file, non quelli dell'ultimo");
        install.finish(&Ok(()));
        assert!(!installer.progress_of(PIPER).running);
    }

    /// A root whose runtime is already installed: the marker and the executable,
    /// which is the whole of `runtime_ready`.
    fn root_with_runtime(name: &str) -> PathBuf {
        let root = test_root(name);
        std::fs::create_dir_all(root.join("piper")).unwrap();
        std::fs::write(exe_path(&root), b"un eseguibile qualsiasi").unwrap();
        std::fs::write(runtime_marker(&root), RUNTIME.sha256).unwrap();
        root
    }

    #[test]
    fn a_cold_install_has_no_byte_total_because_the_runtime_bytes_are_published_too() {
        let root = test_root("totale-a-freddo");
        let installer = Installer::default();
        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        // A freddo l'install parte dall'archivio del runtime, e quei byte vengono
        // pubblicati come gli altri. Un totale che contasse solo i due file della
        // voce farebbe camminare la barra oltre il proprio fondo, che è il 100%
        // che l'utente vede alla prima installazione. L'esito qui è un errore —
        // l'archivio finto non si lascia scompattare — e non è quello che il
        // test guarda: quello che guarda è lo stato pubblicato prima.
        let _ = install_voice(
            &installer,
            &slot,
            &root,
            wanted_voice("ugo"),
            &Scripted::new(vec![9_u8; 4096], Ending::Whole),
            &FingerprintInProcess,
        );
        let after = installer.progress_of(PIPER);
        assert_eq!(after.bytes_total, None, "a freddo il totale dei byte non è noto: il pannello disegna per file");
        assert!(after.bytes_done > 0, "i byte scaricati sono pubblicati anche senza un totale");
        assert_eq!(after.files_total, 3, "i file si contano sempre");
    }

    #[test]
    fn a_warm_install_keeps_the_total_and_never_passes_it() {
        let root = root_with_runtime("totale-a-caldo");
        let installer = Installer::default();
        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        // Runtime presente e voce già scaricata: l'install non ha niente da
        // prendere, e i due file sono già al loro posto. Il totale è la somma di
        // quello che manca, che qui è zero — ed è questo che distingue il ramo
        // caldo da quello freddo, dove il totale è ignoto.
        let model = model_path(&root, "ugo");
        std::fs::create_dir_all(model.parent().unwrap()).unwrap();
        std::fs::write(&model, b"gia' qui").unwrap();
        std::fs::write(model.with_extension("onnx.json"), b"gia' qui").unwrap();
        let outcome = install_voice(
            &installer,
            &slot,
            &root,
            wanted_voice("ugo"),
            &Scripted::new(vec![3_u8; 32], Ending::Whole),
            &FingerprintInProcess,
        );
        assert!(outcome.is_ok(), "a caldo, con tutto già in posto, l'install è una no-op");
        let after = installer.progress_of(PIPER);
        let total = after.bytes_total.expect("a caldo i byte si contano");
        assert!(after.bytes_done <= total, "{} byte su un totale di {total}", after.bytes_done);
        assert_eq!(after.files_done, after.files_total, "la barra arriva in fondo");
        assert!(!after.running);
    }

    #[test]
    fn with_the_runtime_already_there_the_bar_reaches_the_end_and_knows_its_bytes() {
        let root = root_with_runtime("runtime-pronto");
        let installer = Installer::default();
        let body = vec![7_u8; 64];
        let model = root.join("voices").join("ugo.onnx");
        let config = model.with_extension("onnx.json");
        std::fs::create_dir_all(model.parent().unwrap()).unwrap();
        let config_body = body.clone();
        let voice_files = [
            (&download_of("ugo.onnx", &body, Some(64)), model),
            (&download_of("ugo.onnx.json", &config_body, Some(64)), config),
        ];

        // The runtime is not one of the files to fetch: its size is not known and
        // its archive never sits at `piper.zip`, and with it in the list the
        // total was empty on every install, warm or cold.
        assert_eq!(
            bytes_pending(&voice_files),
            Some(128),
            "con il runtime già installato i byte da scaricare si sanno"
        );

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, 3, bytes_pending(&voice_files), far());
        assert!(
            installer.progress_of(PIPER).bytes_total.is_some(),
            "la barra dei byte ha un totale da disegnare"
        );
        let scripted = Scripted::new(body, Ending::Whole);
        let outcome = install_locked(&install, &root, &voice_files, &scripted, &FingerprintInProcess);
        install.finish(&outcome);
        outcome.unwrap();

        let done = installer.progress_of(PIPER);
        assert_eq!(done.files_done, 3, "tre file su tre, e l'installazione è finita");
        assert_eq!(done.files_total, 3);
        assert!(!done.running);
        // Il runtime non è stato riscaricato: era già installato.
        assert_eq!(scripted.asked.lock().unwrap().len(), 2, "solo i due file della voce");
    }

    #[test]
    fn a_cancel_between_two_files_stops_before_the_next_download() {
        let root = root_with_runtime("annullato-fra-file");
        let installer = Installer::default();
        let body = vec![7_u8; 64];
        let model = root.join("voices").join("ugo.onnx");
        let config = model.with_extension("onnx.json");
        std::fs::create_dir_all(model.parent().unwrap()).unwrap();
        let config_body = body.clone();
        // Il primo file è già al suo posto: l'annullamento cade nel buco fra
        // l'uno e l'altro, dove il fetcher non chiede.
        std::fs::write(&config, &config_body).unwrap();
        let voice_files = [
            (&download_of("ugo.onnx.json", &config_body, Some(64)), config),
            (&download_of("ugo.onnx", &body, Some(64)), model),
        ];

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, 3, bytes_pending(&voice_files), far());
        // Il primo file passa senza rete, e l'annullamento arriva lì in mezzo.
        install
            .bring(&voice_files[0].0, &voice_files[0].1, &Scripted::new(body.clone(), Ending::Whole), &FingerprintInProcess)
            .unwrap();
        assert!(installer.cancel_of(PIPER));

        let scripted = Scripted::new(body, Ending::Whole);
        let outcome = install_locked(&install, &root, &voice_files, &scripted, &FingerprintInProcess);
        install.finish(&outcome);
        assert_eq!(outcome.unwrap_err(), ANNULLATA);
        assert!(scripted.asked.lock().unwrap().is_empty(), "il secondo file non parte");
    }

    #[test]
    fn a_cancel_that_arrived_too_late_does_not_cancel_the_next_install() {
        let root = root_with_runtime("annullato-tardi");
        let installer = Installer::default();
        let body = vec![7_u8; 64];
        let model = root.join("voices").join("ugo.onnx");
        let config = model.with_extension("onnx.json");
        std::fs::create_dir_all(model.parent().unwrap()).unwrap();
        let config_body = body.clone();
        // Tutti i file già al loro posto: l'installazione non scarica niente.
        std::fs::write(&model, &body).unwrap();
        std::fs::write(&config, &config_body).unwrap();
        let voice_files = [
            (&download_of("ugo.onnx.json", &config_body, Some(64)), config),
            (&download_of("ugo.onnx", &body, Some(64)), model),
        ];

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, 3, bytes_pending(&voice_files), far());
        let scripted = Scripted::new(body, Ending::Whole);
        let outcome = install_locked(&install, &root, &voice_files, &scripted, &FingerprintInProcess);
        assert!(outcome.is_ok(), "{outcome:?}");
        // L'annullamento arriva dopo l'ultimo controllo ma prima della chiusura:
        // la finestra esiste, ed è qui che l'annullamento si fermava addosso.
        assert!(installer.cancel_of(PIPER), "l'annullamento è arrivato a un install in corso");
        install.finish(&outcome);
        // L'installazione è riuscita, e un install riuscito non è annullato: se
        // no, il prossimo per questo provider parte già annullato.
        assert!(!installer.progress_of(PIPER).cancelled);
    }

    /// A transfer that gets halfway, is cut, and starts again from zero: what
    /// `curl --retry 2` does to the staging file, and the reason a byte counter
    /// that adds up every report ends up counting the same bytes twice.
    struct Restarting {
        body: Vec<u8>,
    }

    impl Fetcher for Restarting {
        fn fetch(
            &self,
            _url: &str,
            part: &Path,
            report: &mut dyn FnMut(u64),
            _stop: &dyn Fn() -> Option<String>,
        ) -> Result<u64, String> {
            let half = self.body.len() / 2;
            std::fs::write(part, &self.body[..half]).map_err(|e| e.to_string())?;
            report(half as u64);
            std::fs::write(part, &self.body).map_err(|e| e.to_string())?;
            report(self.body.len() as u64);
            Ok(self.body.len() as u64)
        }
    }

    #[test]
    fn bytes_a_file_lost_and_written_again_are_not_counted_twice() {
        let root = test_root("ritentativo");
        let installer = Installer::default();
        let body = b"il file per intero".to_vec();
        let dest = root.join("ugo.onnx");
        let wanted = download_of("ugo.onnx", &body, Some(body.len() as u64));
        let files = [(&wanted, dest.clone())];

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, 1, bytes_pending(&files), far());
        // Un trasferimento che si interrompe a metà e ricomincia da capo: il file
        // si accorcia a zero e ricresce, e i byte non possono essere contati due
        // volte. Qui si vede il numero, che è la metà del file più il file.
        let restarting = Restarting { body: body.clone() };
        install.fetch(&wanted, &staging(&dest), &restarting, &FingerprintInProcess).unwrap();
        assert_eq!(
            installer.progress_of(PIPER).bytes_done,
            body.len() as u64,
            "un ritentativo non gonfia il contatore"
        );
        install.finish(&Ok(()));
    }

    /// A `Fingerprint` that panics, which is the one way an install can stop
    /// without an outcome: nothing in `install_locked` is expected to.
    struct FingerprintPanicking;

    impl Fingerprint for FingerprintPanicking {
        fn sha256(&self, _path: &Path) -> Result<String, String> {
            panic!("un panico vero, dentro il controllo");
        }
    }

    #[test]
    fn a_panic_inside_an_install_leaves_it_closed() {
        let root = test_root("panico");
        let installer = Installer::default();
        let body = b"un modello".to_vec();
        let dest = root.join("ugo.onnx");
        let wanted = download_of("ugo.onnx", &body, Some(body.len() as u64));
        let files = [(&wanted, dest.clone())];

        let slot = installer.slot(PIPER);
        let _one = installer.hold(&slot);
        let install = installer.begin(&slot, 1, bytes_pending(&files), far());
        // Il panico non passa da `report`: è il drop a chiudere, che è il punto.
        let closed = Closed { install: &install, closed: false };
        // Il rumore del panico non è un fallimento: qui viene voluto.
        let quiet = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            install_locked(&install, &root, &files, &Scripted::new(body, Ending::Whole), &FingerprintPanicking)
        }));
        std::panic::set_hook(quiet);
        assert!(outcome.is_err(), "il controllo è andato in panico");
        drop(closed);

        let progress = installer.progress_of(PIPER);
        assert!(!progress.running, "un install finito non resta in corso per sempre");
        assert_eq!(progress.error.as_deref(), Some(PANICA));
    }

    #[test]
    fn a_rename_that_succeeds_leaves_nothing_behind() {
        let root = test_root("rename-ok");
        let from = root.join("ugo.onnx.part");
        let dest = root.join("ugo.onnx");
        std::fs::write(&from, b"il modello").unwrap();

        rename_into_place(&from, &dest).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"il modello");
        assert!(!from.exists(), "il .part non resta dopo un rename riuscito");
    }

    #[test]
    fn a_rename_that_cannot_happen_says_which_file_and_leaves_no_part() {
        let root = test_root("rename-fallito");
        // Una cartella al posto del file: `rename` non può sostituirla, e su
        // Windows è la forma che prende «qualcuno lo tiene aperto».
        let dest = root.join("ugo.onnx");
        std::fs::create_dir_all(&dest).unwrap();
        let from = root.join("ugo.onnx.part");
        std::fs::write(&from, b"il modello").unwrap();

        let problem = rename_into_place(&from, &dest).unwrap_err();
        // Il nome del file è nella frase: «Access is denied» da solo manda
        // l'utente a cercare permessi che non è lui ad avere.
        assert!(problem.contains("ugo.onnx"), "il messaggio nomina il file: {problem}");
        assert!(!from.exists(), "un .part lasciato è spazzatura che sembra progresso");
    }

    #[test]
    fn a_name_that_is_not_a_provider_does_not_stay_in_the_map() {
        let installer = Installer::default();
        // Le stringhe arrivano dall'interfaccia: una mappa che cresce per ognuna
        // cresce per tutta la durata dell'app.
        for i in 0..500 {
            installer.progress_of(&format!("provider-{i}"));
            installer.cancel_of(&format!("provider-{i}"));
        }
        assert_eq!(installer.providers.lock().unwrap().len(), 0, "nessuno di quelli è un provider");

        // Quelli che lo sono, invece, ci restano: e uno solo per provider.
        installer.progress_of(PIPER);
        installer.progress_of("kokoro");
        installer.progress_of(PIPER);
        assert_eq!(installer.providers.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_lock_poisoned_by_a_panic_is_still_taken() {
        let installer = std::sync::Arc::new(Installer::default());
        let quiet = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        // Un thread che tiene il lock e va in panico: il mutex resta avvelenato.
        let poisoned = {
            let installer = installer.clone();
            std::thread::spawn(move || {
                let slot = installer.slot(PIPER);
                let _held = installer.hold(&slot);
                panic!("un panico vero, col lock in mano");
            })
        };
        assert!(poisoned.join().is_err());
        std::panic::set_hook(quiet);
        // Rifiutarlo lasciava il provider con «installazione bloccata» per
        // tutta la sessione, e non è niente qui che resti scritto a metà.
        let slot = installer.slot(PIPER);
        let _taken = installer.hold(&slot);
    }

    #[test]
    fn one_provider_does_not_hold_up_another() {
        let installer = Installer::default();
        let piper = installer.slot(PIPER);
        let kokoro = installer.slot("kokoro");
        // `hold` aspetta, e qui si vuole sapere subito: `try_lock` è la
        // domanda «lo si può prendere adesso?».
        let _held = piper.lock.try_lock().unwrap();
        // Kokoro's files are not Piper's files: asking for one while the other
        // downloads must not wait, or a 63 MB voice holds up the next one.
        assert!(kokoro.lock.try_lock().is_ok());
        assert!(piper.lock.try_lock().is_err(), "two installs of one provider must not write the same files");
    }

    #[test]
    fn a_cancel_with_nothing_running_says_so() {
        let installer = Installer::default();
        assert!(!installer.cancel_of("kokoro"), "non c'è installazione in corso da fermare");
        // And it does not leave a cancelled mark on the next one.
        assert!(!installer.progress_of("kokoro").cancelled);
    }

    /// The voice the panel would have installed, out of the catalog the app
    /// ships: what the panel names is a catalog voice, and the install reads its
    /// two files by name.
    fn wanted_voice(id: &str) -> &'static Voice {
        VOICES.iter().find(|voice| voice.id == id).expect("una voce del catalogo")
    }

    /// A voice of the catalog's shape whose two files are `body`, digests
    /// included.
    ///
    /// The real voices carry pinned digests of files nobody has here, so an
    /// install of one of them with a scripted transfer always ends at the digest
    /// check. This one is installable, which is what lets a test drive
    /// `install_voice` all the way to a finished install instead of stopping at
    /// the first file. Leaked like `download_of` leaks its strings: a `Voice` is
    /// `&'static str` all the way down, and a test that ran once does not need it
    /// back.
    fn installable_voice(id: &'static str, body: &[u8]) -> &'static Voice {
        Box::leak(Box::new(Voice {
            id,
            source: "https://example.invalid/voice",
            model: download_of("model.onnx", body, Some(body.len() as u64)),
            config: download_of("model.onnx.json", body, Some(body.len() as u64)),
        }))
    }

    #[test]
    fn a_second_install_of_one_provider_waits_its_turn_and_leaves_the_state_alone() {
        // Runtime già presente: il secondo install passa dalla riga vera e non si
        // ferma a scaricare l'archivio, così quello che il test guarda è solo
        // l'ordine fra lock e stato.
        let root = root_with_runtime("due-install");
        let installer = std::sync::Arc::new(Installer::default());
        let body = b"un modello da sessanta megabyte".to_vec();
        let first_dest = root.join("ugo.onnx");
        let second_dest = model_path(&root, "paola");
        let first_wanted = download_of("ugo.onnx", &body, Some(body.len() as u64));
        std::fs::create_dir_all(second_dest.parent().unwrap()).unwrap();

        // Il primo install tiene il lock e aspetta il permesso di scaricare.
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first = {
            let installer = installer.clone();
            let body = body.clone();
            std::thread::spawn(move || {
                let slot = installer.slot(PIPER);
                let _one = installer.hold(&slot);
                let install = installer.begin(&slot, 1, None, far());
                let scripted = Scripted::new(body, Ending::Whole).signalling(started_tx).gated(release_rx);
                let outcome = install.bring(&first_wanted, &first_dest, &scripted, &FingerprintInProcess);
                install.finish(&outcome);
                outcome
            })
        };
        started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("il primo download parte");
        // Qualcosa è già scaricato: è lo stato che il secondo non deve toccare.
        assert!(installer.progress_of(PIPER).bytes_done > 0);

        // Il secondo chiede un'altra voce mentre il primo scarica, e lo chiede
        // come lo chiede l'applicazione: `install_voice`, la riga vera, così
        // l'ordine che questo test dimostra è quello che gira e non una sua
        // ricostruzione.
        let (queued_tx, queued_rx) = std::sync::mpsc::channel();
        let second = {
            let installer = installer.clone();
            let root = root.clone();
            let body = body.clone();
            std::thread::spawn(move || {
                queued_tx.send(()).unwrap();
                let slot = installer.slot(PIPER);
                let _one = installer.hold(&slot);
                install_voice(
                    &installer,
                    &slot,
                    &root,
                    installable_voice("paola", &body),
                    &Scripted::new(body, Ending::Whole),
                    &FingerprintInProcess,
                )
            })
        };
        queued_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("il secondo install chiede il lock");
        std::thread::sleep(std::time::Duration::from_millis(50));

        // In coda non ha ancora cominciato: lo stato è ancora quello del primo e
        // non è stato azzerato da un `begin` che non è ancora cominciato.
        let while_queued = installer.progress_of(PIPER);
        assert!(while_queued.running, "il primo sta scaricando: lo stato lo dice");
        assert!(
            while_queued.bytes_done > 0,
            "i byte del primo non sono spariti per un install in coda"
        );

        // L'annulla raggiunge quello che gira.
        assert!(installer.cancel_of(PIPER), "c'era un install in corso da fermare");
        // Il permesso di scaricare, che era tenuto fermo il primo pezzo: adesso
        // va avanti e al pezzo dopo è `stop()` a leggerlo.
        release_tx.send(()).unwrap();
        let stopped = first.join().unwrap().unwrap_err();
        assert_eq!(stopped, ANNULLATA, "l'annulla ha fermato il download che stava andando");

        // E il secondo parte dopo, con lo stato pulito.
        assert!(second.join().unwrap().is_ok(), "chi aspetta parte dopo e riesce");
        let after = installer.progress_of(PIPER);
        assert!(!after.running);
        assert!(!after.cancelled, "l'annullamento non resta sul successivo");
        assert!(second_dest.is_file());
    }

    #[test]
    fn an_install_that_waited_its_turn_has_not_spent_its_budget() {
        let root = test_root("scadenza-dopo");
        // Trecento millisecondi di budget e un file da otto byte: dopo il lock il
        // lavoro è di un pezzo, e regge anche con la suite che gira in parallelo.
        let installer = std::sync::Arc::new(Installer {
            providers: Mutex::new(HashMap::new()),
            deadline: Some(std::time::Duration::from_millis(300)),
        });
        let body = b"un file".to_vec();
        let dest = root.join("ugo.onnx");
        let wanted = download_of("ugo.onnx", &body, Some(body.len() as u64));

        // Il lock è tenuto da un altro, più a lungo del budget.
        let held = installer.slot(PIPER);
        let guard = installer.hold(&held);
        let waiter = {
            let installer = installer.clone();
            let body = body.clone();
            let dest = dest.clone();
            std::thread::spawn(move || {
                // La forma di `install_blocking`: il lock, e solo dopo il
                // budget. Un install in coda non ha ancora speso niente.
                let slot = installer.slot(PIPER);
                let _one = installer.hold(&slot);
                let install = installer.begin(&slot, 1, None, Instant::now() + installer.deadline());
                let outcome = install.bring(&wanted, &dest, &Scripted::new(body, Ending::Whole), &FingerprintInProcess);
                install.finish(&outcome);
                outcome
            })
        };
        std::thread::sleep(std::time::Duration::from_millis(400));
        drop(guard);

        let outcome = waiter.join().unwrap();
        assert!(outcome.is_ok(), "il budget parte dal lock, non dalla richiesta: {outcome:?}");
        assert!(dest.is_file());
    }
}
