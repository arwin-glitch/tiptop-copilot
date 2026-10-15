# Changelog

Notable changes to TipTop Copilot. Newest first.

Versions follow [semantic versioning](https://semver.org). Until 1.0 the schema
may change between minor versions; migrations are additive and idempotent
throughout.

---

## [Unreleased]

- **Affinity's data where it is used.** Each imported list feeds the page that
  needs it, as a subtab or a one-click switch, never a long scroll:
  - **Deals:** new subtabs. *Pipeline* lists Copilot's deals and Affinity's
    deal lists as one row per company, matched by domain and then by name.
    Affinity's stage is read as Copilot's stage, its own label stays visible,
    and "Differs from Copilot" marks a disagreement. It never changes a deal.
    *Sourcing* holds the watch lists, deal feeds and sector lists. The
    existing list is now the *Screening* tab, and the bare URL still opens it.
  - **Fund II:** *LP pipeline* gains a "From Affinity" switch. It lists
    Affinity's LP pipelines grouped by Copilot's LP stages, with likelihood,
    and never shows an amount: a row shows only who the LP is with, what kind,
    how likely and when last in touch, so a plain-number column called
    "Commit" or "Size ($K)" stays off too, here and on the LP's profile. A new
    *LP lists* tab holds Fund I's LPs (kept out of Fund II's stage counts),
    newsletter and SPV lists, with member counts.
  - **Portfolio:** a new *Angel* tab holds Nick's personal angel investments,
    labelled as not Fund I. Company cards show founders from Affinity, and a
    new *Founders* tab lists every founder and portfolio row, matched to a
    company here or not.
  - **Network:** new *Investors*, *Service providers*, *Operators* and
    *Events* tabs. *People* gains a "From Affinity" switch, and a search names
    any Affinity matches.
  - **Meetings:** *Notes* gains an "Affinity" switch with every Affinity note,
    newest first, 25 to a page. Deal and portfolio profiles show Affinity's
    lists, people and notes for the company.
  - Every Affinity table pages with previous and next, so a list of thousands
    is browsable end to end without growing into a long scroll.
- **Daily Affinity sync.** Every morning the app copies every Affinity list,
  its rows and the notes into Copilot (`AFFINITY_API_KEY`). A page Affinity
  refuses or keeps failing to send is moved past instead of stopping the sync
  for good, and a notes page that could not be saved is read again the next
  morning.
- **Help and guided tours.** Help is in the System group of the menu. It shows
  a card for every page and for Ask Arwin: what it is for, a small sketch of
  the page with numbered pins for where to click, the same steps as one-line
  labels, its tabs, and two buttons. "Show me" runs a tour on the real page: it
  dims everything but one element at a time and explains it in a line, with
  "2 of 5", Back, Next and Done. Esc ends it. "Take the 2-minute tour" walks
  one stop on every page, opening each in turn. The "?" beside a page title
  tours that page, and Settings links to Help. A step whose element is not on
  screen (a phone layout, an empty list) is skipped. The tour never blocks the
  page: clicks go through to it, leaving the page ends the tour, and it waits
  while the Ask Arwin panel is open. Page shortcuts stand down while a tour
  card has focus. The copy, steps and tab labels live in one place
  (`src/lib/help/registry.ts`), and a test checks every step against the code.
  No new dependency, no migration.
- **At a glance on Today.** Three small cards open Today: Do now, Intros owed
  and Coming up, one short line per task, four a card, with the full count in
  the title and "+N more" to Tasks. Tick a line and the task is done: the count
  drops at once, the line strikes through and folds away, and an 8-second Undo
  is offered. Do now is anything undated, overdue or due within two days;
  Coming up is 3 to 30 days out (a week-level date reads "Oct 19 wk"); intros
  are read from the routine or the title ("Intro A to B", arrows), never "intro
  call". Short labels come from the task-suggest routine (new optional
  `short`, `bucket` and `due_precision` fields on `TASK_ADD_V1`, each dropped
  on its own if malformed; `due_at` now takes any offset, a bare date or a
  Central time); otherwise the app shortens the title itself, no AI. A relay
  message with one bad task or date keeps the rest of its tasks. With the
  cards showing, Tasks due starts closed, with the overdue count beside its
  title. On a narrow screen, a tablet or a small laptop the cards stack, and a
  long line wraps instead of being cut. No migration.
- **Ask Arwin replaces the Ask tab.** A green chat button sits in the
  bottom-right corner of every page (above the tab bar on a phone), with a
  "Hi. Need any help?" greeting that can be closed for good. It opens a panel:
  past conversations first (the question, the last thing said, when it
  started, and Answered / Waiting / No answer), a "New conversation" button,
  and the conversation itself. The page dims behind it, and keys typed in it
  never reach the page's own shortcuts (the Inbox's Gmail keys, the email
  session's Ctrl+Enter send). A phone on its side or a short window gets the
  full-screen sheet. An answer still on its way keeps being checked with the
  panel closed, and the button gets a gold dot when it lands. "Ask about
  today", a deal's Research, IC memo and Ask links, and `?ask=<question>` on
  any page open the panel instead of leaving the page. `/ask` stays as the full
  page, one click away from the panel. Esc closes it; keyboard focus stays in
  the panel while it is open, and a screen reader hears when an answer lands,
  panel open or closed.

## [0.11.4] — 2026-10-15

