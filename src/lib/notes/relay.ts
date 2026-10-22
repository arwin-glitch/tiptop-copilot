import 'server-only';
import { env } from '@/lib/config/env';
import { log } from '@/lib/security/redact';
import { processWide } from '@/lib/util/process-state';

/**
 * Where Arwin's routine posts what Copilot asked it for (D-076): the Slack
 * relay channel, read with ASK_RELAY_SLACK_TOKEN (read-only; the app posts
 * nothing there). The routine cannot reach the app, so this is the only way
 * back.
 *
 * In demo mode there is no Slack: a process-wide list stands in for the
 * channel, filled through POST /api/notes/demo/relay (demo mode only), which
 * is how the end-to-end tests play the routine. The same switch can route
 * the meeting chat through the bridge in demo mode, so a test can answer it.
 */

export interface RelayMessage {
  text: string;
  /** Slack's message timestamp, "<seconds>.<micros>". */
  ts: string;
}

const SLACK_TIMEOUT_MS = 6_000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 3;
const DEMO_MAX_MESSAGES = 500;

const demo = processWide('notes-demo-relay', () => ({
  messages: [] as RelayMessage[],
  bridge: false,
}));

/** The relay can be read: a Slack token, or demo mode's stand-in. */
export function relayReadable(): boolean {
  const e = env();
  return Boolean(e.askRelaySlackToken) || e.demoMode;
}

/** Demo mode only: a message as if the routine had posted it. */
export function postDemoRelay(text: string, now: Date = new Date()): boolean {
  if (!env().demoMode) return false;
  demo.messages.push({ text, ts: (now.getTime() / 1000).toFixed(6) });
  if (demo.messages.length > DEMO_MAX_MESSAGES)
    demo.messages.splice(0, demo.messages.length - DEMO_MAX_MESSAGES);
  return true;
}

/** Demo mode only: send the meeting chat through the bridge (true) or answer it at once (false). */
export function setDemoBridge(on: boolean): boolean {
  if (!env().demoMode) return false;
  demo.bridge = on;
  return true;
}

export function demoBridgeOn(): boolean {
  return env().demoMode && demo.bridge;
}

/** Test hook: an empty demo channel and the bridge off. */
export function resetDemoRelay(): void {
  demo.messages = [];
  demo.bridge = false;
}

/**
 * The relay channel's messages since `oldest` (epoch seconds), newest first,
 * or null when it cannot be read. A failure is logged and reads as null.
 */
export async function readRelay(
  options: { channel: string; oldest?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<RelayMessage[] | null> {
  const e = env();
  if (!e.askRelaySlackToken) {
    if (!e.demoMode) return null;
    const oldest = options.oldest ?? 0;
    return demo.messages.filter((m) => Number(m.ts) >= oldest).reverse();
  }
  const out: RelayMessage[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ channel: options.channel, limit: String(PAGE_LIMIT) });
      if (options.oldest) params.set('oldest', options.oldest.toFixed(6));
      if (cursor) params.set('cursor', cursor);
      const response = await fetchImpl(`https://slack.com/api/conversations.history?${params}`, {
        headers: { Authorization: `Bearer ${e.askRelaySlackToken}` },
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        error?: string;
        messages?: Array<{ text?: unknown; ts?: unknown }>;
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };
      if (!body.ok) {
        log.warn('Notes relay channel could not be read', { error: body.error ?? 'unknown' });
        return out.length ? out : null;
      }
      for (const m of body.messages ?? []) {
        if (typeof m.text === 'string') out.push({ text: m.text, ts: String(m.ts ?? '') });
      }
      cursor = body.response_metadata?.next_cursor || undefined;
      if (!body.has_more || !cursor) break;
    }
    return out;
  } catch (error) {
    log.warn('Notes relay channel could not be read', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return out.length ? out : null;
  }
}
