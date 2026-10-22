import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BRIDGE_VERSION,
  EXTENSION_SOURCE,
  PAGE_SOURCE,
  RosterTimeline,
  parseExtensionMessage,
  rosterSuggestions,
} from '@/lib/capture/meet-roster';
import { mockTranscriptEvents } from '@/lib/transcribe/mock-script';
import { CONSENT_NOTICE_TEXT } from '@/lib/types/notes';

/**
 * The Meet names extension (D-076, WS3, v1 nice) and the page side of its
 * bridge. The extension's reading logic runs in a sandbox against stand-in
 * elements; the bridge's checks and the voice-to-name matching run as is.
 */

const DIR = path.resolve(import.meta.dirname, '../../extension/meet');

interface MeetApi {
  CONSENT_NOTICE_TEXT: string;
  EXTENSION_SOURCE: string;
  PAGE_SOURCE: string;
  BRIDGE_VERSION: number;
  cleanName(v: unknown): string | null;
  readRoster(root: unknown): { participants: string[]; speaking: string[] };
  RosterTracker: new (heartbeatMs?: number) => {
    next(
      s: { participants: string[]; speaking: string[] },
      now: number,
    ): Record<string, unknown> | null;
  };
  shouldRelay(state: unknown): boolean;
  postToChat(doc: unknown, text: string): string;
}

function loadCore(): MeetApi {
  const sandbox: Record<string, unknown> = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(DIR, 'roster-core.js'), 'utf8'), sandbox);
  return sandbox.TipTopMeet as MeetApi;
}

/** A tiny stand-in for DOM elements: attributes, text, children, and selector lookups by predicate. */
class El {
  children: El[] = [];
  constructor(
    readonly tag: string,
    readonly attrs: Record<string, string> = {},
    readonly text = '',
  ) {}
  add(...kids: El[]) {
    this.children.push(...kids);
    return this;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  private descendants(): El[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(selector: string): El[] {
    return this.descendants().filter((el) => matches(el, selector));
  }
  querySelector(selector: string): El | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** Enough of CSS for the extension's selectors: [attr], [attr="v"], [attr*="v" i], tag.class, descendant. */
function matches(el: El, selector: string): boolean {
  const last =
    selector
      .trim()
      .split(/\s+(?![^[]*\])/)
      .pop() ?? '';
  const tag = /^[a-z]+/i.exec(last)?.[0];
  if (tag && el.tag !== tag) return false;
  const cls = /\.([\w-]+)/.exec(last)?.[1];
  if (cls && !(el.attrs.class ?? '').split(' ').includes(cls)) return false;
  for (const m of last.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)"(\s+i)?)?\]/g)) {
    const [, name, op, value, insensitive] = m;
    const actual = el.attrs[name!];
    if (actual === undefined) return false;
    if (op === '=' && actual !== value) return false;
    if (op === '*=') {
      const a = insensitive ? actual.toLowerCase() : actual;
      const v = insensitive ? value!.toLowerCase() : value!;
      if (!a.includes(v)) return false;
    }
  }
  return true;
}

describe('the extension package', () => {
  it('is MV3 with the least it needs', () => {
    const manifest = JSON.parse(readFileSync(path.join(DIR, 'manifest.json'), 'utf8')) as {
      manifest_version: number;
      permissions: string[];
      host_permissions?: string[];
      content_scripts: { matches: string[] }[];
    };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.host_permissions).toBeUndefined();
    const hosts = manifest.content_scripts.flatMap((c) => c.matches);
    expect(hosts.sort()).toEqual(
      [
        'http://127.0.0.1/*',
        'http://localhost/*',
        'https://copilot.tiptop.vc/*',
        'https://meet.google.com/*',
      ].sort(),
    );
  });

  it('posts the same notice Copilot copies, and speaks the bridge’s protocol', () => {
    const core = loadCore();
    expect(core.CONSENT_NOTICE_TEXT).toBe(CONSENT_NOTICE_TEXT);
    expect(core.EXTENSION_SOURCE).toBe(EXTENSION_SOURCE);
    expect(core.PAGE_SOURCE).toBe(PAGE_SOURCE);
    expect(core.BRIDGE_VERSION).toBe(BRIDGE_VERSION);
    for (const file of ['content-copilot.js', 'background.js', 'content-meet.js']) {
      const text = readFileSync(path.join(DIR, file), 'utf8');
      expect(text, file).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket/);
    }
  });
});

