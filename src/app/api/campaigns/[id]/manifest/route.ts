import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { describeManifest, manifestTable } from '@/lib/campaigns/manifest';
import { done, fail } from '@/lib/campaigns/route-helpers';
import { toCsv } from '@/lib/crm/saved-views';
import { getStore } from '@/lib/runtime';
import { campaignManifest } from '@/lib/services/campaigns';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * "Who gets what": every pending recipient's email as it would go out (To,
 * photo, shared attachments, CC, BCC) with any problem, for the review
 * screen; `?format=csv` downloads the same as a spreadsheet. Reads only, and
 * names the campaign version it read so the page can tell it from a review
 * taken at another moment.
 */
export async function GET(request: NextRequest, context: Context) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const { id } = await context.params;
  const result = await campaignManifest(getStore(), auth.value.organizationId, id);
  if (!result.ok) return fail(result.error);
  const { check, ...rest } = result.value;

  if (request.nextUrl.searchParams.get('format') === 'csv') {
    return new NextResponse(toCsv(manifestTable(check.rows, rest.extras)), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="who-gets-what.csv"',
        'Cache-Control': 'no-store',
      },
    });
  }
  return done({
    manifest: {
      ...rest,
      summary: check.summary,
      line: describeManifest(check.summary),
      issues: check.issues,
      warnings: check.warnings,
      rows: check.rows,
    },
  });
}
