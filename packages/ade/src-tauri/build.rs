use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

/// The folder of RaguVerse's assets, next to this file. `src/raguverse.rs` names the same folder (`ASSETS_DIR`)
/// and the installer does not ship it: `src/raguverse_assets.rs` fetches the files the manifest below names.
const ASSETS_DIR: &str = "nikverse-assets";

fn main() {
    build_raguverse_world();
    write_raguverse_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest())).unwrap_or_else(|error| panic!("{error:#}"));
}

#[path = "src/bun_lookup.rs"]
mod bun_lookup;

// The commands of the app, read from the list lib.rs gives Tauri; the tests in the same file check the capability grants them.
#[path = "src/handler_list.rs"]
#[allow(dead_code)]
mod handler_list;

/// The app's own commands declared as its ACL manifest (S7), so a command that is not granted to the main window in
/// capabilities/default.json is refused, and a page that is not the main window's, or is loaded from a web address, cannot
/// reach them. Every command is declared, not only the sensitive ones: once there is a manifest, Tauri refuses any command
/// of the app that is not in it (see src/handler_list.rs).
fn app_manifest() -> tauri_build::AppManifest {
    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=src/handler_list.rs");
    let source = fs::read_to_string(PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("src/lib.rs"))
        .unwrap_or_else(|error| panic!("src/lib.rs: {error}"));
    // `AppManifest` keeps the names for the whole build, and this process ends with it.
    let commands: Vec<&'static str> = handler_list::handler_commands(&source)
        .into_iter()
        .map(|command| &*Box::leak(command.into_boxed_str()))
        .collect();
    tauri_build::AppManifest::new().commands(Box::leak(commands.into_boxed_slice()))
}

/// Bundles RaguVerse's 3D city into `nikverse-assets/world/city.js` (`scripts/build-raguverse-world.ts`),
/// before the folder is listed, so the bundle is hashed into the manifest like every other asset.
///
/// Every way ADE is built goes through cargo, so this is the one place that cannot be forgotten
/// (`tauri dev`, `tauri build`, the test app, `cargo test`). Without `bun` the world keeps working as
/// its plain list (the page falls back when the module is missing) and the build says so; set
/// `RAGUVERSE_WORLD_REQUIRED=1` to make that an error, as a release build should.
fn build_raguverse_world() {
    println!("cargo:rerun-if-changed=../src/raguverse/city");
    println!("cargo:rerun-if-changed=../scripts/build-raguverse-world.ts");
    println!("cargo:rerun-if-changed=src/bun_lookup.rs");
    println!("cargo:rerun-if-env-changed=RAGUVERSE_WORLD_REQUIRED");
    println!("cargo:rerun-if-env-changed=RAGUVERSE_SKIP_WORLD");
    println!("cargo:rerun-if-env-changed=BUN_BIN");
    if env::var_os("RAGUVERSE_SKIP_WORLD").is_some() {
        return;
    }
    let required = env::var_os("RAGUVERSE_WORLD_REQUIRED").is_some();
    let app = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("..");
    let city_bundle = app.join("src-tauri").join(ASSETS_DIR).join("world").join("city.js");
    let candidates = bun_lookup::find_bun_candidates_from_env();
    let mut failures = Vec::new();

    for program in &candidates {
        match std::process::Command::new(program)
            .arg("scripts/build-raguverse-world.ts")
            .current_dir(&app)
            .output()
        {
            Ok(out) if out.status.success() => return,
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let msg = if !stderr.is_empty() {
                    stderr
                } else if !stdout.is_empty() {
                    stdout
                } else {
                    format!("exit code {}", out.status)
                };
                failures.push(format!("{}: {msg}", program.display()));
            }
            Err(error) => failures.push(format!("{}: {error}", program.display())),
        }
    }

    if city_bundle.is_file() {
        println!("cargo:warning=RaguVerse: bun non e riuscito a rigenerare il bundle, ma city.js e presente; procedo con quello");
        return;
    }

    let summary = if failures.is_empty() {
        String::from("nessun candidato bun trovato")
    } else {
        failures.join("; ")
    };

    if required {
        panic!("RaguVerse: il mondo 3D non si e costruito: {summary}");
    }
    println!("cargo:warning=RaguVerse: il mondo 3D non si e costruito ({summary}); il pannello mostrera la lista");
}

/// Lists every file of the assets folder with its SHA-256 and size, and writes the list as Rust
/// source into `OUT_DIR`, where `src/raguverse.rs` includes it. The scheme serves only what this list
/// names, and only while the file on disk still has the hash the binary was built with.
///
/// A name that cannot be a plain relative path (a space, a backslash, a colon, a non-ASCII letter) fails
/// the build here, so nothing the scheme's path rules would refuse ever reaches the list.
fn write_raguverse_manifest() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join(ASSETS_DIR);
    println!("cargo:rerun-if-changed={ASSETS_DIR}");
    println!("cargo:rerun-if-changed=build.rs");

    let mut files = Vec::new();
    if root.is_dir() {
        collect(&root, &root, &mut files);
    }
    files.sort();

    let mut source = String::from("pub const MANIFEST: &[ManifestEntry] = &[\n");
    for relative in &files {
        let bytes = fs::read(root.join(relative)).unwrap_or_else(|error| panic!("{ASSETS_DIR}/{relative}: {error}"));
        let digest = Sha256::digest(&bytes);
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        source.push_str(&format!(
            "    ManifestEntry {{ path: {relative:?}, sha256: {hex:?}, size: {} }},\n",
            bytes.len()
        ));
    }
    source.push_str("];\n");

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("raguverse_manifest.rs");
    fs::write(out, source).expect("raguverse_manifest.rs");
}

fn collect(root: &Path, dir: &Path, into: &mut Vec<String>) {
    let entries = fs::read_dir(dir).unwrap_or_else(|error| panic!("{}: {error}", dir.display()));
    for entry in entries {
        let entry = entry.expect("voce della cartella");
        let name = entry.file_name().to_string_lossy().into_owned();
        // `.DS_Store`, `.gitkeep`: never listed, so never served.
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, into);
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .expect("dentro la cartella")
            .components()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let plain = relative
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'));
        assert!(plain, "{ASSETS_DIR}/{relative}: il nome puo avere solo lettere ASCII, cifre e . _ - /");
        into.push(relative);
    }
}
