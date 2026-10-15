import type { NextRequest } from 'next/server';
import { isPrefetch } from '@/lib/campaigns/activity';
import { readTrackingToken } from '@/lib/campaigns/tokens';
import { NO_STORE, PIXEL_GIF } from '@/lib/campaigns/tracking-pages';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { recordOpen } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ token: string }> };

const gif = () =>
  new Response(new Uint8Array(PIXEL_GIF), {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Content-Length': String(PIXEL_GIF.length),
      ...NO_STORE,
    },
  });

/**
 * The open pixel in a campaign email. Public (no session), and always a
 * 1x1 gif whatever the token: an invalid one (or a test email's) is simply
 * not counted, a machine's load is kept but not counted (recordOpen), and
 * the response never says which.
 */
export async function GET(request: NextRequest, context: Context) {
  const { token } = await context.params;
  const target = readTrackingToken(token);
  if (target) {
    try {
      await recordOpen(getStore(), target, {
        userAgent: request.headers.get('user-agent'),
        prefetch: isPrefetch(request.headers),
      });
    } catch {
      log.warn('Campaign open could not be recorded', {});
    }
  }
  return gif();
}

/** A HEAD is a link checker: the same answer, nothing recorded. */
export async function HEAD() {
  return gif();
}
