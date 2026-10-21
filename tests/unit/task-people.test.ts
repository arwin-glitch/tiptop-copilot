import { describe, expect, it } from 'vitest';
import { personShort, taskPeople } from '@/lib/tasks/task-people';
import {
  matchesWho,
  readTasksView,
  readTasksWho,
  withTasksView,
  withTasksWho,
} from '@/lib/tasks/tasks-view';

/**
 * Who a task is for, and the `?who=` filter over To do and Money & legal.
 * Names come from people's own profiles; every one here is invented.
 */

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';

describe('taskPeople', () => {
  it('puts the owner first, then sorts by name, with first names to show', () => {
    const people = taskPeople([
      { id: B, fullName: 'Riley Moreno', email: 'riley@team.example', owner: false },
      { id: A, fullName: 'Avery Stone', email: 'avery@team.example', owner: true },
      { id: C, fullName: null, email: 'kit@team.example', owner: false },
    ]);
    expect(people.map((p) => [p.id, p.short, p.owner])).toEqual([
      [A, 'Avery', true],
      [C, 'Kit', false],
      [B, 'Riley', false],
    ]);
    expect(people.find((p) => p.id === C)?.name).toBe('Kit');
  });

  it('uses full names where two people share a first name', () => {
    const people = taskPeople([
      { id: A, fullName: 'Sam Park', email: null, owner: true },
      { id: B, fullName: 'Sam Lane', email: null, owner: false },
    ]);
    expect(people.map((p) => p.short)).toEqual(['Sam Park', 'Sam Lane']);
  });

  it('names nobody by an empty profile', () => {
    expect(taskPeople([{ id: A, fullName: ' ', email: null, owner: true }])[0]?.name).toBe(
      'Someone',
    );
  });

  it('finds a short name, or none for no one and for someone who left', () => {
    const people = taskPeople([{ id: A, fullName: 'Avery Stone', email: null, owner: true }]);
    expect(personShort(people, A)).toBe('Avery');
    expect(personShort(people, null)).toBeNull();
    expect(personShort(people, B)).toBeNull();
  });
});

describe('the Money & legal tab and the person filter in the URL', () => {
  it('opens Money & legal from ?view=money', () => {
    expect(readTasksView('money')).toBe('money');
    expect(withTasksView('who=none', 'money').toString()).toBe('who=none&view=money');
    expect(withTasksView('view=money', 'todo').toString()).toBe('');
  });

  it('reads ?who= as everyone, no one or one person, and nothing else', () => {
    expect(readTasksWho(null)).toBe('all');
    expect(readTasksWho('none')).toBe('none');
    expect(readTasksWho(A.toUpperCase())).toBe(A);
    expect(readTasksWho('robert; drop table')).toBe('all');
  });

  it('writes the person in, and everyone as the bare URL', () => {
    expect(withTasksWho('view=money', B).toString()).toBe(`view=money&who=${B}`);
    expect(withTasksWho(`view=money&who=${B}`, 'all').toString()).toBe('view=money');
  });

  it('matches tasks to the filter', () => {
    expect(matchesWho(A, 'all')).toBe(true);
    expect(matchesWho(null, 'all')).toBe(true);
    expect(matchesWho(A, A)).toBe(true);
    expect(matchesWho(B, A)).toBe(false);
    expect(matchesWho(null, 'none')).toBe(true);
    expect(matchesWho(A, 'none')).toBe(false);
  });
});
