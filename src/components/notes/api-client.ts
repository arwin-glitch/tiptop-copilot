import { NOTES_API } from '@/lib/notes/api';
import type { NotesAccessResponse } from '@/lib/types/notes';

/**
 * The Notes screens' calls to the /api/notes routes (D-076). Every answer is
 * `{ ok: true, ...body }` or a plain-words failure the screen can show as it
 * is; nothing here throws. Bodies and answers are typed in lib/types/notes.ts.
 */

export type NotesFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
};

export type NotesAnswer<T> = ({ ok: true } & T) | NotesFailure;

const OFFLINE: NotesFailure = {
  ok: false,
  code: 'provider_unavailable',
  message: 'Copilot could not be reached. Check the connection and try again.',
};

export async function notesCall<T extends object>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<NotesAnswer<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const json = (await res.json().catch(() => null)) as
      ({ ok?: boolean; error?: Partial<NotesFailure> } & Record<string, unknown>) | null;
    if (!json || json.ok !== true) {
      return {
        ok: false,
        code: json?.error?.code ?? (res.status === 404 ? 'not_found' : 'internal'),
        message: json?.error?.message ?? 'Something went wrong. Try again.',
        details: json?.error?.details,
      };
    }
    return json as { ok: true } & T;
  } catch {
    return OFFLINE;
  }
}

/* ------------------------------------------------------------ access == */

let accessCache: { at: number; value: Promise<boolean> } | null = null;
const ACCESS_TTL_MS = 60_000;

/**
 * Whether Copilot Notes is on for the person signed in. Asked once a minute
 * at most, so opening ten calendar cards costs one request. Off on any error:
 * a feature that cannot say it is on stays hidden.
 */
export function notesEnabled(now: number = Date.now()): Promise<boolean> {
  if (accessCache && now - accessCache.at < ACCESS_TTL_MS) return accessCache.value;
  const value = notesCall<Omit<NotesAccessResponse, 'ok'>>('GET', NOTES_API.beta).then((r) =>
    r.ok ? r.enabled : false,
  );
  accessCache = { at: now, value };
  return value;
}

/** Forget the cached answer (after the beta switch changes). */
export function resetNotesAccess(): void {
  accessCache = null;
}
