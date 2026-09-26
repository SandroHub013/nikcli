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
//! One ADE per identity (`single_instance`): opened again while it sits in
//! the tray, it brings the window back rather than start a second gateway on
//! the same bots, which would answer every message twice.
//!
//! Hiding is said, not done behind the user's back (G11 review, M1): the
//! page is asked first (`ade-window-hide-requested`). With agent sessions at
//! work it asks whether to keep them, close them, or not hide at all; the
//! first time without, it says once that ADE stays in the tray. Hidden, the
//! page closes always-on listening (`ade-window-hidden`), and the tray's name
//! says a gateway keeps ADE open. A page that does not answer within
//! `ASK_TIMEOUT` is not waited for: the window hides, as the gateway needs.
//!
//! The tray has two items: Apri, and Esci, which goes through the same close
//! the window's X had before, the page's question about running sessions
//! included. The test build's tray has its own icon (the bundle's, from
//! `tauri.test.conf.json`) and its own name, «ADE Test» and the worktree's
//! label, as its window.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

const MENU_OPEN: &str = "ade-tray-open";
const MENU_QUIT: &str = "ade-tray-quit";

/// How long the page has to take up a hide before the window hides anyway.
const ASK_TIMEOUT: Duration = Duration::from_secs(4);

/// The tray's state: Esci chosen, the hide the page is asked about, its name.
#[derive(Default)]
pub struct Tray {
    /// The user asked to quit from the tray: the next close is a real one.
    quitting: AtomicBool,
    /// The hide the page was asked about and has not taken up; 0 for none.
    asked: AtomicU64,
    count: AtomicU64,
    /// The window's name, the tray's tooltip while the window is on screen.
    title: Mutex<String>,
}

impl Tray {
    /// A new hide for the page to take up; the one before, if any, is dropped.
    pub(crate) fn ask(&self) -> u64 {
        let id = self.count.fetch_add(1, Ordering::SeqCst) + 1;
        self.asked.store(id, Ordering::SeqCst);
        id
    }

    /// Takes up the hide `id`: true once, for whoever comes first, the page
    /// or the timeout; false for one taken already or replaced by a newer one.
    pub(crate) fn take(&self, id: u64) -> bool {
        id != 0 && self.asked.compare_exchange(id, 0, Ordering::SeqCst, Ordering::SeqCst).is_ok()
    }

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

/// The tray's tooltip: the window's name, and while the window is hidden what
/// keeps ADE open, since a tray icon is all there is to see.
pub(crate) fn tray_tooltip(title: &str, hidden: bool) -> String {
    if hidden {
        format!("{title} · gateway acceso")
    } else {
        title.to_owned()
    }
}

/// The tray's id: one per product, so ADE Test's is never the official one's.
pub(crate) fn tray_id(identifier: &str) -> String {
    format!("{identifier}.tray")
}

/// Whether this ADE is the only one of its identity: a second start of it
/// brings the first one's window forward and ends. The official ADE and ADE
/// Test have different identifiers, so they never stop each other. Always for
/// the official build; a test build only when asked (`ADE_SINGLE_INSTANCE=1`),
/// since every worktree's ADE Test shares one identifier and runs beside the
/// others.
pub(crate) fn single_instance(identifier: &str, asked: Option<&str>) -> bool {
    !identifier.ends_with(".test") || asked == Some("1")
}

fn set_tooltip(app: &AppHandle, hidden: bool) {
    let title = app.state::<Tray>().title.lock().map(|title| title.clone()).unwrap_or_default();
    if let Some(tray) = app.tray_by_id(&tray_id(&app.config().identifier)) {
        let _ = tray.set_tooltip(Some(tray_tooltip(&title, hidden)));
    }
}

/// The main window, back on screen and in front. The page hears of it, and
/// always-on listening may come back (`voice/listen-guard.ts`).
pub(crate) fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        set_tooltip(app, false);
        let _ = app.emit("ade-window-shown", ());
    }
}

