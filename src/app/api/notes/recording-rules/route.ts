import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { CREATE_RECORDING_RULE } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { createRecordingRule, listRecordingRules } from '@/lib/services/notes-rules';

export const dynamic = 'force-dynamic';

/** The never-record rules: the team's own, then the built-in defaults (ListRecordingRulesResponse). */
export async function GET(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  const listed = await listRecordingRules({ store: getStore(), auth: gate.auth });
  return listed.ok ? done({ rules: listed.value }) : fail(listed.error);
}

/** A rule of the team's own (CreateRecordingRuleRequest → RecordingRuleResponse). */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, CREATE_RECORDING_RULE);
  if (!body.ok) return body.response;
  const made = await createRecordingRule({ store: getStore(), auth: gate.auth }, body.value);
  return made.ok ? done({ rule: made.value }) : fail(made.error);
}
