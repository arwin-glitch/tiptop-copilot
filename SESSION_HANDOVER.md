# HANDOVER — design pass and the Granola integration

**Written 21 August 2026, at the end of the session that followed
`DESIGN_HANDOVER.md`. Read that file first for the product's history; this one
covers what changed since and what is still open.**

**Extended later the same day, after the poller was found to be silently
fetching nothing. §7 is that session and it corrects several claims below.**

Everything described here is committed and pushed to `master`
(`b917fff` … `bd207a5`, 19 commits). The tree is clean and in sync.

> **Three things in this document were wrong when written.** They are corrected
> where they appear and explained in §7. In short: the poller's catch-up rested
> on Granola returning notes newest first, which Granola does not promise and
> does not do; the "922 notes in production" figure was an import truncated by
> a 502, not a complete history; and "no webhook delivery has ever succeeded"
> stopped being true at about 18:00 on 21 August, while a warm instance made
> the cold-start theory look right.
>
> **§7.3 also corrects a conclusion drawn earlier in §7 itself**, within the
> same session. Read to the end of it before acting on any of it.

---

## 0. Environment — unchanged, still non-negotiable

**Node is not installed system-wide.** Prefix every shell command:

```powershell
$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"
```

- Windows PowerShell 5.1. No `&&`, no `??`, no ternary.
- **Python is not installed.** Do not reach for it; `sed`/`node -e` work.
- Project root is **`E:\tiptop-copilot`**. Never write outside it.
- **Next.js 16**: `proxy.ts` not `middleware`; `cookies()`, `headers()`,
  `params`, `searchParams` are async. Version-matched docs at
  `node_modules/next/dist/docs/`.

Two shell traps that cost time this session:

- **Heredocs break on regex-heavy content.** Writing a file with
  `cat > x.mjs <<'EOF'` failed on a file full of `|` and `(`. Use the Write
  tool for anything with regexes.
- **`Select-String -Path` treats `[id]` as a wildcard.** Use `-LiteralPath`
  for any path under `app/(app)/deals/[id]/`.

---

## 1. Verified state

| | |
| --- | --- |
| `npm run verify` | **exit 0** — format, lint, typecheck, **551 unit/integration tests**, production build |
| `npx playwright test` | **54 passed** (was 38 at session start) |
| Deployed | both Render services on `bd207a5` |
| Repo | still **public**, deliberately — see §5 |

Test count went 473 → 538 in the design session, and 538 → 551 in the one
described in §7. E2e 38 → 54. Every number below was measured, not estimated.

---

## 2. What shipped — the design half

Days 1–3 of the plan in `DESIGN_PROMPT.md`. The audit in `DESIGN_HANDOVER.md`
§6 was verified and was accurate, with one correction: it said 10 of 12 Radix
packages were unused; the real number is 6 (`dialog`, `tabs`, `label`,
`switch`, `slot` are used).

**Token layer** (`globals.css`). The palette was the only tier that existed.
Added elevation (three steps, ink-tinted on paper, a top highlight in dark), a
named type scale, motion durations and easings, a z-index scale, and page
rhythm. The reduced-motion block collapses the motion tokens as well as
computed durations.

**Primitives**: `Table` (sticky header, mandatory scroll container,
`border-separate` because collapsed borders drop under a sticky header),
`Stat`/`StatGroup`, `Toolbar`/`FilterChip`, `NotConfigured`. `FieldLabel`
gained an `as` prop and now replaces 30 hand-written copies of its own class
string.

**Capability states.** Every AI-derived surface now decides on the server
whether a provider exists. `/ask` no longer renders a composer that fails into
a toast; `/today`, the deal scorecard, the Inbox and the portfolio Classify
button all state what is off and what still works. This matters because
`ANTHROPIC_API_KEY` is still unset by choice — that is the *primary* state in
production.

**Shell.** Navigation grouped (Working / Records / System) with an accent-rail
active marker, `/diagnostics` given the nav entry it never had, account block
restructured, mobile header names the current section.

