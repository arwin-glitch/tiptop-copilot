import type { SttSession } from '@/lib/types/notes';

/**
 * Opening a vendor socket from an SttSession (D-076). Client-safe: the web
 * recorder calls these, so the vendor differences live in one place.
 *
 * Speechmatics: the socket address takes the temporary key as `?jwt=`, and
 * the first message on the open socket is the StartRecognition in
 * sessionConfig.startRecognition.
 * AssemblyAI: the socket address takes the temporary token as `?token=` and
 * every setting as a query parameter (sessionConfig.query); nothing is sent
 * on open.
 * Mock: no socket; the recorder plays lib/transcribe/mock-script.ts.
 */

export interface SpeechmaticsSessionConfig {
  startRecognition: Record<string, unknown>;
}

export interface AssemblyAISessionConfig {
  query: Record<string, string>;
}

export interface MockSessionConfig {
  script: string;
  track: string;
}

/** The address to open, with its credential, or null for the mock. */
export function socketUrlFor(session: SttSession): string | null {
  if (!session.wsUrl || session.provider === 'mock') return null;
  const url = new URL(session.wsUrl);
  if (session.provider === 'speechmatics') {
    url.searchParams.set('jwt', session.token);
  } else {
    const query = (session.sessionConfig as Partial<AssemblyAISessionConfig>).query ?? {};
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set('token', session.token);
  }
  return url.toString();
}

/** The first message to send once the socket is open, or null when there is none. */
export function openingMessageFor(session: SttSession): string | null {
  if (session.provider !== 'speechmatics') return null;
  const start = (session.sessionConfig as Partial<SpeechmaticsSessionConfig>).startRecognition;
  return start ? JSON.stringify(start) : null;
}

/**
 * Voice enrolment (D-076): the message that asks Speechmatics for the voice
 * identifiers of every voice it has heard so far. Send it on an enrolment
 * session (sessionConfig.enrollment) before EndOfStream, or on a live
 * meeting session when "Remember this voice" is asked for a consented
 * person. Only Speechmatics supports it.
 */
export function getSpeakersMessage(final = true): string {
  return JSON.stringify({ message: 'GetSpeakers', final });
}

/**
 * The identifiers of one vendor label from a SpeakersResult message, or null
 * when the message is something else. Keep only the label you asked about:
 * everyone else's identifiers are dropped here, in memory, and never sent on.
 */
export function speakerIdentifiersFor(message: unknown, label: string): string[] | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as { message?: unknown; speakers?: unknown };
  if (m.message !== 'SpeakersResult' || !Array.isArray(m.speakers)) return null;
  for (const s of m.speakers as { label?: unknown; speaker_identifiers?: unknown }[]) {
    if (s?.label !== label || !Array.isArray(s.speaker_identifiers)) continue;
    const ids = s.speaker_identifiers.filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    return ids.length ? ids : null;
  }
  return null;
}
