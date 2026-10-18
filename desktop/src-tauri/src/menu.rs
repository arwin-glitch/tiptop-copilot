//! The menu bar: File, Edit and View, plus the app menu on a Mac. Check for
//! Updates… is placed here and answered in updates.rs.
//!
//! Undo through Select All (except Paste and Match Style and Delete) are the
//! system's own items: they act on whatever has focus in the page, exactly as
//! the keys do. Everything else is handled here, on the window in front.
//! Windows gets one menu bar per window; every window inherits the app's menu
//! as long as it is set before the window is built.

use std::{collections::BTreeMap, sync::Mutex};

use tauri::{
    AppHandle, Manager, Runtime, WebviewWindow,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
};

use crate::{MAIN, nav::LIVE_HOST, show_main};

const SETTINGS: &str = "menu-settings";
const QUIT: &str = "menu-quit";
const PASTE_PLAIN: &str = "edit-paste-plain";
const DELETE: &str = "edit-delete";
const RELOAD: &str = "view-reload";
const FORCE_RELOAD: &str = "view-force-reload";
const FULL_SCREEN: &str = "view-full-screen";
const ACTUAL_SIZE: &str = "view-actual-size";
const ZOOM_IN: &str = "view-zoom-in";
const ZOOM_OUT: &str = "view-zoom-out";

/// The label of the window in front, kept from focus events: a menu event
/// does not say which window it came from, and on Windows a window whose page
/// has focus does not report itself as focused.
static FRONT: Mutex<Option<String>> = Mutex::new(None);

/// Each window's zoom.
static ZOOM: Mutex<BTreeMap<String, f64>> = Mutex::new(BTreeMap::new());

/// Uses the page's own Settings link when it has one, so the app moves there
/// the way a click would, without reloading; else loads the page.
const OPEN_SETTINGS: &str = concat!(
    "(function () {",
    "if (location.pathname === '/settings') return;",
    "var link = document.querySelector('a[href=\"/settings\"]');",
    "if (link) link.click(); else location.assign('/settings');",
    "})();"
);

/// Deletes the selection in the focused field. With no selection it does
/// nothing (the editing command would delete the character before the caret).
#[cfg(windows)]
const DELETE_SELECTION: &str = concat!(
    "(function () {",
    "var field = document.activeElement, selected = false;",
    "try {",
    "selected = field && typeof field.selectionStart === 'number'",
    " ? field.selectionStart !== field.selectionEnd",
    " : !document.getSelection().isCollapsed;",
    "} catch (_) {}",
    "if (selected) document.execCommand('delete');",
    "})();"
);

/// Sets the menus and starts handling them. Call it before building any
/// window, so each window gets the menu bar when it is created.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.set_menu(build(app)?)?;
    // Tray and menu events reach every handler, so the ids never overlap.
    app.on_menu_event(|app, event| on_event(app, event.id.as_ref()));
    Ok(())
}

/// The app menu, File, Edit and View. Items with a selector of their own
/// (Close Window, Quit, the edit items, Full Screen) are the system's.
#[cfg(target_os = "macos")]
fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    use tauri::menu::AboutMetadata;
    let package = app.package_info();
    let about = AboutMetadata {
        name: Some(package.name.clone()),
        version: Some(package.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        ..Default::default()
    };
    // The first menu is the app menu; macOS titles it with the app's name.
    let app_menu = Submenu::with_items(
        app,
        "TipTop Copilot",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about))?,
            &crate::updates::menu_item(app)?,
            &MenuItem::with_id(app, SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&PredefinedMenuItem::close_window(app, Some("Close Window"))?],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &MenuItem::with_id(
                app,
                PASTE_PLAIN,
                "Paste and Match Style",
                true,
                Some("Alt+Shift+CmdOrCtrl+V"),
            )?,
            &MenuItem::with_id(app, DELETE, "Delete", true, None::<&str>)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, RELOAD, "Reload", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, FORCE_RELOAD, "Force Reload", true, Some("Shift+CmdOrCtrl+R"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ACTUAL_SIZE, "Actual Size", true, Some("CmdOrCtrl+0"))?,
            &MenuItem::with_id(app, ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view])
}