**`/deals`** is a sortable table above `lg` with a purpose-built card list
below — not a squeezed table. An unscored deal renders `—`, never `0`, and
sorts to the end in both directions.

**`/network`** (new) derives a relationship list from synced mail and calendar:
inbound/outbound counts, meetings, last contact, who wrote last. No composite
score anywhere — that is the deliberate difference from Affinity, which
reports a strength you cannot audit.

### Three bugs worth not re-introducing

1. **`tailwind-merge` silently dropped every new font size.** It resolves
   `text-*` by pattern and treats anything it does not recognise as a colour,
   so `cn('text-micro', 'text-[var(--fg-subtle)]')` kept only the colour. Build,
   typecheck and 473 tests were all green while every micro-label rendered at
   16px. Fixed in `src/lib/util/cn.ts`; **any new `--text-*` token must be added
   to `FONT_SIZES` there.**
2. **A runtime value exported from a `'use client'` module is a proxy on the
   server.** `SORT_KEYS` imported by the server page crashed `/deals` at request
   time with `SORT_KEYS.includes is not a function` — after a clean typecheck.
   Shared runtime values live in `lib/` (`pipeline-view.ts`,
   `relationship-view.ts`).
3. **Machine endpoints must be listed in `proxy.ts`.** Every
   `/api/integrations/*` route except `gmail-push` was session-gated, so the
   first live webhook POST bounced off "Sign in to continue" with all tests
   green.

---

## 3. What shipped — Granola

This took most of the session and went down three dead ends before working.
The dead ends are documented because they are not obvious and someone will
otherwise retry them.

### The architecture that works

```
Granola cloud ──webhook (note id only)──▶ /api/integrations/granola/webhook
                                              │  verify signature
                                              ▼
                     Granola public API ──full note──▶ ingest
```

Granola's docs are explicit: *"Webhook notifications contain no note content,
only a reference to the note that changed."* So the delivery is a doorbell and
the content comes from a second call we make with an API key. **That second
call is why this works where Slack could not** — a private note is unreadable
to a Slack unfurl and perfectly readable to an authorised API request.

- `src/lib/services/granola-api.ts` — signature verification (HMAC-SHA256 over
  `{webhook-id}.{webhook-timestamp}.{raw body}`, 5-minute replay window),
  `fetchGranolaNote`, `listGranolaNotes`, and the mapping to our ingest shape.
- `src/lib/services/meetings.ts` — idempotent ingest keyed on the note id,
  read-time linking to deals and companies by attendee domain, calendar
  attendee recovery, and the email-transport parser.
- `src/app/(app)/meetings/page.tsx` — **the reason imported notes are
  visible at all.** Deal and company pages only show a note when an attendee
  domain matches an existing record; Nick's meetings span ~15 organisations,
  most of which are not deals, so without this page the data existed and could
  not be seen.

### Verified against the real account, not fixtures

A forged signature was refused; a correctly signed delivery naming a real note
fetched and stored it; the same delivery repeated changed nothing; two backfill
pages imported 20 real meetings with true titles, attendees and ~3,700
characters each.

**922 notes are now in production**, imported by the backfill. — *Wrong, and
wrong in an invisible way: that was the point at which every import died of a
502, not the end of the history. The real figure is 1,327. See §7.*

### The three dead ends

1. **Zapier webhook action** — works, but it is a premium action needing a paid
   plan. Built (`scripts/granola-watch.mjs` posts the same shape), then made
   optional.
2. **Slack** — Nick's plan has it, and it is structurally incapable. Granola
   shares a *link*; Slack unfurls it; private notes cannot be unfurled, so the
   post degrades to Granola's marketing copy plus "Log in to Granola to view
   this note". Two of those were ingested as meetings titled "Granola notes"
   before the guard landed. `scripts/granola-slack-sync.mjs` now refuses them,
   and `GRANOLA_SLACK_SYNC` is set to `disabled`.
