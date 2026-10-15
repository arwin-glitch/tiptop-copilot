import { Fragment } from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { AFFINITY_LISTS_HREF, KNOWLEDGE_TABS } from '@/lib/records-tabs';

/**
 * The way back from a list or a record profile: Knowledge › Affinity lists,
 * then any steps in between (a record opened from a list names that list).
 * The lists moved under Knowledge, so this replaces the old "All lists" link.
 *
 * Links in a paragraph, not a list: tests count `main li` as a page's rows.
 * `dark` because it sits on the page header's green band, like the back link
 * on the follow-up session page.
 */
export function CrmBreadcrumb({ trail = [] }: { trail?: { label: string; href: string }[] }) {
  const steps = [
    { label: KNOWLEDGE_TABS.page, href: KNOWLEDGE_TABS.path },
    { label: 'Affinity lists', href: AFFINITY_LISTS_HREF },
    ...trail,
  ];
  return (
    <nav aria-label="Breadcrumb" className="dark mb-2">
      <p className="flex flex-wrap items-center gap-1 text-sm text-[var(--fg-muted)]">
        {steps.map((step, i) => (
          <Fragment key={step.href}>
            {i > 0 ? (
              <ChevronRight className="size-3.5 text-[var(--fg-subtle)]" aria-hidden="true" />
            ) : null}
            <Link href={step.href} className="hover:text-[var(--fg)] hover:underline">
              {step.label}
            </Link>
          </Fragment>
        ))}
      </p>
    </nav>
  );
}
