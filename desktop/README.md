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
- **Mac Go menu.** Back ⌘[, Forward ⌘], Today ⇧⌘H, Reload ⌘R. Windows has
  WebView2's own Alt+←, Alt+→ and F5.
- **Mac downloads.** Files are saved to Downloads and Finder opens with the
  file selected. Windows keeps WebView2's own download bar.

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
- **A tag `desktop-vX.Y.Z`** builds the same way and then publishes a release
  with the versioned installers plus `TipTop-Copilot-mac.dmg` and
  `TipTop-Copilot-windows-setup.exe`. The web app's `/download` page serves
  those two through our own domain, so people never visit GitHub.

The icons are generated during the build from `public/icon.svg`, so none are
committed. The Mac build runs `cargo test` on the navigation rules first.

## Releasing a new version

1. Set the same new `version` in **both** `src-tauri/tauri.conf.json` and
   `src-tauri/Cargo.toml`. The workflow stops if they differ.
2. Merge to `master`, with `src-tauri/Cargo.lock` committed (see below; a
   tag build stops without it).
3. Tag the merged commit and push the tag:
   ```sh
   git tag desktop-v0.1.0
   git push origin desktop-v0.1.0
   ```
4. Wait for the desktop workflow to finish. The release is published only if
   both installers built. The Download page shows the new version within
   about ten minutes.
5. People update by downloading again from `/download` and installing over
   the old copy (see "Updating" below).

Most changes need none of this: anything in the web app shows up in the
desktop app on its next page load. A new desktop version is only needed when
something in `desktop/` changes.

### Before the first release: Cargo.lock

A tag build refuses to run until `desktop/src-tauri/Cargo.lock` is committed,
so a release is always built from the exact crate versions that were tested.
The first successful branch build commits it for you: its `lock` job adds the
Mac build's lock file to the branch (pull before pushing again). From then on
every build passes `--locked`: a lock file that no longer matches `Cargo.toml`
fails the build instead of being quietly updated. After changing a dependency
in `Cargo.toml`, delete `src-tauri/Cargo.lock` in the same commit and the next
branch build commits a fresh one.

### If a Mac build crashes at launch

If a future Mac build quits immediately with a code-signature error, set
`"hardenedRuntime": false` under `bundle.macOS` in `tauri.conf.json` and
release again.

## Installing for the first time

The installers are not signed with a paid certificate, so each computer asks
once for every new version.

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

## Updating

The app always shows the latest Copilot, so most updates need nothing. When
the Download page shows a newer app version: quit the app first (Mac: ⌘Q;
Windows: right-click the tray icon, then Quit, because closing the window only
hides it), download again and install over the old copy. The Mac and Windows
security steps above come back once for each new version.

## Why there is no auto-updater

Tauri's updater only installs updates signed with a private key, which would
have to be created and stored as a CI secret, and a self-updating app that
isn't signed by Apple or Microsoft still triggers the same security warnings
on every update. Because the web content is live anyway, re-downloading for
the rare shell change is simpler.

## Known limitations

- No phone alerts in the desktop app (app webviews can't receive Web Push).
  The Settings page says to turn them on from a phone.
- Connecting Google, or turning on sending, is done in a web browser; the
  desktop app says so where those buttons would be.
- No address bar or back button: use the Go menu on a Mac and Alt+← on
  Windows.
- After about 15 idle minutes the server sleeps, so the first load can take up
  to a minute. The opening screen says so. If the connection drops while the
  app is open, reload (⌘R or F5).
- Timers in a hidden window can be slowed by the system, so keep the window
  open while a campaign is sending.

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
8. The Go menu (Mac) and Alt+← (Windows) go back.
9. Starting offline shows "Can't reach TipTop Copilot", then recovers when
   the connection returns.
10. Links that redirect on the server stay in the app when they lead to
    Copilot, and open the browser when they lead elsewhere (a meeting link).
11. Campaign Cancel, Pause and Delete still ask for confirmation on a Mac.
12. The briefing's Save as PDF button works on a Mac (the Mac webview may
    ignore print requests).
