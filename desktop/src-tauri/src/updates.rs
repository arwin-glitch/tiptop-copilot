//! In-app updates. About 15 seconds after launch, and then every 6 hours, the
//! app asks Copilot whether a newer version exists (tauri.conf.json > plugins
//! > updater), downloads it in the background and asks whether to restart.
//! Check for Updates… does the same and also says when nothing is new. Every
//! download is checked against the public key built into the app, and the
//! version it was signed for, before anything is installed.
//!
//! All of it runs here in Rust: the page gets no command and no injected
//! script. The dialogs are rfd's, not tauri-plugin-dialog's, whose script
//! would replace alert and confirm in the page with calls it may not make.

use std::{
    sync::{Mutex, MutexGuard, OnceLock, PoisonError},
    time::{Duration, SystemTime},
};

use rfd::{AsyncMessageDialog, MessageButtons, MessageDialogResult, MessageLevel};
use tauri::{AppHandle, Manager, Runtime, menu::MenuItem};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Check for Updates…: menu.rs places it, the handler set up in `init` answers it.
pub const MENU_ID: &str = "app-check-for-updates";

const FIRST_CHECK: Duration = Duration::from_secs(15);
const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// After a check that failed (offline, the service asleep or busy).
const RETRY: Duration = Duration::from_secs(30 * 60);
/// How often the timer looks at the clock. Wall-clock time, so a laptop that
/// slept through a check catches up within this long of waking.
const TICK: Duration = Duration::from_secs(5 * 60);
/// A cold start of the web service can take most of a minute.
const CHECK_TIMEOUT: Duration = Duration::from_secs(60);
/// The updater sets no download timeout of its own (Update::timeout is None).
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

const RESTART: &str = "Restart now";
const LATER: &str = "Later";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Trigger {
    Automatic,
    Manual,
}

/// What `State::begin` decided.
#[derive(PartialEq, Eq, Debug)]
enum Begin {
    /// This call runs the check.
    Run,
    /// A check is already running; it reports to this manual one.
    Joined,
    /// Restart now was chosen, so nothing else starts.
    Refused,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Check,
    Download,
}

enum Outcome {
    UpToDate,
    Ready(String),
    Failed(Stage),
    /// A Mac copy running from the disk image, or from where it was
    /// downloaded, cannot replace itself.
    WrongPlace,
}

struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct State {
    /// A check or download is running.
    running: bool,
    /// Check for Updates… was chosen while a check ran: that check reports.
    report: bool,
    /// Downloaded and verified, waiting for Restart now.
    ready: Option<Ready>,
    /// Our restart question is on screen; never stack a second one.
    asking: bool,
    /// Restart now was chosen; nothing else starts.
    installing: bool,
    /// The wrong-place notice was shown since launch.
    told_place: bool,
    /// The last check that ran, manual or automatic: the timer goes by it.
    last: Option<Checked>,
}

impl State {
    /// One check at a time: a manual call made while one runs asks that one
    /// to report instead.
    fn begin(&mut self, trigger: Trigger) -> Begin {
        if self.installing {
            return Begin::Refused;
        }
        if trigger == Trigger::Manual {
            self.report = true;
        }
        if self.running {
            return Begin::Joined;
        }
        self.running = true;
        Begin::Run
    }

    /// Ends a check, noting when and whether it failed; true when someone
    /// asked to hear how it went.
    fn end(&mut self, failed: bool, at: SystemTime) -> bool {
        self.running = false;
        self.last = Some(Checked { at, failed });
        std::mem::take(&mut self.report)
    }

    /// Check for Updates… shows "Checking…" while a check it asked for runs.
    fn checking(&self) -> bool {
        self.running && self.report
    }

    /// The wrong-place notice: every manual check, else once per launch.
    fn tell_place(&mut self, report: bool) -> bool {
        let first = !std::mem::replace(&mut self.told_place, true);
        report || first
    }

    fn ready_version(&self) -> Option<String> {
        self.ready.as_ref().map(|ready| ready.update.version.clone())
    }
}

