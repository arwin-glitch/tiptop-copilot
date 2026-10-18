//! The main window's frame. On Windows it has no native title bar or menu
//! bar: the web app draws one bar across the top (the ☰ menu, Back and
//! Forward, Search Copilot, and minimise, maximise and close). On a Mac the
//! title bar is transparent and the traffic lights sit in that same bar.
//!
//! Here: the flag that tells the page to draw the bar, the safety-net bar for
//! pages that cannot, the main window's builder settings, and the three
//! commands the page may call (capabilities/, permissions/). Each command acts
//! only on the window that called it. Second windows keep a normal frame.

#[cfg(windows)]
use std::{
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Runtime, WebviewWindow, WebviewWindowBuilder};

/// What the page is told it is drawing for.
const FRAME: &str = if cfg!(target_os = "macos") { "mac" } else { "windows" };

/// Where the traffic lights go on a Mac, in points. x is the close button's
/// left edge. y is not its top: wry and tao set the title bar's container to
/// the button's height plus y, and AppKit keeps the buttons centred in it, so
/// 24 centres them on the 40pt bar. The page keeps 80px free for them
/// (src/components/desktop/desktop-title-bar.tsx). Check on a real Mac: if
/// they sit low, AppKit left them where they were and y wants about 18.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHTS: (f64, f64) = (16.0, 24.0);

/// How far from the window's top-left corner the ☰ menu may open, in logical
/// px. The bar keeps its size at any zoom, so its button's corner is about
/// (6, 40); the fallback page's bar grows with the zoom (40px at 300% is
/// 120). Nothing else on screen can be put under the menu: a page could only
/// open it here, and its first level holds nothing but File, Edit and View.
const MENU_ZONE: f64 = 128.0;

/// Where the pointer must be, in logical px from the window's top-left, for a
/// mouse press to count as one on ☰. The web bar keeps its size at any zoom
/// (the button spans 6 to 42 across and 6 to 34 down); the fallback page's
/// bar grows with the zoom, so the zone grows with it, never shrinks.
const BUTTON_ZONE: (f64, f64) = (48.0, 40.0);

/// How soon after a press on ☰ its click must ask for the menu.
const CLICK_WITHIN: Duration = Duration::from_millis(1500);

/// A page may not reopen the menu sooner than this after it closed, so a
/// script cannot bring it back the instant it is dismissed, and the click on
/// ☰ that dismisses it only closes it.
const REOPEN_AFTER: Duration = Duration::from_millis(300);

/// Tells the page to draw the window's top bar. Main window only, never the
/// second windows (attachments, the briefing), which keep their own frame.
/// Layout only, like the desktop flag; the server never grants anything on
/// the strength of it.
pub fn frame_flag() -> String {
    format!(
        "(function () {{\
         if (location.protocol !== 'https:' || location.hostname !== 'copilot.tiptop.vc' || window.top !== window) return;\
         try {{ Object.defineProperty(window, '__TIPTOP_DESKTOP_FRAME__', {{ value: '{FRAME}' }}); }} catch (_) {{}}\
         }})();"
    )
}

/// A plain bar that can move, minimise, maximise and close the window, for a
/// page on the live host that does not draw the real one: a host error page,
/// the offline page (its scripts are not cached), or a web deploy older than
/// this app. It steps aside once the real bar is ready.
pub fn safety_strip() -> String {
    include_str!("safety-strip.js").replace("__FRAME__", FRAME)
}

/// The main window's frame. Called on the builder from `window_builder`, so
/// the desktop flag stays the first script.
pub fn main_window<'a, R: Runtime>(
    builder: WebviewWindowBuilder<'a, R, AppHandle<R>>,
) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    let builder = builder
        .initialization_script(frame_flag())
        .initialization_script(safety_strip());

    // tao keeps WS_CAPTION, WS_SYSMENU and WS_SIZEBOX on an undecorated
    // window, so Alt+F4, Alt+Space, snapping, Win+arrows and resizing from
    // the edges stay native, and tauri-runtime-wry adds the strip that resizes
    // from the top. The shadow keeps the system frame, so Windows 11 rounds
    // the corners; Windows 10 draws its thin window border instead.
    #[cfg(windows)]
    let builder = builder.decorations(false).shadow(true);

    // Not accept_first_mouse: the first click into a window behind others
    // would also press whatever is under it.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            TRAFFIC_LIGHTS.0,
            TRAFFIC_LIGHTS.1,
        ));

    builder
}

