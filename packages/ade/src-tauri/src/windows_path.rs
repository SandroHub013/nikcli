//! The PATH a program started now would get on Windows.
//!
//! A process reads its PATH once, when it starts. An installer writes the new directory to the registry
//! (`HKCU\Environment` for the user, `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment` for the
//! machine) and tells Explorer, which hands it to what it starts afterwards — not to ADE, which is already running.
//! So an agent installed from the new-session form was on the disk and not on ADE's PATH: «Ricontrolla» said it was
//! still missing, and a session would not have found it either.
//!
//! The registry's PATH is read with `RegGetValueW`, which expands a `REG_EXPAND_SZ` (`%USERPROFILE%\bin`) the way
//! the shell does. The reply is not read from `reg.exe`: its output is in the console's code page, and a user folder
//! with an accent would come back garbled.

/// What a new process would have: the machine's PATH, then the user's — the order Windows builds it in — and then
/// whatever the running process has that neither of them lists, so nothing ADE was started with is lost.
///
/// Directories are compared without case, a trailing slash or quotes; the first spelling is kept. Empty entries go.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn merge(machine: Option<&str>, user: Option<&str>, current: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut parts: Vec<&str> = Vec::new();
    for list in [machine.unwrap_or(""), user.unwrap_or(""), current] {
        for entry in list.split(';') {
            let key = entry.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_ascii_lowercase();
            if !key.is_empty() && seen.insert(key) {
                parts.push(entry.trim());
            }
        }
    }
    parts.join(";")
}

/// The PATH from the registry, merged with `current`; `None` when the registry has no PATH to give.
#[cfg(windows)]
pub fn refreshed(current: &str) -> Option<String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ,
    };

    fn read(root: HKEY, subkey: PCWSTR) -> Option<String> {
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
        let mut bytes: u32 = 0;
        // Asked its size first: a PATH is as long as the user made it.
        let status = unsafe { RegGetValueW(root, subkey, w!("Path"), flags, None, None, Some(&mut bytes as *mut u32)) };
        if status != ERROR_SUCCESS || bytes == 0 {
            return None;
        }
        let mut buffer = vec![0u16; bytes as usize / 2 + 2];
        let mut size = (buffer.len() * 2) as u32;
        let status = unsafe {
            RegGetValueW(root, subkey, w!("Path"), flags, None, Some(buffer.as_mut_ptr().cast()), Some(&mut size as *mut u32))
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let text = String::from_utf16_lossy(&buffer[..(size as usize / 2).min(buffer.len())]);
        Some(text.trim_end_matches('\0').to_string())
    }

    let machine = read(HKEY_LOCAL_MACHINE, w!("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"));
    let user = read(HKEY_CURRENT_USER, w!("Environment"));
    if machine.is_none() && user.is_none() {
        return None;
    }
    Some(merge(machine.as_deref(), user.as_deref(), current))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_then_user_then_what_the_process_already_had() {
        assert_eq!(merge(Some("C:\\Windows;C:\\Tools"), Some("C:\\Users\\a\\bin"), "C:\\ADE\\bin"), "C:\\Windows;C:\\Tools;C:\\Users\\a\\bin;C:\\ADE\\bin");
    }

    #[test]
    fn a_directory_the_installer_just_added_reaches_the_process() {
        let current = "C:\\Windows;C:\\Tools";
        let merged = merge(Some("C:\\Windows;C:\\Tools"), Some("C:\\Users\\a\\.local\\bin"), current);
        assert!(merged.split(';').any(|dir| dir == "C:\\Users\\a\\.local\\bin"));
    }

    #[test]
    fn the_same_directory_is_kept_once_whatever_its_spelling() {
        assert_eq!(merge(Some("C:\\Tools\\"), Some("c:\\tools"), "\"C:\\TOOLS\""), "C:\\Tools\\");
    }

    #[test]
    fn empty_entries_and_a_missing_value_do_not_leave_gaps() {
        assert_eq!(merge(None, Some(";C:\\a;;"), ""), "C:\\a");
        assert_eq!(merge(None, None, ""), "");
    }

    #[test]
    fn a_path_with_spaces_and_accents_is_not_split_or_altered() {
        assert_eq!(merge(Some("C:\\Program Files\\Git\\cmd"), Some("C:\\Users\\José\\bin"), ""), "C:\\Program Files\\Git\\cmd;C:\\Users\\José\\bin");
    }

    #[cfg(windows)]
    #[test]
    fn the_registry_of_this_machine_gives_a_path_with_the_system_directory() {
        let merged = refreshed("").expect("every Windows has a machine PATH");
        assert!(merged.to_ascii_lowercase().contains("\\windows\\system32"), "{merged}");
    }
}
