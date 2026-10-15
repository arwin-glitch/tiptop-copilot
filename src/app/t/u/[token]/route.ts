import type { NextRequest } from 'next/server';
import { readTestTrackingToken, readTrackingToken } from '@/lib/campaigns/tokens';
import { invalidLinkPage, publicPage } from '@/lib/campaigns/tracking-pages';
import { escapeHtml } from '@/lib/campaigns/template';
import { getStore } from '@/lib/runtime';
import { describeUnsubscribe, unsubscribe } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ token: string }> };

const testPage = () =>
  publicPage(
    'Test email',
    '<h1>This was a test email</h1><p>The unsubscribe link works in the real emails. Nothing was changed.</p>',
  );

/** A test email's link: the literal "test" from older test sends, or a signed test token. */
const isTest = (token: string) => token === 'test' || readTestTrackingToken(token) !== null;

/**
 * The unsubscribe link in a campaign email. Public (no session). Opening it
 * changes nothing (mail scanners open links): it shows one button, and the
 * button (or a mail provider's one-click unsubscribe, RFC 8058) does it.
 */
export async function GET(_request: NextRequest, context: Context) {
  const { token } = await context.params;
  if (isTest(token)) return testPage();
  const target = readTrackingToken(token);
  if (!target) return invalidLinkPage();
  const who = await describeUnsubscribe(getStore(), target);
  if (!who.ok) return invalidLinkPage();
  if (who.value.already) {
    return publicPage(
      'Unsubscribed',
      `<h1>You are unsubscribed</h1><p>${escapeHtml(who.value.email)} will not get these emails again.</p>`,
    );
  }
  return publicPage(
    'Unsubscribe',
    `<h1>Unsubscribe from these emails?</h1>
<p>${escapeHtml(who.value.email)} will stop getting updates sent this way. Personal emails are not affected.</p>
<form method="post"><input type="hidden" name="confirm" value="1"><button type="submit">Unsubscribe</button></form>`,
  );
}

export async function POST(request: NextRequest, context: Context) {
  const { token } = await context.params;
  if (isTest(token)) return testPage();
  const target = readTrackingToken(token);
  if (!target) return invalidLinkPage();
  const result = await unsubscribe(getStore(), target, request.headers.get('user-agent'));
  if (!result.ok) return invalidLinkPage();
  return publicPage(
    'Unsubscribed',
    `<h1>You are unsubscribed</h1><p>${escapeHtml(result.value.email)} will not get these emails again.</p>`,
  );
}
