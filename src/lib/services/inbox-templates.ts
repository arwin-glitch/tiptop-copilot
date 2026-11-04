import 'server-only';
import { isMissingTableError } from '@/lib/db/missing-table';
import type { DataStore } from '@/lib/db/store';
import { MAX_COMPOSE_HTML, sanitizeComposeHtml } from '@/lib/email/compose-html';
import type { InboxTemplate } from '@/lib/types/domain';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * Gmail's "Templates" for the compose window, kept by Kraken
 * (inbox_templates), shared by the workspace. A template is saved only from
 * a person's click on Save draft as template, and removed only from their
 * click on Delete; inserting one only fills the compose box. Nothing here
 * sends. Before the migration is run every call says so and stores nothing.
 */

const TABLE = 'inbox_templates' as const;
/** Gmail's own limit is 50 templates; Kraken keeps the same. */
export const MAX_TEMPLATES = 50;

export const TEMPLATES_NOT_SET_UP =
  'Templates need a database update before they can be saved. Nothing else changes.';

const needsMigration = () =>
  err('not_configured', TEMPLATES_NOT_SET_UP, { details: { needsMigration: true } });

export interface TemplateSummary {
  id: string;
  name: string;
  subject: string;
  html: string;
}

const summary = (t: InboxTemplate): TemplateSummary => ({
  id: t.id,
  name: t.name,
  subject: t.subject,
  html: t.body_html,
});

async function readAll(store: DataStore, organizationId: string): Promise<InboxTemplate[] | null> {
  try {
    return (await store.list(
      TABLE,
      organizationId,
      {},
      { limit: MAX_TEMPLATES + 1 },
    )) as InboxTemplate[];
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

export async function listTemplates(
  store: DataStore,
  organizationId: string,
): Promise<Result<TemplateSummary[]>> {
  const rows = await readAll(store, organizationId);
  if (!rows) return needsMigration();
  return ok(
    rows.map(summary).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
  );
}

/**
 * Save the compose box as a template, Gmail's way: a new name makes a new
 * one, an existing name overwrites that template (Gmail asks first; the
 * dialog does).
 */
export async function saveTemplate(
  store: DataStore,
  actor: { organizationId: string; userId: string | null },
  input: { name: string; subject: string; html: string },
  now: Date = new Date(),
): Promise<Result<TemplateSummary>> {
  const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!name) return err('invalid_input', 'Name the template first.');
  if (input.html.length > MAX_COMPOSE_HTML)
    return err('invalid_input', 'That template is too long.');
  const rows = await readAll(store, actor.organizationId);
  if (!rows) return needsMigration();
  const subject = input.subject
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 300);
  const body_html = sanitizeComposeHtml(input.html).slice(0, 100_000);
  const same = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
  const stamp = now.toISOString();
  if (same) {
    const updated = (await store.update(TABLE, actor.organizationId, same.id, {
      subject,
      body_html,
      updated_at: stamp,
    })) as InboxTemplate;
    return ok(summary(updated));
  }
  if (rows.length >= MAX_TEMPLATES) {
    return err('invalid_input', `Kraken keeps up to ${MAX_TEMPLATES} templates. Delete one first.`);
  }
  const row: InboxTemplate = {
    id: newId(),
    organization_id: actor.organizationId,
    created_by: actor.userId,
    name,
    subject,
    body_html,
    created_at: stamp,
    updated_at: stamp,
  };
  return ok(summary((await store.insert(TABLE, row)) as InboxTemplate));
}

export async function deleteTemplate(
  store: DataStore,
  organizationId: string,
  id: string,
): Promise<Result<true>> {
  const rows = await readAll(store, organizationId);
  if (!rows) return needsMigration();
  if (!rows.some((r) => r.id === id)) return err('not_found', 'That template is gone.');
  await store.remove(TABLE, organizationId, id);
  return ok(true);
}