/// What the bar's window buttons ask for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Minimize,
    ToggleMaximize,
    Close,
    ExitFullScreen,
}

impl Action {
    fn parse(action: &str) -> Option<Self> {
        match action {
            "minimize" => Some(Self::Minimize),
            "toggle-maximize" => Some(Self::ToggleMaximize),
            "close" => Some(Self::Close),
            "exit-full-screen" => Some(Self::ExitFullScreen),
            _ => None,
        }
    }
}

/// Minimise, maximise or restore, close, or leave full screen: the calling
/// window only. Close on the main window hides it, as its own close does.
/// Async, like tauri's own window commands, so it runs as a task of its own
/// rather than inside the webview's message callback.
#[tauri::command]
pub async fn window_control<R: Runtime>(
    window: WebviewWindow<R>,
    action: String,
) -> tauri::Result<()> {
    let Some(action) = Action::parse(&action) else {
        return Ok(());
    };
    match action {
        Action::Minimize => window.minimize()?,
        // As tauri's internal_toggle_maximize, which the bar's double-click
        // uses. Not in full screen, where the same button leaves it.
        Action::ToggleMaximize => {
            if !window.is_fullscreen()? && window.is_resizable()? {
                if window.is_maximized()? {
                    window.unmaximize()?;
                } else if window.is_maximizable()? {
                    window.maximize()?;
                }
            }
        }
        Action::Close => window.close()?,
        Action::ExitFullScreen => {
            if window.is_fullscreen()? {
                window.set_fullscreen(false)?;
            }
        }
    }
    Ok(())
}

/// Whether the calling window is maximised or full screen, and its View
/// zoom, which the bar undoes on itself so it keeps its size.
#[tauri::command]
pub async fn window_frame<R: Runtime>(
    window: WebviewWindow<R>,
) -> tauri::Result<serde_json::Value> {
    Ok(json!({
        "maximized": window.is_maximized().unwrap_or(false),
        "fullscreen": window.is_fullscreen().unwrap_or(false),
        "zoom": crate::menu::zoom_of(window.label()),
    }))
}

