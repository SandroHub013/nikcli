// SPDX-License-Identifier: GPL-3.0-or-later
//! The Kokoro host: a process ADE starts with the runtime on its command
//! line, and then speaks to in JSON lines over stdin and stdout.

use std::io::Write;
use std::path::PathBuf;
use std::time::Instant;

use kokoro_host::protocol;
use kokoro_host::sherpa::EngineConfig;

/// Eight threads was what K1 measured as fastest; 16 bought almost nothing and
/// 2 or 4 fell under the gate. `--threads` overrides it.
const DEFAULT_THREADS: i32 = 8;

/// Every flag this program answers to, in the order the command line takes
/// them. Anything else is turned away without being named, because a token in
/// the wrong place is as likely to be somebody's path as a misspelling.
const FLAGS: &[&str] = &[
    "--dll",
    "--model",
    "--voices",
    "--tokens",
    "--espeak-data",
    "--lexicon",
    "--dict-dir",
    "--lang",
    "--threads",
];

fn main() {
    let started = Instant::now();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let config = match parse_args() {
        Ok(config) => config,
        Err(code) => startup_failure(&mut out, started, &code),
    };

    #[cfg(windows)]
    run(started, out, config);

    #[cfg(not(windows))]
    {
        let _ = config;
        startup_failure(&mut out, started, "unsupported-platform");
    }
}

/// Say the load failed on the first line, then leave with status 2 having said
/// nothing else: no usage text, and no path, because neither belongs on the
/// wire.
fn startup_failure<W: Write>(out: &mut W, started: Instant, code: &str) -> ! {
    let load_ms = started.elapsed().as_millis() as u64;
    writeln!(out, "{}", protocol::failed_line(load_ms, code)).ok();
    out.flush().ok();
    std::process::exit(2);
}

#[cfg(windows)]
fn run<W: Write>(started: Instant, mut out: W, config: EngineConfig) -> ! {
    let mut engine = match kokoro_host::sherpa::load(&config) {
        Ok(engine) => engine,
        Err(error) => startup_failure(&mut out, started, &error.code()),
    };
    let ready = protocol::ready_line(
        started.elapsed().as_millis() as u64,
        engine.sample_rate(),
        kokoro_host::mem_snapshot(),
    );
    let default_lang = config.lang.clone();

    let stdin = std::io::stdin();
    let _ = kokoro_host::serve(
        stdin.lock(),
        &mut out,
        &mut engine,
        &ready,
        &default_lang,
    );

    // stdin closed: the caller is gone, and that is how this ends.
    std::process::exit(0);
}

fn parse_args() -> Result<EngineConfig, String> {
    parse_from(std::env::args().skip(1))
}

fn parse_from<I>(arguments: I) -> Result<EngineConfig, String>
where
    I: IntoIterator<Item = String>,
{
    let arguments: Vec<String> = arguments.into_iter().collect();

    let mut dll: Option<PathBuf> = None;
    let mut model: Option<PathBuf> = None;
    let mut voices: Option<PathBuf> = None;
    let mut tokens: Option<PathBuf> = None;
    let mut espeak_data: Option<PathBuf> = None;
    let mut lexicon: Option<PathBuf> = None;
    let mut dict_dir: Option<PathBuf> = None;
    let mut lang = protocol::LANG_US.to_string();
    let mut threads = DEFAULT_THREADS;

    let mut index = 0;
    while index < arguments.len() {
        let flag = arguments[index].as_str();
        if matches!(flag, "--help" | "-h") {
            return Err("usage".to_string());
        }
        if !FLAGS.contains(&flag) {
            return Err("bad-args:unknown".to_string());
        }
        let Some(value) = arguments.get(index + 1) else {
            return Err(format!("bad-args:{}", bare(flag)));
        };
        match flag {
            "--dll" => dll = Some(PathBuf::from(value)),
            "--model" => model = Some(PathBuf::from(value)),
            "--voices" => voices = Some(PathBuf::from(value)),
            "--tokens" => tokens = Some(PathBuf::from(value)),
            "--espeak-data" => espeak_data = Some(PathBuf::from(value)),
            "--lexicon" => lexicon = Some(PathBuf::from(value)),
            "--dict-dir" => dict_dir = Some(PathBuf::from(value)),
            "--lang" => lang = value.clone(),
            "--threads" => {
                threads = value
                    .parse::<i32>()
                    .map_err(|_| format!("bad-args:{}", bare(flag)))?
            }
            _ => return Err("bad-args:unknown".to_string()),
        }
        index += 2;
    }

    if !(1..=256).contains(&threads) {
        return Err("bad-args:threads".to_string());
    }
    let lang = match protocol::normalize_lang(&lang) {
        Some(lang) => lang.to_string(),
        None => return Err("bad-lang".to_string()),
    };

    Ok(EngineConfig {
        dll: dll.ok_or_else(|| "missing:dll".to_string())?,
        model: model.ok_or_else(|| "missing:model".to_string())?,
        voices: voices.ok_or_else(|| "missing:voices".to_string())?,
        tokens: tokens.ok_or_else(|| "missing:tokens".to_string())?,
        espeak_data: espeak_data.ok_or_else(|| "missing:espeak-data".to_string())?,
        lexicon,
        dict_dir,
        lang,
        threads,
    })
}

