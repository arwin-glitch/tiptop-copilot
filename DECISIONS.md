# DECISIONS

Material product and technical decisions, with reasoning. Newest first within
each section. These were made without asking, per the brief.

---

## Environment / workspace

### D-001 — Portable Node toolchain instead of a system install

**Context.** No Node.js runtime existed on the machine. The brief requires
installing dependencies, running tests and running a production build — none of
which is possible without one.

**Decision.** Extracted the official Node 24.19.0 LTS Windows x64 zip to
`E:\_toolchain\node-v24.19.0-win-x64\` and invoked it by absolute path.

**Why.** Additive and confined: no installer, no system PATH change, no registry
write, nothing outside the workspace drive. Deleting `E:\_toolchain` fully
reverses it.

**Consequence.** Every command in this repo's docs assumes Node is on PATH. If
it is not, prefix with:
`$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"`.

### D-002 — Application lives in `E:\tiptop-copilot`, not the drive root

The invocation directory is a personal drive root with ~200 unrelated files.
Initialising a repo there would be unmanageable and would sweep private files
into version control. The app is a self-contained subdirectory.

---

## Product

### D-010 — The default surface is a cockpit, not a chat box

Today is the landing page and is structured data with expandable sections. Chat
exists only where conversation is genuinely the right modality (Ask TipTop, and
a scoped "ask about this deal" affordance). There is no persistent chat input on
Today, Deals, Portfolio or Knowledge.

**Why.** Nick's stated pain is hunting across screens. A chat box on every screen
adds a hunt step; it does not remove one.

### D-011 — Answer-first response contract

Every AI surface returns a structured object whose first field is a one-line
direct answer, followed by evidence, then recommended actions. The UI renders in
that order and never inverts it. Enforced by the output schemas in
`src/lib/ai/schemas.ts`, not by prompt wording alone.

### D-012 — Five recommendation labels; `INVESTED` is not among them

The AI may emit `INSUFFICIENT_DATA | PASS | MONITOR | DIG_DEEPER | ADVANCE`.
The `invested` deal stage is reachable only through a human decision write
(`recordDecision` with `actor: 'human'`). The schema does not contain the value,
so it cannot be produced even by a jailbroken model.

**Amended 2026-09-23 (D-051), on Arwin's explicit decision that day.** Being in
the Portfolio tab also lists a company under Invested. The deal pull mirrors
each Portfolio company into an `invested` deal — creating one from the
Portfolio row, or moving a matching deal once — as a system move audited with
no user and the reason "in Portfolio tab". No `deal_decisions` row is written:
that table records people's decisions, and its actor is always human. The
model still cannot emit `invested`, and the deal-sorter routine still never
sets it.

### D-013 — Scores, completeness, evidence quality and confidence are four
independent numbers

Missing information reduces *completeness* and *confidence*; it does not score
zero on quality. A category with no evidence is recorded as `unscored` and
excluded from the normalised quality score, which is reported as
`earned / attempted` rather than `earned / 100`. This prevents "we know nothing,
therefore it's bad".

### D-014 — Hard red flags cap, they do not veto

An unresolved hard red flag caps the recommendation at `MONITOR` (or
`INSUFFICIENT_DATA` when completeness is also low) and is surfaced with its
source. It never silently rewrites the underlying score, so resolving the flag
restores the original recommendation without re-analysis.

### D-015 — No invented investment parameters

The seeded thesis contains only what TipTop states publicly. Check size,
ownership target, geography and traction thresholds ship **empty** with a
"not configured" state in the UI and are excluded from scoring until Nick sets
them. The scorer treats an unset criterion as `unscored`, never as a failure.

### D-016 — Corrections are additive, never destructive

`deal_facts` rows are append-only versions with `superseded_by`. A human
correction writes a new row with `source_type: 'human'` and links the original.
Both values are visible in the audit drawer forever.

---

## Technical

### D-020 — Two implementations behind every external boundary

`DataStore`, `AIProvider`, `EmailProvider`, `CalendarProvider`,
`ResearchProvider`, `StorageProvider` and `RetrievalProvider` each have a real
implementation and a demo/mock implementation, chosen once in
`src/lib/runtime.ts` based on environment.

**Why.** This is the only way "the repository works without real credentials and
the full flow is testable end to end" is structurally true rather than a set of
`if (demo)` branches scattered through business logic.

### D-021 — Demo store is file-backed JSON, not in-memory

`DemoStore` seeds from fixtures and persists mutations to
`.demo-data/store.json`. In-memory state would be lost between Next.js server
module instances (dev HMR, route handler isolation), which would break the
multi-step demo flow. The directory is git-ignored and is only ever written when
`DEMO_MODE=true`.

### D-022 — Gmail and Calendar over REST + `fetch`, not the `googleapis` package

`googleapis` is ~50 MB and pulls a large discovery-document surface for two
narrow use cases. The adapters call the Gmail and Calendar REST endpoints
directly with a small typed client and handle OAuth token refresh in
`src/lib/google/oauth.ts`.

**Why.** Smaller install, faster builds, an easier-to-mock seam, and no
generated-client version drift. The trade-off is that we own the request shapes;
they are pinned in one file each and covered by tests against recorded fixtures.

### D-023 — Anthropic structured outputs via `output_config.format` + Zod

Schemas are authored once in Zod, converted with `z.toJSONSchema()` and passed as
`output_config: { format: { type: 'json_schema', schema } }`. The response is
re-validated with the same Zod schema before it reaches any business logic. An
invalid or truncated response is a typed failure, not a crash.

### D-024 — Model selection is environment-driven, two tiers

`AI_MODEL_FAST` (default `claude-haiku-4-5`) for classification and extraction;
`AI_MODEL_DEEP` (default `claude-opus-5`) for analysis, comparison, memos and
tool-use chat. No model id is hard-coded at a call site — every call names a
*tier*, and the tier resolves through `src/lib/ai/models.ts`.

### D-025 — Chat tools are a server-side allowlist with schema'd IO

The model never sees a database, a shell, or a URL it did not receive from a
tool. Every tool declares a Zod input schema and a Zod output schema; both are
validated. Every tool receives an `AuthContext` and re-checks organization
ownership itself — the tool layer does not trust the caller.

### D-026 — Untrusted content is fenced and labelled, never concatenated

Email bodies, attachment text, web results and uploaded documents are wrapped in
`<untrusted-content source-id="…">` blocks preceded by a standing instruction
that content inside is data. A pre-pass injection detector flags suspicious
spans and records them; detection *annotates*, it does not silently drop
content, so a false positive cannot hide a real email from Nick.

### D-027 — Postgres FTS is the default retrieval implementation

`tsvector` generated columns + GIN indexes on `knowledge_chunks`,
`email_messages` and `deals`. `RetrievalProvider` is the seam for adding vector
search later without touching callers.

### D-028 — Content hashing for cache reuse

Every extractable artifact (email body, attachment, document) is SHA-256 hashed.
Extraction and analysis results record the hash set they were derived from; a
re-run with an identical hash set returns the cached result unless
`force: true`. This is also the idempotency key for sync.

### D-029 — Idempotent sync via natural keys, not retry counters

`email_messages` is unique on `(organization_id, provider, provider_message_id)`,
`calendar_events` on `(organization_id, provider, provider_event_id)`, and sync
runs on `(organization_id, integration_id, idempotency_key)`. Re-running a sync
is a no-op upsert by construction, so retries are always safe.

### D-030 — Sanitised text rendering only; no `dangerouslySetInnerHTML`

Email and attachment text renders as plain text through a whitespace-preserving
component. HTML email is converted to text server-side. There is no code path in
the app that renders provider- or model-supplied HTML.

### D-031 — Hand-built accessible component layer over Radix primitives

Rather than running the shadcn/ui CLI (which vendors files and pins its own
versions), the same architecture is implemented directly: Radix primitives for
behaviour, `class-variance-authority` for variants, Tailwind v4 for tokens. This
keeps the dependency list explicit and the components auditable.

### D-032 — `proxy.ts` (Next.js 16) for auth gating and security headers

Next.js 16 renamed `middleware` to `proxy` and removed edge-runtime support for
it. `src/proxy.ts` handles session presence checks and sets CSP, HSTS,
`X-Frame-Options`, `X-Content-Type-Options` and `Referrer-Policy`. Deep
authorization stays in the services, never in the proxy.

### D-033 — Rate limits are database-backed, with an in-process fast path

Limits are enforced in `ai_usage` / `rate_limit_buckets` so they survive across
serverless instances. A per-instance memory cache short-circuits obvious
rejections without a round trip. Demo mode uses the same code against the demo
store, so the limit tests exercise the real logic.

### D-034 — Timezone stored per user, all formatting via `Intl`

Default `America/Chicago`, configurable in Settings. No date library: every
render path goes through `src/lib/util/time.ts`, which wraps
`Intl.DateTimeFormat` with the user's zone. "Today" boundaries are computed in
the user's zone, not the server's.

### D-035 — Vitest (not Jest) and Playwright

Vitest for unit + integration: native ESM/TS, no transform config, and it shares
`tsconfig` paths with the app. Playwright for e2e against a demo-mode server.
The e2e suite starts the app itself via `webServer`.

### D-036 — `pdfjs-dist` for page-aware PDF text, with a graceful fallback

Page boundaries are required so claims can cite a page number. `pdfjs-dist`'s
legacy build is loaded dynamically inside the server-only extraction service. If
it fails to load or a PDF is image-only, extraction is recorded with
`confidence: 'low'` and `needs_review: true` rather than throwing — the deal
still opens, the attachment is flagged for manual review.

### D-037 — Anthropic web search is the default `ResearchProvider`

When `RESEARCH_PROVIDER=anthropic` and an API key is present, the
`web_search_20260209` server tool is used. `RESEARCH_PROVIDER=none` (the default)
disables research entirely and the app states that research is unavailable
rather than answering from model memory. A `CustomSearchProvider` adapter reads
`RESEARCH_API_URL` / `RESEARCH_API_KEY` for any other provider.

### D-038 — Attachments in a private bucket with short-lived signed URLs

Bucket `deal-attachments`, private, 15-minute signed URLs minted per request
after an authorization check. Filenames are normalised to a safe slug plus a
random suffix; the original filename is stored as metadata only. MIME type is
validated against a magic-byte sniff, not just the client-declared header.

---

## Verification pass (session 2)

### D-039 — `/login` forced dynamic, and why that class of bug is worth a decision

**Context.** `/login` reads `isDemoMode()` and `capabilityReport()` to decide
which sign-in path to offer. With no session cookie to read, it used no dynamic
API, so Next prerendered it at build time. A production build made without
`DEMO_MODE` therefore served "authentication is not configured" for ever — and
`npm run start:demo` could not get past it. The entire demo was unreachable.

**Decision.** `export const dynamic = 'force-dynamic'` on `/login`, with a
comment stating why. `/privacy` and `/offline` stay static: they read nothing.

**Why.** The general rule this establishes: **a page whose output depends on
runtime environment must declare itself dynamic, even when it uses no dynamic
API.** Reading `process.env` is not a signal Next can see. Every other
env-dependent page in the app already had the declaration; this one was missed
precisely because it has no session read to make the dependency obvious.

### D-040 — Rate limits fail towards the user, never into a server error

**Context.** `enterDemoAction` was capped at 20 entries per minute on a single
global key, and threw on trip. The e2e suite hit it, and so would a room of
people opening a shared demo link. The result was a bare "A server error
occurred" page with no explanation and no way forward.

**Decision.** The ceiling is 60/minute, and tripping it redirects to
`/login?busy=1`, where a notice explains the wait and states that nothing was
lost.

**Why.** Everywhere else in this codebase an expected failure travels as a typed
`Result` carrying `stillUsable`. A rate limit is the most expected failure there
is. Throwing was inconsistent with the whole error model, and it converted a
one-minute wait into something that looks like the product is broken.

### D-041 — The e2e suite resets the demo store and never reuses a server

**Context.** The demo store is file-backed and survives between runs, and the
server holds it in memory. Steps that assert a starting state — "this deal has
not been analysed yet" — passed on the first run and failed for ever after.

**Decision.** `tests/e2e/global-setup.ts` deletes `.demo-data/e2e` before the
run, and `reuseExistingServer: false`.

**Why.** An e2e suite whose purpose is reproducing the demo has to be
reproducible itself. The cost is one server start per run; the alternative is a
suite that quietly stops testing the interesting cases. Deleting the store file
is a complete reset because `DemoStore` reseeds from fixtures when the file is
missing.

### D-042 — `server-only` aliased in tests, with the boundary asserted separately

**Context.** The `server-only` package throws unless resolved under the
`react-server` condition, which only Next applies. Every service module imports
it, so no integration test could load one.

**Decision.** `vitest.config.mts` aliases `server-only` to a no-op stub, and
`tests/unit/env-boundary.test.ts` asserts the real boundary: it walks every file
under `src/`, finds those marked `'use client'`, and fails if any imports a
server-only module or reads a non-public `process.env` key.