/// Opens File, Edit and View under the bar's ☰ button: Windows only (a Mac
/// keeps its menu bar). `x` and `y` are where the page wants the menu's
/// top-left corner, in its CSS px. Resolves once the menu has closed, and
/// without showing anything unless the person is asking for it (a click on
/// ☰, or a tap of Alt or F10), or when the window is not the one in front,
/// the menu is already open, or it closed a moment ago. The page calls it
/// twice for a click: as ☰ is pressed, which only notes the press, and on
/// the click, which opens the menu.
///
/// Async, as tauri's own menu popup, so the menu's loop starts from a task
/// of its own and not inside the webview's message callback.
#[tauri::command]
pub async fn show_app_menu<R: Runtime>(
    window: WebviewWindow<R>,
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    #[cfg(windows)]
    {
        use tauri::Manager;

        if window.label() != crate::MAIN || !window.is_visible()? || window.is_minimized()? {
            return Ok(());
        }
        // Only for the window in front: Windows brings a menu's owner to the
        // front, and a menu opened while another app is in front can be left
        // on screen over it.
        if !in_front(&window) {
            return Ok(());
        }
        // Only when the person is asking for it right now, as Windows itself
        // reports: a click on ☰, or a tap of Alt or F10 on its own. A page
        // can call this whenever it likes, but it cannot press a key or a
        // mouse button, so it cannot open the menu while someone types and
        // turn their next letters into menu picks (E, then P, is Edit >
        // Paste). For a click the page asks as ☰ is pressed, and this notes
        // the press if a button is held with the pointer on ☰; the click then
        // opens the menu, the button let go and the pointer still there. For
        // a key the page asks as it goes down; the menu opens once it is let
        // go, as Windows' own menus do, and not at all if another key or a
        // button joins it (Alt+←, AltGr, Alt+Tab). Nothing borrowed is held
        // across the wait.
        let zoom = crate::menu::zoom_of(window.label());
        let clicked = match pointer_on_button(&window, zoom) {
            Some(true) => {
                input::note_press();
                return Ok(());
            }
            Some(false) => input::take_press(),
            None => false,
        };
        if !clicked {
            let Some(key) = input::lone_menu_key() else {
                return Ok(());
            };
            let alone = tauri::async_runtime::spawn_blocking(move || input::released_alone(key))
                .await
                .unwrap_or(false);
            if !alone || !in_front(&window) {
                return Ok(());
            }
        }
        let Some(menu) = crate::menu::app_menu(window.app_handle()) else {
            return Ok(());
        };
        let Some(_open) = OpenMenu::take() else {
            return Ok(());
        };
        // CSS px times the page's zoom are logical px from the top-left of
        // the window's client area, which the webview fills; muda scales them
        // by the window's DPI and calls ClientToScreen. The menu's top-left
        // goes there, and Windows moves it in from the screen's edges.
        let size = window.inner_size()?.to_logical::<f64>(window.scale_factor()?);
        let Some((left, top)) = menu_point(x, y, zoom, size.width, size.height) else {
            return Ok(());
        };
        // Paste and Match Style, Delete and the View items arrive after the
        // menu closes and act on the window in front: this one.
        crate::menu::focused(window.label());
        let (done, wait) = std::sync::mpsc::channel();
        let owner = window.clone();
        window.run_on_main_thread(move || {
            let mode = dark_menu::force();
            let shown = owner.popup_menu_at(&menu, tauri::LogicalPosition::new(left, top));
            dark_menu::restore(mode);
            let _ = done.send(shown);
        })?;
        wait.recv().map_err(|_| tauri::Error::FailedToReceiveMessage)??;
    }
    #[cfg(not(windows))]
    let _ = (window, x, y);
    Ok(())
}

/// Where the ☰ menu opens, in logical px from the window's top-left: the
/// page's point times its zoom, kept inside the window and the button's
/// corner of it. None for a point that is not a number.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn menu_point(
    x: f64,
    y: f64,
    zoom: f64,
    width: f64,
    height: f64,
) -> Option<(f64, f64)> {
    if !(x.is_finite() && y.is_finite() && zoom.is_finite() && zoom > 0.0) {
        return None;
    }
    let limit = |size: f64| {
        if size.is_nan() {
            0.0
        } else {
            size.clamp(0.0, MENU_ZONE)
        }
    };
    Some((
        (x * zoom).clamp(0.0, limit(width)),
        (y * zoom).clamp(0.0, limit(height)),
    ))
}

/// Whether a point, in logical px from the window's top-left, is on the ☰
/// button's corner of the window at this zoom (`BUTTON_ZONE`).
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn on_menu_button(x: f64, y: f64, zoom: f64) -> bool {
    if !zoom.is_finite() {
        return false;
    }
    let grow = zoom.max(1.0);
    x >= 0.0 && y >= 0.0 && x <= BUTTON_ZONE.0 * grow && y <= BUTTON_ZONE.1 * grow
}

/// Alt, either side of the keyboard (VK_MENU, VK_LMENU, VK_RMENU), and F10.
#[cfg_attr(not(windows), allow(dead_code))]
const ALT: i32 = 0x12;
#[cfg_attr(not(windows), allow(dead_code))]
const LEFT_ALT: i32 = 0xA4;
#[cfg_attr(not(windows), allow(dead_code))]
const RIGHT_ALT: i32 = 0xA5;
#[cfg_attr(not(windows), allow(dead_code))]
const F10: i32 = 0x79;

/// Whether Windows' key `code`, held with the menu key `key`, makes it a
/// shortcut rather than a tap of that key alone. Alt is also reported as left
/// or right Alt. The input method keys (0x15 to 0x1F) never count: on some
/// keyboards Windows reports a locked kana mode as a key held down.
#[cfg_attr(not(windows), allow(dead_code))]
fn joins(key: i32, code: i32) -> bool {
    let same = code == key || (key == ALT && (code == LEFT_ALT || code == RIGHT_ALT));
    !same && !(0x15..=0x1F).contains(&code)
}

