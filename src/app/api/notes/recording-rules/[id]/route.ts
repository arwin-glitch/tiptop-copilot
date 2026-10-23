import type { NextRequest } from 'next/server';
import { done, fail, notesGate, param, readBody } from '@/lib/notes/route-helpers';
import { UPDATE_RECORDING_RULE } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { deleteRecordingRule, updateRecordingRule } from '@/lib/services/notes-settings';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Rename a rule, or (admins) turn it off or change what it matches
 * (UpdateRecordingRuleRequest → RecordingRuleResponse). Built-in rules are fixed.
 */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, UPDATE_RECORDING_RULE);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const saved = await updateRecordingRule(
    { store: getStore(), auth: gate.auth },
    param(id),
    body.value,
  );
  return saved.ok ? done({ rule: saved.value }) : fail(saved.error);
}

/** Remove a rule (admins). */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  const removed = await deleteRecordingRule({ store: getStore(), auth: gate.auth }, param(id));
  return removed.ok ? done({}) : fail(removed.error);
}
