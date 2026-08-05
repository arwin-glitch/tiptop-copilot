# Data model

Thirty-four tables in eight migrations, all under row-level security.

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
| `chat_threads` / `chat_messages` | Ask history, with citations and the tool trail. |
| `generated_drafts` | `check (sent = false)`. |
| `ai_usage` | Every model call: operation, model, prompt version, tokens, cost, ok, error code, duration. |
| `audit_events` | Everything consequential. Client IPs stored hashed. |
| `user_feedback` | Thumbs on a specific output, for prompt iteration. |

### `generated_drafts`

```sql
sent boolean not null default false check (sent = false)
```

The column exists so the UI can state plainly that nothing was sent. The
constraint means it can never say otherwise. There is no code path that would
attempt to set it, and if one were added the database would reject it.

### `ai_usage`

Recorded for **failed** calls too, with the error code and zero cost. A failed
call still consumes a request slot, which is the point of a rate limit. It is
also the only way to see that a provider is degraded rather than that usage
dropped.

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