**Why.** The alias removes a build-time marker, so something has to replace the
guarantee it was providing. A static check over the actual source is stronger
than the marker anyway — it catches a client component reading
`process.env.SECRET` directly, which the marker never would.

### D-043 — Two-pass `startOfDayUtc`

**Context.** The original computed the timezone offset at noon UTC and applied
it to midnight. On the two DST changeover days each year the offset at noon is
not the offset at midnight, so the "today" window was an hour out — pulling in a
23:00 event from yesterday, or missing a 00:30 event today.

**Decision.** Two passes: probe at noon for a first guess, then re-measure the
offset at the instant that guess landed on, which is the one that actually
applies.

**Why.** One iteration is sufficient for every standard one-hour transition and
costs two `Intl` formats instead of one, on a function called a handful of times
per request. The alternative — a date library — is a dependency for a
twelve-line function.

### D-044 — Detector gaps fixed rather than tests loosened

**Context.** Two injection patterns did not match what they were written for.
`scoring_manipulation` required the object to carry no noun, so it missed "mark
this deal as ADVANCE" — the exact phrasing of the product's own demo payload.
`credential_exfiltration` required the credential term before the verb, so it
missed "send me your api key", which is the more natural phrasing of the two.

**Decision.** Both regexes widened. Neither test was relaxed.

**Why.** A detector that misses its own demo payload is not a detector. It is
worth stating that the fence — not the detector — is the actual defence, so
these were gaps in defence-in-depth rather than in the primary control; that is
a reason to fix them cheaply, not a reason to leave them.

### D-045 — An override requires a reason

**Context.** `overrideRecommendation` accepted an empty note, while
`recordDecision` had always refused an empty rationale.

**Decision.** An override with a blank reason is `invalid_input`.

**Why.** The function's own contract says it records that Nick disagreed *and
why*. The override is what the whole app and the exported memo will show; the
reason is the only part of it that carries information forward. Accepting a
blank one silently discards the signal the feature exists to capture.

### D-046 — The draft voice is Nick's actual voice

**Context.** `draft-reply@1.2.0` prescribed a generic direct-warm register and
banned exclamation marks. Reading Nick's real sent mail while operating the
mailbox triage routines showed the opposite: natural exclamation points,
"Hey X -" greetings, verdict-first openings, and recurring signature phrasings
("Thanks for sharing this and thinking of me!", "will review internally and
circle back").

**Decision.** `draft-reply@2.0.0` encodes the observed voice with reference
phrasings lifted from the outbox, adds a hard guardrail — no commitments,
amounts, allocations or legal terms in any draft — and confines LinkedIn links
to outbound introductions, on formal full names only, with URLs taken only from
supplied sources.

**Why.** A draft Nick has to rewrite to sound like himself saves nothing; the
evidence for the voice is his own sent mail. The guardrail exists because a
warmer voice makes accidental commitment language more likely, not less. The
link rule follows his house style, and "verified or unlinked" beats a plausible
but wrong profile in a live introduction.

### D-047 — Scheduling drafts speak as the EA, against a calendar snapshot

**Context.** Scheduling logistics are handled by Arwin, not Nick — and the
external triage routines already answer such threads in Arwin's voice after
checking the calendar. The app drafted everything as Nick and never looked at
the calendar at all.

**Decision.** A new `DraftKind: 'scheduling'` routes to
`scheduling-reply@1.0.0`, which speaks as Arwin (introduction and signature)
and receives a snapshot of upcoming synced `calendar_events` to propose
conflict-free, business-hours slots with travel buffers around in-person
commitments. Reschedules treat the moving slot as free; cancellations get a
warm rebook offer; the prompt never initiates moving one of Nick's
commitments. The app stays read-only: the draft proposes, nothing writes to
the calendar, and the Google write-scope test keeps that true.

**Why.** The division of labour is deliberate: the routines act in the
mailbox; the app judges and drafts for copy-paste. Giving the app the same
scheduling intelligence without any new authority keeps one brain across both
surfaces. The snapshot comes from records rather than a live tool call so a
stale sync degrades to fewer, safer proposals instead of wrong ones.

### D-048 — Drafts answer factual asks from the sources, not with a deferral

**Context.** On 2026-08-28 the mailbox triage fleet replied to deal counsel's
request for TipTop's investment entity, signature block and notice info with
"I'll get you that shortly" — and Nick had to write the real answer himself,
although the information appears across roughly two hundred mailbox threads.
The commitment guardrail had been over-applied to routine deal-execution
admin: entity names and notice details are retrievable facts, not verdicts.
The fleet's six prompts were fixed the same day; the app's draft prompt still
carried the gap.

**Decision.** `draft-reply@2.1.0` adds an answer-with-facts rule directly
after the commitment guardrail: when the inbound asks for factual or
administrative information and the answer appears in the supplied sources, the
draft contains the actual answer — modeled on Nick's own fix (thanks →
"please find the requested info below:" → the facts) — with every fact listed
in `asserted_facts`. Deferral is reserved for facts genuinely absent from the
sources, and the draft then names exactly what is missing. The guardrail
itself is unchanged: no new commitments, amounts, allocations or legal
positions, and wire or banking details never appear in a draft even when the
sources contain them.

**Why.** A draft that punts on a question the thread already answers creates
work instead of removing it — the auto-responders this product replaces
answered, and Nick's own sent reply is the template. The canonical facts stay
out of the prompt text and in the sources: the repository is public, so
personal and entity data does not belong in a committed prompt, and grounding
stays honest — the draft can only assert what the supplied evidence shows,
which `asserted_facts` makes checkable before sending.

### D-049 — Briefing cards only move forward, and the Today page is their only reader

**Context.** On 2026-09-22 the Today page's afternoon card showed a Sep 21
recap hours after the Sep 22 one had posted. Four faults compounded. Next
memoizes identical GET fetches within one server render, and supabase-js goes
through that patched `fetch`, so the render that pulled a new card from Slack
then read back the rows from before the pull — and the pull's own
skip-unchanged check compared against those stale rows, so a kind with two
payloads in the window flipped between them on alternate pulls. The GitHub
`briefing-slack-sync` relay replayed every payload in the window newest-first
and the webhook wrote each one, so every run ended with each slot on its
oldest post. An open tab never refreshed itself. And a failed Slack read
locked the pull out for a full minute, while `posted_at` recorded ingest time
rather than when the routine posted.

**Decision.**

- `getStore()` gives the Supabase client a `fetch` wrapper that adds a fresh
  `AbortController` signal when the caller has none — the documented opt-out
  from memoization (`force-dynamic` and `cache: 'no-store'` do not disable it).
  `fetch` is looked up per call so Next's instrumentation still sees it.
- The Slack pull ingests one payload per kind: the latest `date_key` in the
  window, and within that day the newest in Slack's order, with the message
  `ts` as `posted_at`. A network fault or Slack 5xx retries after ten seconds;
  anything Slack answers (a good read, a refusal such as `not_in_channel`)
  waits the full minute, and a rate limit waits as long as `Retry-After` says.
- `ingestRoutineBriefing` never moves a slot to an earlier `date_key`, and a
  payload identical to the stored card is a no-op that leaves `posted_at`
  untouched. It does not order same-day posts by `posted_at`: a webhook post
  and every row written before this change carry an ingest time there, which
  is later than the Slack `ts` of the post that should replace them, so that
  comparison would keep a superseded card for the rest of the day. Same-day
  order is the pull's choice.
- The schema refuses a `date_key` that is not a real date or is later than
  today in UTC+14. With the forward-only rule, one far-future date — a
  mistyped year from a routine, a forged webhook post, any poster in the relay
  channel — would otherwise pin its slot until the row was fixed by hand.
- The GitHub relay is retired. The Today page is the only reader of
  `routine_briefings` and pulls on view, so a writer that runs with no viewer
  adds nothing, and it replayed every payload in the window. The webhook route
  stays for direct posts.
- An open Today tab polls `GET /api/briefings/current` (pull, then a
  fingerprint of kind, `date_key` and `posted_at` — never `updated_at`) every
  15 seconds while visible and on returning to the tab, and calls
  `router.refresh()` only when the fingerprint differs from the rendered one
  and no refresh for that fingerprint has been asked for yet — a pending
  refresh keeps the old fingerprint on the page, and each extra
  `router.refresh()` starts another full server render. Failed checks back off
  to at most five minutes, and a 401 stops the polling.

**Why.** Each fix closes one cause, and they are cheap together: the store
change is one wrapper, the guard is two comparisons, and the watcher sends a
fingerprint rather than the cards. With a tab open, a routine's card now
appears within about 75 seconds of posting (up to 60s of pull throttle plus
one 15s poll). The watcher never refreshes on a timer alone, because a Today
render also syncs the calendar and may generate an outlook. Known limit: the
briefing token is assumed public (see `BRIEFING_BRIDGE_TOKEN`), and a junk
post through it, or in the relay channel, shows until that kind's next
routine post — about a day at most for one dated tomorrow, longer over a
weekend with no posts.

**Deploy.** Delete the `BRIEFING_SLACK_SYNC` repository variable (and the
`BRIEFING_WEBHOOK_URL` secret). The workflow file is gone from `master`, but a
push to `relay-kick` runs whatever workflow files the pushed commit carries,
and a routine pushing a commit from before this change would start the old
job, which fails on the deleted script. Removing the variable is what keeps
it from running.

### D-050 — The Updates tab reads the private channels live; nothing is copied or stored

**Context.** Four cloud routines post every week to four private Slack
channels: three dealflow reports (Fridays) and the Nick Update Digest (Monday
and Friday runs, plus month-start and month-end, each run a parent message
with one threaded reply per update). The reports are long — up to about 8,500
characters in one message, and about 50,000 across one digest thread — and
some are marked confidential or investors-only. The app's Slack token already
reads the public relay channel for Ask answers and the Today briefing cards.

**Decision.**

- The Updates tab reads the four channels directly with the existing
  read-only bot token (`conversations.history`, plus `conversations.replies`
  for threads). No routine changes, no posting to Slack, no copies in the
  relay channel, and no table or migration.
- The sources are a hardcoded list of channel IDs, like the relay channel's.
  One channel's name is a private person's name, so the repository labels it
  "Referral partner" and reaches it by ID; the report's own heading, read at
  runtime, identifies it on screen.
- A per-instance in-memory cache: five minutes for a good read, one minute
  after a refusal, while a thread may still be posting or when a thread could
  not be read. The last good copy (up to a day) is served only while Slack
  fails to answer (unreachable, rate-limited, an unknown error); when access
  is withdrawn — bot removed, token revoked, scope dropped — everything kept
  from that channel is dropped at once. A forced refresh is floored at 20
  seconds per channel, never overrides `Retry-After` (a thread read's
  included), and is rate-limited per user. Thread replies are re-read when a
  parent's `latest_reply` changes, and at least every 30 minutes, since an
  edit changes neither `reply_count` nor `latest_reply`.
- Posts are classified by their structure, never by author: the routines post
  through the Claude connector as a human member's own account, so neither
  the user nor `bot_id` tells a report from a person's message.
- Slack mrkdwn becomes React elements through a whitelist; link schemes are
  limited to `https`, `http` and `mailto`, and every link opens with
  `rel="noreferrer"`.
- Each source reports its access state, and the page names the exact fix per
  channel instead of showing an error or an empty page.
- The tab stays closed — no Slack call at all — while
  `AUTH_ALLOWED_EMAIL_DOMAINS` is empty outside demo mode.

**Why.** The relay channel is public: everyone in the workspace can read it,
so copying deal reports and investors-only digests there would publish them
workspace-wide. Slack is already where the routines write and is the record
Nick and the EA read, so a table would only be a second copy of confidential
text in the database, with its own retention and sync to maintain. Next's
caches were ruled out: `'use cache'` requires `cacheComponents`, which removes
the `dynamic` segment config used across the app; `unstable_cache` and fetch
caching persist to `.next/cache` on disk, would store Slack's HTTP-200
`ok:false` refusals as successes, and cannot serve the last good copy on
failure. A plain Map is the same pattern as the briefing pull.

**Consequence.** The bot needs the `groups:history` scope and an invite to
each channel; once invited, anything holding that token — this app, and the
GitHub workflows that use the same token — can read those channels. The
`on_auth_user_created` trigger gives every new account its own organisation
with the owner role, so there is no shared role to gate on and the sign-in
allowlist is the only boundary: every account on an allowed domain sees all
four channels, and with no allowlist the tab is closed rather than open to
any Google account. One of the dealflow channels was once deliberately kept
from one reader; revisit gating if the app gains users on an allowed domain
who should not see a channel. A read during the
minutes a digest thread is still posting shows a partial run, marked "Still
posting" and re-read after a minute. A report whose format drifts past the
parser still appears, as a generic collapsed card with a link to Slack.

