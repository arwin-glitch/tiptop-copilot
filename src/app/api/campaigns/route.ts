import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { campaignAuth, fail, respond } from '@/lib/campaigns/route-helpers';
import { getStore } from '@/lib/runtime';
import { createCampaign } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

const BODY = z.object({ name: z.string().max(300).nullish() });

/** Start a draft campaign. Nothing is sent from a draft. */
export async function POST(request: NextRequest) {
  const gate = await campaignAuth('edit');
  if (!gate.ok) return gate.response;
  const parsed = BODY.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Give the campaign a name.' });
  const created = await createCampaign(
    getStore(),
    gate.auth.organizationId,
    { userId: gate.auth.userId },
    { name: parsed.data.name, timeZone: gate.auth.profile.timezone },
  );
  return respond(created, (c) => ({ id: c.id }));
}
