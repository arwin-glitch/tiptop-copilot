import Link from 'next/link';
import { Building2 } from 'lucide-react';
import type { TaskCompany } from '@/lib/tasks/task-company';
import { cn } from '@/lib/util/cn';

/** The company a task is about, as a row shows it. */
export type TaskCompanyChip = TaskCompany;

const KIND_LABEL: Record<TaskCompanyChip['kind'], string> = {
  deal: 'Deal',
  portfolio: 'Portfolio company',
  crm: 'CRM company',
};

/**
 * A small, quiet chip after a task's title: "Send the data-room checklist
 * (Brightkiln)" becomes the title and a "Brightkiln" chip. Unlinked tasks show
 * none. No hooks, so server and client rows share it.
 */
export function CompanyChip({
  company,
  className,
}: {
  company: TaskCompanyChip | null | undefined;
  className?: string;
}) {
  if (!company) return null;
  const classes = cn(
    'ml-2 inline-flex max-w-[14rem] items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-sunken)] px-1.5 py-px align-[1px] text-[11px] font-medium text-[var(--fg-muted)]',
    company.href && 'hover:border-[var(--border-strong)] hover:text-[var(--fg)]',
    className,
  );
  const body = (
    <>
      <Building2 className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{company.name}</span>
    </>
  );
  const title = `${KIND_LABEL[company.kind]}: ${company.name}`;
  return company.href ? (
    <Link href={company.href} className={classes} title={title} data-company-chip="">
      {body}
    </Link>
  ) : (
    <span className={classes} title={title} data-company-chip="">
      {body}
    </span>
  );
}
