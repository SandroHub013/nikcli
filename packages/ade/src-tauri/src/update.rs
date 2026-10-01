//! In-app updates.
//!
//! The manifest and the signed bundles come from the fork's releases; see
//! `.github/workflows/ade-release.yml` for how they are produced, and
//! `plugins.updater` in `tauri.conf.json` for the endpoint and the public key.

/// Where an install stands, as the window hears it on `ade-update-progress`.
///
/// A download of a few megabytes arrives in thousands of chunks; the page gets
/// one event per quarter megabyte, which is finer than any bar can draw, and
/// one when the installer is about to take over, which on Windows is the last
/// thing this process says.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "phase", rename_all = "lowercase")]
pub enum Progress {
    Download { downloaded: u64, total: Option<u64> },
    Install,
}

pub const PROGRESS_EVENT: &str = "ade-update-progress";
const PROGRESS_STEP: u64 = 256 * 1024;

/// How long the download may go without a single byte before it is given up.
///
/// Counted in seconds the process was awake, from the last byte: a slow line
/// that keeps trickling (nine megabytes at 50 kB/s take three minutes) is
/// fine, a line that went dead is not. A minute is longer than the
/// retransmission stalls of a flaky Wi-Fi (tens of seconds) and shorter than
/// what a person will stare at a bar that does not move. Without this a
/// half-dead connection never rejected, and the window had no way out of
/// "downloading".
pub const STALL_AFTER_SECS: u32 = 60;

/// The allowance before the first byte, which is a different wait: a proxy
/// that scans the whole file before forwarding it, or a queue at GitHub, can
/// hold the request for minutes with nothing wrong. Three minutes, then the
/// same way out.
pub const FIRST_BYTE_AFTER_SECS: u32 = 180;

/// How long asking the manifest may take. It is a few hundred bytes: a network
/// that does not answer for a minute will not answer, and without a limit the
/// window stayed on "downloading" with no way out (audit 0.7.7, MEDIO 14). Not
/// the plugin's own timeout, which would also cut a slow download that keeps
/// arriving: that one has its watch below.
pub const CHECK_AFTER: std::time::Duration = std::time::Duration::from_secs(60);

/// `future`, or an error once `limit` has passed without an answer.
async fn within<T>(limit: std::time::Duration, future: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(limit, future)
        .await
        .unwrap_or_else(|_| Err(format!("nessuna risposta dal server degli aggiornamenti per {} secondi", limit.as_secs())))
}

/// Why this build may not install an update, or `None` when it may.
///
/// The installer is the real one, and on Windows NSIS closes every
/// `ade-desktop.exe` before it writes, whatever window started it. So a test
/// build (`ai.nikcli.ade.test`) or a dev build that pressed «Aggiorna e
/// riavvia» closed the user's own ADE, with its sessions, and installed the
/// release over it: an update is for the installed ADE only.
pub(crate) fn install_refused(identifier: &str, dev_build: bool) -> Option<String> {
    if identifier.ends_with(".test") {
        return Some("questa è una build di test: l'aggiornamento si installa solo dall'ADE installata, perché il setup chiuderebbe anche quella".to_string());
    }
    if dev_build {
        return Some("questa è una build di sviluppo: l'aggiornamento si installa solo dall'ADE installata, perché il setup chiuderebbe anche quella".to_string());
    }
    None
}