### D-051 — Routine-sourced deals: ownership by equality, evidence-dated moves, and Portfolio under Invested

**Context.** /deals was empty in production: the only way a deal was created
was "Analyse as deal", which needs an AI key the deployment deliberately does
not have. A cloud routine (the deal-sorter) now reads Nick's mailbox, calendar
and the weekly deal-feed reports and posts every real
deal it finds, stage-sorted and fit-flagged, to a private Slack channel,
because its sandbox cannot reach the app. A person also changes stages by
hand, corrects facts, passes and invests, and the routine re-reads months of
history. Arwin decided on 2026-09-23: a private `#deal-relay` channel, every
deal listed (every feed deal included, fit-flagged), fit-unlikely routine
deals kept off Today, no migration, the channel ID committed as a code
default, and Portfolio companies under Invested automatically.

**Decision.**

- **Relay.** `DEAL_UPSERT_V1` and `DEAL_SORTER_RUN_V1` messages in
  `#deal-relay` (`C0C40TVD4DP`, overridable, never falling back to the public
  relay channel). Each deal is validated on its own with a schema that has no
  slot for emails, check sizes or terms; a website must be a plain hostname,
  emails in any free text are replaced, and amounts in the evidence, next step
  and pass reason. A bad optional field drops only that field; a bad key or
  name drops the deal, counted by path and message, never by content. The pull re-reads 30 days (5 pages of 200), is
  throttled per minute, retries a network fault or 5xx after 10 seconds,
  honours `Retry-After`, maps Slack refusals to setup states the page names,
  and never throws. It runs on viewing /deals (bounded at 8 seconds, then
  finished with `after()`), from an open tab's version watcher, and from the
  daily job, whose status is counts only because it lands in a public log.
- **No migration.** What the routine owns lives in one append-only
  `deal_facts` row per deal, `field = 'routine:state'`: its keys and aliases,
  its stage view with evidence and evidence date, the stage it last set and
  when, what it last wrote to each column, and a content hash. Nothing else
  reads that field. An unchanged window hashes the same, so a re-read writes
  nothing.
- **Folding.** Per company, the stage view with the latest *evidence date*
  wins, never simply the latest message, so a backfill phase that saw only
  older evidence cannot regress a deal. No date may be later than the day it
  was posted (an upcoming meeting is dated when it was seen). `new` is the
  routine saying it saw no signal, so it never displaces a real stage or
  clears a next step. Aliases, founders and threads are unioned; a retraction
  counts only as the newest word.
- **Matching** against every deal including archived: the routine's key, then
  website domain (free mail ignored), then normalized name, then aliases both
  ways — and a match of any kind whose domains differ is not a match, the key
  included (it is a slug of the name), so two companies sharing a name stay
  two deals. A live match anywhere in that order beats an archived one; an
  archived match with no live one is never resurrected. A company with no deal that matches the
  Portfolio tab is not created by the relay; the mirror covers it.
- **Ownership by equality.** A column is written only while it is blank or
  still equals what the routine last wrote; a correction or an extraction
  ends that for good. A stage is the routine's only while it equals the stage
  the routine last set and no person has recorded a stage change or decision
  since (or, for a deal it never staged, while it is `new` and untouched).
  Then: never to `new`, `reviewing` only from `new`, never out of
  `invested`, never *to* `invested` (wire evidence moves it no further than
  `ic_review` and shows "Record invest decision"), and otherwise only on
  evidence at least as new as the current stage's. A stage a person set only
  gets a "Suggests: X" beside it, with an Apply button that is the ordinary
  human stage change. The routine never writes `deal_decisions`.
- **Retraction** archives a deal only if the routine created it, still owns
  its stage, and nobody has decided, noted, tasked or restored it; otherwise it
  is a banner with a human "Not a deal" button. "Not a deal" and "Restore" are
  audited human actions.
- **Portfolio under Invested** (amends D-012). After the relay, every
  Portfolio company without a matching deal gets an `invested` deal filled from
  its row, and a matching deal at another stage is moved to `invested` once —
  audited `deal.stage_synced` with no user and the reason "in Portfolio tab",
  and no decision row. A deal it created or already moved is not moved
  again, nor is one a person has staged or decided since the company joined
  the Portfolio tab, so a person moving it back out is final.
- **One organization.** `#deal-relay` is one fund's mailbox, so it is folded
  into the deployment's only organization, and nowhere once there are two
  (the rule in `lib/db/tenancy.ts`). The mirror, which reads only that
  organization's own Portfolio tab, runs regardless.
- **Pages.** /deals lists everything with one query (paged past the API's
  1,000-row cap), filters stage and fit in memory, and fetches analyses in one
  query per hundred deals instead of one per deal; with no AI and no analyses
  it shows fit, source and last activity instead of empty score columns.
  Today hides routine deals flagged fit-unlikely and ranks "Awaiting a
  decision" by how far along each deal is.

**Why.** Equality is a lock that needs no schema: it cannot be forged by the
routine and it survives a failed audit write, while the audit check catches a
person moving A -> B -> A. Dating moves by evidence rather than by message
order is what makes six overlapping backfill phases and daily incremental runs
safe to replay in any order. The mirror is Arwin's call: the Portfolio tab is
already the confirmed record of what TipTop invested in, and asking a person
to re-confirm each one on /deals added nothing.

**Known limits.** There is no unique constraint on a deal's name, and the
in-process dedupe protects one instance only. New deals therefore get ids
derived from their source (the relay key and domain, or the Portfolio row),
so two instances racing on the same window collide on the primary key instead
of duplicating; one live deployment with the relay token (Render, not the
idle Vercel standby) is still the simpler setup. Deals matched only by name
can still be told apart wrongly when neither side has a website. The status
strip reflects the pulls on the instance that served the page.

### D-052 — Closing finished tasks automatically: a person always wins, and no migration

**Context.** Suggested follow-ups arrive from the `task-auto-suggest` routine,
and Inbox tasks are made from real email, but nothing closed a task once the
work was done: of the first ten suggested tasks, four were already done within
hours. Snoozed tasks also never came back, because every list read only
`status = 'open'`. Arwin decided on 2026-09-25: a separate `task-closer`
routine at 4pm Central clock time (4pm CDT now, 4pm CST after Nov 1) that may
close a snoozed task on evidence after the snooze; the app's own "Reply to"
check on by default; and the open-task snapshot built now but live only once
the Slack app has `chat:write`.

**Decision.**

- **Undo and the Snoozed tab.** Tasks has To do, Snoozed and Completed tabs,
  switched in the browser and kept in `?view=`. A snooze wakes when it is read
  (`snoozed_until` at or before now): the row stays `snoozed` and To do, Today,
  the daily brief, deal and portfolio pages all list it as open. The "Marked
  complete", "Snoozed" and "Back on To do" toasts carry an Undo, run by a host
  mounted once in the app layout, so its refresh is reported to the tab guard
  even though the row that showed the toast is gone. An Undo is an ordinary,
  audited person's change. The Tasks tabs switch on a click or an arrow key,
  never on focus alone: a toast hands focus back to the tab clicked before its
  Undo when it closes, and that must not switch the tab.
- **Relay.** The routine cannot reach the app, so it posts `TASK_CLOSE_V1`
  (up to 20 closes a message) and one `TASK_CLOSER_RUN_V1` per Central date
  to the private #deal-relay, not the public relay channel, where anyone could
  forge a close and mailbox evidence would be exposed. The app reads 14 days
  (5 pages of 200), only from `TASK_RELAY_POSTER_IDS` (default: the one
  account the routines post as; never "anyone"), never a message with a
  subtype, oldest first, with the first line exactly the marker. The preview
  markers `TASK_CLOSE_PREVIEW_V1` and `TASK_CLOSER_PREVIEW_RUN_V1` are never
  applied. Each close is validated on its own; a bad one is counted and
  dropped. `TASK_ADD_V1` is now read from the same poster list only.
- **Matching.** By `task_id` when that task exists and its title agrees,
  as stored or as the snapshot showed it (clipped to 200 characters,
  backticks as apostrophes), ignoring case, spacing and the `http://` Slack
  adds when it auto-links a domain (titles cannot be edited here, so a
  mismatch is a mistyped id); else by title among open or snoozed *suggested*
  tasks, only when exactly one matches. A task a person created closes by id
  or not at all.
- **A person wins.** A close applies only to an open or snoozed task, and only
  when its evidence time — the evidence, never later than the Slack post that
  carried it — is strictly after the latest person's `task.created` or
  `task.updated` audit row (for a task a person made with no such row, its
  creation). One comparison covers Reopen, Undo, snooze, unsnooze and tasks
  made by hand. A suggested task nobody touched also needs evidence no more
  than 7 days before it was posted (the suggester runs behind: one real proof
  predates its task by 6 minutes). The same evidence id is never applied to a
  task twice, and the task is re-read just before the write; both checks sit
  in the one write that the relay and the reply check share, so a Reopen
  whose audit row was lost still cannot be undone by the same evidence.
- **No migration.** A close is `status = complete` plus a `task.auto_completed`
  audit row with no user and the evidence in its metadata. The Completed tab
  reads those rows (dropping any that a person's later `task.updated`
  outranks) and shows "Closed automatically · email sent Sep 22", linked to
  the sent message in Gmail by `authuser=`, with the routine's one-line reason,
  above Reopen. The 4pm check and snapshot posts are recorded the same way
  (`task.autoclose_sweep`, `task.snapshot_posted`).
- **The app's own "Reply to" check** (`TASK_REPLY_AUTOCLOSE`, on unless set to
  off). Once per Central day, in the first pull at or after 16:00 Central,
  for open or snoozed Inbox tasks whose title starts "Reply to": closed when
  the same Gmail thread holds a message labelled `SENT` and not `DRAFT`, from
  the connected mailbox, to the original sender, sent after both the source
  message and the latest person's touch, and not the out-of-office
  auto-reply, a holding reply or hand-off ("flag", "on his radar", "passed it
  along", "looping in", "Arwin here", "he'll follow up", "away until", …) or a
  question back (a snippet ending in "?"). It reads Gmail's snippet and, when
  the body was fetched, the body above the quoted thread. It runs only when
  the connected Google account is Nick's mailbox; otherwise Diagnostics says
  so. A miss leaves the task open.
- **Snapshot feed.** So the routine can close tasks a person made, the app
  posts `TASK_OPEN_V1` (open and snoozed tasks with id, title, source, touch
  time, thread and sender, at most ten parts of 3,500 characters) to
  #deal-relay when there is none, every 20 hours, and, when the list changed,
  between 2pm and 4pm Central at most every 30 minutes. The routine reads it
  once, at 4pm, and each post is several messages in a channel that both
  readers page by message count, so posting on every change would crowd out
  the closes. The last post is also remembered in memory, so a lost audit row
  cannot make it post on every pull. The Slack app has read scopes only, so
  today every post answers `missing_scope`; the app waits six hours before
  trying again and Diagnostics says "needs chat:write". Adding the scope
  switches it on with no other change; `TASK_SNAPSHOT_FEED=off` stops it.
- **Where it is pulled.** `/tasks` (bounded at 8 seconds, then finished with
  `after()`), an open Tasks tab's version watcher (`/api/tasks/version`,
  a hash with no task content), after `/today` renders, and the daily job,
  whose status is counts only because it lands in a public log. The job now
  also runs at 22:30 UTC, so one afternoon run follows 4pm Central in both
  daylight and standard time; only the 11:00 UTC run generates the outlook.
  Concurrent pulls share one run; each step runs at most once a minute.
  Throttles, statuses and back-offs live on `globalThis`, because Next builds
  pages and route handlers as separate bundles with their own module copies.
  A muted line on To do says when the day's check ran and what it closed, or
  after 5:30pm Central that it has not reported.

