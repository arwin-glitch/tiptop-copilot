# Data model

Forty tables, all under row-level security.

Migrations live in `supabase/migrations/` and are applied in filename order.
Nothing is created by hand; see [SUPABASE_SETUP.md](SUPABASE_SETUP.md).

---

## Conventions

- **Primary keys** are `uuid`, defaulting to `gen_random_uuid()`.
- **Every scoped table carries `organization_id`**, with a foreign key and an
  RLS policy. This is the isolation boundary and it is never implicit.
- **Timestamps** are `timestamptz`. `updated_at` is maintained by a trigger
  (`set_updated_at`), never by application code.
- **Text fields that a model can write are length-checked** at the database
  level as well as in the Zod schema. Two gates, because a schema change and a
  migration do not ship together.
- **Nullable means unknown.** There are no sentinel values anywhere in this
  schema — no `'N/A'`, no `-1`, no empty-string-means-missing.
- **Full-text search** uses generated `tsvector` columns with GIN indexes.
  Company-name fuzzy matching uses `pg_trgm`.

---

## 1. Identity and access

| Table | Purpose |
| --- | --- |
| `organizations` | The tenant. `slug` is constrained to `^[a-z0-9-]{1,60}$`. |
| `user_profiles` | One row per auth user: name, timezone, theme preference. |
| `organization_members` | Membership and role (`owner`, `admin`, `member`, `viewer`). The join table every RLS policy consults. |

Helper functions `is_org_member(org)` and `has_org_role(org, role)` are defined
once and used by every policy, so the authorisation rule exists in exactly one
place.

---

## 2. Integrations

| Table | Purpose |
| --- | --- |
| `integrations` | One row per connected provider account: kinds, scopes, status, sync cursor, last error. |
| `encrypted_provider_tokens` | Sealed OAuth tokens. `check (token_type in ('refresh','access'))`, unique on `(integration_id, token_type)`. |
| `sync_runs` | One row per sync attempt, with a deterministic `idempotency_key`. |

`encrypted_provider_tokens` stores `ciphertext`, `iv`, `auth_tag` and
`key_version` — never a plaintext token. See [SECURITY.md](SECURITY.md) §3.

**The idempotency key is the mechanism, not a comment.** It is derived from
organization, integration, provider, cursor and window start, and it is unique
per `(organization_id, integration_id, idempotency_key)`. Re-running the same
sync upserts the same run row rather than creating a second one — which is why
the service must use the id the upsert returns, not the one it generated.

---

## 3. Email and calendar

| Table | Purpose |
| --- | --- |
| `email_threads` | Thread metadata, unique on `(organization_id, provider, provider_thread_id)`. |
| `email_messages` | The natural-key table: unique on `(organization_id, provider, provider_message_id)`. This uniqueness is what makes sync idempotent. |
| `email_participants` | Normalised addresses, indexed by address and domain, for sender-based lookups. |
| `email_attachments` | Extracted text, page count, extraction confidence, `needs_review`, content hash. |
| `calendar_events` | Events with attendees, unique on `(organization_id, provider, provider_event_id)`. |

Notable columns on `email_messages`:

- `body_text` is **null until deliberately fetched**. A routine sync stores
  metadata and a snippet. This is a privacy posture, not a performance one.
- `category_source` is `'model' | 'human' | 'rule'`. A human categorisation is
  never overwritten by the model.
- `injection_flagged` drives the badge. Flagged messages are never hidden or
  filtered out.

---

## 4. Deals

| Table | Purpose |
| --- | --- |
| `deals` | The record. Every extracted field is nullable. |
| `deal_people` | Founders and contacts, unique on `(deal_id, name)`. |
| `deal_sources` | What the deal was built from: emails, attachments, documents, notes, web. Unique on `(deal_id, kind, ref_id)`, so attaching twice is a no-op. |
| `deal_facts` | **Append-only.** Provenance for every extracted value. |
| `deal_analyses` | Versioned, content-addressed analyses. |
| `deal_decisions` | Human decisions. `check (actor = 'human')`. |
| `deal_notes` | Free text. |
| `tasks` | Follow-ups. `source` is `'human' | 'suggested'`. |

### `deal_facts` — the append-only one

