import { X } from 'lucide-react';
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
  onRemove,
}: {
  name: string;
  color: { bg: string; fg: string } | undefined;
  className?: string;
  /** Gmail's × on a label in an open conversation: takes the label off. */
  onRemove?: () => void;
}) {
  return (
    <span
      title={name}
      className={cn(
        'rounded px-1.5 text-xs',
        onRemove && 'inline-flex items-center gap-0.5 pr-0.5',
        color
          ? ''
          : 'border border-[var(--border)] bg-[var(--neutral-soft)] text-[var(--fg-muted)]',
        className,
      )}
      style={color ? { backgroundColor: color.bg, color: color.fg } : undefined}
    >
      {chipText(name)}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove label ${name}`}
          title="Remove this label"
          className="rounded-sm p-px opacity-70 hover:bg-black/10 hover:opacity-100"
        >
          <X className="size-3" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}