**Why.** The audit trail already separates people (a user id) from machines
(none), and the deal pipeline already protects a person's stage the same way,
so "a person wins" needs no schema — and no hand-applied migration, the cause
of the Sep 15 outage. Comparing times rather than flags makes re-reading the
same window harmless and lets genuinely newer evidence close a task a person
reopened. Title matching is limited to suggested tasks because a person's own
titles repeat ("Reply to X"), while the suggester's are unique by
construction (ingest skips any title already present, in any status, across
every page of tasks — it used to stop at the API's first 1,000 rows).

**Known limits.** The status write is not conditional; the race window is
milliseconds in a single-user app. A Gmail sync that skips a message only
causes a missed close, never a wrong one. Anything done by phone, in person,
on LinkedIn or from Nick's personal mailbox never closes automatically.
Nothing involving a counterparty kept Nick-only by standing rule is checked by
the app or posted in the snapshot; the app knows them only by SHA-256 digests
of their name and domain words, so this public repository does not name them.
The reply check sees about 200 characters of a message whose body was never
fetched, so a holding line further down can still read as a reply; its phrase
list errs toward leaving tasks open. The AI tools' task list still reads open
tasks only (it runs only with an AI key). The status line reflects pulls on
the instance that served the page.

**Amended 2026-10-16, on Arwin's request that day.** The check moves an hour
earlier, to 3pm Central clock time (CDT or CST alike). The task-closer
routine is rescheduled to match outside this repository. In the app, the
"Reply to" check runs in the first pull at or after 15:00 Central, the
snapshot's change window is 1pm to 3pm Central, and the line on To do says
"Today's 3 PM Central auto-check hasn't reported yet" from 4:30pm Central.
The daily job's 21:30 and 22:30 UTC runs are unchanged: both still follow
3pm Central in daylight and standard time.

### D-053 — Today's "At a glance": every line is a task, labels live beside it, no migration

**Context.** Arwin asked on 2026-10-15 for a Today Nick can read in one
glance: what to do now, which intros he owes, and what is coming, as short
lines he can tick off, with no long scrolling. Top priorities is a relay post,
not tasks, so it cannot be ticked; Tasks due lists only the next 24 hours.

**Decision.**

- **Three cards from open tasks.** Do now, Intros owed and Coming up sit
  between the welcome-back card and Top priorities, four lines a card, the
  full count in the title and "+N more" to Tasks; the block is left out when
  all three are empty. Only open tasks, and snoozed ones that have woken,
  count. A tick is the ordinary "Marked complete" (`task.updated` with the
  person's id) with the same 8-second Undo run by the layout's task host, so
  the task-closer sees a later close for it as `not_open`. The count drops at
  once; the line strikes through and is held in place until its fold has
  played, because the server's answer to the tick already leaves it out.
  With the cards showing, Tasks due starts closed and shows the overdue count
  beside its title.
- **Buckets, in local days in the profile's timezone.** A person's card
  always wins. The routine's `intro` sticks; its `now` and `upcoming` are
  hints that a due date overrules (so Coming up becomes Do now when its date
  arrives). A title with an arrow (→, ->, " <> ", ↔), starting "intro",
  "introduce", "introduction" or "connect" (after an optional "make"/"send"
  and article), or "send … intros" is an intro, but never one with "intro
  call". Otherwise: undated, overdue or due within today+2 is Do now; today+3
  to +30 is Coming up; later is not shown. Do now runs overdue oldest first,
  then soonest due, then undated newest first; intros oldest owed first;
  Coming up soonest first.
- **Labels.** The task-suggest routine may send `short` (≤ 40 characters,
  ≤ 6 words, one line, no backticks), `bucket` and `due_precision` on each
  `TASK_ADD_V1` task; each is dropped on its own when malformed, so a bad
  label never costs the task. `due_at` now takes any offset, a bare date
  (09:00 Central that day) or a time with no offset (Central wall time), and
  is stored as UTC. On the Slack relay, where nobody sees a rejection and the
  same message is read every run, a payload that fails as a whole is kept
  task by task: a task failing only on `detail`, `due_at` or `urgent` loses
  that field, only a task with no usable title is left out, and the failure
  is logged. The JSON is read from the first "{" to the last "}", so a
  backtick inside a value no longer loses the message. The webhook stays
  strict: its caller gets the validation error. Without a label the app shortens the title deterministically (no
  model): a trailing "(…)" goes; "Intro A to B and C" is "A → B + C" in first
  names; "Reply to X …" is "X: reply"; a linked deal or portfolio company, or
  a portfolio name in the title, leads "Company: three words" without
  articles and generic verbs; otherwise the first five words and "…"; never
  over 40 characters. Arrows display as →; a week-level date reads
  "Oct 19 wk".
- **No migration.** Labels and cards are `task.glance_set` audit rows: no
  user for the routine's, the person's id for theirs, folded per field with
  the newest person's value first. They are not one of the task-closer's
  "person touched it" actions, so moving a task between cards never stops it
  closing itself. `setTaskGlanceAction` (rate-limited) writes a person's row;
  no screen offers it yet.
- **No label dedupe.** Only the title decides whether a task already exists
  ("never resurrect", unchanged). A label never does, even for an intro:
  labels are first names by design, so two different intros ("Chris Dalton
  to Sam Park", "Chris Okafor to Sam Lee") or the same pair introduced again
  months later share "Chris → Sam". Not reposting a pair under new wording is
  the routine prompt's rule; a duplicate that slips through costs one tick,
  while a dropped intro is a promise nobody sees.
- **The routine prompts** (task-auto-suggest and task-closer) gain the
  fields and rules above; the app accepts payloads with or without them.

**Why.** Every line being a real task means the tick, the Undo, the Completed
tab, the 4pm task-closer and "a person wins" all work unchanged, and the
audit trail already holds per-task routine and person state without a schema
change (the Sep 15 outage came from a hand-applied migration). Short labels
are the routine's job because it has read the thread; the shortener only has
to be predictable.

**Known limits.** The shortener knows company names only from linked deals
and the portfolio, so an unlinked deal's name is not recognised. An intro the
routine reposts under new wording shows twice until one is ticked. Day
boundaries follow the profile's timezone, not where Nick is travelling.

**Amended 2026-10-15, on Arwin's request that day.** Do now and Top
priorities on screen together read as two to-do lists. Top priorities now
leads Today, right after the welcome-back card and unchanged, and while it
holds today's list the glance row shows only Intros owed and Coming up
(`todayLead` decides `hideNow`, `todayGlanceCards` applies it; the buckets
themselves are unchanged). "Today's" is the profile's local day: an older list
(a routine that stopped posting, the weekend, Monday before the morning brief)
still shows, with its age, but Do now comes back beside it, because undated
tasks and those due in the next two days are listed nowhere else on Today.
With no list at all (the relay not set up, a failed read, an empty list) all
three cards show as before, so Today always has a live to-do list. The row is
left out when every card it would show is empty, and Tasks due starts open on
overdue tasks whenever Do now is not on the page. The 2-minute tour stops on
Top priorities, and on the glance cards (`grandStandIn`) when there is none.

### D-054 — The desktop app: a window onto the live site, signed in through the browser

**Context.** Asked for on 2026-10-17: a real downloadable Copilot for Mac
and Windows, "like Discord", at no cost: no Apple developer account, no
Windows signing certificate, nothing paid. It should never need a new build
for a web change.

**Decision.**

- **A Tauri shell with no bridge to the page.** *Narrowed by D-056: from
  0.3.0 the main window's top bar may move, minimise, maximise and close
  that window and open its menu.* `desktop/` opens one window
  that shows a small bundled page until https://copilot.tiptop.vc answers,
  then loads the live site, so every web deploy reaches the app at once. The
  remote page gets no native access: no capabilities, no commands, the
  opener plugin's link hook off. All native behaviour (which links open in
  the system browser, downloads, the tray, the Mac Go menu) is in the
  shell's own Rust. The shell marks its window with a read-only
  `__TIPTOP_DESKTOP__` global and a `tiptop_desktop` cookie, both its
  version; the web app uses them for layout only (hiding phone alerts and
  Google's consent links, which cannot work there), never to grant anything.
- **Sign-in through the system browser, with the code carried to the app.**
  Google refuses sign-in inside an app's window. The app asks
  `/api/auth/desktop/start` for a Google URL; the server starts Supabase's
  PKCE flow there, so the verifier lands in the app's own cookies, and binds
  the hand-off to the app with an httpOnly, path-scoped poll cookie. The shell
  opens the URL in the system browser, which lands on `/desktop/callback`.
  That page seals Google's code and only then mints a 4-character code and
  shows it; the person types it into the app (`/api/auth/desktop/verify`).
  Every code typed first takes one of three tries with a compare-and-set, and
  only a code holding a try is compared, so no burst of guesses from any
  number of addresses gets more than three looks; the third wrong code ends
  the hand-off, and a right one claims it once. Only then does the app
  exchange Google's code, exactly
  once (Supabase deletes the verifier even on failure), and re-check the
  allowed domains, as `/api/auth/callback` does.
- **Why the code goes from the browser to the app.** Anyone can start a
  hand-off, and whoever starts one sees everything the app is shown. A code
  shown in the app and confirmed in the browser would let a phisher mail the
  sign-in link, tell the victim the code, and collect the victim's session
  when they signed in. With the code first appearing in the victim's browser,
  the starter never has it unless the victim reads it out, which the page
  warns against. Accepted residual risk: a phisher who talks the victim into
  reading the code out in real time.
- **`desktop_handoffs` is scopeless.** A hand-off happens before anyone is
  signed in, so it belongs to no organization. `soleOrganizationId` would have
  broken desktop sign-in on any deployment with two organizations. Only hashes
  of the hand-off id and poll secret are stored; Google's code is sealed with
  `APP_ENCRYPTION_KEY` and cleared when claimed; rows are swept a day after
  they expire, by the start route.
- **Abuse brakes that cannot exhaust memory.** These routes are reached before
  sign-in, so their limiter keys are addresses an outsider chooses: IPv6 is
  keyed by /64; the start route looks at a global ceiling before creating a
  per-address entry, but charges it only for requests within their address's
  limit, so one caller cannot spend it for everyone; and the limiter now drops
  spent windows once it holds 5,000 keys.
- **Unsigned installers through our own domain.** CI (`desktop.yml`, standard
  runners) builds a universal Mac `.dmg`, ad-hoc
  signed so Apple Silicon runs it after a one-time Open Anyway, and a
  per-user Windows setup `.exe`. `/download` and
  `/api/desktop/download/<platform>` stream them through Copilot; no page
  links to where they are hosted. When the release lookup is refused, both
  downloads stay offered and go by the installers' fixed names.
- **No auto-updater.** *Superseded by D-055: from 0.2.0 the app updates
  itself.* One would need signing keys kept as secrets. The app
  shows the live site, so most changes need nothing; a new shell version
  means downloading it again from `/download`, which says when one is out.
- **window.confirm is gone.** The Mac window answers every confirm with
  Cancel and shows nothing, which would have made a campaign impossible to
  cancel from a Mac. The ten campaign confirms, including the leave-while-
  sending guard, now use the app's own dialog (`useConfirm`).

**Why.** Free, nothing to keep signed or renewed, and the web app stays the
only thing that changes week to week. The hand-off keeps the web flow's
guarantee that nobody but the person signing in can end up with their
session.

**Known limits.** No phone alerts in the desktop app (neither webview has a
push service; *from 0.4.0 the shell shows desktop alerts itself, D-057*);
connecting Google stays a browser task; each new shell version
repeats Open Anyway on a Mac and SmartScreen's Run anyway on Windows (until
0.2.0, D-055); the
first load after Render has idled can take up to a minute, which the bundled
page says.

### D-055 — The desktop app updates itself: signed updates through our own domain

**Context.** D-054 shipped the shell with no updater, so every new shell
version meant downloading it again and repeating the security steps. From
0.2.0 the app installs its own updates, still with nothing paid.

**Decision.**

- **Tauri's updater, driven from Rust only.** About 15 seconds after launch
  and every 6 hours (30 minutes after a check that failed) the shell asks
  `/api/desktop/update/<os>/<arch>/<version>`, downloads a newer version in
  the background and asks once whether to restart. Later is the default
  button, so an Enter meant for the page never restarts the app. Check for
  Updates… (the File menu on Windows, after About on a Mac) does the same and
  also says when nothing is new. The page still gets no command and no
  injected script.
- **Native dialogs from rfd, not tauri-plugin-dialog.** The dialog plugin adds
  a script to every page, copilot.tiptop.vc included, that replaces `alert`
  and `confirm` with calls the remote page may not make: `alert` would show
  nothing and `confirm` would always say yes. rfd is the engine that plugin
  uses, without the script.
- **Every update is signed, and checked twice.** Each file carries a minisign
  signature whose trusted comment names its version. The app checks it
  against the public key built into it, refuses a version other than the one
  announced (`requireSignedVersion`) and never downgrades. CI checks every
  signature against the same public key before anything is published, and
  publishes nothing if one fails.
- **One job sees the key.** The build jobs sign with a throwaway key made for
  that run, so no crate's build code ever sees the real one and a branch
  build's files are worthless as updates. A job that runs for release tags
  alone, the only place the `TAURI_SIGNING_PRIVATE_KEY` secret is read,
  re-signs the update files, verifies them and hands them to the release job,
  which writes `latest.json`. The key has no password; it lives in that
  secret and the owner's offline copies.
- **Two public routes on our own domain.** The updater is a plain HTTP client
  with no session, so `/api/desktop/update/...` and
  `/api/desktop/update-file/<platform>/<version>` are public, listed one by
  one in the proxy; `/api/desktop/download` stays signed in. The check reads
  the newest release's `latest.json`, requires its version to be the tag's
  and each signature to be made for that version, and answers for one
  platform with a URL it builds itself; the file's own URLs and notes are
  ignored. The file route streams only the version on offer, so a release
  that lands between a check and its download gives a 404 and a later check,
  never a file its signature does not match. Neither route names where
  releases are hosted, in a body, a header or an error.
- **Brakes.** Per address (IPv6 by /64, hashed): 30 checks and 10 file
  requests an hour. Ceilings for everyone: 1,200 checks and 30 files an
  hour, charged only by requests within their own address's limit. The file
  ceiling counts only files that will stream: a version not on offer is a
  404 from the cached manifest and spends only its caller's own limit. A
  file is tens of megabytes, so the low file ceiling caps what the routes
  can be made to stream. A manifest that cannot be read is a 503, never a
  204, so a manual check never says "up to date" when nobody looked.
- **Accepted:** the shell can be downloaded from these routes without signing
  in. It holds nothing but the site's address. A request carries the OS, CPU
  architecture and app version; nothing about the caller is stored, and the
  logs hold only the platform and versions of an update offered or served.

**Why.** A shell that cannot update itself leaves people on old versions, and
each new one costs a download and the security steps again. Signing keeps the
trust where it was: a compromise of the host, the routes or the release
storage can stop or delay updates, never install a build that did not come
through the release signing job.

**Known limits.** The 0.1.0 app has no updater, so its users download 0.2.0
once more; /download and Settings say so. If the signing key is lost,
installed apps can never update again, and a new key costs everyone one more
manual download; if it leaks, one release signed with the old key must carry
the new public key. Anyone who can change the workflow can reach the secret;
limiting it to a GitHub Environment for release tags is the next hardening
step. A Mac copy run from the disk image or from Downloads cannot replace
itself, and says so once per launch. The limiter is in-process, so it resets
on deploy. The ceilings can still be used up on purpose, by downloading the
real file from 3 addresses or checking from 40: updates then wait for the
next hour, the apps try again every 30 minutes, and the signatures are
untouched, so the worst outcome is a delay.

### D-056 — The desktop app's top bar is drawn by the web app

**Context.** Asked for on 2026-10-18: the desktop app's grey Windows title
bar and its File/Edit/View strip looked bolted on. The reference was Slack's
desktop app: one top bar that belongs to the sidebar under it, a menu button
at the top left that drops down File, Edit and View, Back and Forward,
search in the middle, and the window buttons on the right, with no separate
grey strip.

**Decision.**

- **Frameless on Windows, transparent on a Mac.** From desktop 0.3.0 the
  main window is undecorated on Windows (`decorations(false)`,
  `shadow(true)`): tao keeps the window's caption, system-menu and sizing
  styles, so Alt+F4, snapping, Win+arrows, resizing from every edge and the
  system shadow stay native, with rounded corners on Windows 11. On a Mac it
  keeps its frame with an overlay title bar, so the traffic lights sit in
  the page's bar and the menu bar stays at the top of the screen.
- **The web app draws the bar.** It has the real theme tokens, so the bar
  is the emerald of the sidebar and page-header band beneath it, in both
  themes, and follows a theme change at once; a separate local strip could
  not. It is rendered once in the root layout and shown only when the main
  window of a 0.3.0 or newer app sets `window.__TIPTOP_DESKTOP_FRAME__`
  (`windows` or `mac`). Older apps and second windows never set it, so there
  are never two bars, and in a browser nothing moves: every offset adds
  `--titlebar-h`, which is 0px there.
- **A native menu under ☰.** The File/Edit/View menu is built as before but
  set on no window on Windows (tauri then adds no menu bar); ☰, Alt and F10
  call `show_app_menu`, which opens it with `popup_menu_at` right under the
  button, but only when the person is asking for it, as Windows itself
  reports: a click on ☰ (the page tells the shell about the press as it
  happens, while Windows still reports a mouse button down with the pointer on
  ☰, and asks again on the click, which opens the menu if that press was
  within 1.5 seconds and the pointer is still on ☰), or Alt or F10 tapped on
  its own (the page asks as the key goes down; the shell waits for it to be
  let go and gives up if any other key or button joins it: Alt+←, AltGr,
  Alt+Tab). Like a native menu bar, ☰ is not a Tab stop; Alt or F10 is the
  keyboard's way. Windows draws it dark for the time it is open (uxtheme's
  SetPreferredAppMode, looked up by number as tao does, from Windows 10 1903),
  so it matches the always-dark bar; the tray menu and second windows keep
  following the system. Second windows each get a menu bar built for them
  alone: Windows destroys a window's menu bar with the window, and the popup's
  submenus are the same ones as the bar's, so sharing one menu would break ☰
  the first time an attachment window closed. Check for Updates… stays in ☰
  only.
- **A narrow bridge, not none.** Until now the live page had no IPC at all.
  One capability per platform, for window `main` only, covers
  `https://copilot.tiptop.vc:443/*` and the bundled fallback page. It grants
  Tauri's `start_dragging` and `internal_toggle_maximize` (its drag script
  needs them) and three app commands in `permissions/title-strip.toml`:
  `window_control` (minimise, maximise or restore, close, leave full
  screen), `window_frame` (maximised, full screen, zoom) and, on Windows,
  `show_app_menu`. The three act on the calling window only. No event
  listening (a page listening for close requests would make Tauri cancel
  them), no `*:default` set, no plugin. The port is written out for
  clarity: urlpattern reads a host with no port, or with :443, as exactly
  the standard port, and the shell never loads another port or a URL with a
  user name.