/// Downloads the newest signed ADE release, installs it and restarts into it.
///
/// Everything happens here rather than through the updater plugin's JavaScript
/// API, so no updater permission is granted to the window: a page in the
/// browser pane cannot trigger an install, and the only thing this command can
/// install is what the fork's manifest, signed with ADE's key, points at.
///
/// On Windows the NSIS installer takes over and closes ADE itself; elsewhere
/// the new bundle is in place when the download returns, and ADE restarts.
#[tauri::command]
pub async fn ade_update_install(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(refusal) = install_refused(&app.config().identifier, cfg!(debug_assertions)) {
        return Err(refusal);
    }
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = within(CHECK_AFTER, async { updater.check().await.map_err(|e| e.to_string()) })
        .await?
        .ok_or_else(|| "nessun aggiornamento installabile per questa piattaforma".to_string())?;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use tauri::Emitter;
    let on_chunk = app.clone();
    let on_finish = app.clone();
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    /*
     * Seconds without a byte, counted by the watch below and zeroed by every
     * chunk. Ticks, not a clock: a laptop that sleeps with its lid closed
     * mid-download stops ticking too, so it wakes with the same count it had,
     * not with ten minutes "elapsed". `started` switches the allowance from
     * the first-byte one to the between-bytes one; `finished` stops the watch
     * the moment the last byte is in. The plugin calls that callback before
     * it verifies the signature and before the installer runs, so neither the
     * verification nor the install is ever timed.
     *
     * Nor could they be: from there on the plugin runs synchronously inside
     * this future (a minisign check of the bytes in memory, then a write to
     * the temp folder and the launch of the setup), and `select!` can only
     * drop a future at a point where it yields. A watch would have to abandon
     * the thread mid-install, which is worse than the wait: the verification
     * is milliseconds, and the write is a few megabytes that an antivirus can
     * slow down but not hold forever.
     */
    let idle = Arc::new(AtomicU32::new(0));
    let started = Arc::new(AtomicBool::new(false));
    let finished = Arc::new(AtomicBool::new(false));
    let (chunk_idle, chunk_started, finish_done) = (idle.clone(), started.clone(), finished.clone());
    let download = update.download_and_install(
        move |chunk, total| {
            downloaded += chunk as u64;
            chunk_idle.store(0, Ordering::Relaxed);
            chunk_started.store(true, Ordering::Relaxed);
            if downloaded / PROGRESS_STEP == reported / PROGRESS_STEP && Some(downloaded) != total {
                return;
            }
            reported = downloaded;
            let _ = on_chunk.emit(PROGRESS_EVENT, Progress::Download { downloaded, total });
        },
        move || {
            finish_done.store(true, Ordering::Relaxed);
            let _ = on_finish.emit(PROGRESS_EVENT, Progress::Install);
        },
    );
    let stalled = async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            if finished.load(Ordering::Relaxed) {
                // Nothing left to watch; the download future ends on its own.
                std::future::pending::<()>().await;
            }
            let waited = idle.fetch_add(1, Ordering::Relaxed) + 1;
            let allowed = if started.load(Ordering::Relaxed) { STALL_AFTER_SECS } else { FIRST_BYTE_AFTER_SECS };
            if waited >= allowed {
                return (waited, started.load(Ordering::Relaxed));
            }
        }
    };
    // Dropping the download future closes its connection: a download given
    // up here cannot finish later and run the installer unasked.
    tokio::select! {
        result = download => result.map_err(|e| e.to_string())?,
        (waited, started) = stalled => {
            return Err(if started {
                format!("nessun dato ricevuto per {waited} secondi")
            } else {
                format!("nessuna risposta dal server per {waited} secondi")
            });
        }
    }
    /*
     * The one-ADE lock (`tray::single_instance`) goes before the new process
     * starts, wherever this is called from: `restart` on the main thread skips
     * `RunEvent::Exit`, where the plugin would let it go, and the updated ADE
     * would find it taken and end. A no-op when the plugin is not on.
     */
    tauri_plugin_single_instance::destroy(&app);
    app.restart()
}

/*
 * The installer of an update that has been installed.
 *
 * The updater plugin writes the downloaded installer into a folder of its own in the user's temp folder, `<app>-<version>-updater-<random>`, and
 * keeps it (`TempDir::keep`): the installer has to outlive this process, which exits right after launching it. Nothing ever removes it, so every
 * update leaves 15-25 MB behind in `%TEMP%`. The new version removes it at its first start: the folders of the updater named for this app, for
 * this version or an older one. A folder for a newer version is an update still on its way, and is never touched.
 */

/// `x.y.z` as numbers, ignoring a pre-release or build suffix; `None` when it is not one.
fn numbers(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    let found = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(found)
}

/// The updater's folders in `temp` that are left from an update to `current` or before: named `<app_name>-<version>-updater-<random>`, a plain
/// folder (not a link) that holds only installer files (`.exe` or `.msi`, as plain files). Anything of another shape is somebody else's.
pub(crate) fn leftover_installers(temp: &std::path::Path, app_name: &str, current: &str) -> Vec<std::path::PathBuf> {
    let Some(current) = numbers(current) else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(temp) else { return Vec::new() };
    let prefix = format!("{app_name}-");
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(rest) = name.strip_prefix(&prefix) else { return false };
            let Some((version, random)) = rest.split_once("-updater-") else { return false };
            if random.is_empty() || !numbers(version).is_some_and(|found| found <= current) {
                return false;
            }
            holds_only_installers(&entry.path())
        })
        .map(|entry| entry.path())
        .collect()
}

