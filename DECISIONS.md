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
