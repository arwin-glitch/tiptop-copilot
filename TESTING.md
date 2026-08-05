# Testing

461 tests: 423 unit and integration under Vitest, 38 end-to-end under
Playwright. Everything runs with no credentials and no network.

```bash
npm test                  # unit + integration
npm run test:unit
npm run test:integration
npm run test:e2e          # needs `npm run test:e2e:install` once
npm run verify            # format + lint + typecheck + test + build
```

---

## 1. What is being tested

The suite is organised around the product's thirteen invariants, not around
code coverage. The question asked of every test is: **would this fail if someone
regressed the behaviour?** A test that passes whatever the implementation does
is worse than no test, because it makes the suite look healthier than it is.

That rules out snapshots. There are none.

| Invariant | Where it is protected |
| --- | --- |
| 1 · Unknown stays unknown | `extraction-schema`, `email-to-deal`, e2e step 8 |
| 2 · Unscored is not zero | `scoring`, `recommendation`, `deal-analysis`, e2e step 7 |
| 3 · The code applies the thresholds | `recommendation`, `deal-analysis` |
| 4 · A hard flag caps, does not veto | `recommendation`, `deal-analysis`, e2e step 11 |
| 5 · The AI cannot mark a deal invested | `recommendation`, `extraction-schema`, `deal-analysis`, `drafts` (DB constraint) |
| 6 · No send capability | `drafts` (exports, scopes, DB constraint), e2e steps 13 and 14 |
| 7 · Untrusted content is fenced | `prompt-injection`, `email-to-deal`, e2e step 4 |
| 8 · No fabricated citations | `citations`, `chat-tools`, `deal-analysis` |
| 9 · No introductions to people who do not exist | `portfolio` |
| 10 · Corrections are additive | `email-to-deal`, e2e step 9 |
| 11 · No `dangerouslySetInnerHTML` | ESLint rule (`npm run lint`) |
| 12 · Sync is idempotent | `gmail-sync` |
| 13 · No invented investment parameters | `scoring`, e2e step 8 |

---

## 2. Unit tests — `tests/unit/`

Pure logic, no store, no harness.

| File | Covers |
| --- | --- |
| `scoring.test.ts` | Scorecard arithmetic, normalisation over attempted weight, confidence, evidence quality |
| `recommendation.test.ts` | The decision rule: thresholds, capping, model downgrade, the absence of INVESTED |
| `dedupe.test.ts` | Certainty vs suggestion; free-provider domains; signal compounding |
| `token-crypto.test.ts` | AES-256-GCM round trip, AAD binding, tampering, key versions, session signatures |
| `prompt-injection.test.ts` | Eleven pattern families, fencing, escape neutralisation, annotate-never-hide |
| `citations.test.ts` | Fabricated ids dropped; page rules; deduplication; href routing |
| `cost-limits.test.ts` | Persisted-usage budget, hourly limit, fixed-window limiter |
| `extraction-schema.test.ts` | Nullability on all 28 fields; INVESTED rejected; JSON Schema conversion |
| `classification-schema.test.ts` | Every structured output shape |
| `attachments.test.ts` | Page round trip, magic-byte sniffing, ceilings, failure recording |
| `env-boundary.test.ts` | No secret reachable from a client component; diagnostics never echo a value |
| `time.test.ts` | Timezone correctness including both DST changeover days |
| `text.test.ts` | Normalisation, HTML to text, domain handling |

`env-boundary.test.ts` is worth singling out: it walks every file in `src/`,
finds the ones marked `'use client'`, and asserts none imports a server-only
module or reads a non-public `process.env` key. It is a static check dressed as
a test, and it catches the class of mistake that is invisible until it is
deployed.

---

## 3. Integration tests — `tests/integration/`

Real services, real store, real citation validation. The only substitution is
the model provider, and that one is deterministic rather than canned.