```sql
value            text,          -- null is a legitimate value: "not stated"
source_type      text,          -- founder_claim | third_party_claim | document
                                -- | model_inference | web | human
evidence_quote   text,          -- the verbatim span it came from
citation_id      text,          -- resolves to a real source, or the row is
                                -- never written
confidence       real check (confidence between 0 and 1),
version          integer,
superseded_by    uuid           -- points at the correction that replaced it
```

Nothing is ever updated in place except to set `superseded_by`. The original
extraction and every correction remain visible for ever, which is what makes
"where did that number come from, and who changed it?" answerable.

### `deal_analyses` — versioned and content-addressed

`source_hash` is a hash of the evidence set plus the thesis version plus the
prompt version. Re-analysing an unchanged deal returns the stored row instead of
spending a token. Change any source, edit the thesis, or ship a new prompt
version, and the hash moves and a fresh analysis is produced.

`quality_score`, `data_completeness`, `evidence_quality` and `confidence` are
four separate `smallint` columns, each `check`ed to 0–100. They are kept
separate on purpose: collapsing them into one number destroys exactly the
information a partner needs.

`human_override` is a jsonb column recording the label, the reason, who and
when. It never rewrites `recommendation` — both are visible.

### `deal_decisions` — the human-only one

```sql
actor text not null default 'human' check (actor = 'human')
```

There is no application path that writes a decision on the model's behalf, and
if one were introduced by mistake the database would reject the insert.
`invested` is reachable only from here.

---

## 5. Portfolio, knowledge and thesis

| Table | Purpose |
| --- | --- |
| `portfolio_companies` | Companies, with priorities, hiring and GTM needs. |
| `portfolio_contacts` | People at those companies. |
| `portfolio_updates` | Classified updates with a typed ask, urgency and status. |
| `knowledge_documents` | Uploaded documents with page-aware extracted text. |
| `knowledge_chunks` | Page/section-level chunks for citation-precise search. |
| `network_contacts` | The fund's own network. |
| `thesis_versions` | Versioned thesis: weights, thresholds, stages, disqualifiers. |
| `thesis_criteria` | Individual criteria attached to a thesis version. |

`portfolio_updates.suggested_network_contact_ids` is filtered against
`network_contacts` before it is written. The database holds only ids that exist.

Asks read from a portfolio company's update email (`lib/services/portfolio-asks.ts`)
are `portfolio_updates` rows too, one per ask: `prompt_version = 'auto-asks/1'`,
`model` null, `summary` the ask as written, `citations[0]` the email (Gmail
link, and the heading in `section`). The row id is a uuid derived from the
organization, the Gmail message id and the ask's normalized text, so a re-run
inserts only ids that do not exist yet and never touches one that does: a
request someone marked handled or ignored stays that way. An ask the same
company already has (in any status, by its normalized text) and every ask of
an email someone classified by hand are not added again. Every read, from the
daily job or a view of Portfolio > Requests, writes one `audit_events` row
with action `portfolio.asks_read` and counts only in `metadata`: `trigger`
(`daily` or `view`), `state`, `emails_scanned`, `asks_found`, `inserted`,
`skipped` (asks already there, or inserted meanwhile by another read),
`insert_failed` (asks the store refused that are not there either),
`bodies_unreadable`, `messages_listed`, `metadata_read` (of those, headers
read), `updates_matched`, `bodies_failed` (matched updates whose body was not
read; `emails_scanned` counts those that were), `body_fail_codes` (that count
by code, every code present: `rate_limited`, `gmail_5xx`, `gmail_4xx`,
`not_found`, `timeout`, `deadline`, `provider_unavailable`, and `empty` for a
body that came back with no text), `error` (a code
such as `provider_unavailable`, `read_failed`, `store_failed` or
`insert_failed`, else null) and `duration_ms`. Who could help is worked out when the page is read
(`lib/network/helpers.ts`), not stored.
Portfolio company contacts beyond `portfolio_contacts` (from Affinity and the
mail) are derived on read as well (`lib/portfolio/contacts.ts`).

`thesis_versions` is versioned rather than mutable so an analysis can point at
the exact thesis it was scored against. Changing the thesis does not silently
rewrite the history of past decisions.

Fields the fund has not configured — `typical_check_range`, `target_ownership`,
`required_traction` — ship **null** and are excluded from scoring until set.
Inventing a plausible check size would be worse than leaving it empty.

---

## 6. Assistant and operations