/// File, Edit and View. While the page has focus WebView2 gets every key
/// before the menu bar does, so a shortcut WebView2 already handles is shown
/// but never registered, and items that have no such shortcut show none
/// (zoom included: WebView2's zoom keys stay off, see `zoom`).
#[cfg(windows)]
fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let file = Submenu::with_items(
        app,
        "&File",
        true,
        &[
            &MenuItem::with_id(app, SETTINGS, "&Settings…", true, None::<&str>)?,
            &crate::updates::menu_item(app)?,
            &PredefinedMenuItem::separator(app)?,
            // Closes the window whose menu was used (Alt+F4).
            &PredefinedMenuItem::close_window(app, Some("&Close Window"))?,
            &MenuItem::with_id(app, QUIT, "&Quit TipTop Copilot", true, None::<&str>)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "&Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("&Undo"))?,
            &PredefinedMenuItem::redo(app, Some("&Redo"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &shown(app, PASTE_PLAIN, "Paste and &Match Style", "Ctrl+Shift+V")?,
            &MenuItem::with_id(app, DELETE, "&Delete", true, None::<&str>)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "&View",
        true,
        &[
            &shown(app, RELOAD, "&Reload", "Ctrl+R")?,
            &shown(app, FORCE_RELOAD, "&Force Reload", "Ctrl+Shift+R")?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, FULL_SCREEN, "Toggle F&ull Screen", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ACTUAL_SIZE, "&Actual Size", true, None::<&str>)?,
            &MenuItem::with_id(app, ZOOM_IN, "Zoom &In", true, None::<&str>)?,
            &MenuItem::with_id(app, ZOOM_OUT, "Zoom &Out", true, None::<&str>)?,
        ],
    )?;
    Menu::with_items(app, &[&file, &edit, &view])
}

/// An item whose shortcut is shown after a tab but not registered.
#[cfg(windows)]
fn shown<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    shortcut: &str,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, format!("{text}\t{shortcut}"), true, None::<&str>)
}

pub fn focused(label: &str) {
    if let Ok(mut front) = FRONT.lock() {
        *front = Some(label.to_owned());
    }
}

pub fn destroyed(label: &str) {
    if let Ok(mut front) = FRONT.lock() {
        if front.as_deref() == Some(label) {
            *front = None;
        }
    }
    if let Ok(mut zooms) = ZOOM.lock() {
        zooms.remove(label);
    }
}

/// The window a menu command acts on: the one in front, else the main one,
/// but never a hidden one (a closed main window is only hidden, and may still
/// hold an unsent reply). With none, the command does nothing. The update
/// dialogs (updates.rs) open on it too.
pub fn front_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    let front = FRONT.lock().ok().and_then(|front| front.clone());
    front
        .and_then(|label| app.get_webview_window(&label))
        .filter(|window| is_shown(window))
        .or_else(|| {
            app.webview_windows()
                .into_values()
                .find(|window| is_shown(window) && window.is_focused().unwrap_or(false))
        })
        .or_else(|| app.get_webview_window(MAIN).filter(|window| is_shown(window)))
}

fn is_shown<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    window.is_visible().unwrap_or(false)
}

fn on_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        SETTINGS => open_settings(app),
        QUIT => app.exit(0),
        PASTE_PLAIN | DELETE | RELOAD | FORCE_RELOAD | FULL_SCREEN | ACTUAL_SIZE | ZOOM_IN
        | ZOOM_OUT => {
            let Some(window) = front_window(app) else {
                return;
            };
            match id {
                PASTE_PLAIN => paste_plain(&window),
                DELETE => delete(&window),
                RELOAD => {
                    let _ = window.reload();
                }
                FORCE_RELOAD => force_reload(&window),
                FULL_SCREEN => toggle_full_screen(&window),
                ACTUAL_SIZE => zoom(&window, Zoom::Reset),
                ZOOM_IN => zoom(&window, Zoom::In),
                _ => zoom(&window, Zoom::Out),
            }
        }
        // The system's own items and the tray's.
        _ => {}
    }
}

/// Settings always opens in the main window. Until the live site has loaded
/// the opening page is showing, and it moves on by itself.
fn open_settings<R: Runtime>(app: &AppHandle<R>) {
    show_main(app);
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    if window
        .url()
        .is_ok_and(|url| url.host_str() == Some(LIVE_HOST))
    {
        let _ = window.eval(OPEN_SETTINGS);
    }
}

/// Pastes the clipboard as plain text into the focused field.
fn paste_plain<R: Runtime>(_window: &WebviewWindow<R>) {
    // The action a Mac's own Paste and Match Style item sends.
    #[cfg(target_os = "macos")]
    {
        mac::send_action(c"pasteAsPlainText:");
    }
    // Chromium's own plain-text paste. A page cannot paste by script.
    #[cfg(windows)]
    {
        keys::press(&[keys::CONTROL, keys::SHIFT], keys::KEY_V);
    }
}

fn delete<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        mac::send_action(c"delete:");
    }
    #[cfg(windows)]
    {
        let _ = window.eval(DELETE_SELECTION);
    }
}

