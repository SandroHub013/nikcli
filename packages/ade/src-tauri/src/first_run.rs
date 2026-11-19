//! Switches that show ADE's first-run cases on a PC that already has everything.
//!
//! ADE has to work on a new PC: when something is missing, the user sees a message with the next step. The PC the
//! team tests on has the screenshots folder, an agent CLI and a voice set up, so `bun run test:app --first-run=...`
//! sets `ADE_TEST_FIRST_RUN` to a comma list and the test build behaves as if these were missing:
//!
//! - `no-screenshots`: Windows has not made its Screenshots folder yet (it appears at the first Win+PrintScreen).
//! - `no-agents`: no agent CLI is installed, `ragu` and `nikcli` included.
//! - `no-voice`: voice is not set up; the voice key is not read (the page side is `src/host/first-run.ts`).
//! - `all`: the three.
//!
//! The variable is read only by the test build (`cfg(feature = "test-exe")`). In the official build the read, and the
//! name of the variable, are not compiled: `on` is a constant `false`. A switch changes what is answered, never what
//! is on the disk: nothing is created, moved or deleted, and no key is opened.

/// The name of the variable: compiled in the test build only, so the official binary does not even carry it.
#[cfg(feature = "test-exe")]
const ENV: &str = "ADE_TEST_FIRST_RUN";

/// Whether `name` is in the comma list `value` (`all` is every switch). Spaces and case do not matter.
#[cfg_attr(not(any(test, feature = "test-exe")), allow(dead_code))]
fn listed(value: &str, name: &str) -> bool {
    value
        .split(',')
        .map(str::trim)
        .any(|item| item.eq_ignore_ascii_case(name) || item.eq_ignore_ascii_case("all"))
}

/// Whether the switch `name` is on. Always `false` outside the test build, without reading the environment.
#[cfg(feature = "test-exe")]
pub fn on(name: &str) -> bool {
    std::env::var(ENV).map(|value| listed(&value, name)).unwrap_or(false)
}

/// Whether the switch `name` is on. Always `false` outside the test build, without reading the environment.
#[cfg(not(feature = "test-exe"))]
pub const fn on(_name: &str) -> bool {
    false
}

/// A Screenshots folder that does not exist and that nothing creates: what `no-screenshots` says Windows has not
/// made yet. Under the instance's own temp folder, so it is the test's and nobody else's.
#[cfg_attr(not(feature = "test-exe"), allow(dead_code))]
pub fn missing_screenshots_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("ade-first-run").join("Screenshots")
}

/// Runs `run` with the variable set to `value`, one test at a time: the environment is the process's, and the tests
/// of every module share it.
#[cfg(all(test, feature = "test-exe"))]
pub(crate) fn with_switches<T>(value: &str, run: impl FnOnce() -> T) -> T {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _held = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::env::set_var(ENV, value);
    let out = run();
    std::env::remove_var(ENV);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_switch_is_found_in_the_comma_list() {
        assert!(listed("no-screenshots,no-agents,no-voice", "no-agents"));
        assert!(listed(" no-voice , no-agents ", "no-voice"));
        assert!(listed("NO-AGENTS", "no-agents"));
        assert!(!listed("no-agents", "no-voice"));
        assert!(!listed("", "no-voice"));
        assert!(!listed("no-agents-at-all", "no-agents"));
    }

    #[test]
    fn all_is_every_switch() {
        for name in ["no-screenshots", "no-agents", "no-voice"] {
            assert!(listed("all", name));
        }
    }

    #[test]
    fn the_missing_screenshots_folder_is_not_on_the_disk() {
        assert!(!missing_screenshots_dir().exists());
    }

    /// The official build: the variable is set and the answer is still no. The read is not compiled there, so there
    /// is nothing for it to ignore.
    #[cfg(not(feature = "test-exe"))]
    #[test]
    fn the_official_build_ignores_the_variable() {
        // A name written out: the constant is not compiled here.
        std::env::set_var("ADE_TEST_FIRST_RUN", "all");
        for name in ["no-screenshots", "no-agents", "no-voice"] {
            assert!(!on(name), "{name} must be off outside the test build");
        }
        std::env::remove_var("ADE_TEST_FIRST_RUN");
    }

    /// The test build: each switch answers from the variable, and only the ones it lists.
    #[cfg(feature = "test-exe")]
    #[test]
    fn the_test_build_reads_the_variable() {
        with_switches("no-agents,no-voice", || {
            assert!(on("no-agents"));
            assert!(on("no-voice"));
            assert!(!on("no-screenshots"));
        });
        with_switches("", || assert!(!on("no-agents")));
    }

    /// The variable is named once, behind the test feature: no other source file reads it.
    #[test]
    fn the_variable_is_read_only_behind_the_test_feature() {
        let source = include_str!("first_run.rs");
        let name_at = source.find("const ENV: &str").expect("the const");
        let gate_at = source[..name_at].rfind("#[cfg(feature = \"test-exe\")]").expect("its gate");
        assert!(name_at - gate_at < 200, "the const must sit right under the gate");
        let read_at = source.find("std::env::var(ENV)").expect("the read");
        let read_gate = source[..read_at].rfind("#[cfg(feature = \"test-exe\")]").expect("its gate");
        assert!(read_at - read_gate < 200, "the read must sit right under the gate");
    }
}
