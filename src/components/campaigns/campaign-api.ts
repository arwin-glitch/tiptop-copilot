/**
 * The campaign pages' JSON calls: the body on success, the server's own
 * message on failure (it is written to be shown), and a plain sentence when
 * the server could not be reached. The same contract as the composer's.
 */
export async function campaignCall<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const res = await fetch(url, init);
    const json = (await res.json().catch(() => null)) as
      (T & { error?: { message?: string } }) | null;
    if (!res.ok || !json) {
      return { ok: false, message: json?.error?.message ?? 'That did not work. Try again.' };
    }
    return { ok: true, data: json };
  } catch {
    return { ok: false, message: 'Could not reach Copilot. Check the connection and try again.' };
  }
}

export const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
