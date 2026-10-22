# Changelog

Notable changes to TipTop Copilot. Newest first.

Versions follow [semantic versioning](https://semver.org). Until 1.0 the schema
may change between minor versions; migrations are additive and idempotent
throughout.

---

## [Unreleased]

- **A public job board for the portfolio's open roles, with a button on
  Portfolio › Jobs to open it.** Jobs now has a "Public job board" bar with
  View public board (opens it in a new tab), Copy link, an on/off switch, a
  Preview while it is off, and the board's text. Under it: From email (the
  roles founders email Nick, as before), Approvals (those emailed roles,
  waiting: none goes public until someone approves it, and only the title,
  company, place, level and job link ever do), Public board (publish, hide,
  feature, mark filled, edit, add a role, Refresh now) and Companies (each
  company's careers page; Copilot reads Greenhouse, Lever, Ashby, Workable
  and Recruitee boards every day, adds new roles and closes ones that are
  gone; a company's board roles go public on their own only when someone
  switches that on). The board itself is at /jobs, and at jobs.tiptop.vc once
  its DNS points here: search and filters by company, team, place, remote,
  level and type, featured roles, a page for each role (apply at the company,
  share, Google for Jobs data) and each company, in the Perks directory's
  look and fast on a phone. It is off, showing "coming soon", until switched
  on, and needs the database update
  `20261022100000_public_jobs.sql`.

- **A routine's post that runs a little long no longer leaves its card on
  yesterday's copy.** When a routine wrote a note, a prep or a title longer
  than the app allows, or listed one item the app could not read (a meeting
  of an unknown kind, a bad date), the whole post was turned away and the
  card kept the older copy; on Oct 21 that held back the Week ahead card and
  the Calendar prep notes. Now long display text is cut at a word with "…",
  an item that cannot be read is skipped and the rest of the post shows, and
  numbered parts of one run still join. Diagnostics > Feeds says "1 item in
  the newest post was skipped" instead of "could not be read"; a post that
  really cannot be read (not JSON, no run time, or not one readable item)
  still says so and keeps the older copy, and so does a follow-ups, Top
  priorities or radar post where most items cannot be read. Ids, names used
  to match records (an LP's name and firm, both sides of an intro), kinds,
  dates and links are still checked strictly. This covers the
  follow-ups, priorities, radar, LP pipeline, portfolio health, intros, week
  ahead, email queue, scheduling, meeting recaps and LP update posts, plus
  Jobs, the task closer's reasons, suggested tasks' details, briefing titles
  and new portfolio companies' descriptions.

- **Campaigns: a BCC choice made right after typing the address sticks.**
  Typing a BCC address and then clicking "The first email only" (or "Every
  email") straight away lost the click while the address saved, so it took
  a second click. The click now counts: the choice shows at once and is
  saved right after the address, and a reload and the review show it. The
  CC and BCC fields no longer lock while the other one saves, either. Each
  save still makes an earlier review stale, as before.

- **Phone and desktop alerts keep the mailbox person's hours.** The 8am to
  8pm quiet hours, the desktop app's 6am to 9pm checking and feed notices
  went by the time zone of whoever set the workspace up; they now go by the
  person whose mailbox Copilot reads (then the owner's, then Central time).
  The morning outlook the daily job prepares is now made for that person
  too, in their time zone, so their first Today of the day no longer waits
  for it.

- **Calendar: Google's colour labels, a clear look for every event, and "How
  you got here" that finds the reason.** The Day, Week and Month views now
  read each calendar's colour labels live from Google Calendar (a rename shows
  within a minute; nothing is stored). As in Google, only a label with a
  name counts as one: Google lists a slot for every colour, named or not, and
  a colour nobody named shows as its colour and never as "Unnamed label". An
  event takes its label's colour, and a named label's name shows after the
  time on the event, on its card, and in a row of label chips above the grid,
  round the colour wheel as Google orders them, greys last: one line on a
  computer with **More** for the rest, a strip that scrolls sideways on a
  phone. Tap one to see only those events (several add up; "Unlabelled" also
  holds events in a colour nobody named), and the choice is remembered. On a
  calendar with labels, the card's colours become Google's label picker: the
  named labels as chips, the colours nobody named as plain dots (each called
  by Google's name for it, "Tomato", "Cobalt"), "No label" and a link to edit
  the labels in Google Calendar; a label or a dot never emails anyone, and
  editing or answering an event never touches its label. When Copilot's own data is clear (a portfolio founder,
  an LP, a deal founder, another VC, only the team, a flight, a registration)
  the card suggests one of the calendar's labels, and nothing changes until
  someone taps "Use it". Ask Arwin can say which label each event has and
  list one label's events ("What Portcos meetings does Nick have this
  week?"). Every event now follows one rule each: filled with its colour;
  faded once it is over; outlined with a "?" while Nick hasn't answered;
  striped for maybe; struck through when declined; a bell on meetings, none
  on blocks, which are no longer dashed or grey. A **Key** button above the
  grid explains it. "How you got here" no longer gives up on events without
  other guests: it finds the email that put the event on the calendar (from
  the organizer, a ticketing site in the description, the title's words, the
  invitation, a meeting note or an earlier event), shows the best one to
  three with Copilot and Gmail links, or says what it checked and offers
  **Search the Inbox** (the Inbox now opens on a search from `?q=`). It works
  on every event's card. The card now opens beside the whole day, so it never
  covers that day's other events. Diagnostics › Event labels shows each
  calendar's named labels and how many events in the next week carry each,
  with the colours nobody named folded into one "+N colours without a name"
  line, read-only (D-070, D-072).

- **Tasks go to the person whose mailbox Copilot reads.** Suggested tasks,
  keep-in-touch check-ins, copied Affinity reminders and follow-ups added
  without choosing someone used to land on whoever set the workspace up, so
  on Tasks "Everyone" and that person showed the same list and the mailbox
  person showed nothing. They now go to the mailbox person: the member whose
  sign-in address is the connected Gmail address (else whoever connected it,
  else the owner), and they keep going there while that mailbox needs
  reconnecting. The person filter lists them first, a money or legal close
  asks for their confirmation by default, and a row only names who it is for
  when it is someone else (or "No one"). Handing a task to someone from its
  menu still works and always sticks. Open and snoozed tasks already filed
  the old way move with
  `supabase/data-fixes/20261021002000_tasks_to_principal.sql`, run by hand in
  the SQL editor after its two preview queries: only tasks no person added or
  reassigned, each with an audit row, done tasks left alone, and running it
  twice moves nothing.

- **Calendar: Day, Week and Month, like Google Calendar.** The Calendar tab
  is now just them: the view last used, else Week on a computer and Day on a
  phone. The old day list and its **New calendar** switch are gone; each
  event's card says everything the list did (meeting or block and why, the
  ping, the meeting prep, the latest emails, "How you got here"), and old
  `?view=list` and `?day=` links, Today's link included, open Day on that
  date. A busy day is laid out the way Google Calendar does it:
  events that start together share the width side by side, and one that
  starts later is drawn over the earlier one, shifted right and nearly full
  width, with a thin outline, so long blocks (travel, a conference day,
  holds) never squeeze a meeting into a sliver. No event is drawn narrower
  than 36px on a computer, give or take half a pixel so three meetings
  starting together fit side by side at 1440px (on a laptop under 1280px the
  month and the calendars move behind the Calendars button to make the
  room); what does not fit folds into a "+N" that lists it. Titles never break inside a
  word: they wrap over whole words where there is room, and a narrow event
  shows the start of its title with an ellipsis. The views go to any date (back, ahead, Today, a date picker),
  show all of Nick's calendars in Google's own names and colours with a
  toggle each, and keep the Meeting/Block verdict (a hold stays a block,
  tagged Hold).
  A click on an event opens Google Calendar's event card beside it (a sheet
  from the bottom on a phone): Edit, Delete, Duplicate, Email guests (opens
  the compose window), its colour, Going? Yes / No / Maybe, Join with Google
  Meet, Copy Meet link, the location in Maps, and Open in Google Calendar for
  anything else. Drag to create, move or resize; the quick editor opens next
  to the slot dragged, and a drag across days makes a multi-day event in
  Month and in Week's all-day row. Changing anything needs **Turn on
  calendar editing** (Google's `calendar.events` only; without it the views
  are read-only). A colour change never emails
  anyone; Going? asks "Send your response to the organizer?" and changes
  with guests ask Send / Don't send every time. Diagnostics › Event parity
  checks, read-only, that the calendar shows the same events as the day
  reader Today and the meeting pings use; it matched Nick's real calendar
  event for event before the views became the default (D-066, D-067, D-069,
  D-072).

