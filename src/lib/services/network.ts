import 'server-only';
import type { DataStore } from '@/lib/db/store';
import type {
  CalendarEvent,
  Deal,
  DealPerson,
  EmailMessage,
  NetworkContact,
  PortfolioCompany,
  PortfolioContact,
} from '@/lib/types/domain';
import type { RelationshipRow } from '@/lib/network/relationship-view';

/**
 * The relationship list.
 *
 * Affinity's central claim is relationship intelligence: who you know, how well
 * you know them, and when you last spoke. It builds that from email and
 * calendar metadata — which this app already syncs and has never used for the
 * purpose. `network_contacts` exists, but it only holds hand-imported CSV rows,
 * and in production it is empty. That is why introduction suggestions have
 * never had anything to suggest.
 *
 * So this derives the list rather than storing another copy of it:
 *
 * 1. **It cannot drift.** A materialised contacts table is a second source of
 *    truth about people while the first one — the mailbox — keeps moving.
 *    Deriving means the answer is always exactly what the records say.
 * 2. **It needs no model.** This is counting and joining, so it works with
 *    `ANTHROPIC_API_KEY` unset, which is the live configuration. It is a
 *    capability the product has today rather than one it is waiting to afford.
 *
 * The consequence, and the difference from Affinity: every figure here is a
 * count of real records, so the interface can show its working. A relationship
 * score nobody can audit is exactly the kind of confident guess the rest of
 * this codebase refuses to make.
 */

export type { RelationshipRow } from '@/lib/network/relationship-view';

export interface RelationshipListOptions {
  /** Addresses belonging to the fund itself. Never listed as contacts. */
  ownAddresses: string[];
  /** Injected so the notion of "past" is testable rather than wall-clock. */
  now?: Date;
  search?: string;
  /** Caps the scan. Real mailboxes are large; this page is not a report. */
  messageLimit?: number;
}

/**
 * Addresses that are machinery rather than people.
 *
 * Deliberately a plain local-part and domain test rather than anything
 * cleverer. A classifier would need the model that may not be configured, and
 * a wrong guess here silently hides a real person from the list. Anything
 * unmatched stays, so the failure mode is a little noise rather than a missing
 * relationship.
 */
const AUTOMATED_LOCAL =
  /^(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer|bounce|postmaster|support|help|info|hello|contact|team|admin|billing|invoices?|receipts?|news|newsletter|digest|updates?|marketing|unsubscribe|automated|system|robot|bot|daemon)([+-].*)?$/i;

const AUTOMATED_DOMAIN =
  /(^|\.)(mailchimp|sendgrid|mailgun|substack|beehiiv|hubspot|intercom|zendesk|calendly|docusign|bounces?)\.[a-z.]+$/i;

export function isAutomatedAddress(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 1) return true;
  return AUTOMATED_LOCAL.test(address.slice(0, at)) || AUTOMATED_DOMAIN.test(address.slice(at + 1));
}

function normalise(address: string): string {
  return address.trim().toLowerCase();
}

/** Pulls a bare address out of `Name <a@b.c>` when the provider left it wrapped. */
function addressOf(raw: string): string | null {
  const angled = /<([^>]+)>/.exec(raw);
  const candidate = normalise(angled ? (angled[1] ?? '') : raw);
  return candidate.includes('@') ? candidate : null;
}

interface Accumulator {
  email: string;
  names: Map<string, number>;
  inboundCount: number;
  outboundCount: number;
  meetingCount: number;
  /**
   * Null until something has actually happened. A meeting in the diary is a
   * booking, not an encounter — counting it as contact produced a "last
   * contact" of "6 hours from now" on the first real run.
   */
  first: number | null;
  last: number | null;
  nextMeeting: number | null;
  lastWasInbound: boolean;
  dealId: string | null;
}

function ensure(acc: Map<string, Accumulator>, email: string): Accumulator {
  let entry = acc.get(email);
  if (!entry) {
    entry = {
      email,
      names: new Map(),
      inboundCount: 0,
      outboundCount: 0,
      meetingCount: 0,
      first: null,
      last: null,
      nextMeeting: null,
      lastWasInbound: false,
      dealId: null,
    };
    acc.set(email, entry);
  }
  return entry;
}

function touch(
  acc: Map<string, Accumulator>,
  email: string,
  at: string,
  kind: 'inbound' | 'outbound' | 'meeting',
  now: number,
): Accumulator | null {
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;

  const entry = ensure(acc, email);

  // Anything still ahead of us is an appointment, not a contact. It puts the
  // person on the list — you are about to see them — without pretending you
  // already have.
  if (time > now) {
    if (kind === 'meeting' && (entry.nextMeeting === null || time < entry.nextMeeting)) {
      entry.nextMeeting = time;
    }
    return entry;
  }

  if (kind === 'inbound') entry.inboundCount += 1;
  else if (kind === 'outbound') entry.outboundCount += 1;
  else entry.meetingCount += 1;

  if (entry.first === null || time < entry.first) entry.first = time;
  if (entry.last === null || time >= entry.last) {
    entry.last = time;
    // A meeting is mutual, so it puts the ball in nobody's court.
    if (kind !== 'meeting') entry.lastWasInbound = kind === 'inbound';
  }

  return entry;
}

/** Counts spellings of a name so one stray casing does not win the label. */
function noteName(entry: Accumulator, name: string | null | undefined): void {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.includes('@')) return;
  entry.names.set(trimmed, (entry.names.get(trimmed) ?? 0) + 1);
}

function bestName(entry: Accumulator): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of entry.names) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

