import 'server-only';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import type { CrmRecord, Integration, NetworkContact } from '@/lib/types/domain';
import { log } from '@/lib/security/redact';
import { searchRecords } from './crm';
import { demoSenders, recentSenders, suggestConversations, type LiveThreadRow } from './inbox-live';

/**
 * What the Inbox's search box suggests while someone types (debounced in
 * the browser, each request aborted by the next keystroke):
 *
 * - People: Kraken's own contacts (the network and CRM people, a small capped
 *   ILIKE each) and senders of mail the Inbox already read (an in-memory map,
 *   no Gmail call). Picking one searches `from:<email> OR to:<email>`.
 * - Conversations: one light Gmail threads.list (five results) with cached
 *   metadata, held 30 seconds per query (inbox-live.ts).
 *
 * The demo reads its fictional fixtures only.
 */

export interface SuggestedPerson {
  name: string;
  email: string;
  /** Where Kraken knows them from, for the row's quiet second line. */
  source: 'contact' | 'crm' | 'recent';
}

export interface InboxSuggestions {
  people: SuggestedPerson[];
  threads: LiveThreadRow[];
}

const PEOPLE = 5;
const MIN_PEOPLE_QUERY = 2;
/** Operators mean the person is writing Gmail syntax: no people for that. */
const HAS_OPERATOR = /\b\w+:/;

async function contactPeople(
  store: DataStore,
  organizationId: string,
  text: string,
): Promise<SuggestedPerson[]> {
  const [contacts, records] = await Promise.all([
    (
      store.list(
        'network_contacts',
        organizationId,
        { textSearch: { columns: ['full_name', 'email'], query: text } },
        { limit: PEOPLE },
      ) as Promise<NetworkContact[]>
    ).catch(() => {
      log.warn('Inbox people suggestions: contacts failed');
      return [] as NetworkContact[];
    }),
    searchRecords(store, organizationId, text, PEOPLE, 'person')
      .then((r) => (r.ok ? r.value : ([] as CrmRecord[])))
      .catch(() => [] as CrmRecord[]),
  ]);
  return [
    ...contacts
      .filter((c) => c.email)
      .map((c) => ({
        name: c.full_name,
        email: c.email!.toLowerCase(),
        source: 'contact' as const,
      })),
    ...records
      .filter((r) => r.primary_email)
      .map((r) => ({
        name: r.name,
        email: r.primary_email!.toLowerCase(),
        source: 'crm' as const,
      })),
  ];
}

/** Contacts first, then recent senders; one row per address. */
export function mergePeople(lists: readonly SuggestedPerson[][], max = PEOPLE): SuggestedPerson[] {
  const seen = new Set<string>();
  const out: SuggestedPerson[] = [];
  for (const list of lists) {
    for (const p of list) {
      if (!p.email || seen.has(p.email)) continue;
      seen.add(p.email);
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}

export async function inboxSuggestions(
  store: DataStore,
  organizationId: string,
  integration: Integration | null,
  rawText: string,
  /** The compose window's To/Cc/Bcc: people only, no conversation search. */
  options: { peopleOnly?: boolean } = {},
): Promise<InboxSuggestions> {
  const text = rawText.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!text) return { people: [], threads: [] };
  const wantPeople = text.length >= MIN_PEOPLE_QUERY && !HAS_OPERATOR.test(text);
  const demo = isDemoMode();
  const [contacts, recent, threads] = await Promise.all([
    wantPeople ? contactPeople(store, organizationId, text) : Promise.resolve([]),
    !wantPeople
      ? Promise.resolve([])
      : demo
        ? demoSenders(store, organizationId, text, PEOPLE)
        : Promise.resolve(integration ? recentSenders(integration.id, text, PEOPLE) : []),
    options.peopleOnly
      ? Promise.resolve([])
      : suggestConversations(store, organizationId, text, { integration }).catch(() => []),
  ]);
  return {
    people: mergePeople([
      contacts,
      recent.map((r) => ({ name: r.name, email: r.email, source: 'recent' as const })),
    ]),
    threads,
  };
}
