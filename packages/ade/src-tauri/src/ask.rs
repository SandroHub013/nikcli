//! A yes/no question to the user whose default button is «No».
//!
//! The dialog plugin's `ask` opens a Windows `TaskDialog` whose default is the first
//! button, «Yes» (`nDefaultButton: 0`), and offers no way to choose another. A key that
//! reached the question by chance — Enter, Space, a click on the window's icon while the
//! question stood hidden behind a minimised ADE — answered «Yes» to «close anyway?».
//! Turning the buttons round with the plugin's own custom labels does not help: it
//! reports a dismissed dialog (Esc, the window's ✕) as the *second* button, so Esc
//! would become «Yes». So the question is asked here, with two buttons of our own:
//!
//! - «Yes» is `1000` and «No» is `1001`, the ids the dialog plugin's backend (rfd) gives
//!   its buttons, so the helpers that click `TDM_CLICK_BUTTON 1000` still mean «yes»;
//! - the default is «No»;
//! - the answer is «yes» only when the button pressed is `1000`. A dismissed dialog
//!   (`IDCANCEL`), an error, any other id: «no».
//!
//! Windows only. The page asks through the plugin everywhere else.

/// The button that answers «yes».
pub const BUTTON_YES: i32 = 1000;
/// The button that answers «no», and the one Enter presses.
pub const BUTTON_NO: i32 = 1001;
/// What a dismissed dialog reports (Esc, the window's ✕): `IDCANCEL`.
#[cfg_attr(not(test), allow(dead_code))]
pub const BUTTON_DISMISSED: i32 = 2;
/// `TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT`: Esc and ✕ close it, and it fits its text.
pub const DIALOG_FLAGS: i32 = 8 | 0x0100_0000;

/// True only when the button pressed is «yes».
pub fn answer_of(button: i32) -> bool {
    button == BUTTON_YES
}

#[cfg(windows)]
mod native {
    use super::{answer_of, BUTTON_NO, BUTTON_YES, DIALOG_FLAGS};
    use std::sync::Mutex;
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, S_OK, WPARAM};
    use windows::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TASKDIALOG_FLAGS, TASKDIALOG_NOTIFICATIONS, TDN_CREATED,
        TDN_DESTROYED, TD_WARNING_ICON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetWindow, IsWindow, SetForegroundWindow, GW_OWNER};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The strings and buttons the dialog points at, kept alive while it is open.
    pub struct Spec {
        title: Vec<u16>,
        message: Vec<u16>,
        yes: Vec<u16>,
        no: Vec<u16>,
    }

    impl Spec {
        pub fn new(title: &str, message: &str, yes: &str, no: &str) -> Self {
            Spec { title: wide(title), message: wide(message), yes: wide(yes), no: wide(no) }
        }

        /// The buttons, «Yes» first as the system lays them out, with the ids above.
        pub fn buttons(&self) -> [TASKDIALOG_BUTTON; 2] {
            [
                TASKDIALOG_BUTTON { nButtonID: BUTTON_YES, pszButtonText: PCWSTR(self.yes.as_ptr()) },
                TASKDIALOG_BUTTON { nButtonID: BUTTON_NO, pszButtonText: PCWSTR(self.no.as_ptr()) },
            ]
        }

        /// The configuration, over `parent`; `buttons` must outlive it.
        pub fn config(&self, parent: HWND, buttons: &[TASKDIALOG_BUTTON; 2]) -> TASKDIALOGCONFIG {
            let mut config = TASKDIALOGCONFIG::default();
            config.cbSize = std::mem::size_of::<TASKDIALOGCONFIG>() as u32;
            config.hwndParent = parent;
            config.dwFlags = TASKDIALOG_FLAGS(DIALOG_FLAGS);
            config.pszWindowTitle = PCWSTR(self.title.as_ptr());
            config.pszContent = PCWSTR(self.message.as_ptr());
            // The task dialog's own warning mark.
            config.Anonymous1.pszMainIcon = TD_WARNING_ICON;
            config.cButtons = buttons.len() as u32;
            config.pButtons = buttons.as_ptr();
            config.nDefaultButton = BUTTON_NO;
            // So `front` knows which window is the question.
            config.pfCallback = Some(on_event);
            config
        }
    }

    /// The questions that are open, by window: pushed when the dialog is created, dropped when it is
    /// destroyed. `front` takes its window from here instead of guessing which popup the window owns.
    static OPEN: Mutex<Vec<isize>> = Mutex::new(Vec::new());

    fn open_list() -> std::sync::MutexGuard<'static, Vec<isize>> {
        // A panic while the list is held leaves it usable: it is only handles.
        OPEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Records a question's window as open.
    pub fn opened(dialog: isize) {
        let mut open = open_list();
        if !open.contains(&dialog) {
            open.push(dialog);
        }
    }

    /// Forgets a question's window.
    pub fn closed(dialog: isize) {
        open_list().retain(|open| *open != dialog);
    }

    /// The dialog tells when it is created and destroyed; the hwnd it passes is the question's own.
    unsafe extern "system" fn on_event(
        dialog: HWND,
        notification: TASKDIALOG_NOTIFICATIONS,
        _wparam: WPARAM,
        _lparam: LPARAM,
        _data: isize,
    ) -> HRESULT {
        if notification == TDN_CREATED {
            opened(dialog.0 as isize);
        } else if notification == TDN_DESTROYED {
            closed(dialog.0 as isize);
        }
        S_OK
    }

    /// The window of the question open over `parent`, the newest first, or none.
    ///
    /// Only a dialog this module opened counts, and only one `parent` owns and that still exists:
    /// another window `parent` owns (a file picker, say) is never taken for the question. Not
    /// required to be visible: with the window just back from the icon, the question shows a moment
    /// after it does.
    pub fn question_of(parent: isize) -> Option<isize> {
        let owner = HWND(parent as *mut core::ffi::c_void);
        let open = open_list().clone();
        open.into_iter().rev().find(|dialog| {
            let dialog = HWND(*dialog as *mut core::ffi::c_void);
            // SAFETY: both calls take a handle and read no memory of ours; a stale handle makes them fail.
            unsafe { IsWindow(Some(dialog)).as_bool() && GetWindow(dialog, GW_OWNER).is_ok_and(|found| found == owner) }
        })
    }

    /// Gives the foreground to the question that is open over `parent`, and says whether there was one.
    ///
    /// The question is modal, so `parent` is disabled while it stands: focusing the window (what
    /// `unminimize` and `setFocus` do) leaves the foreground on a window that ignores every key, and
    /// an answer from the keyboard needs a click first.
    pub fn front(parent: isize) -> bool {
        match question_of(parent) {
            // SAFETY: a handle in, nothing read; the system may refuse the foreground, and that is «false».
            Some(dialog) => unsafe { SetForegroundWindow(HWND(dialog as *mut core::ffi::c_void)) }.as_bool(),
            None => false,
        }
    }

    /// Opens the question over `parent` and waits for the answer. Any failure is «no».
    pub fn ask(parent: isize, title: &str, message: &str, yes: &str, no: &str) -> bool {
        let spec = Spec::new(title, message, yes, no);
        let buttons = spec.buttons();
        let config = spec.config(HWND(parent as *mut core::ffi::c_void), &buttons);
        let mut pressed: i32 = 0;
        // SAFETY: `config` points into `spec` and `buttons`, both alive until the call returns.
        let result = unsafe { TaskDialogIndirect(&config, Some(&mut pressed), None, None) };
        match result {
            Ok(()) => answer_of(pressed),
            Err(_) => false,
        }
    }
}