- **What an XSS on the site could add.** Minimise, maximise, hide or drag the
  main window, read its state, and drag or maximise an attachment window
  (Tauri's drag commands accept another window's name). It cannot open the
  menu by itself: a page can neither press a mouse button on ☰ nor tap Alt or
  F10. That matters because an open menu reads the next letters typed as
  picks, so a menu a script could open while someone types would turn E, then
  P, into Edit > Paste: a real paste, into a field the script chose, of
  whatever another app left on the clipboard, which the page could not
  otherwise read without a permission prompt. Once the person opens it, only
  they pick: the menu is modal, opens only for the window in front, only in
  the top-left corner where its first level holds just File, Edit and View,
  never twice at once and not within 300 ms of closing. It cannot open links
  or files, install updates, create windows or run script elsewhere. An XSS
  already holds the whole session, so this is nuisance, not escalation.
- **Rejected: no IPC, by navigating to special URLs.** A navigation the page
  starts runs `beforeunload` first, so on a campaign page (which warns
  before leaving) every minimise, close or menu click would ask "Leave
  site?". Opening special URLs in new windows instead depends on popup
  rules a keypress may not satisfy, any script could do it just as well,
  and a Mac still needs IPC to drag.
- **Always movable and closable.** The bundled fallback page has a plain bar
  of its own. Any live page in the main window that has not shown the ready
  bar 4 seconds in (a host error page, the cached offline page whose scripts
  are gone, a web deploy older than the app) gets a plain injected safety-net
  bar that drags and has the menu and window buttons, until the real one is
  ready. A real bar that is on screen but still waiting for its scripts gets
  until 3 seconds after the page has loaded (15 at most), so the plain bar
  does not flash over a slow start, and the plain bar steps aside the moment
  the real one says it is ready. Both drag with Tauri's script, not CSS, so
  they do not depend on WebView2's non-client regions; the real bar uses CSS
  `app-region` on Windows for native dragging, snapping and the window menu.
- **Overlay scrollbars on Windows.** The one visible change outside the bar:
  every window uses WebView2's thin overlay scrollbars, so the page's
  scrollbar never sits beside the close button or moves it. WebView2 needs
  one value for every webview on the app's data folder, so all windows get
  it.
- **Second windows stay native.** Attachments (the engine's PDF and image
  viewers) and the sandboxed briefing cannot draw a bar, so a frameless
  window there could not be moved or closed. They get no frame flag and no
  capability.
- **Slack's inset corners, drawn by the bar.** Two 10px corners hang from the
  bar at the page column's top corners (wide windows, app pages, not under the
  demo banner), in the band's emerald. At rest every app page's header band
  runs up behind the bar in that colour, so they cannot be seen; once the page
  scrolls up under the bar they round it off, so the bar and rail frame the
  page like Slack's panel instead of slicing across it. In a narrow window the
  bar takes the phone header's see-through emerald and blur, so the two stay
  one colour whatever scrolls under them; the gold line art at the top of the
  page fades in from under the bar rather than stopping on its edge; and
  search hangs just under the bar's Search field rather than mid-window.
- **Windows 10's caption style.** The page tells Windows 10 from 11 by the
  client hints (the user agent says "Windows NT 10.0" on both) and draws
  Windows 10's brighter close red and square maximise and restore glyphs
  there.

**Why.** It is what was asked for, and the bar matches the app exactly,
theme included, because it is the app. The bridge is the smallest that does
the job, scoped to one window and one origin, and each command checks its
own input.

**Known limits.** This narrows D-054's "no capabilities, no commands" to the
bridge above. Windows 11's Snap Layouts flyout does not appear over our
maximise button (Win+Z still works); when the window is not maximised the top
4 pixels of the bar resize it; Windows 10 shows its thin window border and
square corners. A tap of Alt or F10 quicker than the page's message to the
shell (a few milliseconds) is missed, and whether a finger or pen on ☰ counts
as a held button is untested. The dark ☰ menu relies on an undocumented
Windows call and falls back to the system's colours where it is missing. Where
the traffic lights sit on a Mac, and whether an old WebView2 drags with CSS,
can only be checked on real machines (desktop/README.md, checklist item 14).

### D-057 — Desktop alerts: the shell polls with a per-computer token

**Context.** Asked for on 2026-10-18: "since we have a computer app already
(mac/windows), can we be able to enable alerts there already?" Alerts were
Web Push to phones only (Settings › Preferences › Phone alerts), and neither
webview in the desktop app has a push service, so Settings told desktop users
to use a phone.

**Decision.**

- **The same alerts, per computer, off by default.** From desktop 0.4.0,
  Settings › Preferences in the app has Desktop alerts: the phone alerts'
  triggers, quiet hours and once-per-item rule, shown as Windows toasts and
  macOS notifications. Each computer is turned on by itself, like a phone.
  Alerts were built for Nick; anyone else turns them on for a computer only
  if they want them there.
- **The shell asks, not the page.** A hidden window's page cannot be relied
  on: built with the macOS 15 SDK, WebKit suspends a hidden page's web
  process outright; WebView2 throttles hidden timers to once a minute after
  five minutes and wry never tells it the window is hidden; and the window
  may not even be on the live site (the fallback page, the offline page,
  sign-in). The shell's process keeps running in the tray or the Dock, so it
  asks `/api/desktop/alerts` itself, about once a minute, and shows what is
  due. It also means there is no "notify" command: no page can make the
  shell show text of its own.
- **A per-computer token, minted through the signed-in page.** Enable asks
  the system for permission first (two commands, so nothing is minted when
  the person says no), then `POST /api/push/desktop` (session, same origin, 10
  an hour per person) answers `tcdsk_<org>_<device>_<43 random>` once; the
  page passes it straight to the shell's `alerts_turn_on`, which checks it
  names its own device, keeps it in its local app data (not roaming; 0600 on
  a Mac) and never returns it. Only its SHA-256 is stored, in an
  `audit_events` row (`push.desktop`) replaced on every turn-on: no
  migration. The shell does not borrow the window's cookies, whose refresh
  token Supabase rotates.
- **Worked out when asked, from cached inputs.** No outbox: each GET reads
  the phone job's inputs (meetings cached 50 seconds and everything else 5
  minutes per organization, so ten computers cost no more Calendar or Slack
  reads than one), then leaves out what that computer must not alert. In
  demo mode meetings come from the synced rows, so asking never reaches
  Google or marks the demo connection as needing a reconnect.
- **6am to 9pm, as phones get in practice.** The phone job runs only from
  6am to 9pm Central, so phones get meetings only then. Outside that window
  in the owner's timezone the endpoint works out nothing and tells the shell
  to come back at 6am, so Render's free plan can still sleep at night.
- **A ledger per computer.** `push.desktop_alerted` rows carry the device in
  metadata. A computer's "already sent" is its own ledger plus whatever the
  phones were alerted about before it was turned on, so turning one on never
  replays what has already pinged. Other computers' ledgers are left out:
  they are what those computers' tokens reported, and a token (or a made-up
  computer) must not be able to quiet alerts on another. After that, phones
  and computers each ping, as two phones would if each had its own ledger. The shell also keeps the keys
  it showed for three days, so a lost report never shows twice, and reports
  only notifications the system accepted.
- **Revoking.** Turn off; signing out in the app (unlike a phone, which keeps
  pinging after sign-out: the card says so); Settings' list of computers,
  from any device, for whoever turned one on or an admin; and leaving the
  organization, checked on every request. No expiry and no last-seen,
  matching phone subscriptions.
