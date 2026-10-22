# The public job board

Open roles at TipTop's portfolio companies, for anyone to see: candidates,
the network, a post on LinkedIn. Like the Perks directory (perks.tiptop.vc),
in its look, and like the job boards other funds run, in what it does:
search, filters, featured roles, a page per role and per company, and every
application going straight to the company. Decision D-077.

- **Copilot:** Portfolio › Jobs. A "Public job board" bar sits on every Jobs
  view with **View public board** (opens it in a new tab), **Copy link**, the
  on/off switch, **Preview** (while it is off) and **Board text**. The views:
  - **From email**: the roles founders email Nick (the weekly jobs scan),
    as before.
  - **Approvals**: those emailed roles as drafts. None is public until a
    person approves it.
  - **Public board**: every role and whether it is public; Publish, Hide,
    Feature, Mark filled, Edit, **Add a role**, **Refresh now**.
  - **Companies**: each portfolio company's careers page, the job board read
    from it, the daily read, auto-publish, "list it even with no open roles",
    the public logo and about, and the last read's result.
- **Public:** `/jobs` on copilot.tiptop.vc, and the same pages at the root of
  jobs.tiptop.vc once its DNS points here (below).

## How a role gets on the board

| Where it comes from | Public when |
| --- | --- |
| A company's own job board (Greenhouse, Lever, Ashby, Workable, Recruitee), read daily and by Refresh now | a person publishes it, or turned that company's auto-publish on |
| A founder's email to Nick (the jobs scan) | a person approves that role. Always. |
| Added by hand | the person adding it publishes it |

And, for every role: the board is on, the role is open, nobody hid it, and it
has an apply link (its own, or its company's careers page). Hide is sticky: a
hidden role stays off whatever later reads of its job board say. Turning
auto-publish off takes down the board roles nobody published one by one.

What a visitor sees of a role: title, company, team, places, remote or
on-site, type, level, pay only where the company publishes it (or a person
typed it), the description, and the apply link. Of a company: name, website,
logo, the public about, sector, its open roles. Nothing else: never an email
address, a contact, a founder's note, a source email or who approved what.

## Reading companies' job boards

Give a company its careers page on Companies. Copilot reads which job board it
is on from the address (`jobs.lever.co/acme`, `boards.greenhouse.io/acme`,
`jobs.ashbyhq.com/acme`, `apply.workable.com/acme`, `acme.recruitee.com`), or
from the careers page itself when it embeds or links to one (fetched once,
robots.txt obeyed, public hosts only). Then it reads that board's documented
public job list once a day (the daily job's full runs, not the frequent
mail-only ones) and whenever someone taps Refresh now: new roles are added,
changed ones updated, and the ones the board no longer lists are closed.

Being a good guest: robots.txt is read and obeyed per host (and its crawl
delay), calls to one host are at least half a second apart, every call has an
8 second timeout and a size cap, a host that answers 429 is left alone for
its Retry-After (10 minutes by default), Refresh now reads one company at
most once a minute, and one company failing never touches another. A board
answer that is not in the documented shape, a 404 or a timeout changes
nothing (it is never read as "every role closed"). Ashby roles marked
unlisted are skipped. Demo mode never calls out.

## Caching, speed and search engines

The public pages are cached by Next (incremental static regeneration): built
on first visit, rebuilt at most every 10 minutes, and at once whenever
someone changes the board in Copilot or a sync changes roles. A build with
no database to read (CI, a laptop) renders them per request instead, so
nothing stale is baked in. Filtering runs in the browser on the list the page
already has, so searching is instant. Each role page carries JobPosting
structured data (Google for Jobs), a canonical link, Open Graph tags and a
generated preview image; the board has a sitemap (`/jobs/sitemap.xml`, or
`/sitemap.xml` on its own host). Copilot's own `robots.txt` disallows
everything but `/jobs`; the board host's allows everything. While the board
is off every page says "coming soon", is marked noindex, and the sitemap is
empty.

The free Render plan sleeps after 15 minutes without traffic. A cached page
is served as soon as the server is up again, but the wake-up itself (around
30 to 60 seconds) is not something caching can hide; a paid instance, or a
ping every 10 minutes, would.

## Setting it live

1. **Apply the migration.** Run `supabase/migrations/20261022100000_public_jobs.sql`
   in the Supabase SQL editor (additive and safe to run again). Until then
   Portfolio › Jobs says the board needs it and the public pages say "coming
   soon". Check: the three tables exist with row-level security on.
2. **Fill it.** On Portfolio › Jobs › Companies, add each company's careers
   page; turn on auto-publish only for companies whose own public job board
   should flow straight through. Approve emailed roles on Approvals. Add
   roles by hand where a company has no board. Use **Preview** to see the
   board as visitors will.
3. **Turn it on** with the switch in the bar. `/jobs` is live at once.

### jobs.tiptop.vc

The app already serves the board at the root of `jobs.tiptop.vc` (the proxy
rewrites that host to the board's pages, and nothing else of Copilot is
reachable there). To point the name at it:

1. **Render:** the Copilot web service › Settings › Custom Domains › Add
   `jobs.tiptop.vc`. Render shows the target to point at (the service's
   `onrender.com` host) and issues the certificate once DNS resolves.
2. **GoDaddy** (DNS for tiptop.vc, as for perks.tiptop.vc): add a record
   `CNAME`, name `jobs`, value the Render target from step 1, TTL default.
   Do not touch the root `tiptop.vc` or `www` records (they point to Framer).
3. Wait for Render to show the domain as verified with a certificate.
4. **Render environment:** set `JOBS_BOARD_URL=https://jobs.tiptop.vc` and
   redeploy. Canonical links, the sitemap and Copilot's "View public board"
   button then use the short address; `copilot.tiptop.vc/jobs` keeps
   working.
5. Check `https://jobs.tiptop.vc/`, a role page, `/sitemap.xml` and
   `/robots.txt`; then submit the sitemap in Google Search Console if wanted.

Another host can be added the same way (`JOBS_BOARD_HOSTS`, comma separated).
No Google sign-in redirect is involved: the board has no sign-in.

## Not in this version

- Job alerts and a talent network (they would collect visitors' email
  addresses, which needs consent and a privacy notice of its own).
- Company stage, size and industry filters (the portfolio data has stage but
  it is not public information by default).
- Greenhouse EU and Lever EU boards, BambooHR and SmartRecruiters.
