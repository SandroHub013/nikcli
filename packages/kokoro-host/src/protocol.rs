// SPDX-License-Identifier: GPL-3.0-or-later
//! One line in, one line out: the contract between ADE and this process.
//!
//! Nothing in here ever carries the text back. A request that will not parse
//! answers with a code, on its own line, and the loop keeps going.

use serde_json::{json, Value};

/// Carried by the first line, so a caller that speaks the wrong version stops
/// before it sends anything.
pub const PROTOCOL_VERSION: u32 = 1;

/// The two languages sherpa-onnx can be asked for, and the only two. `en-gb`
/// is not one of them: espeak inside sherpa has no `en-gb` voice and refuses
/// to set one, which is how K1 measured the failure.
pub const LANG_US: &str = "en-us";
pub const LANG_EN: &str = "en";

const DEFAULT_SPEED: f64 = 1.0;
const MIN_SPEED: f64 = 0.25;
const MAX_SPEED: f64 = 4.0;

/// A request as it arrived on one line.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub id: Value,
    pub text: String,
    pub sid: i32,
    /// Absent means "whatever this host was started with".
    pub lang: Option<String>,
    pub speed: f32,
    pub out: String,
}

/// A line that could not become a request: `code` goes back on that line.
#[derive(Debug, Clone, PartialEq)]
pub struct BadLine {
    pub id: Value,
    pub code: &'static str,
}

fn bad(id: &Value, code: &'static str) -> BadLine {
    BadLine {
        id: id.clone(),
        code,
    }
}

/// What this host will ask espeak for. Anything else has no voice behind it.
pub fn normalize_lang(raw: &str) -> Option<&'static str> {
    let folded = raw.trim().to_ascii_lowercase().replace('_', "-");
    match folded.as_str() {
        "en-us" | "en" => Some(if folded == "en" { LANG_EN } else { LANG_US }),
        // British English is spoken by espeak's plain `en`: there is no
        // `en-gb` for sherpa to set, and asking for it fails outright.
        "en-gb" | "en-uk" | "en-gb-england" => Some(LANG_EN),
        _ => None,
    }
}

/// Parse one input line. Never fails without saying which line it was and why.
pub fn parse_request(line: &str) -> Result<Request, BadLine> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Err(BadLine {
            id: Value::Null,
            code: "bad-line",
        });
    };
    let Some(object) = value.as_object() else {
        return Err(BadLine {
            id: Value::Null,
            code: "bad-line",
        });
    };

    let id = match object.get("id") {
        Some(id) => id.clone(),
        None => {
            return Err(BadLine {
                id: Value::Null,
                code: "bad-request",
            })
        }
    };

    let text = match object.get("text").and_then(Value::as_str) {
        Some(text) if !text.trim().is_empty() && !text.contains('\0') => text.to_string(),
        _ => return Err(bad(&id, "bad-request")),
    };

    let sid = match object.get("sid") {
        None | Some(Value::Null) => 0,
        Some(value) => match value.as_i64() {
            Some(sid) if (0..=i32::MAX as i64).contains(&sid) => sid as i32,
            _ => return Err(bad(&id, "bad-request")),
        },
    };

    let lang = match object.get("lang") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_str() {
            Some(raw) => match normalize_lang(raw) {
                Some(lang) => Some(lang.to_string()),
                None => return Err(bad(&id, "bad-lang")),
            },
            None => return Err(bad(&id, "bad-request")),
        },
    };

    let speed = match object.get("speed") {
        None | Some(Value::Null) => DEFAULT_SPEED as f32,
        Some(value) => match value.as_f64() {
            Some(speed) if speed.is_finite() && (MIN_SPEED..=MAX_SPEED).contains(&speed) => {
                speed as f32
            }
            _ => return Err(bad(&id, "bad-request")),
        },
    };

    let out = match object.get("out").and_then(Value::as_str) {
        Some(out) if !out.is_empty() && !out.contains('\0') => out.to_string(),
        _ => return Err(bad(&id, "bad-request")),
    };

    Ok(Request {
        id,
        text,
        sid,
        lang,
        speed,
        out,
    })
}

