import * as React from 'react';
import Link from 'next/link';
import { CircleDashed } from 'lucide-react';
import { cn } from '@/lib/util/cn';
import { Button } from './button';

/**
 * The "this capability is switched off" surface.
 *
 * This is not an edge case in this product. `ANTHROPIC_API_KEY` is unset by
 * choice and `RESEARCH_PROVIDER` is `none`, so on the live deployment this is
 * the *primary* state of the outlook, of Ask, and of every scorecard. It gets
 * a designed component rather than a toast for that reason.
 *
 * Three rules it enforces, which are the difference between an off switch and
 * a broken screen:
 *
 * - It says what still works. A dead panel with no context reads as a total
 *   outage; almost always the surrounding page is fine and only this one
 *   derived surface is unavailable.
 * - It is not an error. No `role="alert"`, no red. Nothing has gone wrong —
 *   a decision was made and this is the honest consequence of it.
 * - It offers the next useful step, which is nearly always `/diagnostics`,
 *   the screen that reports exactly which variable is missing.
 */
export function NotConfigured({
  title,
  description,
  stillWorks,
  action = { label: 'See what is configured', href: '/diagnostics' },
  variant = 'panel',
  className,
}: {
  title: string;
  /** What is unavailable and why. Plain language, no variable names. */
  description: string;
  /** What the user can still do on this screen. Omit only if truly nothing. */
  stillWorks?: string;
  action?: { label: string; href: string } | null;
  variant?: 'panel' | 'inline';
  className?: string;
}) {
  if (variant === 'inline') {
    return (
      <p className={cn('flex items-start gap-2 text-sm text-[var(--fg-muted)]', className)}>
        <CircleDashed
          className="mt-0.5 size-3.5 shrink-0 text-[var(--fg-subtle)]"
          aria-hidden="true"
        />
        <span className="min-w-0">
          <span className="font-medium text-[var(--fg)]">{title}</span> {description}
          {action ? (
            <>
              {' '}
              <Link
                href={action.href}
                className="text-[var(--accent)] underline-offset-2 hover:underline"
              >
                {action.label}
              </Link>
              .
            </>
          ) : null}
        </span>
      </p>
    );
  }

  return (
    <div
      className={cn(
        // Dashed, sunken and unshadowed: it reads as a space held open rather
        // than a card with nothing in it.
        'rounded-[var(--radius-card)] border border-dashed border-[var(--border-strong)] bg-[var(--bg-sunken)] px-[var(--gutter)] py-5',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <CircleDashed
          className="mt-0.5 size-4 shrink-0 text-[var(--fg-subtle)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-title font-serif font-semibold">{title}</p>
          <p className="mt-1.5 max-w-prose text-sm text-[var(--fg-muted)]">{description}</p>
          {stillWorks ? (
            <p className="mt-2 max-w-prose text-sm text-[var(--fg-muted)]">
              <span className="font-medium text-[var(--fg)]">Still available: </span>
              {stillWorks}
            </p>
          ) : null}
          {action ? (
            <Button asChild size="sm" variant="secondary" className="mt-4">
              <Link href={action.href}>{action.label}</Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The specific case that covers most of the app: no API key, so nothing
 * model-derived can be produced. Wording is shared so five screens do not
 * invent five different explanations of the same switch.
 */
export function AiNotConfigured({
  what,
  stillWorks,
  variant = 'panel',
  className,
}: {
  /** What would have been here, e.g. "The daily outlook". */
  what: string;
  stillWorks?: string;
  variant?: 'panel' | 'inline';
  className?: string;
}) {
  return (
    <NotConfigured
      variant={variant}
      className={className}
      title={`${what} is unavailable`}
      description="No AI provider is connected, so nothing is generated rather than guessed. Everything on this page that comes straight from your records is unaffected."
      stillWorks={stillWorks}
    />
  );
}
