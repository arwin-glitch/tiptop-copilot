# PLAN — TipTop Copilot

An internal AI operating system for TipTop VC. Primary user: Nick Tippmann.
Organization-aware from day one; single-user in practice at launch.

## 0. Workspace situation

The invocation working directory (`E:\`) is a personal drive root containing
hundreds of unrelated files. Creating an application repository there would be
destructive and unmanageable, so the application lives in a dedicated
subdirectory:

```
E:\tiptop-copilot\
```

Nothing outside that directory was modified, with one exception noted in
`DECISIONS.md` (D-001): a portable Node.js toolchain was extracted to
`E:\_toolchain\` because no Node runtime was installed on the machine and the
build could not otherwise be run or verified. No system-wide installation was
performed and no PATH/registry changes were made.

`E:\tiptop-vc-perks` (an unrelated static site) was inspected and left untouched.

## 1. Acceptance criteria

The build is done when every item below is true and has been *executed*, not
just written:

| # | Criterion | Verified by |
|---|---|---|
| A1 | App runs locally with zero credentials | `npm run dev:demo` |
| A2 | Demo mode covers the full 13-step product flow | Playwright `tests/e2e/demo-flow.spec.ts` |
| A3 | Deal emails become structured deal records | `tests/integration/email-to-deal.test.ts` |
| A4 | Attachments extract with page-aware citations | `tests/unit/attachments.test.ts` |
| A5 | Every material AI claim carries a resolvable source | `tests/unit/citations.test.ts` |
| A6 | Scorecard, completeness, confidence tracked separately | `tests/unit/scoring.test.ts` |
| A7 | Missing data never fabricated; unknown stays unknown | `tests/unit/scoring.test.ts`, `tests/unit/extraction-schema.test.ts` |
| A8 | Hard red flags cap the recommendation | `tests/unit/recommendation.test.ts` |
| A9 | AI cannot mark a deal `invested` | `tests/unit/recommendation.test.ts` |
| A10 | Prompt injection in email/attachments does not alter behaviour | `tests/unit/prompt-injection.test.ts` |
| A11 | Org isolation enforced on every read/write | `tests/integration/authorization.test.ts` + RLS policies |
| A12 | OAuth refresh tokens encrypted at rest (AES-256-GCM) | `tests/unit/token-crypto.test.ts` |
| A13 | Gmail sync is incremental, deduplicated and idempotent | `tests/integration/gmail-sync.test.ts` |
| A14 | Duplicate deals detected, never auto-merged when uncertain | `tests/unit/dedupe.test.ts` |
| A15 | Cost/rate limits enforced server-side | `tests/unit/cost-limits.test.ts` |
| A16 | Production build passes | `npm run build` |
| A17 | Lint, format, typecheck, unit, integration, e2e all pass | `npm run verify` + `npm run test:e2e` |
| A18 | No secret reachable from the browser bundle | `tests/unit/env-boundary.test.ts` + build output review |
| A19 | Complete migrations; no manual table creation | `supabase/migrations/*.sql` |
| A20 | Publishing handoff needs no further code work | `PUBLISH_CHECKLIST.md` |

## 2. Milestones (all executed in this session)

1. **Inspection & planning** — workspace audit, `PLAN.md`, `DECISIONS.md`.
2. **Foundation** — Next.js 16 App Router, TS strict, Tailwind v4, design system,
   PWA, demo-mode infrastructure.
3. **Database & auth** — full migration set, RLS, org-aware session layer,
   encrypted integration tokens, demo auth.
4. **Core product UI** — Today, Inbox, Deals, Deal Detail, Ask TipTop, Portfolio,
   Knowledge, Tasks, Settings, Diagnostics.
5. **AI layer** — Anthropic server adapter, model config, versioned prompts,
   structured outputs, extraction, analysis, outlook, tool-use chat, draft
   generation, injection defences, deterministic mock provider.
6. **Gmail & Calendar** — provider interfaces, Gmail REST adapter, Calendar REST
   adapter, OAuth flow, incremental sync, disconnect/revoke/delete.
7. **Knowledge & retrieval** — upload, extraction, page-aware chunking,
   PostgreSQL FTS, retrieval-provider interface, network CSV import.
8. **Deal & portfolio workflows** — dedupe, configurable scorecard, corrections,
   tasks, drafts, comparisons, portfolio requests, decisions, memo export.
9. **Security, performance, resilience** — review, rate limits, budgets,
   content-hash caching, audit events, error handling.
10. **QA & handoff** — full suite, production build, demo run, docs.

## 3. Architecture in one paragraph

Next.js App Router with a strict service/adapter split. Route handlers and
server actions do authentication, validation and nothing else; they delegate to
services in `src/lib/**`. Every external system sits behind an interface with at
least two implementations (real + demo/mock), selected once in a factory. The
data layer is a `DataStore` interface implemented by `SupabaseStore` (Postgres +
RLS) and `DemoStore` (file-backed, fixture-seeded). The AI layer is an
`AIProvider` interface implemented by `AnthropicProvider` and `MockAIProvider`.
This is what makes "works end to end without credentials" true rather than
aspirational.

## 4. What is deliberately *not* built

- Sending email. Gmail scopes are read-only; the app produces drafts only.
- Vector/embedding retrieval. The `RetrievalProvider` interface exists and
  Postgres FTS implements it; an embedding implementation is a documented,
  additive extension.
- Multi-provider mailboxes. `EmailProvider` is provider-agnostic; only Gmail is
  implemented, per the brief.
- Any deployment, publish, push, purchase or real email send.