/// Whether a press on ☰ was `CLICK_WITHIN` of `now`.
#[cfg_attr(not(windows), allow(dead_code))]
fn pressed_just_now(pressed: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    pressed.is_some_and(|at| at <= now && now - at < CLICK_WITHIN)
}

/// With the pointer on ☰: whether a mouse button is held down. None when the
/// pointer is anywhere else.
#[cfg(windows)]
fn pointer_on_button<R: Runtime>(window: &WebviewWindow<R>, zoom: f64) -> Option<bool> {
    let (Ok(hwnd), Ok(scale)) = (window.hwnd(), window.scale_factor()) else {
        return None;
    };
    let ((x, y), held) = input::pointer(hwnd.0 as *mut std::ffi::c_void)?;
    let on = scale > 0.0 && on_menu_button(f64::from(x) / scale, f64::from(y) / scale, zoom);
    on.then_some(held)
}

/// The keyboard and mouse as they are right now, from Windows itself, which
/// a page cannot fake. Raw user32 calls, like `GetForegroundWindow` below.
#[cfg(windows)]
mod input {
    use std::{
        ffi::c_void,
        sync::{
            Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::{Duration, Instant},
    };

    use super::{ALT, F10, joins, pressed_just_now};

    /// The mouse's left and right buttons. Windows reports the physical
    /// ones, and the primary may be either, so both count.
    const LEFT_BUTTON: i32 = 0x01;
    const RIGHT_BUTTON: i32 = 0x02;
    /// Held longer than this, Alt or F10 is not a tap.
    const LONGEST_TAP: Duration = Duration::from_millis(1500);
    const POLL: Duration = Duration::from_millis(10);

    /// One wait for a key at a time, however often a page asks.
    static WAITING: AtomicBool = AtomicBool::new(false);

    /// When a mouse button was last seen held with the pointer on ☰.
    static PRESSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

    /// POINT.
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetAsyncKeyState(key: i32) -> i16;
        fn GetCursorPos(point: *mut Point) -> i32;
        fn ScreenToClient(window: *mut c_void, point: *mut Point) -> i32;
    }

    /// Whether a key or mouse button is held down now.
    fn down(code: i32) -> bool {
        // SAFETY: only reads one key's state; every code from 1 to 254 is
        // valid, and the top bit (a negative value) means "down".
        unsafe { GetAsyncKeyState(code) < 0 }
    }

    /// Where the pointer is, in physical px from the top-left of `window`'s
    /// client area, and whether a mouse button is held down.
    pub fn pointer(window: *mut c_void) -> Option<((i32, i32), bool)> {
        let mut point = Point { x: 0, y: 0 };
        // SAFETY: both only write the one Point owned here, and `window` is
        // the handle of a window that is open.
        let found =
            unsafe { GetCursorPos(&mut point) != 0 && ScreenToClient(window, &mut point) != 0 };
        let held = down(LEFT_BUTTON) || down(RIGHT_BUTTON);
        found.then_some(((point.x, point.y), held))
    }

    /// A mouse button is held with the pointer on ☰ now.
    pub fn note_press() {
        if let Ok(mut pressed) = PRESSED_AT.lock() {
            *pressed = Some(Instant::now());
        }
    }

    /// Whether ☰ was pressed just now; a press opens the menu once only.
    pub fn take_press() -> bool {
        let pressed = PRESSED_AT.lock().ok().and_then(|mut at| at.take());
        pressed_just_now(pressed, Instant::now())
    }

    /// Alt or F10, when it is the only key or button held down.
    pub fn lone_menu_key() -> Option<i32> {
        let key = [ALT, F10].into_iter().find(|&key| down(key))?;
        (!others_down(key)).then_some(key)
    }

    fn others_down(key: i32) -> bool {
        (1..=0xFE).any(|code| joins(key, code) && down(code))
    }

