// SPDX-License-Identifier: GPL-3.0-or-later
//! Loading sherpa-onnx and asking it for speech.
//!
//! Nothing here is linked at build time. The DLL is opened at run time from
//! the path the command line gave, which is why this crate has no build
//! script, no `SHERPA_LIB`, and no idea where the runtime will end up.

use std::path::PathBuf;

/// What one synthesis produced: floats in `[-1, 1]`, ready for the WAV.
pub struct Audio {
    pub samples: Vec<f32>,
    pub sample_rate: i32,
    /// Wall clock of the sherpa call alone, in milliseconds.
    pub synth_ms: f64,
}

/// A synthesis that did not happen. `code` is what goes over the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineError {
    pub code: &'static str,
}

/// The seam the tests stand on: everything the host does after a line parses.
pub trait Engine {
    fn synth(&mut self, text: &str, sid: i32, lang: &str, speed: f32)
        -> Result<Audio, EngineError>;
}

/// Where the runtime lives, from the command line.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub dll: PathBuf,
    pub model: PathBuf,
    pub voices: PathBuf,
    pub tokens: PathBuf,
    pub espeak_data: PathBuf,
    pub lexicon: Option<PathBuf>,
    pub dict_dir: Option<PathBuf>,
    /// The language asked for when a request does not name one.
    pub lang: String,
    pub threads: i32,
}

#[cfg(windows)]
mod loader {
    use super::{Audio, Engine, EngineConfig, EngineError};
    use crate::protocol::normalize_lang;
    use std::ffi::{c_char, CStr, CString};
    use std::io;
    use std::path::Path;
    use std::time::Instant;

    /// sherpa-onnx looks for its own dependencies beside itself, and ADE puts
    /// the runtime wherever it likes, not beside this executable.
    const SEARCH_DLL_LOAD_DIR: u32 = 0x0000_0100;
    const SEARCH_DEFAULT_DIRS: u32 = 0x0000_1000;