fn holds_only_installers(folder: &std::path::Path) -> bool {
    match std::fs::symlink_metadata(folder) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
        _ => return false,
    }
    let Ok(entries) = std::fs::read_dir(folder) else { return false };
    entries.flatten().all(|entry| {
        let is_file = std::fs::symlink_metadata(entry.path()).map(|meta| meta.file_type().is_file()).unwrap_or(false);
        let extension = entry.path().extension().map(|ext| ext.to_string_lossy().to_lowercase());
        is_file && matches!(extension.as_deref(), Some("exe") | Some("msi"))
    })
}

/// Removes them; how many went. One that will not (the setup is still finishing and holds its file) stays for the next start.
pub(crate) fn sweep_installers(temp: &std::path::Path, app_name: &str, current: &str) -> usize {
    leftover_installers(temp, app_name, current).into_iter().filter(|folder| std::fs::remove_dir_all(folder).is_ok()).count()
}

/// At every start, out of the way: the first start of a new version finds the installer that brought it, and later ones find nothing.
pub fn sweep_leftovers(app: &tauri::AppHandle) {
    let info = app.package_info();
    let (name, version) = (info.name.clone(), info.version.to_string());
    std::thread::spawn(move || {
        sweep_installers(&std::env::temp_dir(), &name, &version);
    });
}

#[cfg(test)]
mod tests {

    /* A test or dev build pressing «Aggiorna e riavvia» ran the real NSIS, which closes the installed ADE too. */
    #[test]
    fn a_test_or_dev_build_never_installs_an_update() {
        assert!(super::install_refused("ai.nikcli.ade.test", false).unwrap().contains("build di test"));
        assert!(super::install_refused("ai.nikcli.ade.test", true).is_some());
        assert!(super::install_refused("ai.nikcli.ade", true).unwrap().contains("build di sviluppo"));
        assert_eq!(super::install_refused("ai.nikcli.ade", false), None);
        // Refused before the updater is even asked: nothing is downloaded, nothing is run.
        let source = include_str!("update.rs");
        let guard = source.find(&["install_refused(&app.", "config().identifier"].concat()).expect("la guardia manca");
        let updater = source.find(&["app.", "updater()"].concat()).expect("nessun updater");
        assert!(guard < updater, "la guardia va prima dell'updater");
    }

    /* G11 review, BASSO 1. */
    #[test]
    fn the_one_ade_lock_is_released_before_the_restart() {
        let source = include_str!("update.rs");
        // Split, so this test's own text is not what is found.
        let destroy = source.find(&["tauri_plugin_single_instance::", "destroy(&app);"].concat()).expect("il lock non viene rilasciato");
        let restart = source.find(&["app.", "restart()"].concat()).expect("nessun riavvio");
        assert!(destroy < restart, "il lock va rilasciato prima del riavvio");
    }
    #[test]
    fn a_check_that_never_answers_ends_in_an_error() {
        let limit = std::time::Duration::from_millis(50);
        let never = super::within::<()>(limit, std::future::pending());
        let answer = tauri::async_runtime::block_on(never);
        assert!(answer.unwrap_err().starts_with("nessuna risposta dal server degli aggiornamenti"));
        let quick = tauri::async_runtime::block_on(super::within(limit, async { Ok::<_, String>(7) }));
        assert_eq!(quick, Ok(7));
    }

