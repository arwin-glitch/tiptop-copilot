# HANDOVER — TipTop Copilot, design and next phase

**Paste `DESIGN_PROMPT.md` into the new chat. This file is the detail behind it.**

Written 10 August 2026, at the end of the session that took this from a local
build to a live deployment on real data.

---

## 0. Environment — nothing works without this

**Node is not installed system-wide.** A portable Node 24.19.0 lives at
`E:\_toolchain\node-v24.19.0-win-x64\`. Prefix every shell command:

```powershell
$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"
```

- Shell is **Windows PowerShell 5.1**. No `&&`, no `??`, no ternary.
- **Python is not installed.** `sharp` is available in `node_modules` and was
  used to generate the app icons.
- Project root is **`E:\tiptop-copilot`**. Never write to `E:\` — it is a
  personal drive root with ~200 unrelated files.

**This is Next.js 16.** `middleware` is **`proxy`** (`src/proxy.ts`);
`cookies()`, `headers()`, `params`, `searchParams` are **async**; `next lint`
is gone. Version-matched docs ship at `node_modules/next/dist/docs/`. Do not
"correct" these to Next 15 patterns.

---

## 1. What is live

| | |
| --- | --- |
| **Real app** | https://tiptop-copilot.onrender.com — Nick's actual mailbox |
| **Demo** | https://tiptop-copilot-demo.onrender.com — fictional data, no login |
| **Repo** | github.com/arwin-glitch/tiptop-copilot — **public** |
| **Database** | Supabase `zkpdrgcemkutfubpgmxw`, Ohio, free tier |
| **Hosting** | Render, two free services, Ohio |

`npm run verify` (format, lint, typecheck, **473 tests**, production build) and
`npm run test:e2e` (**38 tests**) both pass. CI runs on every push.

**Both Render services sleep after 15 minutes idle.** First request takes ~50s.
That is the free tier, not a bug.

### Configured

Google sign-in restricted to `@tiptop.vc`; Gmail and Calendar connected
read-only to `nick@tiptop.vc`; Gmail push via Cloud Pub/Sub; a daily job at
11:00 UTC that renews the push registration and generates the outlook.

### Deliberately not configured

**`ANTHROPIC_API_KEY` is unset.** Every AI surface reports itself unavailable
rather than guessing. This is a decision, not an oversight — see §4.

---

## 2. What happened today, and why it matters to you

The app had never been run against anything real. Every failure came from that.
In order:

1. **There was no sign-in code.** `/login` linked to `/api/auth/google`, which
   did not exist. Built it (Supabase Auth + Google), plus the domain gate the
   database lacks.
2. **The migrations could not be applied** — a `language sql` function read a
   table created in the next file.
3. **A generated column used `array_to_string`**, which is STABLE, so the
   schema would not compile.
4. **Three wrong environment values**, each failing opaquely.
5. **No grants** — sign-in worked, then the first query said `permission
   denied`.
6. **A redirect loop** that took four rounds and three wrong diagnoses. Cause:
   Supabase chunks its auth cookie past 4KB and the proxy tested
   `endsWith('-auth-token')`, which no chunk matches.

**The lesson, which applies directly to your phase:** all 467 tests passed
throughout, because `tests/setup.ts` forces `DEMO_MODE=true` for the entire
suite. Everything that had never executed was where the problems were. When you
change the shell, the navigation or the theme, the e2e suite runs in demo mode
too — it will not tell you whether the real app still renders.

---

## 3. The invariants — do not regress these

Each has a test, and several are database constraints. They are the product's
actual argument, not decoration.

1. **Unknown stays unknown.** No defaults, no `N/A`, no inference-as-value.
2. **Unscored is not zero.** An unevidenced category is excluded from the
   normalised score, not counted as failure.
3. **The model proposes; the code decides.** `deriveRecommendation()` applies
   the configured thresholds. The model may argue *down*, never up.
4. **A hard red flag caps, it does not veto.** The score is untouched.
5. **The AI cannot mark a deal invested.** `deal_decisions.actor` has
   `check (actor = 'human')`.
6. **No send capability.** No `gmail.send` scope; `generated_drafts.sent` has
   `check (sent = false)`; there is deliberately no `sendDraft()`.
7. **Untrusted content is fenced, never obeyed.** Detection annotates; a false
   positive must not make an email invisible.
8. **No fabricated citations.** Unknown source ids are dropped and audited.
9. **No introductions to people who do not exist.**
10. **Corrections are additive.** `deal_facts` is append-only.
11. **No `dangerouslySetInnerHTML`** except one audited theme script.
12. **Sync is idempotent by construction.**
13. **No invented investment parameters.**

**Two that will bite a redesign specifically:**

- Every AI-derived surface has a **"not configured"** state that is currently
  visible in production, because there is no API key. These are not edge cases
  to be styled last — right now they are the *primary* state of `/today`,
  `/ask`, and every scorecard. Brief item 7 asks for polished "not configured"
  states; here they are load-bearing.
- The **`role="status"` demo banner** is asserted by the accessibility suite.
  Restyling the shell must keep it announced.

---

## 4. Cost, which constrains design more than it looks

`ANTHROPIC_API_KEY` is unset by choice. With it:

- classification ≈ $0.0025/email (haiku tier)
- the daily outlook ≈ one opus call each morning
- realistically **$5–15/month** for one mailbox

Arwin has not yet decided to spend it. **So design for a product whose
intelligence layer may be off.** An interface that only looks good full of
AI-generated content will look broken in its actual current state.

---

## 5. The design brief — read §6 before believing all of it

The brief Arwin wrote is in `DESIGN_PROMPT.md`, verbatim. It is a good brief.
It also names several things that **do not exist in this codebase**, and a
session that takes it at face value will waste hours looking for them.

---

## 6. Brief versus reality — verified against the code

| Brief mentions | Reality |
| --- | --- |
| "intelligence dashboard", "charts, trends, comparisons, compact data visualizations" | **There are no charts anywhere.** The only `<svg>` in `src/` is the wordmark. No charting library is installed. This is a new feature, not a restyle. |
| "public job board" | **Does not exist.** No route, no table, no reference anywhere. Entirely new. |
| "portfolio intelligence feed", "signals" | Partially. `market_signal` exists as a *brief item type*, and `market_signals` in the daily outlook — but it needs web research, which is disabled (`RESEARCH_PROVIDER=none`), so it currently renders "Web research not configured". There is no standing feed. |
| "hiring activity" | `portfolio_companies.hiring_needs` is a single text field. There is no hiring feed or timeline. |
| "source health" | No such concept. The nearest thing is `/diagnostics`, which reports capability configuration. |
| "saved views, column controls, sticky headers" | None of these exist. Tables are simple lists. |
| "global search, shortcuts" | No global search, no keyboard shortcut layer. Per-section search exists (Postgres full-text). |

**Roughly half the brief is a redesign of what exists. The other half is new
product.** Say which is which before starting, and get Arwin to choose an
order — otherwise the estimate will be wrong by a factor of several.

### What does exist to design against

Routes: `/today`, `/inbox`, `/deals`, `/deals/[id]`, `/ask`, `/portfolio`,
`/portfolio/[id]`, `/knowledge`, `/tasks`, `/settings`, `/diagnostics`,
`/login`, `/privacy`, `/offline`.

Design system today: Tailwind 4 with CSS custom properties in
`src/app/globals.css` — `--bg`, `--bg-raised`, `--bg-sunken`, `--fg`,
`--fg-muted`, `--fg-subtle`, `--border`, `--accent`, plus semantic
`--ok/--warn/--danger/--info` and a recommendation palette. Light and dark are
both defined. Radix primitives are installed for dialog, popover, select, tabs,
tooltip, dropdown, accordion, switch, separator, label.

**The brand is already applied** and should be preserved: palette from TipTop's
own guide (`#241B1B` ink, `#2B6D56` green, `#0FC382` bright green, `#84DBE0`
blue accent, `#FAF8F6` paper), and the real brandmark drawn in `currentColor`
in `src/components/brand/wordmark.tsx`.

