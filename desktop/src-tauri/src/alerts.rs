//! Desktop alerts (from 0.4.0): the alerts phones get, and from 0.4.1 Ask
//! Arwin's answers to whoever asked, as Windows toasts and macOS
//! notifications, while the app runs, also with its window hidden in the
//! tray (Windows), closed (a Mac keeps running) or minimised.
//!
//! The shell asks Copilot for them itself, with a token for this computer
//! alone: about once a minute from 6am to 9pm in the owner's time zone, as
//! Copilot's answers say, and every 30 seconds while a question to Ask
//! Arwin from whoever turned alerts on here waits for its answer (from
//! 0.4.1; nobody else's question). The page could not: WebKit suspends a
//! hidden window's page on a Mac, WebView2 slows a hidden page's timers to
//! once a minute, and the window may show the bundled page or sign-in. The
//! token comes once, from Copilot through the signed-in page, which hands it
//! straight to `alerts_turn_on`. It is kept in this computer's app data and
//! never given back to a page, and it can only read alert summaries (with
//! the start of its owner's own new Ask answers) and say which were shown
//! here.
//!
//! From 0.4.1 an alert may ask to stay quiet while the person is looking at
//! Copilot (`quietWhenFocused`: Ask Arwin's answers, which the page announces
//! itself). With the main window shown, not minimised, in front and on the
//! live site, it counts as shown without a notification, so it never shows
//! later either, and the page is told which page it opens
//! (`tiptop-desktop-replied`), so it can show its own pop-up for an answer
//! it was not watching. The page may also ask for the next poll within half
//! a minute (`alerts_poll_soon`), straight after a question, so its answer
//! can ping at night too.
//!
//! The page gets six commands (capabilities/desktop-alerts.json): the main
//! window, on the live site only. None shows text a page chooses: what a
//! notification says comes only from Copilot, over the token's own requests.
//! Any token for this computer's id is taken, though, so a script on the live
//! page could hand over one from an organization of its own, whose alerts
//! the shell would then show until Turn off (D-057's threat model).
//! A click brings the main window forward and opens the alert's page through
//! the web app, as a link would; the path is checked here and again there.
//!
//! No plugin: tauri-plugin-notification would replace `window.Notification`
//! in every page. Windows toasts go through tauri-winrt-notification and a
//! Mac's notifications through mac-usernotifications (UNUserNotificationCenter),
//! both from Rust only.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Mutex, MutexGuard, OnceLock, PoisonError,
        mpsc::{RecvTimeoutError, Sender},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewWindow};

use crate::nav::{self, Route};

/// In the app's local data: this computer's id, the token and the alerts
/// already shown.
const FILE: &str = "desktop-alerts.json";
const FILE_VERSION: u32 = 1;
/// A bigger file is not one this app wrote.
const FILE_MAX: u64 = 256 * 1024;

/// How often the poller looks at the clock. Wall-clock time, so a laptop
/// that slept catches up within this long of waking.
const TICK: Duration = Duration::from_secs(15);
/// The first poll after launch, when alerts are on.
const FIRST_POLL: Duration = Duration::from_secs(10);
/// Copilot says when to ask next (once a minute in the day, at 6am at
/// night); this when it says nothing, and never sooner or later than these.
const POLL_EVERY: Duration = Duration::from_secs(60);
const POLL_SOONEST: Duration = Duration::from_secs(30);
const POLL_LATEST: Duration = Duration::from_secs(10 * 60 * 60);
/// While the system does not allow notifications, nothing is fetched.
const NOT_ALLOWED_WAIT: Duration = Duration::from_secs(5 * 60);
/// Copilot asked the app to slow down (429, or 503 with Retry-After).
const WAIT_DEFAULT: Duration = Duration::from_secs(5 * 60);
const WAIT_SOONEST: Duration = Duration::from_secs(30);
const WAIT_LATEST: Duration = Duration::from_secs(60 * 60);
/// A cold start of the web service can take most of a minute.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// A bigger answer is refused unread.
const BODY_MAX: usize = 64 * 1024;

/// At most this many alerts from one answer, meetings first; the rest come
/// with the next one.
const SHOWN_MAX: usize = 8;
/// What Copilot's acknowledgement route takes.
const KEYS_MAX: usize = 50;
const KEY_MAX: usize = 200;
const ACK_MAX: usize = 200;
const TITLE_MAX: usize = 120;
const TEXT_MAX: usize = 240;
const PATH_MAX: usize = 300;
/// Where an alert whose page does not pass the checks opens.
const FALLBACK_PATH: &str = "/today";
/// An alert the system refused this many times counts as shown, so a
/// notification that can never show does not come back every minute.
const TRIES_MAX: u32 = 3;
/// How long, and how many, shown alerts are remembered here. Copilot keeps
/// its own record per computer; this one covers a lost acknowledgement.
const SEEN_FOR: Duration = Duration::from_secs(3 * 24 * 60 * 60);
const SEEN_MAX: usize = 300;
/// Send a test is refused more often than this.
const TEST_EVERY: Duration = Duration::from_secs(3);
/// How long a poll waits for the main thread to say whether the person is
/// looking at Copilot; past it, the alert shows.
const FOCUS_WAIT: Duration = Duration::from_secs(2);

/// What the page is told this computer is.
const PLATFORM: &str = if cfg!(target_os = "macos") { "mac" } else { "windows" };
const USER_AGENT: &str = concat!("TipTopCopilot/", env!("CARGO_PKG_VERSION"), " desktop-alerts");
/// Copilot's own 401 for a token it no longer knows names this realm. Any
/// other 401 (a proxy, a deploy that lost the route) is a passing failure:
/// forgetting the token on one would turn alerts off on every computer.
const REALM: &str = "realm=\"tiptop-copilot\"";
const TOKEN_PREFIX: &str = "tcdsk_";
/// What a refused command answers; the page only sees null.
const REFUSED: &str = "refused";

/// Whether the system lets this app show notifications, as the page is told.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Permission {
    Granted,
    Denied,
    /// A Mac that was not asked yet, or whose question is still on screen.
    Prompt,
    /// This copy cannot show notifications: on a Mac, a development build
    /// outside an app bundle, or a system that refused to ask.
    Unavailable,
}

/// What every command answers. Never the token.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Status {
    on: bool,
    permission: Permission,
    device: String,
    platform: &'static str,
}

/// An alert key shown on this computer, and when (Unix seconds).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Seen {
    k: String,
    at: u64,
}

/// desktop-alerts.json.
#[derive(Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Saved {
    v: u32,
    device: Option<String>,
    token: Option<String>,
    #[serde(default)]
    seen: Vec<Seen>,
}

#[derive(Default)]
struct State {
    /// This computer's id: made when Settings first asks, saved once alerts
    /// are turned on, and kept after they are turned off, so turning them
    /// back on never repeats what was shown here.
    device: Option<String>,
    /// None while alerts are off.
    token: Option<String>,
    seen: Vec<Seen>,
    /// Goes up when alerts are turned on or off, so a poll that started
    /// before drops what it found.
    generation: u64,
    next_due: Option<SystemTime>,
    /// Failed polls in a row.
    failures: u32,
    /// The next poll waits as Copilot asked (Retry-After) or while the
    /// system does not allow notifications; `alerts_poll_soon` leaves it.
    held: bool,
    /// The page asked for a poll soon since the last poll started.
    soon: bool,
    /// Times the system refused an alert, by its first key.
    tries: HashMap<String, u32>,
    last_test: Option<Instant>,
}

impl State {
    /// The page asked for a poll soon (`alerts_poll_soon`): the next comes
    /// within `POLL_SOONEST`, never later than one already due. Nothing
    /// changes while alerts are off, failed polls back off or Copilot asked
    /// the app to wait.
    fn poll_soon(&mut self, now: SystemTime) {
        if self.token.is_some() && self.failures == 0 && !self.held {
            self.next_due = due_soon(self.next_due, now);
            self.soon = true;
        }
    }

    /// Copilot answered a poll: the next comes when it said, or within
    /// `POLL_SOONEST` when the page asked for one while this poll was under
    /// way, since the answer may predate that question.
    fn answered(&mut self, poll_after: Duration, now: SystemTime) {
        self.next_due = Some(now + poll_after);
        if std::mem::take(&mut self.soon) {
            self.next_due = due_soon(self.next_due, now);
        }
        self.failures = 0;
        self.held = false;
    }

    /// Counts a failed attempt to show the alert keyed `key`; true once it
    /// has failed `TRIES_MAX` times.
    fn give_up(&mut self, key: &str) -> bool {
        if self.tries.len() >= 64 && !self.tries.contains_key(key) {
            self.tries.clear();
        }
        let tries = self.tries.entry(key.to_owned()).or_insert(0);
        *tries += 1;
        *tries >= TRIES_MAX
    }
}

