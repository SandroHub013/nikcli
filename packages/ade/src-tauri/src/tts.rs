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
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

/// One file to fetch: where from, and the digest it must have.
struct Download {
    url: &'static str,
    sha256: &'static str,
}

const RUNTIME: Download = Download {
    url: "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip",
    sha256: "f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea",
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
        },
        config: Download {
            url: "https://huggingface.co/Einrich99/PiperTTS-UGO-Italian/resolve/3d165b2a45cb134e96eb3a30a85568b213848ad2/medium/it_IT-ugo-medium.onnx.json",
            sha256: "feb477322e426918b978c46a80c7eb02e21014c38131dd6878fd72a5e21e4081",
        },
    },
    Voice {
        id: "paola",
        source: "https://huggingface.co/rhasspy/piper-voices/tree/main/it/it_IT/paola/medium",
        model: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/it/it_IT/paola/medium/it_IT-paola-medium.onnx",
            sha256: "6fc918b5a0ea6137382833dddfa567bffbe6a5060c02043c87192ee59c04210c",
        },
        config: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json",
            sha256: "aea19c0a7fce29fbc359b93f10e7902854401e4c95ae2ea328ae516b15d296cf",
        },
    },
    Voice {
        id: "lessac",
        source: "https://huggingface.co/rhasspy/piper-voices/tree/main/en/en_US/lessac/medium",
        model: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
            sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f",
        },
        config: Download {
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
            sha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0",
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

/// The resident process, and the lock that keeps two installs apart.
#[derive(Default)]
pub struct Piper {
    resident: Mutex<Option<Resident>>,
    install: Mutex<()>,
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

fn install_blocking(app: &tauri::AppHandle, wanted: &'static Voice) -> Result<(), String> {
    let state = app.state::<Piper>();
    // Two first sentences must not download the same files into each other.
    let _one = state.install.lock().map_err(|_| "installazione bloccata")?;
    let root = root(app)?;
    std::fs::create_dir_all(root.join("voices")).map_err(|e| e.to_string())?;

    if !runtime_ready(&root) {
        // Whatever an interrupted attempt left is discarded, not trusted.
        let _ = std::fs::remove_dir_all(root.join("piper"));
        let zip = root.join("piper.zip.part");
        fetch(&RUNTIME, &zip)?;
        let extracted = run(system_tool("tar.exe"), &["-xf".as_ref(), zip.as_os_str(), "-C".as_ref(), root.as_os_str()]);
        let _ = std::fs::remove_file(&zip);
        extracted?;
        if !exe_path(&root).is_file() {
            return Err("L'archivio di Piper non contiene piper.exe.".into());
        }
        std::fs::write(runtime_marker(&root), RUNTIME.sha256).map_err(|e| e.to_string())?;
    }
    let model = model_path(&root, wanted.id);
    let config = model.with_extension("onnx.json");
    for (download, path) in [(&wanted.config, config), (&wanted.model, model)] {
        if path.is_file() {
            continue;
        }
        let part = path.with_extension("part");
        fetch(download, &part)?;
        std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
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

    let mut guard = state.resident.lock().map_err(|_| "voce bloccata")?;
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
    let source = voice(&voice_id)?.source;
    #[allow(deprecated)]
    tauri_plugin_shell::ShellExt::shell(&app).open(source, None).map_err(|e| e.to_string())
}

/// Ends the resident process, freeing its memory until the next sentence.
/// Async and non-blocking: uses `try_lock` so an in-flight synthesis is never blocked,
/// and the main window never freezes. If busy, synthesis is in progress and stop is skipped
/// (JS will not re-arm the silence timer until another sentence finishes speaking).
#[tauri::command]
pub async fn tts_piper_stop(state: tauri::State<'_, Piper>) -> Result<(), String> {
    if let Ok(mut guard) = state.resident.try_lock() {
        *guard = None;
    }
    Ok(())
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

/// Downloads to `path` and keeps the file only if its digest is the pinned one.
fn fetch(download: &Download, path: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(path);
    run(
        system_tool("curl.exe"),
        // Bounded by progress, not by a total: the install lock is held for the
        // whole download, so a stalled connection left every later request for
        // this voice waiting, while a fixed ceiling would also cut off a slow
        // line that is still getting there. Under 1 KB/s for a minute is stalled.
        &[
            "-fsSL".as_ref(),
            "--retry".as_ref(),
            "2".as_ref(),
            "--connect-timeout".as_ref(),
            "20".as_ref(),
            "--speed-limit".as_ref(),
            "1024".as_ref(),
            "--speed-time".as_ref(),
            "60".as_ref(),
            "-o".as_ref(),
            path.as_os_str(),
            download.url.as_ref(),
        ],
    )
    .map_err(|e| format!("Download della voce non riuscito: {e}"))?;
    let listing = run(system_tool("certutil.exe"), &["-hashfile".as_ref(), path.as_os_str(), "SHA256".as_ref()])?;
    if digest_in(&listing).as_deref() != Some(download.sha256) {
        let _ = std::fs::remove_file(path);
        return Err("Il file scaricato non corrisponde a quello atteso: scartato.".into());
    }
    Ok(())
}

/// The hex digest in `certutil -hashfile` output: the line of 64 hex digits, spaces removed.
fn digest_in(listing: &str) -> Option<String> {
    listing
        .lines()
        .map(|line| line.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_ascii_lowercase())
        .find(|line| line.len() == 64 && line.chars().all(|c| c.is_ascii_hexdigit()))
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
}