/// What a flag is called once its `--` is taken off: one of `FLAGS`, and so
/// never a path or anything else the caller put next to it.
fn bare(flag: &str) -> &str {
    flag.strip_prefix("--").unwrap_or(flag)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUIRED: &[&str] = &[
        "--dll",
        "runtime\\sherpa-onnx-c-api.dll",
        "--model",
        "model\\model.fp16.onnx",
        "--voices",
        "model\\voices.bin",
        "--tokens",
        "model\\tokens.txt",
        "--espeak-data",
        "model\\espeak-ng-data",
    ];

    fn parse(extra: &[&str]) -> Result<EngineConfig, String> {
        let mut all: Vec<String> = REQUIRED.iter().map(|s| s.to_string()).collect();
        all.extend(extra.iter().map(|s| s.to_string()));
        parse_from(all)
    }

    fn without(flag: &str) -> Result<EngineConfig, String> {
        let mut all: Vec<String> = Vec::new();
        let mut skip = false;
        for token in REQUIRED {
            if skip {
                skip = false;
                continue;
            }
            if *token == flag {
                skip = true;
                continue;
            }
            all.push(token.to_string());
        }
        parse_from(all)
    }

    #[test]
    fn every_required_argument_reaches_the_config() {
        let config = parse(&[]).expect("all of them are there");
        assert_eq!(config.dll, PathBuf::from("runtime\\sherpa-onnx-c-api.dll"));
        assert_eq!(config.model, PathBuf::from("model\\model.fp16.onnx"));
        assert_eq!(config.voices, PathBuf::from("model\\voices.bin"));
        assert_eq!(config.tokens, PathBuf::from("model\\tokens.txt"));
        assert_eq!(
            config.espeak_data,
            PathBuf::from("model\\espeak-ng-data")
        );
        assert!(config.lexicon.is_none());
        assert!(config.dict_dir.is_none());
        assert_eq!(config.lang, "en-us");
        assert_eq!(config.threads, 8);
    }

    #[test]
    fn an_absent_argument_is_named_by_itself() {
        for flag in [
            "--dll",
            "--model",
            "--voices",
            "--tokens",
            "--espeak-data",
        ] {
            let code = without(flag).expect_err("absent").to_string();
            assert_eq!(code, format!("missing:{}", bare(flag)), "flag {flag}");
        }
    }

    #[test]
    fn with_no_arguments_at_all_the_first_one_named_is_the_dll() {
        assert_eq!(
            parse_from(Vec::<String>::new()).expect_err("empty"),
            "missing:dll"
        );
    }

    #[test]
    fn an_unknown_token_is_never_named_because_it_may_be_a_path() {
        let code = parse(&["--frobnicate", "a value that must not appear"])
            .expect_err("not a flag of ours");
        assert_eq!(code, "bad-args:unknown");
        assert!(!code.contains("a value"));

        // A flag that lost its value, so the path beside it lands where the
        // flag was expected: what came in must not come back out.
        let code = parse_from([
            "--model".to_string(),
            "model.onnx".to_string(),
            "C:\\a\\b\\model.onnx".to_string(),
        ])
        .expect_err("a path is not a flag");
        assert_eq!(code, "bad-args:unknown");
        assert!(!code.contains("model.onnx"), "the path came back out");
    }

    #[test]
    fn a_flag_with_nothing_after_it_is_named_too() {
        assert_eq!(parse(&["--threads"]).expect_err("no value"), "bad-args:threads");
        assert_eq!(parse(&["--lang"]).expect_err("no value"), "bad-args:lang");
    }

    #[test]
    fn threads_have_to_be_a_number_the_process_can_use() {
        for value in ["abc", "0", "-3", "1000", "8.5"] {
            let code = parse(&["--threads", value]).expect_err(value);
            assert_eq!(code, "bad-args:threads", "threads {value}");
        }
        assert_eq!(parse(&["--threads", "4"]).expect("fine").threads, 4);
        assert_eq!(parse(&["--threads", "1"]).expect("fine").threads, 1);
    }

    #[test]
    fn a_language_without_a_voice_is_refused_before_the_model_loads() {
        assert_eq!(parse(&["--lang", "it-it"]).expect_err("no voice"), "bad-lang");
        assert_eq!(parse(&["--lang", "fr"]).expect_err("no voice"), "bad-lang");
    }

    #[test]
    fn the_language_is_normalized_the_way_espeak_needs_it() {
        assert_eq!(parse(&["--lang", "en-GB"]).expect("british").lang, "en");
        assert_eq!(parse(&["--lang", "EN_US"]).expect("us").lang, "en-us");
        assert_eq!(parse(&["--lang", "en"]).expect("plain").lang, "en");
    }

    #[test]
    fn help_is_an_answer_not_a_crash() {
        assert_eq!(parse(&["--help"]).expect_err("help"), "usage");
        assert_eq!(parse(&["-h"]).expect_err("help"), "usage");
    }

    #[test]
    fn the_lexicon_and_the_dict_are_optional_but_named() {
        let config = parse(&["--lexicon", "a.txt", "--dict-dir", "d"])
            .expect("both are fine");
        assert_eq!(config.lexicon, Some(PathBuf::from("a.txt")));
        assert_eq!(config.dict_dir, Some(PathBuf::from("d")));
    }
}
