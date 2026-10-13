import 'server-only';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { listMessageIds, readMessageHeadline } from '@/lib/google/gmail-inbox';
import { SEND_SCOPES } from '@/lib/google/send-scopes';
import type { Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { documentKind, type DocSendReader } from './docsend';
import { getPrimaryIntegration } from './inbox';

/**
 * The "Follow up" button on Fund II's DocSend readers: a prefilled note in
 * Nick's voice, whether the app may send it, and whether Nick already emailed
 * that reader recently (so he does not follow up twice). Reading only: the
 * sent-mail check is a Gmail search, and sending goes through the compose
 * window's own route.
 */

const SENT_TTL_MS = 10 * 60_000;
const SENT_WINDOW = 'newer_than:60d';
/** Every reader with a Follow up button is checked, up to this many (cached 10 minutes). */
export const MAX_LOOKUPS = 60;
const LOOKUP_BATCH = 5;

export const FOLLOW_UP_SUBJECT = 'Following up - TipTop Ventures';

/** True when the mailbox granted the opt-in send scope. Mirrors the send module's check. */
export function mailboxCanSend(integration: Integration | null): boolean {
  return Boolean(integration && SEND_SCOPES.every((s) => integration.scopes.includes(s)));
}

/** What the reader looked at, as the note names it. Newest fundraising document first. */
export function followUpWhat(documents: readonly string[]): string {
  const doc = documents.find((d) => documentKind(d) === 'fundraise') ?? documents[0] ?? '';
  if (/prospective/i.test(doc)) return 'our latest LP update';
  if (/\btl;?\s?dr\b/i.test(doc)) return 'our TL;DR';
  if (/deck/i.test(doc)) return 'the deck';
  if (/one[- ]pager/i.test(doc)) return 'our one-pager';
  if (/data room/i.test(doc)) return 'the data room';
  if (/memo/i.test(doc)) return 'the memo';
  return 'what we sent over';
}

const HONORIFIC = /^(?:dr|mr|mrs|ms|mx|prof|sir)\.?$/i;

/**
 * Words that show up in shared and role inboxes ("investor.relations@",
 * "deal.team@"): never a first name to greet.
 */
const ROLE_WORDS = new Set([
  'investor',
  'investors',
  'investment',
  'investments',
  'invest',
  'investing',
  'relations',
  'relation',
  'ir',
  'lp',
  'lps',
  'gp',
  'deal',
  'deals',
  'dealflow',
  'team',
  'teams',
  'info',
  'admin',
  'office',
  'partners',
  'partner',
  'ops',
  'operations',
  'contact',
  'contacts',
  'hello',
  'support',
  'inquiries',
  'enquiries',
  'inquiry',
  'capital',
  'fund',
  'funds',
  'finance',
  'accounts',
  'accounting',
  'legal',
  'compliance',
  'research',
  'analyst',
  'analysts',
  'diligence',
  'assistant',
  'reception',
  'desk',
  'mail',
  'general',
  'group',
  'sales',
  'marketing',
  'careers',
  'jobs',
  'family',
  'foundation',
  'ventures',
  'venture',
  'management',
  'portfolio',
  'private',
  'wealth',
  'the',
  'noreply',
  'reply',
  'events',
  'media',
  'press',
  'board',
  'exec',
  'executive',
  'founders',
  'staff',
  'service',
  'services',
  'clients',
  'client',
  'newsletter',
  'news',
  'billing',
  'treasury',
  'tax',
  'secretary',
]);

/** A first name guessed from an address is used only when it looks like one. */
function plausibleGuessedName(word: string): boolean {
  const w = word.toLowerCase();
  return w.length >= 3 && /[aeiouy]/.test(w) && !ROLE_WORDS.has(w);
}

/**
 * "Jessica Whittington" -> "Jessica"; nothing usable -> "there". With
 * `guessed` (the name was read off the email address, not the pipeline),
 * initials ("jw.smith"), role inboxes ("investor.relations", "ir.team") and
 * other unlikely names fall back to "there" too.
 */
export function followUpFirstName(
  name: string | null | undefined,
  options: { guessed?: boolean } = {},
): string {
  const tokens = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const first = tokens.find((t) => !HONORIFIC.test(t));
  if (!first || !/^\p{L}[\p{L}'-]*$/u.test(first) || first.length < 2) return 'there';
  if (options.guessed && !plausibleGuessedName(first)) return 'there';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export interface FollowUpDraft {
  to: string;
  subject: string;
  body: string;
}

/**
 * The prefilled note. Never proposes days: the reader picks a time if they
 * want one. The greeting uses the pipeline's name when the reader is that LP,
 * and a name guessed from the address only when it is plausible.
 */
export function followUpDraft(
  reader: Pick<DocSendReader, 'email' | 'name' | 'documents'> &
    Partial<Pick<DocSendReader, 'match'>>,
): FollowUpDraft {
  const fromPipeline = reader.match?.by === 'person';
  const first = followUpFirstName(reader.name, { guessed: !fromPipeline });
  const what = followUpWhat(reader.documents);
  return {
    to: reader.email,
    subject: FOLLOW_UP_SUBJECT,
    body:
      `Hi ${first},\n\nThanks for taking a look at ${what}. Happy to walk you through Fund II ` +
      'or answer any questions - would a quick call be helpful?\n\nNick',
  };
}

const SAFE_EMAIL =
  /^[a-z0-9][a-z0-9._+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

/** Gmail search for Nick's recent mail to this address, or null when it is not a plain address. */
export function sentQuery(email: string): string | null {
  const address = email.trim().toLowerCase();
  if (address.length > 254 || !SAFE_EMAIL.test(address)) return null;
  return `in:sent {to:${address} cc:${address}} ${SENT_WINDOW}`;
}

export interface FollowUpContext {
  canSend: boolean;
  /** Reader email -> when Nick last emailed them (last 60 days). Missing: no mail, or unknown. */
  lastSent: Record<string, string>;
  /**
   * Readers whose sent mail was actually checked. A reader missing here was
   * not checked (lookup failed, or over the cap), so no "You emailed them"
   * line means "unknown", not "not emailed".
   */
  checked: ReadonlySet<string>;
}

const cache = processWide('docsend-follow-up', () => ({
  sent: new Map<string, { at: number; lastAt: string | null }>(),
}));

/** Test hook. */
export function resetFollowUpCache(): void {
  cache.sent.clear();
}

/**
 * Whether the app may send, and when Nick last emailed each of these readers
 * (pass them in display order: the first MAX_LOOKUPS are checked). Each
 * lookup is cached for 10 minutes; a failed or skipped lookup is left out of
 * `checked`, so the page can say so instead of implying "not emailed".
 * Never throws.
 */
export async function readFollowUpContext(
  store: DataStore,
  organizationId: string,
  emails: readonly string[],
  options: { now?: Date; isDemo?: boolean } = {},
): Promise<FollowUpContext> {
  const now = options.now ?? new Date();
  if (isDemoMode() || options.isDemo) {
    const lastSent: Record<string, string> = {};
    // Fictional: in the demo, Nick wrote to one reader last week.
    if (emails.includes('sam.okafor@gmail.com')) {
      lastSent['sam.okafor@gmail.com'] = new Date(now.getTime() - 6 * 86_400_000).toISOString();
    }
    return { canSend: false, lastSent, checked: new Set(emails) };
  }
  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration || integration.status === 'disconnected') {
    return { canSend: false, lastSent: {}, checked: new Set() };
  }

  const lastSent: Record<string, string> = {};
  const checked = new Set<string>();
  const todo: { email: string; q: string }[] = [];
  for (const email of [...new Set(emails)].slice(0, MAX_LOOKUPS)) {
    const q = sentQuery(email);
    if (!q) continue;
    const key = `${organizationId}|${email.toLowerCase()}`;
    const hit = cache.sent.get(key);
    if (hit && now.getTime() - hit.at < SENT_TTL_MS) {
      checked.add(email);
      if (hit.lastAt) lastSent[email] = hit.lastAt;
    } else {
      todo.push({ email, q });
    }
  }

  for (let i = 0; i < todo.length; i += LOOKUP_BATCH) {
    const batch = todo.slice(i, i + LOOKUP_BATCH);
    const found = await Promise.all(
      batch.map(async ({ q }) => {
        const ids = await listMessageIds(store, integration, q, 1).catch(() => null);
        if (!ids?.ok) return undefined; // unknown: not cached, not shown
        const newest = ids.value[0];
        if (!newest) return null;
        const head = await readMessageHeadline(store, integration, newest).catch(() => null);
        return head?.at ?? undefined;
      }),
    );
    batch.forEach(({ email }, j) => {
      const lastAt = found[j];
      if (lastAt === undefined) return;
      cache.sent.set(`${organizationId}|${email.toLowerCase()}`, { at: now.getTime(), lastAt });
      checked.add(email);
      if (lastAt) lastSent[email] = lastAt;
    });
  }

  return { canSend: mailboxCanSend(integration), lastSent, checked };
}