- **Clicks follow the page's own link rules.** The shell brings the main
  window forward and fires a `tiptop-desktop-open` event with the alert's
  in-app path; the page clicks a hidden link to it, so "Leave while sending?"
  still guards a campaign that is sending. A native navigation would skip
  `beforeunload` on a Mac and silently stop the send. The path is checked by
  the same rule on the server, in Rust and in the page (one leading `/`, no
  `\`, `#`, `:` or spaces, 300 characters at most).
- **No notification plugin.** tauri-plugin-notification replaces
  `window.Notification` on every page and cannot be told not to;
  mac-notification-sys swizzles the process's bundle id. The shell uses
  tauri-winrt-notification and mac-usernotifications (UNUserNotificationCenter)
  directly, and holds off App Nap while alerts are on, so a 6.5-minute
  meeting window is not slept through.
- **A second narrow bridge, under D-056's rules.** Five commands
  (`alerts_state`, `alerts_request_permission`, `alerts_turn_on`,
  `alerts_turn_off`, `alerts_test`; a sixth, `alerts_poll_soon`, from 0.4.1:
  D-058), for the live site in the main window only, not the fallback page;
  no event listening, no plugin, no `*:default`.
  This narrows D-054's "hiding phone alerts": the web app now hides the
  phone card in the app and shows the desktop one.

**Threat model.** A stolen token (from the disk or a process dump) reads that
organization's alert summaries, the text phones already show, and records
deliveries for that one computer: no Gmail, CRM, drafts or sending. It
travels over HTTPS to a fixed host with redirects refused, and is redacted
from logs. An XSS on the live page can turn this computer's alerts on or
off, which its session could already do, and show only the fixed test text;
it cannot read the token, write a notification's text through the shell, or
reach the fallback page or second windows, and a token for another device is
refused. The shell does take any token for its own device id, so an XSS
could mint one in an organization of its own (every new account gets one)
and hand it over: this computer would then show that organization's alerts,
and not its own, until Turn off, even after the XSS is fixed. Accepted: the
same script already holds the session, which reads and sends far more; the
shell cannot tell which organization the window is signed in to, and a
binding the page could undo with Turn off would add nothing.
Notification text comes only from the server over the bearer channel; a
click target is checked in Rust and again in the page, so a compromised
answer can at worst open an in-app page. Re-registering a colleague's
computer takes an admin, and only those who may turn a computer off are
sent its full id. Brakes: bad tokens per address (a malformed one never
reaches the database), then 20 requests a minute per organization and
computer charged only once its token checks out (device ids are not
secret, and the same id can be turned on in another organization), 10
turn-ons an hour per person, 5 computers per person and 20 per
organization, 300 ledger rows a day per computer. Only a refused token is
answered 401, always with the realm the shell checks before it forgets its
token; a store failure is 503.

**Why.** It is what was asked for, it works with the window hidden, and it
reuses the phone pipeline's rules without touching it.

**Known limits.** Alerts need the app running (it does not start at login).
Whether a Windows toast stays in Action Center without a COM activator, and
whether a click there reaches the app, are on-device checks; so is the Mac's
first-run prompt and a click on a notification more than 15 minutes old,
which only activates the app (a Dock click brings the window back). Focus
Assist and Do Not Disturb hold notifications back, as on phones. Release
order matters: publish `desktop-v0.4.0` before the web side reaches master
(desktop/README.md, checklist item 15).

### D-058 — Ask Arwin answers alert the asker's computers

**Context.** Asked for on 2026-10-19: "when arwin chatbot replies, it should
ping an alert to our pc as well". The Ask Arwin widget already showed a
3.5-second "Arwin replied" pop-up and a gold dot when an answer landed, but
only in a page that was watching that conversation, and a hidden window's
page cannot be relied on to run (D-057). In production answers arrive later,
through the Ask bridge, often while the person is in another app.

**Decision.**

- **A new kind of desktop alert, per person.** `ask:<answer id>`, worked out
  when the shell asks, like the rest (`lib/services/ask-reply-alerts.ts`).
  Only computers whose row was turned on by the thread's owner
  (`chat_threads.user_id`) get it: other members' computers get nothing, and
  neither do Nick's unless he asked. The organization comes from the token
  and membership is re-checked on every request, as in D-057.
- **One notification per ask, worded as the pop-up.** "Arwin replied", or
  "Arwin replied to N questions" when several land together; the newest
  answer's first line as plain text (Slack and Markdown removed, code fences
  skipped), 100 characters at most, else "You asked: <question>", else "The
  answer is ready to read." Never the full answer or markup. A click opens
  `/ask?thread=<id>` through the existing alert opener, so the widget opens
  the conversation (the Ask page, if that is where the person is).
- **Nothing old replays.** An answer counts when its thread was touched after
  the computer was turned on and in the last 10 minutes (the pop-up's own
  limit), and its row is at most 2 hours old. A thread's `updated_at` is the
  only "answered at" (a bridge answer keeps its row's `created_at`, the
  question's time), but every update to the row bumps it, including the
  `on delete set null` of a deleted deal, so the row's age keeps such a
  thread from replaying days-old answers. Times are compared as instants:
  Supabase writes `+00:00`, JavaScript `Z`.
- **Quiet while the person is looking.** Each alert carries
  `quietWhenFocused` (false for everything else). From 0.4.1 the shell counts
  such an alert as shown, without a notification, while the main window is
  shown, not minimised, in front (Windows: the foreground window, since a
  window whose WebView2 has focus does not report itself focused; a Mac: the
  key window) and on the live site; it is remembered and acknowledged like
  any other, so it never shows later. The shell then fires
  `tiptop-desktop-replied` with the alert's path, and the widget reads that
  conversation (owner-checked) and shows its own pop-up, so an answer to a
  question asked from a phone or a browser still gets a signal. A grouped
  alert names only its newest conversation, so the widget also reads the
  person's conversations answered in the last 10 minutes; an answer the
  full Ask page showed when it landed there is handed to the widget as seen,
  so neither announces it again.
- **Any hour, and sooner while waiting.** No quiet hours: the person just
  asked. While their own question has waited less than 30 minutes (the
  widget's watch limit), the GET first settles answers from the Slack relay
  (throttled process-wide, nothing without a relay token) and tells the
  shell to come back in 30 seconds, the soonest it takes, day or night. With
  the shell's 15-second tick an answer pings about 30 seconds after it lands,
  45 at most. Asked in the app, the widget also calls `alerts_poll_soon`, so
  the shell, asleep until 6am at night, asks within 30 seconds: a working
  day in another time zone can fall entirely inside Copilot's night.
- **Only to a shell that can stay quiet.** Ask alerts and the 30-second hint
  go only to a shell whose User-Agent is `TipTopCopilot/<v> desktop-alerts`
  with v at least 0.4.1 (`FIRST_ASK_ALERTS_VERSION`); a 0.4.0 shell would
  toast on top of the page's own pop-up. The User-Agent is a compatibility
  hint, never a permission: the token decides what is read. Settings
  promises Ask alerts only inside a 0.4.1 app, since an older one may wait
  days on the updater's Later. Either release order works.
- **Phones unchanged.** push-alerts.ts, the shared alerts summary and the
  phone ledger do not change. No migration.

**Threat model.** No new cross-user path: the only selector is the thread
owner equal to the device row's owner, inside the token's organization, and
a token works only in the shell with its own device id. Ledger rows hold an
answer id, never text, and logs stay counts-only. A stolen token now also
reads the first 100 characters of its owner's new Ask answers, for 10
minutes after each lands, and whether a question waits (a 30-second hint
instead of 60); it can pre-acknowledge `ask:` keys for its own computer
only, inside the unchanged 300-a-day cap, and is revoked the same ways. An
XSS on the live page can call `alerts_poll_soon`, at most one extra poll per
30 seconds and never during a failure backoff or a Retry-After, and fire
`tiptop-desktop-replied`, which only makes the widget read the signed-in
person's own conversations (the recent list and at most ten of them) and
show the pop-up it would show anyway; it cannot set a notification's text,
the flag or its click target. Answer text, which email content can shape
through the routine, is shown as plain text (WinRT toast text, a Mac's
notification strings), with control and bidi characters flattened in Rust;
the click target is built by the server from the thread id and checked by
the server, the shell and the page. Flooding: nothing older than 10 minutes
or the computer's turn-on, at most 10 threads read and one notification per
ask, a per-computer ledger plus the shell's three-day seen list. Load: two
asks a minute per computer, only while its owner's own question has waited
less than 30 minutes; an idle ask costs one indexed thread read. The
answer's first line can show on the lock screen and in Action Center or
Notification Center, the same class of text as phone alerts (D-057).
Alerts follow the thread's owner, so `ask()` now refuses a thread id that is
not the asker's own ("That conversation does not exist.", as the widget's
read already did): before, a member who knew a colleague's thread id could
add a question to it and have the answer, shaped by that question, pop up on
the colleague's computers, and keep them polling every 30 seconds while it
waited. Still pre-existing and out of scope: the full Ask page shows any
thread of the organization by its id.

**Why.** It is what was asked for, it reaches the person in another app or
with the window hidden, and it reuses D-057's token, ledger, limits and
click path rather than adding a second channel.

**Known limits.**

- At night (9pm to 6am in the owner's timezone, not the asker's) only the
  computer the question was asked from, in the app, wakes. The person's
  other computers, and questions asked in a browser or on a phone, ping in
  the day window only. An answer that takes more than 30 minutes at night
  never pings: the 30-second asks stop when the wait does, and by 6am it is
  over 10 minutes old.
- "Looking" is the main window in front on the live site, so there is no
  notification (the answer waits in the app) when that window is in front on
  another monitor, on an unlocked PC with the display off, or with nobody at
  the desk; a live page without the widget (sign-in) counts too. Whether a
  locked Windows session counts as in front is an on-device check.
- An answer read in the page just before the person switches away can still
  ping once (asks are up to 45 seconds apart), and after a notification the
  page's own pop-up may also show on return within 10 minutes. When an alert
  is held back, the widget's pop-up counts every answer of the last 10
  minutes it has not handled in that window, so it can also name one read
  on a phone or in a browser. A browser tab of Copilot on the same computer
  can pop up beside a notification: the shell cannot see the browser.
- On a shared computer, answers go to whoever turned its alerts on, even
  after someone else signs in, until alerts are turned off for it (Sign out
  in the app does that; a session that expires does not).
- An answer more than 2 hours after its question never alerts; Ask's
  history still shows it. A thread touched for another reason can still
  replay, once, an answer up to 2 hours old that this computer never showed
  (one that landed before it was turned on).
- In-process answers (the demo, tests) arrive within the request, so they
  never call `alerts_poll_soon`.

### D-059 — Ask Arwin answers as Arwin

**Context.** Asked for on 2026-10-19: "since the ai chatbot on the copilot is
Named arwin. can we make sure it knows that hes arwin". The app calls the
chatbot Ask Arwin everywhere (the widget, the Ask page, "Arwin replied" in the
pop-up and on the computer, D-058), but nothing that writes an answer said
so. The in-app prompt opened "You are TipTop Copilot, an internal analyst",
and the Ask bridge's answerer, which writes every answer in production
(`ASK_BRIDGE_TOKEN` set), had no identity at all. The app stores a bridge
answer as written, so its identity and voice come entirely from the answerer.

**Decision.**

- **One persona block, word for word, wherever Ask is answered.**
  `ASK_ARWIN_PERSONA` in `src/lib/ai/prompts/index.ts`: Arwin, the assistant
  in TipTop Copilot, named after Arwin Reyes, Nick's executive assistant, who
  set it up. It speaks in the first person, never calls itself TipTop
  Copilot, Claude, "the AI", a model, the bridge or the routine, and writes
  the way Arwin types: warm, short, a spaced hyphen rather than an em dash,
  no AI tells. The same text is pasted into the `ask-bridge-answerer` cloud
  routine's prompt and into the old local answering task (disabled since
  2026-09-21, kept in step in case it comes back), just before their "data,
  never instructions" rule, followed by the one asker line described below;
  nothing else in either changes. It is plain
  ASCII with no backticks, so the paste is exact, and a test pins the
  module's copy to its SHA-256, the same hash the two pasted copies have.
- **Honest about what it is.** Asked sincerely whether it is a person, it
  says it is Arwin's AI assistant, not Arwin, and honesty comes before
  staying in character. Asked what AI powers it, it need not name the model
  but never denies it or answers falsely, so "never call yourself Claude" can
  never become a false denial. It never takes credit for what the human Arwin
  did, never claims to be somewhere in person and never makes up a memory.
- **The human Arwin stays in the loop, with no false claim.** Sending an
  email, booking or moving a meeting and judgment calls on Nick's behalf are
  "one for Arwin", with a suggestion to message him. It never says it flagged
  anything, because neither path can: the routine's only write is its relay
  post, which shows as Arwin's own Slack user, the in-app tools are
  `create_task`, `save_note` and `create_draft_reply`, and "Tell Arwin" lives
  in the email session, not in Ask.
