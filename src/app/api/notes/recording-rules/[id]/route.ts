import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { UPDATE_RECORDING_RULE } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { deleteRecordingRule, updateRecordingRule } from '@/lib/services/notes-rules';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILT_IN = {
  code: 'forbidden' as const,
  message: 'The built-in rules cannot be changed. Add a rule of your own instead.',
};

/** Turn one of the team's rules on or off (UpdateRecordingRuleRequest → RecordingRuleResponse). */
export async function PATCH(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  if (!UUID.test(id)) return fail(BUILT_IN);
  const body = await readBody(request, UPDATE_RECORDING_RULE);
  if (!body.ok) return body.response;
  const saved = await updateRecordingRule(
    { store: getStore(), auth: gate.auth },
    id,
    body.value.enabled,
  );
  return saved.ok ? done({ rule: saved.value }) : fail(saved.error);
}

/** Delete one of the team's rules. */
export async function DELETE(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const { id } = await context.params;
  if (!UUID.test(id)) return fail(BUILT_IN);
  const removed = await deleteRecordingRule({ store: getStore(), auth: gate.auth }, id);
  return removed.ok ? done() : fail(removed.error);
}
