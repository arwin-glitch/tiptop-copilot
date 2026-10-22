import type { NextRequest } from 'next/server';
import { eventsAuth, respond } from '@/lib/events/route-helpers';
import { getStore } from '@/lib/runtime';
import { absoluteUrl } from '@/lib/services/event-public';
import { personalLinks } from '@/lib/services/event-guests';

/**
 * GET /api/events/[id]/guests/[gid]/link — a guest's personal links (invite,
 * ticket, and the QR's check-in URL), for the drawer's "Copy personal link"
 * (owners: signed-in members who may write).
 * The link is the guest's credential: it is never shown on a list, only
 * fetched for one guest on demand. Rotating it is the bulk "Rotate links".
 */

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; gid: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const gate = await eventsAuth('guest-link', { max: 60 });
  if (!gate.ok) return gate.response;
  const { id, gid } = await context.params;
  const result = await personalLinks(getStore(), gate.owner.organizationId, id, gid);
  return respond(result, (links) => ({
    invite: links.invitePath ? absoluteUrl(links.invitePath) : null,
    ticket: links.ticketPath ? absoluteUrl(links.ticketPath) : null,
    checkin: absoluteUrl(links.checkinPath),
  }));
}