- **Portfolio numbers load at once.** "Numbers from their updates" shows the
  last read from the database straight away, right after a restart or deploy
  too, with an "Updated <time>" note. Numbers older than 30 minutes are read
  afresh from Gmail in the background (sooner if the last read ran out of
  time), and the daily job refreshes them too. A company the background read
  could not finish keeps its last numbers rather than figures from part of its
  mail. Extraction rules, labels, dates and source-email links are unchanged.

## [0.11.3] — 2026-10-14

- **Event sign-ups don't ping.** An RSVP that Luma, Eventbrite or a similar
  platform put on the calendar is a block ("An event registration, not a
  meeting"), unless a real person is on it too. A firm's shared calendar@ or
  no-reply@ mailbox still books a real meeting when the title names the other
  side ("Intro: Pat <> Nick").
- **Names read right.** "Invited by" uses the organizer's own name from the
  invite, and a one-word address (pat@) shows as "Pat".
- **In-person meetings show the place.** IRL meetings, or ones at a real place
  with only the auto-attached Meet link, say where instead of "Tap to join",
  and the tap opens the Calendar tab. Zoom or Teams links next to a place
  (hybrid) keep "Tap to join". The Calendar card shows the place first and
  keeps a muted Join link.

## [0.11.2] — 2026-10-14

- **Meeting alerts start on time every morning.** The alert loop no longer
  stops at 9pm and waits for GitHub to start the next day's run (which came
  hours late on Oct 14). It now waits quietly overnight without calling the
  app, starts its own successor every 5.5 hours, and survives a bad reply
  from the app instead of exiting. The hourly schedule is only a backup.

## [0.11.1] — 2026-10-13

Fixes from checking 0.11.0 against Nick's real mailbox.

- **Fresh company updates** now catch updates sent through Visible or
  Mailchimp (trust is checked against the founder on Reply-To), from a news
  subdomain (news.acme.com counts as acme.com), and founders' monthly
  "Newsletter" letters from the company's own domain. A first load that runs
  out of time says so ("still reading some of your mail") instead of showing a
  quietly short list. A founder's update sent as mass mail (Visible, Mailchimp, a
  news subdomain) counts when its subject names the sender's own company and
  Nick has emailed them before.
- **Portfolio numbers:** other companies' or goal figures ("companies have
  gotten to $20M ARR", "$20M ARR by end of 2027") are refused; one misread
  point 3x off a company's series is dropped from the trend; "Raising" now
  means a raise in progress or ahead and from the last 120 days, never a round
  that closed.
- **Who can intro?** only counts someone as an introducer when they shared a
  small email (6 people or fewer) with the target, not an event invite.

## [0.11.0] — 2026-10-13

No schema change, no new dependency, no new environment variable.

- **Fresh company updates (Reports).** Founder and investor updates from the
  last 30 days, read live from Gmail, above the Slack digests: so an update
  that lands between digests (like Hank's on Oct 12) shows the same day. Only
  updates from portfolio companies or people Nick has emailed are shown, each
  with the reason, the kind (investor/quarterly/fundraise "Day N"), "you were
  bcc'd", and "In the Slack digest" when it already appeared there.
- **Numbers from their updates (Portfolio).** ARR or MRR (never converted),
  cash, runway, raising status and YoY growth pulled from each portfolio
  company's update emails by rules (no model), each with its as-of date and
  source email, ARR/MRR with a small trend line. Labelled company-reported.
  Plan, target, deal, customer, pipeline and prior-period figures are refused;
  when two figures conflict, neither is shown.
- **Follow up (Fund II).** DocSend prospect rows get a Follow up button that
  opens the compose window prefilled to the reader in Nick's voice, plus "You
  emailed them <date>" from sent mail so nobody gets chased twice.
- **Who can intro? (Fund II).** On LP cards and DocSend rows: people Nick
  already knows at the firm, and people who have been on threads with them and
  could introduce him, from the last 3 years of his mail, each with a sample
  thread. Read-only; says so honestly when nothing is found.
- **Calendar invites are not "emails".** Invites, updates and RSVPs no longer
  count as the last email with someone on Today or the Calendar tab.

## [0.10.0] — 2026-10-13

No schema change, no new dependency, no new environment variable.

- **Meeting alerts, 5 minutes before.** A phone ping before each real
  meeting: "Lindel / Nick in 5 min · 10:05 AM · with Lindel · Tap to join".
  Tapping opens the Zoom/Meet/Teams link directly (`/go/meeting`). A meeting
  means someone else is on it (invited and not declined, or the organizer), it
  has a video link, or its title names someone ("Coffee w/ Jane", "X <> Y").
  Blocks never ping: Focus time, out of office, Gmail bookings (flights,
  hotels), holds nobody accepted, Lunch/Gym/Travel/Prep-style entries with no
  one on them, family time, declined meetings, and room-only bookings.
  Meeting alerts ignore the 8am-8pm quiet window; everything else keeps it.
- **Alerts every minute.** The GitHub sender now loops through the day
  (6am-9pm Central), asking for meetings every minute and for everything else
  every half hour; a scheduled run waiting in the queue takes over before each
  run's time limit. Repository is public, so the runner minutes are free.
- **Calendar tab.** Nick's calendar, live, day by day (today and the next six
  days). Every entry is marked Meeting (pings 5 min before) or Block (no ping)
  with the reason. Meetings show who is on them, a Join link, and "How you got
  here": the daily dossier's section for that meeting (with "The one thing to
  know" and "Worth asking"), the week-ahead prep note on other days, and the
  latest email threads with the people on it.
- **Inbox: compose, forward, attachments.** Compose a new email (or press c),
  forward one with its attachments (up to 20 MB), and open attachments: PDFs
  and images open in a tab, everything else downloads (never rendered here).
  Same Send path, signatures and 8-second undo as replies.

