import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The task server actions added with task basics and money and legal tasks:
 * each signs the caller in first and checks what the browser sent before any
 * service runs. The services are replaced; their own tests cover them. Every
 * id here is invented.
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  editTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  snoozeTask: vi.fn(),
  assignTask: vi.fn(),
  setMoneyLegal: vi.fn(),
  completeTaskWithProof: vi.fn(),
  dismissNeedsProof: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireAuth: mocks.requireAuth,
}));
vi.mock('@/lib/services/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/tasks')>()),
  editTask: mocks.editTask,
  updateTaskStatus: mocks.updateTaskStatus,
  snoozeTask: mocks.snoozeTask,
  assignTask: mocks.assignTask,
}));
vi.mock('@/lib/services/money-legal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/money-legal')>()),
  setMoneyLegal: mocks.setMoneyLegal,
  completeTaskWithProof: mocks.completeTaskWithProof,
  dismissNeedsProof: mocks.dismissNeedsProof,
}));

const {
  assignTaskAction,
  completeTaskWithProofAction,
  deleteTaskAction,
  dismissNeedsProofAction,
  editTaskAction,
  setMoneyLegalAction,
  snoozeTaskUntilAction,
} = await import('@/app/actions');

const TASK = '0f0e0d0c-0b0a-4908-8706-050403020100';
const PERSON = '11111111-2222-4333-8444-555555555555';
const AUTH = { userId: 'user-invented-1', organizationId: 'org-invented-1' };
const DAY = 86_400_000;

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue(AUTH);
  for (const fn of [
    mocks.editTask,
    mocks.updateTaskStatus,
    mocks.snoozeTask,
    mocks.assignTask,
    mocks.setMoneyLegal,
    mocks.completeTaskWithProof,
    mocks.dismissNeedsProof,
  ]) {
    fn.mockReset().mockResolvedValue({ ok: true, value: {} });
  }
});

describe('the task actions', () => {
  it('run nothing for a caller who is not signed in', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(deleteTaskAction(TASK)).rejects.toThrow('NEXT_REDIRECT');
    await expect(
      editTaskAction(TASK, { title: 'ZZ x', detail: null, dueAt: null }),
    ).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.updateTaskStatus).not.toHaveBeenCalled();
    expect(mocks.editTask).not.toHaveBeenCalled();
  });

  it('refuse a task id that is not an id, before any service', async () => {
    const results = await Promise.all([
      editTaskAction('../tasks', { title: 'ZZ x', detail: null, dueAt: null }),
      deleteTaskAction('1 or 1=1'),
      snoozeTaskUntilAction('nope', new Date(Date.now() + DAY).toISOString()),
      assignTaskAction('nope', PERSON),
      setMoneyLegalAction('nope', true),
      completeTaskWithProofAction('nope', {
        kind: 'confirmed',
        confirmedBy: PERSON,
        note: undefined,
      }),
      dismissNeedsProofAction('nope'),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('invalid_input');
    }
    for (const fn of Object.values(mocks)) {
      if (fn !== mocks.requireAuth) expect(fn).not.toHaveBeenCalled();
    }
  });

  it('refuse an edit of the wrong shape', async () => {
    const bad = await editTaskAction(TASK, {
      title: 42,
      detail: null,
      dueAt: null,
    } as unknown as { title: string; detail: null; dueAt: null });
    expect(bad.ok).toBe(false);
    expect(mocks.editTask).not.toHaveBeenCalled();
  });

  it('delete by cancelling, so Undo can put the task back', async () => {
    expect((await deleteTaskAction(TASK)).ok).toBe(true);
    expect(mocks.updateTaskStatus).toHaveBeenCalledWith(AUTH, TASK, 'cancelled');
  });

  it('snooze only to a time after now and within the year', async () => {
    const past = await snoozeTaskUntilAction(TASK, new Date(Date.now() - 60_000).toISOString());
    expect(past.error?.message).toBe('Pick a date after today.');
    const far = await snoozeTaskUntilAction(TASK, new Date(Date.now() + 500 * DAY).toISOString());
    expect(far.error?.message).toBe('Pick a date within the next year.');
    expect((await snoozeTaskUntilAction(TASK, 'not a date')).ok).toBe(false);
    expect(mocks.snoozeTask).not.toHaveBeenCalled();

    const until = new Date(Date.now() + 10 * DAY).toISOString();
    expect((await snoozeTaskUntilAction(TASK, until)).ok).toBe(true);
    expect(mocks.snoozeTask).toHaveBeenCalledWith(AUTH, TASK, until);
  });

  it('assign to a person id or to no one, nothing else', async () => {
    expect((await assignTaskAction(TASK, null)).ok).toBe(true);
    expect(mocks.assignTask).toHaveBeenLastCalledWith(AUTH, TASK, null);
    expect((await assignTaskAction(TASK, PERSON)).ok).toBe(true);
    expect((await assignTaskAction(TASK, 'riley')).ok).toBe(false);
    expect(mocks.assignTask).toHaveBeenCalledTimes(2);
  });

  it('take a money and legal toggle only as true or false', async () => {
    expect((await setMoneyLegalAction(TASK, 'yes' as unknown as boolean)).ok).toBe(false);
    expect(mocks.setMoneyLegal).not.toHaveBeenCalled();
    expect((await setMoneyLegalAction(TASK, false)).ok).toBe(true);
    expect(mocks.setMoneyLegal).toHaveBeenCalledWith(AUTH, TASK, false);
  });

  it("pass a service's refusal back, code and all", async () => {
    mocks.completeTaskWithProof.mockResolvedValue({
      ok: false,
      error: { code: 'invalid_input', message: 'Use a web link (https://…).' },
    });
    const result = await completeTaskWithProofAction(TASK, {
      kind: 'link',
      url: 'ftp://files.example.com/x',
      note: undefined,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'Use a web link (https://…).',
        stillUsable: undefined,
      },
    });
  });
});
