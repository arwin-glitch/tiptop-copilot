import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/util/cn';
import { RECOMMENDATION_LABELS, type Recommendation } from '@/lib/types/domain';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-[var(--border)] bg-[var(--neutral-soft)] text-[var(--fg-muted)]',
        ok: 'border-transparent bg-[var(--ok-soft)] text-[var(--ok)]',
        info: 'border-transparent bg-[var(--info-soft)] text-[var(--info)]',
        warn: 'border-transparent bg-[var(--warn-soft)] text-[var(--warn)]',
        danger: 'border-transparent bg-[var(--danger-soft)] text-[var(--danger)]',
        outline: 'border-[var(--border-strong)] bg-transparent text-[var(--fg-muted)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const RECOMMENDATION_TONE: Record<Recommendation, NonNullable<BadgeProps['tone']>> = {
  ADVANCE: 'ok',
  DIG_DEEPER: 'info',
  MONITOR: 'warn',
  PASS: 'danger',
  INSUFFICIENT_DATA: 'neutral',
};

export function RecommendationBadge({
  recommendation,
  className,
  size = 'md',
}: {
  recommendation: Recommendation;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <Badge
      tone={RECOMMENDATION_TONE[recommendation]}
      className={cn(
        'uppercase',
        size === 'lg' && 'px-3 py-1 text-xs',
        size === 'sm' && 'px-1.5 text-[10px]',
        className,
      )}
      aria-label={`Recommendation: ${RECOMMENDATION_LABELS[recommendation]}`}
    >
      {RECOMMENDATION_LABELS[recommendation]}
    </Badge>
  );
}

/**
 * Marks anything a model produced. Present on every generated surface —
 * outlook, analysis, drafts, chat answers — so provenance is never ambiguous.
 */
export function AiBadge({
  className,
  label = 'AI-generated',
}: {
  className?: string;
  label?: string;
}) {
  return (
    <Badge tone="outline" className={cn('gap-1', className)}>
      <span aria-hidden="true" className="text-[9px]">
        ✦
      </span>
      {label}
    </Badge>
  );
}

/** Fact / claim / inference provenance marker used in evidence lists. */
export function ProvenanceBadge({
  kind,
  className,
}: {
  kind:
    | 'fact'
    | 'founder_claim'
    | 'third_party_claim'
    | 'document'
    | 'inference'
    | 'model_inference'
    | 'nick_note'
    | 'human'
    | 'web'
    | 'unknown';
  className?: string;
}) {
  const map: Record<
    string,
    { label: string; tone: NonNullable<BadgeProps['tone']>; title: string }
  > = {
    fact: { label: 'Fact', tone: 'ok', title: 'Verified against a stored record.' },
    document: {
      label: 'Document',
      tone: 'info',
      title: 'Read out of an attached or uploaded document.',
    },
    founder_claim: {
      label: 'Founder claim',
      tone: 'warn',
      title: 'Asserted by the company. Not independently corroborated.',
    },
    third_party_claim: {
      label: 'Third party',
      tone: 'info',
      title: 'Asserted by someone outside the company.',
    },
    inference: {
      label: 'Inference',
      tone: 'neutral',
      title: 'Derived by the model from other stated facts.',
    },
    model_inference: {
      label: 'Inference',
      tone: 'neutral',
      title: 'Derived by the model from other stated facts.',
    },
    nick_note: { label: 'Your note', tone: 'outline', title: 'Written by you in this product.' },
    human: { label: 'Your entry', tone: 'outline', title: 'Entered or corrected by you.' },
    web: { label: 'Public web', tone: 'info', title: 'Retrieved from a public web page.' },
    unknown: { label: 'Unknown', tone: 'neutral', title: 'Provenance not recorded.' },
  };
  const entry = map[kind] ?? map.unknown!;
  return (
    <Badge tone={entry.tone} className={className} title={entry.title}>
      {entry.label}
    </Badge>
  );
}
