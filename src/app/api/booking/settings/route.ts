import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/session';
import { calendarAuth, done, fail } from '@/lib/calendar/route-auth';
import { getStore } from '@/lib/runtime';
import { saveBookingSettings } from '@/lib/services/booking';
import { patchBookingSettings } from '@/lib/services/booking-planner';

export const dynamic = 'force-dynamic';

const BODY = z
  .object({
    enabled: z.boolean(),
    slug: z.string().max(60),
    // Checked field by field in the service (BOOKING_CONFIG_SCHEMA), which says which one is wrong.
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

/**
 * Save Settings > Booking link: on or off, the link's name, and the rest of
 * its settings. Signed in, an admin or the owner, from Copilot's own pages.
 */
export async function PUT(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-settings', max: 30, write: true });
  if (!gate.ok) return gate.response;
  const admin = requireRole(gate.auth, 'admin');
  if (!admin.ok) return fail(admin.error);
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Check the settings.' });
  const saved = await saveBookingSettings(
    getStore(),
    gate.auth.organizationId,
    gate.auth.userId,
    parsed.data as never,
  );
  if (!saved.ok) return fail(saved.error);
  return done({ settings: saved.value });
}

const PATCH_BODY = z
  .object({
    enabled: z.boolean().optional(),
    slug: z.string().max(60).optional(),
    // Only the Booking tab's own fields are taken (PANEL_KEYS); the rest stay as stored.
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Save one Booking tab panel (D-078): only the fields it sends change, on top
 * of what is stored, so the planner, the profile and the chatbot never undo
 * each other. Signed in, an admin or the owner, from Copilot's own pages.
 */
export async function PATCH(request: NextRequest) {
  const gate = await calendarAuth(request, { bucket: 'booking-settings', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const admin = requireRole(gate.auth, 'admin');
  if (!admin.ok) return fail(admin.error);
  const parsed = PATCH_BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail({ code: 'invalid_input', message: 'Check the settings.' });
  const saved = await patchBookingSettings(
    getStore(),
    gate.auth.organizationId,
    gate.auth.userId,
    parsed.data,
  );
  if (!saved.ok) return fail(saved.error);
  return done({ settings: saved.value });
}
