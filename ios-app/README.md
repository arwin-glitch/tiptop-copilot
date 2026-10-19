# TipTop Copilot for iPhone

An iPhone app that is a window onto the live site, https://copilot.tiptop.vc,
with Apple's own push service (APNs) for alerts. It is built with
[Capacitor](https://capacitorjs.com) 8.5.3 and reaches Nick and Arwin through
TestFlight, for internal testing only: it is never on the App Store.

Everything after the first page is the web app, so every web update reaches
the iPhone app with no new build. The app itself is rebuilt only when this
folder changes, and once a month so no TestFlight build expires.

Nothing here is built on a laptop: GitHub Actions builds it on a Mac
(`.github/workflows/ios.yml`). The app needs Apple's keys only to be signed
and sent to TestFlight; everything else runs, and is checked, without them.

## What is in this folder

| Path | What it is |
| --- | --- |
| `package.json`, `package-lock.json` | Capacitor, pinned exactly: `@capacitor/cli`, `core` and `ios` 8.5.3, `@capacitor/push-notifications` 8.1.3, `@capacitor/app` 8.1.2. No other plugin. |
| `capacitor.config.json` | The live site as the server (`https://copilot.tiptop.vc/`, root and trailing slash both required), the offline page, the user-agent token, native HTTP and cookies off. |
| `www/offline.html` | Shown only when the site cannot be reached; tries again on its own. |
| `ios/` | The Xcode project: Capacitor's own template (`npx cap add ios`) plus the changes listed below. `cap sync` regenerates the ignored parts on every build. |
| `icon-source.json` | The SHA-256 of `public/icon.svg` the app icon was drawn from. |
| `scripts/` | `make-icon.mjs` draws the icon. `asc.mjs` talks to App Store Connect and APNs. `check-config.mjs` and `check-native-project.mjs` are CI's checks. `simulator-smoke.sh` opens the app on a simulator. `signing-keychain.sh` loads the certificate on the runner. `signing-request.sh` and `signing-p12.sh` make the signing certificate on the admin's computer. |
| `tests/` | `main.swift`, the shell's own checks, compiled and run on the Mac runner; `asc.test.mjs`, the App Store Connect script against a stand-in server. |

## What the shell changes, and why

`scripts/check-native-project.mjs` compares `ios/` with a fresh `cap add ios`
on every CI run and fails on any change not in this list.

- **Bundle ID `vc.tiptop.copilot`, iOS 16.4, iPhone only, portrait.** 16.4 is
  the same floor web push already needs, so any phone that gets alerts today
  can run the app. The home-screen name is "TipTop", as for the web app.
- **`Info.plist`.** `ITSAppUsesNonExemptEncryption` is false (HTTPS only), so
  uploads do not wait on the export-compliance questions. Camera, microphone
  and photo-library usage strings, because the web app's file pickers offer
  Take Photo or Video and iOS ends an app that asks without them. The
  `vc.tiptop.copilot` URL scheme, for the sign-in return link. No storyboard
  makes the window, so `SceneDelegate` makes the only one.
- **Entitlements.** `aps-environment` for push. The release job sets it to
  the provisioning profile's value (production for TestFlight) and adds Time
  Sensitive notifications only when the profile has them.
- **`TipTopBridgeViewController`** replaces Capacitor's view controller
  (`SceneDelegate` makes it). It turns on swipe-back, colours the web view
  like the launch screen, and puts three stand-ins in front of Capacitor's
  own delegate (`WebViewProxies.swift`, decisions in `ShellPolicy.swift`):
  - **The offline page only for a network failure.** Capacitor 8.5.3 shows it
    for every failed load, including a cancelled one (-999) and one that
    became a download or a hand-off to Safari (WebKit 102), which would hide a
    working page, for example right after a meeting link opens Zoom.
  - **Downloads.** An attachment, a type WebKit cannot show, or an
    `<a download>` link (CRM exports, the deal memo, inbox attachments, the
    export button's `blob:` save) is saved and offered to the share sheet:
    Save to Files, AirDrop, Mail.
  - **Plugin listeners survive a download.** Capacitor clears them when any
    navigation starts; the shell waits until a new page actually replaces the
    old one, so a download or a redirect handed to Safari leaves push and link
    listeners working.
  - **Same-site new-window links stay in the app.** Capacitor sends every
    `target=_blank` and `window.open` to Safari, which would show Copilot
    signed out. Other sites still go to Safari or their own app.
  - **`window.open` works without a tap**, so a meeting's join link opens
    after the page fetches it, or from an alert tap.
  - **Only four plugins answer the page**: PushNotifications, App, SystemBars
    and Console, and only for the live site's own top-level page. Capacitor
    also registers CapacitorHttp, CapacitorCookies and WebView in every app;
    their calls are dropped, and the shell answers Capacitor's prompt() channel
    as "off", so a script on the page cannot make native requests around the
    CSP or write cookies.
  - **No camera, microphone or motion access for web pages.** Capacitor grants
    them to any page; Copilot never asks. File pickers are unaffected.
  - The stand-ins pass every other delegate call to Capacitor unchanged, and
    the simulator check fails if Capacitor ever implements one they do not.
- **`AppDelegate`.** Passes the push token to the plugin (the plugin's
  README), and holds an alert tap that launches the app until Capacitor's
  notification router exists: Apple requires a notification delegate before
  launch finishes, and Capacitor 8 sets its own only when the scene connects.
- **Launch screen and icon.** A plain colour, `#f6f1e4` or `#0e0f0f` in dark
  mode, and the TipTop mark from `public/icon.svg`, full-bleed, 1024 px, no
  transparency (`npm run icon` redraws it; CI warns when the SVG changes).

## What the web app relies on

- **The app's token.** Every request's user agent ends with
  `TipTopCopilotiOS/<version>` (the version in `package.json`), after
  WebKit's own `Mobile/15E148`. A TestFlight build adds
  `TipTopBuilt/YYYY-MM-DD`, the UTC day it was built, after it. Both are
  layout hints, never credentials.
- **Push.** `PushNotifications.requestPermissions()` then `register()`; the
  `registration` event's `value` is the APNs device token as upper-case hex.
  A tap fires `pushNotificationActionPerformed`, whose
  `notification.data` is the whole APNs payload, so `data.url` and `data.tag`
  are the payload's own keys. A tap that launched the app waits until the page
  adds that listener. The APNs topic is `vc.tiptop.copilot`; TestFlight builds
  use the production APNs host.
- **Listeners after a page change.** The shell clears native listeners
  whenever a new page replaces the old one, as Capacitor does, so the page
  adds them on load. A page WebKit restores from its back-forward cache (after
  a swipe back) keeps its JavaScript but not its native listeners, so the page
  should add them again on `pageshow` when `event.persisted` is true.
- **Sign-in return.** A `vc.tiptop.copilot://…` link opens the app, and the
  App plugin's `appUrlOpen` event carries the full URL. Google sign-in cannot
  run inside the app; the web app starts it in Safari.
- **Downloads and new-window links work** as described above, so exports need
  not be hidden in the app.
- **Status bar.** It follows the phone's light or dark mode; the page may call
  `SystemBars.setStyle` to match its own theme.
- **Build age.** TestFlight builds stop opening 90 days after upload. The
  `TipTopBuilt` day says when a build was made; `App.getInfo()` also gives
  `build`, whose first part is the same day as `YYYYMMDD` (for example
  `20261019.57.1`). A simulator or local build has neither (`build` is `1`).

## How it is built

`.github/workflows/ios.yml`, on GitHub's `macos-26` runners with Xcode 26.6:

1. **checks** (Linux, every push touching this folder, the workflow,
   `public/icon.svg` or the root `package.json`): versions and pins agree,
   the reviewed settings hold, the native project is the template plus the
   listed changes and in step with `cap sync`, and `asc.mjs`'s tests pass.
2. **simulator** (macOS, when this folder or the workflow changed): compiles
   and runs `tests/main.swift` against the shell's own code, confirms this
   Xcode knows every export option and Swift package option the builds use,
   resolves the Swift packages (below), builds for the simulator and,
   unsigned, for devices, checks the built app's settings, then opens it on
   an iPhone simulator: it must show the live site (or, if the runner cannot
   reach it, the offline page), keep running, pass its delegate check and
   open from a `vc.tiptop.copilot://` link. Screenshots (launch, after the
   link, dark mode) and logs stay on the run for 14 days.
3. **resolved** (branch pushes only): commits the build's
   `Package.resolved` when none is committed or it changed.
4. **gate → release** (tag `ios-vX.Y.Z`, the 1st of each month, or Run
   workflow with task `upload`): only when all six keys below are set;
   otherwise the gate posts a notice and nothing fails. Uses exactly the
   committed `Package.resolved`, and refuses to run without one that fits.
   Signs by hand with the Apple Distribution certificate in a keychain made
   for the run; finds or makes the App Store profile for that certificate
   through the API; archives with build number
   `<UTC date YYYYMMDD>.<run number>.<attempt>` (always higher than the
   last); checks the signed app carries production push; exports for
   **TestFlight internal testing only** and uploads. The monthly run rebuilds
   the newest `ios-v*` tag.
5. **report** opens an issue if a monthly rebuild fails or the certificate
   ends within 30 days.
6. **setup** (Run workflow, task `setup`): checks each key that is set,
   registers the bundle ID with Push Notifications (and tries Time Sensitive
   Notifications), makes sure a profile can be made, and lists what is
   missing.

**Swift packages.** Capacitor's native code comes from its Swift package
(`capacitor-swift-pm`, pinned exactly to 8.5.3 by `cap sync`). Xcode records
the exact commit in
`ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
While that file is committed and fits, every build uses exactly that commit
(`-disableAutomaticPackageResolution`) and fails rather than fetching another.
The first branch build after this folder lands has none, so it resolves the
packages itself, and the **resolved** job commits the file to the branch as
"ios: commit the Package.resolved from run …" (like the desktop's Cargo.lock
job). After a Capacitor upgrade the same happens again. Tag a commit that
includes that file.

Workflow logs can be read by others, so the certificate's name (the Account
Holder's legal name) and the team ID are masked before any tool could print
them, no signing log is kept as an artifact, and no key is ever printed. The
key IDs and team ID are identifiers, not credentials; a GitHub variable is
visible in a step's settings. Every action the workflow uses is GitHub's own,
pinned to a commit.

## Apple's keys

Secrets (Settings, Secrets and variables, Actions, Secrets):

| Name | What it is |
| --- | --- |
| `ASC_KEY_P8` | The App Store Connect team API key (the `.p8` file's text), Admin access. |
| `IOS_DIST_P12` | The Apple Distribution certificate and key, as base64 (from `signing-p12.sh`). |
| `IOS_DIST_P12_PASSWORD` | Its password (from `signing-p12.sh`). |
| `APNS_KEY_P8` | The APNs key (the `.p8` file's text). Used by the alert sender and by `setup`; never by a build. |

Variables (the same page, Variables):

| Name | What it is |
| --- | --- |
| `ASC_KEY_ID` | The App Store Connect key's ID. |
| `ASC_ISSUER_ID` | The Issuer ID shown above the team keys. |
| `APPLE_TEAM_ID` | The team ID (from `signing-p12.sh`, read from the certificate). |
| `APNS_KEY_ID` | The APNs key's ID. |
| `APNS_TIME_SENSITIVE` | Optional, set later: `1` once an installed build has Time Sensitive Notifications (step A10). |

The Mac app's notarisation keys come later, with the desktop work.

## One-time setup, after Apple approves the account

Nick enrolled as an Individual in October 2026. These steps start once
Apple's approval email arrives. On an Individual account only Nick can use
Certificates, Identifiers & Profiles; Arwin works in App Store Connect and
GitHub.

**Go/no-go.** Step N3 asks Apple to turn on the App Store Connect API, which
Apple reviews case by case. If it is refused, stop: the alternatives store
Nick's own Apple ID password in CI, which also opens his iCloud mail, so the
choice goes back to Nick (an Organization enrolment would be the clean route).

**Before anything:** Arwin needs an iPhone on iOS 16.4 or later, and a phone
for two-factor sign-in to the Apple Account he will use for App Store Connect
(he can make that account when he accepts the invite).

### Arwin, before Nick's sitting

**A1. Make the two signing requests** (Git Bash, about a minute):

```sh
bash ios-app/scripts/signing-request.sh /e/tiptop-apple-signing <your work email>
```

Send Nick `dist.certSigningRequest` and `devid.certSigningRequest` from
`E:\tiptop-apple-signing\`. They are not secret. The `.key` files never leave
that folder.

### Nick, one sitting on a laptop (about 15 minutes)

**N1.** appstoreconnect.apple.com → **Business** → Agreements: accept anything
waiting (until then no app can be added and every upload fails).

**N2.** **Users and Access** → People → **+** → Arwin's name and work email →
role **Admin** → Next → **Invite**. (The invitation expires after 3 days.)

**N3.** **Users and Access** → **Integrations** → App Store Connect API →
**Request Access** → tick the box → **Submit**.

**N4.** developer.apple.com/account/resources → **Certificates** → **+** →
**Apple Distribution** → Continue → Choose File: `dist.certSigningRequest` →
Continue → **Download**. Send the `.cer` to Arwin, named `dist.cer`.

**N5.** **Certificates** → **+** → **Developer ID** → **Developer ID
Application** → Continue → Choose File: `devid.certSigningRequest` → Continue
→ **Download**. Send it to Arwin, named `devid.cer` (for the Mac app, later).

**N6.** **Keys** → **+** → Key Name `Copilot Push` → tick **Apple Push
Notification service (APNs)** → **Configure** → environment **Sandbox &
Production**, key type **Team Scoped** → Continue → **Confirm** →
**Download** (it downloads only once) → Done. Send Arwin the `.p8` file and
its Key ID through the password manager, never by email or chat.

Certificates are public; only the `.p8` is secret.

### Arwin, after the sitting

**A2.** Accept the App Store Connect invitation from the email (within 3
days).

**A3.** Once Apple approves API access: App Store Connect → **Users and
Access** → **Integrations** → App Store Connect API → **Team Keys** →
**Generate API Key** → name `Copilot CI`, access **Admin** → **Generate** →
**Download** (only once). Note the Key ID, and the Issuer ID above the list.

**A4.** Put `dist.cer` and `devid.cer` into `E:\tiptop-apple-signing\`, then:

```sh
bash ios-app/scripts/signing-p12.sh /e/tiptop-apple-signing
```

It makes the `.p12` files and `paste-into-github.txt`. Store both `.p12`
files and their passwords in the password manager.

**A5.** GitHub → the repository → **Settings** → **Secrets and variables** →
**Actions**:

- **Secrets** → New repository secret, four times:
  `ASC_KEY_P8` (open the A3 `.p8` in Notepad, copy all of it),
  `IOS_DIST_P12` and `IOS_DIST_P12_PASSWORD` (from `paste-into-github.txt`),
  `APNS_KEY_P8` (all of Nick's push `.p8`).
- **Variables** → New repository variable, four times:
  `ASC_KEY_ID` and `ASC_ISSUER_ID` (A3), `APPLE_TEAM_ID` (from
  `paste-into-github.txt`), `APNS_KEY_ID` (from Nick, N6).

Then delete `paste-into-github.txt`.

Then restart the alert job, which reads its keys only when a run starts:
GitHub → **Actions** → **push-alerts** → click the run that is in progress
→ **Cancel workflow** (top right); then back on the push-alerts list, **Run
workflow** → branch `master` → **Run workflow**. (A cancelled run does not
start the next one by itself. Until a new run starts, the app's Settings say
"Copilot can't send to this app yet" and Send a test alert is greyed out.)

**A6.** GitHub → **Actions** → **ios** → **Run workflow** → task **setup** →
Run. Every row of its summary should say yes. It registers
`vc.tiptop.copilot` with Push Notifications. If it notes that Time Sensitive
Notifications could not be turned on, ask Nick to tick it: developer.apple.com
→ Identifiers → `vc.tiptop.copilot` → **Time Sensitive Notifications** →
Save. (Without it meeting alerts still arrive, as ordinary alerts.)

**A7.** App Store Connect → **Apps** → **+** → **New App**: platform **iOS**,
name `TipTop Copilot` (if taken, `TipTop Copilot for iPhone`), language
English (U.S.), bundle ID `vc.tiptop.copilot`, SKU `tiptop-copilot-ios`,
**Full Access** → **Create**. The bundle ID is permanent from the first
upload.

**A8.** The new app → **TestFlight** → **+** next to Internal Testing → name
`TipTop` → tick **Enable automatic distribution** → Create → **Invite
Testers** → tick Nick and Arwin → Add.

**A9.** The first build: push the tag `ios-v1.0.0` on a `master` commit
that has `Package.resolved` (the bot's "ios: commit the Package.resolved"
commit, or anything after it), or Actions → ios → Run workflow on `master`
with task **upload**. Apple processes it for about 5 to 30 minutes, then
TestFlight emails both testers.

**A10.** Meeting alerts break through a Focus only once the installed build
has Time Sensitive Notifications. The release job's log says whether this
build's profile had them ("Meeting alerts in this build can break through a
Focus"). Once such a build is installed: GitHub → **Settings** → **Secrets
and variables** → **Actions** → **Variables** → New repository variable
`APNS_TIME_SENSITIVE` = `1`, then restart the alert job as in A5. Until then
meeting alerts arrive as ordinary alerts.

### On each iPhone (about 2 minutes; Arwin first)

1. Install **TestFlight** from the App Store.
2. Open the TestFlight email on the iPhone → **View in TestFlight** →
   **Accept** → **Install**.
3. In TestFlight, open TipTop Copilot and turn **Automatic Updates** on, so
   the monthly build replaces the old one before it expires.
4. Open the app → **Sign in with Google** → Safari opens; sign in with
   Google there → on the page showing a 4-character code, tap **Open TipTop
   Copilot** → **Open** (or type the code into the app).
5. In the app: **Settings** (near the right end of the bottom bar; swipe the
   bar to reach it) → **Preferences** → iPhone alerts → **Turn on alerts on
   this iPhone** → **Allow**. Then tap **Send a test alert**: it
   arrives within about a minute (6am to 9pm Central).

A small orange dot by the app's name means it came from TestFlight.

## Checking on a phone

Arwin, on the first build, before Nick installs:

- [ ] Signs in once, and stays signed in after closing the app.
- [ ] The clock and the Dynamic Island never cover the page, in light and dark mode; the launch colour matches.
- [ ] Settings → Preferences → iPhone alerts → **Turn on alerts on this iPhone** → **Allow** → **Send a test alert** → it arrives within about a minute; tapping it opens Settings.
- [ ] Close the app fully (swipe it away), send another test alert, tap it: the app opens on Settings.
- [ ] A meeting alert's tap opens the meeting in Zoom, Meet or Teams, and the app does not show the offline page afterwards.
- [ ] Export a CRM list as CSV: the share sheet offers Save to Files.
- [ ] Open a briefing PDF or an attachment, then swipe from the left edge to come back.
- [ ] A link to another site opens Safari; a same-site link meant for a new tab stays in the app.
- [ ] Attaching a file offers Take Photo or Video, which works without the app closing.
- [ ] Settings' Google connect link says to do it on a computer.
- [ ] Airplane mode → reopen the app → the offline page; turn it off → Copilot returns on its own.
- [ ] After a test alert, the web app's own home-screen alerts stop arriving on that phone (no double pings).

## Every year: renewing the certificate

The Apple Distribution certificate lasts a year. The monthly run warns, and
opens an issue, 30 days before it ends; after it ends uploads stop, and 90
days later the installed build stops opening.

1. Nick: developer.apple.com → Certificates → **+** → **Apple
   Distribution** → upload the same `dist.certSigningRequest` (Arwin still
   has it) → Download → send to Arwin as `dist.cer`.
2. Arwin: replace `dist.cer` in `E:\tiptop-apple-signing\`, run
   `signing-p12.sh` again, and update the secrets `IOS_DIST_P12` and
   `IOS_DIST_P12_PASSWORD`.
3. Run the workflow with task **upload**. It makes a profile for the new
   certificate by itself.

Also yearly: Nick accepts any updated Apple agreement when Apple emails him
(uploads stop until he does), and the $99 renews. Apple sends those emails,
and certificate notices, to the Apple Account Nick enrolled with, so that
mailbox should be one he reads, or forward Apple Developer mail from it to
his work address and to Arwin.

## When something fails

- **"TestFlight upload skipped"**: a key is missing; the notice names it.
- **The monthly run opened an issue**: the run's error says why. Most often an
  agreement waits for Nick in App Store Connect (Business), or the certificate
  has expired (renew it as above).
- **The simulator check showed the offline page**: the runner could not reach
  the live site at that moment; the screenshot shows the page. The shell
  itself passed.
- **"No Package.resolved is committed"** on an upload: push the commit to a
  branch first; its simulator build resolves the Swift packages and the
  resolved job commits the file. Then tag (or upload from) that newer
  commit. **"does not fit the project"**: the same, after a Capacitor
  change.
- **"Delegate check failed"**: a Capacitor upgrade added a delegate method;
  add it to the stand-ins in `WebViewProxies.swift`.

## Changing the app

- **A new version.** Set the same `X.Y.Z` in `package.json`, in
  `capacitor.config.json` (`ios.appendUserAgent`) and as `MARKETING_VERSION`
  in `ios/App/App.xcodeproj/project.pbxproj` (both lines); CI checks they
  agree. Then tag `ios-vX.Y.Z`.
- **Only web changes need nothing here**: they reach the app from the site.
- **The icon.** Edit `public/icon.svg`, then run `npm run icon` here (from a
  checkout where `npm ci` ran at the root) and commit the PNG and
  `icon-source.json`.
- **Capacitor or a plugin.** Change the exact version in `package.json`, run
  `npm install` here (Node 22 or newer) and `npx cap sync ios`, and update
  `check-native-project.mjs` and `WebViewProxies.swift` if the template or
  Capacitor's delegate changed (and the pins in `check-config.mjs`). CI says
  what differs, and its resolved job commits the new `Package.resolved`. Every plugin can be called by any script on the live
  site, so add one only with a reason, and add its name to
  `ShellPolicy.allowedPlugins`.
- **A tag's own scripts build it.** The monthly run uses this workflow with
  the newest tag's `ios-app/`, so a change to the scripts the workflow calls
  reaches the monthly build with the next tag.