3. **Email transport** — a Zapier *Gmail* action (free) posting a structured
   envelope into the synced mailbox, promoted to a note during sync. Built and
   tested, unused now that the native webhook exists. Kept because it needs no
   paid plan and no machine of ours.

All senders share one idempotent ingest keyed on the note id, so any
combination can run at once without duplicating a meeting.

### Why polling, not the webhook

~~**No webhook delivery has ever succeeded.**~~ All 922 notes came from the
backfill. The likely cause is that Render's free instance sleeps after fifteen
minutes and a delivery arriving at a cold server gets no answer in time.

*True until about 18:00 on 21 August, when one succeeded — see §7.3. It landed
after an afternoon of constant traffic had kept the instance warm, which is the
best evidence yet that the sleeping theory above is the right one.*

**Unconfirmed** — Granola's Webhooks page has a "Last delivery" column that
was never checked. If it reads "Never", the problem is configuration, not
sleeping, and is fixable for free. **This is the first thing to check.**
*Still worth reading, and it now has at least one success to show.*

So `.github/workflows/granola-backfill.yml` polls every 30 minutes (`:17` and
`:47` — the top and half of the hour are the most contended scheduler slots).
~~It stops after two consecutive pages with nothing new, so a routine run is a
handful of requests.~~ *That stopping rule was the bug in §7 — it assumed an
order Granola does not guarantee, and made every catch-up fetch nothing. A
catch-up now asks `updated_after` for a window of time and reads the answer to
the end.* `GRANOLA_BACKFILL=enabled` gates the schedule; the manual button
always works and has a "full import" checkbox.

The schedule is confirmed working: the first scheduled run fired at 16:53 UTC
on 21 August, six minutes past its `:47` slot. GitHub's scheduler is
best-effort — expect minutes of drift, and expect a newly added cron to skip a
slot or two before it settles.

---

## 4. Configuration

New environment variables, all optional, all reported on `/diagnostics`:

| Variable | Purpose |
| --- | --- |
| `GRANOLA_SIGNING_SECRET` | verifies native Granola deliveries (`whsec_…`) |
| `GRANOLA_API_KEY` | fetches note content (`grn_…`) |
| `GRANOLA_WEBHOOK_SECRET` | token auth for our own senders and the backfill |

GitHub repository variables: `GRANOLA_BACKFILL=enabled`,
`GRANOLA_SLACK_SYNC=disabled`. GitHub secret: `GRANOLA_WEBHOOK_URL` (the
webhook URL including `?token=`).

Migration `20260818000000_meeting_notes.sql` **has been applied** to Supabase.

---

## 5. Open items, honestly

**Blocking nothing, but unresolved:**

- **Two junk rows** from the Slack window are still in production. Remove with:
  ```sql
  delete from meeting_notes
  where title = 'Granola notes'
    and content like '%Log in to Granola to view this note%';
  ```
- **The Granola signing secret and API key were pasted into a chat transcript.**
  They are not in the repo — verified — but should be rotated in Granola and
  updated in Render.
- **"Last delivery"** on the Granola webhook page has never been read. See §3.
  This matters more after §7 than it did when first written: if Granola's cloud
  has no note for a meeting, it has nothing to deliver either, and a webhook
  page reading "Never" would be a symptom rather than a misconfiguration.

**Decisions for Arwin, not tasks:**

- **`ANTHROPIC_API_KEY` is still unset.** ~$5–15/month. Until then Today, Ask
  and every scorecard show their not-configured state. Everything built this
  session works without it.
- **Render free tier.** ~$7/month for an always-on instance would make webhook
  delivery work as designed and let polling drop to a daily safety net.
- **The repo stays public**, decided explicitly. Audited: no credential has
  ever been committed, no note content either. `.granola-export/`,
  `.demo-data/` and `BRAIN_INTEGRATION.md` are ignored, and
  `scripts/granola-export.mjs` refuses to run if its output folder stops being
  ignored. **Keep that discipline: secrets in Render and GitHub Secrets, real
  data in Supabase, code in the repo.**