struct Alerts {
    state: Mutex<State>,
    /// Held while the file is written, taken before `state`, so writes never
    /// interleave and the last one always holds the latest state.
    file: Mutex<()>,
    path: Option<PathBuf>,
    /// Wakes the poller when alerts are turned on.
    wake: Sender<()>,
    client: OnceLock<reqwest::Client>,
    /// The AppUserModelID toasts are shown under.
    #[cfg(windows)]
    app_id: String,
}

impl Alerts {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Writes the settings as they are now, never values a caller read
    /// earlier.
    fn persist(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let _writing = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(text) = saved_text(&self.lock()) else {
            return;
        };
        if write_file(path, &text).is_err() {
            eprintln!("could not save the desktop alerts settings");
        }
    }

    /// The token and the generation it belongs to, while alerts are on.
    fn on(&self) -> Option<(String, u64)> {
        let state = self.lock();
        state.token.clone().map(|token| (token, state.generation))
    }

    fn due(&self, now: SystemTime) -> bool {
        let state = self.lock();
        state.token.is_some() && is_due(state.next_due, now)
    }

    /// The next poll comes after `wait`, unless alerts were turned on or off
    /// meanwhile; the page cannot ask for it sooner.
    fn wait(&self, generation: u64, wait: Duration) {
        let mut state = self.lock();
        if state.generation == generation {
            state.next_due = Some(SystemTime::now() + wait);
            state.held = true;
        }
    }

    fn failed(&self, generation: u64) {
        let mut state = self.lock();
        if state.generation != generation {
            return;
        }
        state.failures = state.failures.saturating_add(1);
        state.next_due = Some(SystemTime::now() + backoff(state.failures));
        if state.failures == 1 {
            eprintln!("could not reach Copilot for desktop alerts; trying again later");
        }
    }

    /// Copilot no longer knows the token (turned off elsewhere, signed out,
    /// or removed from the organization): alerts are off here. The device id
    /// stays.
    fn revoked(&self, generation: u64) {
        let cleared = {
            let mut state = self.lock();
            let current = state.generation == generation && state.token.is_some();
            if current {
                state.token = None;
                state.next_due = None;
            }
            current
        };
        if cleared {
            eprintln!("desktop alerts were turned off for this computer from Copilot");
            self.persist();
        }
    }

    /// One HTTP client for every request, made on first use.
    fn client(&self) -> Option<reqwest::Client> {
        if let Some(client) = self.client.get() {
            return Some(client.clone());
        }
        // As tauri-plugin-updater 2.14.0 does (updater.rs): reqwest is built
        // here without a TLS crypto provider of its own.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let built = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build();
        match built {
            Ok(client) => Some(self.client.get_or_init(|| client).clone()),
            Err(_) => {
                eprintln!("could not set up the connection for desktop alerts");
                None
            }
        }
    }

    /// What the commands answer; makes this computer's id if there is none.
    fn status(&self, permission: Permission) -> Result<Status, String> {
        let mut state = self.lock();
        if state.device.is_none() {
            state.device = Some(new_device().ok_or_else(|| REFUSED.to_owned())?);
        }
        Ok(Status {
            on: state.token.is_some(),
            permission,
            device: state.device.clone().unwrap_or_default(),
            platform: PLATFORM,
        })
    }
}

fn alerts<R: Runtime>(app: &AppHandle<R>) -> &Alerts {
    app.state::<Alerts>().inner()
}

/// Loads the saved settings and starts the poller. Call it in setup().
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    let path = app.path().app_local_data_dir().ok().map(|dir| dir.join(FILE));
    let saved = path.as_deref().and_then(read_saved).unwrap_or_default();
    let on = saved.token.is_some();
    let state = State {
        device: saved.device,
        token: saved.token,
        seen: saved.seen,
        next_due: on.then(|| SystemTime::now() + FIRST_POLL),
        ..State::default()
    };
    let (wake, woken) = std::sync::mpsc::channel();
    app.manage(Alerts {
        state: Mutex::new(state),
        file: Mutex::new(()),
        path,
        wake,
        client: OnceLock::new(),
        #[cfg(windows)]
        app_id: toast::app_id(&app.config().identifier),
    });
    let app = app.clone();
    // One poll at a time, in order, on a thread of its own.
    let poller = std::thread::Builder::new()
        .name("alerts-poller".into())
        .spawn(move || {
            loop {
                if let Err(RecvTimeoutError::Disconnected) = woken.recv_timeout(TICK) {
                    std::thread::sleep(TICK);
                }
                if alerts(&app).due(SystemTime::now()) {
                    tauri::async_runtime::block_on(poll_once(&app));
                }
            }
        });
    if poller.is_err() {
        eprintln!("could not start desktop alerts");
    }
}

/// The calling window's app, if it is the main window. capabilities/ already
/// refuses every other window and page; this is a second lock.
fn from_main<R: Runtime>(window: &WebviewWindow<R>) -> Result<AppHandle<R>, String> {
    if window.label() == crate::MAIN {
        Ok(window.app_handle().clone())
    } else {
        Err(REFUSED.to_owned())
    }
}

/// Whether desktop alerts are on for this computer and allowed by the
/// system, and this computer's id (made now if there is none, and saved only
/// once alerts are turned on). Asks the person nothing.
#[tauri::command]
pub async fn alerts_state<R: Runtime>(window: WebviewWindow<R>) -> Result<Status, String> {
    let app = from_main(&window)?;
    let shared = alerts(&app);
    shared.status(read_permission(shared).await)
}

/// Asks the system for permission where nobody has been asked: a Mac's
/// first time, which shows macOS's Allow question. Prompt when that question
/// has not been answered within a minute. Windows asks nobody, so there it
/// only reads the setting.
#[tauri::command]
pub async fn alerts_request_permission<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Status, String> {
    let app = from_main(&window)?;
    let shared = alerts(&app);
    shared.status(ask_permission(shared).await)
}

/// Turns alerts on with the token Copilot just issued for this computer.
/// Refused unless it is a desktop alerts token for this computer's id. Keeps
/// nothing, and answers off, unless the system allows notifications.
#[tauri::command]
pub async fn alerts_turn_on<R: Runtime>(
    window: WebviewWindow<R>,
    token: String,
) -> Result<Status, String> {
    let app = from_main(&window)?;
    let shared = alerts(&app);
    let device = shared.lock().device.clone().ok_or_else(|| REFUSED.to_owned())?;
    if !token_fits(&token, &device) {
        return Err(REFUSED.to_owned());
    }
    let permission = read_permission(shared).await;
    if permission != Permission::Granted {
        return shared.status(permission);
    }
    {
        let mut state = shared.lock();
        state.token = Some(token);
        state.generation += 1;
        state.next_due = Some(SystemTime::now());
        state.failures = 0;
        state.held = false;
        state.tries.clear();
    }
    shared.persist();
    let _ = shared.wake.send(());
    shared.status(permission)
}

/// Turns alerts off for this computer: forgets the token (keeping the id)
/// and tells Copilot, best effort; the page tells it too.
#[tauri::command]
pub async fn alerts_turn_off<R: Runtime>(window: WebviewWindow<R>) -> Result<Status, String> {
    let app = from_main(&window)?;
    let shared = alerts(&app);
    let old = {
        let mut state = shared.lock();
        let old = state.token.take();
        if old.is_some() {
            state.generation += 1;
            state.next_due = None;
            state.failures = 0;
            state.held = false;
            state.tries.clear();
        }
        old
    };
    // A computer that never had alerts on writes and sends nothing.
    if let Some(token) = old {
        shared.persist();
        let owner = app.clone();
        tauri::async_runtime::spawn(async move { revoke(&owner, &token).await });
    }
    shared.status(read_permission(shared).await)
}

/// Shows the one test notification, with fixed text ("Alerts work on this
/// computer.") that opens Settings. Only while alerts are on and allowed,
/// and at most once every 3 seconds. Refused when the system would not show
/// it, so Settings says the test failed instead of nothing happening.
#[tauri::command]
pub async fn alerts_test<R: Runtime>(window: WebviewWindow<R>) -> Result<Status, String> {
    let app = from_main(&window)?;
    let shared = alerts(&app);
    let permission = read_permission(shared).await;
    let ready = permission == Permission::Granted && {
        let mut state = shared.lock();
        let ready = state.token.is_some()
            && state.last_test.is_none_or(|at| at.elapsed() >= TEST_EVERY);
        if ready {
            state.last_test = Some(Instant::now());
        }
        ready
    };
    if ready {
        let test = Alert {
            keys: Vec::new(),
            title: "TipTop Copilot".to_owned(),
            body: "Alerts work on this computer.".to_owned(),
            path: "/settings".to_owned(),
            urgent: false,
            // Shows with Settings in front: that is where it is sent from.
            quiet_when_focused: false,
        };
        if !show(&app, shared, &test).await {
            eprintln!("the test notification could not be shown");
            return Err(REFUSED.to_owned());
        }
    }
    shared.status(permission)
}

