# HANDOVER — design pass and the Granola integration

**Written 21 August 2026, at the end of the session that followed
`DESIGN_HANDOVER.md`. Read that file first for the product's history; this one
covers what changed since and what is still open.**

Everything described here is committed and pushed to `master`
(`b917fff` … `cf3d289`, 17 commits). The tree is clean and in sync.

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
| `npm run verify` | **exit 0** — format, lint, typecheck, **538 unit/integration tests**, production build |
| `npx playwright test` | **54 passed** (was 38 at session start) |
| Deployed | both Render services on `cf3d289` |
| Repo | still **public**, deliberately — see §5 |

Test count went 473 → 538; e2e 38 → 54. Every number below was measured, not
estimated.

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

**922 notes are now in production**, imported by the backfill.

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

**No webhook delivery has ever succeeded.** All 922 notes came from the
backfill. The likely cause is that Render's free instance sleeps after fifteen
minutes and a delivery arriving at a cold server gets no answer in time.

**Unconfirmed** — Granola's Webhooks page has a "Last delivery" column that
was never checked. If it reads "Never", the problem is configuration, not
sleeping, and is fixable for free. **This is the first thing to check.**

So `.github/workflows/granola-backfill.yml` polls every 30 minutes (`:17` and
`:47` — the top and half of the hour are the most contended scheduler slots).
It stops after two consecutive pages with nothing new, so a routine run is a
handful of requests. `GRANOLA_BACKFILL=enabled` gates the schedule; the manual
button always works and has a "full import" checkbox.

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
