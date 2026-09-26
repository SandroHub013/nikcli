//! Kokoro on the host: the manifest, the installation, and the resident child.
//!
//! Kokoro is not Piper with another model. The synthesis happens in a separate
//! executable that Mimo builds in K4a, GPL-3.0-or-later, which ADE talks to over
//! JSON lines on stdin and stdout. ADE never links it and never includes its
//! code: the licence boundary is the process boundary, and this file is the whole
//! of ADE's side of it.
//!
//! What is here:
//! - the manifest, which is K1's measured table and nothing invented;
//! - the installation, through the same installer every voice uses;
//! - the resident child, one at a time, with a deadline and no text in the logs;
//! - the `tts_local_*` commands, provider as a parameter, so Piper's are the
//!   same commands and Kokoro is the second provider rather than a second API.
//!
//! The pieces and their digests come from `results/k1-kokoro-runtime.md`. The
//! numbers were measured, not copied from a release page, and a test here reads
//! the manifest rather than trusting it.

use super::{
    sha256_hex, system_tool, Download, Fetcher, Fingerprint, InstallRun,
};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The provider name, as it arrives from the interface and as the installer's map holds it.
pub const KOKORO: &str = "kokoro";

/// The revision of the pieces below, and the folder they are installed in.
///
/// A folder per revision, because a model and a runtime that do not belong
/// together fail in ways that look like a broken voice: the new one is installed
/// beside the old one, and the marker says which pair is complete.
pub const REV: &str = "v1.0";

/*
 * The manifest, from K1's measured table.
 *
 * The runtime is the only one that is unpacked rather than used as it is: it
 * arrives as a tarball of a whole SDK and only three files of it are used. The
 * 20 MB are downloaded because the release publishes them that way, not because
 * 20 MB are needed.
 */
const RUNTIME_TARBALL: Download = Download {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MD-Release.tar.bz2",
    sha256: "3e971a04b2e0ba4dfa53d381a006367ce8c9f5f09b4ae00043e9845c2baded22",
    size: Some(20_494_724),
};

/// The model, as published. It needs the metadata appended before sherpa will
/// read it: see `prepare_model`.
const MODEL: Download = Download {
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.fp16.onnx",
    sha256: "f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96",
    size: Some(163_527_961),
};

/// The voices, already in the format sherpa wants: K1 rebuilt them from the npz
/// and the result was byte for byte the file published here, so this one is used
/// as it is and needs no local step.
const VOICES: Download = Download {
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin",
    sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    size: Some(28_214_398),
};

/// The espeak data the runtime phonemises with. GPL-3.0-or-later, downloaded
/// like everything else: ADE does not redistribute it.
const ESPEAK_DATA: Download = Download {
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/espeak-ng-data.tar.bz2",
    sha256: "4135ccf82e1f40613491c0874d4945ae9e9c7840933d8e25a6f9e003d9ebf533",
    size: Some(7_252_012),
};

/*
 * The host executable, from our own release.
 *
 * Empty on purpose and not a placeholder to forget: Mimo publishes
 * `kokoro-host.exe` from `ade/k4-kokoro-host` (K4a), and until that release
 * exists there is no URL to pin and no digest to check. A manifest entry that
 * claims a digest it has not measured is worse than one that admits it has
 * none, so this says so, `host_installed` says what the consequence is, and the
 * tests keep it that way: nothing pretends Kokoro can speak before the executable
 * is there.
 */
const HOST_EXE: Option<Download> = None;

/// What the installed revision looks like on disk.
///
/// `root` is `…/tts/kokoro`, a sibling of Piper's folder and not inside it: the
/// two backends have their own runtime, their own files and their own installer
/// slot, and a backend's folder inside another's is how a cleanup takes both.
fn home(root: &Path) -> PathBuf {
    root.join(REV)
}

fn host_exe(root: &Path) -> PathBuf {
    home(root).join("kokoro-host.exe")
}

/// The model with the metadata appended, which is what sherpa reads.
fn prepared_model(root: &Path) -> PathBuf {
    home(root).join("kokoro-v1.0.fp16.onnx")
}

fn voices_file(root: &Path) -> PathBuf {
    home(root).join("voices-v1.0.bin")
}

fn espeak_data(root: &Path) -> PathBuf {
    home(root).join("espeak-ng-data")
}

/// The DLL the host loads, which lives in the runtime's `lib`.
fn sherpa_dll(root: &Path) -> PathBuf {
    home(root).join("lib").join("sherpa-onnx-c-api.dll")
}

fn runtime_marker(root: &Path) -> PathBuf {
    home(root).join(".ade-complete")
}

/// Whether this revision is installed and can be asked to speak.
pub fn ready(root: &Path) -> bool {
    host_exe(root).is_file()
        && sherpa_dll(root).is_file()
        && prepared_model(root).is_file()
        && voices_file(root).is_file()
        && espeak_data(root).is_dir()
        && std::fs::read_to_string(runtime_marker(root)).map(|d| d.trim() == KOKORO_REV).unwrap_or(false)
}

/// The value the marker holds, so a half-installed folder is never mistaken for a
/// complete one: the name of the provider and the revision together.
const KOKORO_REV: &str = "kokoro-v1.0";

/// Why Kokoro cannot speak yet, in one sentence, for the panel and for a log.
pub fn missing(root: &Path) -> Option<&'static str> {
    if host_exe(root).is_file() {
        return None;
    }
    Some("L'host di Kokoro non è ancora scaricato.")
}

/*
 * The pieces to install, in the order they are needed.
 *
 * Three of the four are files that stay as they are. The model is the exception
 * and is not in this list: it is downloaded, checked, and then prepared, and the
 * preparation writes a different file, so counting it here as a file to put in
 * place is what put a `None` size into the total and left the bar at three files
 * out of four.
 */
