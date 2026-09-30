import 'server-only';
import { gunzipSync } from 'node:zlib';
import { env } from '@/lib/config/env';
import { log } from '@/lib/security/redact';
import type { RoutineBriefing } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { unwrapSlackText } from '@/lib/util/slack-text';

/**
 * The exact dashboard HTML the Daily Overview / Recap routines published as a
 * claude.ai artifact, relayed so the app can show Nick the same page. The
 * artifact itself is private to Arwin's account and the routines cannot reach
 * this app, so they post a gzip + base64 copy to the private relay channel in
 * pieces:
 *
 *   BRIEFING_HTML_V1
 *   `{"kind":"morning","date_key":"2026-09-30","run":"2026-09-30T11:31:07Z","part":1,"parts":2,"gz_b64":"..."}`
 *
 * `run` is the same on every piece of one post, so two posts on the same day
 * never mix their pieces.
 *
 * Nothing is stored: the copy is read from Slack when someone opens it and
 * cached in memory for a few minutes. The HTML is routine-written and quotes
 * third-party email, so the route that serves it disables its scripts.
 */

const MARKER = 'BRIEFING_HTML_V1';
const MAX_PARTS = 20;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const CACHE_MS = 5 * 60_000;
const MISS_CACHE_MS = 60_000;

export interface HtmlPart {
  kind: RoutineBriefing['kind'];
  date_key: string;
  run: string;
  part: number;
  parts: number;
  gz_b64: string;
}

/** One relay message -> one piece of a relayed page, or null. */
export function parseBriefingHtmlPart(text: unknown): HtmlPart | null {
  if (typeof text !== 'string') return null;
  const clean = unwrapSlackText(text).trim();
  if (!clean.startsWith(MARKER)) return null;
  const json = /`([^`]+)`/.exec(clean)?.[1];
  if (!json) return null;
  try {
    const p = JSON.parse(json) as Partial<HtmlPart>;
    const kindOk = p.kind === 'morning' || p.kind === 'afternoon' || p.kind === 'dossier';
    if (
      !kindOk ||
      typeof p.date_key !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(p.date_key) ||
      !Number.isInteger(p.part) ||
      !Number.isInteger(p.parts) ||
      p.parts! < 1 ||
      p.parts! > MAX_PARTS ||
      p.part! < 1 ||
      p.part! > p.parts! ||
      typeof p.run !== 'string' ||
      p.run.length > 64 ||
      typeof p.gz_b64 !== 'string' ||
      !/^[A-Za-z0-9+/=\s]+$/.test(p.gz_b64)
    ) {
      return null;
    }
    return p as HtmlPart;
  } catch {
    return null;
  }
}

/**
 * The newest complete page for `kind` and `dateKey` among relay messages,
 * newest first as Slack returns them. A set is complete when every part from
 * 1 to `parts` is present; a routine that re-posts later wins.
 */
export function assembleBriefingHtml(
  messages: { text?: unknown }[],
  kind: RoutineBriefing['kind'],
  dateKey: string,
): string | null {
  // Newest first: the first run whose pieces are all present is the newest.
  const groups = new Map<string, Map<number, string>>();
  for (const message of messages) {
    const part = parseBriefingHtmlPart(message.text);
    if (!part || part.kind !== kind || part.date_key !== dateKey) continue;
    const id = `${part.run}|${part.parts}`;
    const group = groups.get(id) ?? new Map<number, string>();
    groups.set(id, group);
    if (!group.has(part.part)) group.set(part.part, part.gz_b64.replace(/\s+/g, ''));
    if (group.size === part.parts) {
      const b64 = Array.from({ length: part.parts }, (_, i) => group.get(i + 1)!).join('');
      return decode(b64);
    }
  }
  return null;
}

function decode(b64: string): string | null {
  try {
    const html = gunzipSync(Buffer.from(b64, 'base64'), {
      maxOutputLength: MAX_HTML_BYTES,
    }).toString('utf8');
    return /<(html|body|div|main|section)\b/i.test(html) ? html : null;
  } catch {
    return null;
  }
}

const cache = processWide(
  'briefing-html',
  () => new Map<string, { html: string | null; at: number }>(),
);

/** Read the relay channel for the page matching this card, or null. */
export async function fetchBriefingHtml(
  kind: RoutineBriefing['kind'],
  dateKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const e = env();
  if (!e.askRelaySlackToken) return null;
  const key = `${kind}|${dateKey}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.html ? CACHE_MS : MISS_CACHE_MS)) return hit.html;

  try {
    const url = `https://slack.com/api/conversations.history?channel=${encodeURIComponent(
      e.askRelayChannelId,
    )}&limit=200`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${e.askRelaySlackToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(6_000),
    });
    const body = (await response.json()) as { ok?: boolean; messages?: { text?: unknown }[] };
    if (!body.ok) return null;
    const html = assembleBriefingHtml(body.messages ?? [], kind, dateKey);
    cache.set(key, { html, at: Date.now() });
    return html;
  } catch (error) {
    log.warn('Briefing page could not be read from the relay', {
      kind,
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return null;
  }
}

/** Test seam. */
export function resetBriefingHtmlCache(): void {
  cache.clear();
}

/**
 * Make the relayed page safe to serve and add the Save-as-PDF bar. The CSP on
 * the response already blocks every script without the nonce; removing them
 * and any meta refresh or base tag as well means nothing in the page depends
 * on that one line of defence.
 */
export function prepareBriefingHtml(html: string, nonce: string): string {
  const cleaned = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');
  const bar = `
<div id="copilot-bar" style="position:sticky;top:0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:flex-end;padding:10px 16px;background:rgba(20,17,15,.92);color:#efe9e4;font:600 13px/1.2 system-ui,-apple-system,'Segoe UI',sans-serif;backdrop-filter:blur(6px)">
  <span style="margin-right:auto;opacity:.75">TipTop Copilot</span>
  <button id="copilot-print" type="button" style="font:inherit;cursor:pointer;border:0;border-radius:8px;padding:8px 14px;background:#18c37e;color:#08130d">Save as PDF</button>
</div>
<style>@media print{#copilot-bar{display:none!important}}</style>
<script nonce="${nonce}">document.getElementById('copilot-print').addEventListener('click',function(){window.print()});</script>
`;
  return /<body\b[^>]*>/i.test(cleaned)
    ? cleaned.replace(/<body\b[^>]*>/i, (tag) => `${tag}${bar}`)
    : `${bar}${cleaned}`;
}