struct Updates<R: Runtime> {
    state: Mutex<State>,
    /// Check for Updates…, once menu.rs has built it.
    item: OnceLock<MenuItem<R>>,
}

impl<R: Runtime> Default for Updates<R> {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            item: OnceLock::new(),
        }
    }
}

impl<R: Runtime> Updates<R> {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn updates<R: Runtime>(app: &AppHandle<R>) -> &Updates<R> {
    app.state::<Updates<R>>().inner()
}

/// The menu item's text, and whether it can be chosen.
fn menu_label(checking: bool, windows: bool) -> (&'static str, bool) {
    match (checking, windows) {
        (true, _) => ("Checking for Updates…", false),
        (false, true) => ("Check for &Updates…", true),
        (false, false) => ("Check for Updates…", true),
    }
}

/// The menu item, for menu.rs: after About on a Mac, in File on Windows.
pub fn menu_item<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<MenuItem<R>> {
    let (text, enabled) = menu_label(false, cfg!(windows));
    let item = MenuItem::with_id(app, MENU_ID, text, enabled, None::<&str>)?;
    if let Some(shared) = app.try_state::<Updates<R>>() {
        let _ = shared.item.set(item.clone());
    }
    Ok(item)
}

/// Brings the menu item in line with the state. It reads the state on the
/// main thread, where every change to the item is made, so the last refresh
/// always shows the latest state.
fn refresh_menu_item<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let posted = app.run_on_main_thread(move || {
        let shared = updates(&handle);
        let Some(item) = shared.item.get() else {
            return;
        };
        let (text, enabled) = menu_label(shared.lock().checking(), cfg!(windows));
        if item
            .set_text(text)
            .and_then(|()| item.set_enabled(enabled))
            .is_err()
        {
            eprintln!("could not update the Check for Updates item");
        }
    });
    if posted.is_err() {
        eprintln!("could not update the Check for Updates item");
    }
}

/// Keeps the state, answers the menu item and starts the timer. Call it in
/// setup(), before the menus are built.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    app.manage(Updates::<R>::default());
    // Menu events reach every handler; menu.rs ignores this id.
    app.on_menu_event(|app, event| {
        if event.id == MENU_ID {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { check(&app, Trigger::Manual).await });
        }
    });
    // A development build never checks by itself.
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    let timer = std::thread::Builder::new()
        .name("update-timer".into())
        .spawn(move || {
            std::thread::sleep(FIRST_CHECK);
            loop {
                // A check it joins counts once that check ends, so a manual
                // check that failed is tried again after 30 minutes too.
                let last = updates(&app).lock().last;
                if due(last, SystemTime::now()) {
                    tauri::async_runtime::block_on(check(&app, Trigger::Automatic));
                }
                std::thread::sleep(TICK);
            }
        });
    if timer.is_err() {
        eprintln!("could not start the update timer");
    }
}

/// When a check ended, and whether it failed.
#[derive(Clone, Copy)]
struct Checked {
    at: SystemTime,
    failed: bool,
}

/// At once the first time, then 6 hours after a check that worked, or 30
/// minutes after one that failed. A clock that went backwards counts as due.
fn due(last: Option<Checked>, now: SystemTime) -> bool {
    last.is_none_or(|last| {
        let wait = if last.failed { RETRY } else { EVERY };
        now.duration_since(last.at).map_or(true, |gone| gone >= wait)
    })
}

