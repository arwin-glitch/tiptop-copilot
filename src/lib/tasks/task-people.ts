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
  /**
   * The organization's principal (lib/tasks/principal.ts): whose mailbox the
   * app reads, so whose work its tasks are. Listed first, and whose
   * confirmation a money or legal close asks for first.
   */
  principal: boolean;
}

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** People from members and their profiles: the principal first, then by name. */
export function taskPeople(
  rows: readonly {
    id: string;
    fullName: string | null;
    email: string | null;
    principal: boolean;
  }[],
): TaskPerson[] {
  const named = rows.map((row) => {
    const name = row.fullName?.trim() || capitalised(row.email?.split('@')[0]?.trim() || 'Someone');
    return { id: row.id, name, first: name.split(/\s+/)[0] ?? name, principal: row.principal };
  });
  const firsts = new Map<string, number>();
  for (const p of named) firsts.set(p.first, (firsts.get(p.first) ?? 0) + 1);
  return named
    .map((p) => ({
      id: p.id,
      name: p.name,
      short: (firsts.get(p.first) ?? 0) > 1 ? p.name : p.first,
      principal: p.principal,
    }))
    .sort((a, b) => Number(b.principal) - Number(a.principal) || a.name.localeCompare(b.name));
}

/** The short name of `id` among `people`, or null for no one / someone who left. */
export function personShort(people: readonly TaskPerson[], id: string | null): string | null {
  if (!id) return null;
  return people.find((p) => p.id === id)?.short ?? null;
}

/**
 * The name a task row shows for its assignee: only when there is more than
 * one person to tell apart, and never for the principal, whose tasks are the
 * list's default. An unassigned task says "No one", as the row's menu does,
 * so a row without a name is the principal's. Null as well for someone who
 * has left, who cannot be named.
 */
export function assigneeChip(people: readonly TaskPerson[], id: string | null): string | null {
  if (people.length < 2) return null;
  if (!id) return 'No one';
  const person = people.find((p) => p.id === id);
  return person && !person.principal ? person.short : null;
}

/** Who a money or legal close is confirmed by unless someone else is chosen: the principal. */
export function defaultConfirmer(people: readonly TaskPerson[]): string {
  return people.find((p) => p.principal)?.id ?? people[0]?.id ?? '';
}
