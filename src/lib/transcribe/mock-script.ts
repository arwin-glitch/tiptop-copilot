import type { TranscriptEvent, TranscriptTrack } from '@/lib/types/notes';

/**
 * The scripted call demo mode "records" (D-076): a fictional founder pitch.
 *
 * Every name, company, address and number here is invented: Acme Robotics,
 * Dana Reyes (CEO), Priya Shah (CTO), and a teammate who joins late and is
 * never introduced, so one voice stays unresolved ("Guest 1") until someone
 * taps "This is…". The person recording is the mic: their lines carry
 * whoever is signed in.
 *
 * Client-safe, with no timers of its own beyond streamMockCall: the web
 * recorder's mock socket plays it in demo mode, the demo fixtures store it as
 * a finished meeting, and the tests read it, so all three see the same call.
 *
 * It is written to exercise the naming ladder: "Dana, go ahead" and "Priya,
 * how does…" name the next voice, "Thanks, Priya" names the last one, and the
 * calendar invite lists Dana and Priya (not the late joiner). Its action items
 * include a promise by the recorder ("I'll send you an intro … by Friday").
 */

export const MOCK_CALL_ID = 'acme-intro';

export interface MockCallPerson {
  key: 'owner' | 'dana' | 'priya' | 'late_joiner';
  /** Null for the recorder (the signed-in person) and the late joiner (never named). */
  name: string | null;
  email: string | null;
  title: string | null;
  /** Their vendor label on the meeting-audio track; null for the mic. */
  systemLabel: string | null;
  /** Their vendor label when everyone is on one mixed track (in person). */
  mixedLabel: string;
}

export const MOCK_CALL_PEOPLE: readonly MockCallPerson[] = [
  { key: 'owner', name: null, email: null, title: null, systemLabel: null, mixedLabel: 'S1' },
  {
    key: 'dana',
    name: 'Dana Reyes',
    email: 'dana@acmerobotics.example',
    title: 'CEO, Acme Robotics',
    systemLabel: 'S1',
    mixedLabel: 'S2',
  },
  {
    key: 'priya',
    name: 'Priya Shah',
    email: 'priya@acmerobotics.example',
    title: 'CTO, Acme Robotics',
    systemLabel: 'S2',
    mixedLabel: 'S3',
  },
  {
    key: 'late_joiner',
    name: null,
    email: null,
    title: null,
    systemLabel: 'S3',
    mixedLabel: 'S4',
  },
];

export const MOCK_CALL_TITLE = 'Acme Robotics intro: Dana Reyes and Priya Shah';

/** The invite's guests (the late joiner was never invited). */
export const MOCK_CALL_GUESTS: readonly { name: string; email: string }[] = [
  { name: 'Dana Reyes', email: 'dana@acmerobotics.example' },
  { name: 'Priya Shah', email: 'priya@acmerobotics.example' },
];

export interface MockLine {
  speaker: MockCallPerson['key'];
  startMs: number;
  endMs: number;
  text: string;
}

export const MOCK_CALL_LINES: readonly MockLine[] = [
  {
    speaker: 'owner',
    startMs: 0,
    endMs: 4200,
    text: "Thanks for making the time, both of you. I've let everyone know this call is being transcribed for notes.",
  },
  {
    speaker: 'dana',
    startMs: 4800,
    endMs: 9500,
    text: "Of course, happy to be here. I'm Dana, I run Acme Robotics, and Priya leads engineering.",
  },
  { speaker: 'priya', startMs: 10_000, endMs: 13_000, text: 'Hi! Glad to finally meet.' },
  {
    speaker: 'owner',
    startMs: 13_500,
    endMs: 18_000,
    text: "Great. Dana, go ahead and give me the short version of what you're building.",
  },
  {
    speaker: 'dana',
    startMs: 18_500,
    endMs: 28_000,
    text: 'We make picking robots for small warehouses. Our arm retrofits onto existing shelving, so a customer is live in about two weeks instead of six months.',
  },
  {
    speaker: 'dana',
    startMs: 28_500,
    endMs: 36_000,
    text: "We're at 1.2 million in annual recurring revenue, up from 400 thousand a year ago, across 19 customers.",
  },
  {
    speaker: 'owner',
    startMs: 36_500,
    endMs: 40_000,
    text: 'What does retention look like across those 19?',
  },
  {
    speaker: 'dana',
    startMs: 40_500,
    endMs: 46_000,
    text: "Net revenue retention is 130 percent. We've lost one customer, and that was a site closure.",
  },
  {
    speaker: 'owner',
    startMs: 46_500,
    endMs: 50_000,
    text: 'Priya, how does the retrofit actually work on the hardware side?',
  },
  {
    speaker: 'priya',
    startMs: 50_500,
    endMs: 60_000,
    text: "The arm clamps onto standard pallet racking. Vision does the rest, so we don't need markers or a site survey.",
  },
  {
    speaker: 'late_joiner',
    startMs: 60_500,
    endMs: 65_000,
    text: "Sorry I'm late, I was on the floor with a customer. I can cover the deployment numbers if that's useful.",
  },
  {
    speaker: 'priya',
    startMs: 65_500,
    endMs: 70_000,
    text: 'Perfect timing. Average deployment is down to eleven days now.',
  },
  {
    speaker: 'owner',
    startMs: 70_500,
    endMs: 74_000,
    text: 'Thanks, Priya. And what are you raising?',
  },
  {
    speaker: 'dana',
    startMs: 74_500,
    endMs: 82_000,
    text: "Four million on a SAFE at a 22 million cap. We have about 2.5 committed, and we'd like to close by mid-November.",
  },
  { speaker: 'owner', startMs: 82_500, endMs: 85_000, text: "Who's leading the round?" },
  {
    speaker: 'dana',
    startMs: 85_500,
    endMs: 91_000,
    text: 'No lead yet. Two angels and our existing seed fund are in.',
  },
  {
    speaker: 'owner',
    startMs: 91_500,
    endMs: 100_000,
    text: 'Okay. My main question is gross margin on the hardware. Can you send me the unit economics?',
  },
  {
    speaker: 'dana',
    startMs: 100_500,
    endMs: 106_000,
    text: "Yes, we'll send the data room link with the unit economics today.",
  },
  {
    speaker: 'owner',
    startMs: 106_500,
    endMs: 115_000,
    text: "Great. I'll send you an intro to our portfolio operations lead by Friday. She's helped a few hardware companies with pricing.",
  },
  {
    speaker: 'priya',
    startMs: 115_500,
    endMs: 119_000,
    text: 'That would be really helpful, thank you.',
  },
  {
    speaker: 'late_joiner',
    startMs: 119_500,
    endMs: 124_000,
    text: "I'll put together a short deployment case study for you as well.",
  },
  {
    speaker: 'owner',
    startMs: 124_500,
    endMs: 130_000,
    text: "Perfect. Let's plan a follow-up with the full team the week after next.",
  },
  {
    speaker: 'dana',
    startMs: 130_500,
    endMs: 134_000,
    text: 'Sounds good. Thanks again for the time.',
  },
];