    type HModule = *mut core::ffi::c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn LoadLibraryExW(name: *const u16, file: HModule, flags: u32) -> HModule;
        fn LoadLibraryW(name: *const u16) -> HModule;
        fn FreeLibrary(module: HModule) -> i32;
        fn GetProcAddress(module: HModule, name: *const u8) -> *const core::ffi::c_void;
    }

    // The layouts below are the sherpa-onnx v1.13 C API: the same ones K1
    // measured, field for field. They are part of the contract with the DLL.
    #[repr(C)]
    struct Vits {
        model: *const c_char,
        lexicon: *const c_char,
        tokens: *const c_char,
        data_dir: *const c_char,
        noise_scale: f32,
        noise_scale_w: f32,
        length_scale: f32,
        dict_dir: *const c_char,
    }

    #[repr(C)]
    struct Matcha {
        acoustic_model: *const c_char,
        vocoder: *const c_char,
        lexicon: *const c_char,
        tokens: *const c_char,
        data_dir: *const c_char,
        noise_scale: f32,
        length_scale: f32,
        dict_dir: *const c_char,
    }

    #[repr(C)]
    struct Kokoro {
        model: *const c_char,
        voices: *const c_char,
        tokens: *const c_char,
        data_dir: *const c_char,
        length_scale: f32,
        dict_dir: *const c_char,
        lexicon: *const c_char,
        lang: *const c_char,
    }

    #[repr(C)]
    struct Kitten {
        model: *const c_char,
        voices: *const c_char,
        tokens: *const c_char,
        data_dir: *const c_char,
        length_scale: f32,
    }

    #[repr(C)]
    struct Zipvoice {
        tokens: *const c_char,
        encoder: *const c_char,
        decoder: *const c_char,
        vocoder: *const c_char,
        data_dir: *const c_char,
        lexicon: *const c_char,
        feat_scale: f32,
        t_shift: f32,
        target_rms: f32,
        guidance_scale: f32,
    }

    #[repr(C)]
    struct Pocket {
        lm_flow: *const c_char,
        lm_main: *const c_char,
        encoder: *const c_char,
        decoder: *const c_char,
        text_conditioner: *const c_char,
        vocab_json: *const c_char,
        token_scores_json: *const c_char,
        voice_embedding_cache_capacity: i32,
    }

    #[repr(C)]
    struct Supertonic {
        duration_predictor: *const c_char,
        text_encoder: *const c_char,
        vector_estimator: *const c_char,
        vocoder: *const c_char,
        tts_json: *const c_char,
        unicode_indexer: *const c_char,
        voice_style: *const c_char,
    }

    #[repr(C)]
    struct ModelConfig {
        vits: Vits,
        num_threads: i32,
        debug: i32,
        provider: *const c_char,
        matcha: Matcha,
        kokoro: Kokoro,
        kitten: Kitten,
        zipvoice: Zipvoice,
        pocket: Pocket,
        supertonic: Supertonic,
    }

    #[repr(C)]
    struct TtsConfig {
        model: ModelConfig,
        rule_fsts: *const c_char,
        max_num_sentences: i32,
        rule_fars: *const c_char,
        silence_scale: f32,
    }

    #[repr(C)]
    struct SherpaAudio {
        samples: *const f32,
        n: i32,
        sample_rate: i32,
    }

    #[repr(C)]
    struct Tts {
        _private: [u8; 0],
    }

    #[repr(C)]
    struct GenConfig {
        silence_scale: f32,
        speed: f32,
        sid: i32,
        reference_audio: *const f32,
        reference_audio_len: i32,
        reference_sample_rate: i32,
        reference_text: *const c_char,
        num_steps: i32,
        extra: *const c_char,
    }

    type CreateFn = unsafe extern "C" fn(*const TtsConfig) -> *const Tts;
    type SampleRateFn = unsafe extern "C" fn(*const Tts) -> i32;
    type GenerateFn = unsafe extern "C" fn(
        *const Tts,
        *const c_char,
        *const GenConfig,
        *const u8,
        *const u8,
    ) -> *const SherpaAudio;
    type DestroyAudioFn = unsafe extern "C" fn(*const SherpaAudio);
    type DestroyTtsFn = unsafe extern "C" fn(*const Tts);

    /// Why the model could not come up. `code` is what goes on the wire, and
    /// it names the argument or the symbol, never the path it was given.
    #[derive(Debug)]
    pub enum LoadError {
        Missing(&'static str),
        BadPath(&'static str),
        OpenDll(io::Error),
        MissingSymbol(String),
        CreateFailed,
        BadSampleRate,
    }

    impl LoadError {
        pub fn code(&self) -> String {
            match self {
                LoadError::Missing(name) => format!("missing:{name}"),
                LoadError::BadPath(name) => format!("bad-path:{name}"),
                LoadError::OpenDll(error) => {
                    format!("open-dll:{}", error.raw_os_error().unwrap_or(-1))
                }
                LoadError::MissingSymbol(name) => format!("missing-symbol:{name}"),
                LoadError::CreateFailed => "create-failed".to_string(),
                LoadError::BadSampleRate => "bad-sample-rate".to_string(),
            }
        }
    }

    /// A loaded module that unloads itself wherever the load gives up.
    struct Module(HModule);

    impl Drop for Module {
        fn drop(&mut self) {
            unsafe { FreeLibrary(self.0) };
        }
    }

    /// The strings the C config points at. They have to outlive the tts.
    struct Strings {
        empty: CString,
        provider: CString,
        lang: CString,
        model: CString,
        voices: CString,
        tokens: CString,
        data_dir: CString,
        dict_dir: CString,
        lexicon: CString,
    }

    struct Symbols {
        generate: GenerateFn,
        destroy_audio: DestroyAudioFn,
    }

    /// The resident model, created once and spoken to one request at a time.
    pub struct SherpaEngine {
        _module: Module,
        tts: *const Tts,
        symbols: Symbols,
        destroy_tts: Option<DestroyTtsFn>,
        sample_rate: i32,
        default_lang: String,
        strings: Strings,
    }

    impl SherpaEngine {
        pub fn sample_rate(&self) -> i32 {
            self.sample_rate
        }
    }

    impl Drop for SherpaEngine {
        fn drop(&mut self) {
            if let Some(destroy_tts) = self.destroy_tts {
                unsafe { destroy_tts(self.tts) };
            }
        }
    }

    impl Engine for SherpaEngine {
        fn synth(
            &mut self,
            text: &str,
            sid: i32,
            lang: &str,
            speed: f32,
        ) -> Result<Audio, EngineError> {
            // Nothing outside sherpa ever sees the text, and a NUL would end it
            // early rather than fail, so it is turned away here.
            let text = CString::new(text).map_err(|_| EngineError {
                code: "bad-request",
            })?;
            let lang = match normalize_lang(lang) {
                Some(lang) => lang,
                None => self.default_lang.as_str(),
            };
            let extra = CString::new(serde_json::json!({ "lang": lang }).to_string())
                .map_err(|_| EngineError {
                    code: "bad-request",
                })?;
            let generation = GenConfig {
                silence_scale: 0.2,
                speed,
                sid,
                reference_audio: core::ptr::null(),
                reference_audio_len: 0,
                reference_sample_rate: 0,
                reference_text: self.strings.empty.as_ptr(),
                num_steps: 0,
                extra: extra.as_ptr(),
            };

            let started = Instant::now();
            let audio = unsafe {
                (self.symbols.generate)(
                    self.tts,
                    text.as_ptr(),
                    &generation,
                    core::ptr::null(),
                    core::ptr::null(),
                )
            };
            let synth_ms = started.elapsed().as_secs_f64() * 1000.0;
            if audio.is_null() {
                return Err(EngineError {
                    code: "synth-failed",
                });
            }

            let (samples, sample_rate) = unsafe {
                let audio = &*audio;
                let count = audio.n.max(0) as usize;
                let samples = if audio.samples.is_null() || count == 0 {
                    Vec::new()
                } else {
                    core::slice::from_raw_parts(audio.samples, count).to_vec()
                };
                (samples, audio.sample_rate)
            };
            unsafe { (self.symbols.destroy_audio)(audio) };

            Ok(Audio {
                samples,
                sample_rate,
                synth_ms,
            })
        }
    }

    /// Open the runtime and load the model. On `Err` nothing is retained: the
    /// module unloads itself as the error is returned.
    pub fn load(config: &EngineConfig) -> Result<SherpaEngine, LoadError> {
        check("model", &config.model, false)?;
        check("voices", &config.voices, false)?;
        check("tokens", &config.tokens, false)?;
        check("espeak-data", &config.espeak_data, true)?;
        check("dll", &config.dll, false)?;
        if let Some(path) = &config.lexicon {
            check("lexicon", path, false)?;
        }
        if let Some(path) = &config.dict_dir {
            check("dict-dir", path, false)?;
        }

        let strings = Strings {
            empty: plain()?,
            provider: CString::new("cpu").expect("a literal has no NUL"),
            lang: CString::new(config.lang.as_str()).map_err(|_| LoadError::BadPath("lang"))?,
            model: path_string("model", &config.model)?,
            voices: path_string("voices", &config.voices)?,
            tokens: path_string("tokens", &config.tokens)?,
            data_dir: path_string("espeak-data", &config.espeak_data)?,
            dict_dir: match &config.dict_dir {
                Some(path) => path_string("dict-dir", path)?,
                None => plain()?,
            },
            lexicon: match &config.lexicon {
                Some(path) => path_string("lexicon", path)?,
                None => plain()?,
            },
        };

        let config_c = TtsConfig {
            model: ModelConfig {
                vits: Vits {
                    model: strings.empty.as_ptr(),
                    lexicon: strings.empty.as_ptr(),
                    tokens: strings.empty.as_ptr(),
                    data_dir: strings.empty.as_ptr(),
                    noise_scale: 0.0,
                    noise_scale_w: 0.0,
                    length_scale: 0.0,
                    dict_dir: strings.empty.as_ptr(),
                },
                num_threads: config.threads.max(1),
                debug: 0,
                provider: strings.provider.as_ptr(),
                matcha: Matcha {
                    acoustic_model: strings.empty.as_ptr(),
                    vocoder: strings.empty.as_ptr(),
                    lexicon: strings.empty.as_ptr(),
                    tokens: strings.empty.as_ptr(),
                    data_dir: strings.empty.as_ptr(),
                    noise_scale: 0.0,
                    length_scale: 0.0,
                    dict_dir: strings.empty.as_ptr(),
                },
                kokoro: Kokoro {
                    model: strings.model.as_ptr(),
                    voices: strings.voices.as_ptr(),
                    tokens: strings.tokens.as_ptr(),
                    data_dir: strings.data_dir.as_ptr(),
                    length_scale: 1.0,
                    dict_dir: strings.dict_dir.as_ptr(),
                    lexicon: strings.lexicon.as_ptr(),
                    lang: strings.lang.as_ptr(),
                },
                kitten: Kitten {
                    model: strings.empty.as_ptr(),
                    voices: strings.empty.as_ptr(),
                    tokens: strings.empty.as_ptr(),
                    data_dir: strings.empty.as_ptr(),
                    length_scale: 0.0,
                },
                zipvoice: Zipvoice {
                    tokens: strings.empty.as_ptr(),
                    encoder: strings.empty.as_ptr(),
                    decoder: strings.empty.as_ptr(),
                    vocoder: strings.empty.as_ptr(),
                    data_dir: strings.empty.as_ptr(),
                    lexicon: strings.empty.as_ptr(),
                    feat_scale: 0.0,
                    t_shift: 0.0,
                    target_rms: 0.0,
                    guidance_scale: 0.0,
                },
                pocket: Pocket {
                    lm_flow: strings.empty.as_ptr(),
                    lm_main: strings.empty.as_ptr(),
                    encoder: strings.empty.as_ptr(),
                    decoder: strings.empty.as_ptr(),
                    text_conditioner: strings.empty.as_ptr(),
                    vocab_json: strings.empty.as_ptr(),
                    token_scores_json: strings.empty.as_ptr(),
                    voice_embedding_cache_capacity: 0,
                },
                supertonic: Supertonic {
                    duration_predictor: strings.empty.as_ptr(),
                    text_encoder: strings.empty.as_ptr(),
                    vector_estimator: strings.empty.as_ptr(),
                    vocoder: strings.empty.as_ptr(),
                    tts_json: strings.empty.as_ptr(),
                    unicode_indexer: strings.empty.as_ptr(),
                    voice_style: strings.empty.as_ptr(),
                },
            },
            rule_fsts: strings.empty.as_ptr(),
            max_num_sentences: 1,
            rule_fars: strings.empty.as_ptr(),
            silence_scale: 0.2,
        };

        let module = Module(open_library(&config.dll)?);

        let create: CreateFn = unsafe { symbol(module.0, c"SherpaOnnxCreateOfflineTts") }?;
        let sample_rate_of: SampleRateFn =
            unsafe { symbol(module.0, c"SherpaOnnxOfflineTtsSampleRate") }?;
        let generate: GenerateFn =
            unsafe { symbol(module.0, c"SherpaOnnxOfflineTtsGenerateWithConfig") }?;
        let destroy_audio: DestroyAudioFn =
            unsafe { symbol(module.0, c"SherpaOnnxDestroyOfflineTtsGeneratedAudio") }?;
        let destroy_tts: Option<DestroyTtsFn> =
            unsafe { symbol_optional(module.0, c"SherpaOnnxDestroyOfflineTts") }?;

        let tts = unsafe { create(&config_c) };
        if tts.is_null() {
            return Err(LoadError::CreateFailed);
        }
        let sample_rate = unsafe { sample_rate_of(tts) };
        if sample_rate <= 0 {
            if let Some(destroy_tts) = destroy_tts {
                unsafe { destroy_tts(tts) };
            }
            return Err(LoadError::BadSampleRate);
        }

        Ok(SherpaEngine {
            _module: module,
            tts,
            symbols: Symbols {
                generate,
                destroy_audio,
            },
            destroy_tts,
            sample_rate,
            default_lang: config.lang.clone(),
            strings,
        })
    }

    fn check(name: &'static str, path: &Path, directory: bool) -> Result<(), LoadError> {
        let present = if directory {
            path.is_dir()
        } else {
            path.is_file()
        };
        if present {
            Ok(())
        } else {
            Err(LoadError::Missing(name))
        }
    }

    fn plain() -> Result<CString, LoadError> {
        CString::new("").map_err(|_| LoadError::BadPath("empty"))
    }

    fn path_string(name: &'static str, path: &Path) -> Result<CString, LoadError> {
        let text = path.to_str().ok_or(LoadError::BadPath(name))?;
        CString::new(text).map_err(|_| LoadError::BadPath(name))
    }

    /// Load the runtime, keeping its dependencies bound to the copies that sit
    /// beside it rather than to the `onnxruntime.dll` Windows ships in System32.
    ///
    /// `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR` is only honoured when the path is a
    /// plain Windows path: given forward slashes the loader drops the flag
    /// without failing, finds a "sherpa" dependency by the usual order and binds
    /// the System32 copy, whose API is far too old for what sherpa asks for. ADE
    /// hands over whatever path it holds, so make it absolute and backslashed
    /// before asking for the flag.
    fn open_library(path: &Path) -> Result<HModule, LoadError> {
        use std::os::windows::ffi::OsStrExt;

        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|_| LoadError::BadPath("dll"))?
                .join(path)
        };
        let mut wide: Vec<u16> = absolute
            .as_os_str()
            .encode_wide()
            .map(|unit| if unit == u16::from(b'/') { u16::from(b'\\') } else { unit })
            .collect();
        wide.push(0);
        unsafe {
            let module =
                LoadLibraryExW(wide.as_ptr(), core::ptr::null_mut(), SEARCH_DLL_LOAD_DIR | SEARCH_DEFAULT_DIRS);
            if !module.is_null() {
                return Ok(module);
            }
            let module = LoadLibraryW(wide.as_ptr());
            if !module.is_null() {
                return Ok(module);
            }
        }
        Err(LoadError::OpenDll(io::Error::last_os_error()))
    }

    /// Resolve one of the four calls the host makes. The name is a literal and
    /// the type is one of this module's function pointers, so a misspelling
    /// fails the load rather than calling through the wrong signature.
    unsafe fn symbol<T>(module: HModule, name: &CStr) -> Result<T, LoadError> {
        let address = unsafe { GetProcAddress(module, name.as_ptr().cast()) };
        if address.is_null() {
            return Err(LoadError::MissingSymbol(
                name.to_string_lossy().into_owned(),
            ));
        }
        Ok(unsafe { resolve::<T>(address) })
    }

    unsafe fn symbol_optional<T>(module: HModule, name: &CStr) -> Result<Option<T>, LoadError> {
        let address = unsafe { GetProcAddress(module, name.as_ptr().cast()) };
        if address.is_null() {
            return Ok(None);
        }
        Ok(Some(unsafe { resolve::<T>(address) }))
    }

    unsafe fn resolve<T>(address: *const core::ffi::c_void) -> T {
        assert_eq!(
            core::mem::size_of::<T>(),
            core::mem::size_of::<*const core::ffi::c_void>(),
            "only function pointers are resolved through the loader"
        );
        unsafe { core::mem::transmute_copy::<*const core::ffi::c_void, T>(&address) }
    }
}