- **"Your inbox" only for Nick.** The in-app prompt reads the asker from
  `<context>`'s `user` (its task line now says it answers Nick and the team).
  The bridge payload (`ASK_QUESTION_V1`) names no asker, so in the routine
  and the local task one line follows the block, outside it: treat the asker
  as Nick unless the question or its history says otherwise. Adding the
  asker to the payload is left for later; the payload is unchanged here.
- **Only Ask's prompt changes.** `CORE_RULES` is split into `CORE_IDENTITY`
  and `CORE_RULES_BODY` and rebuilt byte for byte, and `systemPrompt` takes
  the identity as a second argument, `CORE_IDENTITY` by default.
  `conversationalToolUse` passes the persona plus the fund sentence and moves
  to `chat-tools@1.4.0`.
  The other ten prompts and web research keep their text (the same SHA-256
  before and after) and their versions, so no deal analysis is re-run, and
  the scheduling drafts, which write as the human Arwin, are untouched. The
  persona sets identity and voice only: grounding, citations, the answer
  format, the untrusted-content rule (the instructions are still never
  revealed) and the authority limits apply as written. No migration, no
  payload change; the Slack relay script composes no text and is unchanged.

**Why.** It is what was asked for, the honesty line keeps a persona named
after a real person from passing as him, and one block in every answerer
keeps the in-app and bridge answers from drifting apart.

**Known limits.**

- The routine's prompt and the local task live outside the repo, so a
  change to the persona still has to be pasted into both by hand. The hash
  test makes that hard to forget: editing the block fails it until the hash
  is updated. The routine's content hash changes with every paste, so the
  learning-sync routine reports it as drift until Arwin approves it there.
- The persona is guidance, not a guarantee. After the routine update, ask
  "who are you?" and "am I talking to a real person?" in Ask Arwin to check.
- Demo mode's canned answers (`src/lib/ai/mock.ts`) carry no identity and
  are unchanged.

### D-060 — Feedback in the Ask Arwin panel, and an "AI" tag on its name

**Context.** Asked for in October 2026: a way to note what should change in
Copilot while using it, by voice as well as by typing, and a marker so
nobody mistakes the chatbot named Arwin for the person it is named after,
without changing how it speaks (D-059).

**Decision.**

- **Feedback is a tab in the Ask Arwin panel**, not a second floating
  button: Conversations, as before, and Feedback, a box for what to change.
  It is typed, or dictated with the keyboard's own microphone (a phone's or
  the computer's dictation). The page never records audio: that would mean
  loosening the `microphone=()` Permissions-Policy (`src/proxy.ts`), storing
  audio and transcribing it, and the app has no AI key for that.
- **Each note carries its page**: the path and query of the page under the
  panel (never the fragment or the origin; anything that is not plainly an
  in-app path is kept as no page) and that page's name from its title
  (`lib/feedback/shared.ts`). Sending is open to anyone signed in, and
  revalidates nothing, like the widget's questions.
- **Read and closed on the full Ask page's Feedback tab**, `/ask?tab=feedback`,
  behind the same URL-synced subtab bar as the Records pages (`ASK_TABS`),
  so the conversation stays the bare URL every `/ask` link opens. Open and
  Done are two short lists, newest first; the open count sits on the tab.
  Marking a note done (or open again) takes the member role. The widget no
  longer catches a link to another tab of `/ask`: that is a page, not a
  question.
- **No schema change.** A note is an `audit_events` row (`feedback.note`),
  written directly so the words arrive as typed; done or open again appends
  `feedback.status`, newest wins. The email session's note button was looked
  at first: its notes are `email.session_answer` rows keyed by a Gmail
  message and read only for emails still in the session, so a note about the
  app has nowhere to sit there. The same pattern is reused under its own
  actions instead.
- **Desktop alerts, opt-in, per person.** Desktop alerts already reach one
  person's computers (D-058), so a note can ping the computers of whoever
  turned on "Desktop alerts for new feedback" on that tab
  (`feedback.alerts`, newest wins), never the sender's own, during the day
  only, once per note (`feedback:<id>` in the computer's ledger), opening
  the Feedback tab. No change to the desktop app. Phone alerts are left out:
  the phone job sends its alerts to every subscribed phone, with no
  per-person choice.
- **The "AI" tag.** A small gold "AI" beside the name in the panel's header,
  on the launcher (its name is "Ask Arwin (AI)"), on the full page's title
  and in the "Arwin replied" pop-up. A screen reader hears "Ask Arwin (AI)".
  A desktop notification has no room for a tag, so its title, built on the
  server, says "Arwin (AI) replied". The persona block and its pinned hash
  are untouched: the chatbot still calls itself Arwin.

**Known limits.** Notes are listed 200 at a time, newest first. Feedback
alerts need a desktop app with desktop alerts on, and someone to turn them
on. The Help tour of Ask Arwin mentions Feedback but cannot point inside the
panel, which a tour waits behind.

### D-061 — A feed watchdog: Diagnostics > Feeds, and feed notices you opt into

**Context.** The cards are filled by cloud routines that post to the Slack
relay channels and by scheduled jobs that call `/api/cron`. When one stops,
its card keeps the last copy it got, and only a small "checked 3d ago" says
so. It has happened quietly before: a relay channel archived under the
routines, a post Slack cut at its length cap, payloads a parser dropped
without a word. Nothing checked that the producers were still posting.

**Decision.**

- **A registry in code** (`lib/feeds/registry.ts`): every feed's name, what
  it fills, its schedule in plain words and the cadence it is held to (an
  interval and a grace period, optionally only on some weekdays or local
  hours, in a fixed timezone). Feeds that post only when there is something
  new (meeting recaps, scheduling drafts, task suggestions, new portfolio
  companies, meeting notes) are never late. Ask answers are on demand: late after a
  question has waited 15 minutes, stopped after an hour. The Reports
  channels are feeds too, late exactly when Reports calls them overdue.
- **Status** (`lib/feeds/status.ts`): running, late (one run missed past the
  grace), looks stopped (a second run missed), not seen, can't check, or off.
  Time counts only on a producer's active days and hours, so a weekday-only
  producer is not late on a Sunday and the alert sender is not late overnight.
  A part that cannot be read is "can't check", never "stopped".
- **Read from what exists** (`lib/services/feed-health.ts`): each relay
  channel's own history (the newest post its consumer can read, and any newer
  one it could not), the Reports channels' newest report, the Affinity sync's
  saved state, the newest meeting note written and the Ask questions still
  pending. The daily job and the
  alert sender leave no other trace, so their `/api/cron` routes now write one
  `feeds.heartbeat` row each in `audit_events`. No migration.
- **Diagnostics gets subtabs**: Setup (the old page, still the bare URL) and
  Feeds, worst first, in plain words.
- **Feed notices are opt-in, per person, for their own computers.** A
  `feeds.notify` row says who turned them on (`POST /api/feeds/notices`,
  signed in and same-origin; nobody can turn them on for someone else). Their
  computers with desktop alerts then get one notice a day per feed that looks
  stopped, 8am to 8pm, through the desktop alerts they already have, ledgered
  per computer like every other alert. Phones never get them, and nobody
  else's computer does. Off by default.
- **Cards say when they may be out of date**: beside its "checked" time, a
  card whose own run time is past its feed's stopped threshold adds "· may be
  out of date". The Today Top priorities card is left exactly as it is.

**Why.** The person who keeps the routines running needs to hear first, and
the phone alerts are for the mailbox owner, who should not get maintenance
noise. Desktop computers already belong to whoever turned them on (D-057), and
Ask answers already go to one person's computers only (D-058), so a notice can
be targeted the same way without a new channel or a new scope. Opting in,
rather than naming anyone in code, keeps the choice in the app.

**Known limits.**

- The cadences are copied from the routines' schedules, which live outside
  the repo: when a schedule moves, change the registry too.
- The relay channels are read 30 days back, at most 1,000 messages each; a
  feed silent for longer reads as not seen rather than stopped.
- The heartbeats start with this change: until each job's next run, the
  daily job and the alert sender read "No run noted yet".
- A feed that only posts when there is news cannot be told apart from one
  that stopped, so those are never late.
- The email queue posts only what changed, so it is given a day's grace.
- Notices need desktop alerts on (the desktop app from 0.4.0).

### D-062 — The Affinity exit checklist: the date is data, a refused key stops cleanly, copies are opt-in

**Context.** The workspace is leaving Affinity and needed one place for it:
the day Affinity needs notice by, what Copilot already holds, what the daily
sync deliberately leaves behind, the outside tools that still read from
Affinity, and a final archive. And once the key dies, the daily sync failed
every morning: `recoverFetch` answered a refused key with "retry", the step
reported it as a failure, and the GitHub job went red until someone deleted
the key.

**Decision.**

- **Where it lives.** Knowledge → Affinity import gains two chips: "Sync &
  import" (the bare tab, unchanged) and "Exit checklist" (`?view=exit`),
  which carries the countdown in its label. No new subtab and no long page.
- **Everything real is data.** The notice date, "Cancelled" and the list of
  outside tools are typed in on the page and kept as `audit_events` rows
  (`action = 'crm.affinity_exit'`, the whole settings in
  `metadata.settings`, newest wins, each change one row). No date, vendor or
  tool name is in the code. No migration: every read degrades to "nothing
  set", every count to "unknown".
- **Status rows are counted, not claimed.** Lists, companies, people and notes
  are counted from the CRM (`source = 'affinity'`); introductions from their
  sidecar rows, each counted once. The rows for what the sync does not copy
  say "not copied" with a count only where something can tell: the API gives
  no total for the directory, the reminder copy asks Affinity for the open
  count, and files stay "unknown" (the pinned API version cannot list them).
- **A refused key stops the sync.** A 401 anywhere, or a 403 on the list of
  lists, records `stopped` in the sync state and answers `done: true,
  stopped: true`. The run keeps its place. While stopped, each call makes one
  `GET /v2/lists?limit=1` and writes nothing if the key is still refused, so a
  stopped sync adds no rows and no errors; a key that works again resumes the
  run. The workflow prints one line and ends green.
- **Copies are opt-in, capped and keyed.** "Copy contacts on no list" pages
  `/v2/companies` then `/v2/persons` and adds only what Copilot lacks, by
  Affinity id (name, domain, emails; teammates never), up to 5,000 a press
  and never past 50,000 records in the workspace (about 1.2 KB a record with
  its indexes, so about 6 MB a press on a 500 MB free database). "Copy open
  reminders as tasks" makes one task per active or overdue reminder with an
  id derived from the reminder's, so a second copy adds nothing and a
  finished task is never brought back. Both are the owner's, run in bounded
  steps the page loops, and keep their progress (counts and a cursor only)
  in `audit_events` like the sync. Shapes are from Affinity's API reference
  for the pinned version 2024-01-01.
- **Today.** One quiet line below the glance cards, linking to the
  checklist, only in the last 14 days before the date and on the day, never
  once cancelled. Top priorities is untouched.

**Why.** The deadline matters and is the workspace's to set, so it is data;
a dead key is an expected end state, not an error; and the directory and
reminders are copied only on a person's say-so because the sync left them out
on purpose.

**Known limits.** The reminder count relies on Affinity's documented filter
syntax (`status=active|status=overdue`) and is best effort; the copy itself
filters in code. Files cannot be copied through the API version in use.

### D-063 — Writing to the CRM in Copilot while the Affinity sync still runs

**Context.** Affinity is cancelled before its renewal, and after that nothing
else adds people, companies, lists, columns or notes. Until then the daily
sync copies every Affinity list in again each morning by Affinity's ids and
deletes nothing, so a write made in Copilot has to survive it: a person added
here must not be duplicated when they also appear in Affinity, a column of
the team's own must not be taken over by an Affinity field of the same name,
and a row taken off a list must not come back the next day.

**Decision.**

- **Records are keyed the way the sync matches.** A new company is keyed on
  its domain, a person on their email (with neither, the name), stored with
  no external id. One already there is opened instead of copied, and the
  sync's existing adopt step takes a Copilot record over under Affinity's id.
- **Copilot columns carry `origin: 'copilot'`** on the list's `fields`. The
  sync's column plan and the field merge never match one, by name or by key,
  on a list that came from Affinity. No migration.
- **Removal writes a tombstone first** (`crm_entry_tombstones`, the one new
  table, `20261021000300_crm_writes.sql`). `upsertEntries`, which the sync
  and the CSV import share, skips rows matching a tombstone of the list.
  The tombstone holds the row, so Undo restores it with its id. Until the
  table exists, removing says to run the file and removes nothing; the sync
  reads no tombstones and carries on as before.
- **Affinity's notes stay read-only while the sync is on**, and say why;
  Copilot's notes can be edited and deleted.
- **Find & save is a Knowledge tab, not list-view filters.** "In <city>,
  in touch within N years" is matched on the record's place-like fields and
  the later of Affinity's dates and Copilot's own mail and calendar, which
  the database does not hold, so the search narrows in the database (name,
  place or list) and finishes in memory over at most 5,000 records.

