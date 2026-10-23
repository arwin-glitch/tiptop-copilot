import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { ADD_ACTION_ITEM_TASK } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { addActionItemTask } from '@/lib/services/notes-generate';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * "Add to Tasks" (AddActionItemTaskRequest → AddActionItemTaskResponse):
 * through the tasks service, add-only, assigned to the principal.
 */
export async function POST(request: NextRequest, context: Context) {
  const gate = await notesGate(request, { bucket: 'write', max: 120, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, ADD_ACTION_ITEM_TASK);
  if (!body.ok) return body.response;
  const { id } = await context.params;
  const added = await addActionItemTask(
    { store: getStore(), auth: gate.auth },
    id,
    body.value.itemId,
  );
  return added.ok ? done({ ...added.value }) : fail(added.error);
}
