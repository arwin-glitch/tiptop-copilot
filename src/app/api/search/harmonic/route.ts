import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { harmonicLookup, harmonicQuota } from '@/lib/integrations/harmonic-mcp';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * Starts a Harmonic look-up ahead of the click: Ctrl+K calls it when its
 * "Search Harmonic" row is highlighted. The answer is kept a day and shared
 * with /network/harmonic, so the page opens on a ready answer. Signed-in
 * members only; a few per minute, as each spends one of the day's free
 * look-ups. Returns only how many matched.
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }
  const limited = rateLimit(`harmonic-warm:${auth.value.userId}`, 6, 60_000);
  if (!limited.ok) return NextResponse.json({ ok: false }, { status: 429 });
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 200);
  if (q.length < 2) return NextResponse.json({ ok: false }, { status: 400 });
  const res = await harmonicLookup(getStore(), auth.value.organizationId, q);
  return NextResponse.json(
    { ok: res.ok, count: res.ok ? res.value.length : 0 },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Harmonic results inside Ctrl+K: `?q=` (2–200 characters). Signed-in members
 * only, a few per minute per person. A cached answer is free; a new one spends
 * one of the organization's daily look-ups, and once Kraken's own daily cap is
 * reached nothing is sent to Harmonic. Answers
 * `{ ok, hits, remaining, code?, connected? }` — `code` is the error code when
 * not ok (`not_configured` with `connected: false` when Harmonic is not
 * connected, `rate_limited` when the day's look-ups are used up).
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code), headers: NO_STORE },
    );
  }
  const org = auth.value.organizationId;
  const limited = rateLimit(`harmonic-search:${auth.value.userId}`, 10, 60_000);
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, hits: [], remaining: harmonicQuota(org).remaining, code: 'rate_limited' },
      { status: 429, headers: NO_STORE },
    );
  }
  const q = (request.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length < 2 || q.length > 200) {
    return NextResponse.json(
      { ok: false, hits: [], remaining: harmonicQuota(org).remaining, code: 'invalid_input' },
      { status: 400, headers: NO_STORE },
    );
  }
  const res = await harmonicLookup(getStore(), org, q);
  const remaining = harmonicQuota(org).remaining;
  if (!res.ok) {
    return NextResponse.json(
      {
        ok: false,
        hits: [],
        remaining,
        code: res.error.code,
        ...(res.error.code === 'not_configured' ? { connected: false } : {}),
      },
      { headers: NO_STORE },
    );
  }
  return NextResponse.json({ ok: true, hits: res.value, remaining }, { headers: NO_STORE });
}