## [0.9.0] — 2026-10-12

No schema change, no new dependency, no new environment variable.

- **Inbox, live like Gmail.** The Inbox tab now reads Nick's Gmail directly
  instead of the synced copy: Primary, Other tabs, Starred and Sent, and a
  search box that takes Gmail search (from:, has:attachment, and so on) across
  all mail. A reading pane shows the whole conversation (older messages
  collapsed, quoted text folded, hard-wrapped plain text rejoined), with
  attachments listed by name.
- **Act on mail.** Archive (with Undo), Move to inbox, Star, Mark read/unread,
  and select several at once. Opening an unread email marks it read, as Gmail
  does. Nothing is ever deleted: there is no trash or delete action.
- **Reply in place.** Reply all opens with the draft already on the thread in
  Gmail, if there is one. Sign as Nick or Arwin; Send goes out from Nick's
  inbox through the same path as the email session, with 8 seconds to undo.
  Without the sending grant, Send opens the email in Gmail instead.
- **Gmail's keys:** j/k, o, e, s, r, u, Shift+U, x and /.
- **Flagged mail stays flagged.** Text aimed at an AI assistant is still
  detected, badged in the list and explained in the reading pane.
- **Retired with the old Inbox:** the in-app AI "Draft reply" (it needed an
  in-app model, which production does not have; drafts come from Gmail) and
  attach-to-deal from the Inbox.

## [0.8.0] — 2026-10-09

No schema change, no new dependency, no new environment variable.

- **Reading your DocSend (Fund II).** Who outside TipTop opened the
  prospective-partner update or a deck, read from DocSend's view emails in
  Nick's mailbox (last 6 months; nothing connects to DocSend itself). One row
  per person: documents, number of views, first and last view, downloads, and
  their Fund II pipeline stage when they match one (by firm domain or name).
  Hot readers (a view in the last 3 days, or a repeat view or download in the
  last 2 weeks) sit on top. Fund I LPs reading the regular LP update are listed
  separately. Visits from TipTop addresses are ignored.
- **Phone alert for DocSend.** A ping when someone outside TipTop opens fund
  materials, once per view, 8am to 8pm. Never for LP-update reads.

## [0.7.1] — 2026-10-09

No schema change, no new dependency, no new environment variable.

- **Welcome back (Today).** A one-time card for Nick's first visit after his
  leave: the email session, phone alerts and "Waiting on you", each with a
  link. "Got it" hides it on that device; it is gone for everyone after
  31 October.
- **Smaller first session.** The email session starts on "10 min" (the most
  urgent emails that fit) unless someone already picked 25 or All on that
  device. The Follow-ups card says so.
- **"Nick last opened the app" (Follow-ups).** Under the email session card,
  anyone other than the mailbox owner sees when the owner last used the app
  and whether phone alerts are on. A page view writes one `app.visited` row in
  `audit_events`, at most once per 15 minutes per person; activity from before
  this release (answers, Ask questions) still counts. Only rows a person makes
  count (visit, session answer, Ask question, alerts turned on): background jobs
  such as the mailbox sync write rows under the mailbox owner too.

## [0.7.0] — 2026-10-08

No schema change, no new dependency, no new environment variable.

- **Email session (Follow-ups).** A card at the top of Follow-ups starts a
  one-email-at-a-time session over Nick's open emails, most urgent first: today,
  money/legal/tax, deals, promises owed, intro offers, then anyone else waiting
  on him. Each card shows why it matters, context the Copilot already has (deal
  stage, portfolio company and its health, Fund II stage, days waiting) and the
  live draft from Gmail, editable. Answers: Send, Tell Arwin (a note), No reply
  needed, Archive, Later. "I have 10 / 25 min" trims the queue; progress is
  saved. Friendly replies and archives sit in an "Arwin handles these" pile
  Nick can pull items back from. A "For Arwin" list shows the notes and
  archives to act on. The rest of Follow-ups is unchanged.
- **Sending, opt-in.** Settings › Integrations › "Turn on sending" asks
  Google for `gmail.modify` on top of the read scopes (the mailbox owner does
  this once). Then Send replies from Nick's inbox on the same thread with an
  8-second undo, signed with Nick's own Gmail signature or Arwin's, and Archive
  works from the app. Until then, Send opens the email in Gmail. Nothing ever
  sends on its own: drafts still never send, AI tools and cron jobs cannot
  reach the send module, and tests pin both. Invariant 6 is reworded to match.
- New relay marker `EMAIL_QUEUE_V1` (parts supported) from the new
  **email-queue** routine (twice daily), which reads the For Nick list and drops
  emails already answered in Gmail. Answers live in `audit_events`
  (`email.session_answer`).

## [0.6.0] — 2026-10-07

No schema change, no new app dependency. One new GitHub secret
(`VAPID_PRIVATE_KEY`); nothing to set on Render.

- **Phone alerts (Web Push) for Nick.** Settings > Preferences > Phone alerts
  turns them on per device (on iPhone, from the Home Screen app). Four kinds,
  each item alerting once, 8am to 8pm in the owner's timezone, at most one
  notification per kind per run: money or legal items going stale (Top
  priorities `money` items), the morning top 3, LPs/founders/portfolio
  waiting on Nick 3+ days (relationship radar), and portfolio companies newly
  flagged at risk (portfolio health). Tapping opens the right page.
