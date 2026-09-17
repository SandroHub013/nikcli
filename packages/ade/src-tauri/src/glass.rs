/**
 * Native glass / transparency support for ADE windows (S49).
 *
 * Implements OS-level window effects:
 * - Windows: Acrylic or Mica through DWM
 * - macOS: Vibrancy (NSVisualEffectMaterial::UnderWindowBackground)
 * - Linux: Transparent window composited by Wayland or X11 compositor
 *
 * Provides status query so the UI knows if native glass is available on this
 * host machine.
 */

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct GlassStatus {
    pub supported: bool,
    pub effect: String,
    pub reason: Option<String>,
}

#[cfg(target_os = "windows")]
pub fn get_glass_status() -> GlassStatus {
    let version = windows_version::OsVersion::current();
    // Windows 10 v1809 is build 17763; Windows 11 starts at build 22000
    if version.build >= 22000 {
        GlassStatus {
            supported: true,
            effect: "acrylic".to_string(),
            reason: None,
        }
    } else if version.build >= 17763 {
        GlassStatus {
            supported: true,
            effect: "acrylic".to_string(),
            reason: None,
        }
    } else {
        GlassStatus {
            supported: false,
            effect: "none".to_string(),
            reason: Some("Richiede Windows 10 build 17763 o successiva".to_string()),
        }
    }
}

#[cfg(target_os = "macos")]
pub fn get_glass_status() -> GlassStatus {
    GlassStatus {
        supported: true,
        effect: "vibrancy".to_string(),
        reason: None,
    }
}

#[cfg(target_os = "linux")]
pub fn get_glass_status() -> GlassStatus {
    let has_wayland = std::env::var("WAYLAND_DISPLAY").is_ok();
    let has_x11 = std::env::var("DISPLAY").is_ok();
    if has_wayland || has_x11 {
        GlassStatus {
            supported: true,
            effect: "compositor".to_string(),
            reason: None,
        }
    } else {
        GlassStatus {
            supported: false,
            effect: "none".to_string(),
            reason: Some("Compositore grafico non rilevato".to_string()),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn get_glass_status() -> GlassStatus {
    GlassStatus {
        supported: false,
        effect: "none".to_string(),
        reason: Some("Piattaforma non supportata".to_string()),
    }
}

#[tauri::command]
pub fn ade_glass_status() -> GlassStatus {
    get_glass_status()
}

#[tauri::command]
pub fn ade_window_set_glass(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            // Apply acrylic effect with subtle dark tint; if that fails or on Win11, also try mica
            if window_vibrancy::apply_acrylic(&window, Some((18, 18, 18, 40))).is_err() {
                let _ = window_vibrancy::apply_mica(&window, Some(true));
            }
        } else {
            let _ = window_vibrancy::clear_acrylic(&window);
            let _ = window_vibrancy::clear_mica(&window);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if enabled {
            let _ = window_vibrancy::apply_vibrancy(
                &window,
                window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            );
        } else {
            let _ = window_vibrancy::clear_vibrancy(&window);
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = window;
        let _ = enabled;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glass_status_is_consistent() {
        let status = get_glass_status();
        if status.supported {
            assert!(!status.effect.is_empty());
            assert!(status.reason.is_none());
        } else {
            assert!(status.reason.is_some());
        }
    }
}
