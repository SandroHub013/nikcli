//! What ADE takes off the computer when it is uninstalled, run by the installer's PREUNINSTALL hook (`windows/hooks.nsh`) as the app's own
//! executable with one flag, before anything of the app starts: no window, no second instance forwarded to a running one, no network.
//!
//! - `--unlink-agents`: ADE's hooks and plugin out of Claude Code, Codex and nikcli (`agent_link::unlink_all`), only for the released
//!   identity (`unlink_allowed`): they are global, and a build of another identity must not strip the installed ADE of them;
//! - `--clean-caches`: what the app downloaded and can download again, out of its local data folder (below);
//! - `--delete-secrets`: the API keys and the bots' tokens out of the system keychain; the hook runs it only when the user ticked «elimina
//!   i dati».
//!
//! The hook runs none of them on an update (`/UPDATE`): an update is not a removal, and the new version needs its hooks, its voices and its keys.
//! Each flag does its own part and reports by its exit code (0 done, 1 something could not be); the installer goes on whatever it is.

use crate::agent_link;
use std::path::{Path, PathBuf};

/// The identity of the released app: the only one whose uninstall touches the hooks of other programs.
pub const RELEASE_IDENTIFIER: &str = "ai.nikcli.ade";

/// The variable a test build is given by the CI job that proves the uninstaller (`.github/workflows/ade-uninstall-check.yml`), to take the hooks of
/// a home that is the runner's. A release build never needs it.
pub const UNLINK_FOR_TEST_VAR: &str = "ADE_UNLINK_AGENTS_FOR_TEST";

/// Whether this build may take ADE out of the other programs. The hooks and the plugin are global: one script name, one path, for every ADE on
/// the computer. Only the released app (`ai.nikcli.ade`) removes them, so uninstalling ADE Test or a build of someone's own does not strip the
/// installed ADE of its hooks. A build that is not the release does it only when the proving job says so, and says so out loud.
pub fn unlink_allowed(identifier: &str, test_override: Option<&str>) -> bool {
    identifier == RELEASE_IDENTIFIER || test_override == Some("1")
}

/// The one place the flags are read: `Some(exit code)` when `args` is one of them, and then nothing of the app should start.
pub fn dispatch(args: &[String], identifier: &str) -> Option<i32> {
    let [flag] = args else { return None };
    match flag.as_str() {
        "--unlink-agents" => Some(if unlink_allowed(identifier, std::env::var(UNLINK_FOR_TEST_VAR).ok().as_deref()) {
            agent_link::unlink_from_env()
        } else {
            eprintln!("ADE: {identifier} non è l'app rilasciata: gli hook degli altri programmi restano");
            0
        }),
        "--clean-caches" => Some(with_dirs(identifier, |dirs| {
            let cleaned = clean_caches(&dirs.local);
            for failed in &cleaned.failed {
                eprintln!("ADE: non riesco a togliere {}", failed.display());
            }
            i32::from(!cleaned.failed.is_empty())
        })),
        "--delete-secrets" => Some(with_dirs(identifier, |dirs| crate::secrets::forget_all(identifier, &dirs.config, &dirs.data))),
        _ => None,
    }
}

