import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { renderBriefingPdf } from '@/lib/briefing/pdf';
import { getStore } from '@/lib/runtime';
import { log } from '@/lib/security/redact';
import { sanitizeFilename } from '@/lib/util/text';
import { statusForError } from '@/lib/util/result';
import type { RoutineBriefing } from '@/lib/types/domain';

export const dynamic = 'force-dynamic';

const KINDS: RoutineBriefing['kind'][] = ['morning', 'afternoon', 'dossier'];

/**
 * The Today card's full briefing or dossier as a PDF, for the signed-in
 * organization only. The artifact the routine published is private to
 * Arwin's claude.ai account, so this is what the app links instead.
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

  try {
    const pdf = await renderBriefingPdf(briefing, { timeZone: auth.value.profile.timezone });
    const filename = sanitizeFilename(`${briefing.title} ${briefing.date_key}.pdf`);
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        // inline: opens in the browser's viewer; the name is used if it is saved.
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    log.warn('Briefing PDF failed', {
      kind,
      reason: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
    return NextResponse.json(
      { ok: false, error: { code: 'internal', message: 'The PDF could not be built.' } },
      { status: 500 },
    );
  }
}
