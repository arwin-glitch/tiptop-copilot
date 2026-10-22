import type { NextRequest } from 'next/server';
import { eventsAuth, fail, done } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';

/**
 * GET /api/events/[id]/guests/sources — what "Add guests from Copilot" can
 * pick from (D-075, signed in): ?kind=lists (CRM lists of people), or
 * ?kind=people&q= (CRM people and Network contacts with an email, by name,
 * email or company). Names and emails only; the add itself is POST …/guests.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const gate = await eventsAuth('guests-sources', { write: false });
  if (!gate.ok) return gate.response;
  const store = getStore();
  const org = gate.owner.organizationId;
  const kind = request.nextUrl.searchParams.get('kind');
  try {
    if (kind === 'lists') {
      const lists = await store.list('crm_lists', org, { eq: { archived: false } });
      return done({
        lists: lists
          .filter((l) => l.entity_type === 'person')
          .map((l) => ({ id: l.id, name: l.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    if (kind === 'people') {
      const q = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 100);
      if (q.length < 2) return done({ people: [] });
      const [records, contacts] = await Promise.all([
        store
          .list(
            'crm_records',
            org,
            {
              eq: { kind: 'person' },
              textSearch: { columns: ['name', 'primary_email'], query: q },
            },
            { limit: 20 },
          )
          .catch(() => []),
        store
          .list(
            'network_contacts',
            org,
            { textSearch: { columns: ['full_name', 'email', 'company'], query: q } },
            { limit: 20 },
          )
          .catch(() => []),
      ]);
      return done({
        people: [
          ...records
            .filter((r) => r.primary_email || r.emails.length)
            .map((r) => ({
              kind: 'record' as const,
              id: r.id,
              name: r.name,
              email: r.primary_email ?? r.emails[0] ?? null,
              company: null,
            })),
          ...contacts
            .filter((c) => c.email)
            .map((c) => ({
              kind: 'network' as const,
              id: c.id,
              name: c.full_name,
              email: c.email,
              company: c.company,
            })),
        ].slice(0, 30),
      });
    }
    return fail({ code: 'invalid_input', message: 'Choose lists or people.' });
  } catch (error) {
    log.warn('Guest sources failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return done({ lists: [], people: [] });
  }
}
