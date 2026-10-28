# TipTop Kraken: Meet names (Chrome extension)

Part of Kraken Notes (D-076, workstream 3, "v1 nice"). It lets Kraken suggest
real names for the voices in a Google Meet transcript, and posts the consent
notice in the Meet chat when you press its button.

## What it does

- **Names.** While Kraken records a meeting whose consent step was confirmed,
  and only if you switched "Send Meet names to Kraken" on in the popup, it
  reads who is in the call and who is speaking from the Meet tab and passes
  that to your Kraken tab. Kraken lines it up with the transcript's voices
  and offers the name in the "Who is this?" picker. It never overrides a name
  someone picked by hand.
- **Consent notice.** "Post the notice in the Meet chat" types Kraken's notice
  ("Hi all, I'm using TipTop Kraken to transcribe…") into the Meet chat and
  sends it. Only when you press the button; never on its own.

## Privacy

- Names go from the Meet tab to the Kraken tab on your computer. The
  extension sends nothing to any server, and Kraken keeps the timeline in the
  page (nothing is stored on the server from it in v1).
- Nothing is read while Kraken is not recording, while the consent step is
  not confirmed, or while the switch is off (it starts off).
- Permissions: `storage` only (the switch). It runs on `meet.google.com` and
  on Kraken's own pages (plus `localhost` for development), nowhere else. It
  never captures audio; the recorder in Kraken does that.

## Install (until it is published)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** and pick this `extension/meet` folder.
3. Pin it, open a Meet call, start a Kraken recording, and switch names on.

## Keeping it working

Google Meet's page is not a public API and changes without notice. Every
lookup lives in `roster-core.js` (`SELECTORS`), prefers accessibility
attributes (`aria-label`, `role`) over class names, and reports an empty list
rather than guessing when nothing matches. The speaking indicator is the most
fragile part; turning on Meet's captions gives a second source (the name on
the newest caption). **These selectors were written without a live Meet call
to test against: check them in a real call before relying on them**, and
update `SELECTORS` if names or speakers do not appear.

Files: `manifest.json` (MV3), `background.js` (relays between tabs, only when
allowed), `content-meet.js` (reads Meet), `content-copilot.js` (talks to the
Kraken page), `roster-core.js` (the reading logic, unit-tested in
`tests/unit/capture-meet-extension.test.ts`), `popup.*`.
