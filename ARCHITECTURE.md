# Architecture

How TipTop Copilot is put together, and why it is put together that way.

---

## 1. The organising idea

Every external boundary is an interface with two implementations — a real one
and an offline one — and the choice is made in exactly one place,
`src/lib/runtime.ts`.

| Interface | Real | Offline |
| --- | --- | --- |
| `DataStore` | `SupabaseStore` (Postgres + RLS) | `DemoStore` (file-backed JSON) |
| `AIProvider` | `AnthropicProvider` | `MockAIProvider` (deterministic) |
| `EmailProvider` | `GmailProvider` (REST) | `MockEmailProvider` (fixtures) |
| `CalendarProvider` | `GoogleCalendarProvider` | `MockCalendarProvider` |
| `ResearchProvider` | `AnthropicResearchProvider` / `CustomSearchProvider` | `NoResearchProvider` |
| `StorageProvider` | `SupabaseStorageProvider` | `LocalStorageProvider` |

This is what keeps `if (demoMode)` out of business logic. A service asks for a
store and gets one; it never asks which kind.

The offline model is the part that makes this more than a stub. `MockAIProvider`
parses the same `<context>` JSON block and the same `<untrusted-content>` fences
the real provider receives, and derives its scores and citations from the actual
fixture text. So the demo — and the whole integration suite — exercises the real
grounding, citation-validation and threshold paths. A canned-string mock would
have made every one of those tests vacuous.

---

## 2. Layers

```
  src/app/                 Routes, pages, server actions, API handlers
  src/components/          UI. Server components by default; 'use client' only
                           where interaction genuinely requires it.
  src/lib/services/        Business logic. The only layer that composes.
  src/lib/{ai,db,email,    The boundaries. Interfaces plus implementations.
    calendar,storage,
    research}
  src/lib/{security,       Cross-cutting: crypto, redaction, injection defence,
    config,util}           limits, audit, env, time, text.
  src/lib/types/domain.ts  The shared vocabulary. No layer defines its own.
```

The dependency direction is strictly downward. A service may import a boundary;
a boundary never imports a service. The one deliberate exception is
`src/lib/ai/tools/registry.ts`, which imports services because its whole purpose
is to expose them to the model — it is an adapter, not a boundary.

### Why services and not an ORM

`DataStore` is narrow and table-shaped on purpose. It fetches and writes rows;
it does not model relationships or generate queries. That keeps the second
implementation (`DemoStore`) tractable — an ORM-shaped interface would have made
an offline implementation a research project — and it keeps every decision that
matters in `src/lib/services/`, where it can be read and tested.

Organization scoping is a **parameter** on every read and write, not a
convention. Both implementations enforce it. In Supabase, RLS is the second
gate; see [SECURITY.md](SECURITY.md).

---

## 3. Request flow

A typical page:

```
  Route (server component)
    → requireAuth()                  session cookie → AuthContext
    → service call                   e.g. gatherTodayData(auth)
        → getStore()                 the DataStore for this deployment
        → getAI()                    the AIProvider for this deployment
        → checkAiBudget()            persisted-usage ceiling, before the call
        → recordAiUsage()            after, success or failure
        → recordAudit()              anything consequential
    → client component               only for interaction
```

Mutations go through server actions in `src/app/actions/`, not API routes, so
Next's built-in Server Action origin check acts as CSRF protection. API routes
exist only where something other than the app is the caller: OAuth callbacks,
cron, file signing, health.

---

## 4. The AI layer

The division of labour is the point:

> **The model reads and judges. The code counts and decides.**

`analyzeDeal()` asks the model to score each category against the evidence and
to cite it. Then `computeScorecard()` does the arithmetic and
`deriveRecommendation()` applies the configured thresholds. The model's own
recommendation is used only to break ties *downward*.

That split buys three things: the recommendation is reproducible, it responds to
thresholds the user configured rather than to the model's mood, and the whole
decision rule is testable without a model in the loop.

### Structured outputs

Every structured call carries a Zod schema. The same schema is converted to JSON
Schema (`toModelJsonSchema()`) and sent as `output_config.format`, so the model
is constrained on the way out and validated again on the way in. A response that
does not validate is a typed `invalid_model_output` failure and never reaches
business logic.

`toModelJsonSchema()` inlines `$ref`s and strips the keywords Anthropic's
structured outputs reject (`minLength`, `pattern`, `format`, …), because Zod 4
emits draft-2020-12 and the API accepts a subset.

### Tools

The model's only route to data is `src/lib/ai/tools/registry.ts`: eighteen
allowlisted tools, each with a Zod input schema, each re-deriving organization
scope from the `AuthContext` rather than trusting an argument. Write tools are a
short list — `create_task`, `save_note`, `create_draft_reply`,
`generate_deal_analysis` — and none of them can record a decision, mark a deal
invested, or send anything.