- **How it is sent:** the app computes due alerts from the relay snapshots and
  serves them at `/api/cron/push` (bearer `CRON_SECRET`); the new
  `push-alerts` workflow (every 30 minutes in the daytime) signs and sends
  them with the VAPID private key it holds, then reports delivered keys and
  dead endpoints back. Subscriptions and the sent ledger are `audit_events`
  rows (`push.subscription`, `push.alerted`), so no migration.
- Subscriptions are accepted only for real push services (Apple, Google,
  Mozilla, Microsoft).

## [0.5.1] — 2026-10-07

No schema change, no new dependency, no new environment variable.

- **Long relay lists in parts:** a Slack message has a length cap, and the first
  intros run lost 77 of its 100 rows to it. The LP pipeline, portfolio health,
  intros and week-ahead posts may now arrive as numbered parts that share one
  `run_at`; the app joins every part of the newest run (week-ahead re-sorted by
  start time). Single posts without `part` work as before.

## [0.5.0] — 2026-10-07

No schema change, no new dependency, no new environment variable.

- **Search everything (Ctrl+K / Cmd+K):** one box in the sidebar and mobile
  header across deals, portfolio, Fund II LPs, people, meetings, tasks and
  documents (`/api/search`, signed-in, org-scoped, in-app links only).
- **Deal board:** Deals has a Table / Board toggle; the board shows stage
  columns with fit, summary and next step. The choice is remembered per browser.
- **Portfolio health** card on Portfolio (`PORTFOLIO_HEALTH_V1`): last update,
  a qualitative healthy / watch / at-risk flag and open asks per company. No
  figures. The classifier-only "Open requests" empty state is hidden when the
  card is present.
- **Intros** card on Network (`INTROS_V1`): intros owed, made, connected or
  stalled.
- **The week ahead** on Meetings (`WEEK_AHEAD_V1`): next seven days with prep.
- **LP update draft** card on Fund II (`LP_UPDATE_DRAFT_V1`): the quarterly LP
  update drafted into Gmail, addressed to Nick only.
- **IC memo** button on deals: asks the Ask routine for an investment-committee
  memo from the mailbox, Granola and the web.
- The relay read window is now 30 days so the quarterly LP update draft stays
  visible.

## [0.4.0] — 2026-10-07

No schema change, no new dependency, no new environment variable.

### No more dead features
- With no in-app AI key (the production setup), nothing shows a permanent
  "not configured" notice any more. Today drops the outlook notice, the empty
  LP section and Market signals; the deal scorecard slot becomes a one-click
  Research profile next to the deal-sorter's fit; Inbox points to Gmail, where
  the triage routines write reply drafts.

### One place for who is waiting
- Follow-ups now opens with **Waiting on you** (from the relationship radar),
  then **You're waiting on**, meeting recaps and scheduling drafts, all in
  "you" voice. Network keeps only **Going cold**. Today's task list is
  "Tasks due"; the Tasks page is just "Tasks".

### Fund II LP pipeline
- New **Fund II** tab: every LP conversation by stage (target, contacted,
  meeting, materials sent, soft commit, committed, passed), with "going quiet"
  flags, from the LP pipeline routine's `LP_PIPELINE_V1` post in #deal-relay.
  Stages only; amounts are never stored or shown.

### Housekeeping
- Navigation regrouped (Working: Today, Follow-ups, Tasks, Deals, Ask, Inbox;
  Records: Portfolio, Fund II, Meetings, Network, Reports, Knowledge). "Updates"
  is now "Dealflow reports"; Diagnostics is linked from Settings instead of the
  main nav. Ops-only text removed from user screens. One HANDOVER.md entry point;
  older handovers and prompts moved to docs/archive/. README screens updated.

## [0.3.16] — 2026-10-05

No schema change, no new dependency, no new environment variable.

### Relationship alerts and one-click company research

- **Network** now opens with **Relationship alerts**: who is waiting on Nick
  (prospective LPs, LPs, portfolio founders, co-investors first) and which key
  relationships have gone quiet, from the relationship radar routine's
  `RELATIONSHIPS_V1` post in #deal-relay. Newest snapshot wins; a Slack
  fault only hides the card.
- **Research** button on every deal: opens Ask with a ready research question
  (team, funding and investors, traction, competitors, recent news), answered
  by the Ask routine with web search. "Ask about this deal" now also shows when
  Ask runs through the cloud routine rather than an in-app model.

## [0.3.15] — 2026-10-05

No schema change, no new dependency, no new environment variable.

### Follow-ups page and Top priorities on Today

- New **Follow-ups** tab (Working group): who Nick is waiting on (he wrote
  last, no reply yet, with a "Nudge drafted" badge when a follow-up draft sits
  on the Gmail thread), recaps drafted after external meetings in Granola
  (with what Nick promised), and replies drafted with real open meeting slots.
- **Top priorities** card at the top of Today: the morning brief's and
  afternoon checkpoint's ranked list, newest wins.
- All of it is read live from the private #deal-relay channel
  (`FOLLOWUPS_V1`, `MEETING_FOLLOWUP_V1`, `SCHEDULING_V1`, `PRIORITIES_V1`),
  posted by cloud routines that only ever create Gmail drafts. Nothing is
  stored, links are rebuilt from validated thread ids, and the page stays
  closed until sign-in is limited to TipTop accounts. Demo mode shows
  fictional data.
- Also fixed in 0.3.14+ (f131777): Ask answers that ended in a link no longer
  get stuck on "Checking your inbox…".

## [0.3.14] — 2026-10-01

No schema change, no new dependency, no new environment variable.

