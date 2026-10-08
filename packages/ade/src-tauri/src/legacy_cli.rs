//! nikcli became ragu. A user can update ADE before the CLI, so until [`UNTIL`] ADE also works with the
//! nikcli of before the rename: it looks for `ragu` and then for `nikcli`, it reads either readiness line,
//! and it gives every setting under both names (`RAGU_X` and `NIKCLI_X`). The one place this lives; the
//! CLI's side is `packages/ragu/src/util/legacy-env.ts`, with the same date.
//!
//! Temporary: removed by [`UNTIL`] with its callers. A test fails from that day until it is.

/// The day this module goes, as `YYYY-MM-DD`; read by the test that enforces it.
#[cfg_attr(not(test), allow(dead_code))]
pub const UNTIL: &str = "2026-12-01";
/// [`UNTIL`] at 00:00 UTC, in seconds since the epoch.
#[cfg_attr(not(test), allow(dead_code))]
const UNTIL_UNIX: u64 = 1_796_083_200;

const NEW: &str = "ragu";
const OLD: &str = "nikcli";
const NEW_ENV: &str = "RAGU_";
const OLD_ENV: &str = "NIKCLI_";
const LISTENING: &str = " server listening";

/// The CLI on PATH, through `which`: `ragu`, else the `nikcli` of before the rename.
pub fn which_cli(which: impl Fn(&str) -> Option<String>) -> Option<String> {
    which(NEW).or_else(|| which(OLD))
}

/// `command` resolved through `which`; `ragu` falls back to `nikcli` like [`which_cli`].
pub fn resolve(command: &str, which: impl Fn(&str) -> Option<String>) -> Option<String> {
    if command.eq_ignore_ascii_case(NEW) {
        which_cli(which)
    } else {
        which(command)
    }
}

/// Whether a command's stem (no directory, no extension) names the CLI, under either name.
pub fn is_cli_stem(stem: &str) -> bool {
    stem.eq_ignore_ascii_case(NEW) || stem.eq_ignore_ascii_case(OLD)
}

/// Whether `line` is the CLI's readiness line, `ragu server listening …` or `nikcli server listening …`.
pub fn is_ready_line(line: &str) -> bool {
    [NEW, OLD].iter().any(|name| line.strip_prefix(name).is_some_and(|rest| rest.starts_with(LISTENING)))
}

/// `RAGU_X` and `NIKCLI_X`, for a setting named `RAGU_X`.
pub fn env_names(name: &str) -> [String; 2] {
    let rest = name.strip_prefix(NEW_ENV).unwrap_or(name);
    [format!("{NEW_ENV}{rest}"), format!("{OLD_ENV}{rest}")]
}

/// A setting `RAGU_X` read through `get`: its own value, else `NIKCLI_X`'s.
pub fn var_with<T>(name: &str, get: impl Fn(&str) -> Option<T>) -> Option<T> {
    let [new, old] = env_names(name);
    get(&new).or_else(|| get(&old))
}

/// [`var_with`] on the process environment.
pub fn var(name: &str) -> Option<String> {
    var_with(name, |key| std::env::var(key).ok())
}

/// [`var_with`] on the process environment, as an `OsString`.
pub fn var_os(name: &str) -> Option<std::ffi::OsString> {
    var_with(name, |key| std::env::var_os(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on_path(names: &'static [&'static str]) -> impl Fn(&str) -> Option<String> {
        move |name| names.contains(&name).then(|| format!("/bin/{name}"))
    }

    #[test]
    fn ragu_first_then_the_nikcli_of_before_the_rename() {
        assert_eq!(which_cli(on_path(&["ragu", "nikcli"])), Some("/bin/ragu".into()));
        assert_eq!(which_cli(on_path(&["nikcli"])), Some("/bin/nikcli".into()));
        assert_eq!(which_cli(on_path(&[])), None);
    }

    #[test]
    fn only_ragu_falls_back() {
        assert_eq!(resolve("ragu", on_path(&["nikcli"])), Some("/bin/nikcli".into()));
        assert_eq!(resolve("claude", on_path(&["nikcli"])), None);
        assert_eq!(resolve("claude", on_path(&["claude"])), Some("/bin/claude".into()));
    }

    #[test]
    fn either_name_is_the_cli() {
        for stem in ["ragu", "RAGU", "nikcli", "NikCli"] {
            assert!(is_cli_stem(stem), "{stem}");
        }
        for stem in ["ragu-island", "nikcli-island", "claude", ""] {
            assert!(!is_cli_stem(stem), "{stem}");
        }
    }

    #[test]
    fn either_readiness_line() {
        assert!(is_ready_line("ragu server listening on http://127.0.0.1:1"));
        assert!(is_ready_line("nikcli server listening on http://127.0.0.1:1"));
        assert!(!is_ready_line("opencode server listening on http://127.0.0.1:1"));
        assert!(!is_ready_line("ragu server started"));
    }

    #[test]
    fn a_setting_under_both_names() {
        assert_eq!(env_names("RAGU_CONFIG_CONTENT"), ["RAGU_CONFIG_CONTENT".to_string(), "NIKCLI_CONFIG_CONTENT".to_string()]);
    }

    #[test]
    fn the_new_name_wins_and_the_old_one_fills_in() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| pairs.iter().find(|(name, _)| *name == key).map(|(_, value)| value.to_string())
        };
        assert_eq!(var_with("RAGU_CONFIG", env(&[("RAGU_CONFIG", "a"), ("NIKCLI_CONFIG", "b")])), Some("a".into()));
        assert_eq!(var_with("RAGU_CONFIG", env(&[("NIKCLI_CONFIG", "b")])), Some("b".into()));
        assert_eq!(var_with("RAGU_CONFIG", env(&[])), None);
    }

    #[test]
    fn this_module_is_gone_by_its_date() {
        assert_eq!(UNTIL, "2026-12-01");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        assert!(now < UNTIL_UNIX, "legacy_cli.rs had to be removed by {UNTIL}, with its callers and legacy-env.ts");
    }
}
