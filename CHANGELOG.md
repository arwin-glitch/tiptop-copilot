# Changelog

Notable changes to TipTop Copilot. Newest first.

Versions follow [semantic versioning](https://semver.org). Until 1.0 the schema
may change between minor versions; migrations are additive and idempotent
throughout.

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
