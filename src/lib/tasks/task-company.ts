/**
 * The company a task is about, as the rows, the edit dialog and the server
 * share it. Pure: the stored side is lib/services/task-company.ts.
 */

export type TaskCompanyKind = 'deal' | 'portfolio' | 'crm';

export interface TaskCompany {
  kind: TaskCompanyKind;
  id: string;
  name: string;
  /** The company's page in the app; null when a CRM record has gone. */
  href: string | null;
}

/** One match in the edit dialog's company search. */
export interface TaskCompanyOption {
  kind: TaskCompanyKind;
  id: string;
  name: string;
  /** "Portfolio", "Deal · diligence", "CRM · acme.example". */
  sub: string;
}

export function taskCompanyHref(kind: TaskCompanyKind, id: string): string {
  if (kind === 'deal') return `/deals/${id}`;
  if (kind === 'portfolio') return `/portfolio/${id}`;
  return `/lists/records/${id}`;
}
