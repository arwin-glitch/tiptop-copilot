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
