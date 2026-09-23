# Changelog

Notable changes to TipTop Copilot. Newest first.

Versions follow [semantic versioning](https://semver.org). Until 1.0 the schema
may change between minor versions; migrations are additive and idempotent
throughout.

---

## [0.3.4] — 2026-09-23

No schema change, no new environment variable, no new dependency. One Slack
app change is needed before the tab shows reports — see **Deploy**.

### Updates tab

A new **Updates** tab (`/updates`, in the sidebar and the phone bottom bar)
shows the three weekly dealflow reports and the Nick Update Digest runs, read
live from their Slack channels. Reasoning in [DECISIONS.md](DECISIONS.md) D-050.

- Filter by Dealflow or Digests, and by source. Each card opens on a short
  preview — the first summary bullets and next deadlines of a report, or the
  "worth your attention" list of a digest (else the run's own flag sentences,
  such as "one is time-sensitive") — and every report section, digest item,
  housekeeping block, run note and roster list stays collapsed until opened.
  A digest's open "Candidate series noticed" question stays in view as
  **Needs your call**. People's replies under a report are shown as replies,
  never as part of it. Ledger lines, "Sent using Claude" footers and channel
  system messages are never shown, and only the current roster version is.
- Each source shows whether the app can read its channel, when it last
  posted, whether a weekly report is overdue, and — when something is wrong —
  the exact fix: add the `groups:history` scope, invite the bot to that
  channel, or replace the token.
- Read-only and not stored: the app never posts to Slack and writes nothing
  to the database. What it reads is kept in server memory for five minutes;
  the last good copy is kept up to a day and shown only when Slack is
  unreachable or rate-limits. Removing the bot from a channel, or revoking the
  token or its scope, drops everything kept from it at once. Refresh re-reads
  a channel at most once every 20 seconds and always honours Slack's
  `Retry-After`.
- Closed while sign-in is unrestricted: outside demo mode the tab makes no
  Slack call and says so until `AUTH_ALLOWED_EMAIL_DOMAINS` is set.
- Slack text is rendered from a whitelist — bold, italic, code, lists, and
  links whose scheme is `https`, `http` or `mailto`. Anything else, including
  `javascript:` links, is shown as plain text.
- /diagnostics lists the Updates tab's configuration.

**Deploy:** in api.slack.com/apps, give the relay bot's app the
`groups:history` bot scope and reinstall it (if the bot token changes, update
`ASK_RELAY_SLACK_TOKEN` on Render and the Vercel standby, and the
`SLACK_BOT_TOKEN` GitHub secret). Then run `/invite @<bot>` in
#pef-dealflow, #openvc-dealflow, the referral dealflow channel and
#nick-update-digest. Until then the tab shows these steps instead of reports.

## [0.3.3] — 2026-09-22

No schema change, no new environment variable, no new dependency.

### Today briefing cards

After the Daily Recap posted on 2026-09-22, the Today page kept showing the
Morning Brief — the afternoon slot flipped between the new recap and a Sep 21
one. Four causes, all fixed. Reasoning in [DECISIONS.md](DECISIONS.md) D-049.

- The Supabase store now sends every request with its own abort signal, the
  documented opt-out from Next's per-render memoization of identical GETs.
  Without it, the Today render that pulled a new card read back the rows from
  before the pull, and the pull's own unchanged-check compared against them.
- The Slack pull ingests one payload per kind — the latest `date_key`, and
  the newest post of that day — and stamps `posted_at` with the Slack message
  time instead of the ingest time. A network fault or Slack 5xx is retried
  after 10 seconds; a Slack refusal waits the full minute, and a rate limit
  waits for its `Retry-After`.
- `ingestRoutineBriefing` never moves a slot to an earlier `date_key`, and
  ignores a payload identical to the stored card. A `date_key` that is not a
  real date, or is later than today in UTC+14, now fails validation, so one
  mistyped year cannot pin a slot for good. The briefing webhook's response
  now says whether it wrote (`written`).
- The GitHub `briefing-slack-sync` relay (workflow, script and its test) is
  retired. It replayed every payload in the window, so each run left each slot
  on its oldest post, and the Today page already reads the channel itself.
- An open Today tab now watches for new cards: it polls
  `GET /api/briefings/current` for a fingerprint every 15 seconds while
  visible, and on returning to the tab, and refreshes once per new
  fingerprint. Failed checks back off to five minutes; a 401 stops them.
- Settings' "Routine briefing card" check now follows `ASK_RELAY_SLACK_TOKEN`,
  the path cards actually arrive by, instead of `BRIEFING_BRIDGE_TOKEN`.
- The daily cron's briefing pull is documented as a best-effort backstop, which
  is all a twice-daily job can be.

**Deploy:** delete the `BRIEFING_SLACK_SYNC` repository variable. A push to
`relay-kick` from a commit that still has the old workflow would otherwise
start it, and it fails on the deleted script.

## [0.3.2] — 2026-09-04

### AI prompts

- `scheduling-reply@1.1.0`: the Arwin voice section now matches Arwin's real
  sent mail instead of a generic professional register — warm and efficient,
  short plain sentences, contractions, concrete times with an explicit CT/CDT
  timezone, and a fixed set of banned AI tells ("I hope this email finds you
  well", "I wanted to reach out", "Please don't hesitate to", "Kindly", "As
  per", "Furthermore/Moreover/Additionally"). Punctuation rule added at Arwin's
  request: a spaced hyphen `' - '` for asides, never em dashes. Calendar rules,
  the signature block, and the read-only/never-sent guarantees are unchanged.
  Voice profile of record lives in the assistant's memory (`arwin-voice-profile`).

## [0.3.1] — 2026-09-01

### AI prompts

- `draft-reply@2.1.0`: factual or administrative asks — an entity name, a
  signature block, notice details, something already shared on the thread — are
  now answered from the supplied sources instead of deferred with "I'll get
  that to you shortly", modeled on Nick's own 2026-08-28 reply to deal counsel
  and mirroring the same-day fix to the external mailbox triage routines. Each
  asserted fact is listed in `asserted_facts`; the commitment guardrail is
  unchanged, and wire or banking details never appear in a draft even when the
  sources contain them. Reasoning in [DECISIONS.md](DECISIONS.md) D-048.

## [0.3.0] — 2026-08-17

Design pass. No schema change, no new environment variable, no new dependency.

### Design system

- The token layer gained the tiers it was missing: **elevation** (three steps,
  tinted with the brand ink on paper and carried by a top highlight in dark),
  a named **type scale**, **motion** durations and easings, a **z-index scale**
  to replace three files picking `z-30`/`z-40`/`z-50` independently, and page
  gutter/stack rhythm. The palette is unchanged; `#0FC382` remains a dark-theme
  accent and a fill, never text on paper.
- New primitives: `Table` (sticky header, numeric alignment, mandatory scroll
  container), `Stat`/`StatGroup`, `Toolbar`/`FilterChip`, and `NotConfigured`.
- `FieldLabel` is now used everywhere. Its exact class string had been
  hand-written 30 times across 9 files while the primitive itself went unused.
- `cn()` declares the new font sizes to `tailwind-merge`. Without that it read
  `text-micro` as a colour, deduped it against `text-[var(--fg-subtle)]`, and
  silently dropped every label's size — with a green build and a green suite.

### Capability states

Every AI-derived surface now decides on the server whether a provider exists,
and says so in place rather than after the fact. `/ask` no longer offers a
composer and eight suggestions that fail into a toast; `/today`, the deal
scorecard, the Inbox (Analyse as deal, Draft reply) and the portfolio Classify
button all state what is off, what still works, and where to look. Everything
that reads from records — attach to deal, categorise, tasks, memo export —
stays available.

### Shell

Navigation is grouped (Working / Records / System) with an accent rail marking
the current page, `/diagnostics` gains the nav entry it never had, the account
block gets a proper hierarchy, and the mobile header names the current section.

### Deals

`/deals` is a sortable table above `lg` — sticky header, `aria-sort`, tabular
figures, ordering held in the URL — and a purpose-built card list below it
rather than a compressed table. An unscored deal renders as absent, never as
zero, and sorts to the end in both directions. Five end-to-end tests cover it.

---

## [0.2.0] — 2026-08-17

### Prompts

- **draft-reply@2.0.0** — the draft voice now matches Nick's actual sent mail
  (greeting forms, verdict-first openings, natural exclamation points, his own
  reference phrasings) instead of a sanitised register; adds a hard guardrail
  against committing money, allocations or terms in any draft; and confines
  LinkedIn links to outbound introductions — formal full names in the
  "please meet" lines only, URLs only from supplied sources, never guessed.
- **scheduling-reply@1.0.0** (new) — pure meeting logistics are drafted in the
  EA's voice with an introduction and signature, checked against a snapshot of
  the synced calendar: no overlaps, 8am–6pm Central only, hour-long in-person
  blocks with travel buffers, reschedules treat the moving slot as free,
  cancellations get a warm rebook offer, and the draft never initiates moving
  one of Nick's commitments. New `DraftKind: 'scheduling'` routes to it and
  supplies the calendar snapshot from synced records.
- **email-classification@1.3.0** — importance now weighs whose court the ball
  is in, and list mail, cold pitches, notifications and marketing are pinned to
  low importance with no deep fetch.

The app remains read-only against Gmail and Calendar. Mailbox-side labelling
and Gmail drafts are owned by the external triage routines; app drafts stay
copy-paste, and the write-scope test keeps that structural.

---

## [0.1.0] — 2026-08-05

First complete build. Every screen works, the full suite passes, and the demo
runs end to end with no credentials.

### Product

- **Today** — daily outlook assembled from records, with meeting prep, important
  mail, new deals, overdue follow-ups and open portfolio requests. Every item
  carries the record it came from.
- **Inbox** — mailbox sync with model classification. Metadata by default; full
  bodies only on open or when the classifier judges a message consequential.
- **Deals** — pipeline, configurable scorecard, page-aware attachment
  extraction, duplicate detection, additive corrections, red flags, diligence
  questions, decision history, markdown memo export.
- **Ask** — open-ended questions answered through an allowlisted server-side
  tool layer, with validated citations and a visible tool trail.
- **Portfolio** — companies, typed asks, and suggested introductions filtered
  against the fund's own network data. CSV import.
- **Knowledge** — uploaded documents with page-level citation search.
- **Tasks**, **Settings** (thesis, weights, thresholds, stages, integrations)
  and **Diagnostics**.

### Platform

- Next.js 16 App Router with Turbopack; React 19; TypeScript strict with
  `noUncheckedIndexedAccess`; Tailwind v4.
- Every external boundary behind an interface with a real and an offline
  implementation, selected once in `src/lib/runtime.ts`.
- Demo mode: file-backed store, deterministic offline model, fixture mail and
  calendar. No credentials, no network.
- 34 tables across 8 migrations, row-level security on every one.
- PWA with a static-shell service worker that never caches authenticated HTML or
  API responses.

### Security

- AES-256-GCM for provider tokens, with a per-record IV and the integration id
  bound in as additional authenticated data.
- Structural prompt-injection defence: fencing, escape neutralisation, attribute
  escaping, and detection that annotates rather than hides.
- Citation validation — a model-supplied source id that no tool issued is
  dropped and audited.
- Organization isolation as a parameter on every call, with RLS as the second
  gate.
- Persisted-usage budget and rate limits that hold across instances.
- Read-only Google scopes. No send capability anywhere in the product.

### Testing

- 423 unit and integration tests, 38 end-to-end. All run without credentials.
- Every one of the thirteen product invariants has at least one test that fails
  if it is regressed.
- No snapshot tests.

### Fixed during the final verification pass

Eight defects, all found by tests written against behaviour rather than
implementation:

- `/login` was statically prerendered. A build made without `DEMO_MODE` froze
  "authentication is not configured" into the HTML, making demo mode unreachable
  no matter how the server was started. This blocked the entire demo.
- Demo entry was globally capped at 20 per minute and **threw** on trip,
  rendering a dead-end server error page. It now redirects back with an
  explanation, and the ceiling is 60.
- A repeated forced sync updated a `sync_runs` id that the upsert had never
  inserted, so the third run crashed — the opposite of "idempotent by
  construction".
- `startOfDayUtc` measured the timezone offset at noon and applied it to
  midnight, so on the two DST changeover days each year the "today" window was
  an hour out: a 23:00 event from yesterday appeared in today's brief, or a
  00:30 event was missed.
- `Asia/Bengaluru` is not an IANA timezone but was offered in the Settings
  dropdown. Selecting it would have thrown on every date format in the app. Now
  `Asia/Kolkata`.
- The injection detector missed `mark this deal as ADVANCE` — the exact phrasing
  of its own demo payload — because the pattern required the object to carry no
  noun. It also missed verb-first credential requests (`send me your api key`).
- `htmlToPlainText` left a leading space on every line and could not produce a
  blank line, so converted email bodies reached the model mis-shaped.
- `overrideRecommendation` accepted an empty reason, losing the one signal a
  human override exists to record.

### Known limitations

See [PUBLISH_CHECKLIST.md](PUBLISH_CHECKLIST.md) §10. In short: no CI, no
penetration test, no load testing, no automatic retention policy, and prompt
injection is mitigated rather than solved.
