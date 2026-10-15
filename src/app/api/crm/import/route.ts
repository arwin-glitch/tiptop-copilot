import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authOrError, requireRole } from '@/lib/auth/session';
import { AFFINITY_IMPORT_LIMITS as LIMITS } from '@/lib/crm/affinity-csv';
import { getStore } from '@/lib/runtime';
import { rateLimit } from '@/lib/security/limits';
import { crmActor } from '@/lib/services/crm';
import { importAffinityList, importAffinityNotes } from '@/lib/services/crm-import';
import { importAffinityIntroductions } from '@/lib/services/introductions';
import { CRM_FIELD_TYPES } from '@/lib/types/domain';
import { statusForError, type AppError } from '@/lib/util/result';

export const dynamic = 'force-dynamic';

const fail = (error: AppError, status?: number) =>
  NextResponse.json(
    { ok: false, error },
    { status: status ?? statusForError(error.code), headers: { 'Cache-Control': 'no-store' } },
  );

const text = (max: number) => z.string().max(max).nullish();

const FIELD = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
  name: z.string().trim().min(1).max(200),
  type: z.enum(CRM_FIELD_TYPES),
  options: z.array(z.string().max(500)).max(LIMITS.options).optional(),
});

const LIST_BODY = z.object({
  kind: z.literal('list'),
  list: z.object({
    id: z.uuid().nullish(),
    name: z.string().trim().min(1).max(300),
    entityType: z.enum(['company', 'person', 'deal']),
    fields: z
      .array(FIELD)
      .max(LIMITS.fields)
      .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, {
        message: 'Field keys must be unique.',
      }),
    externalId: text(300),
  }),
  records: z
    .array(
      z.object({
        externalId: text(300),
        name: text(500),
        domain: text(500),
        emails: text(5000),
        primaryEmail: text(320),
      }),
    )
    .max(LIMITS.rowsPerRequest),
  entries: z
    .array(
      z.object({
        externalId: text(300),
        title: text(500),
        values: z.record(z.string().max(60), z.string().max(LIMITS.cellChars)).optional(),
        record: z
          .number()
          .int()
          .min(0)
          .max(LIMITS.rowsPerRequest - 1)
          .nullish(),
      }),
    )
    .max(LIMITS.rowsPerRequest),
});

const NOTES_BODY = z.object({
  kind: z.literal('notes'),
  notes: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(300),
        content: z.string().min(1).max(LIMITS.noteChars),
        author: text(300),
        occurredAt: z.iso.datetime().nullish(),
        entityNames: z.array(z.string().max(500)).max(LIMITS.namesPerNote).optional(),
      }),
    )
    .min(1)
    .max(LIMITS.rowsPerRequest),
});

const PARTY = z.object({
  kind: z.enum(['person', 'company']),
  name: text(500),
  email: text(320),
  domain: text(253),
  organization: z.object({ name: text(500), domain: text(253) }).nullish(),
});

const INTRODUCTIONS_BODY = z.object({
  kind: z.literal('introductions'),
  introductions: z
    .array(
      z.object({
        externalId: z.string().trim().min(1).max(300),
        section: z.enum(['made_by', 'made_to', 'source_people', 'source_orgs']),
        introducer: PARTY,
        introduced: z.array(PARTY).min(1).max(4),
        date: z.iso.date().nullish(),
        evidence: z.enum(['email', 'chat']).nullish(),
      }),
    )
    .min(1)
    .max(LIMITS.rowsPerRequest),
});

const BODY = z.discriminatedUnion('kind', [LIST_BODY, NOTES_BODY, INTRODUCTIONS_BODY]);

/** Past the page's own 2MB chunks, and short of the proxy's 10MB buffer, where bodies get cut. */
const MAX_BODY_BYTES = 8_000_000;

/**
 * Signed-in members only: one chunk of an Affinity CSV import, parsed and
 * mapped in the browser (Knowledge → Affinity import, `/knowledge?tab=import`).
 * Idempotent — the same chunk sent twice changes nothing the second time — so
 * the page can retry freely.
 */
export async function POST(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return fail(auth.error);
  const allowed = requireRole(auth.value, 'member');
  if (!allowed.ok) return fail(allowed.error);
  // Far above what an import of every list needs (one request per 200 rows),
  // far below what a runaway loop would send.
  const limited = rateLimit(`crm-import:${auth.value.userId}`, 300, 60_000);
  if (!limited.ok) return fail(limited.error);

  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) {
    return fail({
      code: 'too_large',
      message: 'That part of the import is too large. Reload the page and try again.',
    });
  }
  const parsed = BODY.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail({
      code: 'invalid_input',
      message: 'The import data was not in the expected shape. Reload the page and try again.',
      details: { issue: parsed.error.issues[0]?.path.join('.') ?? null },
    });
  }

  const store = getStore();
  const actor = crmActor(auth.value);
  const body = parsed.data;
  const result =
    body.kind === 'list'
      ? await importAffinityList(store, auth.value.organizationId, body, actor)
      : body.kind === 'notes'
        ? await importAffinityNotes(store, auth.value.organizationId, body, actor)
        : await importAffinityIntroductions(store, auth.value.organizationId, body, actor);
  if (!result.ok) return fail(result.error);
  return NextResponse.json(
    { ok: true, kind: body.kind, ...result.value },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
