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
| `updates-mrkdwn.test.ts` | Slack mrkdwn: the link whitelist, entities, emphasis, emoji, blocks, footers |
| `updates-parse.test.ts` | The classifier and the three dealflow report formats, deal counts and people's replies; digest items, run notes, flags, open asks, housekeeping and notes; the roster |
| `updates-render.test.ts` | Rendered Updates markup: no script, no handler, no `javascript:`, `rel`/`target` on every link; what each card keeps in view |
| `updates-service.test.ts` | The Slack reader: access mapping, pagination, replies, cache, throttle, Retry-After, dropping a channel whose access was withdrawn, a post the parsers cannot read, and that demo mode makes no network calls |
| `updates-refresh-action.test.ts` | The Refresh action: sign-in first, six a minute per user, nothing read while sign-in is unrestricted |
| `calendar-grid.test.ts` | The calendar views' arithmetic: Day/Week/Month ranges, stepping, labels, DST-safe placement, side-by-side overlaps; Google's overlap layout on a busy day (cascading over long blocks, side by side within 45 minutes, the minimum chip width and its half-pixel tolerance at the boundary (three at noon fit at 1440, D-072), "+N" folds, no event lost, the same whatever the order); month packing with "+N more" |
| `calendar-colors.test.ts` | Colours from Google: an event's colorId, else its calendar's; the palette and its names |
| `calendar-labels.test.ts` | Google's colour labels and the looks (D-070): reading a calendar's labels, an event's colour (its label's, else its colorId's, else its calendar's), a label write is eventLabelId alone with eventLabelVersion=1 and never an email while a colour write never carries the version, the legend and its filter (named labels only, merged by name; a colour nobody named filters as "Unlabelled"), Google's picker order (CIE LCh hue, the ten colours of Google's own picker in its order, greys last, ties by name), Google's colour names by hex else "Colour #rrggbb", the picker split into named chips and plain colour dots, a label asked for by any spelling, how an event looks (ended, not answered, maybe, declined), and the suggested label with every case where it stays quiet |
| `calendar-legacy-links.test.ts` | The retired day list's addresses (D-072): `?view=list` and `?day=` open Day on that date (today for a bare `?view=list`), other parameters kept, a view the address names kept; every other address left alone |
| `calendar-origin.test.ts` | "How you got here" for a guest-less event: the search terms an event gives (organizer, linked sites, distinctive title words), the ranking of what a search found (the ticket email first, the invitation, a meeting note or an earlier event after the emails, nothing below the bar), and the words and Inbox search when nothing turns up |
| `calendar-edit-rules.test.ts` | Who may change an event, the guests prompt every time guests are involved, only Send becomes sendUpdates "all", recurring scopes, what a change sends |
| `calendar-write-boundary.test.ts` | Only the Calendar tab's edit route reaches a calendar write; the readers, pings and parity check name none; nothing defaults to emailing guests; a colour or a label from the event card has no `notify` and is always sendUpdates "none", and only the label request and the write module name the label switch; the label, look and origin modules name no write; the calendar-editing scope is asked for only by the opt-in flow |
| `calendar-event-actions.test.ts` | The event card's requests: Going? sends only Nick's own entry (Google's answer-only form, `attendeesOmitted`) and maps Send / Don't send to sendUpdates "all" / "none"; a colour is colorId alone, never an email; Duplicate's draft; which options a card offers (read-only events get only Join, Copy link, Email guests, Open in Google); the repeat rule, the guests' answers and a description as safe words and links |

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
| `calendar-current-reader-pin.test.ts` | The day reader (Today, the card's context box, the parity check) reads exactly what it read before the views (a pin) |
| `calendar-pings-pin.test.ts` | The meeting pings' request and verdicts are unchanged (a pin) |
| `calendar-range.test.ts` | The new views' reader over the mock calendar and Google's pages: calendars, recurring instances, all-day, colours, verdicts, caching; the parity check; per-person settings (Week by default, the view, toggles and filter remembered; the retired switch's `preview` flag ignored on older rows, accepted and dropped on a save, rows written as `v: 3`) |
| `calendar-edit.test.ts` | Writes against the mock calendar: create with Meet and guests, Send vs Don't send, move, resize, move calendars, delete with and without cancellations, recurring scopes, refusals without the grant or on view-only events |
| `calendar-event-card.test.ts` | The event card's writes against the mock calendar: Duplicate saves a new id, a colour records colorId alone with sendUpdates "none" (from the editor too, even with Send), Going? Send vs Don't send with every other guest's entry left as it was, refusals for the organizer, a view-only calendar and no grant |
| `calendar-labels.test.ts` | Google's colour labels over the mock calendar and Google's endpoints (fetch stubbed): reads send eventLabelVersion=1 and come back with each event's label and colour, labels kept under a minute, a calendar whose labels fail still draws; a label write is exactly {eventLabelId} with eventLabelVersion=1 and sendUpdates "none" (cleared with ""), refused without the grant, on a view-only calendar and for a label the calendar lacks; a colour, an edit and an answer never send the version and leave the label on (the mock drops a label a write sends the version without); the main calendar's 24 slots (nine named, fifteen not) give the picker and the legend the named labels only, in Google's order, and the dots Google's colour names; a colour dot is the same write (its slot's eventLabelId alone, eventLabelVersion=1, sendUpdates "none"); Ask's calendar tool returns named label names in Google's order, no name for an event in a colour nobody named ("none" lists it), and filters by name; the suggested label from Copilot's data; the ticket email found for a guest-less registration, and the "nothing found" words; Diagnostics' counts; the legend's filter remembered |

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

**`calendar-default.spec.ts`** runs first of the calendar specs: a plain
`/calendar` opens Week for a person who has chosen nothing, with no "New
calendar" switch and no day list (D-072); `?view=list` and old `?day=` links
open Day on that date with any other parameters kept, and leave the saved view
alone; Today's "Full day and meeting prep in Calendar" link lands on today's
Day. On the demo's conference day (long overlapping blocks under short
meetings) every chip is at least 36px wide (half a pixel less at most) at 1440
and 1280, the three meetings at noon fit side by side at 1440 and fold into a
"+2" at 1280, no title can break inside a word, a word too long for its chip
ends in an ellipsis, a "+N" lists what does not fit and opens its card (which
gives the "+N" focus back), and a phone's week fits without scrolling sideways
while its label chips scroll in their own strip. At 1024px, over the conference
day and the day after it, the calendars panel moves behind its button, every
chip is still at least 36px, a title that wraps has room for whole words, and
no chip is wholly covered. Esc on a long block's card leaves the meetings drawn
over it on top and clickable, and a meeting dragged into a crowded row stays
drawn, on top, with nothing else moving and nothing saved on Esc.

**`calendar-display.spec.ts`** runs after `calendar-default.spec.ts` and before
`calendar-event-card.spec.ts` (which answers the board meeting it shows as
unanswered), over the demo's mock calendar (D-070, D-072): the named labels of
the calendars shown, in Google's order, are filter chips above the grid,
remembered, Month included, one line at 1280 with "More" for the rest (a chip
picked there lights it up and nothing moves), and no "Unnamed label" anywhere;
an event in a colour nobody named is drawn in it with no name, shows under
"Unlabelled" and its card says "Colour: Lavender"; an event's label name shows
on its chip and its card, whose picker lists the named labels, then the other
fifteen colours as plain dots with Google's names; picking a label or a dot
sends a single PATCH with the label alone and asks nothing (a dot's colour
survives a reload, which the mock allows only with eventLabelVersion=1); a
suggested label shows on the card and is applied only on a tap;
the Key explains every look; an ended, an unanswered, a maybe and a declined
event each look different while a block is filled like any event (no dashes,
no grey); a guest-less registration's card finds its ticket email with the
Copilot and Gmail links; and an event nothing explains says what was checked
and opens the Inbox on the search; Diagnostics › Event labels lists the named
labels and folds the colours without a name into one line that opens. It
leaves no filter or label behind.

**`calendar-event-card.spec.ts`** covers the new calendar's event card over the
demo's mock calendar: a click opens it beside the event (not a centred dialog)
with Google's options; a press on an empty slot only closes it; a colour (on
the team calendar, which has no labels) asks nothing and stays; Duplicate opens the editor prefilled and, with guests, asks
the invitations question; Going? asks "Send your response to the organizer?"
and Cancel or Esc writes nothing (Send is never focused first); a read-only
event offers only what writes nothing; Email guests opens the compose window
(Copy for Gmail in the demo) and sends nothing. The tests record the requests
the page sends, so a colour that asked for more than colorId, an answer with a
notify the person did not pick, or a Duplicate that touched the original
fails them. Titles wrap over whole words where a chip has room and take one
line where it is narrow; the quick editor opens beside the
dragged slot, which stays drawn; a drag across days makes one event in Month
and in Week's all-day row; and a phone gets a bottom sheet.

**`calendar.spec.ts`** holds the words the retired day list used to show, now
on each event's card: a meeting's "Meeting" and "… Pings 5 min before." with
"How you got here" in its context box, and a hold's "Block", "Hold" and "… No
ping." (the Copilot and Gmail links in the context box are in
`calendar-event-card.spec.ts`).

**`updates.spec.ts`** covers the Updates tab over the invented demo workspace,
with one shared sign-in: no Ledger line, footer or old roster anywhere in the
page, collapsed content included; report sections, digest items and notes stay
collapsed until opened, while a digest's open question stays in view; a channel
the bot cannot read shows the exact invite instruction and a link to the
channel; a link with a `javascript:` scheme is inert text; and Refresh keeps the
page.

### Determinism

`tests/e2e/global-setup.ts` deletes `.demo-data/e2e` before the run, and the
config sets `reuseExistingServer: false`. Both are necessary: the demo store is
file-backed and the server holds it in memory, so without them the suite
inherits the previous run's state and any test asserting a starting condition
passes once and then fails for ever.

Demo entry is rate-limited to 60 sign-ins a minute (`enterDemoAction`), and a
full run, one sign-in per test, fits inside one window with little to spare.
A few retried tests in the same minute, as CI's `retries: 1` allows, tip the
next sign-in onto `/login?busy=1` and cascade. A new spec should sign in once
and share the session through `storageState`, as
`today-briefing-watch.spec.ts` does, rather than add a sign-in per test.

Two timing traps that pass alone and fail now and then in a full run, when
the machine is busy:

- **Playwright's fake clock also runs `AbortSignal.timeout`.** Jumping the
  clock (`page.clock.runFor`) past a request's timeout while it is in flight
  aborts it, and code that backs off after a failure goes quiet. Wait until
  the page is done with one request before moving the clock again;
  `today-briefing-watch.spec.ts` counts the watcher's checks to know.
- **A visible heading is not a hydrated page.** The server-rendered HTML
  shows long before React has run a component's effects, so an event a test
  sends to a listener a component adds on mount can be lost. Wait for the
  listener first; `desktop-alerts.spec.ts` reads it over the DevTools
  protocol (`listening`).

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
