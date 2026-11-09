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

/// What to do about a failed process of `kind`, given the reloads of the crashes before it.
pub(crate) fn after_failure(kind: i32, recent: &mut Vec<Instant>, now: Instant) -> AfterFailure {
    match kind {
        BROWSER_PROCESS_EXITED => AfterFailure::GiveUp,
        RENDER_PROCESS_EXITED => {
            recent.retain(|at| now.duration_since(*at) < RELOAD_WINDOW);
            if recent.len() < MOST_RELOADS {
                recent.push(now);
                AfterFailure::Reload
            } else {
                AfterFailure::GiveUp
            }
        }
        _ => AfterFailure::Nothing,
    }
}

/// Hears of the window's failed processes for as long as it lives.
pub(crate) fn watch(window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let result = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let mut recent = Vec::new();
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            let reloaded = match after_failure(kind.0, &mut recent, Instant::now()) {
                AfterFailure::Nothing => return Ok(()),
                AfterFailure::GiveUp => false,
                // The page load that follows ends the old sessions (`on_page_load`).
                AfterFailure::Reload => sender.is_some_and(|page| page.Reload().is_ok()),
            };
            if !reloaded {
                eprintln!("ADE: la pagina non si riprende (processo di tipo {}): chiudo le sessioni", kind.0);
                crate::page_gone(&app);
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(error) = core.add_ProcessFailed(&handler, &mut token) {
            eprintln!("ADE: crash della pagina non sorvegliati: {error}");
        }
    });
    if let Err(error) = result {
        eprintln!("ADE: crash della pagina non sorvegliati: {error}");
    }
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

    // Inbound chat messages went on to a dead page, and the streams to `ragu serve` to channels nobody reads.
    #[test]
    fn giving_up_does_what_a_page_load_does() {
        let lib = include_str!("lib.rs");
        let gone = lib.split("fn page_gone(").nth(1).expect("the common step").split("
}").next().unwrap();
        for step in [
            "pty::Registry>().end_all_in_background()",
            "gateway::Gateway>().page_loading()",
            "serve_proxy::Requests>().abort_all()",
        ] {
            assert!(gone.contains(step), "{step}");
        }
        assert!(lib.contains("page_gone(window.app_handle())"));
        assert!(include_str!("renderer.rs").contains(concat!("crate::page_gone", "(&app)")));
    }

    #[test]
    fn the_window_is_watched() {
        assert!(include_str!("lib.rs").contains("renderer::watch(&window);"));
    }
}
