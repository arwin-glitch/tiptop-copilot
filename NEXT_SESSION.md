# NEXT SESSION — publish TipTop Copilot

**Paste `PROMPT.md` into the new chat. This file is the detail behind it.**

The build is finished and verified. What remains is deployment, and deployment
is blocked on things only Arwin can provide. Read §1 before doing anything else
— it is the difference between a productive session and forty minutes of
discovering the same wall.

---

## 0. Environment — nothing works without this

**Node.js is not installed system-wide.** A portable Node 24.19.0 lives at
`E:\_toolchain\node-v24.19.0-win-x64\`.

Prefix **every** shell command with:

```powershell
$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"
```

- Shell is **Windows PowerShell 5.1**. No `&&`, no `??`, no ternary. Use `;`
  and `if ($?) { }`.
- **Python is not installed.**
- Project root is **`E:\tiptop-copilot`**. Never write to `E:\` — it is a
  personal drive root with ~200 unrelated files.
- `E:\tiptop-vc-perks` is an unrelated static site. Leave it alone.

---

## 1. Publishing is blocked — read this first

### 1a. No deployment tooling is installed

Verified on this machine:

| Tool | Status |
| --- | --- |
| `git` | installed (`/mingw64/bin/git`) |
| `gh` | **not installed** |
| `vercel` | **not installed** |
| `netlify` | **not installed** |
| `docker` | **not installed** |

The repository has **local commits on `master`, no remote, and no configured git
identity** (commits so far used a per-command `-c user.name`). Run
`git log --oneline` for the current count.

So before anything can be pushed or deployed, someone has to either install a
CLI and authenticate it, or do the deploy through a web dashboard.

### 1b. Credentials that cannot be generated from inside the repo

Nothing in the codebase can produce these. They are the real blocker.

| # | What | Where it comes from |
| --- | --- | --- |
| 1 | Supabase project URL, anon key, **service role key** | A new Supabase project |
| 2 | `ANTHROPIC_API_KEY` | console.anthropic.com |
| 3 | Google OAuth client ID + secret | Google Cloud Console |
| 4 | A production domain | Wherever DNS lives |
| 5 | A hosting account (Vercel or equivalent) | Signup + auth |
| 6 | A GitHub account/remote, if the deploy is git-based | github.com |

These three you generate locally — commands are in `.env.example`:

```powershell
$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"     # APP_ENCRYPTION_KEY (must be 32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # CRON_SECRET
```

Store all three in a password manager **before** pasting them anywhere. Losing
`APP_ENCRYPTION_KEY` means every Google connection has to be re-established —
there is no re-encryption path, by design.

### 1b-2. Can this be published for free?

**Yes — but only one of the two things you might mean by "publish" is free.**

Decide which you want *before* picking a host; they need different setups.

#### Path A — publish the demo. Genuinely free, and quick.

Demo mode needs **no Supabase, no Google OAuth and no Anthropic key.** It runs
on the file-backed store and the deterministic offline model. Every screen
works. So it can go on any free tier with two environment variables:

```
DEMO_MODE=true
NEXT_PUBLIC_DEMO_MODE=true
SESSION_SECRET=<generate one, so sessions survive a restart>
```

Caveats that matter:

- **Demo mode has no authentication.** Anyone with the URL gets a workspace.
  Every company, person and number is fictional, so there is nothing to leak —
  but do not put a real deal in it.
- The demo store is a file on disk. On a serverless host that filesystem is
  ephemeral, so edits reset on redeploy or cold start. Fine for a demo, and it
  is why the fixtures reseed automatically.

This is the fast win. If the goal is "somewhere I can show people", stop here.

#### Path B — publish it for real. Not free.

The unavoidable cost is **the Anthropic API**: it is pay-per-token with no free
production tier. Everything else has a free option, with real limitations:

- **Supabase free tier** — 500 MB, and the project **pauses after about a week
  of inactivity**, and has **no point-in-time recovery**. A fund's deal history
  on a tier with no PITR is a bad trade; `SUPABASE_SETUP.md` §9 says so already.
- Google OAuth is free.

So Path B is "cheap", not "free". The honest number is: Anthropic usage, plus a
Supabase plan once the data matters.

#### Host options

Verify current terms before committing — these change.

| Host | Free tier | The catch |
| --- | --- | --- |
| **Vercel** | Hobby | **Hobby is non-commercial use only.** Best Next.js support by a distance, but see the note below. |
| **Netlify** | Yes | Commercial use permitted. Next.js support via adapter; good, not seamless. |
| **Cloudflare Workers/Pages** | Generous | Commercial permitted. Needs OpenNext, and this app uses Node APIs (`node:crypto`, `pdfjs-dist`, `mammoth`, `jszip`) so `nodejs_compat` must be on and PDF extraction wants testing. |
| **Render** | Yes | Commercial permitted. Free services **spin down when idle** — first request after a pause is slow. |

#### On "it's only two of us"

This comes up, and it is the wrong axis. A non-commercial term keys on
**commercial character, not audience size**. The question is not how many people
log in — it is whether the deployment is being used to run a business. A
two-person internal tool that triages a fund's deal flow is commercial use; a
public portfolio site with fifty thousand visitors is not.

Not legal advice, and terms change — check the current wording rather than
trusting this note.

**Recommendation:** it does not matter much, because the alternatives are free
*and* unrestricted. Render and Netlify permit commercial use on their free
tiers, so sidestepping the question costs nothing but Vercel's smoother Next.js
integration. Put Path A on Render or Netlify today; move to a paid plan when
Nick's real mailbox is connected and it is doing real work.

Path A is arguably evaluation rather than production use, so the stakes there
are low either way. Path B is where it would actually matter.

### 1c. The one setting that matters most

`DEMO_MODE` **must be false or unset in production.** Demo mode has no real
authentication: anyone who reaches the URL gets a workspace. It is the single
most consequential line in the environment.

### 1d. Order of operations

Deployment cannot be done in one step. The sequence that works:

1. Create the Supabase project, apply the eight migrations, verify RLS →
   [SUPABASE_SETUP.md](SUPABASE_SETUP.md)
2. Create the Google OAuth client (**Internal** user type) →
   [GOOGLE_OAUTH_SETUP.md](GOOGLE_OAUTH_SETUP.md)
3. Set every variable in the host's environment UI →
   [ENVIRONMENT_VARIABLES.md](ENVIRONMENT_VARIABLES.md)
4. Deploy
5. Walk [PUBLISH_CHECKLIST.md](PUBLISH_CHECKLIST.md) §6–§7 against the live URL

Steps 1 and 2 involve web dashboards and cannot be automated from here.

---

## 2. Current state — verified, not claimed

Every command below was run and observed to pass, twice for the e2e suite.

```powershell
$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"
Set-Location "E:\tiptop-copilot"

