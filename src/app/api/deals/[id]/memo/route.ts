import { NextResponse } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { getDealDetail, renderMemoMarkdown } from '@/lib/services/deals';
import { getStore } from '@/lib/runtime';
import { recordAudit } from '@/lib/security/audit';
import { sanitizeFilename } from '@/lib/util/text';
import { statusForError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

/** Markdown memo export. Authorization is re-checked here, not assumed. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authOrError();
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: statusForError(auth.error.code) },
    );
  }

  const { id } = await context.params;
  const detail = await getDealDetail(auth.value.organizationId, id);
  if (!detail) {
    return NextResponse.json(
      { ok: false, error: { code: 'not_found', message: 'That deal does not exist.' } },
      { status: 404 },
    );
  }

  const markdown = renderMemoMarkdown(detail);

  await recordAudit(getStore(), {
    organizationId: auth.value.organizationId,
    userId: auth.value.userId,
    action: 'deal.memo_exported',
    entityType: 'deal',
    entityId: id,
    metadata: { bytes: markdown.length, has_analysis: Boolean(detail.analysis) },
  });

  const filename = sanitizeFilename(`${detail.deal.company_name}-memo.md`);

  return new NextResponse(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