/// The next poll once the page asks for one soon: within `POLL_SOONEST`,
/// never later than one already due (none set means due now).
fn due_soon(next_due: Option<SystemTime>, now: SystemTime) -> Option<SystemTime> {
    next_due.map(|at| at.min(now + POLL_SOONEST))
}

/// Looks for this computer's alerts within half a minute: the page calls it
/// when a question to Ask Arwin starts waiting, so the answer can ping at
/// night too, when Copilot otherwise has the app wait until 6am. Never
/// sooner than that however often it is called, never later than a poll
/// already due, and nothing while alerts are off, failed polls back off or
/// Copilot asked the app to wait. Shows nothing itself: what comes is up to
/// Copilot.
#[tauri::command]
pub async fn alerts_poll_soon<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    let app = from_main(&window)?;
    alerts(&app).lock().poll_soon(SystemTime::now());
    Ok(())
}

async fn revoke<R: Runtime>(app: &AppHandle<R>, token: &str) {
    let Some(client) = alerts(app).client() else {
        return;
    };
    if client.delete(alerts_url()).bearer_auth(token).send().await.is_err() {
        eprintln!("could not tell Copilot that desktop alerts are off here");
    }
}

fn alerts_url() -> String {
    format!("https://{}/api/desktop/alerts", nav::LIVE_HOST)
}

/// One poll: fetch the alerts due for this computer, show the new ones and
/// say which this computer has. Never two at once (the poller's thread).
async fn poll_once<R: Runtime>(app: &AppHandle<R>) {
    let shared = alerts(app);
    let Some((token, generation)) = shared.on() else {
        return;
    };
    #[cfg(target_os = "macos")]
    mac::hold_off_app_nap(app);
    // Nothing is fetched, or counted as shown, while notifications are off.
    if read_permission(shared).await != Permission::Granted {
        shared.wait(generation, NOT_ALLOWED_WAIT);
        return;
    }
    let Some(client) = shared.client() else {
        shared.failed(generation);
        return;
    };
    // This poll's answer covers what the page asked about so far; an ask
    // from now on may come too late for it (`State::answered`).
    shared.lock().soon = false;
    match fetch(&client, &token).await {
        Fetched::Alerts(batch) => deliver(app, shared, &client, &token, generation, batch).await,
        Fetched::Revoked => shared.revoked(generation),
        Fetched::Wait(wait) => shared.wait(generation, wait),
        Fetched::Failed => shared.failed(generation),
    }
}

/// Shows what is new in `batch`, saves, then tells Copilot which alerts this
/// computer has: those shown now, and any shown before in case that earlier
/// acknowledgement was lost. An alert the system refused is neither, so the
/// next poll offers it again, until it has failed `TRIES_MAX` times.
///
/// Alerts turned off or on again meanwhile (a new generation) stop the batch
/// and the acknowledgement, but an alert already on screen is remembered and
/// saved all the same: what was shown belongs to this computer's id, which
/// outlives the token, so the next token's first poll never shows it twice.
async fn deliver<R: Runtime>(
    app: &AppHandle<R>,
    shared: &Alerts,
    client: &reqwest::Client,
    token: &str,
    generation: u64,
    batch: Batch,
) {
    let mut delivered: Vec<String> = Vec::new();
    // Whether the remembered alerts changed, so the file is written only then.
    let mut changed = false;
    let mut stale = false;
    for alert in &batch.alerts {
        let fresh = {
            let state = shared.lock();
            if state.generation != generation {
                stale = true;
                break;
            }
            is_new(&state.seen, &alert.keys)
        };
        if fresh {
            // What the page announces itself (an Ask Arwin answer) counts as
            // shown while the person is looking at Copilot: remembered and
            // reported like any other, so it never shows later.
            let shown = (alert.quiet_when_focused && quiet_here(app, &alert.path))
                || show(app, shared, alert).await;
            let mut state = shared.lock();
            if shown {
                state.tries.remove(&alert.keys[0]);
                remember(&mut state.seen, &alert.keys, unix_now());
                changed = true;
            }
            if state.generation != generation {
                stale = true;
                break;
            }
            if !shown {
                if !state.give_up(&alert.keys[0]) {
                    continue;
                }
                eprintln!("an alert could not be shown and will not be tried again");
                state.tries.remove(&alert.keys[0]);
                remember(&mut state.seen, &alert.keys, unix_now());
                changed = true;
            }
        }
        for key in &alert.keys {
            if !delivered.contains(key) {
                delivered.push(key.clone());
            }
        }
    }
    if stale {
        if changed {
            shared.persist();
        }
        return;
    }
    {
        let mut state = shared.lock();
        if state.generation != generation {
            drop(state);
            if changed {
                shared.persist();
            }
            return;
        }
        let before = state.seen.len();
        prune(&mut state.seen, unix_now());
        changed |= state.seen.len() != before;
        state.answered(batch.poll_after, SystemTime::now());
    }
    if changed {
        shared.persist();
    }
    delivered.truncate(ACK_MAX);
    if delivered.is_empty() {
        return;
    }
    let acknowledged = client
        .post(alerts_url())
        .bearer_auth(token)
        .json(&serde_json::json!({ "delivered": delivered }))
        .send()
        .await;
    match acknowledged {
        Ok(response) if answer_of(&response) == Answer::Revoked => shared.revoked(generation),
        Ok(_) => {}
        // Shown alerts stay remembered here, and the next poll says so again.
        Err(_) => eprintln!("could not tell Copilot which alerts were shown"),
    }
}

/// What one poll found.
enum Fetched {
    Alerts(Batch),
    Revoked,
    Wait(Duration),
    Failed,
}

async fn fetch(client: &reqwest::Client, token: &str) -> Fetched {
    let Ok(response) = client.get(alerts_url()).bearer_auth(token).send().await else {
        return Fetched::Failed;
    };
    match answer_of(&response) {
        Answer::Ok => match read_body(response).await.and_then(|body| parse_batch(&body)) {
            Some(batch) => Fetched::Alerts(batch),
            None => Fetched::Failed,
        },
        Answer::Revoked => Fetched::Revoked,
        Answer::Wait(wait) => Fetched::Wait(wait),
        Answer::Failed => Fetched::Failed,
    }
}

fn answer_of(response: &reqwest::Response) -> Answer {
    classify(
        response.status().as_u16(),
        header(response, reqwest::header::WWW_AUTHENTICATE),
        header(response, reqwest::header::RETRY_AFTER),
    )
}