    /// The plugin reads this section when ADE starts: a key or endpoint it
    /// cannot parse stops every installed copy from opening, not just from
    /// updating.
    #[test]
    fn the_updater_section_of_the_config_parses() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).expect("plugins.updater");
        assert_eq!(updater.endpoints.len(), 1);
        assert!(updater.endpoints[0].as_str().starts_with("https://github.com/SandroHub013/nikcli/releases/"));
        assert!(!updater.pubkey.is_empty());
    }

    // ----- the installer an update leaves in the temp folder -----

    fn temp_with(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ade-update-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// What the updater leaves: the folder, with the installer in it.
    fn left(temp: &std::path::Path, folder: &str, file: &str) -> std::path::PathBuf {
        let dir = temp.join(folder);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(file), vec![1u8; 64]).unwrap();
        dir
    }

    #[test]
    fn the_installer_that_brought_this_version_and_the_ones_before_it_are_removed() {
        let temp = temp_with("sweep");
        let this = left(&temp, "ADE-0.9.2-updater-AbC123", "ADE-0.9.2-installer.exe");
        let older = left(&temp, "ADE-0.9.1-updater-Zz9", "ADE-0.9.1-installer.exe");
        let oldest = left(&temp, "ADE-0.8.10-updater-q1w2e3", "ADE-0.8.10-installer.exe");
        assert_eq!(super::sweep_installers(&temp, "ADE", "0.9.2"), 3);
        assert!(!this.exists() && !older.exists() && !oldest.exists());
        // The temp folder itself stays, and a second start finds nothing.
        assert!(temp.exists());
        assert_eq!(super::sweep_installers(&temp, "ADE", "0.9.2"), 0);
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn the_folder_of_a_newer_update_is_an_update_on_its_way_and_stays() {
        let temp = temp_with("newer");
        let coming = left(&temp, "ADE-0.9.3-updater-AbC123", "ADE-0.9.3-installer.exe");
        let later = left(&temp, "ADE-1.0.0-updater-x", "ADE-1.0.0-installer.exe");
        let tenth = left(&temp, "ADE-0.10.0-updater-y", "ADE-0.10.0-installer.exe");
        assert_eq!(super::sweep_installers(&temp, "ADE", "0.9.2"), 0);
        assert!(coming.exists() && later.exists() && tenth.exists());
        // Versions are numbers: 0.10.0 is after 0.9.2, and before 0.10.1; 1.0.0 is after both.
        assert_eq!(super::sweep_installers(&temp, "ADE", "0.10.1"), 2);
        assert!(later.exists());
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn only_this_apps_folders_are_taken_not_another_apps_nor_another_shape() {
        let temp = temp_with("shape");
        let other_app = left(&temp, "ADE Test-0.9.1-updater-AbC", "ADE Test-0.9.1-installer.exe");
        let other_name = left(&temp, "Other-0.9.1-updater-AbC", "Other-0.9.1-installer.exe");
        let not_updater = left(&temp, "ADE-0.9.1-notes", "a.exe");
        let no_random = left(&temp, "ADE-0.9.1-updater-", "ADE-0.9.1-installer.exe");
        let no_version = left(&temp, "ADE-latest-updater-AbC", "ADE-latest-installer.exe");
        let a_file = temp.join("ADE-0.9.1-updater-file");
        std::fs::write(&a_file, "x").unwrap();
        assert_eq!(super::sweep_installers(&temp, "ADE", "0.9.2"), 0);
        for kept in [&other_app, &other_name, &not_updater, &no_random, &no_version, &a_file] {
            assert!(kept.exists(), "{} was removed", kept.display());
        }
        // The test build takes its own.
        assert_eq!(super::sweep_installers(&temp, "ADE Test", "0.9.2"), 1);
        assert!(!other_app.exists());
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn a_folder_that_holds_anything_but_installer_files_is_not_ours() {
        let temp = temp_with("contents");
        let mixed = left(&temp, "ADE-0.9.1-updater-AbC", "ADE-0.9.1-installer.exe");
        std::fs::write(mixed.join("notes.txt"), "mine").unwrap();
        let nested = left(&temp, "ADE-0.9.1-updater-Def", "ADE-0.9.1-installer.exe");
        std::fs::create_dir_all(nested.join("sub")).unwrap();
        let msi = left(&temp, "ADE-0.9.1-updater-Ghi", "ADE-0.9.1-installer.msi");
        let empty = temp.join("ADE-0.9.1-updater-Jkl");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(super::sweep_installers(&temp, "ADE", "0.9.2"), 2);
        assert!(mixed.exists() && nested.exists());
        assert!(!msi.exists() && !empty.exists());
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn a_version_that_is_not_numbers_removes_nothing() {
        let temp = temp_with("version");
        let there = left(&temp, "ADE-0.9.1-updater-AbC", "ADE-0.9.1-installer.exe");
        for current in ["", "dev", "0.9", "1.2.3.4", "a.b.c"] {
            assert_eq!(super::sweep_installers(&temp, "ADE", current), 0, "{current:?}");
        }
        assert!(there.exists());
        // A pre-release or build suffix on the running version counts for its numbers.
        assert_eq!(super::sweep_installers(&temp, "ADE", "0.9.1-beta.2"), 1);
        assert_eq!(super::sweep_installers(&temp.join("manca"), "ADE", "0.9.1"), 0);
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn the_sweep_runs_at_every_start_out_of_the_way() {
        let source = include_str!("lib.rs");
        let setup = &source[source.find(".setup(|app| {").unwrap()..];
        let setup = &setup[..setup.find("open_main_window(app.handle())").unwrap()];
        assert!(setup.contains("update::sweep_leftovers(app.handle())"));
    }
}
