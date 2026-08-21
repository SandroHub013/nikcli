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
use serde::Serialize;
use std::time::UNIX_EPOCH;

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

// ---------------------------------------------------------------------------
// Filesystem commands — let the frontend read the disk without shelling out
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified_ms: f64,
}

/// Lists the contents of `path`, directories first, then files, both sorted
/// alphabetically (case-insensitive). Entries the OS refuses to stat are
/// silently skipped instead of aborting the whole listing.
#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))?;
    let mut dirs: Vec<DirEntry> = Vec::new();
    let mut files: Vec<DirEntry> = Vec::new();

    for entry in rd {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        let full = entry.path().to_string_lossy().into_owned();
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs_f64() * 1000.0)
            .unwrap_or(0.0);
        let de = DirEntry {
            name,
            path: full,
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified_ms,
        };
        if meta.is_dir() {
            dirs.push(de);
        } else {
            files.push(de);
        }
    }

    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    dirs.append(&mut files);
    Ok(dirs)
}

#[derive(Serialize, Clone)]
struct FileRead {
    text: String,
    truncated: bool,
    bytes: usize,
}

/// Reads up to `max_bytes` of a text file. Returns an explicit error for
/// binary content so the frontend can tell the user instead of showing
/// mojibake.
#[tauri::command]
fn read_text_file(path: String, max_bytes: usize) -> Result<FileRead, String> {
    let data = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    let total = data.len();
    let truncated = total > max_bytes;
    let slice = if truncated { &data[..max_bytes] } else { &data[..] };
    let text = String::from_utf8(slice.to_vec())
        .map_err(|_| "file binario".to_string())?;
    Ok(FileRead { text, truncated, bytes: total })
}

/// Writes `contents` to `path` atomically. Refuses to write if the path is a
/// directory. Creates any missing parent directories. Writes first to a sibling
/// temporary file and then renames it over the target to prevent partial writes
/// on interrupted saves.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let target = Path::new(&path);
    if target.is_dir() {
        return Err(format!("il percorso è una directory: {path}"));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{path}: {e}"))?;
        }
    }

    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_else(|| "file".into());
    let now_nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp_name = format!(".{file_name}.tmp_{}_{now_nanos}", std::process::id());
    let temp_path = parent.join(temp_name);

    if let Err(e) = std::fs::write(&temp_path, contents.as_bytes()) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("{path}: {e}"));
    }

    if let Err(e) = std::fs::rename(&temp_path, target) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(format!("{path}: {e}"));
    }

    Ok(())
}

#[tauri::command]
fn current_dir() -> Result<String, String> {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "impossibile determinare la home".to_string())
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            link_directory,
            read_dir,
            read_text_file,
            write_text_file,
            current_dir,
            home_dir,
            path_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running ADE");
}
