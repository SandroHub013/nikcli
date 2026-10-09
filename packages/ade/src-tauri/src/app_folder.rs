//! nikcli became ragu, and a user's folders and config files keep their old
//! names until `ragu migrate` moves them. Rule B, as the CLI applies it
//! (`packages/util/src/app-folder.ts`): the ragu one if it exists, else the
//! nikcli one, and never a copy. With neither there yet, the old name, where a
//! CLI of before the rename and this one both look.
//!
//! Readers ask here; guards that protect ragu's configuration know both names
//! (`STEMS`, `DOT_FOLDERS`).

use std::path::{Path, PathBuf};

/// A platform folder's names, the new one first.
pub(crate) const STEMS: [&str; 2] = ["ragu", "nikcli"];
/// The home's and a project's own folder, the new one first.
pub(crate) const DOT_FOLDERS: [&str; 2] = [".ragu", ".nikcli"];

fn first(base: &Path, names: &[&str]) -> PathBuf {
    names
        .iter()
        .map(|name| base.join(name))
        .find(|path| path.exists())
        .unwrap_or_else(|| base.join(names[names.len() - 1]))
}

/// `<base>/ragu` or `<base>/nikcli`: a platform folder (APPDATA, XDG, LOCALAPPDATA).
pub(crate) fn app_folder(base: &Path) -> PathBuf {
    first(base, &STEMS)
}

/// `<dir>/ragu.json` when `ragu.json` or `ragu.jsonc` is there, else `<dir>/nikcli.json`.
pub(crate) fn config_file(dir: &Path) -> PathBuf {
    let stem = if dir.join("ragu.jsonc").exists() || dir.join("ragu.json").exists() { "ragu" } else { "nikcli" };
    dir.join(format!("{stem}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ade-app-folder-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("scratch");
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_ragu_folder_when_it_exists_else_the_nikcli_one_else_the_old_name() {
        let base = Scratch::new("pick");
        assert_eq!(app_folder(&base.0), base.0.join("nikcli"));
        fs::create_dir_all(base.0.join("nikcli")).unwrap();
        assert_eq!(app_folder(&base.0), base.0.join("nikcli"));
        fs::create_dir_all(base.0.join("ragu")).unwrap();
        assert_eq!(app_folder(&base.0), base.0.join("ragu"));
        // Nothing is copied or moved: both folders are as they were.
        assert!(base.0.join("nikcli").is_dir() && base.0.join("ragu").is_dir());
    }

    #[test]
    fn the_config_file_is_ragu_json_only_when_one_is_there() {
        let dir = Scratch::new("config");
        assert_eq!(config_file(&dir.0), dir.0.join("nikcli.json"));
        fs::write(dir.0.join("nikcli.json"), "{}").unwrap();
        assert_eq!(config_file(&dir.0), dir.0.join("nikcli.json"));
        fs::write(dir.0.join("ragu.jsonc"), "{}").unwrap();
        assert_eq!(config_file(&dir.0), dir.0.join("ragu.json"));
    }

    #[test]
    fn both_lists_put_the_new_name_first() {
        assert_eq!(STEMS, ["ragu", "nikcli"]);
        assert_eq!(DOT_FOLDERS, [".ragu", ".nikcli"]);
    }
}
