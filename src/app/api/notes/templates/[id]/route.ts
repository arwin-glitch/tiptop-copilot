import type { NextRequest } from 'next/server';
import { done, fail, notesGate, param, readBody } from '@/lib/notes/route-helpers';
import { UPDATE_TEMPLATE } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { archiveTemplate, updateTemplate } from '@/lib/services/notes-settings';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/** Edit a custom template (UpdateTemplateRequest → TemplateResponse). Built-in ones are fixed. */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, UPDATE_TEMPLATE);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const saved = await updateTemplate({ store: getStore(), auth: gate.auth }, param(id), body.value);
  return saved.ok ? done({ template: saved.value }) : fail(saved.error);
}

/** Remove a custom template from the picker (archived; notes written with it keep its id). */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const removed = await archiveTemplate({ store: getStore(), auth: gate.auth }, param(id));
  return removed.ok ? done({}) : fail(removed.error);
}