/// Runs one check, or joins the one running, which then reports to a manual
/// call and records how it went for the timer.
async fn check<R: Runtime>(app: &AppHandle<R>, trigger: Trigger) {
    let begun = updates(app).lock().begin(trigger);
    if trigger == Trigger::Manual && begun != Begin::Refused {
        refresh_menu_item(app);
    }
    if begun != Begin::Run {
        return;
    }
    let outcome = find_and_download(app).await;
    let failed = matches!(outcome, Outcome::Failed(_));
    let report = updates(app).lock().end(failed, SystemTime::now());
    if report {
        refresh_menu_item(app);
    }
    match outcome {
        // Asked whoever started it; Later asks again at the next check.
        Outcome::Ready(next) => ask_to_restart(app, &next),
        // Automatic checks stay silent; only a manual one hears these.
        Outcome::UpToDate if report => {
            let current = app.package_info().version.to_string();
            tell(
                app,
                "You’re up to date",
                &format!("TipTop Copilot {current} is the newest version."),
            );
        }
        Outcome::Failed(Stage::Check) if report => tell(
            app,
            "Couldn’t check for updates",
            "Copilot didn’t answer. Try again in a few minutes.",
        ),
        Outcome::Failed(Stage::Download) if report => tell(
            app,
            "Couldn’t download the update",
            "Try again in a few minutes. If it keeps failing, download the newest version \
             from copilot.tiptop.vc/download.",
        ),
        Outcome::WrongPlace if updates(app).lock().tell_place(report) => tell(
            app,
            "Move TipTop Copilot to Applications",
            "This copy is running from the disk image or from Downloads, so it can’t update \
             itself. Quit it, drag TipTop Copilot into the Applications folder, then open it \
             from there.",
        ),
        _ => {}
    }
}

async fn find_and_download<R: Runtime>(app: &AppHandle<R>) -> Outcome {
    if !can_update_here() {
        eprintln!("not checking for updates: this copy cannot replace itself");
        return Outcome::WrongPlace;
    }
    #[allow(unused_mut)]
    let mut builder = app.updater_builder().timeout(CHECK_TIMEOUT);
    #[cfg(windows)]
    {
        builder = builder.on_before_exit(before_installer(app.clone()));
    }
    let updater = match builder.build() {
        Ok(updater) => updater,
        Err(e) => {
            eprintln!("could not set up the update check: {e}");
            return Outcome::Failed(Stage::Check);
        }
    };
    let found = match updater.check().await {
        Ok(found) => found,
        Err(e) => {
            eprintln!("update check failed: {e}");
            // Offline or refused: a download already verified is still good.
            return fall_back(app, Stage::Check);
        }
    };
    let Some(mut update) = found else {
        // Nothing newer, or the newer release was withdrawn: drop any download.
        updates(app).lock().ready = None;
        return Outcome::UpToDate;
    };
    if updates(app).lock().ready_version().as_deref() == Some(update.version.as_str()) {
        return Outcome::Ready(update.version);
    }
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    // download() checks the signature, and the version it was signed for.
    let downloaded = update.download(|_, _| {}, || {}).await;
    match downloaded {
        Ok(bytes) => {
            let version = update.version.clone();
            eprintln!("update {version} downloaded and verified");
            updates(app).lock().ready = Some(Ready { update, bytes });
            Outcome::Ready(version)
        }
        Err(e) => {
            eprintln!("update {} could not be downloaded: {e}", update.version);
            fall_back(app, Stage::Download)
        }
    }
}

fn fall_back<R: Runtime>(app: &AppHandle<R>, stage: Stage) -> Outcome {
    updates(app)
        .lock()
        .ready_version()
        .map_or(Outcome::Failed(stage), Outcome::Ready)
}

/// Whether this copy can replace itself. macOS runs a copy opened from the
/// disk image, or one still where it was downloaded (App Translocation), from
/// a read-only place. A copy on any writable disk can.
fn can_update_here() -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe) = tauri::utils::platform::current_exe() {
            // …/TipTop Copilot.app/Contents/MacOS/<binary>
            let bundle = exe.ancestors().nth(3).unwrap_or(exe.as_path());
            return !read_only_place(&exe.to_string_lossy(), mac::on_read_only_volume(bundle));
        }
    }
    true
}

#[cfg(any(target_os = "macos", test))]
fn read_only_place(exe: &str, read_only_volume: bool) -> bool {
    read_only_volume || exe.contains("/AppTranslocation/")
}