**Two colour facts worth not rediscovering:** `#0FC382` is 2.2:1 on paper and
must never be text on a light background — it is the dark-theme accent and a
fill. And the brand's `#241B1B` is the dark theme's *surface*, not its page,
because a dark UI needs the page to sit beneath its panels.

---

## 7. Open items, honestly

- **The Gmail push round trip has never fired.** Registration returns
  `"watch":"registered"`; nothing has verified an actual notification arriving.
- **`network_contacts` is empty**, so introduction suggestions cannot work.
  Affinity, LinkedIn and Granola were all discussed; none are built. See the
  end of this file.
- **No CI job applies the migrations against a real Postgres.** That is the one
  class of check that would have caught today's schema failures.
- **The repo is public.** Nothing sensitive is committed, but the schema and
  prompts are readable by anyone.
- **The free tiers are wrong for real data long-term.** Supabase free has no
  point-in-time recovery and pauses after a week idle. Render free sleeps.
  Roughly $32/month fixes both.

### The Brain

There is a second system — an Obsidian vault of ~930 wiki pages on Nick's
machine, holding TipTop's institutional memory, including the full Affinity
corpus and 2,177 Granola meetings. The agreed architecture is that the Brain
stays canonical and projects into this app's Postgres. `BRAIN_INTEGRATION.md`
(local only, gitignored — the repo is public) holds the Copilot-side response.

**Relevant to you:** Arwin wants Affinity, LinkedIn messages via Kondo, and
every Granola meeting connected. None are built, and the architecture argues
they should arrive through the Brain projection rather than through three new
ingestion paths.

---

## 8. Rules

- **Do not regress the invariants in §3.** Several are database constraints. If
  something seems to require breaking one, stop and ask.
- **Do not send email.** Ever.
- **Do not spend money** without telling Arwin the specific amount first.
- **Do not write outside `E:\tiptop-copilot`.**
- **Never commit a secret.** The repo is public. Secrets live in Render's
  environment and are referenced by name only.
- **The demo's prompt-injection fixture is deliberate.** Leave it.
- **Verify before claiming.** `npm run verify` and `npm run test:e2e` both pass
  today. Keep them passing, and do not report a screen as working because it
  compiles.