#[cfg(windows)]
pub use loader::{load, LoadError, SherpaEngine};

#[cfg(test)]
mod tests {
    use super::*;

    /// The command line has to name every file before anything is opened.
    fn config() -> EngineConfig {
        EngineConfig {
            dll: PathBuf::from("runtime\\sherpa-onnx-c-api.dll"),
            model: PathBuf::from("model\\model.fp16.onnx"),
            voices: PathBuf::from("model\\voices.bin"),
            tokens: PathBuf::from("model\\tokens.txt"),
            espeak_data: PathBuf::from("model\\espeak-ng-data"),
            lexicon: None,
            dict_dir: None,
            lang: "en-us".to_string(),
            threads: 8,
        }
    }

    #[test]
    fn a_config_keeps_every_path_the_command_line_named() {
        let config = config();
        assert_eq!(config.lang, "en-us");
        assert_eq!(config.threads, 8);
        assert!(config.lexicon.is_none());
        assert!(config.dict_dir.is_none());
        assert_eq!(
            config.dll.to_string_lossy(),
            "runtime\\sherpa-onnx-c-api.dll"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_missing_file_is_named_by_argument_and_not_by_path() {
        let error = match load(&config()) {
            Ok(_) => panic!("nothing here exists"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "missing:model");
        assert!(!error.code().contains('\\'), "no path on the wire");
    }

    #[cfg(windows)]
    #[test]
    fn a_dll_that_is_not_a_library_says_so_with_its_error() {
        // Cargo.toml exists, so the argument checks pass, and Windows then
        // refuses it as a module: the failure is the load, not the path.
        let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let mut config = config();
        config.dll = crate_dir.join("Cargo.toml");
        config.model = crate_dir.join("Cargo.toml");
        config.voices = crate_dir.join("Cargo.toml");
        config.tokens = crate_dir.join("Cargo.toml");
        config.espeak_data = crate_dir;
        let code = match load(&config) {
            Ok(_) => panic!("not a library"),
            Err(error) => error.code(),
        };
        assert!(
            code.starts_with("open-dll:"),
            "expected open-dll, got {code}"
        );
    }
}
