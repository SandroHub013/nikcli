//! Recording a video of ADE in use (S36).
//!
//! One interface for the three systems: the capture itself is the operating
//! system's, because only it can hand back a window's composed pixels at 60 Hz
//! without reading the screen. Windows is implemented here; macOS and Linux
//! have the same signature and say, in one sentence, that they are not ready
//! yet — so the app compiles and behaves everywhere, and the work left is
//! plainly one file each.
//!
//! What ADE writes next to the video — pointer, clicks, panes, commands — lives
//! on the TypeScript side (`src/record/recording.ts`): zoom and click
//! highlights are drawn from it at export, never burned into the frames.

use std::path::PathBuf;
use std::sync::Mutex;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(not(target_os = "windows"))]
mod unsupported;

#[cfg(target_os = "windows")]
use windows as platform;

#[cfg(not(target_os = "windows"))]
use unsupported as platform;

/// The part of the window a take covers, in physical pixels.
///
/// A pane is not a separate capture: the window is captured once and each
/// frame is cropped, which is what keeps a pane take in step with the window
/// it belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Target {
    Window,
    Pane { x: u32, y: u32, width: u32, height: u32 },
}

/// How heavy a take is: the three levels the panel offers (S36).
///
/// Only the frame rate and the encoded size change; the capture itself is the
/// same. Sent by name so the numbers stay in one place, the frontend, where
/// they are also shown to the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
pub struct Quality {
    pub fps: u32,
    /// Absent keeps the window's own size.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Bits a second. Absent asks for the heaviest level's rate.
    pub bitrate: Option<u32>,
}

impl Default for Quality {
    fn default() -> Self {
        Self { fps: 60, width: None, height: None, bitrate: None }
    }
}

/// The size a take is encoded at: inside the level's box, same shape.
///
/// A window is rarely the shape of the box. Stretching what was captured to
/// fill it is the mistake that ruins a promo video quietly: the first pane
/// take of 2026-09-16 was 900x1125 and came out 900x800, everything in it
/// subtly squashed. So the frame is fitted, never stretched, and never
/// enlarged: upscaling costs bytes and adds nothing.
pub fn fit_in(frame: (u32, u32), limit: (Option<u32>, Option<u32>)) -> (u32, u32) {
    let (width, height) = frame;
    if width == 0 || height == 0 {
        return (even(width), even(height));
    }
    let ratio = |side: u32, max: Option<u32>| f64::from(max.unwrap_or(side).min(side)) / f64::from(side);
    let scale = ratio(width, limit.0).min(ratio(height, limit.1)).min(1.0);
    let scaled = |side: u32| even((f64::from(side) * scale).round() as u32).max(2);
    (scaled(width), scaled(height))
}

/// A take in progress, as the frontend sees it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecordState {
    pub recording: bool,
    /// The file being written, absent when nothing is being recorded.
    pub path: Option<String>,
}

#[derive(Default)]
pub struct Recorder {
    active: Mutex<Option<platform::Active>>,
}

/// H.264 refuses odd dimensions, and a window is whatever size the user left it.
pub fn even(size: u32) -> u32 {
    size - (size % 2)
}

/// The crop, kept inside the window and even on every side.
///
/// A pane rectangle comes from the layout, which measures in CSS pixels and
/// rounds; on a scaled display the right edge can land a pixel past the frame,
/// and a capture that reads past its own buffer is a crash, not a bad video.
pub fn crop_in(frame: (u32, u32), x: u32, y: u32, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let (frame_width, frame_height) = frame;
    if x >= frame_width || y >= frame_height {
        return None;
    }
    let width = even(width.min(frame_width - x));
    let height = even(height.min(frame_height - y));
    if width == 0 || height == 0 {
        return None;
    }
    Some((x, y, width, height))
}

/// Where a take is written: the folder the user chose, plus the name ADE made.
pub fn video_path(dir: &str, name: &str) -> PathBuf {
    PathBuf::from(dir).join(format!("{name}.mp4"))
}

