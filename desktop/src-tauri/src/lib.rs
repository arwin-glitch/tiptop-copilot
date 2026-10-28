//! TipTop Kraken for Mac and Windows: a window onto https://copilot.tiptop.vc.
//!
//! A bundled fallback page hands over to the live site once it answers, so
//! every web update reaches the app with no new build. The page gets two
//! narrow bridges, in the main window only (`capabilities/`, `permissions/`).
//! The live site and the fallback page may move, minimise, maximise and close
//! that window, read its state, and open the menu under its top bar's ☰
//! button (`frame.rs`). The live site alone may turn desktop alerts on or off
//! for this computer, show their fixed test notification, and ask for them
//! within half a minute after a question to Ask Arwin (`alerts.rs`).
//! Everything else native is here, driven from Rust: the menus (`menu.rs`),
//! the in-app updates (`updates.rs`), the alerts themselves, links and
//! downloads, and on a Mac the move from the old app name (`rename.rs`).

mod alerts;
mod frame;
mod menu;
mod nav;
#[cfg(any(target_os = "macos", test))]
mod rename;
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
/// where links may go, the scrollbars and (on a Mac) downloads.
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

    // Thin scrollbars that overlay the page and take no width, so the main
    // window's top bar reaches the right edge and its close button never
    // moves. WebView2 needs the same value for every webview on one data
    // directory, so every window gets it; runtimes older than 125 ignore it.
    #[cfg(windows)]
    let builder = builder.scroll_bar_style(tauri::webview::ScrollBarStyle::FluentOverlay);

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
/// work. Closing one of these really closes it. These keep a normal title bar
/// and, on Windows, a menu bar: an attachment or the briefing cannot draw the
/// main window's top bar.
fn open_view<R: Runtime>(
    app: &AppHandle<R>,
    features: NewWindowFeatures,
) -> tauri::Result<WebviewWindow<R>> {
    let label = format!("view-{}", NEXT_VIEW.fetch_add(1, Ordering::Relaxed));
    let blank = Url::parse("about:blank").map_err(tauri::Error::InvalidUrl)?;
    let builder = window_builder(app, &label, WebviewUrl::External(blank))
        .title("TipTop Kraken")
        .inner_size(1100.0, 780.0)
        .min_inner_size(480.0, 360.0)
        .prevent_overflow()
        // Any size the page asked for, and the engine wiring that ties the new
        // page to the one that opened it.
        .window_features(features)
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        });
    // A menu of its own: Windows destroys a window's menu bar with it.
    #[cfg(windows)]
    let builder = match menu::window_bar(app) {
        Ok(bar) => builder.menu(bar),
        Err(_) => {
            eprintln!("could not add a second window's menus");
            builder
        }
    };
    builder.build()
}

#[cfg(windows)]
fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    let open = MenuItem::with_id(app, "open", "Open TipTop Kraken", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TipTop Kraken", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::<R>::with_id("main")
        .tooltip("TipTop Kraken")
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
    // A Mac copy updated from 0.4.x still sits in "TipTop Copilot.app": rename
    // it to "TipTop Kraken.app" and start again from there (rename.rs).
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    if rename::relaunch_under_new_name() {
        return;
    }
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
        // Used from Rust only (updates.rs); no capability grants it to the page.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The top bar's commands (frame.rs) and desktop alerts' (alerts.rs).
        // Only capabilities/ lets a page call them: the main window, on the
        // live site, and for the top bar the fallback page too.
        .invoke_handler(tauri::generate_handler![
            frame::show_app_menu,
            frame::window_control,
            frame::window_frame,
            alerts::alerts_state,
            alerts::alerts_request_permission,
            alerts::alerts_turn_on,
            alerts::alerts_turn_off,
            alerts::alerts_test,
            alerts::alerts_poll_soon
        ])
        .on_window_event(|window, event| match event {
            // Closing the main window hides it (tray on Windows, Dock on a Mac).
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
                api.prevent_close();
                let _ = window.hide();
            }
            // Menu commands act on the window in front; the main window coming
            // forward also looks for an update (at most every 15 minutes).
            WindowEvent::Focused(true) => {
                menu::focused(window.label());
                if window.label() == MAIN {
                    updates::focused(window.app_handle());
                }
            }
            WindowEvent::Destroyed => menu::destroyed(window.label()),
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // Before the menus, so Check for Updates… always finds its state.
            updates::init(&handle);
            // Before any window, so Settings always finds the alerts' state.
            alerts::init(&handle);
            // Before any window, so the menu is there when the page first asks
            // for it. A Mac keeps its default menus if this fails.
            if menu::install(&handle).is_err() {
                eprintln!("could not add the menus");
            }
            let window = frame::main_window(window_builder(
                &handle,
                MAIN,
                WebviewUrl::App("index.html".into()),
            ))
            .title("TipTop Kraken")
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
        .expect("error while starting TipTop Kraken")
        .run(|app, event| match event {
            // A Dock click while the window is hidden.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main(app),
            tauri::RunEvent::ExitRequested { .. } => menu::leave_full_screen(app),
            _ => {}
        });
}
