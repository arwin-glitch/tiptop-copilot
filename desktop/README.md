# TipTop Copilot desktop app

Copilot in its own window, with an icon in the Dock (Mac) or the taskbar and
system tray (Windows). It is built with [Tauri](https://tauri.app) 2.

## What it is

The app is a window onto the live site, https://copilot.tiptop.vc. It ships one
small page of its own (`fallback/`), which shows "Opening TipTop Copilot…"
and hands over to the live site as soon as the site answers. Everything after
that is the web app, so every web update reaches the desktop app with no new
build.

The shell gives the web page no native access at all: there is no
`capabilities/` folder, no commands, and no `window.__TAURI__` object. What the
shell does is all in Rust (`src-tauri/src/`):

- **Where links go** (`nav.rs`, unit-tested). The live site loads in the
  window. Any other web address, `mailto:` and `tel:` open in the default
  browser. Everything else (`data:`, `file:`, plain `http` to the live site)
  is refused. `/api/auth/google` and `/api/integrations/google/start` never
  load in the window, because Google refuses sign-in inside an app window; the
  web app hides those links in the desktop app and this is the backstop.
- **New-tab links.** A same-site link meant for a new tab (an attachment, the
  full briefing) opens in a second window, so the page it came from keeps any
  half-written reply. Those windows close for real.
- **The desktop flag.** Every page on the live host gets
  `window.__TIPTOP_DESKTOP__` (the app version) and a `tiptop_desktop` cookie.
  The web app uses them for layout only, never for access.
- **Windows.** Closing the main window hides it. On Windows the tray icon
  brings it back (left-click, or right-click for Open and Quit); on a Mac,
  click the Dock icon and quit with ⌘Q. Opening the app a second time focuses
  the running one. The main window's size and position are remembered.
- **Menus** (`menu.rs`). File, Edit and View, in the menu bar on a Mac and
  under the title bar of every window on Windows (dark when Windows is in
  dark mode). Commands act on the window in front.
  - **File:** Settings… (opens Settings in the main window), Check for
    Updates… (see "How updates work"), Close Window (hides the main window,
    closes any other), Quit TipTop Copilot. On a Mac, Check for Updates…,
    Settings… ⌘, and Quit ⌘Q sit in the TipTop Copilot menu with About,
    Hide, Hide Others and Show All, and File holds Close Window ⌘W.
  - **Edit:** Undo, Redo, Cut, Copy, Paste, Paste and Match Style, Delete,
    Select All. They act on the focused field in the page, the same as the
    keys. Undo through Paste and Select All are the system's own items;
    Paste and Match Style is the Mac's own action (⌥⇧⌘V) or Chromium's
    Ctrl+Shift+V on Windows; Delete removes the selection.
  - **View:** Reload (⌘R / Ctrl+R), Force Reload (⇧⌘R / Ctrl+Shift+R; skips
    the cache), Toggle Full Screen (⌃⌘F on a Mac), Actual Size, Zoom In and
    Zoom Out (⌘0 ⌘= ⌘- on a Mac). The zoom is per window and stays through
    reloads, and the main window's is remembered for the next launch. On
    Windows only the menu zooms: Ctrl+=, Ctrl+-, Ctrl+wheel and pinch do
    nothing, as in 0.1.0.
- **Mac downloads.** Files are saved to Downloads and Finder opens with the
  file selected. Windows keeps WebView2's own download bar.
- **Updates** (`updates.rs`, unit-tested). From 0.2.0 the app installs new
  versions of itself; see "How updates work" below.

The fallback page checks the site is up by loading `/icon-192.png` from it,
so keep that file served by the web app.

## How it is built

Nothing is built on anyone's computer. `.github/workflows/desktop.yml` builds
both installers on GitHub's Mac and Windows runners:

- **A push to any branch** that changes `desktop/` or the workflow builds a
  universal Mac `.dmg` (Apple Silicon and Intel) and a Windows setup `.exe`.
  They are attached to the run as artifacts named `tiptop-copilot-mac` and
  `tiptop-copilot-windows` (Actions tab, open the run, Artifacts at the
  bottom) and kept for 14 days. Use them to test on a real machine before a
  release.
- **A tag `desktop-vX.Y.Z`** builds the same way, signs the update files
  (the `sign` job) and then publishes a release with the versioned
  installers plus files with fixed names: `TipTop-Copilot-mac.dmg` and
  `TipTop-Copilot-windows-setup.exe`, which the web app's `/download` page
  serves through our own domain, so people never visit GitHub; and the
  update files (`TipTop-Copilot-mac.app.tar.gz`, a `.sig` for it and for
  the Windows installer, and `latest.json`), which installed apps fetch
  through Copilot's update routes. Never rename any of them.

Every build signs its update files with a throwaway key made for that run,
which no installed app trusts, so a branch build can never be installed as
an update. Only a tag's `sign` job uses the real key (see "The update
signing key").

The icons are generated during the build from `public/icon.svg`, so none are
committed. The Mac build runs `cargo test` on the navigation rules, the zoom
steps and the update timing first.

## Releasing a new version

1. Set the same new `version` in **both** `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`. The workflow stops if they differ. Also set it on
   the `tiptop-copilot-desktop` entry in `src-tauri/Cargo.lock` (a branch
   build that finds the old version there updates that entry and commits
   it; a tag build stops). Never delete `Cargo.lock` for a version change.
2. Merge to `master`, with `src-tauri/Cargo.lock` committed and up to date
   (see below; a tag build stops without it).
3. Tag the merged commit and push the tag:
   ```sh
   git tag desktop-v0.2.1
   git push origin desktop-v0.2.1
   ```
4. Wait for the desktop workflow to finish. The release is published only if
   both installers built and both update files were signed and their
   signatures checked. The Download page shows the new version within about
   ten minutes.
5. Installed apps from 0.2.0 on find it within about six hours, or at once
   from Check for Updates…, download it and ask to restart. People on 0.1.0
   download the new version once from `/download` (see "How updates
   work").

Most changes need none of this: anything in the web app shows up in the
desktop app on its next page load. A new desktop version is only needed when
something in `desktop/` changes.

### Cargo.lock

A tag build refuses to run unless `desktop/src-tauri/Cargo.lock` is committed
and fits `Cargo.toml`, so a release is always built from the exact crate
versions that were tested. Every build whose lock fits passes `--locked`.

After adding or changing a dependency in `Cargo.toml` (or the version), push
to a branch. Its build sees that the lock no longer fits and updates it as
little as possible: every crate already pinned stays at its version and only
what changed is resolved. The branch's `lock` job then commits the Mac build's
lock file (pull before pushing again). Never delete the lock to do this: that
would re-resolve every crate to whatever is newest that day. With no lock
committed at all, the first branch build commits a fresh one the same way.

### If a Mac build crashes at launch

If a future Mac build quits immediately with a code-signature error, set
`"hardenedRuntime": false` under `bundle.macOS` in `tauri.conf.json` and
release again.

## Installing for the first time

The installers are not signed with a paid certificate, so each computer asks
once, at the first install. From 0.2.0, later versions install from inside
the app with none of these steps.

**Mac** (macOS 13 or newer):

1. Open the downloaded `.dmg` and drag TipTop Copilot into Applications.
2. Open TipTop Copilot from the Applications folder. The Mac says
   '"TipTop Copilot" Not Opened' and that Apple could not verify it is free of
   malware. That is expected for an app from outside the App Store: click
   **Done** (or **Cancel**), never Move to Trash.
3. Within an hour, open **System Settings → Privacy & Security**, scroll down,
   click **Open Anyway** and enter your Mac password.

If the Mac instead says the app "is damaged", run this once in Terminal, then
open the app again:

```sh
xattr -dr com.apple.quarantine "/Applications/TipTop Copilot.app"
```

**Windows** (10 or 11):

1. Open `TipTop-Copilot-windows-setup.exe`. If the browser warns about the
   download, keep it (in Edge: **Keep**, then **Show more**, **Keep anyway**).
2. If a blue box says "Windows protected your PC", click **More info**, then
   **Run anyway**.
3. It installs for the current user in a few seconds (no administrator
   password) and opens. Find it later in the Start menu.

The first time, the app opens the web browser to sign in with Google. After
that it stays signed in.

## How updates work

The app always shows the latest Copilot, so most changes need no new app
version at all. When `desktop/` changes and a new version is released, apps
from 0.2.0 on install it themselves:

- **When it looks.** About 15 seconds after launch, then every 6 hours (by
  the clock, so a laptop that slept catches up soon after waking), and after
  a check that failed, again in about 30 minutes. Check for Updates… (File
  menu on Windows; TipTop Copilot menu on a Mac, after About) looks at once;
  the item reads "Checking for Updates…" while it does. A development build
  never looks by itself.
- **What it asks.** `https://copilot.tiptop.vc/api/desktop/update/<os>/<arch>/<version>`.
  Copilot answers from the newest release's `latest.json`: nothing (204)
  when the app is up to date, else the new version, its signature and a link
  to `/api/desktop/update-file/<platform>/<version>`, which streams that
  file from the release. The link carries the version and answers only
  while that version is the newest release. Both routes are public (the app
  has no session) and rate-limited.
- **What it trusts.** Nothing but the signature. Every download is checked
  against the public key built into the app (`plugins.updater.pubkey` in
  `tauri.conf.json`), and against the version it was signed for, before
  anything is installed. A file that fails is thrown away.
- **What the person sees.** Nothing while it downloads. Then one question:
  "TipTop Copilot X.Y.Z is ready", with **Later** (the default, so Enter
  never restarts by accident) and **Restart now**. Later asks again at the
  next check. Restart now takes about 10 to 20 seconds: Windows shows the
  installer's progress bar and reopens the app; a Mac swaps the app in
  Applications and reopens it. A manual check also says when the app is up
  to date, or when the check or the download failed.
- **No going back.** An app only installs a version newer than its own, so
  a bad release is fixed by releasing a newer one. A release that is
  withdrawn before an app installed it is dropped at that app's next check.
- **Mac: run it from Applications.** A copy opened straight from the disk
  image, or still in Downloads, runs from a read-only place and cannot
  replace itself. It says so once per launch (and at every Check for
  Updates…) and asks to be dragged into Applications. A copy on any other
  writable disk updates normally.
- **0.1.0 has no updater.** People on 0.1.0 download 0.2.0 once from
  `/download` and install it over the old copy (quit first: Mac ⌘Q;
  Windows: right-click the tray icon, then Quit). The Download page and
  Settings say so. After that it updates itself.

**First self-update: a canary.** After 0.2.0 is installed by hand, release
0.2.1 as a version-only change (`tauri.conf.json`, `Cargo.toml` and the
`Cargo.lock` root entry, nothing else; never delete the lock) and watch it
update on Windows first, then on a Mac (see the checklist), before anyone
relies on in-app updates.

## The update signing key

Updates are signed with a minisign key made with `tauri signer generate`. It
has no password. Its public half is `plugins.updater.pubkey` in
`tauri.conf.json`, and every installed app trusts only that key. The private
half lives in exactly two places: the `TAURI_SIGNING_PRIVATE_KEY` repository
secret, which only the tag-only `sign` job can read, and the owner's offline
copy. Keep a second offline backup somewhere else, and never commit the key
or paste it anywhere else. Set the secret straight from the key file, for
example `gh secret set TAURI_SIGNING_PRIVATE_KEY < <key file>`; the `sign`
job strips stray line breaks and spaces anyway.

- **If the key is lost,** installed apps can never update again. Make a new
  key, put its public half in `tauri.conf.json`, release, and everyone
  downloads that version once by hand.
- **If the key leaks,** release one version signed with the old key that
  carries a new public key, then sign everything after it with the new key.
- Anyone who can change the workflow on a branch could read the secret. For
  tighter custody, move it into a GitHub environment that only `desktop-v*`
  tags can use; branch builds never need it.

## Known limitations

- No phone alerts in the desktop app (app webviews can't receive Web Push).
  The Settings page says to turn them on from a phone.
- Connecting Google, or turning on sending, is done in a web browser; the
  desktop app says so where those buttons would be.
- No address bar or back button. Windows has WebView2's own Alt+← and Alt+→;
  a Mac has no back shortcut (the Go menu was removed in 0.2.0).
- On Windows the page gets every key before the menu bar does, so the menus'
  shortcuts work only where WebView2 handles the same keys itself (editing,
  reload, Alt+F4). Settings, Quit, Toggle Full Screen and the zoom items have
  no shortcut there (Ctrl+comma, Ctrl+Q, F11, Ctrl+0, Ctrl+= and Ctrl+- do
  nothing), and Alt or F10 may not open the menus while the page has focus;
  the mouse always works. The menus' Paste and Match Style and Force Reload
  items press those keys for the page.
- On a Mac the Window and Help menus went with the Go menu, so ⌘M no longer
  minimizes (use the yellow button). Zoom In is ⌘=, not ⌘+ (⇧⌘=).
- macOS adds its own AutoFill, Dictation and Emoji & Symbols items to the
  Edit menu.
- After about 15 idle minutes the server sleeps, so the first load can take up
  to a minute. The opening screen says so. If the connection drops while the
  app is open, reload (⌘R or F5).
- Timers in a hidden window can be slowed by the system, so keep the window
  open while a campaign is sending.
- A downloaded update waits in memory: after Later, quitting means the next
  launch downloads it again. Release notes are not shown.
- On a Mac, the "access your Downloads folder" question may come back after
  an update, because the app is only ad-hoc signed. A Mac user who is not an
  administrator is asked for an administrator's password to update.

## Checklist on a real Mac and PC

1. The Mac shows Open Anyway, not "damaged" (if damaged, use the `xattr`
   command above).
2. Sign-in through the browser works on both.
3. A Gmail link opens in the default browser.
4. CSV exports and attachments reach Downloads. On a Mac, Finder shows the
   file; note any "access your Downloads folder" prompt, and check
   `xattr -l` on a downloaded file lists `com.apple.quarantine`.
5. A PDF or image attachment, or "Open full briefing", opens a second window,
   and a half-written reply in the first window is still there. A Word, Excel
   or zip attachment downloads with no new window, and the reply is still
   there too.
6. Closing the main window hides it; the tray (Windows) or Dock (Mac) brings
   it back; opening the app again focuses the running one.
7. Size and position survive quitting and reopening.
8. The menus, on both (and in a second window, where they act on that
   window):
   - Every Edit item in a reply box: Undo, Redo, Cut, Copy, Paste, Paste and
     Match Style (formatting is dropped), Delete (removes the selection only)
     and Select All. The keys still work too: ⌘/Ctrl C, V, X, Z, A, Redo
     (⇧⌘Z / Ctrl+Y) and ⌥⇧⌘V / Ctrl+Shift+V.
   - Reload and Force Reload reload the page.
   - Actual Size, Zoom In and Zoom Out by menu (and ⌘0, ⌘= and ⌘- on a
     Mac): Actual Size returns to 100%, the zoom stays through Reload, and
     the main window's comes back after a restart. On Windows, Ctrl+=,
     Ctrl+wheel and pinch do not zoom.
   - Toggle Full Screen; on Windows the menu bar stays visible and the same
     item leaves full screen. Quitting while in full screen and reopening
     gives the normal window size.
   - Settings… opens Settings in the main window, bringing it back if hidden.
   - Close Window hides the main window and closes a second window; with the
     main window hidden, Reload and the zoom items do nothing. Quit quits.
   - Windows: the menu bar is dark in Windows dark mode, light otherwise.
   - Mac: About, Hide, Hide Others and Show All.
9. Starting offline shows "Can't reach TipTop Copilot", then recovers when
   the connection returns.
10. Links that redirect on the server stay in the app when they lead to
    Copilot, and open the browser when they lead elsewhere (a meeting link).
11. Campaign Cancel, Pause and Delete still ask for confirmation on a Mac.
12. The briefing's Save as PDF button works on a Mac (the Mac webview may
    ignore print requests).
13. Updates (with the 0.2.1 canary installed over 0.2.0):
    - The question appears about 15 seconds after launch, or at once from
      Check for Updates… (which reads "Checking for Updates…" meanwhile).
      Enter chooses Later.
    - Later, then quit and reopen: it asks again.
    - Restart now on Windows: a progress bar, then the app reopens on 0.2.1
      with the window in the same place and one tray icon.
    - Restart now on a Mac: it reopens on 0.2.1 with no Open Anyway step,
      and `xattr -l "/Applications/TipTop Copilot.app"` lists no
      `com.apple.quarantine`. Note any "prevented from modifying apps"
      notice (allow it under Privacy & Security → App Management) and any
      Downloads-folder prompt.
    - No SmartScreen prompt on Windows.
    - Settings shows 0.2.1, and Check for Updates… then says "You're up to
      date".
    - Opened straight from the disk image, a Mac copy says once that it
      must be moved to Applications.