| Table | Purpose |
| --- | --- |
| `daily_briefs` | One per user per local day. `date_key` is `check`ed to `^\d{4}-\d{2}-\d{2}$`. |
| `routine_briefings` | One per `(organization_id, kind)`, ever — `kind` is `'morning' \| 'afternoon' \| 'dossier'`. Daily Overview posts a `morning` brief and a `dossier`; Daily Recap posts an `afternoon` brief that supersedes `morning` for the day without touching `dossier`. Each post upserts on its own key rather than accumulating a history, and never moves a row back to an earlier `date_key`. A `date_key` later than today (in UTC+14) is refused at the door. |
| `chat_threads` / `chat_messages` | Ask history, with citations and the tool trail. `chat_messages.status` is `'pending'` only for an assistant row waiting on the Ask bridge (an external Claude session with live Gmail/Calendar/Slack access) to answer it — every other row is `'answered'` from the moment it is inserted. |
| `generated_drafts` | `check (sent = false)`. |
| `ai_usage` | Every model call: operation, model, prompt version, tokens, cost, ok, error code, duration. |
| `audit_events` | Everything consequential. Client IPs stored hashed. |
| `mcp_tokens` | One per Claude client of the MCP endpoint (`20261016020000_mcp_tokens.sql`; `lib/services/mcp-tokens.ts`, `docs/MCP.md`): `name`, `hint` (last four characters), `last_used_at`, `revoked_at`. Only the SHA-256 of the token is stored (`token_hash`, unique); the token is shown once. Owners can read; only the server writes. Every call is audited as `mcp.tool_called` (tool and client name, never arguments). |
| `desktop_handoffs` | One per desktop app sign-in in progress (`20261017000000_desktop_handoffs.sql`; `lib/auth/desktop-handoff.ts`). No `organization_id`: it happens before anyone is signed in, so the table is scopeless in `store.ts`. SHA-256 of the hand-off id and of the app's poll secret (`handoff_hash`, `poll_secret_hash`, both unique); `match_code`, minted when the browser receives Google's code and shown there; `attempts` (three wrong codes end it); `flow_id` (Supabase's PKCE flow, not a secret); `status` pending → code_received → claimed → signed_in, or failed with a `failure_reason`; `auth_code_sealed`, Google's code sealed with `APP_ENCRYPTION_KEY` and cleared when claimed. Expires 10 minutes after creation; deleted a day later by the start route. RLS on, no policies: only the server reads or writes it. |
| `user_feedback` | Thumbs on a specific output, for prompt iteration. |

### `generated_drafts`

```sql
sent boolean not null default false check (sent = false)
```

The column exists so the UI can state plainly that nothing was sent. The
constraint means it can never say otherwise. There is no code path that would
attempt to set it, and if one were added the database would reject it.

### `audit_events` as job state

Besides the audit trail, a few background jobs keep their state here under
their own `action`, so they need no table or migration: the phone-alert
subscriptions and delivery ledger (`push.subscription`, `push.alerted`), the
computers with desktop alerts and their ledger (`push.desktop`, one row per
computer with `entity_id` the shell's device id, `user_id` whoever turned it
on and the token's SHA-256 in metadata, replaced rather than updated;
`push.desktop_alerted`, `entity_id` the alert key, `metadata.device` the
computer), and
the Portfolio page's stored numbers (`portfolio.numbers_snapshot`, one row per
organization holding the last read, replaced by each refresh).
The daily Affinity sync keeps its progress the same way
(`crm.affinity_sync`, `entity_type = 'affinity_sync'`): the newest row's
`metadata.state` is the run in progress (which list, the next page URL, how
often a page has failed), the last finished run's counts, the notes watermark
and a lease. Each step of the sync appends two rows (taking the lease, then
its progress). A page Affinity refuses (an expired cursor, a rejected filter)
or keeps failing to send is moved past, never retried forever: the list or the
notes restart from page 1, then the notes are read in full, then skipped. The
watermark only moves when the run saw every changed note, so a skipped notes
page is read again by the next run. No column or migration is involved.

Today's "At a glance" cards keep each task's short label and card the same
way, as `task.glance_set` rows (`entity_type = 'task'`, `entity_id` the task):
metadata `{v: 1, by, source?, short? (≤ 40 characters, ≤ 6 words, one line),
bucket?: 'now' | 'intro' | 'upcoming', due_precision?: 'day' | 'week'}`. A row
with no user is the task-suggest routine's (written at ingest when
`TASK_ADD_V1` carries any of those fields); a row with a user is a person's
choice. Per field, the newest person's value beats the newest routine value;
who wrote a row is its `user_id`, never its `by`, and a field that does not
parse is ignored on its own. `task.glance_set` is not a "person touched it"
action for the task-closer (D-052), so moving a task between cards never stops
it closing itself. See D-053.