### Today: the full briefing prints cleanly

- Save as PDF on a relayed briefing, checkpoint or dossier now prints on
  letter pages in the light design even when the reader's OS is in dark mode
  (dark-mode rules are rewritten to apply on screen only), keeps colours and
  backgrounds, and never splits a card, callout, row or list item across a
  page break.
- The Daily Overview and Recap routines now fill a fixed template in the
  dossier's editorial style instead of improvising a design each run.

## [0.3.13] — 2026-09-30

No schema change, no new dependency, no new environment variable.

### Today: the full briefing looks exactly like the routine's page

- "Open full briefing / dossier" now opens the page the Daily Overview or
  Recap published, relayed to the app as a gzip + base64 copy in the private
  relay channel (`BRIEFING_HTML_V1`, read on open, cached five minutes, never
  stored). A "Save as PDF" bar prints it. When no copy arrived, the link
  falls back to the text PDF from 0.3.11.
- The page is served sandboxed at `/api/briefings/<kind>/view`: an opaque
  origin, the page's own scripts, meta refreshes and base tags removed and
  blocked by CSP, and only the app's nonce'd print script allowed. The proxy
  leaves this one path's CSP to the route.

## [0.3.12] — 2026-09-30

No schema change, no new dependency, no new environment variable.

### Ask: follow-up questions, and links you can click

- A question handed to the answering routine now carries the conversation
  before it in the same thread (up to 8 turns, 6,000 characters, newest
  kept), on both the direct start and the Slack relay. "Can you attach the
  links to those threads?" used to arrive alone and could not be answered.
- Links into Gmail, Google Calendar, Google Drive, Slack, claude.ai and this
  app are clickable in answers, shown as "Open in Gmail" and so on. Any other
  URL stays plain text, since answers quote third-party email.
- Slack's link markup (`<http://Bill.com|Bill.com>`) is stripped from answers
  on arrival, and from answers already stored when they are shown.

## [0.3.11] — 2026-09-30

No schema change and no new environment variable. New dependency: `pdf-lib`
(pure JavaScript, no native code), used only to write the briefing PDF.

### Today: "Open full briefing / dossier" opens a PDF

- The button linked the routine's claude.ai artifact, which is created
  private to Arwin's account, so Nick hit a permission wall. It now opens a
  PDF the app builds from the routine's full text at
  `/api/briefings/<kind>/pdf`, behind the app's own sign-in (401 without a
  session). Headings, bullets and the red "Going stale" section carry over;
  arrows and emoji the standard PDF fonts cannot print are mapped or dropped.
- The artifact link stays in Arwin's Slack message; the app no longer shows
  it anywhere.
- The demo workspace now seeds one brief and one dossier, so the Today cards
  appear in the demo.

## [0.3.10] — 2026-09-28

No schema change, no new dependency, no new environment variable.

### Updates: instant filter chips that turn off again

- The view and source chips (All, Dealflow, Digests, and each channel) switch
  at once. The page reads Slack once and renders every filter; a click only
  shows a different one, so it no longer waits on a server render and a Slack
  read. The filter is still written to the URL, so a reload, a shared link
  and Back keep it.
- Clicking the chip that is already on turns it off and goes back to All.

## [0.3.9] — 2026-09-25

No schema change, no new dependency, no new environment variable.

### Every page reachable in a narrow window

- Below the sidebar breakpoint the bottom bar held only six destinations, so
  Meetings, Network, Knowledge, Tasks, Settings and Diagnostics could not be
  reached in a phone or half-width window. It now holds all twelve and
  scrolls sideways (swipe, trackpad, or mouse wheel), fades at an edge while
  there is more to scroll to, and opens with the current page in view.

## [0.3.8] — 2026-09-25

No schema change, no new dependency, no new environment variable.

### One throttle per server, not one per bundle

- Next builds pages and route handlers into separate bundles, each with its
  own copy of a module. The Tasks relay was moved to process-wide state in
  0.3.7; the same now applies to the Deals relay pull, the Updates tab's
  Slack caches and Retry-After block, the Today briefing and Ask-bridge
  throttles, the portfolio pull, and the rate limiter's buckets. A page and
  its API route now share one throttle, so Slack is read half as often and a
  rate limit can no longer be dodged by alternating endpoints.
- The Today watcher e2e test no longer flakes: a tick landing while the
  previous check was still being read was skipped, and the test waited for a
  check that never came.

## [0.3.7] — 2026-09-25

No schema change and no new dependency. New optional environment variables,
none of which needs setting: `TASK_RELAY_POSTER_IDS`, `TASK_REPLY_AUTOCLOSE`
and `TASK_SNAPSHOT_FEED`. Reasoning in [DECISIONS.md](DECISIONS.md) D-052.

### Tasks: Snoozed tab, Undo, and snoozes that come back

