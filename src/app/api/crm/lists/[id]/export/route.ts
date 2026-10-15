import { NextResponse, type NextRequest } from 'next/server';
import { authOrError, requireRole } from '@/lib/auth/session';
import { parseSavedViews } from '@/lib/crm/saved-views';
import { parseCrmListParams, resolveListParams } from '@/lib/crm/view';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { crmActor, getCrmList } from '@/lib/services/crm';
import { exportViewCsv } from '@/lib/services/crm-views';
import { statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const fail = (error: AppError) =>
  NextResponse.json(
    { ok: false, error },
    { status: statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );

/** Repeated params (`status`, `f`) as arrays, single ones as strings: the shape a page's searchParams has. */
function rawParams(search: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    out[key] = values.length > 1 ? values : (values[0] ?? '');
  }
  return out;
}

/**
 * "Export CSV" of the view on screen: the list page's own URL state (saved
 * view, search, status chips, conditions, sort, columns) applied to every
 * entry, not just the page showing. Members and above; audited, never logged.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const role = requireRole(auth.value, 'member');
  if (!role.ok) return fail(role.error);
  const limited = rateLimit(`crm-export:${auth.value.userId}`, 30, 60_000);
  if (!limited.ok) return fail(limited.error);

  const { id } = await context.params;
  const store = getStore();
  const org = auth.value.organizationId;
  const found = await getCrmList(store, org, id);
  if (!found.ok) return fail(found.error);
  const list = found.value;

  const views = parseSavedViews(list.views, list.fields);
  const { params, active } = resolveListParams(
    parseCrmListParams(rawParams(request.nextUrl.searchParams)),
    list.fields,
    views,
  );
  const result = await exportViewCsv(
    store,
    org,
    list.id,
    {
      query: params.q || null,
      statusIn: params.statuses,
      conditions: params.conditions,
      sortKey: params.sort || null,
      sortDir: params.dir,
      columns: params.columns,
      viewName: active?.name ?? null,
    },
    crmActor(auth.value),
  );
  if (!result.ok) return fail(result.error);

  return new NextResponse(result.value.csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.value.filename}"`,
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(result.value.rows),
      ...(result.value.complete ? {} : { 'X-Export-Truncated': 'true' }),
    },
  });
}
