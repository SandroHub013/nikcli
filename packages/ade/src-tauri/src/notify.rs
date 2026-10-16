//! A system notification (the Windows toast) for a bot that waits for the user: `system_notify(title, body)`.
//!
//! Why a command of our own and not the notification plugin's `notify`: the page would need the plugin's permission,
//! and with it any script in the window could post any toast, of any length, with any icon or sound. This command takes
//! two strings, makes them safe to show (`clean`: no control characters, a length a toast can hold) and nothing else, so
//! the capability file has no notification entry at all: `invoke` of an app command needs none.
//!
//! The page calls it only when ADE's window is behind (`bots/system-notify.ts`), and sends the flash of the taskbar icon
//! on its own, so a toast that cannot be shown leaves the flash.
//!
//! Identity (AUMID, the name Windows files a toast under): `tauri-plugin-notification` sets the app id to the bundle
//! `identifier` of the running build (`ai.nikcli.ade`, or `ai.nikcli.ade.test` for ADE Test) unless the executable sits
//! in a `target\debug` or `target\release` folder. There it leaves notify-rust's own default, which is PowerShell's: a
//! toast from `tauri dev` is shown as coming from PowerShell. The installer's start-menu shortcut is what registers the
//! identifier with its display name; an identifier with no shortcut still shows, under the identifier itself.
//!
//! A click on the toast does nothing: notify-rust on Windows shows it without waiting for the activation (the plugin
//! gives no click event on desktop), and a toast activation back into the process needs a registered COM activator.
//! The flash and the bell's «Apri» are what bring the user to the request.

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// The most characters of a title, and of a body: a toast cuts what is longer, and a command line can be long.
const TITLE_MAX: usize = 80;
const BODY_MAX: usize = 240;

/// The text as one line a toast can show: control characters (newlines too) become spaces, runs of spaces become one,
/// and what is longer than `max` characters is cut with an ellipsis. Cuts on characters, never inside one.
pub fn clean(text: &str, max: usize) -> String {
    let mut out = String::new();
    let mut space = true;
    for c in text.chars() {
        let c = if c.is_control() { ' ' } else { c };
        if c.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    let out = out.trim_end().to_string();
    if out.chars().count() <= max {
        return out;
    }
    let mut cut: String = out.chars().take(max.saturating_sub(1)).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// Shows the toast. An error is the page's to read: it keeps the flash.
#[tauri::command]
pub fn system_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let title = clean(&title, TITLE_MAX);
    let body = clean(&body, BODY_MAX);
    if title.is_empty() && body.is_empty() {
        return Err("empty notification".into());
    }
    app.notification()
        .builder()
        .title(if title.is_empty() { "ADE".to_string() } else { title })
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newlines_and_controls_become_one_space() {
        assert_eq!(clean("git push\n  --force\t\r\nnow\u{7}", 80), "git push --force now");
    }

    #[test]
    fn short_text_is_kept_whole() {
        assert_eq!(clean("«alfa» aspetta te", 80), "«alfa» aspetta te");
        assert_eq!(clean("   ", 80), "");
    }

    #[test]
    fn long_text_is_cut_on_a_character_with_an_ellipsis() {
        let text = "è".repeat(300);
        let cut = clean(&text, 10);
        assert_eq!(cut.chars().count(), 10);
        assert!(cut.ends_with('…'));
        assert!(cut.starts_with("èèèèèèèèè"));
        // Exactly at the limit is not cut.
        assert_eq!(clean(&"a".repeat(10), 10), "a".repeat(10));
    }

    #[test]
    fn the_cut_does_not_leave_a_space_before_the_ellipsis() {
        assert_eq!(clean("abcd efgh", 6), "abcd…");
    }
}
