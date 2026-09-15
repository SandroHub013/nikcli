//! Reading a project file as bytes, for the panels that draw one.
//!
//! The 3D panel parses a `.glb`, an `.stl`, the textures a `.gltf` names — all
//! binary, none of them something `read_text_file` can hand over. The
//! `ade-media` scheme serves bytes, but in capped ranges for a media element
//! and to an origin a `fetch` from the window is not allowed to read; a model
//! is parsed whole, so it is read whole here instead.
//!
//! Confined to the roots the window has opened, like every write: anything
//! running in the browser pane can call a command, and one that read an
//! arbitrary path would read the user's whole disk.

use std::io::Read;

use crate::{within_roots, WriteRoots};

/// The file's bytes, refused when it is outside every open project or larger
/// than `max_bytes`.
///
/// Returned as a raw IPC response rather than a `Vec<u8>`: serialised as JSON,
/// a 40 MB scene becomes an array of forty million numbers.
#[tauri::command]
pub async fn read_project_bytes(
    roots: tauri::State<'_, WriteRoots>,
    path: String,
    max_bytes: u64,
) -> Result<tauri::ipc::Response, String> {
    read_confined(&roots, &path, max_bytes).map(tauri::ipc::Response::new)
}

fn read_confined(roots: &WriteRoots, path: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let resolved = within_roots(roots, path)?;
    let file = std::fs::File::open(&resolved).map_err(|e| format!("{path}: {e}"))?;
    let meta = file.metadata().map_err(|e| format!("{path}: {e}"))?;
    if meta.is_dir() {
        return Err(format!("il percorso è una directory: {path}"));
    }
    if meta.len() > max_bytes {
        return Err(format!(
            "file troppo grande: {} MB, il limite è {} MB",
            meta.len() / (1024 * 1024),
            max_bytes / (1024 * 1024)
        ));
    }
    let mut data = Vec::with_capacity(meta.len() as usize);
    // Capped again while reading: the file can grow between the stat and the read.
    file.take(max_bytes)
        .read_to_end(&mut data)
        .map_err(|e| format!("{path}: {e}"))?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("test-tmp")
                .join(format!("bytes-{tag}-{nanos}"));
            std::fs::create_dir_all(&path).expect("temp dir");
            TempDir(path)
        }

        fn roots(&self) -> WriteRoots {
            let roots = WriteRoots::default();
            roots.0.lock().unwrap().push(self.0.canonicalize().expect("canonical"));
            roots
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_a_binary_file_inside_the_project() {
        let dir = TempDir::new("inside");
        let file = dir.0.join("cube.glb");
        std::fs::write(&file, [0x67u8, 0x6c, 0x54, 0x46, 0x00, 0xff]).unwrap();
        let bytes = read_confined(&dir.roots(), &file.to_string_lossy(), 1024).expect("readable");
        assert_eq!(bytes, vec![0x67, 0x6c, 0x54, 0x46, 0x00, 0xff]);
    }

    #[test]
    fn refuses_a_file_outside_every_project() {
        let project = TempDir::new("project");
        let other = TempDir::new("other");
        let file = other.0.join("secret.bin");
        std::fs::write(&file, b"x").unwrap();
        assert!(read_confined(&project.roots(), &file.to_string_lossy(), 1024).is_err());
    }

    #[test]
    fn refuses_a_file_over_the_limit_with_its_size() {
        let dir = TempDir::new("big");
        let file = dir.0.join("big.stl");
        std::fs::write(&file, vec![0u8; 4096]).unwrap();
        let error = read_confined(&dir.roots(), &file.to_string_lossy(), 1024).unwrap_err();
        assert!(error.contains("troppo grande"));
    }
}