/// The very first line: whether the model loaded, and in how long.
pub fn ready_line(load_ms: u64, sample_rate: i32, mem: Value) -> String {
    json!({
        "v": PROTOCOL_VERSION,
        "ready": true,
        "loadMs": load_ms,
        "sampleRate": sample_rate,
        "pid": std::process::id(),
        "mem": mem,
    })
    .to_string()
}

/// What comes out instead when the model could not be loaded: the process then
/// leaves with status 2, having said nothing else.
pub fn failed_line(load_ms: u64, code: &str) -> String {
    json!({
        "v": PROTOCOL_VERSION,
        "ready": false,
        "loadMs": load_ms,
        "error": code,
    })
    .to_string()
}

/// One answered request. The text that was synthesized is not in here.
pub fn success_line(
    id: &Value,
    synth_ms: f64,
    samples: usize,
    sample_rate: i32,
    peak: f32,
    mem: Value,
) -> String {
    let audio_ms = if sample_rate > 0 {
        samples as f64 * 1000.0 / sample_rate as f64
    } else {
        0.0
    };
    let round = |value: f64, decimals: u32| {
        let factor = 10_f64.powi(decimals as i32);
        (value * factor).round() / factor
    };
    json!({
        "id": id,
        "ok": true,
        "synthMs": round(synth_ms, 2),
        "audioMs": round(audio_ms, 2),
        "samples": samples,
        "sampleRate": sample_rate,
        "peak": round(peak as f64, 4),
        "mem": mem,
    })
    .to_string()
}

