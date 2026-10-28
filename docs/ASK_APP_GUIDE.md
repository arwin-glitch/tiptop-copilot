# Ask Arwin knows its way around Kraken

Ask Arwin answers questions about the app itself ("Where is the job board?",
"How do I snooze a task?", "Which tab shows DocSend readers?") so nobody has to
open Help to find something. Help, its cards and the guided tours are unchanged;
the Help page only gains one line: "Tip: you can also ask Arwin where anything is."

## Where the answers come from

Everything comes from the Help registry, `src/lib/help/registry.ts`: page names,
purposes, tabs (with their links), Help sections (Jobs, Students & interns,
Booking assistant) and every tour step. `src/lib/help/app-guide.ts` indexes it.
There is no copied list of pages, so a new page or tab is findable as soon as it
has a Help entry.

The only hand-written part is `SYNONYMS`: everyday words that point at an entry
("snooze" to Tasks › Snoozed, "job board" to Portfolio › Jobs, "phone alert" to
Settings › Preferences). `tests/unit/app-guide.test.ts` fails if a synonym points
at an entry that no longer exists, or if any page cannot be found by its own name.
Synonyms are strong (words for the app itself: snooze, booking link, job board)
or weak (everyday words mostly used about data: email, wire, intro, pitch,
metrics). A weak synonym nudges the ranking but never makes an answer confident
on its own. Help itself is the one entry built in `app-guide.ts` rather than read
from the registry, since the registry has no entry for the page that reads it.

## The three paths

1. **Instant answer** (`ask()` in `src/lib/services/chat.ts`, before either
   existing path). When the question is shaped like an app question
   (`isAppQuestion`: "where is…", "how do I find/open/turn on…", "which tab…")
   and one place clearly wins, Arwin answers at once:
   "It's on Portfolio, in the Jobs tab." plus what the tab holds. The answer is
   stored as a normal assistant message (model `kraken-app-guide`, shown with a
   "From Help" badge instead of "AI-generated", no tool calls, audit metadata
   `routed_to: 'app_guide'`)
   with `help` citations: each one becomes a button that opens the page or tab,
   and the first one with a tour adds "Show me", which closes the chat and
   starts that page's tour on that tab. When two or three pages fit about
   equally and each is named outright, they are offered as choices. Nothing is
   fired and no model is called, so it costs nothing and works with or without
   the bridge.

   It leans hard toward falling through, because a wrong page pointer costs
   the real answer. These always go to the full answer as before:
   - questions about someone's data, even typed in lowercase: a name after
     from/for/about/with ("where is my email from bob"), a possessive
     ("nick's calendly link"), people after from/about ("the feedback from the
     founders"), a pronoun ("a meeting with them");
   - advice or asking Arwin to act ("how should I reply…", "how can we
     improve…", "how can I reach the founder");
   - status ("where are we on the wire", "where is the money");
   - a time ("my notes from yesterday", "today's meetings");
   - a bare "where is the X" unless X names a page, tab or Help card (or says
     page, tab, link…): "where are the notes" falls through;
   - any question in a deal-scoped chat, and follow-ups in a thread that lean
     on the conversation ("where is it?").
2. **Direct model path** (no `ASK_BRIDGE_TOKEN`): the model has a read-only
   tool, `app_guide_search`, that returns the same matches with `help:` citations
   it can cite. Its description says to name only pages it returns. The system
   prompt and the Ask Arwin persona block are unchanged.
3. **Bridge path** (production): a pending question about the app itself
   (`isAppQuestion`) that matches something in Help carries an `app_guide` field, up to three entries of
   `{ title, page, tab, link, tour_link, why }`, with links on the app's own
   origin (`APP_URL`). It is in the `/fire` text (`fireText`) and in the
   webhook's pending list (`listPendingBridgeQuestions`). Questions about mail,
   deals or meetings, and app questions with no good match, carry no field, so
   their payload is exactly as before.

## Routine prompt addition

Paste this paragraph into the ask-bridge routine's instructions, as its own
section **after** (outside) the "ASK ARWIN - WHO YOU ARE" persona block. Do not
edit the persona block itself; it must stay byte-identical to
`ASK_ARWIN_PERSONA` in `src/lib/ai/prompts/index.ts`.

```
KRAKEN APP GUIDE
If the question includes app_guide, it lists the places in Kraken the question may be about, taken from Kraken's Help centre. Use it to answer questions about where things are or how to do something in Kraken: name the page and the tab, say in a few words what is there, and give the link. If tour_link is present, you can offer it as "Show me" for a guided tour. Never invent a page, tab, button or link that is not in app_guide; if app_guide does not cover what was asked, say you are not sure where that is and suggest the Help page. When the question is about Nick's data (email, deals, meetings), answer that as usual and use app_guide only to point at where to see it.
```

No routine has been edited by this change. Until the paragraph is pasted, the
routine simply ignores the extra field; plain "where is" questions are already
answered in the app before they reach it.

## The chat

The Ask Arwin widget shows three app starters after the usual ones
(`APP_GUIDE_SUGGESTIONS`: snoozed tasks, the job board, phone alerts). A test
checks each one gets an instant answer.
