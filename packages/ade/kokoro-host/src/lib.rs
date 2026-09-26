// SPDX-License-Identifier: GPL-3.0-or-later
//! The Kokoro host, as a process of its own.
//!
//! ADE starts it, hands it the runtime on the command line, and then talks to
//! it in JSON lines: one line out says whether the model loaded, one line in
//! is one synthesis, one line out is the answer. The text it is given never
//! reaches stdout or stderr, only the WAV file the request asked for.

#![deny(unsafe_op_in_unsafe_fn)]

pub mod protocol;
pub mod sherpa;
pub mod wav;

use std::io::{self, BufRead, Write};

use protocol::Request;
use sherpa::{Engine, EngineError};

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> *mut core::ffi::c_void;
    fn K32GetProcessMemoryInfo(
        process: *mut core::ffi::c_void,
        counters: *mut ProcessMemoryCounters,
        cb: u32,
    ) -> i32;
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct ProcessMemoryCounters {
    cb: u32,
    page_faults: u32,
    peak_ws: usize,
    ws: usize,
    quota_peak_paged: usize,
    quota_paged: usize,
    quota_peak_nonpaged: usize,
    quota_nonpaged: usize,
    commit: usize,
    peak_commit: usize,
}

/// What the process is holding, in the shape K1 measured. The host has no
/// other way to tell ADE it is running out of room.
pub fn mem_snapshot() -> serde_json::Value {
    #[cfg(windows)]
    {
        use serde_json::json;
        let mut counters = ProcessMemoryCounters {
            cb: core::mem::size_of::<ProcessMemoryCounters>() as u32,
            ..Default::default()
        };
        unsafe {
            K32GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                counters.cb,
            )
        };
        let mib = |bytes: usize| ((bytes as f64 / 1_048_576.0) * 10.0).round() / 10.0;
        json!({
            "wsMiB": mib(counters.ws),
            "peakWsMiB": mib(counters.peak_ws),
            "commitMiB": mib(counters.commit),
            "peakCommitMiB": mib(counters.peak_commit),
        })
    }
    #[cfg(not(windows))]
    {
        serde_json::Value::Object(Default::default())
    }
}

/// The ready line, then one answer per line until stdin runs out or breaks.
///
/// A line that will not parse answers on its own line with `bad-line` and the
/// loop carries on; a stream that closes is a normal end, not an error.
pub fn serve<R, W, E>(
    input: R,
    output: &mut W,
    engine: &mut E,
    ready: &str,
    default_lang: &str,
) -> io::Result<()>
where
    R: BufRead,
    W: Write,
    E: Engine + ?Sized,
{
    writeln!(output, "{ready}")?;
    output.flush()?;
    for line in input.lines() {
        let Ok(line) = line else {
            return Ok(());
        };
        let answer = match protocol::parse_request(&line) {
            Ok(request) => synthesis(engine, &request, default_lang),
            Err(bad) => protocol::error_line(&bad.id, bad.code),
        };
        if writeln!(output, "{answer}").is_err() || output.flush().is_err() {
            return Ok(());
        }
    }
    Ok(())
}

