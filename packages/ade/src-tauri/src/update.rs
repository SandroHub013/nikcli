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
    use tauri::Emitter;
    let on_chunk = app.clone();
    let on_finish = app.clone();
    let mut downloaded: u64 = 0;
    let mut reported: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                if downloaded / PROGRESS_STEP == reported / PROGRESS_STEP && Some(downloaded) != total {
                    return;
                }
                reported = downloaded;
                let _ = on_chunk.emit(PROGRESS_EVENT, Progress::Download { downloaded, total });
            },
            move || {
                let _ = on_finish.emit(PROGRESS_EVENT, Progress::Install);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
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