    /// Waits for `key` to be let go: true if it was, within `LONGEST_TAP`,
    /// with no other key or button pressed meanwhile.
    pub fn released_alone(key: i32) -> bool {
        if WAITING.swap(true, Ordering::AcqRel) {
            return false;
        }
        let start = Instant::now();
        let alone = loop {
            if others_down(key) || start.elapsed() > LONGEST_TAP {
                break false;
            }
            if !down(key) {
                break true;
            }
            thread::sleep(POLL);
        };
        WAITING.store(false, Ordering::Release);
        alone
    }
}

/// Whether the menu closed less than `REOPEN_AFTER` before `now`.
#[cfg_attr(not(windows), allow(dead_code))]
fn closed_too_recently(closed: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    closed.is_some_and(|at| now.saturating_duration_since(at) < REOPEN_AFTER)
}

/// Held while the ☰ menu is open. A second menu could not open anyway.
#[cfg(windows)]
struct OpenMenu;

#[cfg(windows)]
static MENU_OPEN: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
static MENU_CLOSED_AT: Mutex<Option<Instant>> = Mutex::new(None);

#[cfg(windows)]
impl OpenMenu {
    fn take() -> Option<Self> {
        let closed = MENU_CLOSED_AT.lock().ok().and_then(|at| *at);
        if closed_too_recently(closed, Instant::now()) || MENU_OPEN.swap(true, Ordering::AcqRel) {
            return None;
        }
        Some(Self)
    }
}

#[cfg(windows)]
impl Drop for OpenMenu {
    fn drop(&mut self) {
        if let Ok(mut at) = MENU_CLOSED_AT.lock() {
            *at = Some(Instant::now());
        }
        MENU_OPEN.store(false, Ordering::Release);
    }
}

#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    /// Returns an HWND, which is pointer-sized.
    fn GetForegroundWindow() -> isize;
}

/// Whether `window` is the window in front. Its webview has the keyboard
/// focus, but the window in front is still the top-level one.
#[cfg(windows)]
fn in_front<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    // SAFETY: takes no arguments and only reads which window is in front.
    let front = unsafe { GetForegroundWindow() };
    front != 0 && front == hwnd.0 as isize
}

/// Windows draws a menu light or dark by the app's preferred mode, which
/// muda cannot set; tao asks it to follow the system. The bar is always
/// dark, so the ☰ menu is made dark while it is open, then the mode goes
/// back, so the tray menu and second windows' menus keep following Windows.
/// These are uxtheme's unnamed exports, looked up by number at run time the
/// way tao looks up its own, and used only from Windows 10 1903 (build
/// 18362), where number 135 is SetPreferredAppMode. Anywhere else this does
/// nothing and the menu follows Windows.
#[cfg(windows)]
mod dark_menu {
    use std::{
        ffi::{c_char, c_void},
        ptr,
        sync::LazyLock,
    };

    const SET_PREFERRED_APP_MODE: usize = 135;
    const FLUSH_MENU_THEMES: usize = 136;
    const FIRST_BUILD: u32 = 18362;
    /// PreferredAppMode: Default, AllowDark (tao's), ForceDark, ForceLight.
    const ALLOW_DARK: i32 = 1;
    const FORCE_DARK: i32 = 2;
    const FORCE_LIGHT: i32 = 3;

    type SetPreferredAppMode = unsafe extern "system" fn(i32) -> i32;
    type FlushMenuThemes = unsafe extern "system" fn();
    type RtlGetVersion = unsafe extern "system" fn(*mut OsVersionInfo) -> i32;