- **Every email link opens in Copilot or Gmail.** Wherever Copilot links to an
  email or thread, it now offers two places to read it: **Copilot**, which
  opens the thread in the Inbox's reading pane (`/inbox?thread=<id>`), and
  **Gmail**, which opens it in Gmail in a new tab. That covers Calendar's
  latest emails, a deal's email threads and source emails, every Follow-ups
  row (and the session when an email can't load), Fund II's LP cards, DocSend
  readers and warm paths, a campaign's replies, Today's outlook priorities,
  important and LP emails and last-email lines, Portfolio requests, numbers
  and company emails,
  Network's going cold, intros and relationship timelines, Reports' fresh
  updates and the Gmail links in routine posts, Gmail links in Ask answers,
  sources in the evidence drawer, and the Seen sent, auto-close and money &
  legal proofs on Tasks. Links that went nowhere now work: Today's email
  rows, a deal's source emails, a company's related email and email citations
  pointed at an Inbox address it never read, and now open the email. The
  Inbox also opens Copilot's own id for a synced email, and the older
  `?message=` links. Opening by link never marks an email read. The Top
  priorities card keeps its single Gmail link, a Gmail search stays a search,
  and the Inbox keeps its own Open in Gmail. Nothing sends, no new scopes.

- **Network › Students & interns**, after Keep in touch: students Nick
  mentors, schools and programs inviting TipTop in (fellowships, PE/VC labs,
  alumni mentor programs), and students asking to intern or for advice. A
  scan reads the mailbox every Monday and Thursday and posts to #deal-relay
  (`STUDENTS_V1`). Filter by kind, status (open by default) and whose next
  step it is, or search; the filters stay in the link. Deadlines in the next
  two weeks are flagged, and items on Arwin are marked in gold and counted at
  the top. Each item links to its emails (Copilot or Gmail) and never shows
  their text. The tab says the scan is overdue after five days, and
  Diagnostics › Feeds watches it too. An old `/portfolio?tab=students` link
  opens the tab on Network. No migration, nothing sent.

- **Fix: campaign photos would not upload.** Every photo was refused by file
  storage (it was stored as `application/octet-stream`, a type the private
  bucket does not take) and the page answered with an error the uploader did
  not keep on screen, so the photo count just stayed at 0. Photos are now
  stored as their real image type (what the file's own bytes say), and HEIC
  photos work once migration `20261021001500_bucket_heic.sql` is applied;
  until then a HEIC photo is refused with "HEIC photos are not enabled yet",
  and JPG, PNG, GIF and WebP work. A shared attachment of a type storage does
  not take (a spreadsheet, a zip, an unknown type) is now refused when it is
  added, with the list of what campaigns can carry, instead of failing in
  storage; supported files attach exactly as before. Upload problems, for
  photos and attachments, now stay on the page under the uploader with the
  reason. The demo and test storage refuses the same types the bucket does,
  so a regression like this fails the tests.

- **Tasks: a proof check for deliverables ticked by hand, and a company chip
  on every task.** When someone ticks a task that is only done once something
  reaches someone (a reply, a document sent, feedback handed back, an intro, a
  signature or a payment, to a named person), the app looks for it in the
  connected mailbox's sent mail. A send it finds shows as "Seen sent" on
  Completed. After two business days with nothing seen, the task shows
  "Ticked, not seen sent" on Completed and in a small Today card, with "It's
  done" and "Reopen"; nothing is reopened or sent on its own, and a send seen
  later still clears it. Plain to-dos (calls, meetings, anything done by
  Slack, phone or in person) and automatic closes are never checked, and a
  teammate's task is not flagged from the owner's mailbox. Once its prompt is
  updated, the 3 PM task closer can also count Slack messages, payment
  confirmations and signature notices as proof (`TASK_PROOF_V1`). Every task
  row, on Tasks and in Today's "Tasks due", shows a quiet company chip from
  its deal or portfolio link, or a CRM company chosen in the edit dialog. No
  migration (D-065).

- **Campaigns: a photo per person, CC and BCC, and "Who gets what".** All
  optional; a campaign that uses none of it sends exactly as before. Photos
  are uploaded as a set and matched to each person by file name; one that
  matches nobody, or two people, is given out by hand. CC goes on every email;
  BCC goes on every email or only on the first email sent; each person can
  also have their own CC. The review now shows "Who gets what" for every email
  (paged, searchable, with a CSV download), counts each copy toward the daily
  cap, says that a copy's unsubscribe link unsubscribes the recipient, and
  blocks sending, naming the person, when a photo cannot go or a copied
  address has unsubscribed. "Send test to me" never copies anyone, and a
  bounce from a copied address no longer marks the recipient bounced. Needs
  migration `20261021001100_campaign_photos_cc.sql`; until it is applied these
  options stay hidden. Before a real campaign uses BCC, confirm with a test to
  inboxes you own that Gmail strips the Bcc line.

- **Portfolio › Jobs, and Open roles on company pages.** A new Jobs tab lists
  the open roles founders mention in investor updates and "we're hiring, know
  anyone?" emails, from a weekly scan that a routine posts to #deal-relay
  (`JOBS_V1`). Active roles show by default; filter by status, team and
  company, or search, and the filters stay in the link. Each role shows the
  founder's own status note, when it was first and last seen, how often it
  came up, who to send candidates to, the job posting, its source emails (in
  Copilot or Gmail), and a Copy blurb button for sharing. A posting that is gone from
  Greenhouse, Lever or Ashby (checked daily) closes the role. Each company's
  page shows Open roles (n), linking to its roles. Diagnostics › Feeds watches
  the weekly scan and calls it late after 10 days. The tab explains the scan
  until the routine first posts. No migration.

- **Campaigns: fill in missing merge fields from the review.** On the review
  screen, each "N people have no first name / name / company" line now opens
  to show who they are, with inputs for whatever each person is missing (Save,
  or Enter). The values are used for that campaign's preview, counts and send,
  and people drop off the list as they are filled; anyone left empty still
  sees the fallback. For people linked to a CRM contact, "Also save to their
  contact" (on by default) also updates that contact's full name and company,
  and names any value it would replace; a first name never goes to the
  contact. Send waits while a save is going through or while typed values are
  unsaved. No database change.

- **Tasks: a menu on every task, and a Money & legal tab.** Every task row on
  Tasks and in Today's "Tasks due" has a More actions menu to edit it, snooze
  it to a chosen day, assign it to a teammate (To do can be filtered by
  person), mark it money & legal, or delete it with Undo. The new Money &
  legal tab holds wires, signatures, filings, invoices and the like until they
  are closed with proof (a link or a teammate's confirmation), and marks
  anything quiet for a week as going stale. If the 3 PM auto-check calls one
  done without proof, it waits under "Needs proof" instead of closing. No
  migration (D-064).

- **CRM writes in Copilot, and Knowledge › Find & save.** New list (Knowledge
  › Affinity lists), Save as list from any list view, and a new Find & save
  tab that finds people or companies by name, place and last contact (for
  example, in Austin, in touch within 3 years), optionally within one list,
  then saves every match as a list or adds them to one; campaigns can use
  these lists. New company or person keys on website or email, opens an
  existing record instead of copying it, and is adopted by the daily Affinity
  sync. Lists get Add column (a Copilot column, edited in the side panel; the
  sync never takes it over). Notes written in Copilot can be edited and
  deleted; Affinity notes say why they are read-only while the sync runs.
  Remove from list has Undo and stays removed through the sync and CSV
  re-imports. Profiles get Add to list and a note box. Lists made in Copilot
  start as Reference only. Remove from list needs migration
  `20261021000300_crm_writes.sql`; everything else works without it (D-063).

- **Affinity exit checklist.** Knowledge › Affinity import has a second view,
  Exit checklist (`?view=exit`): a countdown to a notice date you set on the
  page, a Cancelled switch, status rows counted from Copilot's own records
  (lists, records, notes, introductions, daily sync), rows for what is not
  copied yet (contacts on no list, reminders, files), a checklist of outside
  tools that still use Affinity, and a final archive download. Two owner-only
  copies run only on a press, after a confirm: contacts on no list (capped per
  press) and open reminders as tasks (safe to repeat). Today shows one quiet
  line linking to the checklist in the last 14 days before the date. When
  Affinity refuses the key, the daily sync now stops cleanly: the job stays
  green and the panel says "Stopped" instead of failing every morning. No
  migration (D-062).

- **Diagnostics › Feeds, and opt-in feed notices.** Diagnostics now has two
  tabs, Setup (the old page) and Feeds: every routine, job and delivery that
  fills a card, meeting notes included, with when it was last seen against how
  often it runs (running / late / looks stopped / not seen / can't check /
  off). Feed notices are opt-in per person: one desktop notice a day per
  stopped feed, 8am-8pm, only on the computers of the person who turned them
  on; phones never get them. Cards other than Top priorities add "may be out
  of date" beside "checked" when their feed looks stopped. No migration
  (D-061).

- **Network › Intros: Write the intro.** Each intro still owed has a "Write
  the intro" button. It opens the compose window on a fresh thread in the
  intro format: an "Intro: First (Firm) <> First & First (Company)" subject,
  everyone greeted by first name, co-founders included, full names linked to
  LinkedIn, and a body that ends at the sign-off so the real Gmail signature
  is added on send. To holds only addresses the app has on record (the tracker
  row, CRM people, portfolio founders, imported introductions); anything
  missing shows as a note to fill in, never a guess. Nothing sends until Send
  is tapped, and Copy for Gmail keeps the links. Subjects and To/Cc names with
  accented letters are now encoded properly, for replies too.

- **Ask Arwin: a Feedback tab, and an AI tag.** The chat window has a Feedback
  tab: type or dictate what should change in Copilot, and the note is saved
  with the page you were on. Notes show on the full Ask page's new Feedback
  tab (`/ask?tab=feedback`), Open and Done, newest first, with the open count
  on the tab and Mark done / Reopen. Desktop alerts for new feedback from
  other people can be turned on there (off by default). A small "AI" tag sits
  beside the Ask Arwin name on the chat button, in the chat header, on the Ask
  page title and in the "Arwin replied" pop-up, and desktop notifications read
  "Arwin (AI) replied". The chatbot still calls itself Arwin. No database
  change (D-060).

- **Inbox: labels.** A Label button (tag icon) is on every row, in the reading
  pane and on the bulk bar for selected emails, and the l key opens it. It
  lists the mailbox's own Gmail labels: tick a plain label to add it, untick
  it to take it off. Numbered labels (1:, 2:, ...) are a move: picking one
  takes the email out of the other numbered labels, so the hourly sorter does
  not undo it. Changes show at once, and the list picks up changes made in
  Gmail sooner: about every 45 seconds while the tab is open, a few seconds
  after each action, and when you come back to the tab. Like archive and star,
  labels need sending turned on.

- **Times in your profile timezone on every page, and portfolio numbers that
  finish.** Today, Inbox, Campaigns, the Follow-ups email session and the New
  follow-up dialog print dates and times in your profile timezone on the
  server and in the browser, so pages no longer redraw themselves after
  loading when the two are in different zones (React #418). New follow-ups
  default to two days from today in your zone, due at 5 PM. Demo meetings stay
  on today after 7pm Central. Portfolio "Numbers from their updates": a
  refresh that runs out of time carries on by itself in the background, up to
  6 passes with 15 s between them, and stops early when a pass reads nothing
  new; page views and the daily job join the refresh already running.

- **Ask Arwin knows it is Arwin.** Answers speak as Arwin, the assistant in
  TipTop Copilot, in the first person and the way Arwin writes (warm, short,
  spaced hyphens, no AI tells), instead of "TipTop Copilot, an internal
  analyst" or no identity at all. Asked sincerely whether it is a real
  person, it says it is Arwin's AI assistant, not Arwin, and it never denies
  being an AI or answers falsely about what powers it. Anything that needs
  the human (sending, booking, a judgment call on Nick's behalf) is "one for
  Arwin", with a suggestion to message him, never a claim that it flagged
  him. One persona block, word for word, in the in-app Ask prompt (now
  `chat-tools@1.4.0`) and in the Ask bridge's answerer, which writes the
  answers in production; a test pins the block's hash so the copies can't
  quietly drift. Grounding, citations and the read-only rules are unchanged,
  and so is every other prompt and its version (D-059).

- **Follow-ups and the email session show the full email.** Each Follow-ups
  row with a Gmail thread gets "Show email" under its Open in Gmail link (one
  row open at a time, with a second Hide email at the foot of the email); the
  email session shows the email beside the drafted reply on a wide screen
  (the reply stays in view while a long email scrolls) and above it on a
  narrower one, and each new card opens at its top. The newest message is
  collapsed to a few lines behind "Show full email", its To/Cc line to one
  line, and the messages before it are behind "Show earlier messages". The
  context line stays. Plain text only, through the Inbox's own renderer
  (links open in a new tab, no images load, text aimed at an AI is flagged).
  Read from Gmail on demand through the new read-only
  `GET /api/follow-ups/email`: through the mailbox gate with an 8 s deadline,
  ahead of background reads already queued (`retry.front`), cached a minute,
  a message id followed to its thread. The session reads the next email ahead
  and checks a copy older than 30 s again, since a reply goes to the newest
  message. Meeting recaps (from Granola) get no control. The demo shows
  fictional emails.

- **The Inbox marks a message as yours only from your exact address.** It
  matched any From header containing the mailbox's address, so a lookalike
  such as `you@firm.com.other.example` showed as "(you)".

- **Ask Arwin answers ping your computer (web and server side, desktop
  0.4.1).** When Arwin answers a question you asked, your own computers with
  desktop alerts on show "Arwin replied" (or "Arwin replied to N questions")
  with the answer's first line as plain text, up to 100 characters, and a
  click opens that conversation. Only the person who asked gets it: other
  members' computers, Nick's included, never get yours. Not while you are
  looking at the app: the alert carries a new `quietWhenFocused` flag, which
  0.4.1 honours by counting it as shown and telling the page, whose widget
  then reads that conversation, and the others answered in the last 10
  minutes (a grouped alert names only the newest), and shows its own pop-up,
  also for a question asked from a phone or a browser; an answer the full
  Ask page showed as it landed is handed to the widget as seen, so it is not
  announced twice. Any hour, no 8am-8pm window, but only for answers that
  landed in the last 10 minutes, after the computer was turned on, and at
  most 2 hours after the question, so a thread touched for another reason
  never replays an answer older than that. Keys `ask:<answer id>` go in each
  computer's ledger. While your own question waits (up to 30 minutes),
  `GET /api/desktop/alerts` first settles answers from the Slack relay and
  tells the app to ask again in 30 seconds, day or night, so an answer pings
  about 30 seconds after it lands (up to 45). The widget also has the app
  ask within 30 seconds straight after a question, so one asked at night
  pings too. Sent only to apps from 0.4.1, by their User-Agent; Settings
  mentions it in those apps only. Phones unchanged. No migration (D-058).
- **Ask: a question goes only into your own conversation.** `ask()` now
  refuses a thread id that belongs to someone else ("That conversation does
  not exist.", as the widget's read already did), since its answer would
  alert that person's computers (D-058).
- **Desktop app 0.4.1: Ask Arwin answers as alerts.** An alert can ask to
  stay quiet while the main window is shown, not minimised, in front and on
  the live site; it then counts as shown, never comes later, and the page is
  told (`tiptop-desktop-replied`, with the alert's path). A sixth page
  command, `alerts_poll_soon`, lets the widget have the app ask within 30
  seconds after a question: at most one poll per 30 seconds however often it
  is called, and nothing while alerts are off, failed polls back off or
  Copilot asked the app to wait. Either release order works. On-device
  checks: desktop/README.md, item 16.
- **Desktop app 0.3.1: new versions show up without asking.** The app now
  looks every hour instead of every 6, and also whenever its window comes to
  the front (at most every 15 minutes), so an app left open all day offers a
  new version soon after it is released. Later keeps that version quiet for
  4 hours; Check for Updates… still asks at once.

- **Desktop alerts, web and server side (desktop 0.4.0).** Settings ›
  Preferences in the desktop app swaps the "Alerts can’t show in the desktop
  app" line for a Desktop alerts card: the same alerts and rules as phone
  alerts (meetings 5 minutes ahead, money or legal going stale, the morning
  top 3, LPs and founders waiting, portfolio newly at risk, DocSend opens,
  campaigns sent; each item once; everything but meetings 8am to 8pm), off
  until someone turns them on, per computer. Enable asks the system for
  permission, then `POST /api/push/desktop` (signed in, same origin, 10 an
  hour) mints a token for that computer, answered once and handed straight to
  the shell; only its SHA-256 is kept, in an `audit_events` row
  (`push.desktop`), so no migration. The shell asks the new public
  `/api/desktop/alerts` with that token: GET works out what is due for that
  computer from the phone job's inputs (cached per organization, so many
  computers cost no extra Calendar or Slack reads), POST records what it
  showed in a ledger of its own (`push.desktop_alerted`), DELETE turns it
  off. It asks every minute from 6am to 9pm in the owner's timezone and is
  told to wait until 6am at night, so the server can still sleep. A phone and
  a computer each ping for anything new; whatever a phone already got before
  a computer was turned on stays quiet there. Turn off, signing out in the
  app, the list of computers in Settings (any device; whoever turned it on,
  or an admin; each row shows the end of the computer's id, and only those
  who may turn it off are sent the whole id) and leaving the organization
  all turn a computer off. A 401 from the endpoint always carries its realm,
  a store failure is a 503, and the per-computer limit is keyed on the
  organization and computer and charged only once the token checks out, so
  nobody can make a colleague's computer miss a meeting. At most 5 computers
  per person and 20 per organization. Older apps see "Update the app to get
  desktop alerts." and that phone alerts are turned on from a phone. Nothing
  changes for phones (D-057).
- **Desktop app 0.4.0: alerts on your computer.** Windows toasts and macOS
  notifications (Notification Center), from the shell itself, so they come
  while the window is hidden in the tray or closed on a Mac. A click brings
  the window forward and opens the alert's page through the page's own link
  handling, so a campaign that is sending still asks before leaving; meeting
  alerts open the call in the browser. 0.3.x apps get it through the in-app
  updater. Release order: publish `desktop-v0.4.0` (after the lock job has
  committed Cargo.lock on the branch) before the web side reaches master, so
  nobody is told to update before there is an update. The on-device checks
  in desktop/README.md (item 15) are still to do.
- **On a phone, the Ask Arwin page puts the question box before Recent.**
  Recent came first, so with a long history the box was a screen down and
  appeared only once the page had scrolled to it. From lg up, Recent stays
  beside the conversation.
- **Desktop app 0.3.0: a Slack-style top bar.** On Windows the grey title bar
  and the File/Edit/View bar are gone. One bar in the emerald of the sidebar
  and page header beneath it runs across the top of the main window, with a
  menu button at the top left (File, Edit and View as a native menu, dark like
  the bar; Alt or F10 opens it too), Back and Forward, a Search Copilot field
  that opens search just under it (Ctrl K), and minimise, maximise and close,
  in Windows 10's or 11's own style. Scrolled, the page column's top corners
  round off under the bar, so bar and sidebar frame the page. Drag the bar to
  move the window and double-click it to maximise; edges, snapping, Alt+F4 and
  the window shadow work as before (rounded corners on Windows 11 only). On a
  Mac the menu bar stays at the top of the screen and the traffic lights sit
  in the same bar, with Back, Forward and search. The bar follows Copilot's
  light and dark theme and keeps its size at any zoom. Attachment and briefing
  windows keep a normal title bar and menus. The one visible change outside
  the bar: scrollbars on Windows become the thin overlay kind, so none sits
  beside the close button. The live page can now ask the main window to move,
  minimise, maximise, close or open the menu, and read whether it is
  maximised; dragging and double-click maximise can also reach the attachment
  windows. The menu opens only for a real click on the menu button or a tap of
  Alt or F10, which no script can fake. Nothing else (D-056). 0.2.x apps get
  it through the in-app updater; the web side ships first and shows nothing
  until a 0.3.0 app opens it.
- **Web side of the desktop app's top bar (desktop 0.3.0).** The page now
  draws the desktop app's title bar itself, from the root layout, but only in
  the main window of a 0.3.0 or newer app, which says so with a second
  read-only global (`__TIPTOP_DESKTOP_FRAME__`) read before first paint: a
  menu button (Windows), Back and Forward, a Search Copilot field that opens
  search, and minimise, maximise and close (Windows), in the colour of the
  page-header band or rail below it. The page, sticky bars, dialogs, drawers,
  the Ask Arwin panel and tour cards all leave room for it (`--titlebar-h`,
  0px everywhere else), and it keeps its size at any View > Zoom. In a
  browser, an older app or an attachment window nothing changes. Settings and
  Download say Check for Updates… is under the menu at the top left from
  0.3.0.

- Desktop app 0.2.1: no changes beyond the version, released to prove that 0.2.0
  updates itself from inside the app.

- **The desktop app updates itself, from 0.2.0.** About 15 seconds after
  launch and every 6 hours (30 minutes after a check that failed) it asks
  Copilot for a newer version, downloads it in the background and asks once
  to restart: Later is the default button and asks again at the next check;
  Restart now takes about 10 to 20 seconds. Check for Updates… is in the File
  menu on Windows and after About on a Mac. Every update file is signed by a
  release-only CI job (the build jobs never see the key) and checked against
  the public key built into the app, and the version it was signed for,
  before it installs. Two new public, rate-limited routes serve it with no
  session: `/api/desktop/update/<os>/<arch>/<version>` answers 204 or the
  version, signature and download URL, and
  `/api/desktop/update-file/<platform>/<version>` streams that file through
  Copilot, for the version on offer only. People on 0.1.0 download 0.2.0 once
  more; /download and Settings say so (see D-055).
- **Desktop app 0.2.0: File, Edit and View menus** on Mac and Windows.
  Settings, Close Window and Quit; Undo through Select All, including Paste
  and Match Style and Delete; Reload, Force Reload, Full Screen and zoom (per
  window; the main window's is remembered). On a Mac the Go menu (Back,
  Forward, Today) and the Window menu are removed, so ⌘M no longer
  minimizes, and Zoom In is ⌘=, not ⌘+. Windows shows the menu bar under the
  title bar of each window, dark in Windows dark mode; zoom there is from the
  View menu only.
- **A desktop app for Mac and Windows.** Settings › Preferences links to a new
  Download page with an installer for each, streamed through Copilot itself
  (no page links anywhere else). The app is a window onto the live site, so
  every web update shows up in it at once, and from 0.2.0 it installs new
  app versions itself. The installers are unsigned, so the first install
  takes one extra step, shown with a picture on the page: Open Anyway in the
  Mac's Privacy & Security settings, or More info, then Run anyway on
  Windows. Installing Copilot from Chrome's address bar is offered as the
  option with no warnings. Built by a new GitHub Actions workflow on
  standard runners; `DESKTOP_RELEASE_TOKEN` is recommended so the page can
  read release details with its own quota (see D-054).
- **Signing in to the desktop app goes through the browser.** Google will
  not sign anyone in inside an app's window, so Sign in with Google opens the
  web browser, which shows a 4-character code after Google; typing it into
  the app signs the app in. A sign-in lasts 10 minutes, three wrong codes
  end it, the browser page can stop it ("I didn't start this"), and it works
  once. It needs `20261017000000_desktop_handoffs.sql` applied in the
  Supabase SQL editor first; until then the app says sign-in is not
  available, and nothing else changes.
- **Inside the desktop app, phone alerts and connecting Google point
  elsewhere.** Alerts cannot show there, so Settings says to turn them on
  from a phone; connecting Google and turning on sending say to use a web
  browser, since Google's consent screen will not open in the app.
- **Campaign confirmations use Copilot's own dialog.** Cancelling a
  campaign, retrying failed sends, settling "may have gone out" emails,
  deleting a draft, removing all recipients, putting an address back on and
  the "Leave while sending?" question no longer use the browser's confirm
  box, which the Mac desktop app silently answers with Cancel. Each asks the
  same question as before, in a dialog with named buttons.
- **Sign-in brakes for routes reached before sign-in.** The rate limiter now
  drops spent windows once it holds many keys, and per-address limits on the
  new sign-in routes treat an IPv6 /64 as one caller.
- **Inbox attachments the browser cannot show download in place.** PDFs and
  images still open in a new tab; a Word, Excel or zip file now downloads
  without opening one, so the page (and any half-written reply) stays put and
  the desktop app leaves no blank window behind.
- **The asks read gets through Gmail's rate limit, and says why when it
  cannot.** It matched 20 portfolio updates but read one body: every other
  thread read was refused (most likely Gmail's per-user rate limit, after
  300 header reads, with the numbers refresh reading the same mailbox) and
  each refusal was dropped without a word. Background reads (the asks read,
  and the stored numbers' refresh, which shares the bodies) now try a 429, a
  403 rate limit and Gmail's 500/502/503/504 again, up to four tries, after
  Retry-After or a backoff from about a second, and no request or wait runs
  past the read's deadline; 400, 401 and 404 are never tried again. They
  share one gate per mailbox, whichever reader asks: four at once, the rest
  queued, and after a rate limit none starts until its wait is over, so the
  numbers refresh and the asks read pace each other when the daily job or a
  Portfolio view runs both. Pages (Inbox, Ask, Reports, and the numbers' first
  read when nothing is stored) still fail at once. The asks read takes bodies
  two at a time with a short pause, and its `portfolio.asks_read` row adds
  `metadata_read`, `bodies_failed` and `body_fail_codes` (`rate_limited`,
  `gmail_5xx`, `gmail_4xx`, `not_found`, `timeout`, `deadline`,
  `provider_unavailable`, `empty`; codes only, no mail); a body that came back
  with no text counts as `empty`, not as read. A long update now keeps its
  last 6,000 characters as well as its first 14,000, so an asks section at
  the end is no longer cut off; the quoted history under a long reply is cut
  first, so an older update's asks and numbers are never read as the new
  one's, and the cut is never read into an ask.
- **Asks are read the way founders write them, and every read leaves a
  record.** Real updates rarely put their asks in bullets under "Asks": they
  write "My ask" over short titles of one sentence each, "Top asks for this
  month" over "None right now", "How you can help:" or a bold "One ask." with
  the ask on the same line, a paragraph whose one asking sentence sits among
  news and numbers, Gmail's plain-text lists, lists a mailer flattened onto
  one line, or HTML from investor-update platforms. Each is now read: a title
  line becomes "Title: sentence", only a paragraph's sentences with asking
  words are kept (never a line of numbers, news, a thank-you for past help or
  "would love to catch up"), and a bare "Hiring" takes the roles under it.
  "None"-style answers, lines about the asks ("same asks as last month"),
  "Thanks for the help!" lists and the thank-yous under "Asks & thank yous",
  "reply to me" sentences, sign-offs, signatures, rules and the next heading
  give nothing; under a bare "Requests" heading only items that read as asks
  count. At most six asks of 300 characters an email, and an ask that reads
  as instructions to a model is still left out. Checked offline against 38
  real update emails from the last 60 days (strict count-and-match grading):
  the asks under each asks heading are caught and nothing else is taken; an
  ask written only in an email's opening paragraph, with no asks heading, is
  still not read, by design. Opening Requests now hands the Gmail read to run
  after the response, and every read, daily or from a view, writes a
  `portfolio.asks_read` audit row with emails scanned, asks found, inserted,
  skipped, inserts the store refused and an error code when it fails. Before,
  a row was written only when something new was inserted, so a read that
  found nothing or failed left no trace. One unreadable email no longer stops
  the read for every company, and an HTML entity that names no character no
  longer throws. A list nested in an HTML email keeps its nesting as text.
- **Portfolio companies show their people.** Each company card lists up to
  three contacts, strongest and most recent first, each marked "from Affinity"
  or "from your mail": founders on Affinity's portfolio and angel lists and
  person records at the company's domain (domain first, exact name second,
  never a guess), and the people at its domain who actually write to Nick in
  the synced mailbox (no no-reply, notification or shared inboxes such as
  info@, hello@, founders@, investors@, ir@ or careers@, from the mail or from
  Affinity, and nobody at TipTop). Someone saved without an address is matched
  to the same exact name in the mail, not listed twice. "Last contact" now reads the mail too, so it no
  longer says "No contact recorded" for a company Nick emails. The profile
  lists every contact with its source. Contacts saved by hand lead and are
  never changed. Worked out on read: nothing is stored.
- **Asks in update emails become requests on their own.** When a portfolio
  company's update (the mail Reports > Fresh updates lists, last 45 days) has
  an asks section ("Asks", "Our asks", "How you can help", "Ways to help",
  "Help wanted", "Where we need help", "Requests"), each bullet or numbered
  line under it becomes an open request on Portfolio > Requests, marked "Read
  from their update" with a link to the email. Prose, quoted replies and
  signatures are never read, a heading with no bullets gives nothing, and no
  model is involved. It runs with the daily job and when Requests is opened
  (at most every 30 minutes, never holding the page). Each ask is written
  once, so a re-run never duplicates one, a request marked handled or
  dismissed is never reopened, the same ask repeated in next month's update
  is the request already there, and an email someone already classified in
  the Inbox is left to their request. Requests shows one card per email (an
  update's asks together, ten cards to a page), with one Draft reply, one
  Handled / Dismiss for the card and a dismiss for each ask; Today's brief
  groups them the same way.
- **Who could help draws on Affinity.** Every open request shows up to three
  people who could help, from the contacts you imported and the people
  Affinity carried over on the Investors, Service providers, Operators,
  Events and portfolio founder lists, each with the reason the data gives
  ("On “Co-investor VCs” (Investors) in Affinity", "Relationship: Warm",
  last in touch). A request nobody fits still names nobody, and a list's
  name, a seniority word in a title or a fitting kind with recent mail is
  never enough on its own to name someone for a customer intro, advice,
  go-to-market or product feedback. Fund II's LP lists are never used. "Who can intro?" on Fund II and profiles adds the
  people Affinity holds at the same firm, with their lists.
- **Knowledge > Contacts counts the whole network.** The tab counts the
  imported contacts and the Affinity people introductions draw on (the same
  pool as Who could help, so never the LP lists), shows how many sit on each
  list that feeds introductions (linked to its Network tab), and links to
  Network > People > From Affinity; a search counts the pool's matches. The
  imported contacts are listed as before.
- **The daily auto-check now runs at 3 PM Central**, an hour earlier, and the
  app's own "Reply to" check, the snapshot's 1 to 3 PM change window and the
  "hasn't reported yet" line (from 4:30 PM) moved with it.
- **Campaign receipts.** A finished campaign opens with Affinity-style tiles
  (Sent date, Delivered "106 / 106", Issues, which shows who needs a look),
  the finish toast and the campaign list carry the same numbers, and the phone
  gets a "Campaign sent" alert with only the name and counts (one that
  finishes overnight alerts the next morning).
- **"Arwin replied" pop-up.** An answer that lands while the chat is closed
  (or open on another conversation) previews itself above the green button for
  about 3.5 seconds; click it to open that conversation. The gold dot still
  stays until it is opened. Answers landing together share one pop-up, it
  waits out a running tour, and a hidden tab gets "(1)" in its title and the
  pop-up on return. The full Ask page is now called Ask Arwin.
- **Dark mode goes black.** Dark mode's pages, cards, menu and header are a soft
  near-black instead of emerald, which is easier on the eyes. Green stays on the
  logo, primary buttons, tags and icons, gold on the rules and labels. Light
  mode is unchanged.
- **Top priorities leads Today.** The card opens the page, unchanged. While it
  holds today's list, the glance row under it shows only Intros owed and
  Coming up, and Tasks due opens on overdue tasks; with no list, or only an
  older one, Do now is back beside them and Tasks due starts closed.
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
