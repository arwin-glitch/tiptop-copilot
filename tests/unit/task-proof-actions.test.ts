import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The server actions the proof check and the company chip add: each signs
 * the caller in first and checks what the browser sent before any service
 * runs. The services are replaced; their own tests cover them. Every id here
 * is invented.
 */

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  confirmTaskProof: vi.fn(),
  setTaskCompany: vi.fn(),
  searchTaskCompanies: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  requireAuth: mocks.requireAuth,
}));
vi.mock('@/lib/services/task-proof', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/task-proof')>()),
  confirmTaskProof: mocks.confirmTaskProof,
}));
vi.mock('@/lib/services/task-company', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/task-company')>()),
  setTaskCompany: mocks.setTaskCompany,
  searchTaskCompanies: mocks.searchTaskCompanies,
}));

const { confirmTaskProofAction, searchTaskCompaniesAction, setTaskCompanyAction } =
  await import('@/app/actions');

const TASK = '0f0e0d0c-0b0a-4908-8706-050403020100';
const COMPANY = '11111111-2222-4333-8444-555555555555';
const AUTH = { userId: 'user-invented-2', organizationId: 'org-invented-2' };

beforeEach(() => {
  mocks.requireAuth.mockReset().mockResolvedValue(AUTH);
  mocks.confirmTaskProof.mockReset().mockResolvedValue({ ok: true, value: {} });
  mocks.setTaskCompany.mockReset().mockResolvedValue({ ok: true, value: null });
  mocks.searchTaskCompanies.mockReset().mockResolvedValue([]);
});

describe('the proof and company actions', () => {
  it('run nothing for a caller who is not signed in', async () => {
    mocks.requireAuth.mockRejectedValue(new Error('NEXT_REDIRECT'));
    await expect(confirmTaskProofAction(TASK)).rejects.toThrow('NEXT_REDIRECT');
    await expect(setTaskCompanyAction(TASK, null)).rejects.toThrow('NEXT_REDIRECT');
    await expect(searchTaskCompaniesAction('acme')).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.confirmTaskProof).not.toHaveBeenCalled();
    expect(mocks.setTaskCompany).not.toHaveBeenCalled();
    expect(mocks.searchTaskCompanies).not.toHaveBeenCalled();
  });

  it('refuse a task id that is not one', async () => {
    expect((await confirmTaskProofAction('task-1')).ok).toBe(false);
    expect((await setTaskCompanyAction('task-1', null)).ok).toBe(false);
    expect(mocks.confirmTaskProof).not.toHaveBeenCalled();
    expect(mocks.setTaskCompany).not.toHaveBeenCalled();
  });

  it('refuse a company choice of the wrong shape', async () => {
    const bad = [
      { kind: 'person', id: COMPANY },
      { kind: 'deal', id: 'acme' },
      { kind: 'crm' },
    ] as unknown as Parameters<typeof setTaskCompanyAction>[1][];
    for (const choice of bad) {
      expect((await setTaskCompanyAction(TASK, choice)).ok).toBe(false);
    }
    expect(mocks.setTaskCompany).not.toHaveBeenCalled();
  });

  it('pass a valid request to the service', async () => {
    expect((await confirmTaskProofAction(TASK)).ok).toBe(true);
    expect(mocks.confirmTaskProof).toHaveBeenCalledWith(AUTH, TASK);
    expect((await setTaskCompanyAction(TASK, { kind: 'crm', id: COMPANY })).ok).toBe(true);
    expect(mocks.setTaskCompany).toHaveBeenCalledWith(AUTH, TASK, { kind: 'crm', id: COMPANY });
    expect((await setTaskCompanyAction(TASK, null)).ok).toBe(true);
    expect(mocks.setTaskCompany).toHaveBeenLastCalledWith(AUTH, TASK, null);
  });

  it('searches only with text', async () => {
    expect(await searchTaskCompaniesAction(42 as unknown as string)).toEqual({
      ok: true,
      data: [],
    });
    expect(mocks.searchTaskCompanies).not.toHaveBeenCalled();
    await searchTaskCompaniesAction('acme');
    expect(mocks.searchTaskCompanies).toHaveBeenCalledWith(
      expect.anything(),
      AUTH.organizationId,
      'acme',
    );
  });

  it('passes a service refusal back', async () => {
    mocks.confirmTaskProof.mockResolvedValue({
      ok: false,
      error: { code: 'conflict', message: 'That task is open again.' },
    });
    expect(await confirmTaskProofAction(TASK)).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
  });
});
