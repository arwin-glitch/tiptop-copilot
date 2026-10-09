import 'server-only';
import { isDemoMode } from '@/lib/config/env';
import type { DataStore } from '@/lib/db/store';
import { listMessageIds, readMessageHeadline } from '@/lib/google/gmail-inbox';
import { processWide } from '@/lib/util/process-state';
import type { LpItem, LpStage } from './follow-ups';
import { getPrimaryIntegration } from './inbox';

/**
 * Who is reading Nick's DocSend links, read from DocSend's own notification
 * emails in his mailbox ("x@firm.com viewed the document Y"). Nothing is
 * connected to DocSend itself: the app already reads the mailbox, and the
 * subject line carries the viewer, the document and whether they downloaded.
 *
 * Views of fundraising material (the prospective-partner update, decks) are
 * the signal: someone outside TipTop just spent time on the fund. Fund I LPs
 * reading their own LP update are shown separately, as context.
 */

const QUERY = 'from:no-reply@docsend.com newer_than:180d -subject:"weekly activity report"';
const MAX_MESSAGES = 300;
const LIST_TTL_MS = 10 * 60_000;
const FETCH_BATCH = 10;

export type DocKind = 'fundraise' | 'lp_update' | 'other';

export interface DocSendView {
  messageId: string;
  threadId: string;
  viewer: string;
  document: string;
  downloaded: boolean;
  at: string;
}

export interface DocSendReader {
  email: string;
  /** "Jessica Whittington" from jessica.whittington@…, or the matched LP's name. */
  name: string | null;
  /** Company domain; null for personal mail (gmail.com and the like). */
  domain: string | null;
  kind: 'prospect' | 'lp' | 'other';
  documents: string[];
  views: number;
  firstAt: string;
  lastAt: string;
  downloaded: boolean;
  /** Gmail thread of the newest notification. */
  threadId: string;
  latestMessageId: string;
  hot: boolean;
  match: { who: string; firm: string | null; stage: LpStage } | null;
}

const SUBJECT = /^\s*(\S+@\S+?)\s+viewed( and downloaded)? the document\s+(.+?)\s*$/i;

export function parseDocSendSubject(
  subject: string,
): { viewer: string; document: string; downloaded: boolean } | null {
  const m = SUBJECT.exec(subject);
  if (!m) return null;
  return { viewer: m[1]!.toLowerCase(), document: m[3]!, downloaded: Boolean(m[2]) };
}

export function documentKind(document: string): DocKind {
  if (/prospective/i.test(document)) return 'fundraise';
  if (/\bLP update\b/i.test(document)) return 'lp_update';
  if (/deck|fund\b|fund i|tl;dr|data room|memo|one[- ]pager/i.test(document)) return 'fundraise';
  return 'other';
}

const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function nameFromLocal(local: string): string | null {
  const parts = local.split(/[._-]+/).filter((p) => /^[a-z]{2,}$/i.test(p));
  if (parts.length < 2) return null;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ');
}

/** The pipeline entry this viewer most likely is: same firm by domain, else same person by name. */
export function matchLp(email: string, lps: readonly LpItem[]): LpItem | null {
  const [local = '', domain = ''] = email.split('@');
  const localKey = alnum(local);
  const corporate = domain && !FREE_MAIL.has(domain);
  const domainKey = alnum(domain.split('.').slice(0, -1).join('.'));

  const byName = (lp: LpItem) => {
    const tokens = lp.who.toLowerCase().split(/\s+/).map(alnum).filter(Boolean);
    const last = tokens.at(-1);
    const first = tokens[0];
    if (!last || last.length < 4 || !first || tokens.length < 2) return false;
    return localKey.includes(last) && localKey.startsWith(first.charAt(0));
  };
  const byFirm = (lp: LpItem) => {
    const firm = alnum(lp.firm ?? '');
    if (!corporate || firm.length < 4 || domainKey.length < 4) return false;
    return firm === domainKey || firm.includes(domainKey) || domainKey.includes(firm);
  };

  return lps.find((lp) => byFirm(lp) && byName(lp)) ?? lps.find(byFirm) ?? lps.find(byName) ?? null;
}

const DAY = 86_400_000;

export function isHot(reader: Pick<DocSendReader, 'lastAt' | 'views' | 'downloaded'>, now: Date) {
  const age = now.getTime() - Date.parse(reader.lastAt);
  return age <= 3 * DAY || (age <= 14 * DAY && (reader.views >= 2 || reader.downloaded));
}