/// Reloads the page and everything on it from the server, not the cache.
fn force_reload<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "macos")]
    {
        let sent = window.with_webview(|webview| mac::reload_from_origin(webview.inner()));
        if sent.is_err() {
            let _ = window.reload();
        }
    }
    // Chromium's hard reload. WebView2 offers no other way to skip the cache
    // short of deleting the stored data, which would sign the user out.
    #[cfg(windows)]
    {
        let _ = window;
        keys::press(&[keys::CONTROL, keys::SHIFT], keys::KEY_R);
    }
}

/// Windows only: a Mac uses the system's own Full Screen item. The menu bar
/// stays at the top in full screen, so the same item brings the window back.
fn toggle_full_screen<R: Runtime>(window: &WebviewWindow<R>) {
    let full = window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(!full);
}

/// Leaves full screen before quitting, so the main window's saved size is its
/// own and not the screen's. Not while hidden: that would show it again.
pub fn leave_full_screen<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(windows)]
    {
        if let Some(window) = app.get_webview_window(MAIN) {
            if window.is_visible().unwrap_or(false) && window.is_fullscreen().unwrap_or(false) {
                let _ = window.set_fullscreen(false);
            }
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[derive(Clone, Copy)]
enum Zoom {
    Reset,
    In,
    Out,
}

/// The zoom is set here, per window, on both systems, and the main window's
/// is kept for the next launch. A zoom the app sets stays through reloads. On
/// Windows a zoom made with WebView2's own keys would be dropped at the next
/// page load, and turning those keys on turns on pinch-zoom too, so they stay
/// off.
fn zoom<R: Runtime>(window: &WebviewWindow<R>, step: Zoom) {
    let current = ZOOM
        .lock()
        .ok()
        .and_then(|zooms| zooms.get(window.label()).copied())
        .unwrap_or(1.0);
    let level = match step {
        Zoom::Reset => 1.0,
        Zoom::In => levels::bigger(current),
        Zoom::Out => levels::smaller(current),
    };
    apply_zoom(window, level);
    if window.label() == MAIN {
        save_zoom(window.app_handle(), level);
    }
}

/// Puts the main window back at the zoom it had when the app last quit.
pub fn restore_zoom<R: Runtime>(window: &WebviewWindow<R>) {
    let saved = zoom_file(window.app_handle())
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| text.trim().parse::<f64>().ok())
        .map(levels::nearest);
    if let Some(level) = saved {
        apply_zoom(window, level);
    }
}

fn apply_zoom<R: Runtime>(window: &WebviewWindow<R>, level: f64) {
    if window.set_zoom(level).is_ok() {
        if let Ok(mut zooms) = ZOOM.lock() {
            zooms.insert(window.label().to_owned(), level);
        }
    }
}

fn zoom_file<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("zoom-level"))
}

fn save_zoom<R: Runtime>(app: &AppHandle<R>, level: f64) {
    let Some(path) = zoom_file(app) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::write(&path, level.to_string()).is_err() {
        eprintln!("could not save the zoom level");
    }
}

/// Zoom levels, stepped through the way browsers do.
mod levels {
    const LEVELS: [f64; 13] = [
        0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
    ];

    /// Treats a level within this of a step as that step.
    const SLACK: f64 = 0.001;

    pub fn bigger(level: f64) -> f64 {
        LEVELS
            .iter()
            .copied()
            .find(|&step| step > level + SLACK)
            .unwrap_or(LEVELS[LEVELS.len() - 1])
    }

    pub fn smaller(level: f64) -> f64 {
        LEVELS
            .iter()
            .rev()
            .copied()
            .find(|&step| step < level - SLACK)
            .unwrap_or(LEVELS[0])
    }

    /// The step nearest a saved level; 100% for anything unreadable.
    pub fn nearest(level: f64) -> f64 {
        if !level.is_finite() {
            return 1.0;
        }
        LEVELS
            .iter()
            .copied()
            .min_by(|a, b| (a - level).abs().total_cmp(&(b - level).abs()))
            .unwrap_or(1.0)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn zoom_steps_through_the_levels() {
            assert_eq!(bigger(1.0), 1.1);
            assert_eq!(bigger(1.1), 1.25);
            assert_eq!(bigger(0.5), 0.67);
            assert_eq!(smaller(1.0), 0.9);
            assert_eq!(smaller(1.25), 1.1);
            assert_eq!(smaller(0.67), 0.5);
        }

        #[test]
        fn zoom_stops_at_either_end() {
            assert_eq!(bigger(3.0), 3.0);
            assert_eq!(bigger(5.0), 3.0);
            assert_eq!(smaller(0.5), 0.5);
            assert_eq!(smaller(0.1), 0.5);
        }

        #[test]
        fn a_level_between_steps_moves_to_the_next_step() {
            assert_eq!(bigger(1.05), 1.1);
            assert_eq!(smaller(1.05), 1.0);
            assert_eq!(bigger(1.1004), 1.25);
        }

        #[test]
        fn a_saved_level_snaps_to_a_step() {
            assert_eq!(nearest(1.25), 1.25);
            assert_eq!(nearest(1.26), 1.25);
            assert_eq!(nearest(0.0), 0.5);
            assert_eq!(nearest(9.0), 3.0);
            assert_eq!(nearest(f64::NAN), 1.0);
            assert_eq!(nearest(f64::INFINITY), 1.0);
        }
    }
}