fn with_dirs(identifier: &str, run: impl FnOnce(&AppDirs) -> i32) -> i32 {
    match AppDirs::from_env(identifier) {
        Some(dirs) => run(&dirs),
        None => {
            eprintln!("ADE: cartelle dell'app non trovate");
            1
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Platform {
    Windows,
    Mac,
    Linux,
}

impl Platform {
    pub fn current() -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Mac
        } else {
            Platform::Linux
        }
    }
}

/// The variables the folders come from, as arguments so each platform is tested on any.
#[derive(Default, Clone)]
pub struct Env {
    pub appdata: Option<String>,
    pub localappdata: Option<String>,
    pub xdg_config: Option<String>,
    pub xdg_data: Option<String>,
    pub home: Option<PathBuf>,
}

/// The folders Tauri gives the app (`app_config_dir`, `app_data_dir`, `app_local_data_dir`), worked out without an app running: this runs
/// before one starts.
#[derive(Debug, PartialEq)]
pub struct AppDirs {
    pub config: PathBuf,
    pub data: PathBuf,
    pub local: PathBuf,
}

impl AppDirs {
    pub fn new(platform: Platform, identifier: &str, env: &Env) -> Option<AppDirs> {
        // An identifier that is not one plain name would make these paths something else.
        if identifier.is_empty() || identifier.contains(['/', '\\', ':']) || identifier == "." || identifier == ".." {
            return None;
        }
        let set = |value: &Option<String>| value.as_ref().filter(|value| !value.trim().is_empty()).map(PathBuf::from);
        let home = env.home.clone();
        let (config, data, local) = match platform {
            Platform::Windows => {
                let roaming = set(&env.appdata).or_else(|| home.as_ref().map(|home| home.join("AppData").join("Roaming")))?;
                let local = set(&env.localappdata).or_else(|| home.as_ref().map(|home| home.join("AppData").join("Local")))?;
                (roaming.clone(), roaming, local)
            }
            Platform::Mac => {
                let support = home.as_ref()?.join("Library").join("Application Support");
                (support.clone(), support.clone(), support)
            }
            Platform::Linux => {
                let config = set(&env.xdg_config).or_else(|| home.as_ref().map(|home| home.join(".config")))?;
                let data = set(&env.xdg_data).or_else(|| home.as_ref().map(|home| home.join(".local").join("share")))?;
                (config, data.clone(), data)
            }
        };
        Some(AppDirs { config: config.join(identifier), data: data.join(identifier), local: local.join(identifier) })
    }

    pub fn from_env(identifier: &str) -> Option<AppDirs> {
        let env = Env {
            appdata: std::env::var("APPDATA").ok(),
            localappdata: std::env::var("LOCALAPPDATA").ok(),
            xdg_config: std::env::var("XDG_CONFIG_HOME").ok(),
            xdg_data: std::env::var("XDG_DATA_HOME").ok(),
            home: agent_link::dirs_home(),
        };
        AppDirs::new(Platform::current(), identifier, &env)
    }
}

/// The folders of the app's local data that are only downloads and caches, whole.
const WHOLE: [&str; 2] = ["tts", "nikverse-assets"];

/// The file of a plugin's folder that is the user's: what the plugin saved (`plugin_storage.rs`), which reinstalling the plugin finds again.
const PLUGIN_KEPT: &str = "storage.json";

/// The caches of the WebView2 profile (`EBWebView/Default/...`): what Chromium makes again at the next start. Its cookies, its local storage
/// and its IndexedDB are the page's settings, not a cache, and stay.
const WEBVIEW_CACHES: [&[&str]; 9] = [
    &["Default", "Cache"],
    &["Default", "Code Cache"],
    &["Default", "GPUCache"],
    &["Default", "DawnGraphiteCache"],
    &["Default", "DawnWebGPUCache"],
    &["Default", "Service Worker", "CacheStorage"],
    &["Default", "Service Worker", "ScriptCache"],
    &["GrShaderCache"],
    &["ShaderCache"],
];

#[derive(Debug, Default, PartialEq)]
pub struct Cleaned {
    /// What the folders weighed.
    pub freed: u64,
    /// What would not go (a file open in a program that is still running), for the report.
    pub failed: Vec<PathBuf>,
}

/// A plain folder, not a link: what is removed is what is under this name on this disk, and a junction put there is not followed.
fn plain_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).map(|meta| meta.is_dir() && !meta.file_type().is_symlink()).unwrap_or(false)
}

fn remove_whole(path: &Path, done: &mut Cleaned) {
    if !plain_dir(path) {
        return;
    }
    let weight = crate::tts::dir_bytes(path);
    match std::fs::remove_dir_all(path) {
        Ok(()) => done.freed += weight,
        // Partly removed counts for what is gone.
        Err(_) => {
            done.freed += weight.saturating_sub(crate::tts::dir_bytes(path));
            done.failed.push(path.to_path_buf());
        }
    }
}

/// What a plugin's folder holds, but its saved document: the versions, their pointers, whatever else. Then the folder, if nothing is left.
fn clean_plugin(folder: &Path, done: &mut Cleaned) {
    let Ok(entries) = std::fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name() == PLUGIN_KEPT {
            continue;
        }
        if plain_dir(&path) {
            remove_whole(&path, done);
        } else if let Ok(meta) = std::fs::symlink_metadata(&path) {
            let size = meta.len();
            match std::fs::remove_file(&path) {
                Ok(()) => done.freed += size,
                Err(_) => done.failed.push(path),
            }
        }
    }
    // `remove_dir` refuses a folder that is not empty: a folder that kept its document stays.
    let _ = std::fs::remove_dir(folder);
}