/// One line that could not be answered with audio.
pub fn error_line(id: &Value, code: &str) -> String {
    json!({ "id": id, "ok": false, "error": code }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Result<Request, BadLine> {
        parse_request(line)
    }

    #[test]
    fn a_full_request_round_trips() {
        let request = parse(
            r#"{"id":7,"text":"four thousand","sid":14,"lang":"en-GB","speed":1.25,"out":"a.wav"}"#,
        )
        .expect("well formed");
        assert_eq!(request.id, json!(7));
        assert_eq!(request.text, "four thousand");
        assert_eq!(request.sid, 14);
        assert_eq!(request.lang.as_deref(), Some("en"));
        assert_eq!(request.speed, 1.25);
        assert_eq!(request.out, "a.wav");
    }

    #[test]
    fn optional_fields_fall_back_to_the_host_defaults() {
        let request = parse(r#"{"id":"x","text":"hi","out":"a.wav"}"#).expect("well formed");
        assert_eq!(request.sid, 0);
        assert!(request.lang.is_none());
        assert_eq!(request.speed, 1.0);
    }

    #[test]
    fn a_line_that_is_not_json_is_bad_line_with_no_id() {
        let bad = parse("surely not json").expect_err("not json");
        assert_eq!(bad.code, "bad-line");
        assert_eq!(bad.id, Value::Null);
    }

    #[test]
    fn a_json_scalar_is_bad_line_too() {
        assert_eq!(parse("42").expect_err("scalar").code, "bad-line");
        assert_eq!(parse("[]").expect_err("array").code, "bad-line");
    }

    #[test]
    fn no_id_is_bad_request_with_no_id_to_answer() {
        let bad = parse(r#"{"text":"hi","out":"a.wav"}"#).expect_err("no id");
        assert_eq!(bad.code, "bad-request");
        assert_eq!(bad.id, Value::Null);
    }

    #[test]
    fn every_missing_or_impossible_field_is_bad_request_and_keeps_the_id() {
        for line in [
            r#"{"id":1,"sid":0,"out":"a.wav"}"#,
            r#"{"id":1,"text":"","out":"a.wav"}"#,
            r#"{"id":1,"text":"hi","sid":-1,"out":"a.wav"}"#,
            r#"{"id":1,"text":"hi","sid":"3","out":"a.wav"}"#,
            r#"{"id":1,"text":"hi","sid":3,"lang":7,"out":"a.wav"}"#,
            r#"{"id":1,"text":"hi","sid":3,"speed":"fast","out":"a.wav"}"#,
            r#"{"id":1,"text":"hi","sid":3,"speed":99,"out":"a.wav"}"#,
            r#"{"id":1,"text":"hi","sid":3,"out":""}"#,
            r#"{"id":1,"text":"hi","sid":3}"#,
            "{\"id\":1,\"text\":\"a\\u0000b\",\"out\":\"a.wav\"}",
        ] {
            let bad = parse(line).expect_err("should not parse");
            assert_eq!(bad.code, "bad-request", "line: {line}");
            assert_eq!(bad.id, json!(1), "line: {line}");
        }
    }

    #[test]
    fn a_language_without_a_voice_is_bad_lang() {
        let bad = parse(r#"{"id":1,"text":"hi","lang":"fr-fr","out":"a.wav"}"#)
            .expect_err("no such voice");
        assert_eq!(bad.code, "bad-lang");
        assert_eq!(bad.id, json!(1));
    }

    #[test]
    fn the_languages_are_the_two_espeak_has() {
        assert_eq!(normalize_lang("en-us"), Some(LANG_US));
        assert_eq!(normalize_lang("en-US"), Some(LANG_US));
        assert_eq!(normalize_lang("EN_US"), Some(LANG_US));
        assert_eq!(normalize_lang("en"), Some(LANG_EN));
        assert_eq!(normalize_lang("en-gb"), Some(LANG_EN));
        assert_eq!(normalize_lang(" en-GB "), Some(LANG_EN));
        assert_eq!(normalize_lang("en-uk"), Some(LANG_EN));
        assert_eq!(normalize_lang("it"), None);
        assert_eq!(normalize_lang(""), None);
    }

    #[test]
    fn the_ready_line_leads_with_the_version() {
        let line = ready_line(842, 24_000, json!({"wsMiB": 1.5}));
        let value: Value = serde_json::from_str(&line).expect("one json value");
        assert_eq!(value["v"], json!(1));
        assert_eq!(value["ready"], json!(true));
        assert_eq!(value["loadMs"], json!(842));
        assert_eq!(value["sampleRate"], json!(24_000));
        assert!(value["pid"].as_u64().is_some());
        assert_eq!(value["mem"]["wsMiB"], json!(1.5));
    }

    #[test]
    fn a_failed_load_says_so_and_carries_nothing_else() {
        let line = failed_line(12, "create-failed");
        let value: Value = serde_json::from_str(&line).expect("one json value");
        assert_eq!(value["v"], json!(1));
        assert_eq!(value["ready"], json!(false));
        assert_eq!(value["error"], json!("create-failed"));
        assert_eq!(value.get("sampleRate"), None);
    }

    #[test]
    fn the_answer_carries_what_was_measured_and_nothing_about_the_text() {
        let line = success_line(&json!("r1"), 318.7654, 24_000, 24_000, 0.9123456, json!({}));
        let value: Value = serde_json::from_str(&line).expect("one json value");
        assert_eq!(value["id"], json!("r1"));
        assert_eq!(value["ok"], json!(true));
        assert_eq!(value["synthMs"], json!(318.77));
        assert_eq!(value["audioMs"], json!(1000.0));
        assert_eq!(value["samples"], json!(24_000));
        assert_eq!(value["sampleRate"], json!(24_000));
        assert_eq!(value["peak"], json!(0.9123));
        assert!(value.get("error").is_none());
    }

    #[test]
    fn an_answered_line_with_no_audio_has_a_code_and_no_measurements() {
        let value: Value =
            serde_json::from_str(&error_line(&json!(3), "write-failed")).expect("one json value");
        assert_eq!(value["id"], json!(3));
        assert_eq!(value["ok"], json!(false));
        assert_eq!(value["error"], json!("write-failed"));
        assert!(value.get("samples").is_none());
        assert!(value.get("mem").is_none());
    }

    #[test]
    fn audio_ms_is_the_length_of_the_answer() {
        let value: Value = serde_json::from_str(&success_line(
            &json!(1),
            10.0,
            48_000,
            24_000,
            1.0,
            json!({}),
        ))
        .expect("one json value");
        assert_eq!(value["audioMs"], json!(2000.0));
    }
}