/** One row per outside viewer, newest first, hot ones on top. Pure, for tests. */
export function buildReaders(
  views: readonly DocSendView[],
  options: { ownDomain: string | null; lps: readonly LpItem[]; now: Date },
): DocSendReader[] {
  const own = options.ownDomain?.toLowerCase() ?? null;
  const byViewer = new Map<string, DocSendView[]>();
  for (const v of views) {
    const domain = v.viewer.split('@')[1] ?? '';
    if (own && domain === own) continue;
    const list = byViewer.get(v.viewer) ?? [];
    list.push(v);
    byViewer.set(v.viewer, list);
  }

  const readers: DocSendReader[] = [];
  for (const [email, list] of byViewer) {
    list.sort((a, b) => b.at.localeCompare(a.at));
    const newest = list[0]!;
    const kinds = new Set(list.map((v) => documentKind(v.document)));
    const kind = kinds.has('fundraise') ? 'prospect' : kinds.has('lp_update') ? 'lp' : 'other';
    const [local = '', domain = ''] = email.split('@');
    const lp = matchLp(email, options.lps);
    const base = {
      lastAt: newest.at,
      views: list.length,
      downloaded: list.some((v) => v.downloaded),
    };
    readers.push({
      email,
      name: lp?.who ?? nameFromLocal(local),
      domain: domain && !FREE_MAIL.has(domain) ? domain : null,
      kind,
      documents: [...new Set(list.map((v) => v.document))],
      firstAt: list.at(-1)!.at,
      threadId: newest.threadId,
      latestMessageId: newest.messageId,
      hot: isHot(base, options.now),
      match: lp ? { who: lp.who, firm: lp.firm ?? null, stage: lp.stage } : null,
      ...base,
    });
  }
  return readers.sort((a, b) => Number(b.hot) - Number(a.hot) || b.lastAt.localeCompare(a.lastAt));
}

export type DocSendState = 'ok' | 'not_connected' | 'error';

export interface DocSendResult {
  state: DocSendState;
  views: DocSendView[];
  ownDomain: string | null;
  checkedAt: string;
}

const cache = processWide('docsend-views', () => ({
  headlines: new Map<string, DocSendView | null>(),
  lists: new Map<string, { at: number; result: DocSendResult }>(),
}));

/** Test hook. */
export function resetDocSendCache(): void {
  cache.headlines.clear();
  cache.lists.clear();
}

/** Fictional views for demo mode. */
function demoViews(now: Date): DocSendView[] {
  const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  return [
    [
      'priya@harborlp.demo',
      'Northwind Ventures — LP Update [Prospective Partner Version]',
      false,
      5,
    ],
    [
      'priya@harborlp.demo',
      'Northwind Ventures — LP Update [Prospective Partner Version]',
      true,
      30,
    ],
    ['sam.okafor@gmail.com', 'Northwind Fund I Deck', false, 50],
    ['lee@quietpine.demo', 'LP Update #4 - Summer [Northwind Ventures]', false, 70],
  ].map(([viewer, document, downloaded, h], i) => ({
    messageId: `d0c5e0d${i}0000000a`,
    threadId: `d0c5e0d${i}0000000a`,
    viewer: viewer as string,
    document: document as string,
    downloaded: downloaded as boolean,
    at: ago(h as number),
  }));
}

/** DocSend views from the mailbox, cached for 10 minutes; never throws. */
export async function readDocSendViews(
  store: DataStore,
  organizationId: string,
  options: { now?: Date; force?: boolean } = {},
): Promise<DocSendResult> {
  const now = options.now ?? new Date();
  if (isDemoMode()) {
    return { state: 'ok', views: demoViews(now), ownDomain: null, checkedAt: now.toISOString() };
  }
  const cached = cache.lists.get(organizationId);
  if (!options.force && cached && now.getTime() - cached.at < LIST_TTL_MS) return cached.result;

  const integration = await getPrimaryIntegration(store, organizationId).catch(() => null);
  if (!integration || integration.status === 'disconnected') {
    return { state: 'not_connected', views: [], ownDomain: null, checkedAt: now.toISOString() };
  }
  const ownDomain = integration.account_email?.split('@')[1]?.toLowerCase() ?? null;
  const ids = await listMessageIds(store, integration, QUERY, MAX_MESSAGES);
  if (!ids.ok) {
    return cached?.result ?? { state: 'error', views: [], ownDomain, checkedAt: now.toISOString() };
  }

  const missing = ids.value.filter((id) => !cache.headlines.has(id));
  for (let i = 0; i < missing.length; i += FETCH_BATCH) {
    const batch = missing.slice(i, i + FETCH_BATCH);
    const heads = await Promise.all(
      batch.map((id) => readMessageHeadline(store, integration, id).catch(() => null)),
    );
    batch.forEach((id, j) => {
      const h = heads[j];
      if (!h) return; // a failed read is retried next time, not remembered as empty
      const parsed = parseDocSendSubject(h.subject);
      cache.headlines.set(
        id,
        parsed && h.at ? { messageId: id, threadId: h.threadId, at: h.at, ...parsed } : null,
      );
    });
  }

  const views = ids.value
    .map((id) => cache.headlines.get(id))
    .filter((v): v is DocSendView => Boolean(v));
  const result: DocSendResult = { state: 'ok', views, ownDomain, checkedAt: now.toISOString() };
  cache.lists.set(organizationId, { at: now.getTime(), result });
  return result;
}
