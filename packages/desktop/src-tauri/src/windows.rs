use crate::constants::{UPDATER_ENABLED, window_state_flags};
use std::{ops::Deref, time::Duration};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_window_state::AppHandleExt;
use tokio::sync::mpsc;

pub struct MainWindow(WebviewWindow);

impl Deref for MainWindow {
    type Target = WebviewWindow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl MainWindow {
    pub const LABEL: &str = "main";

    pub fn create(app: &AppHandle) -> Result<Self, tauri::Error> {
        if let Some(window) = app.get_webview_window(Self::LABEL) {
            return Ok(Self(window));
        }

        let window_builder = base_window_config(
            WebviewWindowBuilder::new(app, Self::LABEL, WebviewUrl::App("/".into())),
            app,
        )
        .title("Nikcli")
        .decorations(true)
        .disable_drag_drop_handler()
        .min_inner_size(820.0, 620.0)
        .zoom_hotkeys_enabled(false)
        .visible(true)
        .maximized(true)
        .initialization_script(format!(
            r#"
            window.__NIKCLI__ ??= {{}};
            window.__NIKCLI__.updaterEnabled = {UPDATER_ENABLED};
          "#
        ));

        let window = window_builder.build()?;

        #[cfg(target_os = "macos")]
        native_glass::apply(&window);

        setup_window_state_listener(app, &window);

        #[cfg(windows)]
        {
            use tauri_plugin_decorum::WebviewWindowExt;
            let _ = window.create_overlay_titlebar();
        }

        Ok(Self(window))
    }
}

fn setup_window_state_listener(app: &AppHandle, window: &WebviewWindow) {
    let (tx, mut rx) = mpsc::channel::<()>(1);

    window.on_window_event(move |event| {
        use tauri::WindowEvent;
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        let _ = tx.try_send(());
    });

    tokio::spawn({
        let app = app.clone();

        async move {
            let save = || {
                let handle = app.clone();
                let app = app.clone();
                let _ = handle.run_on_main_thread(move || {
                    let _ = app.save_window_state(window_state_flags());
                });
            };

            while rx.recv().await.is_some() {
                tokio::time::sleep(Duration::from_millis(200)).await;

                save();
            }
        }
    });
}

pub struct LoadingWindow(WebviewWindow);

impl Deref for LoadingWindow {
    type Target = WebviewWindow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl LoadingWindow {
    pub const LABEL: &str = "loading";

    pub fn create(app: &AppHandle) -> Result<Self, tauri::Error> {
        let window_builder = base_window_config(
            WebviewWindowBuilder::new(app, Self::LABEL, tauri::WebviewUrl::App("/loading".into())),
            app,
        )
        .center()
        .resizable(false)
        .inner_size(640.0, 480.0)
        .visible(true);

        Ok(Self(window_builder.build()?))
    }
}

fn base_window_config<'a, R: Runtime, M: Manager<R>>(
    window_builder: WebviewWindowBuilder<'a, R, M>,
    _app: &AppHandle,
) -> WebviewWindowBuilder<'a, R, M> {
    let window_builder = window_builder.decorations(true);

    #[cfg(windows)]
    let window_builder = window_builder
        // Some VPNs set a global/system proxy that WebView2 applies even for loopback
        // connections, which breaks the app's localhost sidecar server.
        // Note: when setting additional args, we must re-apply wry's default
        // `--disable-features=...` flags.
        .additional_browser_args(
            "--proxy-bypass-list=<-loopback> --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection",
        )
        .data_directory(_app.path().config_dir().expect("Failed to get config dir").join(_app.config().product_name.clone().unwrap()))
        .decorations(false);

    #[cfg(target_os = "macos")]
    let window_builder = window_builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(12.0, 18.0))
        // Needed so the native glass layer behind the webview can show through.
        .transparent(true)
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                && native_glass::is_active()
            {
                let _ = webview.eval("document.documentElement.dataset.nativeGlass = 'true'");
            }
        });

    window_builder
}

/// Native macOS glass behind the webview: Liquid Glass on macOS 26+, sidebar
/// vibrancy on older releases. The web layer opts in via `data-native-glass`.
#[cfg(target_os = "macos")]
mod native_glass {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::WebviewWindow;
    use window_vibrancy::{
        LiquidGlassOptions, NSGlassEffectViewStyle, NSVisualEffectMaterial, NSVisualEffectState,
        apply_liquid_glass, apply_vibrancy,
    };

    static ACTIVE: AtomicBool = AtomicBool::new(false);

    pub fn is_active() -> bool {
        ACTIVE.load(Ordering::Relaxed)
    }

    pub fn apply(window: &WebviewWindow) {
        // NSGlassEffectView may only be touched from the main thread, and windows are
        // created from async tasks, so hop over before applying.
        let target = window.clone();
        let _ = window.run_on_main_thread(move || {
            let glass = apply_liquid_glass(
                &target,
                LiquidGlassOptions::new(NSGlassEffectViewStyle::Regular).interactive(true),
            );

            let applied = match glass {
                Ok(()) => true,
                Err(err) => {
                    println!("Liquid glass unavailable ({err}), falling back to vibrancy");
                    apply_vibrancy(
                        &target,
                        NSVisualEffectMaterial::Sidebar,
                        Some(NSVisualEffectState::Active),
                        None,
                    )
                    .is_ok()
                }
            };

            ACTIVE.store(applied, Ordering::Relaxed);
            if applied {
                let _ = target.eval("document.documentElement.dataset.nativeGlass = 'true'");
            }
        });
    }
}