fn header(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<&str> {
    response.headers().get(name).and_then(|value| value.to_str().ok())
}

/// The body, unless it is bigger than `BODY_MAX`, counted as it arrives (an
/// answer sent in chunks says no length up front).
async fn read_body(mut response: reqwest::Response) -> Option<Vec<u8>> {
    if response.content_length().is_some_and(|length| length > BODY_MAX as u64) {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > BODY_MAX {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    Some(body)
}

/// What an answer from Copilot means.
#[derive(Debug, PartialEq, Eq)]
enum Answer {
    Ok,
    /// Copilot itself no longer knows the token.
    Revoked,
    Wait(Duration),
    Failed,
}

fn classify(status: u16, www_authenticate: Option<&str>, retry_after: Option<&str>) -> Answer {
    match status {
        200..=299 => Answer::Ok,
        401 if www_authenticate.is_some_and(|value| value.contains(REALM)) => Answer::Revoked,
        429 => Answer::Wait(retry_wait(retry_after)),
        503 if retry_after.is_some() => Answer::Wait(retry_wait(retry_after)),
        _ => Answer::Failed,
    }
}

/// Retry-After in seconds, kept between 30 seconds and an hour; 5 minutes
/// when it is missing or a date.
fn retry_wait(retry_after: Option<&str>) -> Duration {
    retry_after
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map_or(WAIT_DEFAULT, |seconds| {
            Duration::from_secs(seconds).clamp(WAIT_SOONEST, WAIT_LATEST)
        })
}

/// Copilot's hint for the next poll, in seconds, kept between 30 seconds and
/// 10 hours; a minute without one.
fn poll_after(hint: Option<f64>) -> Duration {
    let seconds = hint
        .filter(|seconds| seconds.is_finite())
        .unwrap_or(POLL_EVERY.as_secs_f64());
    Duration::from_secs_f64(seconds.clamp(POLL_SOONEST.as_secs_f64(), POLL_LATEST.as_secs_f64()))
}

/// After the `failures`th failed poll in a row: a minute, two, then five,
/// and a quarter of an hour once Copilot has failed for about 20 minutes, so
/// a broken deploy is not woken every few minutes all night.
fn backoff(failures: u32) -> Duration {
    Duration::from_secs(match failures {
        0 | 1 => 60,
        2 => 120,
        3..=5 => 300,
        _ => 900,
    })
}

/// Whether a poll is due: at once with no time set, and at once when the
/// time set lies further ahead than any wait could (the clock went back).
fn is_due(next_due: Option<SystemTime>, now: SystemTime) -> bool {
    next_due.is_none_or(|at| match at.duration_since(now) {
        Err(_) => true,
        Ok(ahead) => ahead.is_zero() || ahead > POLL_LATEST + TICK,
    })
}

/// An alert from Copilot, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Alert {
    keys: Vec<String>,
    title: String,
    body: String,
    /// An in-app path that passed `alert_target`.
    path: String,
    /// A meeting: shown first and for longer.
    urgent: bool,
    /// Shown only while the person is not looking at Copilot (an Ask Arwin
    /// answer, which the page announces itself); otherwise counted as shown.
    quiet_when_focused: bool,
}

/// One answer's alerts, and when to ask again.
#[derive(Debug, PartialEq)]
struct Batch {
    alerts: Vec<Alert>,
    poll_after: Duration,
}

#[derive(Deserialize)]
struct RawBatch {
    #[serde(default)]
    alerts: Option<Vec<serde_json::Value>>,
    #[serde(default, rename = "pollAfterSeconds")]
    poll_after_seconds: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct RawAlert {
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    urgent: bool,
    #[serde(default, rename = "quietWhenFocused")]
    quiet_when_focused: bool,
}

/// Copilot's answer: other fields are ignored, an alert that does not fit is
/// skipped (the rest still show), and at most `SHOWN_MAX`, meetings first.
fn parse_batch(body: &[u8]) -> Option<Batch> {
    let raw: RawBatch = serde_json::from_slice(body).ok()?;
    let mut alerts: Vec<Alert> = raw
        .alerts
        .unwrap_or_default()
        .into_iter()
        .filter_map(|value| serde_json::from_value::<RawAlert>(value).ok())
        .filter_map(alert_from)
        .collect();
    // Stable, so the rest keep Copilot's order.
    alerts.sort_by_key(|alert| !alert.urgent);
    alerts.truncate(SHOWN_MAX);
    Some(Batch {
        alerts,
        poll_after: poll_after(raw.poll_after_seconds.and_then(|value| value.as_f64())),
    })
}

fn alert_from(raw: RawAlert) -> Option<Alert> {
    if raw.keys.is_empty() || raw.keys.len() > KEYS_MAX {
        return None;
    }
    let mut keys: Vec<String> = Vec::new();
    for key in raw.keys {
        if !key_fits(&key) {
            return None;
        }
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    let title = clip(&raw.title, TITLE_MAX);
    if title.is_empty() {
        return None;
    }
    let path = raw
        .url
        .as_deref()
        .and_then(alert_target)
        .map_or_else(|| FALLBACK_PATH.to_owned(), |(_, path)| path);
    Some(Alert {
        keys,
        title,
        body: clip(raw.body.as_deref().unwrap_or(""), TEXT_MAX),
        path,
        urgent: raw.urgent,
        quiet_when_focused: raw.quiet_when_focused,
    })
}

fn key_fits(key: &str) -> bool {
    !key.is_empty() && key.chars().count() <= KEY_MAX
}

/// Text for a notification: line breaks and tabs become spaces, other
/// control and direction-changing characters go, and text longer than `max`
/// characters is cut at a character, with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    let flat: String = text
        .chars()
        .filter_map(|c| match c {
            '\n' | '\r' | '\t' => Some(' '),
            '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' => None,
            c if c.is_control() => None,
            c => Some(c),
        })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        return flat.to_owned();
    }
    let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// Whether an alert with these keys has a key not yet shown here.
fn is_new(seen: &[Seen], keys: &[String]) -> bool {
    keys.iter().any(|key| !seen.iter().any(|shown| shown.k == *key))
}

fn remember(seen: &mut Vec<Seen>, keys: &[String], now: u64) {
    for key in keys {
        if !seen.iter().any(|shown| shown.k == *key) {
            seen.push(Seen { k: key.clone(), at: now });
        }
    }
}

/// Forgets keys older than `SEEN_FOR`, then all but the newest `SEEN_MAX`.
fn prune(seen: &mut Vec<Seen>, now: u64) {
    seen.retain(|shown| now.saturating_sub(shown.at) <= SEEN_FOR.as_secs());
    if seen.len() > SEEN_MAX {
        seen.sort_by_key(|shown| shown.at);
        let extra = seen.len() - SEEN_MAX;
        seen.drain(..extra);
    }
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |gone| gone.as_secs())
}

/// 32 lowercase hex characters: an organization's or a computer's id.
fn is_hex32(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// A new id for this computer: 16 random bytes.
fn new_device() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Whether `token` is a desktop alerts token for this computer:
/// `tcdsk_<organization>_<device>_<43 base64url>`, both ids 32 hex.
fn token_fits(token: &str, device: &str) -> bool {
    let Some(rest) = token.strip_prefix(TOKEN_PREFIX) else {
        return false;
    };
    if !rest.is_ascii() || rest.len() != 32 + 1 + 32 + 1 + 43 {
        return false;
    }
    let (organization, rest) = rest.split_at(32);
    let (first, rest) = rest.split_at(1);
    let (computer, rest) = rest.split_at(32);
    let (second, secret) = rest.split_at(1);
    is_hex32(organization)
        && first == "_"
        && is_hex32(computer)
        && computer == device
        && second == "_"
        && secret
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The same rule Copilot and the page apply: a path on the live site, up to
/// 300 characters of `A-Za-z0-9/_.~?=&%+,-`, starting with one slash, with
/// no `%` before any `?` (so no escape can spell a path the app blocks).
fn path_fits(path: &str) -> bool {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "/_.~?=&%+,-".contains(c);
    let before_query = path.split('?').next().unwrap_or_default();
    (1..=PATH_MAX).contains(&path.len())
        && path.starts_with('/')
        && !path.starts_with("//")
        && path.chars().all(allowed)
        && !before_query.contains('%')
}

/// Where an alert opens: the full URL, and the path the page is handed.
/// None for anything but a page that loads in the app (nav.rs) on the live
/// site.
fn alert_target(path: &str) -> Option<(Url, String)> {
    if !path_fits(path) {
        return None;
    }
    let url = Url::parse(&format!("https://{}/", nav::LIVE_HOST)).ok()?.join(path).ok()?;
    if nav::route(&url) != Route::InApp || !nav::is_live(&url) {
        return None;
    }
    let in_app = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    Some((url, in_app))
}

/// Asks the web app to open `path` as an in-app link click would, so the
/// page's own guards (a campaign that is sending) still ask first. The path
/// passed `alert_target`, and JSON keeps it a plain string.
fn open_script(path: &str) -> String {
    format!(
        "window.dispatchEvent(new CustomEvent('tiptop-desktop-open', {{ detail: {} }}));",
        serde_json::Value::String(path.to_owned())
    )
}

/// A click on an alert: the main window comes forward and opens the alert's
/// page. Through the web app when the window shows the live site, else by
/// loading the page. A path that does not pass only brings the window back.
fn open_alert<R: Runtime>(app: &AppHandle<R>, path: &str) {
    let target = alert_target(path);
    let handle = app.clone();
    let posted = app.run_on_main_thread(move || {
        crate::show_main(&handle);
        let (Some((url, path)), Some(main)) = (target, handle.get_webview_window(crate::MAIN))
        else {
            return;
        };
        let opened = if main.url().is_ok_and(|current| nav::is_live(&current)) {
            main.eval(open_script(&path))
        } else {
            main.navigate(url)
        };
        if opened.is_err() {
            eprintln!("could not open an alert's page");
        }
    });
    if posted.is_err() {
        eprintln!("could not open an alert's page");
    }
}

/// Tells the web app an alert it announces itself was held back while the
/// person looks at it, with the page that alert opens, so it can show its
/// own pop-up for an answer it was not watching (asked from a phone or
/// another window). The path passed `alert_target`, and JSON keeps it a
/// plain string.
fn replied_script(path: &str) -> String {
    format!(
        "window.dispatchEvent(new CustomEvent('tiptop-desktop-replied', {{ detail: {} }}));",
        serde_json::Value::String(path.to_owned())
    )
}

/// Whether an alert marked `quiet_when_focused` stays quiet: true while the
/// person is looking at Copilot (`main_in_front`), and the page is then told
/// (`replied_script`). Asked on the main thread, which owns the window;
/// false when it does not answer within `FOCUS_WAIT`, so the alert shows.
fn quiet_here<R: Runtime>(app: &AppHandle<R>, path: &str) -> bool {
    let (tell, told) = std::sync::mpsc::channel();
    let handle = app.clone();
    let script = replied_script(path);
    let posted = app.run_on_main_thread(move || {
        let looking = main_in_front(&handle);
        // Told only while the poll still waits for this answer: one that
        // gave up shows the notification instead.
        if tell.send(looking).is_err() || !looking {
            return;
        }
        let told_page = handle
            .get_webview_window(crate::MAIN)
            .is_some_and(|main| main.eval(script).is_ok());
        if !told_page {
            eprintln!("could not tell the page about a quiet alert");
        }
    });
    posted.is_ok() && told.recv_timeout(FOCUS_WAIT).unwrap_or(false)
}

/// Whether the person is looking at Copilot: the main window shown, not
/// minimised, in front and on the live site, where the page shows its own
/// pop-up. Call it on the main thread: off it, each getter waits on the
/// main thread with no time limit.
fn main_in_front<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(main) = app.get_webview_window(crate::MAIN) else {
        return false;
    };
    main.is_visible().unwrap_or(false)
        && !main.is_minimized().unwrap_or(true)
        && in_front(&main)
        && main.url().is_ok_and(|url| nav::is_live(&url))
}

/// On Windows the window whose page has the keyboard does not report itself
/// focused (menu.rs), so this asks which window is in front, as frame.rs
/// does. Shown but minimised still counts as visible there, hence the check
/// above.
#[cfg(windows)]
fn in_front<R: Runtime>(main: &WebviewWindow<R>) -> bool {
    crate::frame::in_front(main)
}

/// A Mac's key window: false while another app is active.
#[cfg(target_os = "macos")]
fn in_front<R: Runtime>(main: &WebviewWindow<R>) -> bool {
    main.is_focused().unwrap_or(false)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn in_front<R: Runtime>(_: &WebviewWindow<R>) -> bool {
    false
}

/// The saved settings, or None when the file is missing or too big.
fn read_saved(path: &Path) -> Option<Saved> {
    if std::fs::metadata(path).ok()?.len() > FILE_MAX {
        return None;
    }
    std::fs::read_to_string(path).ok().map(|text| parse_saved(&text))
}

/// The saved settings, checked: a corrupt file, or one from another version,
/// starts empty, and a value that does not fit is dropped.
fn parse_saved(text: &str) -> Saved {
    let Ok(saved) = serde_json::from_str::<Saved>(text) else {
        return Saved::default();
    };
    if saved.v != FILE_VERSION {
        return Saved::default();
    }
    let device = saved.device.filter(|device| is_hex32(device));
    let token = match &device {
        Some(device) => saved.token.filter(|token| token_fits(token, device)),
        None => None,
    };
    let seen = saved.seen.into_iter().filter(|shown| key_fits(&shown.k)).collect();
    Saved {
        v: FILE_VERSION,
        device,
        token,
        seen,
    }
}

fn saved_text(state: &State) -> Option<String> {
    serde_json::to_string(&Saved {
        v: FILE_VERSION,
        device: state.device.clone(),
        token: state.token.clone(),
        seen: state.seen.clone(),
    })
    .ok()
}

/// Writes through a temporary file and a rename, so a crash never leaves
/// half a file. On a Mac only this user can read it; on Windows the folder
/// is the user's own local (not roaming) app data.
fn write_file(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&temp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    match std::fs::rename(&temp, path) {
        // Windows: an antivirus or the search indexer may hold the file for a
        // moment (access denied, sharing violation).
        Err(error) if cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32)) => {
            std::thread::sleep(Duration::from_millis(200));
            std::fs::rename(&temp, path)
        }
        done => done,
    }
}

/// A Mac's authorization status, without the Mac-only types, so the rules
/// below are tested on every platform.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MacStatus {
    NotDetermined,
    Denied,
    /// Authorized, provisional or ephemeral.
    Allowed,
    Unknown,
}

/// What a Mac's status means, read without asking.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_permission(status: MacStatus) -> Permission {
    match status {
        MacStatus::NotDetermined => Permission::Prompt,
        MacStatus::Denied => Permission::Denied,
        MacStatus::Allowed => Permission::Granted,
        MacStatus::Unknown => Permission::Unavailable,
    }
}