/// Takes the downloads and caches out of the app's local data folder: the voices (`tts`), NikVerse's assets, the plugins' files (not what they
/// saved), and the WebView2 caches. Best effort: what will not go is in `failed`, and the rest is done. Nothing else is touched: not the
/// mailbox, the settings, the WebView's cookies and local storage, nor the keychain.
pub fn clean_caches(local: &Path) -> Cleaned {
    let mut done = Cleaned::default();
    if !plain_dir(local) {
        return done;
    }
    for name in WHOLE {
        remove_whole(&local.join(name), &mut done);
    }
    let plugins = local.join("plugins");
    if plain_dir(&plugins) {
        if let Ok(entries) = std::fs::read_dir(&plugins) {
            for entry in entries.flatten() {
                let path = entry.path();
                if plain_dir(&path) {
                    clean_plugin(&path, &mut done);
                } else if let Ok(meta) = std::fs::symlink_metadata(&path) {
                    let size = meta.len();
                    match std::fs::remove_file(&path) {
                        Ok(()) => done.freed += size,
                        Err(_) => done.failed.push(path),
                    }
                }
            }
        }
        let _ = std::fs::remove_dir(&plugins);
    }
    let profile = local.join("EBWebView");
    for cache in WEBVIEW_CACHES {
        remove_whole(&cache.iter().fold(profile.clone(), |path, part| path.join(part)), &mut done);
    }
    done
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ade-uninstall-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(path: &Path, size: usize) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![7u8; size]).unwrap();
    }

    fn args(flags: &[&str]) -> Vec<String> {
        flags.iter().map(|flag| flag.to_string()).collect()
    }

    #[test]
    fn only_the_three_flags_alone_are_the_uninstallers() {
        // A normal start, a deep link, a flag beside another argument: none of them is this.
        assert_eq!(dispatch(&args(&[]), "ai.nikcli.ade"), None);
        assert_eq!(dispatch(&args(&["ade://open?x=1"]), "ai.nikcli.ade"), None);
        assert_eq!(dispatch(&args(&["--unlink-agents", "--clean-caches"]), "ai.nikcli.ade"), None);
        assert_eq!(dispatch(&args(&["--unlink-agents-now"]), "ai.nikcli.ade"), None);
        assert_eq!(dispatch(&args(&["--delete"]), "ai.nikcli.ade"), None);
    }

    #[test]
    fn the_folders_are_the_ones_tauri_gives_the_app_on_each_platform() {
        let env = Env {
            appdata: Some("C:/Users/u/AppData/Roaming".into()),
            localappdata: Some("C:/Users/u/AppData/Local".into()),
            home: Some(PathBuf::from("C:/Users/u")),
            ..Env::default()
        };
        let windows = AppDirs::new(Platform::Windows, "ai.nikcli.ade", &env).unwrap();
        assert_eq!(windows.config, PathBuf::from("C:/Users/u/AppData/Roaming/ai.nikcli.ade"));
        assert_eq!(windows.data, windows.config);
        assert_eq!(windows.local, PathBuf::from("C:/Users/u/AppData/Local/ai.nikcli.ade"));
        // The variables missing: where Windows keeps them by default.
        let bare = Env { home: Some(PathBuf::from("C:/Users/u")), ..Env::default() };
        let windows = AppDirs::new(Platform::Windows, "ai.nikcli.ade.test", &bare).unwrap();
        assert_eq!(windows.local, PathBuf::from("C:/Users/u/AppData/Local/ai.nikcli.ade.test"));

        let unix = Env { home: Some(PathBuf::from("/home/u")), ..Env::default() };
        let linux = AppDirs::new(Platform::Linux, "ai.nikcli.ade", &unix).unwrap();
        assert_eq!(linux.config, PathBuf::from("/home/u/.config/ai.nikcli.ade"));
        assert_eq!(linux.data, PathBuf::from("/home/u/.local/share/ai.nikcli.ade"));
        let xdg = Env { xdg_config: Some("/x/config".into()), xdg_data: Some("/x/data".into()), ..unix.clone() };
        let linux = AppDirs::new(Platform::Linux, "ai.nikcli.ade", &xdg).unwrap();
        assert_eq!((linux.config, linux.local), (PathBuf::from("/x/config/ai.nikcli.ade"), PathBuf::from("/x/data/ai.nikcli.ade")));
        let mac = AppDirs::new(Platform::Mac, "ai.nikcli.ade", &Env { home: Some(PathBuf::from("/Users/u")), ..Env::default() }).unwrap();
        assert_eq!(mac.local, PathBuf::from("/Users/u/Library/Application Support/ai.nikcli.ade"));
    }

    #[test]
    fn an_identifier_that_is_not_one_plain_name_has_no_folders_and_no_home_is_none() {
        let env = Env { home: Some(PathBuf::from("C:/Users/u")), ..Env::default() };
        for bad in ["", ".", "..", "a/b", "a\\b", "C:x"] {
            assert_eq!(AppDirs::new(Platform::Windows, bad, &env), None, "{bad}");
        }
        assert_eq!(AppDirs::new(Platform::Windows, "ai.nikcli.ade", &Env::default()), None);
    }

    /// A local data folder as the app leaves it, with downloads, caches and what is the user's.
    fn lived_in(local: &Path) {
        put(&local.join("tts/piper/piper.exe"), 1000);
        put(&local.join("tts/voices/ugo.onnx"), 600);
        put(&local.join("tts/kokoro/model.onnx"), 400);
        put(&local.join("nikverse-assets/world/city.glb"), 300);
        put(&local.join("plugins/alpha/1.0.0/index.html"), 50);
        put(&local.join("plugins/alpha/current"), 5);
        put(&local.join("plugins/alpha/storage.json"), 20);
        put(&local.join("plugins/beta/1.0.0/index.html"), 70);
        put(&local.join("plugins/index.json"), 9);
        put(&local.join("EBWebView/Default/Cache/Cache_Data/f_1"), 200);
        put(&local.join("EBWebView/Default/Code Cache/js/a"), 100);
        put(&local.join("EBWebView/Default/GPUCache/data_0"), 30);
        put(&local.join("EBWebView/Default/Service Worker/CacheStorage/x"), 11);
        put(&local.join("EBWebView/GrShaderCache/g"), 3);
        // Not caches: the page's own settings, and ADE's.
        put(&local.join("EBWebView/Default/Local Storage/leveldb/000003.log"), 40);
        put(&local.join("EBWebView/Default/IndexedDB/x/data"), 41);
        put(&local.join("EBWebView/Default/Network/Cookies"), 42);
        put(&local.join("agent-sessions/abc.json"), 4);
        put(&local.join("mailbox/m.json"), 4);
    }

    #[test]
    fn the_caches_go_and_what_is_the_users_stays() {
        let local = scratch("caches").join("ai.nikcli.ade");
        lived_in(&local);
        let done = clean_caches(&local);
        assert_eq!(done.failed, Vec::<PathBuf>::new());
        // 1000 + 600 + 400 (voices), 300 (assets), 50 + 5 + 70 + 9 (plugins but one document), 200 + 100 + 30 + 11 + 3 (webview caches).
        assert_eq!(done.freed, 1000 + 600 + 400 + 300 + 50 + 5 + 70 + 9 + 200 + 100 + 30 + 11 + 3);
        assert!(!local.join("tts").exists() && !local.join("nikverse-assets").exists());
        assert!(!local.join("EBWebView/Default/Cache").exists());
        assert!(!local.join("EBWebView/Default/Code Cache").exists());
        assert!(!local.join("EBWebView/Default/GPUCache").exists());
        assert!(!local.join("EBWebView/Default/Service Worker/CacheStorage").exists());
        assert!(!local.join("EBWebView/GrShaderCache").exists());
        assert!(!local.join("plugins/alpha/1.0.0").exists() && !local.join("plugins/beta").exists() && !local.join("plugins/index.json").exists());
        // What a plugin saved is kept with its folder, and a plugin with none leaves no folder.
        assert!(local.join("plugins/alpha/storage.json").exists());
        assert!(!local.join("plugins/alpha/current").exists());
        for kept in [
            "EBWebView/Default/Local Storage/leveldb/000003.log",
            "EBWebView/Default/IndexedDB/x/data",
            "EBWebView/Default/Network/Cookies",
            "agent-sessions/abc.json",
            "mailbox/m.json",
        ] {
            assert!(local.join(kept).exists(), "{kept} was removed");
        }
        let _ = std::fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn a_second_time_there_is_nothing_and_a_folder_that_is_not_there_is_not_made() {
        let local = scratch("caches-twice").join("ai.nikcli.ade");
        lived_in(&local);
        clean_caches(&local);
        assert_eq!(clean_caches(&local), Cleaned::default());
        let missing = scratch("caches-missing").join("ai.nikcli.ade");
        assert_eq!(clean_caches(&missing), Cleaned::default());
        assert!(!missing.exists());
        let _ = std::fs::remove_dir_all(local.parent().unwrap());
        let _ = std::fs::remove_dir_all(missing.parent().unwrap());
    }

    #[test]
    fn a_plugins_folder_with_no_saved_document_goes_whole_with_the_plugins_folder() {
        let local = scratch("caches-plugins").join("ai.nikcli.ade");
        put(&local.join("plugins/beta/1.0.0/index.html"), 70);
        put(&local.join("plugins/beta/pending"), 3);
        clean_caches(&local);
        assert!(!local.join("plugins").exists());
        assert!(local.exists(), "the app's own folder is not the cache's to remove");
        let _ = std::fs::remove_dir_all(local.parent().unwrap());
    }

    #[test]
    fn the_hook_for_the_installer_runs_the_three_flags_and_never_on_an_update() {
        // The hook is read as text: the flags it launches are the ones `dispatch` knows, and the secrets only with the data box ticked.
        let hook = include_str!("../windows/hooks.nsh");
        let body = &hook[hook.find("!macro NSIS_HOOK_PREUNINSTALL").unwrap()..hook.find("!macroend").unwrap()];
        let at = |what: &str| body.find(what).unwrap_or_else(|| panic!("{what} is not in the hook"));
        // The question "ADE is open, close it?" comes first: it can be answered with Cancel, and nothing may be gone by then.
        let first = body.lines().skip(1).map(str::trim).filter(|line| !line.is_empty() && !line.starts_with(';')).collect::<Vec<_>>();
        assert_eq!(first[0], "${If} $UpdateMode <> 1");
        assert_eq!(first[1], r#"!insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}""#);
        assert!(at("CheckIfAppIsRunning") < at("--unlink-agents"));
        assert!(at("$UpdateMode <> 1") < at("--unlink-agents"));
        assert!(at("$UpdateMode <> 1") < at("--clean-caches"));
        assert!(at("$DeleteAppDataCheckboxState = 1") < at("--delete-secrets"));
        assert!(at("--delete-secrets") > at("--unlink-agents"));
        // Each launch is the app's own executable, so a build with another binary name uses its own.
        assert_eq!(body.matches("${MAINBINARYNAME}.exe").count(), 4, "the question about a running ADE and the three launches");
        // Nothing of the hook removes a folder itself: Tauri's own «elimina i dati» does, after the secrets are out.
        assert!(!body.contains("RMDir") && !body.contains("Delete "));
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["bundle"]["windows"]["nsis"]["installerHooks"].as_str(), Some("windows/hooks.nsh"));
    }

    #[test]
    fn the_installer_is_per_user_so_the_hook_runs_as_the_user_whose_files_it_removes() {
        // Under `perMachine` a standard user who elevates with an administrator's credentials would run the hook as the administrator, and
        // it would clean the wrong home. Whoever changes this changes the hook with it.
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mode = config["bundle"]["windows"]["nsis"]["installMode"].as_str();
        assert!(mode.is_none() || mode == Some("currentUser"), "installMode is {mode:?}");
    }

    #[test]
    fn only_the_released_identity_takes_the_hooks_of_other_programs() {
        assert!(unlink_allowed("ai.nikcli.ade", None));
        // ADE Test, and any other identity, leave them alone...
        assert!(!unlink_allowed("ai.nikcli.ade.test", None));
        assert!(!unlink_allowed("com.example.myade", None));
        assert!(!unlink_allowed("ai.nikcli.ade.test", Some("0")));
        assert!(!unlink_allowed("ai.nikcli.ade.test", Some("")));
        // ...unless the proving job says so; the release does not need to be told.
        assert!(unlink_allowed("ai.nikcli.ade.test", Some("1")));
        assert!(unlink_allowed("ai.nikcli.ade", Some("0")));
    }

    #[test]
    fn a_build_that_is_not_the_release_ends_the_flag_with_nothing_touched() {
        // `dispatch` answers 0 (nothing to do, the installer goes on) without reading any home: the identity is what decides, before the files.
        if std::env::var(UNLINK_FOR_TEST_VAR).is_err() {
            assert_eq!(dispatch(&args(&["--unlink-agents"]), "ai.nikcli.ade.test"), Some(0));
            assert_eq!(dispatch(&args(&["--unlink-agents"]), "other.app"), Some(0));
        }
        let source = include_str!("uninstall.rs");
        let arm = &source[source.find("\"--unlink-agents\" => Some(if").unwrap()..];
        assert!(arm[..arm.find("\"--clean-caches\"").unwrap()].contains("unlink_allowed(identifier"));
    }
}
