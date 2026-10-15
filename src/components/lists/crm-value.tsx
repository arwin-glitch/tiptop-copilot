import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { formatCrmValue, statusTone } from '@/lib/crm/view';
import { httpUrl, websiteHref } from '@/lib/deals/links';
import type { CrmField, CrmValue } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

const EMAIL = /^[^\s@<>()"]+@[^\s@<>()"]+\.[a-z]{2,}$/i;

/**
 * One stored value, rendered for its field type. Imported values are
 * untrusted text: they render as text, and a URL or email only becomes a link
 * when it is rebuilt from a validated value (http(s) only, a plain hostname, a
 * plain address) — the same rule as every other stored link in the app.
 */
export function CrmValueView({
  field,
  value,
  timezone,
  className,
}: {
  field: Pick<CrmField, 'type'>;
  value: CrmValue | undefined;
  timezone: string;
  className?: string;
}) {
  const text = formatCrmValue(field, value, timezone);
  if (!text) {
    return (
      <span className={cn('text-[var(--fg-subtle)]', className)} aria-label="Empty">
        —
      </span>
    );
  }
  if (field.type === 'status' && typeof value === 'string') {
    return (
      <Badge tone={statusTone(value)} className={className}>
        {value}
      </Badge>
    );
  }
  if (field.type === 'url' && typeof value === 'string') {
    const href = httpUrl(value) ?? websiteHref(value);
    if (href) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={cn('text-[var(--accent)] underline-offset-2 hover:underline', className)}
        >
          {text}
        </a>
      );
    }
  }
  if (field.type === 'email' && typeof value === 'string' && EMAIL.test(value)) {
    return (
      <a
        href={`mailto:${value}`}
        className={cn('text-[var(--accent)] underline-offset-2 hover:underline', className)}
      >
        {text}
      </a>
    );
  }
  return (
    <span
      className={cn(
        (field.type === 'money' || field.type === 'number') && typeof value === 'number'
          ? 'tabular'
          : undefined,
        className,
      )}
    >
      {text}
    </span>
  );
}