/// The same, once macOS answered the request. Still undecided means macOS
/// would not ask (it reports its own refusal as "not granted"), so the page
/// must not say to answer a question that is not there.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_permission_answered(status: MacStatus) -> Permission {
    match status {
        MacStatus::NotDetermined | MacStatus::Unknown => Permission::Unavailable,
        other => mac_permission(other),
    }
}

/// Windows' NotificationSetting: off for the app (1), for the user (2) or by
/// policy (3) is denied. Enabled (0), DisabledByManifest (4), anything else
/// and an error (None) never block: Send a test shows whether toasts work.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_permission(setting: Option<i32>) -> Permission {
    match setting {
        Some(1..=3) => Permission::Denied,
        _ => Permission::Granted,
    }
}

#[cfg(windows)]
async fn read_permission(shared: &Alerts) -> Permission {
    toast::permission(&shared.app_id)
}

/// Windows asks nobody: the setting is all there is.
#[cfg(windows)]
async fn ask_permission(shared: &Alerts) -> Permission {
    toast::permission(&shared.app_id)
}

#[cfg(windows)]
async fn show<R: Runtime>(app: &AppHandle<R>, shared: &Alerts, alert: &Alert) -> bool {
    toast::show(app, &shared.app_id, alert)
}

#[cfg(target_os = "macos")]
async fn read_permission(_: &Alerts) -> Permission {
    mac::permission().await
}

#[cfg(target_os = "macos")]
async fn ask_permission(_: &Alerts) -> Permission {
    mac::request_permission().await
}

