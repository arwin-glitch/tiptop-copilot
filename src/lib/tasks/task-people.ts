/**
 * The people a task can be assigned to, or confirmed by: the organization's
 * members, by the names on their own profiles. Nobody is named in code; the
 * labels come from whoever signed in.
 */

export interface TaskPerson {
  id: string;
  /** Full name, else the address's local part. */
  name: string;
  /** First name, or the full name when two people share one. */
  short: string;
  /** The organization's owner: whose confirmation a money or legal close asks for first. */
  owner: boolean;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** People from members and their profiles: the owner first, then by name. */
export function taskPeople(
  rows: readonly {
    id: string;
    fullName: string | null;
    email: string | null;
    owner: boolean;
  }[],
): TaskPerson[] {
  const named = rows.map((row) => {
    const name = row.fullName?.trim() || capitalised(row.email?.split('@')[0]?.trim() || 'Someone');
    return { id: row.id, name, first: name.split(/\s+/)[0] ?? name, owner: row.owner };
  });
  const firsts = new Map<string, number>();
  for (const p of named) firsts.set(p.first, (firsts.get(p.first) ?? 0) + 1);
  return named
    .map((p) => ({
      id: p.id,
      name: p.name,
      short: (firsts.get(p.first) ?? 0) > 1 ? p.name : p.first,
      owner: p.owner,
    }))
    .sort((a, b) => Number(b.owner) - Number(a.owner) || a.name.localeCompare(b.name));
}

/** The short name of `id` among `people`, or null for no one / someone who left. */
export function personShort(people: readonly TaskPerson[], id: string | null): string | null {
  if (!id) return null;
  return people.find((p) => p.id === id)?.short ?? null;
}
