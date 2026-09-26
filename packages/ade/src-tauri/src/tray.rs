//! ADE in the tray (G11): closing the window while a bot's gateway is on
//! hides it, and the process stays, so the chats still reach their bots.
//!
//! The turns and the CLIs' parsers live in the page, not in Rust: the page
//! must keep running with the window hidden, and it does (see
//! `ade-team/results/g11-tray.md` for WebView2's timers). With no gateway on,
//! closing the window is what it always was: ADE ends, and every process it
//! started with it — sessions left running where no one sees them would
//! spend on the user's accounts.
//!
//! The tray has two items: Apri, and Esci, which goes through the same close
//! the window's X had before, the page's question about running sessions
//! included. The test build's tray has its own icon (the bundle's, from
//! `tauri.test.conf.json`) and its own name, «ADE Test» and the worktree's
//! label, as its window.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const MENU_OPEN: &str = "ade-tray-open";
const MENU_QUIT: &str = "ade-tray-quit";

/// Whether the user asked to quit from the tray: the next close of the
/// window is a real one, not a hide.
#[derive(Default)]
pub struct Tray {
    quitting: AtomicBool,
}

impl Tray {
    pub(crate) fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    /// Esci was chosen; `false` again when the page's question is answered no.
    pub(crate) fn set_quitting(&self, quitting: bool) {
        self.quitting.store(quitting, Ordering::SeqCst);
    }
}

/// Whether closing the window hides it instead: a gateway is on, and the
/// user did not choose Esci.
pub(crate) fn hides_on_close(gateway_on: bool, quitting: bool) -> bool {
    gateway_on && !quitting
}

/// The tray's id: one per product, so ADE Test's is never the official one's.
pub(crate) fn tray_id(identifier: &str) -> String {
    format!("{identifier}.tray")
}

/// The main window, back on screen and in front.
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Esci: the window comes back, and its close goes through the page as the
/// X did before the tray: a question when sessions are running, then ADE ends.
fn quit(app: &AppHandle) {
    app.state::<Tray>().set_quitting(true);
    match app.get_webview_window("main") {
        Some(window) => {
            show_main(app);
            if window.close().is_err() {
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

/// The tray icon, with its name as tooltip (`title`, the window's).
pub(crate) fn install(app: &AppHandle, title: &str) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Apri", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, MENU_QUIT, "Esci", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &exit])?;
    let mut builder = TrayIconBuilder::with_id(tray_id(&app.config().identifier))
        .tooltip(title)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main(app),
            MENU_QUIT => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    // The bundle's icon: the test build's is its own (`tauri.test.conf.json`).
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_hides_only_while_a_gateway_is_on_and_esci_was_not_chosen() {
        assert!(hides_on_close(true, false));
        assert!(!hides_on_close(false, false), "senza gateway la X chiude ADE come prima");
        assert!(!hides_on_close(true, true), "Esci chiude davvero");
        assert!(!hides_on_close(false, true));
    }

    #[test]
    fn the_test_build_has_a_tray_of_its_own() {
        assert_eq!(tray_id("ai.nikcli.ade"), "ai.nikcli.ade.tray");
        assert_ne!(tray_id("ai.nikcli.ade.test"), tray_id("ai.nikcli.ade"));
    }

    #[test]
    fn esci_is_remembered_until_the_page_says_no() {
        let tray = Tray::default();
        assert!(!tray.quitting());
        tray.set_quitting(true);
        assert!(tray.quitting());
        tray.set_quitting(false);
        assert!(!tray.quitting());
    }
}