/** How long the scripted call runs, in milliseconds. */
export const MOCK_CALL_DURATION_MS = MOCK_CALL_LINES[MOCK_CALL_LINES.length - 1]?.endMs ?? 0;

function person(key: MockCallPerson['key']): MockCallPerson {
  const found = MOCK_CALL_PEOPLE.find((p) => p.key === key);
  if (!found) throw new Error(`Unknown mock speaker ${key}`);
  return found;
}

/**
 * The call as finished vendor events, in time order. With 'mixed' among the
 * tracks everyone is on one diarized track (an in-person meeting); otherwise
 * the recorder is the mic and everyone else is the meeting audio. Lines on a
 * track not asked for are left out (mic-only mode hears the recorder alone).
 */
export function mockTranscriptEvents(tracks: readonly TranscriptTrack[]): TranscriptEvent[] {
  const mixed = tracks.includes('mixed');
  const out: TranscriptEvent[] = [];
  for (const line of MOCK_CALL_LINES) {
    const who = person(line.speaker);
    let track: TranscriptTrack;
    let speakerLabel: string | null;
    if (mixed) {
      track = 'mixed';
      speakerLabel = who.mixedLabel;
    } else if (who.key === 'owner') {
      track = 'mic';
      speakerLabel = null;
    } else {
      track = 'system';
      speakerLabel = who.systemLabel;
    }
    if (!tracks.includes(track)) continue;
    out.push({
      type: 'final',
      track,
      speakerLabel,
      startMs: line.startMs,
      endMs: line.endMs,
      text: line.text,
      confidence: 0.97,
    });
  }
  return out;
}

export interface StreamMockCallOptions {
  tracks: readonly TranscriptTrack[];
  /** Playback speed: 1 is real time, 20 plays the call twenty times faster. */
  speed?: number;
  /** Emit a partial (the first half of the words) before each final line. */
  partials?: boolean;
  /** Start this far into the call (a reconnect resumes where it left off). */
  fromMs?: number;
  signal?: AbortSignal;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Play the call in (scaled) real time: each line arrives when it would have
 * finished being said. Stops quietly when `signal` aborts.
 */
export async function* streamMockCall(
  options: StreamMockCallOptions,
): AsyncGenerator<TranscriptEvent, void, undefined> {
  const speed = options.speed && options.speed > 0 ? options.speed : 1;
  const fromMs = Math.max(0, options.fromMs ?? 0);
  let clock = fromMs;
  for (const event of mockTranscriptEvents(options.tracks)) {
    if (event.endMs <= fromMs) continue;
    if (options.partials) {
      const midway = Math.round((event.startMs + event.endMs) / 2);
      await wait((midway - clock) / speed, options.signal);
      if (options.signal?.aborted) return;
      clock = Math.max(clock, midway);
      const words = event.text.split(' ');
      yield {
        ...event,
        type: 'partial',
        text: words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(' '),
      };
    }
    await wait((event.endMs - clock) / speed, options.signal);
    if (options.signal?.aborted) return;
    clock = Math.max(clock, event.endMs);
    yield event;
  }
}