/// Asks `message` over this window, with «No» as the default button. True only on «yes».
#[tauri::command]
pub async fn ade_ask(
    window: tauri::WebviewWindow,
    message: String,
    title: String,
    yes: String,
    no: String,
) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let parent = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        // Opened on a thread of its own, as the dialog plugin does: it blocks until answered.
        tauri::async_runtime::spawn_blocking(move || native::ask(parent, &title, &message, &yes, &no))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, message, title, yes, no);
        Err("ade_ask is for Windows: the page asks through the dialog plugin elsewhere".to_string())
    }
}

/// Brings the open question to the front, so a key answers it at once. False when none is open.
#[tauri::command]
pub async fn ade_ask_front(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let parent = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        Ok(native::front(parent))
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn with_no_question_open_there_is_nothing_to_bring_forward() {
        // No window at all, and a handle that is not one: both say «no question», without a panic.
        assert!(!native::front(0));
        assert!(!native::front(1));
        assert_eq!(native::question_of(0), None);
    }

    /// Real windows, made on the test's thread: `GetWindow` and `IsWindow` need no message loop.
    #[cfg(windows)]
    mod windows_of_the_test {
        use windows::core::w;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_OVERLAPPED, WS_POPUP,
        };

        /// A top-level window, or a popup owned by `owner`.
        pub fn make(owner: Option<HWND>) -> HWND {
            let style = if owner.is_some() { WS_POPUP } else { WS_OVERLAPPED };
            // SAFETY: the STATIC class is the system's own; the handle is destroyed by the test.
            unsafe { CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), w!("prova"), style, 0, 0, 10, 10, owner, None, None, None) }
                .expect("a test window")
        }

        pub fn destroy(window: HWND) {
            // SAFETY: a window this test made.
            let _ = unsafe { DestroyWindow(window) };
        }

        pub fn id(window: HWND) -> isize {
            window.0 as isize
        }
    }

    /// B3 of the review: the positive case. The question is found by the owner it was opened over.
    #[cfg(windows)]
    #[test]
    fn the_open_question_is_found_by_the_window_that_owns_it() {
        use windows_of_the_test::{destroy, id, make};
        let owner = make(None);
        let question = make(Some(owner));
        native::opened(id(question));
        assert_eq!(native::question_of(id(owner)), Some(id(question)));
        // Closed (the dialog's destroy notice): no question any more.
        native::closed(id(question));
        assert_eq!(native::question_of(id(owner)), None);
        destroy(question);
        destroy(owner);
    }

    /// B1 of the review: a popup the window owns that is not one of ours is never taken for the question.
    #[cfg(windows)]
    #[test]
    fn another_popup_of_the_window_is_not_the_question() {
        use windows_of_the_test::{destroy, id, make};
        let owner = make(None);
        let picker = make(Some(owner));
        // Owned and enabled, but never registered as a question: not taken.
        assert_eq!(native::question_of(id(owner)), None);
        assert!(!native::front(id(owner)));
        // With the question open as well, it is the question, not the picker, whichever was made first.
        let question = make(Some(owner));
        native::opened(id(question));
        assert_eq!(native::question_of(id(owner)), Some(id(question)));
        native::closed(id(question));
        destroy(question);
        destroy(picker);
        destroy(owner);
    }

    #[cfg(windows)]
    #[test]
    fn a_question_over_another_window_or_already_gone_is_not_found() {
        use windows_of_the_test::{destroy, id, make};
        let (first, second) = (make(None), make(None));
        let question = make(Some(first));
        native::opened(id(question));
        // Owned by the first window, so not the second's.
        assert_eq!(native::question_of(id(second)), None);
        assert_eq!(native::question_of(id(first)), Some(id(question)));
        // A window destroyed without the notice (a crash of the dialog) is skipped, not trusted.
        destroy(question);
        assert_eq!(native::question_of(id(first)), None);
        native::closed(id(question));
        destroy(first);
        destroy(second);
    }

    #[cfg(windows)]
    #[test]
    fn the_dialog_reports_when_it_is_created() {
        let spec = native::Spec::new("ADE", "Close anyway?", "Yes", "No");
        let buttons = spec.buttons();
        let config = spec.config(windows::Win32::Foundation::HWND(std::ptr::null_mut()), &buttons);
        // Copied out of the packed struct before it is compared.
        let callback = config.pfCallback;
        assert!(callback.is_some(), "without it `front` cannot tell which window is the question");
    }

    #[test]
    fn only_the_yes_button_answers_yes() {
        assert!(answer_of(BUTTON_YES));
        assert!(!answer_of(BUTTON_NO));
        // Esc and the window's ✕, an error's zero, a stray id: all «no».
        for button in [BUTTON_DISMISSED, 0, -1, 1, 6, 7, 1002, i32::MAX] {
            assert!(!answer_of(button), "button {button} must not answer yes");
        }
    }

    #[test]
    fn the_ids_are_the_dialog_plugins_so_helpers_that_click_1000_still_mean_yes() {
        assert_eq!(BUTTON_YES, 1000);
        assert_eq!(BUTTON_NO, 1001);
        assert_ne!(BUTTON_NO, BUTTON_DISMISSED);
    }

    #[test]
    fn the_dialog_can_be_dismissed_and_fits_its_text() {
        assert_eq!(DIALOG_FLAGS & 8, 8, "TDF_ALLOW_DIALOG_CANCELLATION");
        assert_eq!(DIALOG_FLAGS & 0x0100_0000, 0x0100_0000, "TDF_SIZE_TO_CONTENT");
    }

    #[cfg(windows)]
    #[test]
    fn the_configuration_defaults_to_no_with_the_two_buttons_in_order() {
        use windows::Win32::Foundation::HWND;
        let spec = native::Spec::new("ADE", "Close anyway?", "Yes", "No");
        let buttons = spec.buttons();
        let config = spec.config(HWND(std::ptr::null_mut()), &buttons);
        // Packed fields are copied out before they are compared.
        let default = config.nDefaultButton;
        let count = config.cButtons;
        let flags = config.dwFlags.0;
        assert_eq!(default, BUTTON_NO, "Enter presses «No»");
        assert_eq!(count, 2);
        assert_eq!(flags, DIALOG_FLAGS);
        let (first, second) = (buttons[0].nButtonID, buttons[1].nButtonID);
        assert_eq!((first, second), (BUTTON_YES, BUTTON_NO));
        // The cbSize is the struct's own, which the system checks.
        let size = config.cbSize;
        assert_eq!(size as usize, std::mem::size_of::<windows::Win32::UI::Controls::TASKDIALOGCONFIG>());
    }
}
