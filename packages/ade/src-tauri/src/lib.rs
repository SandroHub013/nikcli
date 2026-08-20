/// ADE's desktop shell.
///
/// Deliberately thin: the product is the web bundle, so this crate opens the
/// window declared in tauri.conf.json and adds exactly one command of its own.
/// The main desktop app carries a sidecar server, deep links and an updater;
/// ADE ships with none of them, and inheriting them would tie its lifecycle to
/// a product it does not release with.
///
/// Where WebView2 cannot write its profile under %LOCALAPPDATA% — a locked-down
/// machine, or a sandboxed parent — set WEBVIEW2_USER_DATA_FOLDER before launch.
/// WebView2 reads that itself, so nothing here needs to know about it.
use std::path::Path;

/// Points `link` at `target`, so an isolated worktree can reach the project's
/// installed dependencies without a copy.
///
/// This exists as its own command rather than as a shell call because the shell
/// allowlist names seven agent binaries and git, on purpose: adding `cmd` so it
/// could run `mklink` would hand every page in this window arbitrary execution,
/// which is a far larger grant than "make one directory point at another".
///
/// Windows uses a junction: unlike a symlink it needs no elevation, and unlike
/// a copy it costs no disk. Elsewhere a directory symlink does the same job.
#[tauri::command]
fn link_directory(link: String, target: String) -> Result<(), String> {
    let link_path = Path::new(&link);
    let target_path = Path::new(&target);

    if !target_path.exists() {
        return Err(format!("sorgente inesistente: {target}"));
    }
    // Already linked from an earlier session: nothing to do, and re-creating it
    // would fail on a path that is already correct.
    if link_path.exists() {
        return Ok(());
    }
    if let Some(parent) = link_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    #[cfg(windows)]
    {
        junction::create(target_path, link_path).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        std::os::unix::fs::symlink(target_path, link_path).map_err(|e| e.to_string())
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![link_directory])
        .run(tauri::generate_context!())
        .expect("error while running ADE");
}
