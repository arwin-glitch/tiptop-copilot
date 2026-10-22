import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { CREATE_FOLDER } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { createFolder, listFolders } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

/** Folders with their visible meeting counts (ListFoldersResponse). */
export async function GET(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  const listed = await listFolders({ store: getStore(), auth: gate.auth });
  return listed.ok ? done({ folders: listed.value }) : fail(listed.error);
}

/** A folder; a private one keeps its meetings private (CreateFolderRequest). */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, CREATE_FOLDER);
  if (!body.ok) return body.response;
  const made = await createFolder({ store: getStore(), auth: gate.auth }, body.value);
  return made.ok ? done({ folder: made.value }) : fail(made.error);
}
