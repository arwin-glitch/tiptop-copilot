import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { fetchBriefingHtml, prepareBriefingHtml } from '@/lib/briefing/html-relay';
import { getStore } from '@/lib/runtime';
import { statusForError } from '@/lib/util/result';
import type { RoutineBriefing } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';

const KINDS: RoutineBriefing['kind'][] = ['morning', 'afternoon', 'dossier'];

/**
 * The full briefing or dossier exactly as the routine published it, for the
 * signed-in organization. Falls back to the text PDF when no copy was relayed.
 *
 * The page is routine-written and quotes third-party email, so it is served
 * sandboxed (an opaque origin with no access to this app's cookies or pages)
 * and only the app's own Save-as-PDF script, carrying this response's nonce,
 * may run. The proxy leaves this path's CSP to this handler.
 */
export async function GET(_request: Request, context: { params: Promise<{ kind: string }> }) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const { kind } = await context.params;
  if (!KINDS.includes(kind as RoutineBriefing['kind'])) {
    return NextResponse.json(
      { ok: false, error: { code: 'not_found', message: 'No such briefing.' } },
      { status: 404 },
    );
  }
  const briefing = await getStore().findOne('routine_briefings', auth.value.organizationId, {
    eq: { kind },
  });
  if (!briefing) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'not_found', message: 'That briefing has not been posted yet.' },
      },
      { status: 404 },
    );
  }

  const html = await fetchBriefingHtml(briefing.kind, briefing.date_key);
  if (!html) {
    // Relative: behind Render's proxy request.url can carry an internal host.
    return new NextResponse(null, {
      status: 303,
      headers: { Location: `/api/briefings/${kind}/pdf`, 'Cache-Control': 'no-store' },
    });
  }

  const nonce = randomBytes(16).toString('base64');
  const csp = [
    'sandbox allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox',
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com data:',
    'img-src data: https:',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return new NextResponse(prepareBriefingHtml(html, nonce), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  });
}