    /// OSVERSIONINFOW. Windows fills in every field; Rust reads two.
    #[repr(C)]
    #[allow(dead_code)]
    struct OsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
    }

    struct Calls {
        set_mode: SetPreferredAppMode,
        flush: FlushMenuThemes,
    }

    static CALLS: LazyLock<Option<Calls>> = LazyLock::new(calls);

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// The Windows build number, from ntdll (GetVersionEx would lie).
    fn build() -> Option<u32> {
        let ntdll = wide("ntdll.dll");
        // SAFETY: the names are NUL-terminated and outlive the calls; the
        // address is RtlGetVersion's, whose signature RtlGetVersion matches,
        // and the struct is OSVERSIONINFOW with its size filled in.
        unsafe {
            let module = GetModuleHandleW(ntdll.as_ptr());
            if module.is_null() {
                return None;
            }
            let address = GetProcAddress(module, c"RtlGetVersion".as_ptr());
            if address.is_null() {
                return None;
            }
            let get = std::mem::transmute::<*mut c_void, RtlGetVersion>(address);
            let mut info = OsVersionInfo {
                size: size_of::<OsVersionInfo>() as u32,
                major: 0,
                minor: 0,
                build: 0,
                platform: 0,
                service_pack: [0; 128],
            };
            (get(&mut info) == 0 && info.major == 10).then_some(info.build)
        }
    }

    fn calls() -> Option<Calls> {
        if build()? < FIRST_BUILD {
            return None;
        }
        let uxtheme = wide("uxtheme.dll");
        // SAFETY: the name is NUL-terminated and outlives the call; the
        // numbers are passed as names the way Windows expects (MAKEINTRESOURCE),
        // and from build 18362 the two exports have exactly these signatures.
        unsafe {
            let module = LoadLibraryW(uxtheme.as_ptr());
            if module.is_null() {
                return None;
            }
            let set_mode = GetProcAddress(module, ptr::without_provenance(SET_PREFERRED_APP_MODE));
            let flush = GetProcAddress(module, ptr::without_provenance(FLUSH_MENU_THEMES));
            if set_mode.is_null() || flush.is_null() {
                return None;
            }
            Some(Calls {
                set_mode: std::mem::transmute::<*mut c_void, SetPreferredAppMode>(set_mode),
                flush: std::mem::transmute::<*mut c_void, FlushMenuThemes>(flush),
            })
        }
    }

    /// Makes menus dark; returns the mode to go back to. On the main thread.
    pub fn force() -> Option<i32> {
        let calls = CALLS.as_ref()?;
        // SAFETY: see `calls`; both only change uxtheme's own state.
        let previous = unsafe {
            let previous = (calls.set_mode)(FORCE_DARK);
            (calls.flush)();
            previous
        };
        Some(if (0..=FORCE_LIGHT).contains(&previous) {
            previous
        } else {
            ALLOW_DARK
        })
    }

    /// Puts back the mode `force` replaced. On the main thread.
    pub fn restore(previous: Option<i32>) {
        let (Some(calls), Some(previous)) = (CALLS.as_ref(), previous) else {
            return;
        };
        // SAFETY: see `calls`.
        unsafe {
            (calls.set_mode)(previous);
            (calls.flush)();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn menu_point_scales_by_zoom() {
        assert_eq!(menu_point(6.0, 40.0, 1.0, 1280.0, 800.0), Some((6.0, 40.0)));
        assert_eq!(menu_point(6.0, 40.0, 1.25, 1280.0, 800.0), Some((7.5, 50.0)));
        assert_eq!(menu_point(6.0, 40.0, 3.0, 1280.0, 800.0), Some((18.0, 120.0)));
        // The web bar undoes the zoom on itself, so it reports 40 / zoom.
        assert_eq!(menu_point(4.0, 32.0, 1.25, 1280.0, 800.0), Some((5.0, 40.0)));
    }

    #[test]
    fn menu_point_stays_in_the_buttons_corner() {
        assert_eq!(menu_point(-5.0, -1.0, 1.0, 1280.0, 800.0), Some((0.0, 0.0)));
        assert_eq!(menu_point(900.0, 600.0, 1.0, 1280.0, 800.0), Some((128.0, 128.0)));
        assert_eq!(menu_point(1e308, 1e308, 4.0, 1280.0, 800.0), Some((128.0, 128.0)));
    }

    #[test]
    fn menu_point_stays_in_the_window() {
        assert_eq!(menu_point(900.0, 600.0, 1.0, 100.0, 50.0), Some((100.0, 50.0)));
        assert_eq!(menu_point(6.0, 40.0, 1.0, 0.0, 0.0), Some((0.0, 0.0)));
        assert_eq!(menu_point(6.0, 40.0, 1.0, -10.0, f64::NAN), Some((0.0, 0.0)));
    }

    #[test]
    fn menu_point_refuses_what_is_not_a_number() {
        assert_eq!(menu_point(f64::NAN, 40.0, 1.0, 1280.0, 800.0), None);
        assert_eq!(menu_point(6.0, f64::INFINITY, 1.0, 1280.0, 800.0), None);
        assert_eq!(menu_point(6.0, 40.0, 0.0, 1280.0, 800.0), None);
        assert_eq!(menu_point(6.0, 40.0, -1.0, 1280.0, 800.0), None);
        assert_eq!(menu_point(6.0, 40.0, f64::NAN, 1280.0, 800.0), None);
    }

    #[test]
    fn only_a_press_on_the_menu_button_counts() {
        assert!(on_menu_button(20.0, 20.0, 1.0));
        assert!(on_menu_button(0.0, 0.0, 1.0));
        assert!(on_menu_button(48.0, 40.0, 1.0));
        // Back, the page under the bar, and off the window's left or top.
        assert!(!on_menu_button(60.0, 20.0, 1.0));
        assert!(!on_menu_button(20.0, 41.0, 1.0));
        assert!(!on_menu_button(-1.0, 20.0, 1.0));
        assert!(!on_menu_button(20.0, -1.0, 1.0));
        // The fallback page's bar grows with the zoom; the web bar is 40
        // high at any zoom, so the zone never shrinks below it.
        assert!(on_menu_button(60.0, 55.0, 1.5));
        assert!(!on_menu_button(80.0, 20.0, 1.5));
        assert!(on_menu_button(40.0, 38.0, 0.5));
        assert!(!on_menu_button(40.0, 41.0, 0.5));
        assert!(!on_menu_button(f64::NAN, 20.0, 1.0));
        assert!(!on_menu_button(20.0, f64::NAN, 1.0));
        assert!(!on_menu_button(20.0, 20.0, f64::NAN));
        assert!(!on_menu_button(20.0, 20.0, f64::INFINITY));
    }

    #[test]
    fn a_click_must_follow_its_press_at_once() {
        let pressed = std::time::Instant::now();
        assert!(!pressed_just_now(None, pressed));
        assert!(pressed_just_now(Some(pressed), pressed));
        assert!(pressed_just_now(Some(pressed), pressed + Duration::from_millis(1499)));
        assert!(!pressed_just_now(Some(pressed), pressed + CLICK_WITHIN));
        // A press dated after the click (a clock read out of order) is none.
        assert!(!pressed_just_now(Some(pressed + Duration::from_secs(1)), pressed));
    }

    #[test]
    fn another_key_makes_alt_or_f10_a_shortcut() {
        // Alt itself, however Windows reports it, is not another key.
        for same in [ALT, LEFT_ALT, RIGHT_ALT] {
            assert!(!joins(ALT, same), "{same:#x}");
        }
        assert!(!joins(F10, F10));
        // Ctrl (AltGr is Ctrl+Alt), left Ctrl, Shift, Tab, a letter, ←, F4,
        // the left mouse button.
        for other in [0x11, 0xA2, 0x10, 0x09, 0x45, 0x25, 0x73, 0x01] {
            assert!(joins(ALT, other), "{other:#x}");
            assert!(joins(F10, other), "{other:#x}");
        }
        assert!(joins(F10, ALT));
        assert!(joins(F10, LEFT_ALT));
        assert!(joins(ALT, F10));
        // Input method keys, which a locked kana mode can report as held.
        for ime in [0x15, 0x19, 0x1F] {
            assert!(!joins(ALT, ime), "{ime:#x}");
        }
    }

    #[test]
    fn the_menu_cannot_be_reopened_at_once() {
        let closed = std::time::Instant::now();
        assert!(!closed_too_recently(None, closed));
        assert!(closed_too_recently(Some(closed), closed));
        assert!(closed_too_recently(Some(closed), closed + Duration::from_millis(299)));
        assert!(!closed_too_recently(Some(closed), closed + REOPEN_AFTER));
        // A clock read before the close counts as too soon, not as a panic.
        assert!(closed_too_recently(Some(closed + Duration::from_secs(1)), closed));
    }

    #[test]
    fn actions_parse_exactly() {
        assert_eq!(Action::parse("minimize"), Some(Action::Minimize));
        assert_eq!(Action::parse("toggle-maximize"), Some(Action::ToggleMaximize));
        assert_eq!(Action::parse("close"), Some(Action::Close));
        assert_eq!(Action::parse("exit-full-screen"), Some(Action::ExitFullScreen));
        for other in ["Minimize", "", "maximize", "close ", "fullscreen"] {
            assert_eq!(Action::parse(other), None, "{other:?}");
        }
    }

    const GUARD: [&str; 3] = [
        "location.protocol !== 'https:'",
        "location.hostname !== 'copilot.tiptop.vc'",
        "window.top !== window",
    ];

    #[test]
    fn frame_flag_is_guarded() {
        let flag = frame_flag();
        for part in GUARD {
            assert!(flag.contains(part), "{part}");
        }
        assert!(flag.contains("__TIPTOP_DESKTOP_FRAME__"));
        assert!(flag.contains(&format!("value: '{FRAME}'")));
        assert!(FRAME == "mac" || FRAME == "windows");
    }

    #[test]
    fn safety_strip_is_guarded() {
        let strip = safety_strip();
        for part in GUARD {
            assert!(strip.contains(part), "{part}");
        }
        assert!(!strip.contains("__FRAME__"));
        assert!(strip.contains(&format!("var FRAME = '{FRAME}';")));
        // CSP-safe: no inline style attributes and no HTML strings.
        assert!(!strip.contains("innerHTML"));
        assert!(!strip.contains("setAttribute('style'"));
        // Never counted as the real bar.
        assert!(!strip.contains("setAttribute('data-titlebar',"));
    }

    fn strings(value: &serde_json::Value) -> Vec<&str> {
        value
            .as_array()
            .expect("a list")
            .iter()
            .map(|item| item.as_str().expect("a string"))
            .collect()
    }

    #[test]
    fn the_page_gets_only_the_title_strip_permissions() {
        let files = [
            (
                include_str!("../capabilities/title-strip-windows.json"),
                "title-strip-windows",
                "windows",
                vec![
                    "core:window:allow-start-dragging",
                    "core:window:allow-internal-toggle-maximize",
                    "allow-window-control",
                    "allow-window-frame",
                    "allow-show-app-menu",
                ],
            ),
            (
                include_str!("../capabilities/title-strip-mac.json"),
                "title-strip-mac",
                "macOS",
                vec![
                    "core:window:allow-start-dragging",
                    "core:window:allow-internal-toggle-maximize",
                    "allow-window-frame",
                ],
            ),
        ];
        for (text, identifier, platform, permissions) in files {
            let capability: serde_json::Value = serde_json::from_str(text).expect("valid JSON");
            assert_eq!(capability["identifier"], identifier);
            assert_eq!(capability["local"], true);
            assert_eq!(strings(&capability["windows"]), ["main"]);
            assert!(capability.get("webviews").is_none());
            assert_eq!(strings(&capability["platforms"]), [platform]);
            // The live site only: https on its standard port (urlpattern
            // reads a host with no port, or :443, as exactly that port).
            assert_eq!(
                strings(&capability["remote"]["urls"]),
                ["https://copilot.tiptop.vc:443/*"]
            );
            let granted = strings(&capability["permissions"]);
            assert_eq!(granted, permissions);
            let refused = [
                "core:event",
                "core:webview",
                "core:menu",
                "opener:",
                "updater:",
                "window-state:",
            ];
            for permission in granted {
                assert!(!permission.ends_with(":default"), "{permission}");
                for prefix in refused {
                    assert!(!permission.starts_with(prefix), "{permission}");
                }
            }
        }
    }

    #[test]
    fn each_app_permission_allows_one_command() {
        let file = include_str!("../permissions/title-strip.toml");
        for (identifier, command) in [
            ("allow-window-control", "window_control"),
            ("allow-window-frame", "window_frame"),
            ("allow-show-app-menu", "show_app_menu"),
        ] {
            assert!(file.contains(&format!("identifier = \"{identifier}\"")), "{identifier}");
            assert!(file.contains(&format!("commands.allow = [\"{command}\"]")), "{command}");
        }
        assert_eq!(file.matches("[[permission]]").count(), 3);
        assert_eq!(file.matches("commands.allow").count(), 3);
    }
}
