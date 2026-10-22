# Environment variables

Every variable the application reads, what happens without it, and how to
generate the ones that need generating.

The template is [.env.example](.env.example). Copy it to `.env.local`.

**Nothing here throws at import time.** A missing variable degrades the
capability that needs it and appears at `/diagnostics` with a plain statement of
what is absent. Start there when something is not working.

---

## Reading conventions

- Empty strings are treated as unset, not as a configured empty value.
- Booleans accept `1`, `true`, `yes`, `on` (case-insensitive); anything else is
  false.
- A numeric variable that will not parse falls back to its default rather than
  producing `NaN`.
- Only `NEXT_PUBLIC_*` variables reach the browser. No secret is ever given such
  a name, and a test enforces it.

---

## Demo mode

### `DEMO_MODE` · `NEXT_PUBLIC_DEMO_MODE`
Default `false`.

With this on, no credential is needed and no external call is made: a
file-backed store, a deterministic offline model and fixture mail and calendar
are used instead. Every screen works, and a persistent banner states that the
data is fictional.

**Must be false or unset in any deployment holding real data.** Demo mode has no
real authentication — anyone who reaches the deployment gets the workspace.

Set both. The unprefixed one drives server behaviour; the prefixed one exists so
build tooling can see the mode.

### `DEMO_DATA_DIR`
Default `.demo-data`. Where the demo store writes `store.json`. Relative paths
resolve from the repository root. Deleting the directory reseeds from fixtures.

---

## Core

### `APP_URL`
Default `http://localhost:3000`. The public origin. Used to build
`GOOGLE_REDIRECT_URI` when that is not set explicitly. `NEXT_PUBLIC_APP_URL` is
accepted as a fallback.

Get this wrong and OAuth fails with a redirect-URI mismatch.

### `SESSION_SECRET` — required before deploying
Signs the session cookie. At least 32 characters.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Without it outside demo mode, session signing throws — that is deliberate, since
an unsigned session cookie is worse than a hard failure. In demo mode an
ephemeral per-process key is substituted, so demo sessions drop on restart. Set
it even for a demo you want to survive a redeploy.

Rotating it signs everyone out. Nothing else is affected.

### `APP_ENCRYPTION_KEY` — required before connecting Google
Encrypts stored OAuth tokens with AES-256-GCM. Must decode to **exactly 32
bytes** of base64.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

A key of the wrong length is reported as `not_configured` at the boundary and
shown as missing at `/diagnostics`, rather than failing at the first token write.

**Rotating this invalidates every stored token.** Users reconnect Google. There
is no re-encryption path — a half-rotated token table is a worse failure than a
reconnect prompt. `key_version` is stored per record so a future rotation
strategy can be added without a migration.

---

## Supabase

Setup walkthrough: [SUPABASE_SETUP.md](SUPABASE_SETUP.md).

### `NEXT_PUBLIC_SUPABASE_URL` · `NEXT_PUBLIC_SUPABASE_ANON_KEY`
Project URL and anon key. Public by design — the anon key is protected by
row-level security, which is why RLS is enabled on every table without exception.

Without them, the app falls back to the demo store.

### `SUPABASE_SERVICE_ROLE_KEY`
**Server-only. Bypasses RLS.** Used for storage signing and scheduled jobs.

Never give it a `NEXT_PUBLIC_` name. Never expose it to a browser. If it leaks,
rotate it in the Supabase dashboard immediately; it grants full database access.

Without it, storage signing and cron endpoints are unavailable and the app uses
the demo store.

### `SUPABASE_STORAGE_BUCKET`
Default `deal-attachments`. The private bucket for attachments and uploaded
documents. Created by the migrations; override only if you renamed it.

---

## Anthropic

### `ANTHROPIC_API_KEY`
Without it, the deterministic offline model is used and every screen still
works — but the analysis is derived from fixture text, not real reasoning.

### `AI_MODEL_FAST`
Default `claude-haiku-4-5`. Classification, extraction and portfolio
classification.

### `AI_MODEL_DEEP`
Default `claude-opus-5-5` (Claude Opus 5.5, $4/$20 per million tokens; it was
`claude-opus-5` at $5/$25 before D-076). Analysis, daily outlook, chat, drafts
and comparison. Copilot Notes never uses it: its notes and meeting chat are
written by Arwin's Claude routine through the Ask bridge, at no cost (D-076).

Model ids come from here and nowhere else — never hard-coded at a call site. To
change a model, change the variable.