An unknown tool name, an input that fails validation, or a write attempted while
writes are disabled returns an error *to the model* rather than throwing. The
model can then correct itself, and the failure is visible in the transcript
instead of collapsing the answer.

### Citations

Every tool that surfaces a record registers a `Citation` for it. When the model
returns source ids, `CitationRegistry.resolve()` drops any it never issued and
reports them; the caller writes a `security.citation_rejected` audit event. A
fabricated citation is the failure mode most likely to make a wrong answer look
trustworthy, so it is handled structurally rather than by prompting.

Model-supplied page numbers are only trusted for source kinds that have pages.
An email cannot acquire page 4.

### Cost

`checkAiBudget()` runs before every model call, against persisted `ai_usage`
rows rather than in-process counters, so the ceiling holds across instances. A
small in-process cache short-circuits obvious denials — it can only ever *deny*
faster, never grant what the database would refuse.

---

## 5. Content safety

Untrusted text — email bodies, attachments, uploaded documents, web results —
goes through `fenceUntrusted()`, which wraps each block in
`<untrusted-content source-id="…">` and carries the citation id the model must
use to reference anything inside. Every prompt that includes such a block is
prefixed with `UNTRUSTED_CONTENT_RULE`.

The structural controls:

- **Fencing.** The system prompt states that anything inside a fence is data.
- **Escape neutralisation.** A closing fence marker inside the body is replaced,
  and zero-width/bidi characters are stripped, so the block cannot be broken
  out of.
- **Attribute escaping.** A hostile label cannot inject a second attribute.
- **Annotation, never suppression.** A detected attempt adds a security note to
  the block and a badge in the UI. The full text stays visible and the message
  stays in the inbox. A false positive must not make an email invisible.

The detector (`scanForInjection`) is a defence in depth, not the defence. The
fence is the defence.

---

## 6. Data flow: an email becomes a deal

```
  syncMailbox()
    provider.listMessages()            metadata only
    upsert on (org, provider, provider_message_id)      ← idempotent by key
    classifyMessage()                  fast model, snippet only
      └ deterministic injection scan is authoritative for the flag;
        the model's opinion can add to it, never clear it
    fetchFullMessage()                 only if warranted or opened
      └ attachments → extractDocument() → page-marked text

  createDealFromEmail()
    findDuplicateCandidates()
      ├ exact domain match → attach to the existing deal
      └ anything softer   → create, and return candidates for a human
    extractDealFacts()                 fast model
      └ a field with no resolvable citation is not written at all
      └ each written field also appends a deal_facts row with provenance

  analyzeDeal()
    content-hash the evidence set + thesis + prompt version
      └ unchanged? return the stored analysis, spend nothing
    deep model scores each category and cites it
    code computes the scorecard, applies thresholds, derives the label
```

---

## 7. Demo mode

`DemoStore` persists to JSON on disk rather than holding state in a module
object. That is deliberate: Next.js route handlers and server components do not
share a single module instance across all requests in every runtime, so an
in-memory store would silently lose writes mid-flow and make the demo look
broken. Writes are serialised through a promise chain and land via
write-then-rename, so a crash cannot leave a half-written file.

Deleting the store file reseeds from fixtures. The e2e suite relies on that for
a clean run (`tests/e2e/global-setup.ts`).

---

## 8. Next.js 16 specifics

This is Next 16, and several things differ from Next 15 patterns:

- `middleware` is **`proxy`**. The file is `src/proxy.ts` and it exports
  `proxy()`.
- `cookies()`, `headers()`, `params` and `searchParams` are **async**.
- `next lint` is removed; `npm run lint` calls the ESLint CLI directly, with
  flat config in `eslint.config.mjs`.
- Version-matched documentation ships in `node_modules/next/dist/docs/`.

Every page that depends on runtime environment or session state declares
`export const dynamic = 'force-dynamic'`. This matters more than it looks:
`/login` decides which sign-in path to offer from runtime env, and without the
declaration it prerendered at build time — freezing "authentication is not
configured" into the HTML of any build made without `DEMO_MODE`.

`/privacy` and `/offline` are static, correctly: they read nothing.

---

## 9. PWA

`public/sw.js` caches the static shell only. It never caches authenticated HTML
or any API response — an offline cache of someone's inbox is a data-leak
surface, and a stale deal page is worse than no deal page. Offline gets you the
shell and `/offline`; everything else needs the network.

---

## 10. What is deliberately not here

- **Sending email.** Not unimplemented — out of scope. See rule 6.
- **An agent loop that acts unattended.** Every write is either a user action or
  a tool call inside a request the user initiated.
- **Vector search.** Postgres full-text search covers a single fund's document
  volume, and it has no embedding-drift or re-index problem. Revisit at a
  different order of magnitude.
- **Multi-tenant onboarding.** The schema and RLS are organization-scoped
  throughout, so it is possible; there is no signup flow because there is one
  customer.
