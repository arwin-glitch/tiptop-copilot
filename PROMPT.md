# Paste this into the new chat

Everything below the line is the prompt. Copy it whole.

**Before you send it:** have the credentials in §"What I'm giving you" ready, or
paste it as-is and answer the questions the session will ask. Without at least
Supabase and Anthropic, publishing cannot start — see `NEXT_SESSION.md` §1.

---

You are continuing work on TipTop Copilot, an internal AI application for
TipTop VC at `E:\tiptop-copilot`.

**The build is finished and verified. Your job this session is to publish it.**

## Read first

Read `E:\tiptop-copilot\NEXT_SESSION.md` before running anything. It is accurate
and current. `PUBLISH_CHECKLIST.md`, `SUPABASE_SETUP.md`,
`GOOGLE_OAUTH_SETUP.md` and `ENVIRONMENT_VARIABLES.md` are the operational
detail.

## Environment — nothing works without this

Node is not installed system-wide. Prefix every shell command with:

```powershell
$env:PATH = "E:\_toolchain\node-v24.19.0-win-x64;$env:PATH"
```

Shell is Windows PowerShell 5.1 — no `&&`, no `??`, no ternary. Python is
unavailable. Project root is `E:\tiptop-copilot`; never write to `E:\` directly.

This is **Next.js 16**: `middleware` is `proxy` (`src/proxy.ts`), and
`cookies()`/`headers()`/`params`/`searchParams` are async. Version-matched docs
are at `node_modules/next/dist/docs/`. Do not "correct" these to Next 15
patterns.

## Current state

`npm run verify` (format, lint, typecheck, 423 tests, production build) and
`npm run test:e2e` (38 tests) both pass. Five local commits on `master`, clean
working tree, **no remote**. All documentation is written.

Confirm this yourself before changing anything — do not take it on trust.

## What is blocking publication

No deployment tooling is installed on this machine: no `gh`, no `vercel`, no
`netlify`, no `docker`. Only `git`, with no remote and no configured identity.

Steps that involve the Supabase and Google Cloud dashboards cannot be automated
from here. Tell me plainly when you need me to do something in a browser, and
tell me exactly what to click.

## I want this hosted for free

Read `NEXT_SESSION.md` §1b-2 and tell me which path applies before you start.

- **Path A — publish the demo.** Genuinely free. Needs no Supabase, no Google
  OAuth and no Anthropic key: two environment variables and it runs. This is
  probably what I want first.
- **Path B — publish it for real.** Not free. The Anthropic API is
  pay-per-token with no free production tier, and the Supabase free tier pauses
  after about a week idle with no point-in-time recovery.

**Check the host's licence terms before deploying.** Vercel's Hobby plan is
non-commercial use only. Only two of us will use this, but that is the wrong
axis — a non-commercial term is about whether it runs a business, not about
audience size, and this triages a fund's deal flow. Render and Netlify permit
commercial use free, so prefer one of those and the question does not arise. If
a host would put me in breach, say so and propose another — do not just deploy
and hope.

Do not spend any money without telling me the specific amount first and getting
a yes.

## What I'm giving you

<!-- Path A (demo) needs NONE of these — leave the whole block blank.
     Path B needs all of them. Never commit this file with values in it. -->

- Supabase project URL:
- Supabase anon key:
- Supabase service role key:
- Anthropic API key:
- Google OAuth client ID:
- Google OAuth client secret:
- Production domain:
- Hosting provider and account:

Generate `SESSION_SECRET`, `APP_ENCRYPTION_KEY` and `CRON_SECRET` yourself with
the commands in `.env.example` and show them to me once so I can store them.

## What I want done

1. Verify the current state actually passes. Report what you ran.
2. Tell me, before starting: which path (A or B), which host and why, whether
   its terms permit this use, and exactly which steps need me in a browser.
3. **Path A:** deploy the demo. Confirm on the live URL that the demo banner
   shows, the Plumbline injection is flagged and unobeyed, and no screen offers
   a way to send anything.
   **Path B:** work through `PUBLISH_CHECKLIST.md` in order — database, auth,
   Google, environment, verification, deploy, first real use.
4. Set up a git remote and push, if I have given you one.
5. Add the CI workflow once a remote exists — `npm ci`, `npm run verify`,
   `npm run test:e2e`. Say plainly that it is unverified until its first run.
6. Confirm on the live URL: `/api/health` healthy, and `/diagnostics` showing no
   secret values. On Path B also confirm `DEMO_MODE` is off.

## Rules

- **On Path B, `DEMO_MODE` must be false.** Demo mode has no real
  authentication — anyone reaching the URL gets a workspace. Check this twice.
  On Path A it is deliberately on, and the fictional-data banner must be
  visible on every screen.
- Do not regress the 13 invariants in `NEXT_SESSION.md` §4. Several are enforced
  by database constraints. If something seems to require breaking one, stop and
  ask.
- The prompt-injection payload in the Plumbline demo fixture is deliberate.
  Leave it.
- Confirm with me before anything irreversible: creating a public repository,
  the first deploy to a real domain, and anything that costs money. Tell me the
  specific cost first.
- Do not send email. Do not purchase anything without my explicit yes.
- Never paste a secret into a file that gets committed. `.env.example` holds
  names only.

## Reporting

Do not claim something works unless you ran it and saw it pass. At the end, tell
me what is live, what failed, and what you still need from me.
