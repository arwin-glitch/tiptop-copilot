import type { AppError } from '@/lib/util/result';

/**
 * Where one Studio talks to. Owners use the signed-in routes
 * (/api/events/[id]/…); an outside editor's Studio uses the scoped proxies
 * (/api/e/edit/[id]/…), which re-check the link on every request. The same
 * component runs on both; only these paths (and the capabilities) differ.
 * Plain strings, so the server page can hand them to the client; `:mid` is
 * replaced by a media id.
 */
export interface StudioEndpoints {
  draft: string;
  ops: string;
  sync: string;
  /** POST on pagehide: drop my presence row. */
  leave: string;
  /** Owners only. */
  activity: string | null;
  versions: string | null;
  publish: string | null;
  mediaUploadUrl: string | null;
  mediaProcess: string | null;
  mediaPatch: string | null;
  /** Outside editors only: "Ready for review". */
  review: string | null;
}

export function ownerEndpoints(eventId: string): StudioEndpoints {
  const base = `/api/events/${eventId}`;
  return {
    draft: `${base}/draft`,
    ops: `${base}/draft/ops`,
    sync: `${base}/draft/sync`,
    leave: `${base}/draft/sync`,
    activity: `${base}/draft/activity`,
    versions: `${base}/versions`,
    publish: `${base}/publish`,
    mediaUploadUrl: `${base}/media/upload-url`,
    mediaProcess: `${base}/media/:mid/process`,
    mediaPatch: `${base}/media/:mid`,
    review: null,
  };
}

export function outsiderEndpoints(eventId: string): StudioEndpoints {
  const base = `/api/e/edit/${eventId}`;
  return {
    draft: `${base}/draft`,
    ops: `${base}/ops`,
    sync: `${base}/sync`,
    leave: `${base}/sync`,
    activity: null,
    versions: null,
    publish: null,
    mediaUploadUrl: `${base}/media/upload-url`,
    mediaProcess: `${base}/media/:mid/process`,
    mediaPatch: `${base}/media/:mid`,
    review: `${base}/review`,
  };
}

export function withMediaId(template: string, mediaId: string): string {
  return template.replace(':mid', encodeURIComponent(mediaId));
}

export type StudioResponse<T> =
  | { ok: true; status: number; value: T }
  | { ok: false; status: number; error: AppError; offline: boolean };

/** JSON over fetch, never throwing: network failures come back as offline. */
export async function studioFetch<T>(
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<StudioResponse<T>> {
  const { json, ...rest } = init;
  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...rest,
      headers: {
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const body = (await response.json().catch(() => null)) as
      ({ ok: true } & T) | { ok: false; error: AppError } | null;
    if (response.ok && body && body.ok) {
      return { ok: true, status: response.status, value: body as T };
    }
    const error =
      body && !body.ok && body.error
        ? body.error
        : ({ code: 'internal', message: 'Something went wrong. Try again.' } as AppError);
    return { ok: false, status: response.status, error, offline: false };
  } catch {
    return {
      ok: false,
      status: 0,
      error: { code: 'provider_unavailable', message: 'You appear to be offline.' },
      offline: true,
    };
  }
}