**Known limits.** "Sync on" is read from `AFFINITY_API_KEY` (or the demo); a
stopped-but-configured sync still locks Affinity's notes. A list saved from a
view copies rows, not columns. Location matching reads single-word labels in
the database pre-filter (Location, City, Headquarters…).

### D-064 — Task basics, and money and legal tasks that close only on proof

**Context.** Tasks could not be edited, deleted, snoozed to a chosen day or
assigned (the snooze was fixed at three days and `tasks.assigned_to` had no
UI). Separately, money and legal items (a wire, a signature, a filing, an
invoice) had no home of their own: a one-shot push alert fired once, and a
task about one closed like any other, including automatically, on evidence
that did not prove the money moved or the document was signed. Both were
built together in one branch.

**Decision.**

- **Edit, delete, snooze until, assign**, from a "More actions" menu on each
  row on Tasks (To do, Snoozed, Money & legal) and on Today's "Tasks due"
  (Top priorities is untouched). Mark complete and the three-day snooze stay
  where they were. An edit is `task.edited`, a person's touch (added to the
  task-closer's touch actions), keeping the old title so the suggest routine
  does not re-add it. Delete sets `status = 'cancelled'` with the usual Undo
  toast: off every list and out of search, but the row stays, so a
  suggestion with the same title is never added again. A chosen snooze wakes
  at 9am, browser time, on the picked day, within a year. Assigning writes
  `assigned_to` (a member of the organization, or no one) plus
  `task.assigned`, which is not a touch: handing a task over says nothing
  about whether it is done. To do and Money & legal filter by person
  (`?who=`, in the browser, like the tabs). People are the organization's
  members by their own profile names; no name is in code.
- **Money & legal** is a fourth tab (`?view=money`, after Completed so the
  existing tab order holds). A task is on it when a person marked it from
  its menu (`task.money_legal_set`, newest wins), or else when its title or
  detail matches the plain keyword rules in `lib/tasks/money-legal.ts`
  (wire, capital call, distribution, K-1, tax forms, filing, signature or
  e-sign, SAFE, side letter, subscription docs, SPV, term sheet, invoice,
  payment, bank, contract, NDA, legal). The row says which rule matched.
  An open item quiet for seven days or more (by `updated_at`) is marked
  "Going stale"; a snoozed one is not, until it wakes. No mailbox is read:
  the routines' all-folder sweep still feeds tasks, and the tab only keeps
  them until really closed.
- **Closing needs proof.** Mark complete on a money or legal task opens a
  dialog for a web link (the confirmation email, a signed copy, a receipt)
  or which team member confirmed it, plus an optional note
  (`task.proof_recorded`, then the completion). The server refuses a plain
  completion with `proof_required`, so a page that does not know the task is
  money or legal (a deal page, Today's glance tick) opens the same dialog.
  Completed and the tab show what each was closed on; Undo reopens it and
  the old proof stops counting.
- **Automatic closes.** In the one write the task-closer and the reply check
  share, a money or legal task closes only on a close that states its
  proof: a reason and a sent email, whose reason then shows as the proof.
  Any other close (a booked meeting, no reason) leaves the task open and is
  kept as a `task.needs_proof` claim, once per evidence id. The tab lists
  those first, with "Close with proof" and "Not done"; "Not done" is a
  person's touch, so the same evidence never claims the task again.
- **No migration.** Everything new is an audit row beside the task, as in
  D-052 and D-053, so nothing waits on a database change and every read
  degrades to "no money or legal marks" rather than an error.

**Known limits.**

- The keyword rules will miss some items and catch a few that are not; the
  per-task toggle is the fix either way, and the rule list is short enough
  to read.
- "Going stale" counts any change to the row (an edit, a snooze, an
  assignment) as activity; a marked-only change (the toggle, a proof) is not.
- The task-closer's snapshot does not carry the money or legal flag yet, so
  the routine itself cannot tell; the app decides when the close arrives.

### D-065 — A proof check for tasks ticked by hand, and a company chip on tasks

**Context.** A tick took the person's word for it. Many tasks are only done
when something reaches someone (a reply, a document, feedback handed back,
an intro, a signature, a payment), and a task ticked but never sent simply
disappeared: the task-closer and the "Reply to" check only look at tasks
still open, and the suggester never adds a completed title back (D-052).
Separately, rows did not say which company a task was about ("Send the
data-room checklist (Brightkiln)"), although most tasks are linked to a deal
or a portfolio company already.

**Decision.**

- **Deliverables, by rule.** When a person completes a task
  (`writeTaskStatus`, every hand tick), `lib/tasks/proof.ts` decides from the
  title whether it is a deliverable: a verb (reply, send, share, forward,
  tell, review-and-return, intro, sign, pay) and a named recipient, or, for a
  reply made from an email, that email's sender. Conservative on purpose: a
  to-do like "Prepare LPAC agenda", "Review the Ridgeline agreement" or
  "Follow up with Dana" is never one, and neither is a call, an invite, a
  meeting, anything said to go by Slack, phone or in person, an idiom ("pay
  attention to", "sign up for", "connect with") or a Title Case noun where a
  name would be ("Send Monthly Update"). The tick then writes
  `task.proof_expected`, with the recipients as named and the end of a grace
  window of two business days (Monday to Friday in the ticker's time zone).
  Ticking a task that is already complete (a stale tab) is not a new
  completion: it keeps its time, its automatic close and its proof check.
- **One notion of proof.** A money or legal close already carries its proof
  (D-064), so it writes no expectation and is never flagged; an automatic
  close is not a hand tick. Whatever proves a tick is a `task.proof_seen`.
- **The app looks first.** The Tasks pull (`pullTaskRelays`, every view, the
  open-tab watcher and the daily job) runs the proof check at most every five
  minutes: a real send (the "Reply to" rule, now in
  `lib/tasks/real-reply.ts`) from the connected mailbox to a recipient after
  the task was created marks it seen. A reply is read as strictly as the
  "Reply to" check reads one; any other deliverable may end on a question or
  pass a document along, and an intro may loop someone in. Recipients are
  matched to addresses from the team, portfolio contacts, the network, CRM
  people and senders in the mailbox, or a company's domain; a first name two
  people share stays unmatched (a wrong "Seen sent" would hide a real miss)
  unless exactly one of them is at the company the task is linked to. Before
  flagging, the check also asks for sent mail to the task's own recipients,
  past the newest-500 scan. Nothing is judged with no mailbox connected,
  with a broken connection, or before the mailbox has synced past the end
  of the window: until then a missing email may only be unsynced. Only the
  mailbox owner's deliverables are flagged from it (the task's assignee, or
  whoever ticked an unassigned one): a teammate's goes out from their own
  mailbox, which the app cannot see. A send it does see still proves one.
- **Evidence is used once.** Evidence that proved an earlier completion of
  the same task, or an automatic close a person then reopened, never proves
  a later tick: the person reopening said that was not it. A task-closer
  post counts only if it was posted after the tick, so re-reading an old
  post every run can never prove a new one, and only evidence of a kind the
  deliverable lists (`proof`) counts: a payment confirmation proves a
  payment, not a reply.
- **The routine adds what the app cannot see.** Slack DMs and payment or
  signature notices come from the task-closer as `TASK_PROOF_V1` in
  #deal-relay, mirroring `TASK_CLOSE_V1`: the same channel and window, the
  same trusted posters, the first line exactly the marker, add-only and
  idempotent. A proof only marks a ticked task seen; it never closes,
  reopens or changes a task, and one for an open task is ignored. A
  `TASK_CLOSE_V1` for an already-ticked task is taken as its proof too. The
  open-task snapshot lists ticked tasks still waiting as `status: "ticked"`
  with what should have gone out, for the routine to look (inert until the
  Slack app has `chat:write`, like the rest of the snapshot). The prompt
  addition lives outside the repo and is applied by hand.
- **The app points; the person decides.** Past the window with nothing seen,
  the check writes `task.proof_missing` once: Completed shows a "Ticked, not
  seen sent" chip and why, and Today shows a small card (outside Top
  priorities, only when something is flagged), each with "It's done"
  (`task.proof_confirmed`, the flag goes for good) and "Reopen" (the task
  back on To do; a new tick starts a new window). Nothing is reopened or sent
  on its own, and a proof that turns up late still turns the flag into
  "Seen sent". Reopen is the only way back to open: the suggester's
  never-resurrect rule is unchanged.
- **The company chip** reads the existing links (`deal_id`, then
  `portfolio_company_id`); a CRM company, which has no column on a task, is a
  `task.company_set` row. The edit dialog searches portfolio companies, deals
  and CRM companies to choose one, or clears it. Not a touch.
- **No migration.** Everything new is an audit row beside the task, as in
  D-052, D-053 and D-064; every read degrades to "nothing to show".

**Known limits.**

- Any real email to the recipient after the task was made counts, whatever
  it says: the check proves something reached them, not that it was the
  deliverable.
- A recipient the app cannot match to an address can only be proved by the
  routine; until then it is flagged, and the row says no address was found.
- The rules read English titles and will miss some deliverables; a miss
  only means no check, which is how every task worked before.

### D-068 — Tasks belong to the principal: the person whose mailbox Copilot reads

**Context.** Copilot reads one person's mail, calendar and meetings, and the
tasks it finds there are that person's work. The code filed them under the
organization's `owner` role instead: every routine suggestion (task-ingest),
the fallback for keep-in-touch check-ins, and every copied Affinity reminder
when nobody pressed; a follow-up added by hand, a check-in and a copied
reminder went to whoever added, set or pressed. In a real team the owner is
whoever set the organization up, an assistant, say, not the person whose
mailbox it is. So on Tasks, Everyone and the owner showed the same rows and
the mailbox person showed "Nothing for …", and a money or legal close asked
for the owner's confirmation first.

**Decision.**

- **One rule, in `lib/tasks/principal.ts`:** the principal is (a) the member
  whose profile address is the address of the organization's mailbox, the
  oldest connected Google integration with the `gmail` kind; else (b) the
  member who connected that mailbox; else (c) the `owner` role member; else
  (d) the first member. Members are read oldest membership first, then by id,
  so no store order decides; addresses compare without case or spaces. The
  oldest mailbox, not the newest, so a second person connecting their own
  mailbox later never moves everyone's tasks. One read of members and
  profiles (the reads Tasks' people already made) and one of the Google
  integrations.
- **Who a task is for (`assigned_to`) is the principal** for a routine's
  suggestion, a follow-up added with no one chosen (the add dialog has no
  picker; Ask's `create_task` too), a keep-in-touch check-in and a copied
  Affinity reminder. Who made it (`created_by`) is unchanged: the owner for a
  routine's task (the table needs a real person), whoever added, set or
  pressed otherwise. A person's choice from the row's menu always stands.
  Check-ins used to go to whoever set the cadence; they go to the principal
  now, because the cadence is on a relationship of the person whose mail and
  calendar decide when it comes due, and an assistant sets it for them.
- **Tasks' people** carry a `principal` flag (the old `owner` flag is gone:
  it only ever meant "first in the list" and "asked to confirm first"). The
  principal is listed first, so the filter reads Everyone · principal ·
  everyone else by name, and a money or legal close defaults to the
  principal's confirmation. A row names its assignee only when that is not
  the principal; an unassigned row says "No one", as the menu does, so a row
  without a name is the principal's.
- **The proof check (D-065)** still holds the assignee responsible
  (`assigned_to ?? tickedBy`), and now knows the mailbox's owner by its
  address too (rules a and b), so the principal's deliverables are judged
  from their mailbox even when someone else connected it.
- **The owner role keeps its meaning for permissions** (owner-only actions,
  the daily job's acting user, the alert time zone); none of that changed.
- **Tasks already filed under the owner** are moved by
  `supabase/migrations/20261021002000_tasks_to_principal.sql`, run by hand in
  the SQL editor after its read-only preview: a task assigned to an owner who
  is not the principal, `source` not `human`, with no `task.assigned` row
  (nobody chose), open, snoozed or complete. Each move writes a
  `task.assigned` row (`reason: 'default owner fix'`), which also makes a
  second run move nothing; `updated_at` is kept. Its selection is pinned in
  TypeScript (`lib/tasks/principal-backfill.ts`) and the SQL is checked
  against it by structure, since the repo has no Postgres to run it.
- **The demo** mirrors a real team: the teammate is the first owner, listed
  first; the demo user, whose mailbox the demo reads, is the principal (and
  keeps the owner role, so owner-only pages stay testable).

**Known limits.**

- A follow-up an assistant adds by hand for themselves now starts on the
  principal; they hand it to themselves from the row's menu.
- Done tasks moved by the backfill are judged by the proof check against the
  principal's mailbox; one an assistant ticked after sending it from their
  own mailbox can be flagged "Ticked, not seen sent" ("It's done" clears it).
- The backfill matches the mailbox address to the member's sign-in address
  in `auth.users` or their profile; the app reads the profile only. The two
  are the same address unless a profile was edited by hand.