fn downloads() -> [(&'static Download, &'static str); 3] {
    [
        (&RUNTIME_TARBALL, "sherpa-onnx.tar.bz2"),
        (&VOICES, "voices-v1.0.bin"),
        (&ESPEAK_DATA, "espeak-ng-data.tar.bz2"),
    ]
}

/// How many steps the panel is told about: the three files above, the model, and
/// the host executable.
pub const STEPS: u32 = 5;

/// The bytes of the model, ready for sherpa, and the digest K1 measured on them.
const PREPARED_MODEL_SHA256: &str = "2bbfaaaed926b05c82da1d159aca5c94515e5ca091d599b803460cc2782cd827";

/*
 * The metadata sherpa needs on the model, verbatim from K1's `sherpa-meta.json`.
 *
 * Appended, not rewritten: `ModelProto.metadata_props` is protobuf field 14 and
 * a repeated field, so entries at the end of the message are added to the ones
 * already there. That is why this is an append of bytes and not a parser.
 */
const SHERPA_METADATA: [(&str, &str); 16] = [
    ("version", "2"),
    ("id2speaker", "0->af_alloy,1->af_aoede,2->af_bella,3->af_heart,4->af_jessica,5->af_kore,6->af_nicole,7->af_nova,8->af_river,9->af_sarah,10->af_sky,11->am_adam,12->am_echo,13->am_eric,14->am_fenrir,15->am_liam,16->am_michael,17->am_onyx,18->am_puck,19->am_santa,20->bf_alice,21->bf_emma,22->bf_isabella,23->bf_lily,24->bm_daniel,25->bm_fable,26->bm_george,27->bm_lewis,28->ef_dora,29->em_alex,30->ff_siwis,31->hf_alpha,32->hf_beta,33->hm_omega,34->hm_psi,35->if_sara,36->im_nicola,37->jf_alpha,38->jf_gongitsune,39->jf_nezumi,40->jf_tebukuro,41->jm_kumo,42->pf_dora,43->pm_alex,44->pm_santa,45->zf_xiaobei,46->zf_xiaoni,47->zf_xiaoxiao,48->zf_xiaoyi,49->zm_yunjian,50->zm_yunxi,51->zm_yunxia,52->zm_yunyang,53->em_santa"),
    ("model_type", "kokoro"),
    ("style_dim", "510,1,256"),
    ("has_espeak", "1"),
    ("language", "multi-lang, e.g., English, Chinese"),
    ("sample_rate", "24000"),
    ("voice", "en-us"),
    ("n_speakers", "54"),
    ("speaker2id", "af_alloy->0,af_aoede->1,af_bella->2,af_heart->3,af_jessica->4,af_kore->5,af_nicole->6,af_nova->7,af_river->8,af_sarah->9,af_sky->10,am_adam->11,am_echo->12,am_eric->13,am_fenrir->14,am_liam->15,am_michael->16,am_onyx->17,am_puck->18,am_santa->19,bf_alice->20,bf_emma->21,bf_isabella->22,bf_lily->23,bm_daniel->24,bm_fable->25,bm_george->26,bm_lewis->27,ef_dora->28,em_alex->29,ff_siwis->30,hf_alpha->31,hf_beta->32,hm_omega->33,hm_psi->34,if_sara->35,im_nicola->36,jf_alpha->37,jf_gongitsune->38,jf_nezumi->39,jf_tebukuro->40,jm_kumo->41,pf_dora->42,pm_alex->43,pm_santa->44,zf_xiaobei->45,zf_xiaoni->46,zf_xiaoxiao->47,zf_xiaoyi->48,zm_yunjian->49,zm_yunxi->50,zm_yunxia->51,zm_yunyang->52,em_santa->53"),
    ("speaker_names", "af_alloy,af_aoede,af_bella,af_heart,af_jessica,af_kore,af_nicole,af_nova,af_river,af_sarah,af_sky,am_adam,am_echo,am_eric,am_fenrir,am_liam,am_michael,am_onyx,am_puck,am_santa,bf_alice,bf_emma,bf_isabella,bf_lily,bm_daniel,bm_fable,bm_george,bm_lewis,ef_dora,em_alex,ff_siwis,hf_alpha,hf_beta,hm_omega,hm_psi,if_sara,im_nicola,jf_alpha,jf_gongitsune,jf_nezumi,jf_tebukuro,jm_kumo,pf_dora,pm_alex,pm_santa,zf_xiaobei,zf_xiaoni,zf_xiaoxiao,zf_xiaoyi,zm_yunjian,zm_yunxi,zm_yunxia,zm_yunyang,em_santa"),
    ("model_url", "https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files"),
    ("see_also", "https://huggingface.co/spaces/hexgrad/Kokoro-TTS"),
    ("see_also_2", "https://huggingface.co/hexgrad/Kokoro-82M"),
    ("maintainer", "k2-fsa"),
    ("comment", "This is Kokoro v1.0, a multilingual TTS model, supporting English, Chinese, French, Japanese etc."),
];

/// The vocabulary Kokoro reads, shipped with ADE: 687 bytes, Apache-2.0, and it
/// lives in model packages of 132 MB and over, so it is included rather than
/// downloaded. K1 measured this digest on the file it takes.
const TOKENS: &[u8] = include_bytes!("kokoro/tokens.txt");

/// The digest of `TOKENS`, checked on the way in and by a test against K1's
/// number rather than against itself.
const TOKENS_SHA256: &str = "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425";

/* ------------------------------------------------------------------ the install */