/// Runs just before the Windows installer starts. The updater then ends the
/// process at once (std::process::exit), so the exit events that keep the
/// window's place and take the tray icon down never fire. Done on the main
/// thread, in order, and waited for.
#[cfg(windows)]
fn before_installer<R: Runtime>(app: AppHandle<R>) -> impl Fn() + Send + Sync + 'static {
    move || {
        let (done, wait) = std::sync::mpsc::channel();
        let handle = app.clone();
        let posted = app.run_on_main_thread(move || {
            use tauri_plugin_window_state::AppHandleExt;
            crate::menu::leave_full_screen(&handle);
            if handle.save_window_state(crate::state_flags()).is_err() {
                eprintln!("could not save the window's place");
            }
            drop(handle.remove_tray_by_id("main"));
            let _ = done.send(());
        });
        if posted.is_ok() {
            let _ = wait.recv_timeout(Duration::from_secs(5));
        }
    }
}

/// [Later] [Restart now] on Windows; a Mac puts the first button on the right.
/// The first is the default, so Return or Enter, pressed by someone typing
/// when the question appears, never restarts.
fn restart_buttons() -> MessageButtons {
    MessageButtons::OkCancelCustom(LATER.to_owned(), RESTART.to_owned())
}

/// rfd answers with the label of the button pressed; Esc or closing the box
/// is Cancel.
fn chose_restart(answer: &MessageDialogResult) -> bool {
    *answer == MessageDialogResult::Custom(RESTART.to_owned())
}

fn ask_to_restart<R: Runtime>(app: &AppHandle<R>, version: &str) {
    {
        let mut state = updates(app).lock();
        if state.asking || state.installing {
            return;
        }
        state.asking = true;
    }
    let handle = app.clone();
    let shown = show(
        app,
        &format!("TipTop Copilot {version} is ready"),
        "Restart now to update. It takes about 10 to 20 seconds. Save anything you’re typing \
         first.",
        restart_buttons(),
        move |answer| {
            let restart = chose_restart(&answer);
            let ready = {
                let mut state = updates(&handle).lock();
                state.asking = false;
                let ready = if restart { state.ready.take() } else { None };
                state.installing = ready.is_some();
                ready
            };
            match ready {
                Some(ready) => install(&handle, ready),
                // A check found the release withdrawn while the question was open.
                None if restart => tell(
                    &handle,
                    "That update is no longer available",
                    "Nothing was changed. The app will look for a newer one later.",
                ),
                None => {}
            }
        },
    );
    if !shown {
        updates(app).lock().asking = false;
    }
}

/// On the dialog's own thread, never the main one: on a Mac the restart must
/// come from another thread so the exit events run first. They release the
/// single-instance socket the new copy checks for, and save the window's place.
fn install<R: Runtime>(app: &AppHandle<R>, ready: Ready) {
    let Ready { update, bytes } = ready;
    // Windows: starts the installer (passive) and exits inside this call; the
    // installer opens the new version when it is done.
    // Mac: swaps the app in its folder for the new one and returns.
    match update.install(&bytes) {
        Ok(()) => {
            eprintln!("update {} installed; restarting", update.version);
            app.restart();
        }
        Err(e) => {
            eprintln!("update {} could not be installed: {e}", update.version);
            #[cfg(windows)]
            {
                // The installer never started, but the tray icon was taken down.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if handle.tray_by_id("main").is_none() && crate::build_tray(&handle).is_err() {
                        eprintln!("could not add the tray icon");
                    }
                });
            }
            updates(app).lock().installing = false;
            tell(
                app,
                "Couldn’t install the update",
                "Nothing was changed. Try again later, or download the newest version from \
                 copilot.tiptop.vc/download.",
            );
        }
    }
}

fn tell<R: Runtime>(app: &AppHandle<R>, headline: &str, detail: &str) {
    show(app, headline, detail, MessageButtons::Ok, |_| {});
}

/// A Mac alert shows a bold headline over the detail. A Windows task dialog
/// puts its title in the title bar, so there the headline leads the text.
fn wording(windows: bool, headline: &str, detail: &str) -> (String, String) {
    if windows {
        ("TipTop Copilot".to_owned(), format!("{headline}.\n\n{detail}"))
    } else {
        (headline.to_owned(), detail.to_owned())
    }
}