#[tauri::command]
pub fn record_start(
    app: tauri::AppHandle,
    recorder: tauri::State<'_, Recorder>,
    target: Target,
    dir: String,
    name: String,
    quality: Option<Quality>,
) -> Result<RecordState, String> {
    let mut active = recorder.active.lock().map_err(|_| "registratore occupato".to_string())?;
    if active.is_some() {
        return Err("Una registrazione è già in corso.".into());
    }
    let path = video_path(&dir, &name);
    let started = platform::start(&app, target, &path, quality.unwrap_or_default())?;
    *active = Some(started);
    Ok(RecordState { recording: true, path: Some(path.to_string_lossy().into_owned()) })
}

#[tauri::command]
pub fn record_stop(recorder: tauri::State<'_, Recorder>) -> Result<RecordState, String> {
    let taken = {
        let mut active = recorder.active.lock().map_err(|_| "registratore occupato".to_string())?;
        active.take()
    };
    match taken {
        Some(active) => {
            let path = platform::stop(active)?;
            Ok(RecordState { recording: false, path: Some(path.to_string_lossy().into_owned()) })
        }
        None => Ok(RecordState { recording: false, path: None }),
    }
}

#[tauri::command]
pub fn record_state(recorder: tauri::State<'_, Recorder>) -> RecordState {
    match recorder.active.lock() {
        Ok(active) => match active.as_ref() {
            Some(active) => RecordState {
                recording: true,
                path: Some(platform::path_of(active).to_string_lossy().into_owned()),
            },
            None => RecordState { recording: false, path: None },
        },
        Err(_) => RecordState { recording: false, path: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_size_is_always_even() {
        assert_eq!(even(1920), 1920);
        assert_eq!(even(1201), 1200);
        assert_eq!(even(0), 0);
    }

    #[test]
    fn a_pane_crop_stays_inside_the_frame() {
        assert_eq!(crop_in((1920, 1200), 100, 50, 800, 600), Some((100, 50, 800, 600)));
        // Rounded up by the layout: cut back to the frame, and to an even size.
        assert_eq!(crop_in((1920, 1200), 1100, 50, 900, 600), Some((1100, 50, 820, 600)));
        assert_eq!(crop_in((1920, 1200), 0, 0, 1921, 1201), Some((0, 0, 1920, 1200)));
        // Nothing to record: outside the frame, or thinner than a pixel pair.
        assert_eq!(crop_in((1920, 1200), 1920, 0, 10, 10), None);
        assert_eq!(crop_in((1920, 1200), 0, 1200, 10, 10), None);
        assert_eq!(crop_in((1920, 1200), 1919, 0, 10, 10), None);
    }

    #[test]
    fn a_take_is_an_mp4_in_the_folder_the_user_chose() {
        let path = video_path("C:/Users/me/Video", "ADE 2026-09-16 09.05.03");
        assert!(path.ends_with("ADE 2026-09-16 09.05.03.mp4"));
        assert!(path.starts_with("C:/Users/me/Video"));
    }

    #[test]
    fn a_lighter_take_is_fitted_in_its_box_and_never_stretched() {
        assert_eq!(fit_in((900, 1125), (Some(1280), Some(800))), (640, 800));
        assert_eq!(fit_in((1920, 1200), (Some(1280), Some(800))), (1280, 800));
        // A window smaller than the box is left alone rather than blown up.
        assert_eq!(fit_in((800, 600), (Some(1280), Some(800))), (800, 600));
        assert_eq!(fit_in((1921, 1201), (None, None)), (1920, 1200));
    }

    #[test]
    fn a_quality_arrives_by_its_numbers_and_falls_back_to_the_heaviest() {
        let light: Quality =
            serde_json::from_str(r#"{"fps":30,"width":1280,"height":800,"bitrate":2866667}"#).unwrap();
        assert_eq!(light, Quality { fps: 30, width: Some(1280), height: Some(800), bitrate: Some(2_866_667) });
        let full: Quality =
            serde_json::from_str(r#"{"fps":60,"width":null,"height":null,"bitrate":null}"#).unwrap();
        assert_eq!(full, Quality::default());
        assert_eq!(Quality::default().fps, 60);
    }

    #[test]
    fn a_pane_target_arrives_from_the_frontend_as_json() {
        let target: Target =
            serde_json::from_str(r#"{"kind":"pane","x":10,"y":20,"width":800,"height":600}"#).unwrap();
        assert_eq!(target, Target::Pane { x: 10, y: 20, width: 800, height: 600 });
        assert_eq!(serde_json::from_str::<Target>(r#"{"kind":"window"}"#).unwrap(), Target::Window);
    }
}
