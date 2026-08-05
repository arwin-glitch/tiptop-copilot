# TipTop Copilot

An internal investment cockpit for TipTop VC. It reads the mailbox and calendar,
turns inbound pitches into structured deal records, scores them against Nick's
written thesis, and answers questions about any of it — always with the record
the answer came from attached.

It drafts email. It never sends it.

---

## Run it in one command

```bash
npm install
npm run dev:demo
```

Then open <http://localhost:3000>. No credentials, no database, no network
calls. Demo mode runs against a fictional dataset with a deterministic offline
model, and every screen works.

To run against real infrastructure, copy `.env.example` to `.env.local` and see
[SUPABASE_SETUP.md](SUPABASE_SETUP.md) and
[GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md).

---

## What it does

| Screen | What it is for |
| --- | --- |
| **Today** | The daily outlook: meetings with prep, important mail, new deals, overdue follow-ups, open portfolio requests. Assembled from records; the model narrows and phrases. |
| **Inbox** | Synced mail, classified. Metadata by default; full bodies only when you open a message or the classifier judges it consequential. |
| **Deals** | The pipeline. Each deal has a scorecard, extracted facts with provenance, diligence questions, red flags and a decision history. |
| **Ask** | One open-ended question, one direct answer, with the sources. The model reaches data only through an allowlisted tool layer. |
| **Portfolio** | Companies and their open asks. Suggested introductions are filtered against your own network data. |
| **Knowledge** | Uploaded documents — thesis, memos, pass notes, market maps — searchable with page-level citations. |
| **Tasks** | Follow-ups, overdue first. |
| **Settings** | Thesis, scoring weights, thresholds, pipeline stages, integrations. |
| **Diagnostics** | What is configured and what is missing. Presence only — never a value. |

---

## The thirteen rules it is built around

These are not aspirations. Each has at least one test that fails if it is
broken, and several are enforced at the database level.

1. **Unknown stays unknown.** A field the sources do not state is `null`. No
   defaults, no `N/A`, no inference dressed as a value. Extraction refuses to
   write a field it cannot attach a real citation to.
2. **Unscored is not zero.** A scorecard category with no evidence is
   `unscored` and is excluded from the normalised score. It lowers completeness
   and confidence; it does not drag the score down.
3. **The model proposes; the code decides.** `deriveRecommendation()` applies
   the thresholds you configured. The model may argue *down* from the
   arithmetic, never up.
4. **A hard red flag caps, it does not veto.** It caps the label at MONITOR
   without touching the score, so resolving it restores the original
   recommendation with no re-analysis.
5. **The AI cannot mark a deal invested.** `INVESTED` is absent from the output
   enum, and `deal_decisions.actor` has a database-level `check (actor =
   'human')`.
6. **There is no send capability.** No `gmail.send` scope is requested
   anywhere, `generated_drafts.sent` has `check (sent = false)`, and there is
   deliberately no `sendDraft()`.
7. **Untrusted content is fenced, never obeyed.** Email, attachment, document
   and web text is wrapped in a labelled block that the system prompt declares
   to be data. Detection *annotates*; a false positive must never make an email
   invisible.
8. **No fabricated citations.** A model-supplied source id that was not in the
   prompt is dropped and audited.
9. **No introductions to people who do not exist.** Portfolio suggestions are
   filtered against your own `network_contacts`.
10. **Corrections are additive.** `deal_facts` is append-only with
    `superseded_by`, so the original extraction and your correction are both
    visible for ever.
11. **No `dangerouslySetInnerHTML`**, except one audited theme-bootstrap script
    with a written justification. An ESLint rule enforces it.
12. **Sync is idempotent by construction** — natural-key upserts plus a
    deterministic idempotency key, not a retry counter.
13. **No invented investment parameters.** Check size, ownership, geography and
    required traction ship empty and are excluded from scoring until you set
    them.

---

## Commands

```bash
npm run dev:demo          # demo mode, no credentials needed
npm run dev               # real mode, needs .env.local
npm run verify            # format:check + lint + typecheck + test + build
npm test                  # unit + integration (423 tests)
npm run test:e2e          # Playwright: demo flow + mobile/accessibility (38 tests)
npm run test:e2e:install  # one-time browser download
```

---

## Documentation

| Document | What is in it |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it is put together and why |
| [SECURITY.md](SECURITY.md) | Threat model, prompt injection, secrets, isolation |
| [DATA_MODEL.md](DATA_MODEL.md) | Every table and the constraints that matter |
| [AI_PROMPTS.md](AI_PROMPTS.md) | Prompts, versioning and the model-vs-code split |
| [TESTING.md](TESTING.md) | What is tested, and how to add to it |
| [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md) | Every variable in prose |
| [SUPABASE_SETUP.md](SUPABASE_SETUP.md) | Database, auth and storage from zero |
| [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md) | Read-only Gmail and Calendar |
| [PUBLISH_CHECKLIST.md](PUBLISH_CHECKLIST.md) | Everything between here and live |
| [PRIVACY.md](PRIVACY.md) | What is stored, where it goes, how to remove it |
| [DECISIONS.md](DECISIONS.md) | Numbered record of every material choice |
| [PLAN.md](PLAN.md) | Acceptance criteria and milestones |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

---

## Stack

Next.js 16 (App Router, Turbopack), React 19, TypeScript 5.9 in strict mode
with `noUncheckedIndexedAccess`, Tailwind v4, Radix primitives, Supabase
(Postgres + RLS + storage), the Anthropic SDK, Zod 4, Vitest 4, Playwright.

Note for anyone reading the source: this is **Next.js 16**. `middleware` is
`proxy` (`src/proxy.ts`), and `cookies()`, `headers()`, `params` and
`searchParams` are all async. Version-matched docs ship at
`node_modules/next/dist/docs/`.

---

Internal tool. Not for distribution.
