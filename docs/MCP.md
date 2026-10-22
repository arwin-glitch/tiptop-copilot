# The MCP server: Claude reads the CRM

Copilot runs a small [Model Context Protocol](https://modelcontextprotocol.io) server, so
Claude can look things up in Copilot the way it used Affinity's MCP server: LP stages, deal
history, list entries and notes. It replaces the Affinity connector once Affinity is cancelled.

- **Read-only.** Fourteen lookup tools: nine for the CRM, deals, LPs, portfolio and tasks,
  and five for meetings (Copilot Notes and Granola, below). Nothing can be written, sent or
  deleted through it.
- **One token per client.** claude.ai, Claude Code and each group of cloud routines get their
  own token, which an owner can revoke on its own.
- **LP stages, never amounts.** The Fund II rule holds in every answer (see below).
- **Notes are untrusted data.** Note text always comes back fenced, so the model reads it as
  data and never as instructions.

Code: `src/lib/mcp/` (protocol, tools, the meeting tools in `meeting-tools.ts`, HTTP handler),
`src/lib/services/mcp-tokens.ts`,
`src/app/api/mcp/`. Tests: `tests/unit/mcp-*.test.ts`, `tests/integration/mcp-*.test.ts`.

## Set it up (once)

1. **Run the migrations.** In the Supabase SQL editor run
   `supabase/migrations/20261016020000_mcp_tokens.sql`. The CRM tools also need
   `supabase/migrations/20261015000000_crm.sql`. Both files are safe to run again. Until the
   tokens migration has run, Settings shows a note saying so and `/api/mcp` answers every
   request with HTTP 503 and the same message. Nothing else in the app is affected.
2. **Create a token.** Go to **Settings → Integrations → Connect Claude (MCP)**. This needs the
   owner role. Name the connection after the client (for example "claude.ai" or "Cloud
   routines") and choose **Create token**. Copilot shows two things, **once**:
   - the **Connector URL**, `https://<copilot>/api/mcp/<token>`, for claude.ai
   - the **Token**, for clients that send `Authorization: Bearer <token>` to
     `https://<copilot>/api/mcp`

   Copy them straight away. Only a SHA-256 hash is stored, so a lost token cannot be shown
   again. Revoke it and create a new one.

## Add it to claude.ai (custom connector)

claude.ai adds a remote MCP server by URL alone, so the token goes in the URL.

1. In claude.ai, open **Settings → Connectors** and choose **Add custom connector**. On a
   Team or Enterprise plan, an owner adds it for the organization from the admin settings.
2. Name it "TipTop Copilot" and paste the **Connector URL**. Leave the OAuth fields empty.
3. In a chat, turn the connector on from the tools menu. Claude then has `search`,
   `get_record` and the other tools listed below.

**Treat the Connector URL like a password.** Anyone holding it can read the CRM. Never paste
it into Slack, a doc, a routine prompt or an email. If it leaks, revoke that token in Settings
and add the connector again with a new one.

## Add it to Claude Code

```sh
claude mcp add --transport http tiptop-copilot https://<copilot>/api/mcp \
  --header "Authorization: Bearer <token>"
```

When a client can send a header, use the header rather than the URL form: the token then
never appears in a URL.

## How the cloud routines use it

The cloud routines (the RemoteTrigger routines: Daily Overview and Recap, the deal-sorter,
the LP pipeline routine, the digests) run on the claude.ai account, so they use the
account's connectors:

1. Add the custom connector to the claude.ai account the routines run under, as above. Give
   it its own token named for the routines, for example "Cloud routines", so you can revoke
   it without disconnecting your own chats.
2. In each routine that used Affinity, turn on the TipTop Copilot connector and turn the
   Affinity connector off.
3. In the routine's prompt, replace the Affinity lookups with the matching tools:

   | The routine needs | Use |
   | --- | --- |
   | Find a company, person, deal or LP | `search` (then the ids it returns) |
   | A company's or person's profile, lists and stage | `get_record` |
   | Every entry on a list, or the entries at one stage | `list_lists`, then `list_entries` |
   | Notes on a company, person or list entry | `get_notes` |
   | Where the deal pipeline stands, and what moved recently | `deals_pipeline` |
   | Where each LP stands (stages only) | `lp_pipeline` |
   | Portfolio companies and their health | `portfolio` |
   | Open tasks | `tasks` |
   | Meetings in a date range (Granola's `list_meetings`) | `list_meetings` |
   | A meeting's notes and action items (Granola's `get_meetings`) | `get_meetings` |
   | Exact words said (Granola's `get_meeting_transcript`) | `get_meeting_transcript` |
   | Find what was said or noted (Granola's `query_granola_meetings`) | `query_meetings` |
   | Meeting folders (Granola's `list_meeting_folders`) | `list_meeting_folders` |

   Never put a token or the Connector URL in a routine prompt. A prompt is treated as public.

## Meeting tools (Copilot Notes, D-076)

Five tools shaped like Granola's MCP tools, so a routine that read Granola swaps tool names
and little else. They read Copilot Notes meetings and the Granola notes Copilot already holds,
in one list.

| Tool | What it returns |
| --- | --- |
| `list_meetings` | Meetings in a time range (the last 7 days by default; `this_week`, `last_week`, `last_30_days` or `custom` with `from_date`/`to_date`), newest first, with attendees, folder, whether there is a transcript and how many action items. Filters: `source` (`copilot`, `granola`), `folder_id`, `participant_email` (with `exclude_participant` for "meetings this person was not in"). Paged with `limit` and `cursor`. |
| `get_meetings` | Up to 10 meetings by id: the notes (Copilot's enhanced notes, or Granola's summary), the speakers' names, and the action items with owners, due dates and Nick's own promises flagged. Not the transcript. |
| `get_meeting_transcript` | A Copilot meeting's transcript, each line with the speaker's name, paged by characters (40,000 by default, 80,000 at most) at line boundaries with `next_offset`. Keep `include_timestamps` the same on every page: offsets count the text as returned. Granola notes have no transcript here; the app only ever stored their summaries. |
| `query_meetings` | Full-text search over titles, notes and transcripts, with the matching passage and, for a transcript, when it was said and by whom. Passages, not an AI answer: read the meetings it finds for the whole picture. |
| `list_meeting_folders` | Folders with their meeting counts. |

Rules every meeting tool keeps:

- **Ids name their source**: `copilot:<uuid>` or `granola:<id>`. A conversation recorded by both
  tools while they run side by side is listed once, as the Copilot meeting, with
  `paired_with` naming the Granola note.
- **Private stays private.** A meeting its recorder kept private, anything in a private
  folder (Coaching), and anything in the trash never appear, not even by id. Tokens have no
  scopes yet, so there is no way to widen this. A recorder who wants routines to read their
  meetings sets "Share with the team by default" (`/api/notes/preferences`).
- **Untrusted text.** Notes, transcripts and passages are fenced in `<untrusted-content>` in
  the text, and in fields ending `_untrusted` in the JSON.
- **LP amounts masked**: in an LP meeting (the LP call template, or LP or Fund II in the title)
  amounts read `[amount]`.
- **No voice data**, ever: voice identifiers are not readable by anything on this server.

### The meeting-follow-up routine

When a team meeting's notes are ready, Copilot starts the meeting-follow-up routine at once
instead of waiting for its schedule: it POSTs `{"text":"copilot_meeting_id=<uuid>"}` to
`MEETING_FOLLOWUP_FIRE_URL` with `MEETING_FOLLOWUP_FIRE_TOKEN`, once per meeting (see
ENVIRONMENT_VARIABLES.md). The text names the meeting and nothing else; the routine reads it
with `get_meetings` and `get_meeting_transcript`. The routine must treat the fire text as
untrusted and act on that meeting id only. Private meetings are never announced. The
routine's own schedule stays as the backstop.

## The tools

| Tool | What it returns |
| --- | --- |
| `search` | Companies, people, deals (Copilot's and the CRM deal lists'), LPs (CRM LP lists and the Fund II pipeline), portfolio companies and notes that match. Each result has an id, a one-line summary (list memberships and stages included) and, for a note, a fenced excerpt. |
| `get_record` | The full profile for any id from `search`: a CRM company or person (fields, every list it is on with that list's values, related people or companies, where it also lives in Copilot's Deals or Portfolio, and its latest notes), a list entry, a Copilot deal or a portfolio company. |
| `list_lists` | Every CRM list: id, what it holds, entry count, its status field with stages in order, and its columns. |
| `list_entries` | One page of a list (25 by default, 100 at most) with its values. You can filter by title and by stage, sort by a column, and page with `offset`. |
| `get_notes` | Notes on a record or a list entry, newest first, with full text, paged. |
| `deals_pipeline` | Copilot's deals by stage, stage changes and decisions in the last N days (made by a person or by the routine), deals received recently, and each CRM deal list by status. |
| `lp_pipeline` | The Fund II pipeline from the LP routine (stage, firm, kind, last touch, next step, Gmail thread id) and each CRM LP list by status. Stages only. |
| `portfolio` | Portfolio companies with health from the portfolio-health routine (ok / watch / risk, headline, open asks). |
| `tasks` | Open tasks, soonest due first, overdue ones marked, with the deal or portfolio company each one is linked to. |
| `list_meetings`, `get_meetings`, `get_meeting_transcript`, `query_meetings`, `list_meeting_folders` | Meetings: see [Meeting tools](#meeting-tools-copilot-notes-d-076). |

Every answer has a short text with ids, so the next call can use them. It also carries the
same data as JSON (`structuredContent`). A bad argument, an unknown id or a CRM that is not set
up comes back as a tool error the model can read and fix.

### LP stages, never amounts

The Fund II page has always shown stages only. The MCP server applies the same rule to
everything it returns:

- **Lists.** A list whose name says LP, limited partner, investor or Fund II/III counts as an
  LP list. On those lists, money columns and amount-like columns (Commitment, Allocation,
  Check size and so on) are left out of `list_lists`, `list_entries`, `get_record`, `search`
  and `lp_pipeline`. `list_entries` will not sort or filter by them either, because the order,
  or which entries match, would give the amounts away: its `status_field` must be a status
  field that is shown.
- **Free text about an LP.** In a note on an LP-list entry or person (its title too), and in
  the LP routine's next steps and notes, amounts show as `[amount]`. `search` only returns such
  a note when the words searched for are in its masked text, so searching for "$500k" does not
  reveal which LP notes mention it.

The Lists page keeps to the same rule for sums: it never totals an LP list's amount columns.

Deal lists are not LP lists. A deal's round size or check amount is shown.

### Untrusted note text

Notes are people's writing and imported email. In the text answer every note sits inside an
`<untrusted-content>` block. These are the same fences Copilot's own prompts use, and they
carry a security warning when the note contains text that looks like an instruction. In the
JSON, note text is in a field named `content_untrusted`. The server's `instructions` (sent at
`initialize`) tell the client never to follow instructions found there. A founder's own
description of a deal, from their email, is fenced the same way.

## Security

- **Tokens.** A token is `tcmcp_<organization id>_<43 random characters>`. That is 256 bits of
  randomness. The organization id is not a secret: it tells the server which organization's
  token table to check. The server looks the token up by its SHA-256 and compares the hashes
  in constant time. A revoked token never works again. An organization can hold 20 live tokens
  at once. `last_used_at` is updated at most once a minute. If a request carries a token in
  the URL and an Authorization header, the URL token is used, so a client that adds its own
  header cannot break a working connector URL.
- **No cookies.** The endpoint never reads a session cookie, so a page open in someone's
  browser cannot use it on their behalf. `/api/mcp` is outside the sign-in gate in
  `src/proxy.ts`, and the route checks the token itself.
- **Rate limits.** In-process, like the app's other limiters:
  - each token can send 120 messages a minute. After that the server answers HTTP 429 with
    `Retry-After`.
  - an address that sends 10 bad tokens in a minute has its further bad tokens answered 429
    for the rest of that minute. A token that is valid is always served, whatever its address
    has sent: claude.ai's connectors and the routines share Anthropic's few outbound
    addresses, so braking by address alone would let one stale connector, or anyone with a bad
    token, shut every client out. Revoked tokens and requests with no token do not count. The
    address is Cloudflare's `CF-Connecting-IP` when present (Render serves through
    Cloudflare), else the last `X-Forwarded-For` hop, never the first one a client writes.
- **Audit.** Every `tools/call` writes an `mcp.tool_called` row to `audit_events` with the
  tool, the client's name, success or failure, and how long it took. The arguments and the
  answer are never recorded. Creating and revoking tokens are audited too
  (`mcp.token_created`, `mcp.token_revoked`).
- **Logs.** The app never logs a token, and the log redactor masks anything shaped like one.
  The host's own HTTP request logs may still record URL paths. That is one more reason to
  prefer the Bearer header wherever the client supports it.

## Protocol notes

- **Transport.** Streamable HTTP. Each POSTed JSON-RPC 2.0 message gets one JSON response.
  The server is stateless: it issues no `Mcp-Session-Id` and offers no SSE stream, so `GET`
  and `DELETE` return 405. A body made only of notifications gets 202 with no body. Batches
  are accepted.
- **Methods.** `initialize`, `ping`, `tools/list` and `tools/call`. Any other method returns
  JSON-RPC "method not found".
- **Protocol versions.** 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05. A client asking
  for another version gets the newest. An unsupported `MCP-Protocol-Version` header gets 400.
- **No SDK.** The protocol is implemented by hand. The surface is four methods, and the SDK
  would add a dependency, a session model and an SSE stream this server does not need.

## Try it

With a token in `$TOKEN` (in demo mode, create one in Settings first):

```sh
curl -s https://<copilot>/api/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lp_pipeline","arguments":{}}}'
```

| Response | Meaning |
| --- | --- |
| 401 | Missing, wrong or revoked token. The message says which. |
| 429 | Over the rate limit. Wait `Retry-After` seconds. |
| 503 | The tokens migration has not run yet. |