Task basics and money and legal tasks are kept the same way, all with
`entity_type = 'task'` and `entity_id` the task (see D-060):

- `task.edited` (a person): `{fields, previous_title?}`. A "person touched it"
  action like `task.updated`, so evidence older than an edit never closes the
  task; `previous_title` keeps the task-suggest routine from adding the old
  wording back.
- `task.assigned` (a person): `{from, to}`, beside the write to
  `tasks.assigned_to` (a member's id, or null). Not a touch.
- `task.money_legal_set` (a person): `{on}`. The newest beats the keyword
  rules in `lib/tasks/money-legal.ts`. Not a touch.
- `task.proof_recorded` (a person): `{v: 1, kind: 'link', url, note?}` or
  `{v: 1, kind: 'confirmed', confirmed_by, note?}`, written just before the
  completion it explains (it counts only within ten minutes of
  `completed_at`). Not a touch; the completion's own `task.updated` is.
- `task.needs_proof` (no user): an automatic close of a money or legal task
  that stated no proof (no reason, or no sent email), kept as a claim instead
  of closing the task; metadata is the close's own. One per evidence id.

A deleted task is `status = 'cancelled'`: off every list and out of search,
but still in the table, so the suggest routine's title check never adds it
again.

The proof check for tasks a person ticks by hand, and the company a task is
about, are kept the same way (see D-061). None of these is a "person touched
it" action, and none ever changes a task's status:

- `task.proof_expected` (the person who ticked it): written with a person's
  completion of a deliverable (a reply, a send, feedback, an intro, a
  signature, a payment; the rules are in `lib/tasks/proof.ts`).
  `{v: 1, kind, recipients: [names as the task gives them], proof:
  [evidence types], completed_at, judge_after, time_zone, email_message_id}`.
  It applies only while `tasks.completed_at` equals its `completed_at`, so an
  Undo or a Reopen ends it. Not written for a close that carried proof (money
  and legal), an automatic close, or a Nick-only counterparty.
- `task.proof_seen` (no user): `{v: 1, expected_id, source:
  'app-sent-check' | 'task-closer', evidence_type, evidence_id, evidence_at,
  thread_id?, channel?, reason?, slack_ts?}`. One per expectation. Written by
  the app's look at synced sent mail, by a `TASK_PROOF_V1` post, or by a
  `TASK_CLOSE_V1` close for an already-ticked task (a post only when posted
  after the tick). Its `evidence_id`, like a `task.auto_completed` row's for
  the same task, never proves a later completion of that task.
- `task.proof_missing` (no user): `{v: 1, expected_id, judged_at,
  addressed, to}`, once, when `judge_after` (two business days in the ticker's
  time zone) passed with nothing seen and the Google connection is working
  and has synced past `judge_after`, for a task the mailbox owner does (its
  assignee, or whoever ticked it unassigned). Shows "Ticked, not seen sent".
  `addressed` is false when no recipient could be matched to an address;
  `to` names who it should have reached (a reply's sender, for one made from
  an email). A reply to the mailbox's own message, or to a no-reply sender,
  is never judged.
- `task.proof_confirmed` (a person): `{v: 1, expected_id}`, "It's done".
- `task.company_set` (a person): `{v: 1, kind: 'deal' | 'portfolio' | 'crm' |
  null, id, name, previous}`, beside the write to `tasks.deal_id` /
  `tasks.portfolio_company_id` (a deal or portfolio choice sets its column
  and clears the other; a CRM choice or none clears both). A CRM company has
  no column, so its chip comes from the newest row while both columns are
  empty.

### `ai_usage`

Recorded for **failed** calls too, with the error code and zero cost. A failed
call still consumes a request slot, which is the point of a rate limit. It is
also the only way to see that a provider is degraded rather than that usage
dropped.

---

## 6a. CRM

Copilot's replacement for Affinity, in Affinity's own shape so its CSV exports
map one-to-one (`20261015000000_crm.sql`; service `lib/services/crm.ts`).

| Table | Purpose |
| --- | --- |
| `crm_lists` | A list of one `entity_type` (`company`, `person`, `deal`) with its own custom `fields` (jsonb array of `{key, name, type, options?}`). Unique on `(organization_id, source, external_id)`. |
| `crm_records` | Companies and people (`kind`). `name_key` is the name trimmed and lowercased, written by the service, so imports can match names case-insensitively through PostgREST. Unique on `(organization_id, kind, source, external_id)`; indexed by `name_key`, `domain`, `primary_email`, GIN on `emails` and trigram on `name`. |
| `crm_list_entries` | One row of one list: `record_id` (nullable, `on delete set null`), `title`, and `"values"` keyed by the list's field keys. `external_id` is Affinity's row id, `entity:<id>` (organization/person/opportunity id) or `name:<name>` (a deal list exported without ids). `imported_values` is what the last import wrote, so a re-import keeps a value someone changed in Copilot since. Unique on `(list_id, external_id)`. |
| `crm_notes` | Notes on records and entries (`record_ids`, `entry_ids`, both GIN-indexed). Content is untrusted, verbatim, rendered as text only, with `injection_flagged` like meeting notes. An id-less CSV note is keyed by a hash of its date, author and content, not the entity it was exported under, so one note exported from two lists is one note (the names count only when a note has neither date nor author). |

`source` is `'affinity' | 'copilot'` on every table. Imports upsert on these
natural keys and write only rows that change, so importing the same export
twice writes nothing. Re-imports never overwrite a list value changed in
Copilot since the previous import (they report it instead), and a row first
imported from a view without row ids is found again when a later view has
them. Records match by name only when no domain or address contradicts it,
and a name several records share is left unlinked. Until the migration is
applied, every CRM read degrades to a "not set up yet" state and every write
returns `not_configured` — the service recognises Postgres `42P01` and
PostgREST `PGRST205` (`lib/db/missing-table.ts`); a table from an earlier copy
of the migration (a missing column: `42703`, `PGRST204`) says to run it again.

Affinity's exports arrive through Knowledge → Affinity import (`/knowledge?tab=import`; the old `/lists/import` redirects there). The page parses and maps
each CSV in the browser (`lib/crm/affinity-csv.ts`) and posts chunks of up to
200 rows to `/api/crm/import`, which runs them through
`lib/services/crm-import.ts`: the list, then its records, then its entries.
Notes go after lists and are linked by name to records and deal entries, only
where exactly one matches; every name stays in `entity_names`. The importer
keys a note without an Affinity id as `affinity-csv:<hash>` of its date (to the
minute when it can be read), author and text — its names count only when it
has neither date nor author — computed in the browser so the key is fixed by
the file itself; rows of the same note union their names and links. The page offers the existing lists to import into, pre-choosing one
when the file is another saved view of it, and a list imported by mistake can
be archived from its page.

**Where a list's data goes.** There is no Lists page in the navigation: each
list feeds the page that uses it. `lib/crm/destinations.ts` (pure) sends a
list to one of `deals`, `sourcing`, `lps`, `lp_lists`, `angel`,
`portfolio_people`, `investors`, `providers`, `operators`, `events` or
`archive` from its name and entity type (ordered rules, first match wins;
unmatched lists go to `archive`, shown only on Knowledge). Knowledge →
Affinity lists (`/knowledge?tab=lists`) groups the lists that way and lets a
member pick another destination. That choice is stored without a migration as
an `audit_events` row per change — `action = 'crm.list_destination'`,
`entity_type = 'crm_list'`, `entity_id` the list id, `metadata.destination`
the choice (`null` = back to automatic) — and the newest row per list wins.
Not in `crm_lists.fields` (those are the list's columns, rewritten by every
re-import). If the audit rows cannot be read, every list falls back to its
rules. Pages read a destination through `lib/services/crm-destinations.ts`
(`listsFor`, `entriesFor`), never a list by name.

**The daily Affinity sync.** Until the Affinity subscription is cancelled,
`lib/services/affinity-sync.ts` copies Affinity in every morning through its
API (`AFFINITY_API_KEY`; the daily GitHub workflow loops
`POST /api/cron/affinity-sync`, and the owner has "Sync now" on Knowledge →
Affinity import). It reads every list, its fields and its entries with all
their field data, then the notes (after the first run, only those created or
changed since the last one), and writes them through the same upserts as the
CSV import, under the same keys: a list's `external_id` is its Affinity list
id (the first sync adopts the CSV-imported list of the same name, also one
named after a saved view, "List - View"), a record's is its organization or
person id, a row's is its list entry id (a CSV row keyed `entity:<id>` is
adopted and re-keyed), a note's is its note id (a CSV note keyed by a hash is
recognised by its text and date and re-keyed). So it updates what was
imported instead of duplicating it, a value changed in Copilot is kept, and
a second run writes nothing. A list's own fields become its columns, and so
does any field the list already had a column for; the other global, enriched
and relationship fields (Industry, Description, Last Email…) go on the
company or person record's `fields`, so a list stays a handful of columns.
Nothing is deleted: a row removed in Affinity stays in Copilot. Its progress
lives in `audit_events` (above).

