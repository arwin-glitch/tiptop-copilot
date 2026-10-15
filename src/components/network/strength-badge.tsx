import { Badge } from '@/components/ui/badge';
import { STRENGTH_LABELS, type StrengthLabel } from '@/lib/network/strength';
import { cn } from '@/lib/util/cn';

/**
 * A relationship strength as a badge: green for Strong, gold for Warm, quiet
 * for Cold. The title carries the evidence it was counted from, so the number
 * is never on screen without its working. No 'use client': it renders in
 * server pages and inside client tables alike.
 */
export function StrengthBadge({
  label,
  score,
  summary,
  showScore = true,
  className,
}: {
  label: StrengthLabel;
  score: number;
  /** The evidence line, shown on hover and read by screen readers. */
  summary?: string;
  showScore?: boolean;
  className?: string;
}) {
  const text = STRENGTH_LABELS[label];
  return (
    <Badge
      tone={label === 'strong' ? 'jewel' : label === 'cold' ? 'info' : 'outline'}
      className={cn(
        'tabular',
        label === 'warm' && 'border-[var(--gold-rule)] text-[var(--label-gold)]',
        className,
      )}
      title={summary ? `${text} ${score}/100: ${summary}` : `${text} ${score}/100`}
      data-strength={label}
    >
      {text}
      {showScore && label !== 'none' ? <span aria-hidden="true">{score}</span> : null}
      <span className="sr-only">
        {label !== 'none' ? `, ${score} out of 100` : ''}
        {summary ? `. ${summary}` : ''}
      </span>
    </Badge>
  );
}
