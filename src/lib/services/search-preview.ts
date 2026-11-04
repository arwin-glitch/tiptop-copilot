import 'server-only';
import type { AuthContext } from '@/lib/auth/session';
import type { DataStore } from '@/lib/db/store';
import { resolveCrmListDestination } from '@/lib/crm/destinations';
import { statusFieldOf } from '@/lib/crm/fields';
import { isMoneyField } from '@/lib/crm/stage-map';
import { formatCrmValue } from '@/lib/crm/view';
import type { ContactStatus } from '@/lib/network/contact-status';
import type { CrmRecord, CrmValue } from '@/lib/types/domain';
import { ok, type Result } from '@/lib/util/result';
import { getRecord } from './crm';
import { readDestinationOverrides } from './crm-destinations';
import { getPrimaryIntegration } from './inbox';
import { readCadences } from './keep-in-touch';
import { contactSummaries, relationshipScope } from './relationships';

/**
 * The quick search's right-hand preview for a company or person, Affinity's
 * shape: where they sit (pipeline or list, its status, owner and amount), the
 * relationship status tag, counts of notes, connections and reminders, and
 * the last contact in words. One request per highlighted row (the palette
 * debounces and caches), all from the database and the cached relationship
 * index — never a Gmail call.
 *
 * An LP list's amounts stay off, as everywhere on Fund II (lib/crm/lp-rule).
 */

export interface SearchPreviewList {
  name: string;
  kind: 'deal' | 'company' | 'person';
  statusName: string | null;
  status: string | null;
}

export interface SearchPreview {
  id: string;
  kind: CrmRecord['kind'];
  name: string;
  /** Domain for a company, primary email for a person. */
  sub: string | null;
  industry: string | null;
  title: string | null;
  href: string;
  /** Deal lists first, then the rest; at most four. */
  lists: SearchPreviewList[];
  listCount: number;
  owner: string | null;
  stage: string | null;
  amount: string | null;
  counts: { notes: number; notesCapped: boolean; connections: number; reminders: number };
  contact: {
    status: ContactStatus;
    lastContactAt: string | null;
    lastTouchText: string | null;
    connections: string[];
  } | null;
}

const NOTE_CAP = 200;
const OWNER = /\b(owner|owners|deal lead|lead partner|point person|relationship owner)\b/i;

function textOf(value: CrmValue | undefined): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length) return value.join(', ');
  return null;
}

/** A record's first filled field among these labels. */
export function recordField(record: Pick<CrmRecord, 'fields'>, labels: readonly string[]) {
  for (const label of labels) {
    const v = textOf(record.fields[label]);
    if (v) return v;
  }
  return null;
}

export const INDUSTRY_LABELS = ['Industry', 'Industries', 'Sector', 'Type'] as const;
export const TITLE_LABELS = ['Job Title', 'Title', 'Role', 'Position'] as const;

export async function searchPreview(
  store: DataStore,
  auth: AuthContext,
  recordId: string,
): Promise<Result<SearchPreview>> {
  const org = auth.organizationId;
  const found = await getRecord(store, org, recordId, { noteLimit: NOTE_CAP });
  if (!found.ok) return found;
  const { record, memberships, notes, related } = found.value;
  const timezone = auth.profile.timezone;

  const [overrides, integration, cadences] = await Promise.all([
    readDestinationOverrides(store, org).catch(() => ({}) as Record<string, never>),
    getPrimaryIntegration(store, org).catch(() => null),
    readCadences(store, org, [record.id]),
  ]);
  const summaries = await contactSummaries(
    store,
    org,
    [{ ...record, related }],
    relationshipScope(auth.profile.email, integration),
  );
  const summary = summaries.ok ? (summaries.value[record.id] ?? null) : null;

  const ordered = [...memberships].sort(
    (a, b) =>
      Number(b.list.entity_type === 'deal') - Number(a.list.entity_type === 'deal') ||
      Number(a.list.archived) - Number(b.list.archived),
  );
  let owner: string | null = null;
  let stage: string | null = null;
  let amount: string | null = null;
  const lists: SearchPreviewList[] = [];
  for (const { entry, list } of ordered) {
    const status = statusFieldOf(list);
    const statusValue = status ? entry.values[status.key] : undefined;
    const statusText =
      status && statusValue !== undefined ? formatCrmValue(status, statusValue, timezone) : null;
    if (lists.length < 4) {
      lists.push({
        name: list.name,
        kind: list.entity_type,
        statusName: status?.name ?? null,
        status: statusText || null,
      });
    }
    stage ??= statusText || null;
    const { destination } = resolveCrmListDestination(list, overrides[list.id]);
    const lp = destination === 'lps' || destination === 'lp_lists';
    for (const field of list.fields) {
      const value = entry.values[field.key];
      if (value === undefined || value === null || value === '') continue;
      if (!owner && OWNER.test(field.name)) owner = formatCrmValue(field, value, timezone) || null;
      if (!amount && !lp && isMoneyField(field) && field.key !== status?.key) {
        amount = formatCrmValue(field, value, timezone) || null;
      }
    }
  }

  return ok({
    id: record.id,
    kind: record.kind,
    name: record.name,
    sub: record.kind === 'company' ? record.domain : record.primary_email,
    industry: recordField(record, INDUSTRY_LABELS),
    title: record.kind === 'person' ? recordField(record, TITLE_LABELS) : null,
    href: `/lists/records/${record.id}`,
    lists,
    listCount: memberships.length,
    owner,
    stage,
    amount,
    counts: {
      notes: notes.length,
      notesCapped: notes.length >= NOTE_CAP,
      connections: summary?.connections.length ?? 0,
      reminders: cadences.get(record.id) ? 1 : 0,
    },
    contact: summary
      ? {
          status: summary.status,
          lastContactAt: summary.lastContactAt,
          lastTouchText: summary.lastTouchText,
          connections: summary.connections.map((c) => c.name),
        }
      : null,
  });
}
