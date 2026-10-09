//! «Mostra nella cartella»: the system's file manager, opened on the folder of
//! a file with the file selected.
//!
//! The binary file pane offers it for the files ADE has no viewer for (an
//! APK, an executable). The file itself is never opened or run: Explorer is
//! asked to select it, not to launch it.
//!
//! A network path is refused before anything starts: Explorer would reach the
//! server named in it, and a page that can call this command could otherwise
//! make the machine knock on any host it likes.

use std::path::Path;

/// What to launch: a program and its arguments, each passed as written.
#[derive(Debug, PartialEq)]
pub struct Reveal {
    pub program: &'static str,
    pub args: Vec<String>,
}

/// The launch that shows `path` selected in its folder, or why not.
pub fn plan(path: &str) -> Result<Reveal, String> {
    crate::refuse_network_path(path)?;
    // Explorer's argument is the path between quotes; one inside it would end it early.
    if path.contains('"') {
        return Err(format!("percorso non valido: {path}"));
    }
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(format!("percorso non assoluto: {path}"));
    }
    let meta = std::fs::metadata(target).map_err(|e| format!("{path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("non è un file: {path}"));
    }
    Ok(native(path, target))
}

#[cfg(windows)]
fn native(path: &str, _target: &Path) -> Reveal {
    Reveal {
        program: "explorer.exe",
        args: vec![format!("/select,\"{}\"", path.replace('/', "\\"))],
    }
}

#[cfg(target_os = "macos")]
fn native(path: &str, _target: &Path) -> Reveal {
    Reveal {
        program: "open",
        args: vec!["-R".into(), path.into()],
    }
}

/// No file manager on Linux takes a file to select, so the folder opens.
#[cfg(all(unix, not(target_os = "macos")))]
fn native(_path: &str, target: &Path) -> Reveal {
    let folder = target.parent().unwrap_or(target);
    Reveal {
        program: "xdg-open",
        args: vec![folder.to_string_lossy().into_owned()],
    }
}

/// Shows the file selected in the system's file manager.
#[tauri::command]
pub async fn reveal_in_folder(path: String) -> Result<(), String> {
    let reveal = plan(&path)?;
    let mut command = std::process::Command::new(reveal.program);
    /*
     * As written, not re-quoted: Rust would put quotes around the whole
     * `/select,"…"` argument because of the spaces, and Explorer then opens
     * the Documents folder instead of the file's.
     */
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for arg in &reveal.args {
            command.raw_arg(arg);
        }
    }
    #[cfg(not(windows))]
    command.args(&reveal.args);
    let mut child = command
        .spawn()
        .map_err(|e| format!("{}: {e}", reveal.program))?;
    // Explorer hands the window to the running shell and exits; waited on so it leaves nothing behind.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::UNIX_EPOCH;

    fn temp(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{tag}-{nanos}"));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    #[test]
    fn a_file_is_shown_selected_in_its_folder() {
        let dir = temp("reveal");
        let file = dir.join("Fabioland 0.1.1.apk");
        std::fs::write(&file, b"PK").expect("write");
        let path = file.to_string_lossy().replace('\\', "/");

        let reveal = plan(&path).expect("a local file is revealed");
        if cfg!(windows) {
            assert_eq!(reveal.program, "explorer.exe");
            // Explorer reads `/select,` and a quoted path with backslashes, and nothing else.
            let native = file.to_string_lossy().replace('/', "\\");
            assert_eq!(reveal.args, vec![format!("/select,\"{native}\"")]);
        } else if cfg!(target_os = "macos") {
            assert_eq!(reveal.program, "open");
            assert_eq!(reveal.args, vec!["-R".to_string(), path.clone()]);
        } else {
            assert_eq!(reveal.program, "xdg-open");
            assert_eq!(reveal.args, vec![dir.to_string_lossy().into_owned()]);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_but_an_existing_local_file_is_revealed() {
        let dir = temp("revealno");
        let here = dir.to_string_lossy().into_owned();
        // A network path: Explorer would contact the server.
        assert!(plan(r"\\server\share\app.apk").is_err_and(|e| e.contains("percorso di rete")));
        assert!(plan("//server/share/app.apk").is_err_and(|e| e.contains("percorso di rete")));
        // Missing, a folder, relative, or a quote that would end Explorer's argument early.
        assert!(plan(&format!("{here}/missing.apk")).is_err());
        assert!(plan(&here).is_err());
        assert!(plan("app.apk").is_err());
        assert!(plan(&format!("{here}/a\".apk")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