### `AI_EFFORT_DEEP`
Default `high`. One of `low`, `medium`, `high`, `xhigh`, `max`. An unrecognised
value falls back to `high`.

Only sent to models that support it. The fast tier never receives it —
`claude-haiku-4-5` rejects both `effort` and adaptive thinking with a 400.

---

## Google Workspace

Setup walkthrough: [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md).

### `AUTH_ALLOWED_EMAIL_DOMAINS` — set this before anyone else has the URL
Comma-separated email domains permitted to sign in, e.g. `tiptop.vc`. A leading
`@` and surrounding spaces are tolerated; matching is on the full domain, so
`nottiptop.vc` and `tiptop.vc.example.com` are both rejected.

Empty means no restriction. That is deliberate — a first deployment must not
lock out its own operator — but it is not a safe resting state. The
`on_auth_user_created` trigger in `20260101000700_storage_and_bootstrap.sql`
creates an organization with **owner** role for every new user, so an
unrestricted project gives a working workspace to anyone who completes Google
sign-in. Their data is isolated from yours by organization scoping, but the
login screen's promise that "access is limited to members of the TipTop
organization" is only true once this is set.

`/diagnostics` reports the unrestricted state as missing rather than ready.

The Updates tab does not rely on organization scoping — its Slack channels
belong to no organization — so it stays closed while this is empty.

### `GOOGLE_CLIENT_ID` · `GOOGLE_CLIENT_SECRET`
Optional. Without them, Inbox and Calendar run on fixtures and Settings says the
integration is not configured.

These are for the **Gmail and Calendar integration**, not for sign-in. Sign-in
is Supabase Auth's own Google provider, configured in the Supabase dashboard,
with the callback `${APP_URL}/api/auth/callback` registered as a redirect URL
there. The two flows can share one Google client, but they are separate
consents: one establishes who you are, the other what the app may read.

### `GOOGLE_REDIRECT_URI`
Defaults to `${APP_URL}/api/integrations/google/callback`. Set explicitly only
if it must differ. It has to match the Google console **exactly**, including
scheme and any trailing path — this is the single most common setup failure.

Scopes are fixed in code and read-only: `gmail.readonly`, `calendar.readonly`,
`userinfo.email`. There is no send scope and no configuration that can add one.

---

## Public web research

### `RESEARCH_PROVIDER`
Default `none`. One of `none`, `anthropic`, `custom`. An unrecognised value
becomes `none`.

Left at `none`, the product **says research is unavailable** rather than
answering from the model's recollection, and the Today page's market-signals
section states so plainly. That is deliberate: a recalled fact with no retrieval
date is worse than a stated gap.

### `RESEARCH_API_URL` · `RESEARCH_API_KEY`
Only for `RESEARCH_PROVIDER=custom`.

---

## Scheduled jobs

### `CRON_SECRET`
Bearer token required by `/api/cron/daily`. Unset, the endpoint rejects every
caller — the safe default for an endpoint that would otherwise let anyone
trigger a sync.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Phone alerts: `VAPID_PUBLIC_KEY` (optional) and the `VAPID_PRIVATE_KEY` GitHub secret

Phone alerts are Web Push. The app only decides what is due
(`/api/cron/push`, guarded by `CRON_SECRET`); the `push-alerts` GitHub
Actions workflow signs and sends them. So:

- **`VAPID_PRIVATE_KEY`** is a **GitHub repository secret**, never a Render
  variable. Until it is set the workflow logs a notice and sends nothing.
- **`VAPID_PUBLIC_KEY`** is built into `src/lib/services/push-alerts.ts`; set
  it on Render only to replace the key pair. Replacing it means every phone has
  to turn alerts on again.

Generate a new pair with `npx web-push generate-vapid-keys`.

### `GRANOLA_WEBHOOK_SECRET`