/// Presses keys for the page, the way the system's own Edit items do on
/// Windows: they go to whatever has focus, which is the page in the window
/// whose menu was used.
#[cfg(windows)]
mod keys {
    pub const SHIFT: u16 = 0x10;
    pub const CONTROL: u16 = 0x11;
    pub const KEY_R: u16 = 0x52;
    pub const KEY_V: u16 = 0x56;

    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_KEYUP: u32 = 2;

    /// KEYBDINPUT. Its fields are read by Windows, not by Rust.
    #[repr(C)]
    #[allow(dead_code)]
    struct KeybdInput {
        vk: u16,
        scan: u16,
        flags: u32,
        time: u32,
        extra_info: usize,
    }

    /// INPUT, padded to its largest member (MOUSEINPUT).
    #[repr(C)]
    #[allow(dead_code)]
    struct Input {
        kind: u32,
        ki: KeybdInput,
        pad: [u8; 8],
    }

    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(size_of::<Input>() == 40);
    #[cfg(target_pointer_width = "32")]
    const _: () = assert!(size_of::<Input>() == 28);

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SendInput(count: u32, inputs: *const Input, size: i32) -> u32;
    }

    /// Holds the modifiers, taps the key, then lets go of the modifiers.
    pub fn press(modifiers: &[u16], key: u16) {
        let event = |vk: u16, flags: u32| Input {
            kind: INPUT_KEYBOARD,
            ki: KeybdInput {
                vk,
                scan: 0,
                flags,
                time: 0,
                extra_info: 0,
            },
            pad: [0; 8],
        };
        let mut inputs: Vec<Input> = modifiers.iter().map(|&vk| event(vk, 0)).collect();
        inputs.push(event(key, 0));
        inputs.push(event(key, KEYEVENTF_KEYUP));
        inputs.extend(modifiers.iter().rev().map(|&vk| event(vk, KEYEVENTF_KEYUP)));
        // SAFETY: the array holds `inputs.len()` INPUTs of the size passed.
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<Input>() as i32,
            )
        };
        if sent == 0 {
            eprintln!("could not press keys for a menu command");
        }
    }
}

/// The two AppKit calls the menu needs, made through the Objective-C runtime
/// directly rather than through another crate.
#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{CStr, c_char, c_void};

    type Id = *mut c_void;
    type Sel = *const c_void;

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        // Called through a pointer cast to each call's exact signature.
        fn objc_msgSend();
    }

    /// Sends an action to whatever has focus, as a menu item with no target
    /// does. Returns whether something handled it.
    pub fn send_action(action: &CStr) -> bool {
        // SAFETY: each objc_msgSend call is cast to the signature of the
        // method it calls: +[NSApplication sharedApplication] and
        // -[NSApplication sendAction:to:from:]. Menu events arrive on the
        // main thread.
        unsafe {
            let class = objc_getClass(c"NSApplication".as_ptr());
            if class.is_null() {
                return false;
            }
            let shared: unsafe extern "C" fn(Id, Sel) -> Id =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            let app = shared(class, sel_registerName(c"sharedApplication".as_ptr()));
            if app.is_null() {
                return false;
            }
            let send: unsafe extern "C" fn(Id, Sel, Sel, Id, Id) -> u8 =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            send(
                app,
                sel_registerName(c"sendAction:to:from:".as_ptr()),
                sel_registerName(action.as_ptr()),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            ) != 0
        }
    }

    /// -[WKWebView reloadFromOrigin]: reloads, checking every resource with
    /// the server.
    pub fn reload_from_origin(webview: *mut c_void) {
        if webview.is_null() {
            return;
        }
        // SAFETY: `webview` is the WKWebView wry handed over, on the main
        // thread, and the cast matches - (WKNavigation *)reloadFromOrigin.
        unsafe {
            let reload: unsafe extern "C" fn(Id, Sel) -> Id =
                std::mem::transmute(objc_msgSend as unsafe extern "C" fn());
            reload(webview, sel_registerName(c"reloadFromOrigin".as_ptr()));
        }
    }
}