**Saved views** (`20261016010000_crm_views.sql`; `lib/crm/saved-views.ts`,
`lib/services/crm-views.ts`) live on the list row as `crm_lists.views`, a jsonb
array of `{id, name, view, columns, sort, dir, statuses, conditions, groupBy}`
— no table of their own: a list has a handful, they are always read with it,
and the list's row-level security already scopes them. The built-in All view
is never stored. The array is read and written whole (two simultaneous saves
on one list can lose one) and is re-validated against the list's fields on
every read, so a view naming a removed field just loses that column or
condition. Until the migration runs a list has no saved views and saving one
returns `not_configured` naming the file. Conditions (status is any of; field
is / contains / is empty / is not empty; number and date ranges; all must
hold) compile to one store `Filter` on `values` JSON paths, run in the
database; `Filter.textContains` (literal, case-insensitive `ILIKE`) was added
for "contains". Column totals and the CSV export read every matching entry a
thousand at a time (PostgREST has no aggregates); totals stream into the page
after the rows and stop at 50,000 entries, saying so. An LP list's amount
columns are never totalled (`lib/crm/lp-rule.ts`, the rule the MCP server
applies too). Time in current status comes from the latest `crm.entry_updated`
audit row whose `changed` keys name the status field (keys only — audit rows
never carry values), else an imported Affinity "Time in Current Status" column
counted on from the list's latest `crm.imported` row (shown as an estimate,
"~36d"), else when a Copilot-made entry was added; the migration indexes those
audit rows by `metadata->>'list_id'` for whole-list exports. The All view
hides at first the imported timer (Time in Stage replaces it) or, on an
Affinity list without one, Time in Stage itself. Exports:
`/api/crm/lists/[id]/export` (the view on screen, members and above),
`/api/crm/records/[id]/notes/export` (members and above), and
`/api/crm/export` (everything as a ZIP of CSVs, owners only); the links show
only to those roles, and a refused export is a toast, not a saved error file.
All are audited as `crm.exported` with counts, and text a spreadsheet would
run as a formula is prefixed with an apostrophe.