/// The window off screen, ADE in the tray; the page closes the microphone.
pub(crate) fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = window.hide() {
            eprintln!("ADE: la finestra non si nasconde: {err}");
            return;
        }
        set_tooltip(app, true);
        let _ = app.emit("ade-window-hidden", ());
    }
}

#[derive(Clone, serde::Serialize)]
struct HideRequest {
    #[serde(rename = "requestId")]
    request_id: u64,
}

/// The X with a gateway on: the page decides (`ade_tray_take`, then
/// `ade_hide_to_tray`, or nothing when the user keeps the window). A page
/// that does not take it up in time is not waited for.
pub(crate) fn request_hide(app: &AppHandle) {
    let id = app.state::<Tray>().ask();
    if app.emit("ade-window-hide-requested", HideRequest { request_id: id }).is_err() {
        if app.state::<Tray>().take(id) {
            hide_main(app);
        }
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ASK_TIMEOUT);
        if app.state::<Tray>().take(id) {
            eprintln!("ADE: la pagina non ha risposto entro {ASK_TIMEOUT:?}, la finestra va nella tray");
            hide_main(&app);
        }
    });
}

/// The page takes up the hide `request_id` it was asked about: true when it is
/// its to decide, false when the timeout already hid the window.
#[tauri::command]
pub fn ade_tray_take(tray: tauri::State<'_, Tray>, request_id: u64) -> bool {
    tray.take(request_id)
}

/// The page's decision: the window goes to the tray.
#[tauri::command]
pub fn ade_hide_to_tray(app: AppHandle) {
    hide_main(&app);
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
    if let Ok(mut kept) = app.state::<Tray>().title.lock() {
        *kept = title.to_owned();
    }
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
    fn one_official_ade_and_as_many_test_ones_as_worktrees_unless_asked() {
        assert!(single_instance("ai.nikcli.ade", None));
        assert!(single_instance("ai.nikcli.ade", Some("0")), "l'ufficiale è sempre una sola");
        assert!(!single_instance("ai.nikcli.ade.test", None), "le ADE Test delle cartelle girano insieme");
        assert!(!single_instance("ai.nikcli.ade.test", Some("0")));
        assert!(single_instance("ai.nikcli.ade.test", Some("1")));
    }

    /* G11 review, M1: the page is asked first, and the timeout hides only a hide nobody took up. */
    #[test]
    fn a_hide_is_taken_up_once_by_the_page_or_the_timeout() {
        let tray = Tray::default();
        let first = tray.ask();
        assert!(tray.take(first), "la pagina lo prende");
        assert!(!tray.take(first), "poi il tempo scaduto non nasconde di nuovo");
        let stale = tray.ask();
        let newer = tray.ask();
        assert!(!tray.take(stale), "una richiesta sostituita non vale più");
        assert!(tray.take(newer));
        assert!(!tray.take(0));
    }

    #[test]
    fn the_tray_says_a_gateway_keeps_ade_open_only_while_hidden() {
        assert_eq!(tray_tooltip("ADE", false), "ADE");
        assert_eq!(tray_tooltip("ADE", true), "ADE · gateway acceso");
        assert_eq!(tray_tooltip("ADE Test · lavoro-1", true), "ADE Test · lavoro-1 · gateway acceso");
    }

    /*
     * G11 review, BASSO 2: on Linux the tray loads libayatana-appindicator at
     * run time and panics without it, at every start. The packages ask for it.
     */
    #[test]
    fn the_linux_packages_ask_for_the_tray_library() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let depends = |format: &str| config["bundle"]["linux"][format]["depends"].as_array().cloned().unwrap_or_default();
        assert!(depends("deb").iter().any(|d| d == "libayatana-appindicator3-1"), "{:?}", depends("deb"));
        assert!(depends("rpm").iter().any(|d| d == "libayatana-appindicator-gtk3"), "{:?}", depends("rpm"));
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