npm run verify        # format:check + lint + typecheck + 423 tests + build
npm run test:e2e      # 38 tests (needs `npm run test:e2e:install` once)
npm run dev:demo      # the whole product, no credentials
```

| Check | Result |
| --- | --- |
| `format:check` | pass |
| `lint` | pass, 0 problems |
| `tsc --noEmit` | pass |
| `npm test` | **423 passed**, 22 files |
| `npm run build` | pass |
| `npx playwright test` | **38 passed** (17 demo flow, 21 mobile/a11y) |

Working tree is clean. All work is committed on `master`. Nothing pushed
anywhere.

---

## 3. What the previous session did

Started from a state where ~115 files existed but **nothing had ever been run**
except a typecheck.

### Validations
`lint` needed four fixes (two `react-hooks/set-state-in-effect`, two unused
imports). `format:check` needed one `npm run format`. `build` passed first time.

### Tests written
- **12 unit files** — scoring, recommendation, dedupe, token-crypto,
  prompt-injection, citations, cost-limits, extraction-schema,
  classification-schema, attachments, env-boundary, time, text
- **9 integration files** — gmail-sync, email-to-deal, deal-analysis, brief,
  chat-tools, drafts, authorization, integration-disconnect, portfolio
  (portfolio was added beyond the original list: invariant 9 had no coverage)
- **2 Playwright specs** — the 13-step demo flow, and mobile/accessibility

No snapshot tests. Every invariant maps to a test in
[TESTING.md](TESTING.md) §1.

### Nine defects the tests found, all fixed

1. **`/login` was statically prerendered.** A build made without `DEMO_MODE`
   froze "authentication is not configured" into the HTML — `npm run start:demo`
   could not get past it. **This blocked the entire demo.**
2. **Demo entry threw on rate limit.** Capped at 20/min on a single global key,
   and tripping it rendered a dead-end server error page. Now 60/min, and it
   redirects back with an explanation.
3. **A repeated forced sync crashed.** It updated a `sync_runs` id the upsert
   had never inserted — the opposite of "idempotent by construction".
4. **`startOfDayUtc` was an hour out on DST changeover days.** It measured the
   offset at noon and applied it to midnight, so twice a year "today" pulled in
   yesterday's 23:00 event or missed today's 00:30 one.
5. **`Asia/Bengaluru` is not an IANA zone** but was in the Settings dropdown.
   Selecting it would have thrown on every date format in the app.
6. **The injection detector missed its own demo payload** — `mark this deal as
   ADVANCE` — and verb-first credential requests (`send me your api key`).
7. **`htmlToPlainText`** left a leading space on every line and could not
   produce a blank line.
8. **`overrideRecommendation` accepted an empty reason**, discarding the one
   signal the feature exists to record.
9. **The offline model's headline text** double-terminated sentences and quoted
   hard-wrapped *lines* rather than sentences, so every quote stopped
   mid-clause. Cosmetic, but it is the first thing a viewer reads in the demo.

Reasoning for each is in [DECISIONS.md](DECISIONS.md) D-039–D-045.

### Docs written
All twelve: `ARCHITECTURE`, `SECURITY`, `DATA_MODEL`, `AI_PROMPTS`, `TESTING`,
`ENVIRONMENT_VARIABLES`, `SUPABASE_SETUP`, `GOOGLE_OAUTH_SETUP`,
`PUBLISH_CHECKLIST`, `PRIVACY`, `CHANGELOG`, `.env.example`. `README.md` was
replaced — it was still the `create-next-app` scaffold.

---

## 4. Non-negotiable invariants — do not regress these

Every one has at least one test that fails if it is broken. Several are enforced
at the database level.

1. **Unknown stays unknown.** No defaults, no `N/A`, no inference-as-value.
2. **Unscored is not zero.** An unevidenced category is excluded from the
   normalised score.
3. **The model proposes; the code decides.** `deriveRecommendation()` applies
   the configured thresholds. The model may argue *down*, never up.
4. **A hard red flag caps, it does not veto.** The score is untouched, so
   resolving the flag restores the recommendation with no re-analysis.
5. **The AI cannot mark a deal invested.** Absent from the enum;
   `deal_decisions.actor` has `check (actor = 'human')`.
6. **No send capability.** No `gmail.send` scope; `generated_drafts.sent` has
   `check (sent = false)`; there is deliberately no `sendDraft()`.
7. **Untrusted content is fenced, never obeyed.** Detection annotates — a false
   positive must not make an email invisible.
8. **No fabricated citations.** Unknown source ids are dropped and audited.
9. **No introductions to people who do not exist.**
10. **Corrections are additive.** `deal_facts` is append-only.
11. **No `dangerouslySetInnerHTML`** except one audited theme script.
12. **Sync is idempotent by construction.**
13. **No invented investment parameters.**

The demo fixtures contain a **deliberate prompt-injection payload** in the
Plumbline intro email. It is there to be demonstrated, not removed.

---

## 5. Next.js 16 — do not "correct" these to Next 15

- `middleware` is **`proxy`** — `src/proxy.ts`, exporting `proxy()`
- `cookies()`, `headers()`, `params`, `searchParams` are **async**
- `next lint` is removed; `npm run lint` calls the ESLint CLI directly
- Version-matched docs ship at `node_modules/next/dist/docs/`
- Any page depending on runtime env needs `export const dynamic =
  'force-dynamic'` — reading `process.env` is not a signal Next can see, which
  is exactly how defect #1 happened

---

## 6. Open items

- **No CI.** No `.github/workflows/`, no husky, no git hooks. The 461 tests only
  run when someone types the command. A workflow is ~20 lines (checkout,
  `npm ci`, `npm run verify`, `npm run test:e2e` with
  `npx playwright install --with-deps chromium`) but needs a GitHub remote
  first, and an unverified workflow file is worse than none.
- No penetration test, no load testing, no automatic retention policy.
- Prompt injection is **mitigated, not solved** — see [SECURITY.md](SECURITY.md)
  §10. The real guarantee is that the AI has no capability worth hijacking.

---

## 7. Boundaries

The previous session was told not to deploy, push, purchase or send. **Arwin has
now authorised publishing.** Everything else still stands:

- Do not purchase anything without explicit confirmation of the specific cost.
- Do not send email.
- Do not write outside `E:\tiptop-copilot`.
- Confirm before the irreversible steps: creating a public repository, the first
  deploy to a real domain, and anything that spends money.