Token required by `/api/integrations/granola/webhook`, the endpoint external
senders POST Granola meeting notes to (`?token=` in the sender's URL). It also
authenticates `/api/integrations/granola/backfill`, which spends Granola API
quota and can walk years of history — so this is the **stronger** of the two
ingest credentials. Unset, neither endpoint accepts a token and nothing else in
the product is affected. Generate it the same way as `CRON_SECRET`.

### `GRANOLA_BRIDGE_TOKEN`

A second token accepted by the webhook endpoint **and by nothing else**. Give
this to any sender that only needs to file notes, and keep
`GRANOLA_WEBHOOK_SECRET` for callers that legitimately start backfills.

It exists because of where such a credential ends up living. The cloud routine
that carries Nick's private notes into the app keeps its token inside its own
prompt, and the routines API returns that prompt in full on `get`, on `run`,
and in run logs — so the value appears in a transcript every time anyone
touches the routine. Assume it is public. Holding it should let someone file a
junk meeting note, and nothing more.

Generate it the same way as `CRON_SECRET`, and give it a **different** value
from `GRANOLA_WEBHOOK_SECRET` — sharing one string between them rebuilds the
exact problem the split removes.

> **Paste the output, not the command.** In August 2026
> `GRANOLA_WEBHOOK_SECRET` was found in production holding the literal text
> `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
> — the generator line from this document, pasted verbatim instead of run. A
> secret that is published three times in a public repository is not a secret.
> Any value here beginning with `node -e` is a placeholder that never became
> one.

### `BRIEFING_BRIDGE_TOKEN`

Token required by `/api/integrations/briefing/webhook`, the endpoint the
Daily Overview (morning) and Daily Recap (afternoon) cloud routines POST to
once each finishes a run. The post replaces the Today page's briefing card —
there is one card per organization per kind, with no reset at midnight, and a
post for an earlier day is ignored. The routines' sandbox cannot reach this app
today, so in practice cards arrive via the Slack relay (`ASK_RELAY_SLACK_TOKEN`
below), not this endpoint, and the Settings readiness check for the briefing
card follows that token rather than this one.

Same reasoning as `GRANOLA_BRIDGE_TOKEN`: the sender is a cloud routine, and
the routines API returns a routine's prompt in full on `get`, on `run`, and
in run logs, so this value is assumed public the moment it is set. Holding it
lets someone put junk text on a briefing card until that kind's next routine
post, and nothing more — no other endpoint accepts it. A `date_key` later than
today is refused, so a junk post cannot pin a card for good. Anyone who can
post in the relay channel has the same reach. Generate it the same way as
`CRON_SECRET`. Unset, the endpoint refuses every post and the rest of Today
is unaffected.

### `PORTFOLIO_BRIDGE_TOKEN`

Token required by `/api/integrations/portfolio/webhook`, the endpoint the
watchers that notice a new investment POST to (the Schedule of Investments
sheet check and the closed-deal mailbox routine). It only adds: a company whose
name is already listed is never replaced, and the one thing a re-post can do to
it is fill a blank field (stage, website, description, sector, latest round, a
founder's role or email) or add a founder it does not have yet (an existing
value is never overwritten, an archived company is left completely alone). There is
no way to remove, archive or read anything with it. The payload has no slot for
valuations, cost, ownership or MOIC, by design.

Same reasoning as `BRIEFING_BRIDGE_TOKEN`: the sender lives in a routine's
prompt, so the value is assumed public. Generate it the same way as
`CRON_SECRET`. Unset, the endpoint refuses every post and the Portfolio page is
unaffected.

### `TASK_BRIDGE_TOKEN`

Token required by `/api/integrations/tasks/webhook`, the endpoint the watcher
that notices a follow-up worth tracking POSTs to (an unanswered ask with a
deadline, a promise made in a meeting or on Slack). It is add-only: a task
whose title already matches an existing task (open, snoozed, or already
completed) is skipped, and there is
no way to complete, edit or delete anything with it.

Same reasoning as `PORTFOLIO_BRIDGE_TOKEN`: the sender lives in a routine's
prompt, so the value is assumed public. Generate it the same way as
`CRON_SECRET`. Unset, the endpoint refuses every post and the Tasks page is
unaffected.

### `ASK_BRIDGE_TOKEN`

Token required by `/api/integrations/ask-bridge/webhook`. When set, every
question asked on the Ask page waits for an external Claude session (the
`ask-bridge-answerer` cloud routine, which has live Gmail/Calendar/Slack
access) instead of the in-app Anthropic call. Same "assumed public" reasoning
as `BRIEFING_BRIDGE_TOKEN`. The routine's prompt carries the same Ask Arwin
persona block as the in-app prompt (`ASK_ARWIN_PERSONA`, D-059), so answers
sound the same whichever path writes them.

### `AFFINITY_API_KEY`

Affinity's API key, for the daily Affinity sync that copies every list,
company, person and note from Affinity into the CRM until the subscription
is cancelled (`lib/services/affinity-sync.ts`). The daily GitHub workflow
calls `/api/cron/affinity-sync` (guarded by `CRON_SECRET`) in a loop each
morning; the owner can also press "Sync now" on Knowledge → Affinity import.

To set it: in Affinity, **Settings → Manage Apps (API) → generate a key**; in
Render, **tiptop-copilot → Environment → add `AFFINITY_API_KEY`**. Unset, the
sync reports itself not connected and does nothing; CSV exports can still be
imported by hand. The key is read only on the server and sent only to
api.affinity.co. Delete it once Affinity is cancelled.

A key Affinity refuses (revoked, or the subscription ended) stops the sync
cleanly: the cron route answers `done: true, stopped: true`, the daily job
ends green with one line saying so, and Knowledge → Affinity import shows
"Stopped". While stopped, each call makes one light request to ask whether
the key works again and writes nothing; a replaced key plus "Sync now"
carries the run on from where it stopped. The same key also powers the two
opt-in copies on the exit checklist (contacts on no list, open reminders as
tasks), which run only when the owner presses their button. The contacts copy
needs Affinity's "Export All" directory permissions on the key.

### `ASK_ROUTINE_FIRE_URL`, `ASK_ROUTINE_TOKEN`, `ASK_RELAY_SLACK_TOKEN`

Optional. Together they make the Ask bridge instant instead of polled. The
answering routine cannot reach this app (an organization egress policy blocks
it), and nothing else can tell it a question was asked, so without these it
runs on its own hourly timer and the GitHub relay carries data both ways.

- `ASK_ROUTINE_FIRE_URL` and `ASK_ROUTINE_TOKEN` — the routine's **API trigger**
  address and bearer token, copied from that routine's settings on claude.ai
  (the URL ends in `/fire`). `ask()` calls it the moment a question is saved,
  so the routine starts immediately. The token can only fire that one routine.
- `ASK_RELAY_SLACK_TOKEN` — a Slack bot token. Read-only. Needs
  `channels:history` for the relay channel and, for the Updates tab,
  `groups:history` plus the bot invited to #pef-dealflow, #openvc-dealflow, the
  referral dealflow channel (`C0BV1HS0CEL`) and #nick-update-digest. The Updates
  tab reads those four private channels live and shows per-channel setup steps
  until access works. It stays closed, with no Slack call, while
  `AUTH_ALLOWED_EMAIL_DOMAINS` is empty. The routine posts its `ASK_ANSWER_V1`
  message to the relay channel (default `C0C3JPW6PTJ`, override with
  `ASK_RELAY_CHANNEL_ID`); the Ask page reads that channel while an answer is
  pending and completes the message itself. The app posts nothing to Slack
  except the optional task snapshot (`TASK_SNAPSHOT_FEED`, below), which needs
  `chat:write` the token does not have yet. The Today page reads the same
  channel for the Daily Overview/Recap `BRIEFING_PAYLOAD_V1` messages, so
  without this token routine briefing cards never reach Today.

All three are best-effort. If any is missing or a call fails, the question is
still saved and the older path answers it later.

### `DEAL_RELAY_CHANNEL_ID`, `DEAL_RELAY_POSTER_IDS`

Optional. The deal-sorter cloud routine posts every deal it finds in Nick's
mailbox, calendar and the weekly feed reports to a **private** Slack channel,
`#deal-relay`, as `DEAL_UPSERT_V1` messages plus one `DEAL_SORTER_RUN_V1`
heartbeat per run. The Deals page reads it on view (throttled to once a
minute), an open Deals tab re-checks every 15 seconds, and the daily job reads
it as a backstop.

- `DEAL_RELAY_CHANNEL_ID` — defaults to `C0C40TVD4DP`, the private channel.
  There is deliberately no fallback to the public relay channel: deal names,
  founders and pass reasons stay out of a channel every member can read.
- `DEAL_RELAY_POSTER_IDS` — comma-separated Slack user IDs. When set, a
  message from anyone else is ignored. Unset, every poster is read; the
  channel is private, so its members are the only ones who can post. Set it
  in production to the one account the routine posts as.

Reading uses `ASK_RELAY_SLACK_TOKEN`, which for a private channel also needs
`groups:history`, and the Slack app must be a member of `#deal-relay`.
Without the token the Deals page says so, and nothing else is affected;
Portfolio companies are still listed under Invested either way. Deals the
pull creates get ids derived from their source, so two deployments reading
the same window collide rather than duplicate; keeping the token on one live
deployment is still the simpler setup (see [DECISIONS.md](DECISIONS.md) D-051).

### `TASK_RELAY_POSTER_IDS`, `TASK_REPLY_AUTOCLOSE`, `TASK_SNAPSHOT_FEED`

Optional; nothing needs setting on Render. The `task-closer` cloud routine
checks Nick's mailbox and calendar at 3pm Central and posts what it found done
to the private `#deal-relay` as `TASK_CLOSE_V1` messages, plus one
`TASK_CLOSER_RUN_V1` run record a day. The Tasks page, an open Tasks tab, the
Today page and the daily job read them and complete the matching task, unless
a person has touched it since the evidence (see
[DECISIONS.md](DECISIONS.md) D-052). Reading uses `ASK_RELAY_SLACK_TOKEN` and
`DEAL_RELAY_CHANNEL_ID`, like the Deals page.

- `TASK_RELAY_POSTER_IDS` — comma-separated Slack user IDs whose
  `TASK_CLOSE_V1`, `TASK_CLOSER_RUN_V1` and `TASK_ADD_V1` posts are read.
  Unset, it defaults in code to the one account the routines post as. It is
  never "anyone": a forged close would hide a real obligation.
- `TASK_REPLY_AUTOCLOSE` — the app's own check, once a day at or after 3pm
  Central, that closes an Inbox "Reply to …" task when a real reply (not a
  holding reply, a hand-off or a question back) went out in the same Gmail
  thread. On unless set to `off` (or `false`, `0`, `no`). It
  needs no Slack, and runs only while the connected Google account is Nick's
  mailbox; Diagnostics says when it skipped.
- `TASK_SNAPSHOT_FEED` — the `TASK_OPEN_V1` snapshot of open tasks the app
  posts to `#deal-relay` so the routine can close tasks a person made, by id.
  `auto` (the default) tries, and while the Slack app lacks `chat:write` fails
  quietly and retries every six hours; Diagnostics says "needs chat:write".
  Adding `chat:write` to the Slack app (and reinstalling it; if Slack issues a
  new token, update `ASK_RELAY_SLACK_TOKEN`) switches it on. `off` never posts.
  It posts when there is no snapshot, every 20 hours, and, when the list
  changed, between 1pm and 3pm Central at most every 30 minutes. Tasks
  involving a counterparty kept Nick-only are left out.

---

## Desktop app downloads and updates

The desktop app (`desktop/`) is built by `.github/workflows/desktop.yml`, which
publishes each version as a release with two installers under fixed names and,
from 0.2.0, the app's own update files and `latest.json`. `/download` shows the
newest one and `/api/desktop/download/<platform>` streams the installer through
this server, so a page never links anywhere else. The app's updater asks
`/api/desktop/update/<os>/<arch>/<version>` and downloads from
`/api/desktop/update-file/<platform>/<version>`, which streams the file the
same way. Both are public, since the updater has no session, and brake per
address. None of this needs a variable of its own. See
[DECISIONS.md](DECISIONS.md) D-054 and D-055.

### `DESKTOP_RELEASE_REPO`

Optional. Where the installers are published, as `owner/name`. Unset or
malformed, the code default is used.

### `DESKTOP_RELEASE_TOKEN` — recommended

Optional. Lets the server look up and fetch installers, update files and
`latest.json` with its own API quota instead of the shared anonymous one; read
access to releases is enough. Without it the lookup is often refused (the
anonymous quota is per outbound address, and the host shares those between
services). Downloads and updates still work then, by each file's fixed name,
but the page cannot show file sizes, and says a new version is out only when
it can read the version some other way.

A fine-grained token expires, a year after it is made at most. Note the date
and replace it before then: an expired token is refused, and downloads and
in-app updates can stop until a new one is set.

---

## Copilot Notes

Meeting transcripts and notes recorded by Copilot itself (D-076). Off until
`NOTES_ENABLED` is set; apply `20261024000000_copilot_notes.sql` first. Every
value here is set by a person on Render, never by an agent and never in the
repository. Speech-to-text needs no key and costs nothing: the recorder's
browser runs Whisper itself (models from huggingface.co, cached in the
browser). Demo mode needs none of these and runs no model.

### `NOTES_ENABLED`

`off` (unset: the feature is hidden and its routes answer 404), `beta` (on for
whoever turns on "Copilot Notes (beta)" in Settings) or `on` (everyone).

### `NOTES_SHARE_PEPPER`

32 or more random characters. Every share link's token is stored only as an
HMAC under it. Unset, notes cannot be shared by link. Changing it breaks every
existing link.

### `VOICEPRINT_ENC_KEY`

32 random bytes, base64, like `APP_ENCRYPTION_KEY` but a different value.
Seals voiceprints (speaker embeddings made in the recorder's browser;
biometric data) at rest. Unset, nobody can be enrolled; names come from the
mic, the on-device voice clustering, the calendar and taps.

### `MEETING_FOLLOWUP_FIRE_URL` · `MEETING_FOLLOWUP_FIRE_TOKEN`

The meeting-follow-up routine's API trigger, so the recap starts as soon as a
meeting's notes are ready. Unset, the routine's own schedule picks the meeting
up instead. Copilot POSTs `{"text":"copilot_meeting_id=<uuid>"}` with the token
as a Bearer header, once per meeting, for meetings the team can see only (the
routine reads them through the MCP meeting tools, docs/MCP.md). Never called in
demo mode.

### Arwin's notes and the meeting chat

No key of their own, and nothing paid: they use the Ask bridge's settings
above. `ASK_ROUTINE_FIRE_URL` and `ASK_ROUTINE_TOKEN` start the
`ask-bridge-answerer` routine with a meeting's notes request; `ASK_RELAY_SLACK_TOKEN`
reads its answer back; `ASK_BRIDGE_TOKEN` sends the meeting chat to it as an
Ask question. Without the trigger the request waits and the meeting keeps its
Quick notes; without the bridge the chat quotes the matching lines instead.
The routine's prompt sections are in [docs/NOTES_ROUTINE.md](docs/NOTES_ROUTINE.md).

### `NOTES_FIRE_MAX_CHARS`

Optional, default `60000` (kept between 8,000 and 400,000). The most characters
of a notes request sent to the routine. A longer meeting is condensed to fit:
a speaker's consecutive lines merged, fillers dropped, then the middle trimmed
with a marker saying how many lines were left out.

### `NOTES_RELAY_CHANNEL_ID`

Optional. The Slack channel the routine posts Arwin's notes to and the app
reads them from; it is sent to the routine with each request. Defaults to
`ASK_RELAY_CHANNEL_ID` (the Ask relay channel). Set it to a private channel so
meeting notes stay out of a channel every member can read; the Slack app then
needs `groups:history` and to be a member there.

---

## Ceilings

All optional, all defaulted. These are **environment ceilings**: per-organization
settings may lower them, never raise them.

| Variable | Default | Effect |
| --- | --- | --- |
| `MAX_EMAILS_PER_SYNC` | `250` | Messages fetched in one run. |
| `DEFAULT_LOOKBACK_DAYS` | `14` | How far back a sync reaches with no cursor. |
| `MAX_ATTACHMENTS_PER_ANALYSIS` | `5` | Attachments read per analysis. |
| `MAX_ATTACHMENT_BYTES` | `26214400` (25 MB) | Larger files are stored with a note, not extracted. |
| `MAX_ATTACHMENT_PAGES` | `80` | Extraction truncates and says so. |
| `MAX_DOCUMENT_CHARS` | `400000` | Characters kept from one document. |
| `MAX_AI_REQUESTS_PER_USER_PER_HOUR` | `120` | Per-user hourly ceiling. |
| `DAILY_AI_BUDGET_USD` | `25` | Per-organization daily spend. |
| `AUTO_ANALYZE_ENABLED` | `true` | Classify and extract as mail arrives. |
| `DEEP_AUTO_ANALYSIS` | `false` | Fetch full bodies during routine sync. |

The AI ceilings are enforced against persisted `ai_usage` rows, not in-process
counters, so they hold across serverless instances. Reaching one returns a typed
refusal naming what still works; stored analyses, search and every non-AI screen
keep functioning.

`DEEP_AUTO_ANALYSIS` is off by default because it materially increases what is
stored. With it off, a full body is fetched when you open a message or the
classifier judges it consequential — and never otherwise.

---

## Minimum sets

**Demo, no credentials:**
```
DEMO_MODE=true
NEXT_PUBLIC_DEMO_MODE=true
```

**Demo with stable sessions:** the two above plus `SESSION_SECRET`.

**Real, without Google:** `APP_URL`, `SESSION_SECRET`, `APP_ENCRYPTION_KEY`, the
three Supabase variables, `ANTHROPIC_API_KEY`.

**Everything:** add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`CRON_SECRET`.
