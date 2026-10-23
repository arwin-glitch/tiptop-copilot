import type { RosterInterval, RosterSnapshot } from './types';

/**
 * Names from Google Meet (D-076, v1 nice): the page side of the Meet
 * extension (extension/meet). The extension reads Meet's participant list and
 * who is speaking, and passes snapshots to this page through its content
 * script on Copilot's own origin. Nothing goes to the server from here: the
 * timeline of who spoke when is lined up with the transcript's voices in the
 * browser, as suggestions for the "Who is this?" picker. The ladder ranks a
 * roster match below a person's tap, so a suggestion never overrides a name
 * someone chose.
 *
 * Consent: the page tells the extension when a recording with a confirmed
 * consent step is running, and the extension relays only then, and only when
 * its own "Send Meet names to Copilot" switch is on.
 */

export const PAGE_SOURCE = 'tiptop-copilot';
export const EXTENSION_SOURCE = 'tiptop-meet-extension';
export const BRIDGE_VERSION = 1;

const MAX_NAME = 120;
const MAX_PEOPLE = 60;

export interface RecordingStateMessage {
  source: typeof PAGE_SOURCE;
  version: typeof BRIDGE_VERSION;
  type: 'recording-state';
  meetingId: string;
  recording: boolean;
  consent: boolean;
}

export interface ExtensionHello {
  source: typeof EXTENSION_SOURCE;
  version: typeof BRIDGE_VERSION;
  type: 'hello';
  enabled: boolean;
}

export interface RosterMessage {
  source: typeof EXTENSION_SOURCE;
  version: typeof BRIDGE_VERSION;
  type: 'roster';
  participants: string[];
  speaking: string[];
  /** Wall-clock ms when Meet showed this. */
  at: number;
}

function cleanNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') return null;
    const name = v.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** A message from the extension, or null for anything else on the window. */
export function parseExtensionMessage(data: unknown): ExtensionHello | RosterMessage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.source !== EXTENSION_SOURCE || d.version !== BRIDGE_VERSION) return null;
  if (d.type === 'hello') {
    return {
      source: EXTENSION_SOURCE,
      version: BRIDGE_VERSION,
      type: 'hello',
      enabled: d.enabled === true,
    };
  }
  if (d.type === 'roster') {
    const participants = cleanNames(d.participants);
    const speaking = cleanNames(d.speaking);
    const at = typeof d.at === 'number' && Number.isFinite(d.at) ? d.at : null;
    if (!participants || !speaking || at === null) return null;
    return {
      source: EXTENSION_SOURCE,
      version: BRIDGE_VERSION,
      type: 'roster',
      participants,
      speaking: speaking.filter((s) => participants.includes(s) || participants.length === 0),
      at,
    };
  }
  return null;
}

/**
 * Builds who-spoke-when from roster snapshots. `clock` maps a wall-clock time
 * to the recording's clock, or null while paused (nothing is kept then).
 */
export class RosterTimeline {
  private readonly open = new Map<string, number>();
  private intervals: RosterInterval[] = [];
  private participants: string[] = [];

  constructor(private readonly clock: (wallMs: number) => number | null) {}

  apply(message: RosterMessage): void {
    this.participants = message.participants;
    const at = this.clock(message.at);
    if (at === null) {
      this.closeAll(null);
      return;
    }
    const speaking = new Set(message.speaking);
    for (const [name, start] of [...this.open]) {
      if (!speaking.has(name)) {
        this.open.delete(name);
        if (at > start) this.intervals.push({ name, startMs: start, endMs: at });
      }
    }
    for (const name of speaking) if (!this.open.has(name)) this.open.set(name, at);
    if (this.intervals.length > 5000) this.intervals = this.intervals.slice(-5000);
  }

  /** Close every open interval (a pause, or the end), at `atMs` or dropping them. */
  closeAll(atMs: number | null): void {
    for (const [name, start] of this.open) {
      if (atMs !== null && atMs > start) this.intervals.push({ name, startMs: start, endMs: atMs });
    }
    this.open.clear();
  }

  snapshot(connected: boolean): RosterSnapshot {
    return { connected, participants: [...this.participants], intervals: [...this.intervals] };
  }
}

export interface RosterSuggestion {
  clusterKey: string;
  name: string;
  /** Share of the voice's talk time that this person was shown speaking, 0..1. */
  score: number;
}

/**
 * Line the speaking timeline up with each voice's lines: a voice whose talk
 * time mostly falls while one person shows as speaking is probably them.
 * Answers the best name per voice, strongest first; weak or ambiguous
 * matches are left out.
 */
export function rosterSuggestions(
  intervals: RosterInterval[],
  lines: { clusterKey: string; startMs: number; endMs: number }[],
  options: { minScore?: number; minOverlapMs?: number; exclude?: string[] } = {},
): RosterSuggestion[] {
  const minScore = options.minScore ?? 0.5;
  const minOverlapMs = options.minOverlapMs ?? 3000;
  const exclude = new Set(options.exclude ?? []);
  const talk = new Map<string, number>();
  const overlap = new Map<string, Map<string, number>>();
  for (const line of lines) {
    if (line.clusterKey === 'mic' || line.clusterKey.startsWith('mic#')) continue;
    const length = Math.max(0, line.endMs - line.startMs);
    talk.set(line.clusterKey, (talk.get(line.clusterKey) ?? 0) + length);
    for (const iv of intervals) {
      if (exclude.has(iv.name)) continue;
      const o = Math.min(line.endMs, iv.endMs) - Math.max(line.startMs, iv.startMs);
      if (o <= 0) continue;
      const byName = overlap.get(line.clusterKey) ?? new Map<string, number>();
      byName.set(iv.name, (byName.get(iv.name) ?? 0) + o);
      overlap.set(line.clusterKey, byName);
    }
  }
  const out: RosterSuggestion[] = [];
  for (const [clusterKey, byName] of overlap) {
    const total = talk.get(clusterKey) ?? 0;
    if (total <= 0) continue;
    const ranked = [...byName].sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    if (!best || best[1] < minOverlapMs) continue;
    const score = Math.min(1, best[1] / total);
    // Two people sharing the voice's time about equally: no suggestion.
    if (score < minScore || (second && second[1] > best[1] * 0.8)) continue;
    out.push({ clusterKey, name: best[0], score });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * The page side of the bridge: listens for the extension on this window only
 * (same origin, same window), and tells it when a consented recording runs.
 */
export class MeetRosterBridge {
  private connected = false;
  private readonly listener = (event: MessageEvent) => {
    if (typeof window === 'undefined') return;
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = parseExtensionMessage(event.data);
    if (!message) return;
    if (message.type === 'hello') {
      this.connected = message.enabled;
      this.onChange();
      return;
    }
    this.connected = true;
    this.timeline.apply(message);
    this.onChange();
  };

  constructor(
    private readonly timeline: RosterTimeline,
    private readonly onChange: () => void,
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('message', this.listener);
  }

  /** Tell the extension what is happening. It relays names only while `recording && consent`. */
  announce(meetingId: string, recording: boolean, consent: boolean): void {
    if (typeof window === 'undefined') return;
    const message: RecordingStateMessage = {
      source: PAGE_SOURCE,
      version: BRIDGE_VERSION,
      type: 'recording-state',
      meetingId,
      recording,
      consent,
    };
    window.postMessage(message, window.location.origin);
  }

  stop(meetingId: string): void {
    this.announce(meetingId, false, false);
    if (typeof window !== 'undefined') window.removeEventListener('message', this.listener);
  }
}
