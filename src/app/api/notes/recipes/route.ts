import type { NextRequest } from 'next/server';
import { done, fail, notesGate, readBody } from '@/lib/notes/route-helpers';
import { CREATE_RECIPE } from '@/lib/notes/schemas';
import { getStore } from '@/lib/runtime';
import { createRecipe, listRecipes } from '@/lib/services/notes';

export const dynamic = 'force-dynamic';

/** Saved chat prompts (ListRecipesResponse). */
export async function GET(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'read', max: 240 });
  if (!gate.ok) return gate.response;
  const listed = await listRecipes({ store: getStore(), auth: gate.auth });
  return listed.ok ? done({ recipes: listed.value }) : fail(listed.error);
}

/** A saved prompt (CreateRecipeRequest). */
export async function POST(request: NextRequest) {
  const gate = await notesGate(request, { bucket: 'write', max: 60, write: true });
  if (!gate.ok) return gate.response;
  const body = await readBody(request, CREATE_RECIPE);
  if (!body.ok) return body.response;
  const made = await createRecipe({ store: getStore(), auth: gate.auth }, body.value);
  return made.ok ? done({ recipe: made.value }) : fail(made.error);
}