#[cfg(target_os = "macos")]
async fn show<R: Runtime>(app: &AppHandle<R>, _: &Alerts, alert: &Alert) -> bool {
    mac::show(app, alert).await
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn read_permission(_: &Alerts) -> Permission {
    Permission::Unavailable
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn ask_permission(_: &Alerts) -> Permission {
    Permission::Unavailable
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn show<R: Runtime>(_: &AppHandle<R>, _: &Alerts, _: &Alert) -> bool {
    false
}

/// Windows toasts, through tauri-winrt-notification 0.8.1, which adds no
/// script and plays the default sound unless told otherwise.
#[cfg(windows)]
mod toast {
    use std::{
        path::Path,
        sync::atomic::{AtomicBool, Ordering},
    };

    use tauri::{AppHandle, Runtime};
    use tauri_winrt_notification::{Duration, Toast};
    use windows::{UI::Notifications::ToastNotificationManager, core::HSTRING};

    use super::{Alert, Permission, windows_permission};

    /// The setting could not be read once already; said once per launch.
    static UNREADABLE: AtomicBool = AtomicBool::new(false);

    /// The AppUserModelID toasts are shown under: the app's identifier, which
    /// Tauri's installer puts on the Start menu shortcut (toasts need it). A
    /// build run from cargo's target folder has no shortcut and borrows
    /// PowerShell's, as tauri-plugin-notification 2.7.0 does (desktop.rs).
    pub fn app_id(identifier: &str) -> String {
        let built_here = tauri::utils::platform::current_exe()
            .ok()
            .and_then(|exe| {
                exe.parent().map(|dir| {
                    ["debug", "release"]
                        .iter()
                        .any(|profile| dir.ends_with(Path::new("target").join(profile)))
                })
            })
            .unwrap_or(false);
        if built_here {
            Toast::POWERSHELL_APP_ID.to_owned()
        } else {
            identifier.to_owned()
        }
    }

    pub fn permission(app_id: &str) -> Permission {
        let setting = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
            .and_then(|notifier| notifier.Setting());
        match setting {
            Ok(setting) => windows_permission(Some(setting.0)),
            Err(_) => {
                if !UNREADABLE.swap(true, Ordering::Relaxed) {
                    eprintln!("could not read whether Windows allows notifications");
                }
                windows_permission(None)
            }
        }
    }

    /// False when Windows refused the toast. A click on the popup arrives
    /// on a Windows thread; one from Action Center does not arrive here.
    pub fn show<R: Runtime>(app: &AppHandle<R>, app_id: &str, alert: &Alert) -> bool {
        let handle = app.clone();
        let path = alert.path.clone();
        let mut toast = Toast::new(app_id)
            .title(&alert.title)
            // 25 seconds on screen for a meeting, 7 for the rest.
            .duration(if alert.urgent { Duration::Long } else { Duration::Short });
        if !alert.body.is_empty() {
            toast = toast.text1(&alert.body);
        }
        toast
            .on_activated(move |_| {
                super::open_alert(&handle, &path);
                Ok(())
            })
            .show()
            .is_ok()
    }
}

/// A Mac's notifications, through mac-usernotifications 0.3.1
/// (UNUserNotificationCenter), which needs the app bundle: a development
/// build outside one reports unavailable. No buttons (they make macOS
/// relaunch the app when a notification is dismissed) and no timeout (it
/// would take the notification out of Notification Center).
#[cfg(target_os = "macos")]
mod mac {
    use std::{
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
        time::Duration,
    };

    use mac_usernotifications::{
        AuthorizationStatus, Notification, check_bundle, get_notification_settings, request_auth,
    };
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};
    use tauri::{AppHandle, Runtime};

    use super::{Alert, MacStatus, Permission, mac_permission, mac_permission_answered};

    /// A click opens the alert's page while something waits for it: this
    /// long after the alert, for a few alerts at a time (more for meetings).
    /// A later click only activates the app.
    const RESPONSE_WINDOW: Duration = Duration::from_secs(15 * 60);
    const WAITERS_MAX: usize = 4;
    const MEETING_WAITERS_MAX: usize = 8;
    /// macOS's Allow question waits for the person; after this the page asks
    /// them to answer it and click Enable again.
    const QUESTION_WAIT: Duration = Duration::from_secs(60);
    /// Reading the settings and posting a notification answer at once; these
    /// only keep a stuck system call from holding up the poller.
    const READ_WAIT: Duration = Duration::from_secs(10);
    const SEND_WAIT: Duration = Duration::from_secs(30);

    static WAITERS: AtomicUsize = AtomicUsize::new(0);
    static AWAKE: AtomicBool = AtomicBool::new(false);

    fn status_of(status: AuthorizationStatus) -> MacStatus {
        match status {
            AuthorizationStatus::NotDetermined => MacStatus::NotDetermined,
            AuthorizationStatus::Denied => MacStatus::Denied,
            AuthorizationStatus::Authorized
            | AuthorizationStatus::Provisional
            | AuthorizationStatus::Ephemeral => MacStatus::Allowed,
            _ => MacStatus::Unknown,
        }
    }

    /// None outside an app bundle, where UNUserNotificationCenter would crash.
    async fn read() -> Option<MacStatus> {
        if check_bundle().is_err() {
            return None;
        }
        let settings = tokio::time::timeout(READ_WAIT, get_notification_settings()).await;
        settings.ok()?.ok().map(|settings| status_of(settings.authorization_status))
    }

    pub async fn permission() -> Permission {
        read().await.map_or(Permission::Unavailable, mac_permission)
    }

    pub async fn request_permission() -> Permission {
        match read().await {
            None => Permission::Unavailable,
            Some(MacStatus::NotDetermined) => {
                match tokio::time::timeout(QUESTION_WAIT, request_auth()).await {
                    Err(_) => Permission::Prompt,
                    Ok(_) => read().await.map_or(Permission::Unavailable, mac_permission_answered),
                }
            }
            Some(status) => mac_permission(status),
        }
    }

    /// True once macOS accepted the notification. Banners show even while the
    /// app is in front (the crate's delegate asks for them); an alert marked
    /// quiet while the person looks at Copilot never gets here then
    /// (`quiet_here`).
    pub async fn show<R: Runtime>(app: &AppHandle<R>, alert: &Alert) -> bool {
        let note = Notification::new()
            .title(&alert.title)
            .message(&alert.body)
            .default_sound();
        let Ok(Ok(handle)) = tokio::time::timeout(SEND_WAIT, note.send()).await else {
            return false;
        };
        let most = if alert.urgent { MEETING_WAITERS_MAX } else { WAITERS_MAX };
        if WAITERS.fetch_add(1, Ordering::AcqRel) >= most {
            WAITERS.fetch_sub(1, Ordering::AcqRel);
            return true;
        }
        let app = app.clone();
        let path = alert.path.clone();
        tauri::async_runtime::spawn(async move {
            let answer = tokio::time::timeout(RESPONSE_WINDOW, handle.response()).await;
            WAITERS.fetch_sub(1, Ordering::AcqRel);
            // A click the crate saw as the notification leaving Notification
            // Center reads as dismissed and only activates the app.
            if answer.is_ok_and(|response| response.is_ok_and(|r| r.is_default_action())) {
                super::open_alert(&app, &path);
            }
        });
        true
    }

    /// Keeps App Nap from slowing the poller while alerts are on: a meeting's
    /// alert has six and a half minutes to arrive. Once per launch, on the
    /// main thread; turning alerts off leaves it until the app quits.
    pub fn hold_off_app_nap<R: Runtime>(app: &AppHandle<R>) {
        if AWAKE.swap(true, Ordering::AcqRel) {
            return;
        }
        let posted = app.run_on_main_thread(|| {
            let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &NSString::from_str("Desktop alerts"),
            );
            // Never ended: it lasts until the app quits.
            std::mem::forget(activity);
        });
        if posted.is_err() {
            AWAKE.store(false, Ordering::Release);
            eprintln!("could not keep App Nap from delaying desktop alerts");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE: &str = "0123456789abcdef0123456789abcdef";
    const OTHER_DEVICE: &str = "fedcba9876543210fedcba9876543210";
    const ORGANIZATION: &str = "00112233445566778899aabbccddeeff";

    fn token_for(device: &str) -> String {
        format!("tcdsk_{ORGANIZATION}_{device}_{}-_", "a1B2".repeat(10) + "c")
    }

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_800_000_000 + seconds)
    }

    #[test]
    fn tokens_must_fit_this_computer() {
        let token = token_for(DEVICE);
        assert_eq!(token.len(), 115);
        assert!(token_fits(&token, DEVICE));
        // Another computer's token is refused.
        assert!(!token_fits(&token_for(OTHER_DEVICE), DEVICE));
        for bad in [
            String::new(),
            token.replacen("tcdsk_", "tcmcp_", 1),
            token.to_uppercase(),
            token[..114].to_owned(),
            format!("{token}x"),
            format!("{}.", &token[..114]),
            format!("tcdsk_{ORGANIZATION}-{DEVICE}_{}", &token[72..]),
            token.replace("a1B2", "a1é"),
            format!("tcdsk_{}_{DEVICE}_{}", "g".repeat(32), &token[72..]),
        ] {
            assert!(!token_fits(&bad, DEVICE), "{bad}");
        }
    }

    #[test]
    fn a_new_device_id_is_32_hex() {
        let first = new_device().expect("random bytes");
        let second = new_device().expect("random bytes");
        assert!(is_hex32(&first) && is_hex32(&second));
        assert_ne!(first, second);
        assert!(!is_hex32("0123456789ABCDEF0123456789abcdef"));
        assert!(!is_hex32("0123"));
    }

    #[test]
    fn alerts_open_only_in_app_pages_on_the_live_site() {
        for (path, url) in [
            ("/calendar", "https://copilot.tiptop.vc/calendar"),
            ("/go/meeting?id=abc_1", "https://copilot.tiptop.vc/go/meeting?id=abc_1"),
            ("/fund-ii?tab=campaigns", "https://copilot.tiptop.vc/fund-ii?tab=campaigns"),
            ("/fund-ii/campaigns/7f3e-01", "https://copilot.tiptop.vc/fund-ii/campaigns/7f3e-01"),
            ("/go/meeting?id=a%2Bb", "https://copilot.tiptop.vc/go/meeting?id=a%2Bb"),
        ] {
            let (target, in_app) = alert_target(path).expect(path);
            assert_eq!(target.as_str(), url);
            assert_eq!(in_app, path);
        }
        let long = format!("/{}", "a".repeat(300));
        for path in [
            "",
            "today",
            "//evil.example",
            "/\\evil",
            "https://evil.example",
            "/api/auth/google",
            "/api/auth/google/",
            "/api/integrations/google/start?send=1",
            "/api/auth/%67oogle",
            "/today#x",
            "/to day",
            "/today\n",
            "/caf\u{e9}",
            "javascript:alert(1)",
            long.as_str(),
        ] {
            assert!(alert_target(path).is_none(), "{path:?}");
        }
        // Dot segments are resolved before the checks, and the page gets the result.
        assert_eq!(alert_target("/a/../calendar").map(|(_, p)| p).as_deref(), Some("/calendar"));
        assert!(alert_target("/x/../api/auth/google").is_none());
        assert!(path_fits(&format!("/{}", "a".repeat(299))));
    }

    #[test]
    fn the_page_is_asked_to_open_the_path_as_a_plain_string() {
        assert_eq!(
            open_script("/go/meeting?id=abc_1"),
            "window.dispatchEvent(new CustomEvent('tiptop-desktop-open', { detail: \"/go/meeting?id=abc_1\" }));"
        );
    }

    #[test]
    fn the_page_is_told_of_a_quiet_alert_with_a_plain_string() {
        assert_eq!(
            replied_script("/ask?thread=t-1"),
            "window.dispatchEvent(new CustomEvent('tiptop-desktop-replied', { detail: \"/ask?thread=t-1\" }));"
        );
        assert_eq!(
            replied_script("/x\"); alert(1); (\""),
            "window.dispatchEvent(new CustomEvent('tiptop-desktop-replied', { detail: \"/x\\\"); alert(1); (\\\"\" }));"
        );
    }

    #[test]
    fn polls_follow_copilots_hint_within_bounds() {
        assert_eq!(poll_after(None), Duration::from_secs(60));
        assert_eq!(poll_after(Some(60.0)), Duration::from_secs(60));
        assert_eq!(poll_after(Some(10.0)), Duration::from_secs(30));
        assert_eq!(poll_after(Some(-5.0)), Duration::from_secs(30));
        assert_eq!(poll_after(Some(7.0 * 3600.0)), Duration::from_secs(7 * 3600));
        assert_eq!(poll_after(Some(1e12)), Duration::from_secs(10 * 3600));
        assert_eq!(poll_after(Some(f64::NAN)), Duration::from_secs(60));
        assert_eq!(poll_after(Some(f64::INFINITY)), Duration::from_secs(60));
    }

    #[test]
    fn asking_soon_never_delays_a_poll_or_polls_sooner_than_half_a_minute() {
        assert_eq!(due_soon(Some(at(3600)), at(0)), Some(at(30)));
        assert_eq!(due_soon(Some(at(10)), at(0)), Some(at(10)));
        assert_eq!(due_soon(None, at(0)), None);
        // Asking again and again keeps the first half minute.
        let once = due_soon(Some(at(3600)), at(0));
        assert_eq!(due_soon(once, at(5)), Some(at(30)));
    }

    fn on_at_night() -> State {
        State {
            token: Some(token_for(DEVICE)),
            next_due: Some(at(7 * 3600)),
            ..State::default()
        }
    }

    #[test]
    fn asking_soon_waits_while_alerts_are_off_failing_or_held_back() {
        let mut state = on_at_night();
        state.poll_soon(at(0));
        assert_eq!(state.next_due, Some(at(30)));
        assert!(state.soon);

        let mut off = State { token: None, next_due: None, ..on_at_night() };
        off.poll_soon(at(0));
        assert_eq!(off.next_due, None);
        assert!(!off.soon);

        // A failed poll backs off, and a Retry-After (or notifications not
        // allowed) holds the next poll where Copilot put it.
        let mut failing = State { failures: 1, next_due: Some(at(60)), ..on_at_night() };
        failing.poll_soon(at(0));
        assert_eq!(failing.next_due, Some(at(60)));
        let mut held = State { held: true, next_due: Some(at(60)), ..on_at_night() };
        held.poll_soon(at(0));
        assert_eq!(held.next_due, Some(at(60)));
        assert!(!held.soon);
    }

    #[test]
    fn an_ask_during_a_poll_is_not_lost_to_its_answer() {
        // Copilot's answer predates the question: wait until 6am.
        let mut asked = State { soon: true, ..on_at_night() };
        asked.answered(Duration::from_secs(7 * 3600), at(100));
        assert_eq!(asked.next_due, Some(at(130)));
        assert!(!asked.soon);

        let mut quiet = State { failures: 2, held: true, ..on_at_night() };
        quiet.answered(Duration::from_secs(60), at(100));
        assert_eq!(quiet.next_due, Some(at(160)));
        assert_eq!(quiet.failures, 0);
        assert!(!quiet.held);
        // Once answered, the page may ask again.
        quiet.poll_soon(at(110));
        assert_eq!(quiet.next_due, Some(at(140)));
    }

    #[test]
    fn failures_back_off_then_settle_at_a_quarter_hour() {
        let waits: Vec<u64> = (1..=8).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(waits, [60, 120, 300, 300, 300, 900, 900, 900]);
        assert_eq!(backoff(u32::MAX).as_secs(), 900);
    }

    #[test]
    fn retry_after_is_seconds_within_bounds() {
        assert_eq!(retry_wait(Some("120")), Duration::from_secs(120));
        assert_eq!(retry_wait(Some(" 90 ")), Duration::from_secs(90));
        assert_eq!(retry_wait(Some("5")), Duration::from_secs(30));
        assert_eq!(retry_wait(Some("999999")), Duration::from_secs(3600));
        assert_eq!(retry_wait(None), Duration::from_secs(300));
        assert_eq!(retry_wait(Some("Wed, 21 Oct 2026 07:28:00 GMT")), Duration::from_secs(300));
        assert_eq!(retry_wait(Some("-1")), Duration::from_secs(300));
    }

    #[test]
    fn only_copilots_own_401_forgets_the_token() {
        let own = "Bearer realm=\"tiptop-copilot\", error=\"invalid_token\"";
        assert_eq!(classify(200, None, None), Answer::Ok);
        assert_eq!(classify(401, Some(own), None), Answer::Revoked);
        // The proxy's 401 for a route missing from its public list, or any
        // other realm, keeps the token and backs off.
        assert_eq!(classify(401, None, None), Answer::Failed);
        assert_eq!(classify(401, Some("Bearer realm=\"other\""), None), Answer::Failed);
        assert_eq!(classify(403, Some(own), None), Answer::Failed);
        assert_eq!(classify(429, None, Some("60")), Answer::Wait(Duration::from_secs(60)));
        assert_eq!(classify(429, None, None), Answer::Wait(Duration::from_secs(300)));
        assert_eq!(classify(503, None, Some("60")), Answer::Wait(Duration::from_secs(60)));
        assert_eq!(classify(503, None, None), Answer::Failed);
        for status in [204_u16, 299] {
            assert_eq!(classify(status, None, None), Answer::Ok);
        }
        for status in [301_u16, 302, 400, 404, 500, 502] {
            assert_eq!(classify(status, Some(own), Some("60")), Answer::Failed, "{status}");
        }
    }

    #[test]
    fn polls_come_due_by_the_clock() {
        assert!(is_due(None, at(0)));
        assert!(!is_due(Some(at(60)), at(0)));
        assert!(is_due(Some(at(60)), at(60)));
        assert!(is_due(Some(at(60)), at(61)));
        // Nine hours ahead is a night's wait; a day ahead means the clock went back.
        assert!(!is_due(Some(at(9 * 3600)), at(0)));
        assert!(is_due(Some(at(24 * 3600)), at(0)));
    }

    fn seen(key: &str, at: u64) -> Seen {
        Seen { k: key.to_owned(), at }
    }

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|key| (*key).to_owned()).collect()
    }

    #[test]
    fn an_alert_is_new_while_any_key_is() {
        let shown = vec![seen("money:a", 1), seen("money:b", 1)];
        assert!(!is_new(&shown, &keys(&["money:a"])));
        assert!(!is_new(&shown, &keys(&["money:a", "money:b"])));
        assert!(is_new(&shown, &keys(&["money:a", "money:c"])));
        assert!(is_new(&[], &keys(&["top3:2026-10-18"])));
    }

    #[test]
    fn shown_keys_are_remembered_once_and_pruned() {
        let mut shown = vec![seen("money:a", 10)];
        remember(&mut shown, &keys(&["money:a", "risk:x", "risk:x"]), 20);
        assert_eq!(shown, vec![seen("money:a", 10), seen("risk:x", 20)]);

        let day = 24 * 60 * 60;
        let now = 10 * day;
        let mut shown = vec![seen("old", now - 3 * day - 1), seen("edge", now - 3 * day), seen("future", now + 5)];
        prune(&mut shown, now);
        assert_eq!(shown, vec![seen("edge", now - 3 * day), seen("future", now + 5)]);

        let mut shown: Vec<Seen> = (0..310).map(|n| seen(&format!("k{n}"), now - 310 + n)).collect();
        shown.reverse();
        prune(&mut shown, now);
        assert_eq!(shown.len(), SEEN_MAX);
        assert_eq!(shown[0], seen("k10", now - 300));
        assert_eq!(shown[SEEN_MAX - 1], seen("k309", now - 1));
    }

    #[test]
    fn an_alert_is_given_up_after_three_failures() {
        let mut state = State::default();
        assert!(!state.give_up("meeting:a"));
        assert!(!state.give_up("meeting:a"));
        assert!(!state.give_up("money:b"));
        assert!(state.give_up("meeting:a"));
    }

    #[test]
    fn settings_survive_a_round_trip() {
        let state = State {
            device: Some(DEVICE.to_owned()),
            token: Some(token_for(DEVICE)),
            seen: vec![seen("money:a", 1_800_000_000)],
            ..State::default()
        };
        let text = saved_text(&state).expect("serialisable");
        assert_eq!(
            parse_saved(&text),
            Saved {
                v: 1,
                device: Some(DEVICE.to_owned()),
                token: Some(token_for(DEVICE)),
                seen: vec![seen("money:a", 1_800_000_000)],
            }
        );
        // Turned off: the id stays, the token does not.
        let off = State { token: None, ..state };
        let saved = parse_saved(&saved_text(&off).expect("serialisable"));
        assert_eq!(saved.device.as_deref(), Some(DEVICE));
        assert_eq!(saved.token, None);
    }

    #[test]
    fn a_damaged_or_foreign_file_starts_empty() {
        for text in ["", "{", "[]", "null", "{\"device\":null}", "{\"v\":2,\"device\":null,\"token\":null}"] {
            assert_eq!(parse_saved(text), Saved::default(), "{text}");
        }
        let other = format!("{{\"v\":1,\"device\":\"{DEVICE}\",\"token\":\"{}\"}}", token_for(OTHER_DEVICE));
        let saved = parse_saved(&other);
        assert_eq!(saved.device.as_deref(), Some(DEVICE));
        assert_eq!(saved.token, None);
        let bad_device = format!("{{\"v\":1,\"device\":\"ABC\",\"token\":\"{}\",\"seen\":[{{\"k\":\"\",\"at\":1}},{{\"k\":\"ok\",\"at\":2}}]}}", token_for(DEVICE));
        assert_eq!(
            parse_saved(&bad_device),
            Saved { v: 1, device: None, token: None, seen: vec![seen("ok", 2)] }
        );
    }

    #[test]
    fn the_file_is_written_whole_and_private() {
        let dir = std::env::temp_dir().join(format!(
            "tiptop-alerts-test-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos())
        ));
        let path = dir.join("nested").join(FILE);
        write_file(&path, "{\"v\":1}").expect("written");
        write_file(&path, "{\"v\":1,\"device\":null}").expect("replaced");
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "{\"v\":1,\"device\":null}");
        assert!(!path.with_extension("json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("metadata").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(read_saved(&path), Some(Saved { v: 1, ..Saved::default() }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn batch(json: &str) -> Batch {
        parse_batch(json.as_bytes()).expect("parsed")
    }

    #[test]
    fn copilots_answer_is_read_leniently() {
        let read = batch(
            r#"{"ok":true,"extra":1,"pollAfterSeconds":120,"alerts":[
                {"keys":["money:a","money:a"],"title":"Wire due today","body":"Fictional Fund LP","url":"/today","urgent":false,"tag":"x"}
            ]}"#,
        );
        assert_eq!(read.poll_after, Duration::from_secs(120));
        assert_eq!(
            read.alerts,
            vec![Alert {
                keys: keys(&["money:a"]),
                title: "Wire due today".to_owned(),
                body: "Fictional Fund LP".to_owned(),
                path: "/today".to_owned(),
                urgent: false,
                quiet_when_focused: false,
            }]
        );
        let quiet = batch(
            r#"{"alerts":[{"keys":["ask:a"],"title":"Arwin replied","body":"Fictional answer","url":"/ask?thread=t-1","quietWhenFocused":true}]}"#,
        );
        assert!(quiet.alerts[0].quiet_when_focused);
        assert_eq!(quiet.alerts[0].path, "/ask?thread=t-1");
        // A flag that is not a boolean makes the alert unreadable, as with urgent.
        assert!(
            batch(r#"{"alerts":[{"keys":["ask:b"],"title":"Bad flag","quietWhenFocused":"yes"}]}"#)
                .alerts
                .is_empty()
        );
        assert_eq!(batch("{}"), Batch { alerts: Vec::new(), poll_after: Duration::from_secs(60) });
        assert_eq!(batch(r#"{"alerts":null,"pollAfterSeconds":"soon"}"#).alerts, Vec::new());
        assert!(parse_batch(b"not json").is_none());
        assert!(parse_batch(b"42").is_none());
        assert!(parse_batch(br#"{"alerts":{"keys":["money:a"]}}"#).is_none());
    }

    #[test]
    fn alerts_that_do_not_fit_are_skipped_and_meetings_come_first() {
        let long_key = "k".repeat(201);
        let many_keys: Vec<String> = (0..51).map(|n| format!("\"money:{n}\"")).collect();
        let json = format!(
            r#"{{"alerts":[
                {{"keys":[],"title":"No keys"}},
                {{"keys":["{long_key}"],"title":"Long key"}},
                {{"keys":[{}],"title":"Too many keys"}},
                {{"keys":["wait:a"],"title":"  \n "}},
                {{"keys":["wait:b"],"title":null}},
                {{"keys":[1],"title":"Not a string"}},
                {{"keys":["risk:a"],"title":"Bad page","url":"https://evil.example"}},
                {{"keys":["risk:b"],"title":"No page"}},
                {{"keys":["c1"],"title":"One"}},
                {{"keys":["c2"],"title":"Two"}},
                {{"keys":["c3"],"title":"Three"}},
                {{"keys":["c4"],"title":"Four"}},
                {{"keys":["c5"],"title":"Five"}},
                {{"keys":["c6"],"title":"Six"}},
                {{"keys":["meeting:x:1"],"title":"Fictional sync in 5 minutes","url":"/go/meeting?id=x","urgent":true}}
            ]}}"#,
            many_keys.join(",")
        );
        let read = batch(&json);
        let titles: Vec<&str> = read.alerts.iter().map(|alert| alert.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Fictional sync in 5 minutes", "Bad page", "No page", "One", "Two", "Three", "Four", "Five"]
        );
        assert_eq!(read.alerts[0].path, "/go/meeting?id=x");
        assert!(read.alerts[0].urgent);
        assert_eq!(read.alerts[1].path, "/today");
        assert_eq!(read.alerts[2].path, "/today");
    }

    #[test]
    fn notification_text_is_flattened_and_cut_at_a_character() {
        assert_eq!(clip("  Line one\nline\ttwo\u{7}  ", 120), "Line one line two");
        assert_eq!(clip("a\u{202E}b\u{2066}c", 120), "abc");
        assert_eq!(clip("abcdef", 6), "abcdef");
        assert_eq!(clip("abcdefg", 6), "abcde…");
        assert_eq!(clip("ab   defg", 6), "ab…");
        // Multi-byte characters are never split.
        let cut = clip(&"é".repeat(300), TEXT_MAX);
        assert_eq!(cut.chars().count(), TEXT_MAX);
        assert!(cut.ends_with('…'));
        assert_eq!(clip("", 10), "");
    }

    #[test]
    fn mac_permission_never_asks_twice_for_a_question_not_shown() {
        assert_eq!(mac_permission(MacStatus::NotDetermined), Permission::Prompt);
        assert_eq!(mac_permission(MacStatus::Denied), Permission::Denied);
        assert_eq!(mac_permission(MacStatus::Allowed), Permission::Granted);
        assert_eq!(mac_permission(MacStatus::Unknown), Permission::Unavailable);
        // Once macOS answered the request.
        assert_eq!(mac_permission_answered(MacStatus::Allowed), Permission::Granted);
        assert_eq!(mac_permission_answered(MacStatus::Denied), Permission::Denied);
        assert_eq!(mac_permission_answered(MacStatus::NotDetermined), Permission::Unavailable);
        assert_eq!(mac_permission_answered(MacStatus::Unknown), Permission::Unavailable);
    }

    #[test]
    fn only_a_windows_setting_that_is_off_blocks() {
        assert_eq!(windows_permission(Some(0)), Permission::Granted);
        for off in [1, 2, 3] {
            assert_eq!(windows_permission(Some(off)), Permission::Denied, "{off}");
        }
        assert_eq!(windows_permission(Some(4)), Permission::Granted);
        assert_eq!(windows_permission(Some(99)), Permission::Granted);
        assert_eq!(windows_permission(None), Permission::Granted);
    }

    #[test]
    fn the_page_is_told_the_state_never_the_token() {
        let status = Status {
            on: true,
            permission: Permission::Prompt,
            device: DEVICE.to_owned(),
            platform: PLATFORM,
        };
        assert_eq!(
            serde_json::to_value(&status).expect("serialisable"),
            serde_json::json!({ "on": true, "permission": "prompt", "device": DEVICE, "platform": PLATFORM })
        );
        assert!(PLATFORM == "mac" || PLATFORM == "windows");
        for (permission, text) in [
            (Permission::Granted, "granted"),
            (Permission::Denied, "denied"),
            (Permission::Unavailable, "unavailable"),
        ] {
            assert_eq!(serde_json::to_value(permission).expect("serialisable"), text);
        }
    }

    #[test]
    fn requests_go_to_the_live_site_only() {
        assert_eq!(alerts_url(), "https://copilot.tiptop.vc/api/desktop/alerts");
        assert!(USER_AGENT.starts_with("TipTopCopilot/"));
        assert!(USER_AGENT.ends_with(" desktop-alerts"));
    }

    #[test]
    fn only_settings_on_the_live_site_in_the_main_window_may_use_alerts() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop-alerts.json")).expect("valid JSON");
        assert_eq!(capability["identifier"], "desktop-alerts");
        // Never the bundled fallback page.
        assert_eq!(capability["local"], false);
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(capability.get("webviews").is_none());
        assert_eq!(capability["platforms"], serde_json::json!(["macOS", "windows"]));
        assert_eq!(capability["remote"]["urls"], serde_json::json!(["https://copilot.tiptop.vc:443/*"]));
        assert_eq!(capability["permissions"], serde_json::json!(["allow-desktop-alerts"]));

        let file = include_str!("../permissions/desktop-alerts.toml");
        assert_eq!(file.matches("[[permission]]").count(), 1);
        assert!(file.contains("identifier = \"allow-desktop-alerts\""));
        assert!(file.contains(
            "commands.allow = [\"alerts_state\", \"alerts_request_permission\", \"alerts_turn_on\", \"alerts_turn_off\", \"alerts_test\", \"alerts_poll_soon\"]"
        ));
    }
}
