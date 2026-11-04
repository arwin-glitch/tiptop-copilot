import { chipText } from '@/lib/email/label-tree';
import { cn } from '@/lib/util/cn';

/**
 * A label on a row or a conversation, in the label's Gmail colour when it has
 * one (Gmail's own pairs, hex only), Kraken's neutral chip otherwise.
 */
export function LabelChip({
  name,
  color,
  className,
}: {
  name: string;
  color: { bg: string; fg: string } | undefined;
  className?: string;
}) {
  return (
    <span
      title={name}
      className={cn(
        'rounded px-1.5 text-xs',
        color
          ? ''
          : 'border border-[var(--border)] bg-[var(--neutral-soft)] text-[var(--fg-muted)]',
        className,
      )}
      style={color ? { backgroundColor: color.bg, color: color.fg } : undefined}
    >
      {chipText(name)}
    </span>
  );
}