- A third tab, **Snoozed**, between To do and Completed, with its count. It
  lists the tasks still asleep, soonest to wake first ("Wakes Sep 29, 9:14 AM
  · 4d from now", or "No wake date"), each with **Unsnooze** and Mark
  complete, and its due date, in red when it comes before the task wakes.
  Switching is instant and `?view=snoozed` survives a reload and Back, like
  Completed.
- A snoozed task now comes back when its snooze ends: it was missing for good
  from To do, Today, the daily brief and deal and portfolio pages.
- **Undo** in the "Marked complete", "Snoozed for 3 days" and "Back on To do"
  toasts, on every page with task buttons. Undoing a completion from the
  Snoozed tab puts the task back to sleep until the same time ("Snoozed
  again"). On a phone the toasts sit above the tab bar.
- The Tasks tabs no longer switch when focus alone lands on one (a closing
  toast handing focus back to a tab switched it seconds later); a click, the
  arrow keys, Home, End, PageUp and PageDown still switch them.

### Tasks close themselves when the work is done

- The new `task-closer` routine checks at 4pm Central whether follow-ups have
  actually been done (a sent email, an accepted meeting) and posts what it
  found to the private #deal-relay. The Tasks page, an open Tasks tab, the
  Today page and the daily job read those posts and complete the task, unless
  a person reopened, undid, snoozed or created it after the evidence. Until
  the Slack app can post, only suggested tasks and "Reply to" tasks are
  checked, and the line at the top of To do says so.
- The app's own check closes an Inbox "Reply to …" task once a real reply went
  out in the same email thread (not a draft, not the out-of-office auto-reply,
  not a holding reply or hand-off, not a question back), once a day after 4pm
  Central.
- Nothing involving a counterparty kept Nick-only by standing rule is checked
  by the app or posted to Slack.
- Completed shows why a task closed automatically ("Closed automatically ·
  email sent Sep 22", linked to the email in Gmail, with a one-line reason)
  next to Reopen. The link is underlined and marked as opening Gmail, and a
  phone shows up to three lines of the reason.
- A muted line on To do says when the day's check ran and what it closed, or
  after 5:30pm Central that "Today's 4 PM Central auto-check" has not reported
  yet.
- Diagnostics has a "task-closer" entry: whether #deal-relay can be read, the
  last run, the snapshot feed ("needs chat:write" until the Slack app has that
  scope) and the reply check.
- Suggested tasks (`TASK_ADD_V1`) are only read from the account the routines
  post as, and a suggested title past the first 1,000 tasks is no longer
  added twice.
- The daily job also runs at 22:30 UTC, so one afternoon run follows 4pm
  Central in standard time too; only the morning run generates the outlook.

**Deploy:** nothing to set. The routine starts in preview mode, posting
markers the app ignores; it goes live once its first run matches the known
answers. To check tasks a person created as well, add `chat:write` to the
Copilot Slack app and reinstall it. The snapshot it then posts goes out when
there is none, every 20 hours, and when the list changed only between 2pm and
4pm Central, at most every 30 minutes.

## [0.3.6] — 2026-09-25

No schema change, no new environment variable, no new dependency.

### Tasks: Completed tab

- The Tasks page has two tabs, **To do** (overdue, due today, upcoming and the
  drafts) and **Completed**, each with its count. Switching is instant, in the
  browser, and the tab stays in the URL (`?view=completed`), so a reload, a
  shared link and Back keep it.
- Completed lists every completed task, newest first, under Today, Yesterday,
  Earlier this week and Earlier (in your timezone; weeks start on Monday).
  Each row shows when it was completed and has **Reopen**, which puts the task
  back on To do. The first 100 show, then **Show more**. No strikethrough.
- The old "Completed" list at the bottom of the page (last 20) is gone.
- Tab panels (Tasks, a deal, Settings) now show the focus ring when reached
  with the keyboard.

## [0.3.5] — 2026-09-23

No schema change and no new dependency. New optional environment variables:
`DEAL_RELAY_CHANNEL_ID` (defaults to the private #deal-relay channel) and
`DEAL_RELAY_POSTER_IDS`. Reasoning in [DECISIONS.md](DECISIONS.md) D-051,
which also amends D-012.

### Deals arrive automatically

- The deal-sorter cloud routine posts every real deal it finds to the private
  #deal-relay Slack channel, and the Deals page folds those posts into the
  pipeline: new deals with their source, founders and Gmail threads, fields
  filled only while nobody has changed them, and stages moved only while no
  person has set one. A stage a person set keeps it; the routine's view shows
  beside it as "Suggests: X" with an Apply button.
- Every company in the Portfolio tab is listed under Invested automatically,
  as an audited system move with no decision row (Arwin's decision, amending
  D-012). The routine itself never marks a deal invested.
- A status strip under the header says whether the deal-sorter is keeping the
  pipeline current, or names the one thing to fix (token, invite, scope).
  An open Deals tab refreshes itself when the pipeline changes.
- The pipeline lists everything, every weekly feed deal included, with a fit flag and a
  fit filter. With no AI key and no analyses, the table shows fit, source and
  last activity instead of empty score columns, and sorting by stage follows
  the pipeline order.
- Deals filters and sorting are instant, in the browser: the stage and fit
  chips and the column headers no longer wait for the server, even while the
  open tab is refreshing itself. They stay in the URL, so Back, a reload and a
  shared link keep the view.
- Each deal page has a Deal-sorter card (stage view, evidence, fit, source,
  next step, who owns the stage), Gmail thread links in Sources, "Not a deal"
  (archive) and, from the archived list, Restore. Compare and the reply drafts
  are hidden when no AI provider is connected.
- Today leaves routine deals flagged fit-unlikely off its deal lists and ranks
  "Awaiting a decision" by stage.
- The daily job pulls the relay as a backstop and reports counts only.

### Fixes

- The Deals page and Today fetched each deal's analysis with its own query;
  both now use one query per hundred deals, and the deal list is paged past
  the API's 1,000-row limit.
- An auto-linked email address in a relay message (`<mailto:x|x>`) now unwraps
  to the bare address instead of keeping the `mailto:` scheme, which failed
  validation and dropped the whole message.
- A deal's website link is always `https://<domain>`, never the stored value,
  and only for a plain hostname: `jane@x.example` or `a.example@b.example`
  is not linked.

### Relay hardening

- A relay deal's website must be a plain hostname; email addresses anywhere in
  its free text are replaced, and amounts are replaced in the evidence, next
  step and pass reason (the round size the founder states stays in `raise`).
- A bad optional field (a malformed thread id, an over-long title) drops that
  field, not the deal. A message too long or nested too deep to be the
  routine's is counted and skipped; it never stops the rest of the pull.
- Dates later than the day of the post are clamped to it, so an upcoming
  meeting cannot outrank a later pass. A `new` post is "no signal": it never
  displaces a real stage, clears a next step, or shows as a suggestion.
- Two companies that share a name (and so a key) with different websites stay
  two deals. Archiving a duplicate no longer cuts the original off from
  updates. Slack's auto-linked `zeta.ai` reads back as `zeta.ai`.
- The Portfolio mirror never moves a deal back into Invested after a person
  moved it out, including a deal the mirror created. A pass outcome the
  routine wrote is cleared when it moves the deal on.
- Deals the pull creates get ids derived from their source, so two instances
  racing on the same window collide instead of duplicating. A failed insert is
  counted and no longer stops the Portfolio mirror; a stage move whose
  bookkeeping failed stays the routine's.
- The relay is folded into the deployment's only organization and nowhere
  else once there are two. The status strip keeps the newest change's counts
  across quiet pulls, and says when saving (not reading) failed.

**Deploy:** add `groups:history` to the Slack app behind
`ASK_RELAY_SLACK_TOKEN` and invite it to #deal-relay. Set
`DEAL_RELAY_POSTER_IDS` to the Slack user ID the routine posts as. Prefer
keeping the token off any standby deployment.

## [0.3.4] — 2026-09-23

No schema change, no new environment variable, no new dependency. One Slack
app change is needed before the tab shows reports — see **Deploy**.

### Updates tab

A new **Updates** tab (`/updates`, in the sidebar and the phone bottom bar)
shows the three weekly dealflow reports and the Nick Update Digest runs, read
live from their Slack channels. Reasoning in [DECISIONS.md](DECISIONS.md) D-050.

- Filter by Dealflow or Digests, and by source. Each card opens on a short
  preview — the first summary bullets and next deadlines of a report, or the
  "worth your attention" list of a digest (else the run's own flag sentences,
  such as "one is time-sensitive") — and every report section, digest item,
  housekeeping block, run note and roster list stays collapsed until opened.
  A digest's open "Candidate series noticed" question stays in view as
  **Needs your call**. People's replies under a report are shown as replies,
  never as part of it. Ledger lines, "Sent using Claude" footers and channel
  system messages are never shown, and only the current roster version is.
- Each source shows whether the app can read its channel, when it last
  posted, whether a weekly report is overdue, and — when something is wrong —
  the exact fix: add the `groups:history` scope, invite the bot to that
  channel, or replace the token.
- Read-only and not stored: the app never posts to Slack and writes nothing
  to the database. What it reads is kept in server memory for five minutes;
  the last good copy is kept up to a day and shown only when Slack is
  unreachable or rate-limits. Removing the bot from a channel, or revoking the
  token or its scope, drops everything kept from it at once. Refresh re-reads
  a channel at most once every 20 seconds and always honours Slack's
  `Retry-After`.
- Closed while sign-in is unrestricted: outside demo mode the tab makes no
  Slack call and says so until `AUTH_ALLOWED_EMAIL_DOMAINS` is set.
- Slack text is rendered from a whitelist — bold, italic, code, lists, and
  links whose scheme is `https`, `http` or `mailto`. Anything else, including
  `javascript:` links, is shown as plain text.
- /diagnostics lists the Updates tab's configuration.

**Deploy:** in api.slack.com/apps, give the relay bot's app the
`groups:history` bot scope and reinstall it (if the bot token changes, update
`ASK_RELAY_SLACK_TOKEN` on Render and the Vercel standby, and the
`SLACK_BOT_TOKEN` GitHub secret). Then run `/invite @<bot>` in
#pef-dealflow, #openvc-dealflow, the referral dealflow channel and
#nick-update-digest. Until then the tab shows these steps instead of reports.

## [0.3.3] — 2026-09-22

No schema change, no new environment variable, no new dependency.

### Today briefing cards

After the Daily Recap posted on 2026-09-22, the Today page kept showing the
Morning Brief — the afternoon slot flipped between the new recap and a Sep 21
one. Four causes, all fixed. Reasoning in [DECISIONS.md](DECISIONS.md) D-049.

- The Supabase store now sends every request with its own abort signal, the
  documented opt-out from Next's per-render memoization of identical GETs.
  Without it, the Today render that pulled a new card read back the rows from
  before the pull, and the pull's own unchanged-check compared against them.
- The Slack pull ingests one payload per kind — the latest `date_key`, and
  the newest post of that day — and stamps `posted_at` with the Slack message
  time instead of the ingest time. A network fault or Slack 5xx is retried
  after 10 seconds; a Slack refusal waits the full minute, and a rate limit
  waits for its `Retry-After`.
- `ingestRoutineBriefing` never moves a slot to an earlier `date_key`, and
  ignores a payload identical to the stored card. A `date_key` that is not a
  real date, or is later than today in UTC+14, now fails validation, so one
  mistyped year cannot pin a slot for good. The briefing webhook's response
  now says whether it wrote (`written`).
- The GitHub `briefing-slack-sync` relay (workflow, script and its test) is
  retired. It replayed every payload in the window, so each run left each slot
  on its oldest post, and the Today page already reads the channel itself.
- An open Today tab now watches for new cards: it polls
  `GET /api/briefings/current` for a fingerprint every 15 seconds while
  visible, and on returning to the tab, and refreshes once per new
  fingerprint. Failed checks back off to five minutes; a 401 stops them.
- Settings' "Routine briefing card" check now follows `ASK_RELAY_SLACK_TOKEN`,
  the path cards actually arrive by, instead of `BRIEFING_BRIDGE_TOKEN`.
- The daily cron's briefing pull is documented as a best-effort backstop, which
  is all a twice-daily job can be.

**Deploy:** delete the `BRIEFING_SLACK_SYNC` repository variable. A push to
`relay-kick` from a commit that still has the old workflow would otherwise
start it, and it fails on the deleted script.

## [0.3.2] — 2026-09-04

### AI prompts

- `scheduling-reply@1.1.0`: the Arwin voice section now matches Arwin's real
  sent mail instead of a generic professional register — warm and efficient,
  short plain sentences, contractions, concrete times with an explicit CT/CDT
  timezone, and a fixed set of banned AI tells ("I hope this email finds you
  well", "I wanted to reach out", "Please don't hesitate to", "Kindly", "As
  per", "Furthermore/Moreover/Additionally"). Punctuation rule added at Arwin's
  request: a spaced hyphen `' - '` for asides, never em dashes. Calendar rules,
  the signature block, and the read-only/never-sent guarantees are unchanged.
  Voice profile of record lives in the assistant's memory (`arwin-voice-profile`).

## [0.3.1] — 2026-09-01

### AI prompts

- `draft-reply@2.1.0`: factual or administrative asks — an entity name, a
  signature block, notice details, something already shared on the thread — are
  now answered from the supplied sources instead of deferred with "I'll get
  that to you shortly", modeled on Nick's own 2026-08-28 reply to deal counsel
  and mirroring the same-day fix to the external mailbox triage routines. Each
  asserted fact is listed in `asserted_facts`; the commitment guardrail is
  unchanged, and wire or banking details never appear in a draft even when the
  sources contain them. Reasoning in [DECISIONS.md](DECISIONS.md) D-048.

## [0.3.0] — 2026-08-17

Design pass. No schema change, no new environment variable, no new dependency.

### Design system

- The token layer gained the tiers it was missing: **elevation** (three steps,
  tinted with the brand ink on paper and carried by a top highlight in dark),
  a named **type scale**, **motion** durations and easings, a **z-index scale**
  to replace three files picking `z-30`/`z-40`/`z-50` independently, and page
  gutter/stack rhythm. The palette is unchanged; `#0FC382` remains a dark-theme
  accent and a fill, never text on paper.
- New primitives: `Table` (sticky header, numeric alignment, mandatory scroll
  container), `Stat`/`StatGroup`, `Toolbar`/`FilterChip`, and `NotConfigured`.
- `FieldLabel` is now used everywhere. Its exact class string had been
  hand-written 30 times across 9 files while the primitive itself went unused.
- `cn()` declares the new font sizes to `tailwind-merge`. Without that it read
  `text-micro` as a colour, deduped it against `text-[var(--fg-subtle)]`, and
  silently dropped every label's size — with a green build and a green suite.

### Capability states

Every AI-derived surface now decides on the server whether a provider exists,
and says so in place rather than after the fact. `/ask` no longer offers a
composer and eight suggestions that fail into a toast; `/today`, the deal
scorecard, the Inbox (Analyse as deal, Draft reply) and the portfolio Classify
button all state what is off, what still works, and where to look. Everything
that reads from records — attach to deal, categorise, tasks, memo export —
stays available.

### Shell

Navigation is grouped (Working / Records / System) with an accent rail marking
the current page, `/diagnostics` gains the nav entry it never had, the account
block gets a proper hierarchy, and the mobile header names the current section.

### Deals

`/deals` is a sortable table above `lg` — sticky header, `aria-sort`, tabular
figures, ordering held in the URL — and a purpose-built card list below it
rather than a compressed table. An unscored deal renders as absent, never as
zero, and sorts to the end in both directions. Five end-to-end tests cover it.

---

## [0.2.0] — 2026-08-17

### Prompts

- **draft-reply@2.0.0** — the draft voice now matches Nick's actual sent mail
  (greeting forms, verdict-first openings, natural exclamation points, his own
  reference phrasings) instead of a sanitised register; adds a hard guardrail
  against committing money, allocations or terms in any draft; and confines
  LinkedIn links to outbound introductions — formal full names in the
  "please meet" lines only, URLs only from supplied sources, never guessed.
- **scheduling-reply@1.0.0** (new) — pure meeting logistics are drafted in the
  EA's voice with an introduction and signature, checked against a snapshot of
  the synced calendar: no overlaps, 8am–6pm Central only, hour-long in-person
  blocks with travel buffers, reschedules treat the moving slot as free,
  cancellations get a warm rebook offer, and the draft never initiates moving
  one of Nick's commitments. New `DraftKind: 'scheduling'` routes to it and
  supplies the calendar snapshot from synced records.
- **email-classification@1.3.0** — importance now weighs whose court the ball
  is in, and list mail, cold pitches, notifications and marketing are pinned to
  low importance with no deep fetch.

The app remains read-only against Gmail and Calendar. Mailbox-side labelling
and Gmail drafts are owned by the external triage routines; app drafts stay
copy-paste, and the write-scope test keeps that structural.

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