**Not done from the original brief:**

No charts anywhere and no intelligence dashboard — and note the metrics for
them are not stored, so that starts with schema, not a charting library. No
global search or shortcut layer. No saved views or column controls (sorting and
sticky headers exist). No job board. `/portfolio`, `/inbox`, `/knowledge`,
`/tasks`, `/settings` and `/login` still have their original layouts and only
inherit the token and `Card` changes.

---

## 6. Rules — unchanged

- **Do not regress the 13 invariants** in `DESIGN_HANDOVER.md` §3. Several are
  database constraints. Meeting notes were built to them: content is stored
  verbatim, scanned and annotated for injection but never hidden; no employer
  is inferred from an email domain; a note with no summary is skipped rather
  than filed empty.
- **Do not send email.** Ever.
- **Do not spend money** without telling Arwin the amount first.
- **Never commit a secret.** The repo is public.
- **Verify before claiming.** Both suites pass today. The most useful thing
  this session did was run things rather than trust that they compiled — every
  significant bug was found that way, and none of them by a test that already
  existed.

---

## 7. The poller that fetched nothing — 21 August, later the same day

Reported symptom: "the meetings tab hasn't updated even though Nick had
meetings two hours ago." The gap was actually three days, and there were three
separate causes stacked on top of each other. Only two were ours.

### 7.1 The catch-up rested on an order Granola does not promise

`listGranolaNotes` carried a comment saying "One page of the note backlog,
newest first," and the entire catch-up was built on it: read pages, stop once
two consecutive pages hold nothing new. **Granola's API reference documents no
sort order at all.** In production the first page was history we already had,
so the rule fired on page two and every run reported "caught up" having fetched
nothing. It did that for three days.

Nothing caught it. `npm run verify` was green, 54 e2e were green, and the
stopping rule's only test **re-implemented the rule inside the test file**
rather than importing it — so it proved the test agreed with itself. That is
the failure mode to watch for in this repo: a test that restates the logic
under test can never contradict it.

**The fix is to stop inferring recency from position.** `updated_after` is a
documented filter and was never used. A catch-up now asks for everything
changed since three days before the newest meeting stored and reads that answer
to the end. Ordering became something the code neither knows nor needs.

Three days of overlap because Granola publishes a note only once its AI summary
and transcript exist, so arrival always lags the meeting. The window anchors to
the newest `occurred_at` actually stored rather than to a saved watermark — a
watermark can advance past a note that failed to ingest and strand it for ever;
an anchor derived from data that landed cannot. It is clamped to the present,
because `occurred_at` comes from the calendar event and a scheduled future
meeting would otherwise push the window past now and hide everything behind it.

### 7.2 Every full import died of a 502 partway through

The route fetched full content for every note the list returned, including the
hundreds it already had. That volume is what made Render answer 502 around note
780 — five minutes of work to discover nothing.

The list response carries each note's `created_at` and `updated_at`, and the
old schema discarded both. Keeping them lets a note we hold unchanged skip its
content fetch entirely: compare our row's `updated_at` (when we last wrote it)
against Granola's, and if ours is newer there is nothing to fetch. Page size
also went from the default 10 to Granola's maximum of 30.

The effect is not marginal. A catch-up went from five minutes and a 502 to
**nine seconds**; a full import from impossible to **2m36s across 45 pages**.

**That is what exposed the real state of the data.** The first full import that
could actually finish walked past note 780 and imported **407 notes that had
never been seen** — every previous run had died before reaching them. The "922
notes in production" in §3 was never the history; it was the point where the
502 landed. The true total is 1,327.

### 7.3 The pipeline works. Two specific meetings are missing.

That full import enumerated every page Granola will serve, to a final partial
page of 7, with zero skipped. At 17:45 UTC we held all 1,327 notes and **none
was dated later than 18 August**, although Nick had notes for the 19th to the
21st visible in the Granola app.