/// A native message box, built on the main thread (AppKit and the task dialog
/// need it there); `then` gets the answer on a thread of its own, so it may
/// block. The same pattern as tauri-plugin-dialog 2.8.3 (desktop.rs). False
/// when it could not be shown, and `then` never runs.
fn show<R, F>(
    app: &AppHandle<R>,
    headline: &str,
    detail: &str,
    buttons: MessageButtons,
    then: F,
) -> bool
where
    R: Runtime,
    F: FnOnce(MessageDialogResult) + Send + 'static,
{
    let (title, description) = wording(cfg!(windows), headline, detail);
    let handle = app.clone();
    let shown = app.run_on_main_thread(move || {
        let mut dialog = AsyncMessageDialog::new()
            .set_level(MessageLevel::Info)
            .set_title(title)
            .set_description(description)
            .set_buttons(buttons);
        // On the window in front, the one the menus act on. With none on
        // screen, or it minimised, a sheet there would never be seen, so the
        // box stands on its own.
        if let Some(window) = crate::menu::front_window(&handle)
            .filter(|window| !window.is_minimized().unwrap_or(false))
        {
            dialog = dialog.set_parent(&window);
        }
        let answer = dialog.show();
        std::thread::spawn(move || then(tauri::async_runtime::block_on(answer)));
    });
    if shown.is_err() {
        eprintln!("could not show a dialog");
    }
    shown.is_ok()
}

/// The one system call the wrong-place check needs, made directly rather than
/// through another crate.
#[cfg(target_os = "macos")]
mod mac {
    use std::{
        ffi::{CString, c_char, c_int},
        os::unix::ffi::OsStrExt,
        path::Path,
    };

    /// <unistd.h> and <sys/errno.h>.
    const W_OK: c_int = 2;
    const EROFS: i32 = 30;

    unsafe extern "C" {
        fn access(path: *const c_char, mode: c_int) -> c_int;
    }

    /// Whether `path` is on a volume mounted read-only: a disk image, or the
    /// private copy App Translocation runs. Lack of permission, as in
    /// Applications for a standard user, is not: the updater asks for an
    /// administrator's password there.
    pub fn on_read_only_volume(path: &Path) -> bool {
        let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `path` is a NUL-terminated string that outlives the call,
        // and access() only reads it.
        let refused = unsafe { access(path.as_ptr(), W_OK) } != 0;
        refused && std::io::Error::last_os_error().raw_os_error() == Some(EROFS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_800_000_000 + seconds)
    }

    #[test]
    fn the_first_check_is_due_at_once() {
        assert!(due(None, SystemTime::now()));
    }

    #[test]
    fn checks_that_work_are_six_hours_apart() {
        let last = Some(Checked {
            at: at(0),
            failed: false,
        });
        assert!(!due(last, at(6 * 3600 - 1)));
        assert!(due(last, at(6 * 3600)));
    }

    #[test]
    fn a_failed_check_is_tried_again_after_half_an_hour() {
        let last = Some(Checked {
            at: at(0),
            failed: true,
        });
        assert!(!due(last, at(30 * 60 - 1)));
        assert!(due(last, at(30 * 60)));
    }

    #[test]
    fn a_clock_that_went_backwards_counts_as_due() {
        let last = Some(Checked {
            at: at(60),
            failed: false,
        });
        assert!(due(last, at(0)));
    }

    #[test]
    fn a_manual_check_joins_the_running_one_and_hears_how_it_went() {
        let mut state = State::default();
        assert_eq!(state.begin(Trigger::Automatic), Begin::Run);
        assert!(!state.checking());
        assert_eq!(state.begin(Trigger::Manual), Begin::Joined);
        assert!(state.checking());
        assert!(state.end(false, at(0)));
        assert!(!state.checking());
    }

    #[test]
    fn automatic_checks_run_one_at_a_time_and_stay_silent() {
        let mut state = State::default();
        assert_eq!(state.begin(Trigger::Automatic), Begin::Run);
        assert_eq!(state.begin(Trigger::Automatic), Begin::Joined);
        assert!(!state.end(false, at(0)));
        assert_eq!(state.begin(Trigger::Automatic), Begin::Run);
    }

    #[test]
    fn a_manual_check_on_its_own_reports() {
        let mut state = State::default();
        assert_eq!(state.begin(Trigger::Manual), Begin::Run);
        assert!(state.checking());
        assert!(state.end(false, at(0)));
    }