export async function buildRelationshipList(
  store: DataStore,
  organizationId: string,
  options: RelationshipListOptions,
): Promise<RelationshipRow[]> {
  const own = new Set(options.ownAddresses.map(normalise).filter((a) => a.includes('@')));
  const limit = options.messageLimit ?? 2000;
  const now = (options.now ?? new Date()).getTime();

  const [messages, events, deals, portfolio, portfolioContacts, dealPeople, imported] =
    await Promise.all([
      store.list(
        'email_messages',
        organizationId,
        {},
        { orderBy: [{ field: 'sent_at', direction: 'desc' }], limit },
      ) as Promise<EmailMessage[]>,
      store.list(
        'calendar_events',
        organizationId,
        {},
        { orderBy: [{ field: 'starts_at', direction: 'desc' }], limit },
      ) as Promise<CalendarEvent[]>,
      store.list('deals', organizationId, {}) as Promise<Deal[]>,
      store.list('portfolio_companies', organizationId, {}) as Promise<PortfolioCompany[]>,
      store.list('portfolio_contacts', organizationId, {}) as Promise<PortfolioContact[]>,
      store.list('deal_people', organizationId, {}) as Promise<DealPerson[]>,
      store.list('network_contacts', organizationId, {}) as Promise<NetworkContact[]>,
    ]);

  const acc = new Map<string, Accumulator>();

  for (const message of messages) {
    const from = addressOf(message.from_address);
    const sentByUs = from !== null && own.has(from);

    if (from && !sentByUs) {
      const entry = touch(acc, from, message.sent_at, 'inbound', now);
      if (entry) {
        noteName(entry, message.from_name);
        if (message.linked_deal_id) entry.dealId ??= message.linked_deal_id;
      }
    }

    if (sentByUs) {
      for (const raw of [...message.to_addresses, ...message.cc_addresses]) {
        const address = addressOf(raw);
        if (!address || own.has(address)) continue;
        const entry = touch(acc, address, message.sent_at, 'outbound', now);
        if (entry && message.linked_deal_id) entry.dealId ??= message.linked_deal_id;
      }
    }
  }

  for (const event of events) {
    // A private event still counts as contact, but its attendee list is not
    // ours to mine — the calendar marked it private for a reason.
    if (event.is_private) continue;
    for (const attendee of event.attendees) {
      const address = addressOf(attendee.email);
      if (!address || own.has(address)) continue;
      const entry = touch(acc, address, event.starts_at, 'meeting', now);
      if (entry) noteName(entry, attendee.name);
    }
  }

  const dealById = new Map(deals.map((d) => [d.id, d]));
  const portfolioById = new Map(portfolio.map((p) => [p.id, p]));
  const importedByEmail = new Map(
    imported.filter((c) => c.email).map((c) => [normalise(c.email as string), c]),
  );
  const portfolioContactByEmail = new Map(
    portfolioContacts.filter((c) => c.email).map((c) => [normalise(c.email as string), c]),
  );
  const dealPersonByEmail = new Map(
    dealPeople.filter((p) => p.email).map((p) => [normalise(p.email as string), p]),
  );

  const rows: RelationshipRow[] = [];

  for (const entry of acc.values()) {
    if (isAutomatedAddress(entry.email)) continue;

    const importedContact = importedByEmail.get(entry.email) ?? null;
    const portfolioContact = portfolioContactByEmail.get(entry.email) ?? null;
    const dealPerson = dealPersonByEmail.get(entry.email) ?? null;

    const dealId = entry.dealId ?? dealPerson?.deal_id ?? null;
    const portfolioCompanyId = portfolioContact?.portfolio_company_id ?? null;
    const dealName = dealId ? (dealById.get(dealId)?.company_name ?? null) : null;
    const portfolioName = portfolioCompanyId
      ? (portfolioById.get(portfolioCompanyId)?.name ?? null)
      : null;

    rows.push({
      email: entry.email,
      name:
        bestName(entry) ??
        importedContact?.full_name ??
        portfolioContact?.name ??
        dealPerson?.name ??
        null,
      inboundCount: entry.inboundCount,
      outboundCount: entry.outboundCount,
      meetingCount: entry.meetingCount,
      firstContactAt: entry.first === null ? null : new Date(entry.first).toISOString(),
      lastContactAt: entry.last === null ? null : new Date(entry.last).toISOString(),
      nextMeetingAt: entry.nextMeeting === null ? null : new Date(entry.nextMeeting).toISOString(),
      awaitingUs: entry.lastWasInbound,
      // Unknown stays unknown. No employer is inferred from the email domain:
      // a Gmail address would invent "gmail" as a company, and a shared domain
      // would put a person on the wrong side of a deal.
      company: importedContact?.company ?? portfolioName ?? dealName,
      role: importedContact?.title ?? portfolioContact?.role ?? dealPerson?.role ?? null,
      links: {
        dealId,
        dealName,
        portfolioCompanyId,
        portfolioCompanyName: portfolioName,
      },
      importedContactId: importedContact?.id ?? null,
      relationship: importedContact?.relationship ?? null,
      expertise: importedContact?.expertise ?? [],
    });
  }

  const search = options.search?.trim().toLowerCase();
  const filtered = search
    ? rows.filter(
        (row) =>
          row.email.includes(search) ||
          (row.name?.toLowerCase().includes(search) ?? false) ||
          (row.company?.toLowerCase().includes(search) ?? false),
      )
    : rows;

  // Default order: most recently in touch first, and anyone you have only ever
  // been booked to meet at the end, where "not yet" belongs.
  return filtered.sort((a, b) => {
    if (a.lastContactAt === null && b.lastContactAt === null) return 0;
    if (a.lastContactAt === null) return 1;
    if (b.lastContactAt === null) return -1;
    return Date.parse(b.lastContactAt) - Date.parse(a.lastContactAt);
  });
}
