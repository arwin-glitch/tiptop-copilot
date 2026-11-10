/**
 * Voice Arwin hands the Inbox a half-written email: it opens the page, and
 * the Inbox picks this up once and fills the reply box or a compose window.
 * Nothing is saved or sent: the person reads it and clicks Send themselves.
 * Kept in this tab's sessionStorage for a minute, then ignored.
 */

const REPLY_KEY = 'kraken.voice.reply';
const COMPOSE_KEY = 'kraken.voice.compose';
const FRESH_MS = 60_000;

/** Rung after a hand-off, for an Inbox already open (no navigation to pick it up). */
export const VOICE_HANDOFF_EVENT = 'kraken:voice-handoff';

export function ringHandoff(): void {
  try {
    window.dispatchEvent(new Event(VOICE_HANDOFF_EVENT));
  } catch {
    // No window: nothing is listening anyway.
  }
}

export interface VoiceReply {
  threadId: string;
  text: string;
}

export interface VoiceCompose {
  to: string;
  subject: string;
  text: string;
}

function put(key: string, value: object): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify({ ...value, at: Date.now() }));
  } catch {
    // Private mode: the page still opens, the box just starts empty.
  }
}

function take<T>(key: string): (T & { at: number }) | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as T & { at: number };
    if (typeof value.at !== 'number' || Date.now() - value.at > FRESH_MS) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function drop(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear.
  }
}

export function handOffReply(reply: VoiceReply): void {
  put(REPLY_KEY, reply);
}

/** The reply waiting for this thread, taken once. */
export function takeReplyFor(threadId: string): VoiceReply | null {
  const value = take<VoiceReply>(REPLY_KEY);
  if (!value || value.threadId !== threadId) return null;
  drop(REPLY_KEY);
  return { threadId: value.threadId, text: typeof value.text === 'string' ? value.text : '' };
}

export function handOffCompose(compose: VoiceCompose): void {
  put(COMPOSE_KEY, compose);
}

/** The new email waiting for the Inbox, taken once. */
export function takeCompose(): VoiceCompose | null {
  const value = take<VoiceCompose>(COMPOSE_KEY);
  if (!value) return null;
  drop(COMPOSE_KEY);
  return {
    to: typeof value.to === 'string' ? value.to : '',
    subject: typeof value.subject === 'string' ? value.subject : '',
    text: typeof value.text === 'string' ? value.text : '',
  };
}