/// One request, one synthesis, one WAV on disk.
fn synthesis<E>(engine: &mut E, request: &Request, default_lang: &str) -> String
where
    E: Engine + ?Sized,
{
    let lang = request.lang.as_deref().unwrap_or(default_lang);
    let audio = match engine.synth(&request.text, request.sid, lang, request.speed) {
        Ok(audio) => audio,
        Err(EngineError { code }) => return protocol::error_line(&request.id, code),
    };
    let peak = audio
        .samples
        .iter()
        .fold(0f32, |highest, sample| highest.max(sample.abs()));
    if audio.samples.is_empty() {
        return protocol::error_line(&request.id, "empty-audio");
    }
    if wav::write(&request.out, audio.sample_rate, &audio.samples).is_err() {
        return protocol::error_line(&request.id, "write-failed");
    }
    protocol::success_line(
        &request.id,
        audio.synth_ms,
        audio.samples.len(),
        audio.sample_rate,
        peak,
        mem_snapshot(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sherpa::Audio;
    use serde_json::{json, Value};

    /// Stands in for sherpa so `cargo test` runs with no DLL anywhere near it.
    struct FakeEngine {
        calls: Vec<(String, i32, String, f32)>,
        fail: bool,
        sample_rate: i32,
    }

    impl FakeEngine {
        fn new() -> Self {
            Self {
                calls: Vec::new(),
                fail: false,
                sample_rate: 24_000,
            }
        }
    }

    impl Engine for FakeEngine {
        fn synth(
            &mut self,
            text: &str,
            sid: i32,
            lang: &str,
            speed: f32,
        ) -> Result<Audio, EngineError> {
            self.calls.push((text.to_string(), sid, lang.to_string(), speed));
            if self.fail {
                return Err(EngineError {
                    code: "synth-failed",
                });
            }
            Ok(Audio {
                samples: vec![0.0, 0.5, -0.5],
                sample_rate: self.sample_rate,
                synth_ms: 7.5,
            })
        }
    }

    fn run(lines: &str, engine: &mut FakeEngine, default_lang: &str) -> Vec<Value> {
        let mut out: Vec<u8> = Vec::new();
        serve(
            io::Cursor::new(lines.as_bytes().to_vec()),
            &mut out,
            engine,
            r#"{"v":1,"ready":true,"loadMs":12}"#,
            default_lang,
        )
        .expect("serve writes to memory");
        String::from_utf8(out)
            .expect("answers are ascii json")
            .lines()
            .map(|line| serde_json::from_str(line).expect("every line is one json value"))
            .collect()
    }

    fn wav_path(name: &str) -> String {
        let dir = std::env::temp_dir();
        dir.join(format!("kokoro-host-test-{name}.wav"))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn the_first_line_is_ready_before_anything_else() {
        let mut engine = FakeEngine::new();
        let answered = run("", &mut engine, "en-us");
        assert_eq!(answered.len(), 1);
        assert_eq!(answered[0]["v"], json!(1));
        assert_eq!(answered[0]["ready"], json!(true));
        assert_eq!(answered[0]["loadMs"], json!(12));
        assert!(engine.calls.is_empty(), "stdin closed: no synthesis");
    }

    #[test]
    fn a_request_answers_and_writes_the_wav() {
        let out = wav_path("ok");
        let _ = std::fs::remove_file(&out);
        let mut engine = FakeEngine::new();
        let lines = json!({
            "id": 1,
            "text": "four thousand",
            "sid": 3,
            "lang": "en-us",
            "out": out.as_str(),
        })
        .to_string();
        let answered = run(&lines, &mut engine, "en-us");

        assert_eq!(answered.len(), 2, "ready line plus one answer");
        let answer = &answered[1];
        assert_eq!(answer["id"], json!(1));
        assert_eq!(answer["ok"], json!(true));
        assert_eq!(answer["samples"], json!(3));
        assert_eq!(answer["sampleRate"], json!(24_000));
        assert_eq!(answer["synthMs"], json!(7.5));
        assert_eq!(
            answer["audioMs"],
            json!((3.0_f64 * 1000.0 / 24_000.0 * 100.0).round() / 100.0)
        );
        assert_eq!(answer["peak"], json!(0.5));
        assert!(answer.get("error").is_none());

        let bytes = std::fs::read(&out).expect("the wav was written");
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");

        assert_eq!(
            engine.calls,
            vec![("four thousand".to_string(), 3, "en-us".to_string(), 1.0)]
        );
    }

    #[test]
    fn the_text_never_reaches_the_answer() {
        const SECRET: &str = "the number is 1.234.567,89";
        let out = wav_path("secret");
        let mut engine = FakeEngine::new();
        let lines =
            json!({"id": "a", "text": SECRET, "sid": 0, "out": out.as_str()}).to_string();
        let answered = run(&lines, &mut engine, "en-us");
        for line in &answered {
            assert!(
                !line.to_string().contains(SECRET),
                "text leaked into the protocol: {line}"
            );
        }
        assert_eq!(answered[1]["ok"], json!(true), "lang defaulted for the engine");
        assert_eq!(engine.calls[0].2, "en-us");
    }

    #[test]
    fn a_line_that_will_not_parse_answers_bad_line_and_the_loop_goes_on() {
        let mut engine = FakeEngine::new();
        let answered = run("not json at all\n", &mut engine, "en-us");
        assert_eq!(answered[1]["error"], json!("bad-line"));
        assert_eq!(answered[1]["id"], Value::Null);
        assert!(engine.calls.is_empty());
    }

    #[test]
    fn a_missing_field_is_bad_request_without_the_id_being_lost() {
        let mut engine = FakeEngine::new();
        let answered = run(r#"{"id":9,"sid":1,"out":"x.wav"}"#, &mut engine, "en-us");
        assert_eq!(answered[1]["id"], json!(9));
        assert_eq!(answered[1]["error"], json!("bad-request"));
        assert!(engine.calls.is_empty());
    }

    #[test]
    fn a_language_espeak_has_no_voice_for_never_leaves_the_host() {
        let out = wav_path("lang");
        let mut engine = FakeEngine::new();
        let lines =
            json!({"id": 1, "text": "hello", "lang": "en-gb", "out": out.as_str()}).to_string();
        let answered = run(&lines, &mut engine, "en-us");
        assert_eq!(answered[1]["ok"], json!(true));
        assert_eq!(engine.calls[0].2, "en", "en-gb becomes en, as K1 measured");
    }

    #[test]
    fn a_sherpa_failure_comes_back_as_its_own_code() {
        let mut engine = FakeEngine::new();
        engine.fail = true;
        let lines = r#"{"id":4,"text":"hello","out":"nope.wav"}"#;
        let answered = run(lines, &mut engine, "en-us");
        assert_eq!(answered[1]["id"], json!(4));
        assert_eq!(answered[1]["error"], json!("synth-failed"));
        assert!(answered[1].get("samples").is_none());
    }

    #[test]
    fn a_wav_that_cannot_be_written_says_so_and_the_host_keeps_serving() {
        let mut engine = FakeEngine::new();
        // A directory that is not there, under the temporary directory, so the
        // test does not depend on where it was started from.
        let nowhere = std::env::temp_dir()
            .join("kokoro-host-test-no-such-directory")
            .join("x.wav");
        let lines = json!({"id": 1, "text": "hello", "out": nowhere.to_string_lossy()}).to_string();
        let answered = run(&lines, &mut engine, "en-us");
        assert_eq!(answered[1]["error"], json!("write-failed"));
        assert_eq!(answered.len(), 2, "the process did not give up");
    }

    #[test]
    fn an_empty_answer_is_an_error_and_no_file_appears() {
        let out = wav_path("empty");
        let _ = std::fs::remove_file(&out);
        struct Silent;
        impl Engine for Silent {
            fn synth(
                &mut self,
                _text: &str,
                _sid: i32,
                _lang: &str,
                _speed: f32,
            ) -> Result<Audio, EngineError> {
                Ok(Audio {
                    samples: Vec::new(),
                    sample_rate: 24_000,
                    synth_ms: 1.0,
                })
            }
        }
        let mut engine = Silent;
        let lines = json!({"id": 1, "text": "hello", "out": out.as_str()}).to_string();
        let mut answer: Vec<u8> = Vec::new();
        serve(
            io::Cursor::new(lines.into_bytes()),
            &mut answer,
            &mut engine,
            r#"{"v":1,"ready":true,"loadMs":1}"#,
            "en-us",
        )
        .unwrap();
        let lines: Vec<Value> = String::from_utf8(answer)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines[1]["error"], json!("empty-audio"));
        assert!(!std::path::Path::new(&out).exists());
    }

    #[test]
    fn two_requests_are_answered_in_the_order_they_came() {
        let mut engine = FakeEngine::new();
        let lines = format!(
            "{}\n{}",
            json!({"id": 1, "text": "one", "out": wav_path("order-1")}).to_string(),
            json!({"id": 2, "text": "two", "out": wav_path("order-2")}).to_string()
        );
        let answered = run(&lines, &mut engine, "en-us");
        assert_eq!(answered.len(), 3);
        assert_eq!(answered[1]["id"], json!(1));
        assert_eq!(answered[2]["id"], json!(2));
        assert_eq!(engine.calls.len(), 2);
    }
}
