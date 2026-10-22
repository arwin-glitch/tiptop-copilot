import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { CREATE_TEMPLATE } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { createTemplate, listTemplates } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

/** Built-in and custom templates (ListTemplatesResponse). */
export async function GET(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  const listed = await listTemplates({ store: getStore(), auth: gate.auth });
  return listed.ok ? done({ templates: listed.value }) : fail(listed.error);
}

/** A custom template (CreateTemplateRequest → TemplateResponse). */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, CREATE_TEMPLATE);
  if (!body.ok) return body.response;
  const made = await createTemplate({ store: getStore(), auth: gate.auth }, body.value);
  return made.ok ? done({ template: made.value }) : fail(made.error);
}