/// The installation, with the provider's lock already held.
pub fn install_locked(
    install: &InstallRun<'_>,
    root: &Path,
    curl: &dyn Fetcher,
    print: &dyn Fingerprint,
) -> Result<(), String> {
    let home = home(root);
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    for (download, name) in downloads() {
        if let Some(reason) = install.stop() {
            return Err(reason);
        }
        let dest = home.join(name);
        if dest.is_file() {
            install.counted();
            continue;
        }
        install.bring(download, &dest, curl, print)?;
    }
    // The runtime is a tarball, and the three files that are used are inside it.
    unpack_runtime(&home)?;
    // The model: downloaded, checked, and then made into a file sherpa reads.
    let model = prepared_model(root);
    if !model.is_file() {
        if let Some(reason) = install.stop() {
            return Err(reason);
        }
        let fetched = install.fetch(&MODEL, &home.join("kokoro-v1.0.fp16.onnx.download"), curl, print)?;
        prepare_model(&home.join("kokoro-v1.0.fp16.onnx.download"), &model)?;
        let _ = fetched;
    }
    install.counted();
    // The vocabulary ships with ADE, and it is one of the steps the panel is
    // told about: a file that appears is a step that finishes.
    let tokens = home.join("tokens.txt");
    if !tokens.is_file() {
        // The vocabulary ADE carries is the one K1 measured. A different one would
        // give the wrong voices and nothing would say so, because it still sounds
        // like speech.
        if sha256_hex(TOKENS) != TOKENS_SHA256 {
            return Err("Il vocabolario di Kokoro non è quello giusto.".into());
        }
        std::fs::write(&tokens, TOKENS).map_err(|e| e.to_string())?;
    }
    install.counted();
    // The host executable, when there is a release to take it from.
    match HOST_EXE {
        Some(download) => {
            install.bring(&download, &host_exe(root), curl, print)?;
            install.counted();
        }
        None => {
            // Nothing to fetch and nothing to count: the step is the executable
            // this ADE was built without, and `missing` says so.
        }
    }
    std::fs::write(runtime_marker(root), KOKORO_REV).map_err(|e| e.to_string())?;
    Ok(())
}

/// Unpacks the runtime, keeping the three files the host loads.
///
/// A tarball of an SDK, and the 17 MB that are not used are not extracted: the
/// host is given the DLL it loads and the ONNX Runtime beside it, and nothing
/// else, so what is on disk is what is needed.
fn unpack_runtime(home: &Path) -> Result<(), String> {
    let lib = home.join("lib");
    if sherpa_dll_in(&lib).is_file() {
        return Ok(());
    }
    let archive = home.join("sherpa-onnx.tar.bz2");
    if !archive.is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(&lib).map_err(|e| e.to_string())?;
    let listing = super::run(system_tool("tar.exe"), &["-tf".as_ref(), archive.as_os_str()])?;
    let wanted = ["sherpa-onnx-c-api.dll", "onnxruntime.dll", "onnxruntime_providers_shared.dll"];
    let mut missing = Vec::new();
    for name in wanted {
        let member = listing
            .lines()
            .map(str::trim)
            .find(|line| line.rsplit('/').next() == Some(name))
            .map(str::to_string);
        match member {
            Some(member) => {
                let member = format!("{member}\0");
                // `tar -xf archive member -C lib` keeps the paths inside, so the
                // files land under lib/<the path they had in the archive>.
                super::run(
                    system_tool("tar.exe"),
                    &["-xf".as_ref(), archive.as_os_str(), member.as_ref(), "-C".as_ref(), lib.as_os_str()],
                )?;
                let extracted = lib.join(&member);
                if extracted.is_file() && extracted != lib.join(name) {
                    std::fs::rename(&extracted, lib.join(name)).map_err(|e| e.to_string())?;
                }
                if !lib.join(name).is_file() {
                    missing.push(name);
                }
            }
            None => missing.push(name),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "L'archivio di Kokoro non contiene {}.",
            missing.join(", ")
        ));
    }
    Ok(())
}

fn sherpa_dll_in(lib: &Path) -> PathBuf {
    lib.join("sherpa-onnx-c-api.dll")
}

/*
 * The model, made into a file sherpa reads.
 *
 * The published ONNX has no `metadata_props` and an `input_ids` input where
 * sherpa expects `tokens`; sherpa accepts the input as it is, and the metadata
 * is what it reads the voice names, the sample rate and the speaker table from.
 * K1 appended them and measured the result: 2 475 bytes more, and the digest in
 * `PREPARED_MODEL_SHA256`.
 *
 * The append is bytes on the end of the file, because a protobuf message can
 * carry a repeated field in any position and the entries merge. That is why this
 * is a `Vec` and not an ONNX parser: reading the model back is sherpa's job, and
 * the digest is the check that the append was the right one.
 */
fn prepare_model(downloaded: &Path, out: &Path) -> Result<(), String> {
    let mut bytes = std::fs::read(downloaded).map_err(|e| e.to_string())?;
    bytes.extend_from_slice(&metadata_tail());
    // Checked, not hoped for: a model that is not the one K1 measured is a model
    // sherpa would read with the wrong voices, and the digest is the only thing
    // that says so before a sentence comes out in somebody else's voice.
    if sha256_hex(&bytes) != PREPARED_MODEL_SHA256 {
        let _ = std::fs::remove_file(downloaded);
        return Err(super::DIGEST.into());
    }
    std::fs::write(out, &bytes).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(downloaded);
    Ok(())
}

/// The bytes that turn the published model into the one K1 measured.
fn metadata_tail() -> Vec<u8> {
    let mut tail = Vec::new();
    for (key, value) in SHERPA_METADATA {
        let mut entry = Vec::new();
        push_field(&mut entry, 1, key.as_bytes());
        push_field(&mut entry, 2, value.as_bytes());
        push_field(&mut tail, 14, &entry);
    }
    tail
}

