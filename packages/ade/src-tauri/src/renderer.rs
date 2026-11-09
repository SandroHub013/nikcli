/*
 * What ADE does when WebView2 loses one of its processes.
 *
 * ADE's page is the only owner of the agents: it holds their panes, their ids and their listeners (`pty::Registry`).
 * When the renderer crashed nothing said so: the window went blank and every session ran on headless until the user
 * quit from the tray (RS2-4). A reload is what F5 does: the page load ends the old sessions and the new page resumes
 * them, at the price of the turn each agent was in.
 *
 * Only for a crash of the page itself. A frame's renderer is a site in the browser pane, and an unresponsive renderer
 * is a flood the page may well come out of, so those are left alone.
 */
use std::time::{Duration, Instant};

use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
};
use webview2_com::ProcessFailedEventHandler;

const BROWSER_PROCESS_EXITED: i32 = COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED.0;
const RENDER_PROCESS_EXITED: i32 = COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED.0;

/// How many reloads a crashing page gets inside `RELOAD_WINDOW`: a page that crashes as it loads must not loop for ever.
const MOST_RELOADS: usize = 3;
const RELOAD_WINDOW: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AfterFailure {
    Reload,
    /// The page will not come back: nothing is left to own the sessions, so they end.
    GiveUp,
    Nothing,
}

pub(crate) fn after_failure(_kind: i32, _recent: &mut Vec<Instant>, _now: Instant) -> AfterFailure {
    AfterFailure::Nothing
}

#[cfg(test)]
mod tests {
    use super::*;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE, COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
    };

    fn at(start: Instant, seconds: u64) -> Instant {
        start + Duration::from_secs(seconds)
    }

    #[test]
    fn a_crashed_page_is_reloaded() {
        assert_eq!(after_failure(RENDER_PROCESS_EXITED, &mut Vec::new(), Instant::now()), AfterFailure::Reload);
    }

    #[test]
    fn the_fourth_crash_in_five_minutes_gives_up() {
        let mut recent = Vec::new();
        let start = Instant::now();
        for seconds in [0, 60, 120] {
            assert_eq!(after_failure(RENDER_PROCESS_EXITED, &mut recent, at(start, seconds)), AfterFailure::Reload);
        }
        assert_eq!(after_failure(RENDER_PROCESS_EXITED, &mut recent, at(start, 180)), AfterFailure::GiveUp);
    }

    #[test]
    fn only_the_last_five_minutes_count() {
        let mut recent = Vec::new();
        let start = Instant::now();
        for seconds in [0, 60, 120] {
            assert_eq!(after_failure(RENDER_PROCESS_EXITED, &mut recent, at(start, seconds)), AfterFailure::Reload);
        }
        // The first has left the window, so there is room for one more, and only one.
        assert_eq!(after_failure(RENDER_PROCESS_EXITED, &mut recent, at(start, 301)), AfterFailure::Reload);
        assert_eq!(after_failure(RENDER_PROCESS_EXITED, &mut recent, at(start, 302)), AfterFailure::GiveUp);
    }

    #[test]
    fn with_the_browser_process_gone_a_reload_cannot_work() {
        assert_eq!(after_failure(BROWSER_PROCESS_EXITED, &mut Vec::new(), Instant::now()), AfterFailure::GiveUp);
    }

    #[test]
    fn a_site_in_the_browser_pane_and_a_busy_page_are_left_alone() {
        for kind in [
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        ] {
            let mut recent = Vec::new();
            assert_eq!(after_failure(kind.0, &mut recent, Instant::now()), AfterFailure::Nothing);
            assert!(recent.is_empty(), "it used up a reload");
        }
    }

    #[test]
    fn the_window_is_watched() {
        assert!(include_str!("lib.rs").contains("renderer::watch(&window);"));
    }
}
