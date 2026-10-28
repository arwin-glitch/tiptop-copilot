'use client';

import * as React from 'react';
import type { TemplateView } from '@/lib/types/notes';
import { Select } from '@/components/ui/form';
import { cn } from '@/lib/util/cn';

/**
 * Which template the notes follow: the five built-in VC templates, then the
 * team's own. "Automatic" leaves the choice to Kraken.
 */
export function TemplatePicker({
  templates,
  value,
  onChange,
  disabled,
  className,
  label = 'Template',
}: {
  templates: readonly TemplateView[];
  value: string | null;
  onChange: (templateId: string | null) => void;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const id = React.useId();
  const builtin = templates.filter((t) => t.isBuiltin);
  const custom = templates.filter((t) => !t.isBuiltin);
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <label htmlFor={id} className="text-xs font-medium whitespace-nowrap text-[var(--fg-muted)]">
        {label}
      </label>
      <Select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 min-w-0 text-[13px] sm:w-48"
        data-template-picker=""
      >
        <option value="">Automatic</option>
        <optgroup label="Built in">
          {builtin.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </optgroup>
        {custom.length > 0 ? (
          <optgroup label="Your templates">
            {custom.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </optgroup>
        ) : null}
      </Select>
    </div>
  );
}