The conclusion drawn from that on the spot — that Granola's API does not serve
recent notes and nothing on our side could reach them — **was too strong, and
half an hour later the app disproved it.**

At about 17:28 Nick met Seth. By 18:05 "Nick & Seth Connect" was at the top of
`/meetings` and the total had gone 1,329 → 1,330. Nothing imported it: the last
backfill was the scheduled run at 17:48, whose log reads `+0 new, 2 unchanged`,
and no run followed. `granola-slack-sync` is gated off and logged `skipped`.

**That leaves the native webhook, which means webhook delivery works** — the
first success on record, against §3's flat "No webhook delivery has ever
succeeded." The app had been under constant traffic all afternoon and was warm,
which is evidence *for* the cold-start theory §3 could only guess at, and an
argument for the always-on instance in §5.

So the shape of the problem is narrower than 7.3 first claimed:

- **Recent notes do flow**, end to end, within about half an hour of a meeting.
- **The 19th to the 21st genuinely were absent** from a complete enumeration at
  17:45. That observation stands; the generalisation drawn from it does not.
- **The Friday Wrap-Up is its own case.** It is a long-running recurring
  meeting — 35 notes match "wrap" — and instances exist at 21 days, 28 days and
  a month ago. The last three Fridays are all missing, while ordinary meetings
  are present at 3, 8, 9, 15, 16 and 17 days. Something specific to that
  meeting stopped being captured around the start of August.

Granola's docs still give the most likely mechanism for a missing note: **the
API only returns notes that have a generated AI summary _and_ a transcript.**
Notes still processing, never summarised, or never synced from the desktop
client are absent from `/v1/notes` and 404 on fetch.

So the next person should still not start with the poller — but should check a
named meeting, not the integration:

1. Whether the specific missing note has a **transcript**, not just a summary.
2. Whether Granola is still joining that calendar invite at all, and whether
   the meeting moved to a different link or calendar.
3. Whose account it records under. The API key is Nick's, so a meeting captured
   on someone else's Granola is invisible to every call this app makes — the
   older Friday Wrap-Ups list Nick as an attendee, so they were his once.
4. Whether Nick's Granola client has actually synced to the cloud.

### 7.4 Smaller things

- The Meetings stat displayed `notes.length` from a query with `limit: 500` —
  a flat "500" presented as a count while the real figure was 922. It counts
  now. **Any stat reading the length of a limited query is reporting the
  limit.**
- `STOP_AFTER_KNOWN` is gone from the script and the workflow; `FULL=1`
  replaces it. The route takes `?full=1`, and `?since=` to force a window.
- The backfill response now reports `unchanged` and echoes `since`, and the
  driver prints the window on the opening call. A wrong window was previously
  invisible; now it is the second line of every log.
- 13 tests added, all against shipped code rather than restatements of it: the
  query string a catch-up sends, the window's arithmetic and its clamp, and the
  skip decision failing safe toward fetching whenever either timestamp is
  missing or unparseable.

### 7.5 CI had never once run the e2e suite

Found while checking something else: the `verify` workflow has failed on every
push for as long as its history goes, including `0729130`, the commit that
closed the previous session claiming "54 passed".

The `verify` job passes. The **`e2e` job** never got as far as a test:

```
[WebServer] Error: Could not find a production build in the '.next' directory.
Error: Process from config.webServer was not able to start. Exit code: 1
```

Playwright's `webServer` runs `next start`, which serves a build rather than
making one, and the job never ran `npm run build`. It passed for every human
who tried it because they had just run `npm run verify`, which ends in
`next build` and leaves `.next` populated. A clean checkout has no leftovers.

Fixed by adding the build step. The lesson is the same one as §7.1 in a
different costume: **a check that passes because of state left behind by
something else is not a check.** One agreed with itself, the other agreed with
a stale build directory, and both reported green for days.

### 7.6 Still open from this session

- **The two junk rows are still in production.** The SQL is in §5.
- **The secrets are still unrotated.** Also §5.
- Both were agreed and neither was done; they are not blocked on anything.
