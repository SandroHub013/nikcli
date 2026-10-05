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
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TASKDIALOG_FLAGS, TD_WARNING_ICON,
    };

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
            config
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

#[cfg(test)]
mod tests {
    use super::*;

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
