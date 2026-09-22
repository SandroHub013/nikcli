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
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
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
    app.restart()
}

#[cfg(test)]
mod tests {
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
}
