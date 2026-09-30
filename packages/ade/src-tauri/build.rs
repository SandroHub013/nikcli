use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

/// The folder of NikVerse's assets, next to this file. `src/nikverse.rs` names the same folder (`ASSETS_DIR`)
/// and the installer does not ship it: `src/nikverse_assets.rs` fetches the files the manifest below names.
const ASSETS_DIR: &str = "nikverse-assets";

fn main() {
    build_nikverse_world();
    write_nikverse_manifest();
    tauri_build::build()
}

/// Bundles NikVerse's 3D city into `nikverse-assets/world/city.js` (`scripts/build-nikverse-world.ts`),
/// before the folder is listed, so the bundle is hashed into the manifest like every other asset.
///
/// Every way ADE is built goes through cargo, so this is the one place that cannot be forgotten
/// (`tauri dev`, `tauri build`, the test app, `cargo test`). Without `bun` the world keeps working as
/// its plain list (the page falls back when the module is missing) and the build says so; set
/// `NIKVERSE_WORLD_REQUIRED=1` to make that an error, as a release build should.
fn build_nikverse_world() {
    println!("cargo:rerun-if-changed=../src/nikverse/city");
    println!("cargo:rerun-if-changed=../scripts/build-nikverse-world.ts");
    println!("cargo:rerun-if-env-changed=NIKVERSE_WORLD_REQUIRED");
    println!("cargo:rerun-if-env-changed=NIKVERSE_SKIP_WORLD");
    if env::var_os("NIKVERSE_SKIP_WORLD").is_some() {
        return;
    }
    let required = env::var_os("NIKVERSE_WORLD_REQUIRED").is_some();
    let app = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR")).join("..");
    // `bun` is a `.cmd` shim on a Windows machine that installed it with npm.
    let mut last = String::from("bun non trovato");
    for program in ["bun", "bun.cmd", "bun.exe"] {
        match std::process::Command::new(program)
            .arg("scripts/build-nikverse-world.ts")
            .current_dir(&app)
            .output()
        {
            Ok(out) if out.status.success() => return,
            Ok(out) => {
                last = format!("{program}: {}", String::from_utf8_lossy(&out.stderr).trim());
                break;
            }
            Err(error) => last = format!("{program}: {error}"),
        }
    }
    if required {
        panic!("NikVerse: il mondo 3D non si e costruito: {last}");
    }
    println!("cargo:warning=NikVerse: il mondo 3D non si e costruito ({last}); il pannello mostrera la lista");
}

/// Lists every file of the assets folder with its SHA-256 and size, and writes the list as Rust
/// source into `OUT_DIR`, where `src/nikverse.rs` includes it. The scheme serves only what this list
/// names, and only while the file on disk still has the hash the binary was built with.
///
/// A name that cannot be a plain relative path (a space, a backslash, a colon, a non-ASCII letter) fails
/// the build here, so nothing the scheme's path rules would refuse ever reaches the list.
fn write_nikverse_manifest() {
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

    let out = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR")).join("nikverse_manifest.rs");
    fs::write(out, source).expect("nikverse_manifest.rs");
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