## 6b. Campaigns

Tracked bulk email, replacing Affinity's (`20261016000000_campaigns.sql`;
service `lib/services/campaigns.ts`, template, limits and the person-or-machine
rules in `lib/campaigns/`).

| Table | Purpose |
| --- | --- |
| `campaigns` | A subject, a `body_template` (light Markdown with `{{first_name}}`, `{{name}}`, `{{company}}` and `{{field\|fallback}}`), `from_identity` (`nick` or `arwin`: whose signature; both send from the connected mailbox), `attachments` (jsonb `{id, name, type, size, parts}`, parts in the private bucket), `status` (`draft`, `sending`, `paused`, `sent`, `cancelled`) and `pause_reason` (`manual`, `left`, `capped`, `failures`, `refused`), the switches `track_activity` (pixel and tracked links; default on) and `unsubscribe_link` (the grey line and the List-Unsubscribe headers; default off), `link_allowlist` (the body's links at confirmation: the only places the click redirect goes), `confirmed_at`/`confirmed_by`, `confirmed_through` (the created_at of the last reviewed recipient: anyone added later is never sent) and `last_sent_at` (pacing). No schedule column, deliberately. |
| `campaign_recipients` | One recipient of one campaign, unique on `(campaign_id, email)`: `merge` values, optional `record_id` (a CRM person), send `status` (`pending`, `sent`, `failed`, `unconfirmed`, `skipped`), Gmail ids, `error`, `attempted_at` (claimed atomically just before each send), and `opened_at`/`open_count`, `clicked_at`/`click_count`, `replied_at`, `bounced_at`, `unsubscribed_at`. `unconfirmed` is a send interrupted after it started: it may have gone out, so it is never resent automatically nor swept up by "retry failed"; a person marks it sent or sends it again, or the reply check settles it when its copy turns up in Sent. |
| `campaign_events` | Every `open`, `click` (with `url`), `reply`, `bounce`, `unsubscribe` and `resubscribe` (both with the lowercased `email`), and `automated` for an open or click that looked like a machine (kept, never counted). The latest unsubscribe or resubscribe per address is the suppression list, checked when people are added, at confirmation and before each batch; it outlives its campaign (`on delete set null`). |
| `campaign_send_locks` | One row per organization: the lease (`lease_token`, `lease_expires_at`) a batch takes by compare-and-set before its first email and renews before each, so one batch sends at a time across tabs and server instances; and `last_sent_at`, which paces the organization's next email whichever campaign sends it. |

Nothing sends from a draft, and what was reviewed is what goes. The review
screen shows the exact recipient count, from-address, subject, attachments,
switches and a sample; the confirmation echoes those and the campaign's
`updated_at` back, and moves the draft to `sending` with a compare-and-set on
that version (`DataStore.updateWhere`). Every draft edit (a save, an attachment
landing or going, recipients added or removed) is itself a compare-and-set on
`status = 'draft'`, so an edit racing the tap either lands first and makes the
tap stale, or is refused. The open page then asks `/api/campaigns/<id>/batch`
for one short batch after another (at most 10 emails, about one every 2
seconds, none started after 25 seconds; at most 400 in any 24 hours per
organization). Sending runs only while that page is open: leaving it (a link,
which asks first, or closing the tab) pauses the campaign with reason `left`,
and a "sending" campaign nobody drives reads as stopped after two minutes. At
the cap it pauses with reason `capped`. Resume is a tap. Sends go through
`lib/google/gmail-send.ts` via `lib/campaigns/sender.ts`, which only the
campaign routes import. Tracking is public at `/t/o/<token>` (pixel),
`/t/c/<token>?u=` (click redirect, allowlist-checked) and `/t/u/<token>`
(unsubscribe: opening changes nothing; the button or a provider's RFC 8058
one-click POST does it). The token is the organization and recipient ids plus
a truncated HMAC under `SESSION_SECRET`; a test send's token names the
campaign under its own purpose tag and records nothing. A link whose text is
itself an address is never rewritten. Opens and clicks in the first minute
after the send, HEAD requests, prefetches, scanner user agents, and a second
link clicked seconds after the first are kept as `automated` and not counted.
Replies and bounces are read from the synced mailbox (a message in the sent
email's thread, from the recipient, not an out-of-office, or from a mail
server) when a campaign is viewed and by the daily job. Reads degrade to "not
set up yet" until the migration is applied, as for the CRM.
---

## 7. Row-level security

Enabled on every table. The bulk of the policies are generated in a `DO` block
over the scoped tables, so there is no chance of one table quietly missing one:

```sql
for select using (is_org_member(organization_id))
for insert with check (has_org_role(organization_id, 'member'))
for update using (has_org_role(organization_id, 'member'))
       with check (has_org_role(organization_id, 'member'))
```

Exceptions are written out individually:

- `user_profiles` — a user reads and writes only their own row.
- `organizations` — updated only by an admin.
- `chat_threads` / `chat_messages` / `daily_briefs` — scoped to the owning user
  as well as the organization.
- `storage.objects` — the attachments bucket is private, with a policy keyed on
  the organization prefix of the object path.

The server uses the service role key, which bypasses RLS, and relies on explicit
scoping in `SupabaseStore`. RLS is the second gate: it protects against a bug in
the first, and against any client that reaches Postgres with the anon key.

---

## 8. Indexes worth knowing about

- `email_messages_search_idx`, `deals_search_idx`, `email_attachments_search_idx`,
  `portfolio_search_idx` — GIN over generated `tsvector` columns.
- `deals_name_trgm_idx` — `pg_trgm`, for fuzzy company-name matching in dedupe.
- `deal_facts_current_idx` — partial index on `superseded_by is null`, which is
  the only row anyone usually wants.
- `deal_analyses_source_hash_idx` — the content-hash cache lookup.
- `sync_runs_org_started_idx` — recent-runs view on the diagnostics page.

---

## 9. Extensions

`pgcrypto` (uuid generation) and `pg_trgm` (fuzzy name matching), both created
in the first migration.
