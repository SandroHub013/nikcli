use std::collections::HashSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Discards any path inside `node_modules`.
///
/// Tauri and npm/bun scripts prepend project and monorepo `node_modules/.bin` to `PATH`.
/// On Windows with Bun's hoisted linker (`bun install --linker hoisted`), `node_modules/.bin`
/// contains broken `.exe`/`.bunx` shims that fail to remap to their targets:
/// `bun: error: could not create process / Bun failed to remap this bin to its proper location within node_modules`.
/// We discard any `node_modules` directory so we find the real global bun toolchain binary.
pub fn is_node_modules(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| s.eq_ignore_ascii_case("node_modules"))
            .unwrap_or(false)
    })
}

#[cfg(windows)]
fn normalize_msys_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if s.len() >= 3 && s.starts_with('/') && s.as_bytes()[2] == b'/' {
        let drive = s.as_bytes()[1] as char;
        if drive.is_ascii_alphabetic() {
            let rest = &s[2..];
            return PathBuf::from(format!("{drive}:{rest}"));
        }
    }
    p.to_path_buf()
}

/// Discovers candidate paths for the real `bun` executable without mutating environment variables.
///
/// Pure function accepting environment parameters explicitly so tests can run in parallel
/// without race conditions on `PATH` or `set_var`.
pub fn find_bun_candidates(
    path: Option<&OsStr>,
    bun_bin: Option<&OsStr>,
    bun_install: Option<&OsStr>,
    home: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    // 1. Explicit override if set by workflow or caller.
    if let Some(bin) = bun_bin {
        let mut p = PathBuf::from(bin);
        #[cfg(windows)]
        {
            p = normalize_msys_path(&p);
        }
        if !is_node_modules(&p) {
            if p.is_file() {
                candidates.push(p);
            } else {
                #[cfg(windows)]
                {
                    for ext in [".exe", ".cmd"] {
                        let with_ext = PathBuf::from(format!("{}{}", p.display(), ext));
                        if with_ext.is_file() {
                            candidates.push(with_ext);
                        }
                    }
                }
            }
        }
    }

    // 2. Scan `PATH`, skipping any directory inside `node_modules`.
    if let Some(path_var) = path {
        for dir in std::env::split_paths(path_var) {
            if is_node_modules(&dir) {
                continue;
            }
            for name in ["bun.exe", "bun.cmd", "bun"] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    candidates.push(candidate);
                }
            }
        }
    }

    // 3. Known global installation locations if PATH only had node_modules shims.
    if let Some(install) = bun_install {
        let bin_dir = PathBuf::from(install).join("bin");
        if !is_node_modules(&bin_dir) {
            for name in ["bun.exe", "bun"] {
                let candidate = bin_dir.join(name);
                if candidate.is_file() {
                    candidates.push(candidate);
                }
            }
        }
    }
    if let Some(home_dir) = home {
        let bin_dir = PathBuf::from(home_dir).join(".bun").join("bin");
        if !is_node_modules(&bin_dir) {
            for name in ["bun.exe", "bun"] {
                let candidate = bin_dir.join(name);
                if candidate.is_file() {
                    candidates.push(candidate);
                }
            }
        }
    }

    // Deduplicate while preserving order.
    let mut seen = HashSet::new();
    candidates.retain(|c| seen.insert(c.clone()));

    // 4. Fallback to bare names if no candidate was found on disk.
    if candidates.is_empty() {
        for name in ["bun", "bun.cmd", "bun.exe"] {
            candidates.push(PathBuf::from(name));
        }
    }

    candidates
}

/// Convenience wrapper for callers reading the current process environment (e.g. `build.rs`).
#[allow(dead_code)]
pub fn find_bun_candidates_from_env() -> Vec<PathBuf> {
    find_bun_candidates(
        std::env::var_os("PATH").as_deref(),
        std::env::var_os("BUN_BIN").as_deref(),
        std::env::var_os("BUN_INSTALL").as_deref(),
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_node_modules_identifies_node_modules_dirs() {
        assert!(is_node_modules(Path::new("node_modules/.bin")));
        assert!(is_node_modules(Path::new("packages/ade/node_modules/.bin")));
        assert!(is_node_modules(Path::new(r"C:\repo\packages\ade\node_modules\.bin")));
        assert!(is_node_modules(Path::new(r"D:\a\ragu\ragu\node_modules\.bin")));
        assert!(!is_node_modules(Path::new(r"C:\Users\runneradmin\.bun\bin")));
        assert!(!is_node_modules(Path::new("/usr/local/bin")));
        assert!(!is_node_modules(Path::new("~/.bun/bin")));
    }

    #[test]
    fn find_bun_candidates_pure_skips_broken_node_modules_shim() {
        let temp = std::env::temp_dir().join(format!("ade-test-bun-lookup-{}", std::process::id()));
        let node_modules_bin = temp.join("packages").join("ade").join("node_modules").join(".bin");
        let real_bun_dir = temp.join(".bun").join("bin");
        let _ = std::fs::create_dir_all(&node_modules_bin);
        let _ = std::fs::create_dir_all(&real_bun_dir);

        #[cfg(windows)]
        let (shim_name, real_name) = ("bun.exe", "bun.exe");
        #[cfg(not(windows))]
        let (shim_name, real_name) = ("bun", "bun");

        let fake_shim = node_modules_bin.join(shim_name);
        let real_bun = real_bun_dir.join(real_name);
        let _ = std::fs::write(&fake_shim, b"fake broken shim");
        let _ = std::fs::write(&real_bun, b"real bun binary");

        let fake_path = std::env::join_paths([&node_modules_bin, &real_bun_dir]).expect("join_paths");

        // Pure call: no std::env::set_var!
        let candidates = find_bun_candidates(Some(fake_path.as_os_str()), None, None, None);

        let _ = std::fs::remove_dir_all(&temp);

        assert!(!candidates.contains(&fake_shim), "candidates should not contain node_modules shim: {:?}", candidates);
        assert!(candidates.contains(&real_bun), "candidates should contain real bun: {:?}", candidates);
    }

    #[test]
    fn find_bun_candidates_bun_bin_override() {
        let temp = std::env::temp_dir().join(format!("ade-test-bun-bin-{}", std::process::id()));
        let custom_bin = temp.join("custom").join("bin");
        let _ = std::fs::create_dir_all(&custom_bin);

        #[cfg(windows)]
        let bin_name = "bun.exe";
        #[cfg(not(windows))]
        let bin_name = "bun";

        let custom_file = custom_bin.join(bin_name);
        let _ = std::fs::write(&custom_file, b"custom bun");

        let candidates = find_bun_candidates(None, Some(custom_file.as_os_str()), None, None);
        let _ = std::fs::remove_dir_all(&temp);

        assert_eq!(candidates.first(), Some(&custom_file));
    }

    #[test]
    fn find_bun_candidates_bun_bin_ignores_node_modules() {
        let temp = std::env::temp_dir().join(format!("ade-test-bun-nm-{}", std::process::id()));
        let nm_bin = temp.join("node_modules").join(".bin");
        let _ = std::fs::create_dir_all(&nm_bin);

        #[cfg(windows)]
        let bin_name = "bun.exe";
        #[cfg(not(windows))]
        let bin_name = "bun";

        let nm_file = nm_bin.join(bin_name);
        let _ = std::fs::write(&nm_file, b"nm bun");

        let candidates = find_bun_candidates(None, Some(nm_file.as_os_str()), None, None);
        let _ = std::fs::remove_dir_all(&temp);

        assert!(!candidates.contains(&nm_file));
    }
}
