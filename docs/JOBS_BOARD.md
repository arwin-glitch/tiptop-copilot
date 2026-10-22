# The public job board

Open roles at TipTop's portfolio companies, for anyone to see: candidates,
the network, a post on LinkedIn. Like the Perks directory (perks.tiptop.vc),
in its look, and like the job boards other funds run, in what it does:
search, filters, featured roles, a page per role and per company, and every
application going straight to the company. Decision D-077.

- **Copilot:** Portfolio › Jobs. A "Public job board" bar sits on every Jobs
  view with **View public board** (opens it in a new tab), **Copy link**, the
  on/off switch and **Board text**. While the board is off, the first button
  is **Preview board** (the public page only says "coming soon" until it is
  on), and a line under the title links to the emailed roles waiting on
  Approvals. The views:
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
| A founder's email to Nick (the jobs scan) | a person approves that role. Always. A link to a shared document (Google Docs, Drive, Notion, Dropbox, SharePoint) asks the approver to check that anyone can open it. |
| Added by hand | the person adding it publishes it |

And, for every role: the board is on, the role is open, nobody hid it, and it
has an apply link (its own, or its company's careers page). Hide is sticky: a
hidden role stays off whatever later reads of its job board say, including
when the board lists a role someone hid as an emailed one. Turning
auto-publish off takes down the board roles nobody published one by one.

Emailed and hand-added roles have nothing that closes them on their own, so
they stay public for 60 days after their last confirmation: the approval, or
the founder mentioning the role again in a later jobs scan. After that they
show as "Not public: still open? Re-confirm it" on Public board, and
**Still open: re-confirm** puts them back. An emailed role whose job posting
its board has dropped closes on the board too, and an emailed role is dated
from its approval, not from the founder's first mention.

What a visitor sees of a role: title, company, team, places, remote or
on-site, type, level, pay only where the company publishes it (or a person
typed it), the description, and the apply link. Of a company: name, website,
careers page, logo, the public about a person typed (Copilot's own portfolio
description is offered on Companies as "Use this text", never published by
itself; the sector is not shown), its open roles. Nothing else: never an
email address, a contact, a founder's note, a source email or who approved
what.

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

The board is read through one cached entry (Next's data cache, tag
`jobs-board`): refreshed at most every 10 minutes, and at once whenever
someone changes the board in Copilot or a sync changes roles. The fixed pages
(home, companies, sitemap) are also cached as pages; a company or role page
renders per request from that entry (a few milliseconds), so an address
someone makes up never adds a file to the server's cache. A build with no
database to read (CI, a laptop) renders the fixed pages per request instead,
so nothing stale is baked in.

The proxy answers 404 to any address that is not shaped like a board page
(`/.env`, `/wp-login.php`, three levels deep) before anything renders, and
slows down one address that floods the board: 120 pages and 20 preview
images a minute, then a 429 for the rest of that minute. Filtering runs in the browser on the list the page
already has, so searching is instant. Each role page carries JobPosting
structured data (Google for Jobs), a canonical link, Open Graph tags and a
generated preview image (JSON-LD only when the role has a real description
and a place Google can read, or is remote; a role it would reject gets none);
the board has a sitemap (`/jobs/sitemap.xml`, or
`/sitemap.xml` on its own host). Copilot's own `robots.txt` disallows
everything but `/jobs`; the board host's allows everything. While the board
is off every page says "coming soon", is marked noindex, and the sitemap is
empty.

The free Render plan sleeps after 15 minutes without traffic. A cached page
is served as soon as the server is up again, but the wake-up itself (around
30 to 60 seconds) is not something caching can hide; a paid instance, or a
ping every 10 minutes, would.

## Setting it live

0. **Before announcing it:** keep the Render service awake. The free plan
   sleeps after 15 idle minutes and takes 30 to 60 seconds to wake, which
   is what the first people clicking a LinkedIn post would meet. Move the
   service to an always-on paid instance, or ping `/jobs` every 10 minutes
   from an outside monitor.
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
   redeploy, in the same sitting as the custom domain (until it is set, the
   board host's sitemap lists copilot.tiptop.vc addresses, which search
   engines ignore there). Never set `JOBS_BOARD_TRUST_FORWARDED_HOST` here:
   it is for the e2e server only. Canonical links, the sitemap and Copilot's "View public board"
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
