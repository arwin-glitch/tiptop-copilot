import type { NextRequest } from 'next/server';
import { isPrefetch } from '@/lib/campaigns/activity';
import { readTestTrackingToken, readTrackingToken } from '@/lib/campaigns/tokens';
import { NO_STORE, invalidLinkPage } from '@/lib/campaigns/tracking-pages';
import { getStore } from '@/lib/runtime';
import { recordClick, resolveTestClick } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ token: string }> };

const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { Location: location, ...NO_STORE } });

/**
 * A tracked link in a campaign email. Public (no session). Redirects only to
 * a link that was in that campaign's body when it was confirmed — checked
 * against the campaign's own allowlist, so this is never an open redirect —
 * and otherwise shows a plain "not valid" page. A HEAD request or a prefetch
 * (mail scanners checking links) is redirected the same but never counted as
 * the person's click; nor is a test email's link.
 */
async function follow(request: NextRequest, context: Context, head: boolean) {
  const { token } = await context.params;
  const url = request.nextUrl.searchParams.get('u') ?? '';
  if (!url || url.length > 2_000) return invalidLinkPage();
  const target = readTrackingToken(token);
  if (target) {
    const result = await recordClick(getStore(), target, url, {
      userAgent: request.headers.get('user-agent'),
      head,
      prefetch: isPrefetch(request.headers),
    });
    return result.ok ? redirect(result.value) : invalidLinkPage();
  }
  const test = readTestTrackingToken(token);
  if (test) {
    const result = await resolveTestClick(getStore(), test, url);
    return result.ok ? redirect(result.value) : invalidLinkPage();
  }
  return invalidLinkPage();
}

export async function GET(request: NextRequest, context: Context) {
  return follow(request, context, false);
}

export async function HEAD(request: NextRequest, context: Context) {
  return follow(request, context, true);
}