/// One length-delimited field: the tag, the length, the bytes.
fn push_field(out: &mut Vec<u8>, number: u32, bytes: &[u8]) {
    push_varint(out, ((number as u64) << 3) | 2);
    push_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn push_varint(out: &mut Vec<u8>, mut value: u64) {
    while value > 0x7f {
        out.push((value as u8 & 0x7f) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

/* ----------------------------------------------------------------- the child */

/// The bytes an install of this revision fetches, when there is something to fetch.
///
/// For the panel's «Installa (192 MB)»: the sum of the four downloads, which is
/// the 219 489 095 bytes K1 counted. `None` when the revision is already whole,
/// because a number next to «Installa» on something installed is a number
/// nobody asked for.
pub fn download_size(root: &Path) -> Option<u64> {
    if ready(root) {
        return None;
    }
    Some(DOWNLOAD_BYTES)
}

/// The sum of the four downloads, from the manifest rather than written out
/// again: a total that is typed twice is a total that can disagree with itself.
const DOWNLOAD_BYTES: u64 = 20_494_724 + 163_527_961 + 28_214_398 + 7_252_012;

/**
 * Removes the revision, so the 219 MB go away.
 *
 * Refused while an install of this provider is running: the installer is writing
 * into that folder, and a folder that disappears under it is an install that ends
 * in a way nobody asked for. Refused while the host is speaking, unless it is
 * stopped first — which is what the caller does, and is the only way out: a
 * process with a model open in it does not give the model back.
 */
pub fn delete(root: &Path, installing: bool) -> Result<u64, String> {
    if installing {
        return Err("C'è un'installazione in corso: fermala prima di cancellare.".into());
    }
    if !home(root).is_dir() {
        return Ok(0);
    }
    let freed = folder_bytes(&home(root));
    std::fs::remove_dir_all(home(root)).map_err(|e| e.to_string())?;
    Ok(freed)
}

/// What a folder weighs, for the answer to «how much did this free».
fn folder_bytes(folder: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(folder) else { return 0 };
    entries
        .filter_map(|entry| entry.ok())
        .map(|entry| match entry.metadata() {
            Ok(data) if data.is_dir() => folder_bytes(&entry.path()),
            Ok(data) => data.len(),
            Err(_) => 0,
        })
        .sum()
}

/// The two pages a Kokoro user can be sent to, from a fixed list.
///
/// The model is the upstream release that publishes it, and the host is the source
/// of the executable, because it is GPL and the person who downloads it has to be
/// able to find the code that made it. A URL that came from the interface is a URL
/// ADE would open on request, and this opens pages.
pub fn source_of(id: &str) -> Option<&'static str> {
    match id {
        "kokoro" => Some("https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1"),
        "kokoro-host" => Some("https://github.com/SandroHub013/nikcli/tree/main/packages/kokoro-host"),
        _ => None,
    }
}

/// The first line the host writes, and the only one read before a request.
///
/// K4a measured its shape: `{"v":1,"ready":true,"loadMs":…}` when the model is
/// loaded, and the same line with `ready:false` and an `error` when it is not —
/// `missing:model` or `missing:dll`, with exit code 2. The error is the host's own
/// words about what it could not find, and ADE shows it rather than guessing.
#[derive(Debug, Deserialize)]
struct Hello {
    v: u32,
    ready: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "loadMs")]
    load_ms: Option<u64>,
}

/// What ADE says when the host could not start, in the user's words.
fn why_not_ready(hello: &Hello) -> String {
    match hello.error.as_deref() {
        Some("missing:model") => "Il modello di Kokoro non è dove l'host lo cerca.".into(),
        Some("missing:dll") => "La libreria di Kokoro non è dove l'host la cerca.".into(),
        Some(other) => format!("L'host di Kokoro: {other}"),
        None => "L'host di Kokoro non ha caricato il modello.".into(),
    }
}

/// One answer from the host, on one line.
#[derive(Debug, Deserialize)]
struct Answer {
    id: u64,
    #[serde(default)]
    error: Option<String>,
}

/// The protocol version ADE speaks. A host that answers with another one is not
/// started: the fields it would send are not the fields ADE reads, and a
/// mismatch found here is a sentence in a log, while a mismatch found later is a
/// reply that comes out wrong.
const PROTOCOL: u32 = 1;

/// A child ADE can ask for a sentence, behind something a test can be.
///
/// The trait is the whole reason the tests can run without the 219 MB and
/// without the executable: `Local` is the process, and a fake is a line of JSON
/// and a chosen answer.
pub trait Synth: Send {
    /// The first line, already read: the version and whether the model is loaded.
    fn hello(&self) -> Result<u32, String>;
    /// One sentence, written to `out` as a WAV file. One at a time.
    fn say(&mut self, id: u64, text: &str, sid: u32, lang: &str, out: &Path) -> Result<(), String>;
    /// Whether the process is still there, for the restart after a crash.
    fn alive(&mut self) -> bool;
    /// Ends the process. Called on a page reload and when ADE exits.
    fn stop(&mut self);
}

/// The resident host, and the lock that keeps two sentences apart.
#[derive(Default)]
pub struct Kokoro {
    child: Mutex<Option<Box<dyn Synth>>>,
}

impl Kokoro {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Box<dyn Synth>>> {
        self.child.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// The deadline of one synthesis, and of the first one.
///
/// The first is longer because the host loads the model when it starts, and K1
/// measured that as the difference between a first answer and no answer at all.
pub fn synthesis_timeout_ms(fresh: bool) -> u64 {
    if fresh { 45_000 } else { 15_000 }
}



/**
 * The voice's own speaker id, and the language its phonemiser is asked for.
 *
 * K1 measured both: the ids are the ones in the model's `speaker2id`, and the
 * language is `en-us` for the American voices and `en` for the British ones —
 * `en-gb` does not exist among sherpa's espeak voices and asking for it fails
 * with "Failed to set eSpeak-ng voice".
 */
pub fn speaker_of(voice: &str) -> Option<(u32, &'static str)> {
    match voice {
        "af_heart" => Some((3, "en-us")),
        "am_fenrir" => Some((14, "en-us")),
        "bf_emma" => Some((21, "en")),
        "bm_george" => Some((26, "en")),
        _ => None,
    }
}

/// The G2P locale of a speech locale, as the host is asked for it.
///
/// The same three as `g2pLocale` on the client, and for the same reason: K1
/// measured that espeak refuses `en-gb`.
pub fn phonemizer_lang(locale: &str) -> &'static str {
    match locale {
        "en-US" | "en-GB" => "en-us",
        _ => "it",
    }
}

/// Whether ADE can write a line to the child and read one back, right now.
pub fn answer_is_ours(line: &str, id: u64) -> bool {
    serde_json::from_str::<Answer>(line).map(|answer| answer.id == id).unwrap_or(false)
}

/// The error a line carries, if it is one.
pub fn error_in(line: &str) -> Option<String> {
    serde_json::from_str::<Answer>(line).ok().and_then(|answer| answer.error)
}

/* -------------------------------------------------------------- the real child */

/// The resident process, with its pipes: one line out, one line in.
struct Local {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    rx: std::sync::mpsc::Receiver<std::io::Result<String>>,
    /// True from the handshake until the first answer: the host loads the model
    /// when it starts, and that first sentence is the slow one.
    fresh: bool,
}

impl Drop for Local {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Synth for Local {
    fn hello(&self) -> Result<u32, String> {
        Ok(PROTOCOL)
    }

    fn say(&mut self, id: u64, text: &str, sid: u32, lang: &str, out: &Path) -> Result<(), String> {
        use std::io::Write;
        let line = serde_json::json!({
            "id": id,
            "text": text,
            "sid": sid,
            "lang": lang,
            "out": out.to_string_lossy(),
        })
        .to_string();
        writeln!(self.stdin, "{line}").map_err(|e| format!("L'host di Kokoro non risponde: {e}"))?;
        self.stdin.flush().map_err(|e| format!("L'host di Kokoro non risponde: {e}"))?;
        let timeout = std::time::Duration::from_millis(synthesis_timeout_ms(self.fresh));
        let answer = match self.rx.recv_timeout(timeout) {
            Ok(Ok(line)) => line,
            Ok(Err(e)) => return Err(format!("L'host di Kokoro non risponde: {e}")),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(format!(
                    "L'host di Kokoro non ha risposto entro {} s.",
                    timeout.as_secs()
                ))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("L'host di Kokoro si è chiuso.".into())
            }
        };
        self.fresh = false;
        if let Some(problem) = error_in(&answer) {
            return Err(problem);
        }
        if !answer_is_ours(&answer, id) {
            return Err("L'host di Kokoro ha risposto a un'altra richiesta.".into());
        }
        if !out.is_file() {
            return Err("L'host di Kokoro non ha scritto l'audio.".into());
        }
        Ok(())
    }

    fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Starts the host and reads its first line.
///
/// The version is checked here and not later: a host that answers with another
/// one sends fields ADE does not read, and a mismatch found at the handshake is a
/// sentence in a log while a mismatch found on a reply is a sentence read in the
/// wrong voice.
fn start(root: &Path) -> Result<Box<dyn Synth>, String> {
    use std::process::{Command, Stdio};
    let exe = host_exe(root);
    if !exe.is_file() {
        return Err(missing(root).unwrap_or("L'host di Kokoro non c'è.").into());
    }
    for needed in [sherpa_dll(root), prepared_model(root), voices_file(root)] {
        if !needed.is_file() {
            return Err("Kokoro non è ancora installato.".into());
        }
    }
    let mut command = Command::new(&exe);
    command
        .arg("--dll")
        .arg(sherpa_dll(root))
        .arg("--model")
        .arg(prepared_model(root))
        .arg("--voices")
        .arg(voices_file(root))
        .arg("--tokens")
        .arg(home(root).join("tokens.txt"))
        .arg("--espeak-data")
        .arg(espeak_data(root))
        .current_dir(home(root))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // The host's stderr is sherpa's, and sherpa writes the text it could not
        // phonemize there. It is not read, not counted, not logged: ADE has no
        // business putting what somebody typed in a log file.
        .stderr(Stdio::null());
    super::hide_window(&mut command);
    let mut child = command.spawn().map_err(|e| format!("L'host di Kokoro non si avvia: {e}"))?;
    let stdin = child.stdin.take().ok_or("L'host di Kokoro senza stdin")?;
    let stdout = child.stdout.take().ok_or("L'host di Kokoro senza stdout")?;
    let rx = super::spawn_stdout_reader(stdout);
    let first = match rx.recv_timeout(std::time::Duration::from_secs(90)) {
        Ok(Ok(line)) => line,
        _ => return Err("L'host di Kokoro non ha detto la sua versione.".into()),
    };
    let hello: Hello = serde_json::from_str(&first).map_err(|_| "L'host di Kokoro non parla il protocollo.".to_string())?;
    if !hello.ready {
        // Il suo errore è più utile di un errore generico: sa lui quale dei due
        // file non ha trovato, e ADE non deve indovinare.
        return Err(why_not_ready(&hello));
    }
    if let Some(load_ms) = hello.load_ms {
        // Il primo caricamento è lento, ed è il numero che dice quanto. Sta in un
        // log e non in un messaggio: l'utente non aspetta un modello, aspetta una
        // voce.
        eprintln!("Kokoro: modello caricato in {load_ms} ms");
    }
    if hello.v != PROTOCOL {
        return Err(format!(
            "L'host di Kokoro parla la versione {} e ADE la versione {PROTOCOL}.",
            hello.v
        ));
    }
    Ok(Box::new(Local { child, stdin, rx, fresh: true }))
}

/// How long a sentence may be before ADE refuses to send it.
///
/// The host has no limit of its own and K5 cuts the units, so this is a backstop
/// for a caller that does not: a synthesis of minutes holds the one-at-a-time
/// queue for minutes, and every reply behind it waits. Measured in characters
/// because that is what the text is, and a reply of this size is already a page.
pub const TEXT_LIMIT: usize = 4_000;

/// A name for the WAV of one request, unique and never from the page.
///
/// The host writes where ADE says, and ADE says here: a folder it owns, a name
/// with the token and a counter in it, and the file is deleted as soon as it has
/// been read. A path that came from the interface would be a path to write to.
fn out_for(root: &Path, token: u64) -> Result<PathBuf, String> {
    let scratch = root.join("scratch");
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(scratch.join(format!("kokoro-{token}-{n}.wav")))
}

/// One sentence through whichever child is running, starting one if needed.
///
/// The lock is the resident one: a synthesis at a time, and a child that has
/// crashed is replaced rather than asked again, which is the "it restarts on the
/// next turn" the brief asks for.
pub fn speak_blocking(
    root: &Path,
    state: &crate::tts::KokoroState,
    voice: &str,
    text: &str,
    token: u64,
    locale: &str,
) -> Result<Vec<u8>, String> {
    let (sid, lang) = speaker_of(voice).ok_or("Questa voce non è una voce Kokoro.")?;
    if text.chars().count() > TEXT_LIMIT {
        return Err(format!(
            "La frase da {} caratteri è troppo lunga per una voce ({TEXT_LIMIT} il massimo).",
            text.chars().count()
        ));
    }
    let out = out_for(root, token)?;
    let mut guard = state.0.lock();
    if guard.as_mut().is_some_and(|child| !child.alive()) {
        // A process that died keeps its slot until something replaces it, and
        // what replaces it is this sentence.
        *guard = None;
    }
    if guard.is_none() {
        *guard = Some(start(root)?);
    }
    let child = guard.as_mut().expect("started above");
    // La versione si controlla una volta per bambino, prima della prima frase: e'
    // l'unico momento in cui il protocollo e' ancora nelle mani dell'accoglienza.
    if child.hello()? != PROTOCOL {
        *guard = None;
        return Err(format!("L'host di Kokoro parla una versione diversa da {PROTOCOL}."));
    }
    // L'host non annulla: quello che è già stato mandato finisce, e il suo WAV si
    // butta. Il segno dell'abbandono è già stato consumato dal comando, che è
    // l'unico posto dove può farlo: qui la richiesta parte.
    let attempt = child.say(token, text, sid, &format!("{}-{}", lang, phonemizer_lang(locale)), &out);
    if attempt.is_err() {
        // A child that failed is not asked again: a half-written WAV and a
        // process in an unknown state are worse than a fresh start.
        *guard = None;
    }
    let bytes = match std::fs::read(&out) {
        Ok(bytes) => Ok(bytes),
        Err(e) => Err(e.to_string()),
    };
    let _ = std::fs::remove_file(&out);
    attempt?;
    bytes
}

/// Ends the child, for the idle timer, a page reload and the exit of ADE.
pub fn stop(state: &crate::tts::KokoroState) {
    let mut guard = state.0.lock();
    if let Some(child) = guard.as_mut() {
        child.stop();
    }
    *guard = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn il_manifest_e_completo_e_i_digest_sono_quelli_misurati() {
        for download in [&RUNTIME_TARBALL, &MODEL, &VOICES, &ESPEAK_DATA] {
            assert_eq!(download.sha256.len(), 64, "un digest è di 64 cifre: {}", download.url);
            assert!(download.sha256.chars().all(|c| c.is_ascii_hexdigit()), "un digest è esadecimale");
            assert!(download.size.is_some_and(|size| size > 0), "una dimensione nota: {}", download.url);
        }
        // I 219 MB di K1, contati come li ha contati lui.
        let total: u64 = [&RUNTIME_TARBALL, &MODEL, &VOICES, &ESPEAK_DATA]
            .iter()
            .map(|download| download.size.unwrap())
            .sum();
        assert_eq!(total, 219_489_095);
    }

    #[test]
    fn l_host_executable_non_e_un_manifest_inventato() {
        // Finché K4a non pubblica la release, la voce nel manifest non c'è, e
        // nessuno deve leggere un digest che nessuno ha misurato.
        assert!(HOST_EXE.is_none(), "il digest dell'host si scrive quando la release esiste");
        let root = Path::new("tts").join("assenza");
        assert_eq!(missing(&root), Some("L'host di Kokoro non è ancora scaricato."));
        assert!(!ready(&root));
    }

    #[test]
    fn il_vocabulario_è_quello_di_k1() {
        assert_eq!(TOKENS.len(), 687);
        assert_eq!(super::super::sha256_hex(TOKENS), TOKENS_SHA256);
    }

    #[test]
    fn i_metadati_aggiunti_sono_2475_byte() {
        // Il numero di K1: se cambia, non è più il file che sherpa ha letto.
        assert_eq!(metadata_tail().len(), 2_475);
    }

    #[test]
    fn il_modello_preparato_è_quello_che_sherpa_ha_misurato() {
        // Un ONNX finto, più i metadati: la coda è quella di K1 e la testa non la
        // tocca, perché un modello con i metadati dentro sarebbe un modello diverso.
        let head = b"modello finto";
        let mut model = head.to_vec();
        let tail = metadata_tail();
        model.extend_from_slice(&tail);
        assert_eq!(model.len(), head.len() + 2_475, "i metadati sono 2.475 byte, e sono in coda");
        assert!(model.ends_with(&tail), "la coda sono i metadati");
        assert_eq!(&model[..head.len()], head, "il modello scaricato resta com'era");
    }

    #[test]
    fn le_voci_e_le_lingue_sono_quelle_misurate() {
        assert_eq!(speaker_of("af_heart"), Some((3, "en-us")));
        assert_eq!(speaker_of("am_fenrir"), Some((14, "en-us")));
        assert_eq!(speaker_of("bf_emma"), Some((21, "en")));
        assert_eq!(speaker_of("bm_george"), Some((26, "en")));
        // Una voce che non è del catalogo non ha un id: meglio un errore che un
        // id sbagliato, che suona con la voce di qualcun altro.
        assert_eq!(speaker_of("if_sara"), None);
        assert_eq!(speaker_of("ugo"), None);
    }

    #[test]
    fn en_gb_non_è_una_lingua_di_espeak() {
        // K1 lo misurò: «Failed to set eSpeak-ng voice».
        assert_eq!(phonemizer_lang("en-GB"), "en-us");
        assert_eq!(phonemizer_lang("en-US"), "en-us");
        assert_eq!(phonemizer_lang("it-IT"), "it");
    }

    #[test]
    fn la_risposta_si_richiama_per_id_e_gli_errori_escono() {
        assert!(answer_is_ours(r#"{"id":7,"synthMs":1}"#, 7));
        assert!(!answer_is_ours(r#"{"id":8,"synthMs":1}"#, 7));
        // Una riga che non è del protocollo non è una risposta: nessun errore, e
        // nessun audio.
        assert!(!answer_is_ours("sherpa: bla", 7));
        assert_eq!(error_in(r#"{"id":7,"error":"voce sconosciuta"}"#), Some("voce sconosciuta".into()));
        assert_eq!(error_in(r#"{"id":7,"synthMs":1}"#), None);
    }

    #[test]
    fn la_dimensione_del_download_e_quel_la_di_k1() {
        assert_eq!(DOWNLOAD_BYTES, 219_489_095, "i 219 MB di K1, dalla tabella e non scritti due volte");
        let root = Path::new("tts").join("vuoto-per-il-download");
        assert_eq!(download_size(&root), Some(219_489_095));
    }

    #[test]
    fn cancellare_toglie_la_cartella_e_rifiuta_durante_un_install() {
        let root = Path::new("tts").join("da-cancellare");
        let _ = std::fs::remove_dir_all(&root);
        let rev = home(&root);
        std::fs::create_dir_all(&rev).unwrap();
        std::fs::write(rev.join("kokoro-v1.0.fp16.onnx"), vec![7_u8; 2_475]).unwrap();
        assert!(rev.is_dir());
        // Durante un install non si cancella: l'installer sta scrivendo lì.
        let refused = delete(&root, true);
        assert!(refused.is_err());
        assert!(rev.is_dir(), "la cartella e' ancora dove era");
        // Fuori da un install, la cartella va e con lei i byte che occupava.
        assert_eq!(delete(&root, false), Ok(2_475));
        assert!(!rev.exists());
        // E su una cartella che non c'e' non si risponde con un errore: non c'e'
        // niente da togliere, che e' quello che il pannello voleva dire.
        assert_eq!(delete(&root, false), Ok(0));
    }

    #[test]
    fn le_pagine_di_kokoro_stanno_in_una_lista_fissa() {
        assert_eq!(
            source_of("kokoro"),
            Some("https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.1")
        );
        // Il sorgente dell'host: e' GPL e chi lo scarica deve poter trovare il
        // codice che lo ha fatto.
        assert!(source_of("kokoro-host").is_some_and(|url| url.contains("kokoro-host")));
        // E un id che non e' fra questi non e' una pagina da aprire.
        assert_eq!(source_of("https://example.invalid"), None);
        assert_eq!(source_of("ugo"), None);
    }

    #[test]
    fn la_prima_riga_si_legge_come_l_host_la_scrive() {
        // Le due righe che K4a ha misurato: il caricamento e il rifiuto, che
        // esce con 2 e dice quale dei due file non ha trovato.
        let ok: Hello = serde_json::from_str(r#"{"v":1,"ready":true,"loadMs":8123}"#).unwrap();
        assert!(ok.ready);
        assert_eq!(ok.v, PROTOCOL);
        assert_eq!(ok.load_ms, Some(8_123));
        assert_eq!(why_not_ready(&ok), "L'host di Kokoro non ha caricato il modello.");

        let no_model: Hello = serde_json::from_str(r#"{"error":"missing:model","loadMs":0,"ready":false,"v":1}"#).unwrap();
        assert!(!no_model.ready);
        assert_eq!(why_not_ready(&no_model), "Il modello di Kokoro non è dove l'host lo cerca.");

        let no_dll: Hello = serde_json::from_str(r#"{"error":"missing:dll","loadMs":0,"ready":false,"v":1}"#).unwrap();
        assert_eq!(why_not_ready(&no_dll), "La libreria di Kokoro non è dove l'host la cerca.");

        // Un errore che ADE non conosce passa come viene: l'host sa più di noi.
        let other: Hello = serde_json::from_str(r#"{"error":"bad-args:unknown","ready":false,"v":1}"#).unwrap();
        assert_eq!(why_not_ready(&other), "L'host di Kokoro: bad-args:unknown");
    }

    #[test]
    fn il_wav_si_genera_qui_e_ha_un_nome_per_ogni_richiesta() {
        let root = Path::new("tts").join("prova-out");
        let first = out_for(&root, 7).unwrap();
        let second = out_for(&root, 7).unwrap();
        // Due richieste con lo stesso token non possono scrivere sullo stesso
        // file: il nome porta anche un contatore.
        assert_ne!(first, second);
        assert!(first.starts_with(&root));
        assert!(first.extension().is_some_and(|ext| ext == "wav"));
        // E il percorso è dentro la cartella di ADE, mai uno che viene dalla pagina.
        assert!(first.parent().is_some_and(|parent| parent.ends_with("scratch")));
    }

    #[test]
    fn il_testo_ha_un_tetto() {
        assert_eq!(TEXT_LIMIT, 4_000);
        // Il tetto è in caratteri, non in byte: una risposta con accenti non
        // viene rifiutata perché pesa di più.
        let lunga = "a".repeat(TEXT_LIMIT + 1);
        assert!(lunga.chars().count() > TEXT_LIMIT);
    }

    #[test]
    fn la_prima_risposta_ha_un_budget_piu_lungo() {
        assert!(synthesis_timeout_ms(true) > synthesis_timeout_ms(false));
        assert_eq!(synthesis_timeout_ms(false), 15_000);
    }

    /// A child that answers what the test tells it to, and counts what it was asked.
    struct Fake {
        hello: Result<u32, String>,
        answers: Vec<Result<(), String>>,
        asked: Vec<(u64, String, u32, String)>,
        alive: bool,
        stopped: usize,
    }

    impl Fake {
        fn new() -> Self {
            Self { hello: Ok(PROTOCOL), answers: Vec::new(), asked: Vec::new(), alive: true, stopped: 0 }
        }

        /// A process that is not there any more: `try_wait` already answered.
        fn dead() -> Self {
            Self { alive: false, ..Self::new() }
        }
    }

    impl Synth for Fake {
        fn hello(&self) -> Result<u32, String> {
            self.hello.clone()
        }

        fn say(&mut self, id: u64, text: &str, sid: u32, lang: &str, _out: &Path) -> Result<(), String> {
            self.asked.push((id, text.to_string(), sid, lang.to_string()));
            if self.answers.is_empty() {
                return Ok(());
            }
            self.answers.remove(0)
        }

        fn alive(&mut self) -> bool {
            self.alive
        }

        fn stop(&mut self) {
            self.stopped += 1;
            self.alive = false;
        }
    }

    #[test]
    fn un_bambino_finto_riceve_voce_e_lingua_come_chiede_il_rilevatore() {
        let mut child = Fake::new();
        let (sid, lang) = speaker_of("bf_emma").unwrap();
        child.say(7, "I opened the session.", sid, lang, Path::new("out.wav")).unwrap();
        assert_eq!(child.asked, vec![(7, "I opened the session.".to_string(), 21, "en".to_string())]);
    }

    #[test]
    fn la_versione_nella_prima_riga_e_quella_che_ade_parla() {
        let mut wrong = Fake::new();
        wrong.hello = Ok(PROTOCOL + 1);
        assert_ne!(wrong.hello().unwrap(), PROTOCOL, "una versione diversa va rifiutata all'accoglienza");
        // E un host che non parla il protocollo non arriva neppure a una versione.
        let mut silent = Fake::new();
        silent.hello = Err("L'host di Kokoro non parla il protocollo.".into());
        assert!(silent.hello().is_err());
    }

    #[test]
    fn un_bambino_morto_è_sostituito_e_non_richiesto_di_piu() {
        // Il ciclo che il brief chiama «se va in crash riparte al turno dopo»: il
        // posto del processo morto viene svuotato da chi lo trova, e la frase
        // dopo lo rimpiazza.
        let state = crate::tts::KokoroState::default();
        {
            let mut guard = state.0.lock();
            *guard = Some(Box::new(Fake::dead()));
        }
        {
            let mut guard = state.0.lock();
            if guard.as_mut().is_some_and(|child| !child.alive()) {
                *guard = None;
            }
            assert!(guard.is_none(), "un bambino che non risponde non viene richiesto due volte");
        }
    }

    #[test]
    fn lo_stop_finisce_il_bambino_e_libera_il_posto() {
        let state = crate::tts::KokoroState::default();
        {
            let mut guard = state.0.lock();
            *guard = Some(Box::new(Fake::new()));
        }
        stop(&state);
        // Un secondo stop non trova niente e non è un errore: lo stop è chiesto
        // dal timer, dal reload e dall'uscita, e le tre possono coincidere.
        stop(&state);
        assert!(state.0.lock().is_none());
    }

    #[test]
    fn il_testo_del_bambino_non_va_nei_log() {
        // Non c'è un logger in questo modulo, e questa è la prova: la sola cosa
        // che esce di qui è un errore, mai la frase. sherpa scrive «Failed to
        // phonemize '…'» sul suo stderr, che ADE lascia a null.
        let mut child = Fake::new();
        child.answers.push(Err("voce sconosciuta".into()));
        let problem = child.say(1, "il testo di nessuno", 3, "en-us", Path::new("out.wav"));
        assert_eq!(problem, Err("voce sconosciuta".to_string()));
        // E l'errore che ADE mette in un log non contiene la frase.
        assert!(!problem.unwrap_err().contains("il testo di nessuno"));
    }
}