    #[test]
    fn a_joined_check_is_not_one_that_worked() {
        let mut state = State {
            last: Some(Checked {
                at: at(0),
                failed: false,
            }),
            ..State::default()
        };
        let due_at = at(6 * 3600);
        assert_eq!(state.begin(Trigger::Manual), Begin::Run);
        // The timer comes due while the manual check runs, and joins it.
        assert_eq!(state.begin(Trigger::Automatic), Begin::Joined);
        assert!(due(state.last, due_at));
        // The manual check fails: the timer tries again in half an hour,
        // not six hours.
        state.end(true, due_at);
        assert!(!due(state.last, at(6 * 3600 + 30 * 60 - 1)));
        assert!(due(state.last, at(6 * 3600 + 30 * 60)));
    }

    #[test]
    fn a_manual_check_that_worked_resets_the_timer() {
        let mut state = State::default();
        assert_eq!(state.begin(Trigger::Manual), Begin::Run);
        state.end(false, at(0));
        assert!(!due(state.last, at(6 * 3600 - 1)));
        assert!(due(state.last, at(6 * 3600)));
    }

    #[test]
    fn nothing_starts_once_restart_was_chosen() {
        let mut state = State {
            installing: true,
            ..State::default()
        };
        assert_eq!(state.begin(Trigger::Manual), Begin::Refused);
        assert_eq!(state.begin(Trigger::Automatic), Begin::Refused);
        assert!(!state.running);
    }

    #[test]
    fn the_wrong_place_notice_comes_once_per_launch_unless_asked() {
        let mut state = State::default();
        assert!(state.tell_place(false));
        assert!(!state.tell_place(false));
        assert!(state.tell_place(true));
        assert!(!state.tell_place(false));
    }

    #[test]
    fn the_menu_item_says_when_it_is_checking() {
        assert_eq!(menu_label(false, true), ("Check for &Updates…", true));
        assert_eq!(menu_label(false, false), ("Check for Updates…", true));
        assert_eq!(menu_label(true, true), ("Checking for Updates…", false));
        assert_eq!(menu_label(true, false), ("Checking for Updates…", false));
    }

    #[test]
    fn later_is_the_default_button() {
        assert!(matches!(
            restart_buttons(),
            MessageButtons::OkCancelCustom(first, second) if first == LATER && second == RESTART
        ));
    }

    #[test]
    fn only_restart_now_restarts() {
        assert!(chose_restart(&MessageDialogResult::Custom(RESTART.to_owned())));
        assert!(!chose_restart(&MessageDialogResult::Custom(LATER.to_owned())));
        assert!(!chose_restart(&MessageDialogResult::Cancel));
        assert!(!chose_restart(&MessageDialogResult::Ok));
    }

    #[test]
    fn a_windows_dialog_leads_with_the_headline() {
        let (title, text) = wording(true, "You’re up to date", "Nothing new.");
        assert_eq!(title, "TipTop Copilot");
        assert_eq!(text, "You’re up to date.\n\nNothing new.");
        let (title, text) = wording(false, "You’re up to date", "Nothing new.");
        assert_eq!(title, "You’re up to date");
        assert_eq!(text, "Nothing new.");
    }

    #[test]
    fn only_a_read_only_copy_cannot_update_itself() {
        let bin = "TipTop Copilot.app/Contents/MacOS/tiptop-copilot-desktop";
        assert!(!read_only_place(&format!("/Applications/{bin}"), false));
        // An external disk is fine as long as it can be written to.
        assert!(!read_only_place(&format!("/Volumes/Work/Apps/{bin}"), false));
        assert!(read_only_place(&format!("/Volumes/TipTop Copilot/{bin}"), true));
        assert!(read_only_place(
            &format!("/private/var/folders/ab/cd/T/AppTranslocation/0A1B2C/d/{bin}"),
            false
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_writable_or_missing_place_is_not_read_only() {
        assert!(!mac::on_read_only_volume(&std::env::temp_dir()));
        assert!(!mac::on_read_only_volume(std::path::Path::new("/no/such/place")));
    }
}