| File | Covers |
| --- | --- |
| `gmail-sync.test.ts` | Idempotency across repeated runs; cursor and run bookkeeping; data deletion |
| `email-to-deal.test.ts` | Deal creation, duplicate handling, extraction, additive corrections, the injection payload |
| `deal-analysis.test.ts` | Persistence, the content-hash cache, every scoring invariant, human override |
| `brief.test.ts` | Candidate assembly, timezone windows, citation validity, suggestion labelling |
| `chat-tools.test.ts` | Tool refusals, deal scoping, citation registration, a full ask |
| `drafts.test.ts` | `sent: false` everywhere, no send function, no write scope, DB constraints |
| `authorization.test.ts` | Organization isolation across reads, writes, id lookups and tools |
| `integration-disconnect.test.ts` | Token encryption, revoke-and-forget under every failure mode |
| `portfolio.test.ts` | Update classification, the network-contact gate, CSV import |

### The harness

`tests/helpers/harness.ts` gives each test an isolated `DemoStore` on disk,
seeded from the same fixtures the demo uses, and injects it with
`setStoreForTesting()`. `addSecondOrganization()` adds a second tenant to the
*same store*, which is what makes the isolation assertions meaningful — every
one of them would pass trivially against separate stores.

```ts
let harness: Harness;
beforeEach(async () => { harness = await createHarness(); });
afterEach(async () => { await harness.dispose(); });
```

Files run serially (`fileParallelism: false`) because each holds filesystem
state.

---

## 4. End-to-end — `tests/e2e/`

Playwright drives a real production build in demo mode, started by the config on
port 3100.

**`demo-flow.spec.ts`** walks the thirteen demo steps in order, asserting the
behaviour behind each rather than that a page rendered: the outlook is assembled
from records and every claim carries its source; the injection is flagged,
unobeyed and fully visible; analysis is an explicit act; unscored is not zero;
unknown reads as not stated; a correction preserves the original; a hard flag
caps reversibly; Ask answers from the records; the draft is marked not sent; and
no screen anywhere offers a send control.

**`responsive.spec.ts`** runs on a Pixel 7 viewport and covers what a
desktop-only pass never catches: no page scrolls horizontally, the bottom bar is
fixed and every target is at least 44px, one `h1` and one `main` per page, the
skip link is first in tab order, `aria-current` marks the current page, every
control has an accessible name, every form control is labelled, and the theme
toggle is an operable radio group.

### Determinism

`tests/e2e/global-setup.ts` deletes `.demo-data/e2e` before the run, and the
config sets `reuseExistingServer: false`. Both are necessary: the demo store is
file-backed and the server holds it in memory, so without them the suite
inherits the previous run's state and any test asserting a starting condition
passes once and then fails for ever.

---

## 5. Writing a new test

1. **State the behaviour, not the implementation.** `it('records a category
   with no evidence as unscored, never as zero')` — not `it('returns the right
   object')`.
2. **Make it fail first.** Break the source, watch it fail, put it back. A test
   that has never failed has never been verified.
3. **Assert the consequence.** Not "the function was called" but "the row was
   not written", "the id was dropped", "the label did not move".
4. **Use the harness for anything touching data.** It is faster than mocking a
   store and it exercises the real path.
5. **Prefer role and label selectors in e2e.** They break when the page becomes
   inaccessible, which is a bug worth being told about. This project has no
   `data-testid` attributes for that reason.

---

## 6. Notes and gotchas

- **`server-only`** throws unless resolved under the `react-server` condition,
  which only Next applies. `vitest.config.mts` aliases it to
  `tests/helpers/server-only-stub.ts`. The boundary it protects is asserted for
  real in `env-boundary.test.ts`.
- **`vitest.config.mts`**, not `.ts` — Vite's native config loader treats `.ts`
  as CommonJS and warns that a future major will stop.
- **Vitest 4 has no `poolOptions`.** Use `fileParallelism: false`.
- **Test setup lives in `tests/setup.ts`** and sets `DEMO_MODE`, a well-known
  32-byte encryption key and a fixed session secret. Those are fixtures, not
  secrets; no production value is ever in this repository.
- **Fixtures ship no analyses.** `deal_analyses` starts empty on purpose, so a
  test that needs one must run the analysis — which is also what the demo does.
