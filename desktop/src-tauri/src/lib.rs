//! TipTop Copilot for Mac and Windows: a window onto https://copilot.tiptop.vc.
//!
//! A bundled fallback page hands over to the live site once it answers, so
//! every web update reaches the app with no new build. The shell registers no
//! commands and ships no capabilities, so the remote page has no native access;
//! the only native behaviour is here, in the menus (`menu.rs`) and in the
//! in-app updates (`updates.rs`), driven from Rust.

mod menu;
mod nav;
mod updates;

use std::sync::atomic::{AtomicUsize, Ordering};

use nav::{Route, route};
use tauri::{
    AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
    webview::{NewWindowFeatures, NewWindowResponse},
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{StateFlags, WindowExt};

const MAIN: &str = "main";

/// Numbers the extra windows that same-site "new tab" links open.
static NEXT_VIEW: AtomicUsize = AtomicUsize::new(1);

/// Tells the web app it is inside the desktop shell. Layout only; the server
/// never grants anything on the strength of it.
const DESKTOP_FLAG: &str = concat!(
    "(function () {",
    "if (location.protocol !== 'https:' || location.hostname !== 'copilot.tiptop.vc' || window.top !== window) return;",
    "try { Object.defineProperty(window, '__TIPTOP_DESKTOP__', { value: '",
    env!("CARGO_PKG_VERSION"),
    "' }); } catch (_) {}",
    "try { document.cookie = 'tiptop_desktop=",
    env!("CARGO_PKG_VERSION"),
    "; Path=/; Max-Age=31536000; Secure; SameSite=Lax'; } catch (_) {}",
    "})();"
);

fn state_flags() -> StateFlags {
    // Not VISIBLE: quitting from the tray while hidden would save "hidden" and
    // start the next launch with no window.
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn open_in_browser<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    // Never print the URL: sign-in links carry one-time values.
    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        eprintln!("could not hand a link to the system browser");
    }
}

/// Every window starts here, so each gets the same rules: the desktop flag,
/// where links may go, and (on a Mac) downloads.
fn window_builder<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    label: &str,
    url: WebviewUrl,
) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    let on_nav = app.clone();
    let on_popup = app.clone();
    let builder = WebviewWindowBuilder::new(app, label, url)
        // Lets HTML drag-and-drop and file drops reach the page on Windows.
        .disable_drag_drop_handler()
        .initialization_script(DESKTOP_FLAG)
        .on_navigation(move |url| match route(url) {
            Route::InApp => true,
            Route::Browser => {
                open_in_browser(&on_nav, url);
                false
            }
            Route::Block => false,
        })
        .on_new_window(move |url, features| match route(&url) {
            Route::InApp => match open_view(&on_popup, features) {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => {
                    eprintln!("could not open a new window");
                    NewWindowResponse::Deny
                }
            },
            Route::Browser => {
                open_in_browser(&on_popup, &url);
                NewWindowResponse::Deny
            }
            Route::Block => NewWindowResponse::Deny,
        });

    // WKWebView cancels every download unless a handler is set; wry fills in
    // ~/Downloads/<name> (with " (n)" on clashes), and Finished has no path on
    // macOS, so remember it from Requested. Windows keeps WebView2's own
    // download flyout, which a handler would hide.
    #[cfg(target_os = "macos")]
    let builder = {
        use std::{
            collections::HashMap,
            path::PathBuf,
            sync::{Arc, Mutex},
        };
        use tauri::webview::DownloadEvent;
        let app = app.clone();
        let saving: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();
        builder.on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination, .. } => {
                    if let Ok(mut pending) = saving.lock() {
                        pending.insert(url.to_string(), destination.clone());
                    }
                }
                DownloadEvent::Finished { url, success, .. } => {
                    let path = saving
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.remove(url.as_str()));
                    if let (true, Some(path)) = (success, path) {
                        let _ = app.opener().reveal_item_in_dir(path);
                    }
                }
                _ => {}
            }
            true
        })
    };

    builder
}

/// A same-site link meant for a new tab (an attachment, the full briefing)
/// opens in a window of its own, so the page it came from keeps any unsent
/// work. Closing one of these really closes it.
fn open_view<R: Runtime>(
    app: &AppHandle<R>,
    features: NewWindowFeatures,
) -> tauri::Result<WebviewWindow<R>> {
    let label = format!("view-{}", NEXT_VIEW.fetch_add(1, Ordering::Relaxed));
    let blank = Url::parse("about:blank").map_err(tauri::Error::InvalidUrl)?;
    window_builder(app, &label, WebviewUrl::External(blank))
        .title("TipTop Copilot")
        .inner_size(1100.0, 780.0)
        .min_inner_size(480.0, 360.0)
        .prevent_overflow()
        // Any size the page asked for, and the engine wiring that ties the new
        // page to the one that opened it.
        .window_features(features)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .build()
}

#[cfg(windows)]
fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let open = MenuItem::with_id(app, "open", "Open TipTop Copilot", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TipTop Copilot", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::<R>::with_id("main")
        .tooltip("TipTop Copilot")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // First, as its docs require: a second launch focuses this one and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(state_flags())
                // Only the main window keeps its size and place.
                .with_filter(|label| label == MAIN)
                .skip_initial_state(MAIN)
                .build(),
        )
        // Its default script would intercept _blank links and call a command the
        // remote page is not allowed to use, leaving the links dead.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        // Used from Rust only (updates.rs). With no capabilities the page cannot call it.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(|window, event| match event {
            // Closing the main window hides it (tray on Windows, Dock on a Mac).
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Menu commands act on the window in front.
            WindowEvent::Focused(true) => menu::focused(window.label()),
            WindowEvent::Destroyed => menu::destroyed(window.label()),
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // Before the menus, so Check for Updates… always finds its state.
            updates::init(&handle);
            // Before any window: on Windows each window takes the app's menu
            // when it is built. A Mac keeps its default menus if this fails.
            if menu::install(&handle).is_err() {
                eprintln!("could not add the menus");
            }
            let window = window_builder(&handle, MAIN, WebviewUrl::App("index.html".into()))
                .title("TipTop Copilot")
                .inner_size(1280.0, 820.0)
                .min_inner_size(800.0, 560.0)
                .center()
                .prevent_overflow()
                .visible(false)
                .build()?;
            // Restored here, before show, so the window never jumps.
            let _ = window.restore_state(state_flags());
            menu::restore_zoom(&window);
            window.show()?;
            let _ = window.set_focus();
            #[cfg(windows)]
            {
                build_tray(&handle)?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while starting TipTop Copilot")
        .run(|app, event| match event {
            // A Dock click while the window is hidden.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            tauri::RunEvent::ExitRequested { .. } => menu::leave_full_screen(app),
            _ => {}
        });
}