describe('reading Meet', () => {
  it('finds participants, who is speaking, and captions', () => {
    const core = loadCore();
    const page = new El('body').add(
      new El('div', { 'data-participant-id': 'p1' }).add(
        new El('span', { class: 'notranslate' }, 'Dana Reyes'),
        new El('div', { 'data-is-speaking': 'true' }),
      ),
      new El('div', { 'data-participant-id': 'p2' }).add(
        new El('span', { class: 'notranslate' }, 'Priya Shah'),
      ),
      new El('div', { 'data-participant-id': 'p3' }).add(
        new El('div', { 'data-self-name': 'You' }),
      ),
      new El('div', { role: 'list', 'aria-label': 'Participants' }).add(
        new El('div', { role: 'listitem', 'aria-label': 'Sam Ortiz' }),
      ),
    );
    expect(core.readRoster(page)).toEqual({
      participants: ['Dana Reyes', 'Priya Shah', 'Sam Ortiz'],
      speaking: ['Dana Reyes'],
    });
  });

  it('reports nothing rather than guessing on an unknown page', () => {
    const core = loadCore();
    expect(core.readRoster(new El('body').add(new El('div', {}, 'Welcome')))).toEqual({
      participants: [],
      speaking: [],
    });
    expect(core.cleanName('  Dana   Reyes (Presenting) ')).toBe('Dana Reyes');
    expect(core.cleanName('You')).toBeNull();
    expect(core.cleanName(42)).toBeNull();
  });

  it('sends a snapshot when something changes, else a heartbeat', () => {
    const core = loadCore();
    const tracker = new core.RosterTracker(10_000);
    const a = { participants: ['Dana Reyes'], speaking: [] as string[] };
    expect(tracker.next(a, 1000)).toMatchObject({
      source: EXTENSION_SOURCE,
      type: 'roster',
      at: 1000,
    });
    expect(tracker.next({ ...a }, 2000)).toBeNull();
    expect(
      tracker.next({ participants: ['Dana Reyes'], speaking: ['Dana Reyes'] }, 3000),
    ).not.toBeNull();
    expect(
      tracker.next({ participants: ['Dana Reyes'], speaking: ['Dana Reyes'] }, 14_000),
    ).not.toBeNull();
  });

  it('relays only with the switch on and a consented recording', () => {
    const core = loadCore();
    expect(core.shouldRelay({ enabled: true, recording: true, consent: true })).toBe(true);
    expect(core.shouldRelay({ enabled: false, recording: true, consent: true })).toBe(false);
    expect(core.shouldRelay({ enabled: true, recording: true, consent: false })).toBe(false);
    expect(core.shouldRelay({ enabled: true, recording: false, consent: true })).toBe(false);
    expect(core.shouldRelay(null)).toBe(false);
  });

  it('posts the notice only into an open chat box', () => {
    const core = loadCore();
    expect(core.postToChat(new El('body'), 'x')).toBe('no_chat');
  });
});

describe('the page side of the bridge', () => {
  it('accepts only the extension’s own, well-formed messages', () => {
    expect(parseExtensionMessage({ source: 'someone-else', version: 1, type: 'hello' })).toBeNull();
    expect(
      parseExtensionMessage({ source: EXTENSION_SOURCE, version: 2, type: 'hello' }),
    ).toBeNull();
    expect(
      parseExtensionMessage({
        source: EXTENSION_SOURCE,
        version: 1,
        type: 'roster',
        participants: 'x',
        speaking: [],
        at: 1,
      }),
    ).toBeNull();
    expect(
      parseExtensionMessage({
        source: EXTENSION_SOURCE,
        version: 1,
        type: 'roster',
        participants: ['  Dana  Reyes ', 'Dana Reyes', 'x'.repeat(500)],
        speaking: ['Dana Reyes', 'Nobody Listed'],
        at: 5,
      }),
    ).toEqual({
      source: EXTENSION_SOURCE,
      version: 1,
      type: 'roster',
      participants: ['Dana Reyes', 'x'.repeat(120)],
      speaking: ['Dana Reyes'],
      at: 5,
    });
  });

  it('builds who-spoke-when on the recording clock, and keeps nothing while paused', () => {
    let paused = false;
    const timeline = new RosterTimeline((wall) => (paused ? null : wall - 1000));
    const msg = (speaking: string[], at: number) => ({
      source: EXTENSION_SOURCE as typeof EXTENSION_SOURCE,
      version: 1 as const,
      type: 'roster' as const,
      participants: ['Dana Reyes', 'Priya Shah'],
      speaking,
      at,
    });
    timeline.apply(msg(['Dana Reyes'], 2000));
    timeline.apply(msg(['Priya Shah'], 5000));
    paused = true;
    timeline.apply(msg([], 6000));
    expect(timeline.snapshot(true).intervals).toEqual([
      { name: 'Dana Reyes', startMs: 1000, endMs: 4000 },
    ]);
  });

  it('suggests the person whose speaking time matches a voice', () => {
    const events = mockTranscriptEvents(['system']);
    const lines = events.map((e) => ({
      clusterKey: `sys:${e.speakerLabel}`,
      startMs: e.startMs,
      endMs: e.endMs,
    }));
    // What Meet showed: Dana and Priya speaking during their own lines; the late joiner not named.
    const intervals = events
      .filter((e) => e.speakerLabel !== 'S3')
      .map((e) => ({
        name: e.speakerLabel === 'S1' ? 'Dana Reyes' : 'Priya Shah',
        startMs: e.startMs - 200,
        endMs: e.endMs + 200,
      }));
    const suggestions = rosterSuggestions(intervals, [
      ...lines,
      { clusterKey: 'mic', startMs: 0, endMs: 4200 },
    ]);
    expect(suggestions.map((s) => [s.clusterKey, s.name])).toEqual(
      expect.arrayContaining([
        ['sys:S1', 'Dana Reyes'],
        ['sys:S2', 'Priya Shah'],
      ]),
    );
    expect(suggestions.find((s) => s.clusterKey === 'sys:S3')).toBeUndefined();
    expect(suggestions.find((s) => s.clusterKey === 'mic')).toBeUndefined();
  });

  it('makes no suggestion when two people share a voice’s time', () => {
    const lines = [{ clusterKey: 'sys:S1', startMs: 0, endMs: 10_000 }];
    const intervals = [
      { name: 'Dana Reyes', startMs: 0, endMs: 5000 },
      { name: 'Priya Shah', startMs: 5000, endMs: 10_000 },
    ];
    expect(rosterSuggestions(intervals, lines)).toEqual([]);
  });
});
