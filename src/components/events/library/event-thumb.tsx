import { HEX_COLOR_RE } from '@/lib/events/schema';
import { cn } from '@/lib/util/cn';

/**
 * An event's thumbnail on its library card: the published share card when
 * there is one, otherwise a live swatch drawn from the page's theme (its
 * background, accent and text colours, with the title set in the display
 * serif). Colours are used only when they are exact 6-digit hex values, so
 * nothing from a stored page reaches a style unchecked.
 */
export function EventThumb({
  title,
  ogImageUrl,
  swatch,
  className,
}: {
  title: string;
  ogImageUrl: string | null;
  swatch: { bg: string; accent: string; text: string } | null;
  className?: string;
}) {
  if (ogImageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a stored share card, already sized 1200×630
      <img
        src={ogImageUrl}
        alt=""
        loading="lazy"
        className={cn('aspect-[1200/630] w-full rounded-md object-cover', className)}
      />
    );
  }
  const hex = (value: string | undefined, fallback: string) =>
    value && HEX_COLOR_RE.test(value) ? value : fallback;
  const bg = hex(swatch?.bg, '#0E2720');
  const accent = hex(swatch?.accent, '#D4AF37');
  const text = hex(swatch?.text, '#F6F1E4');
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative flex aspect-[1200/630] w-full flex-col justify-end overflow-hidden rounded-md border border-[var(--border)] p-3',
        className,
      )}
      style={{ backgroundColor: bg, color: text }}
    >
      <span
        className="absolute top-3 left-3 h-[2px] w-10 rounded-full"
        style={{ backgroundColor: accent }}
      />
      <span className="line-clamp-2 font-serif text-base leading-tight font-semibold">{title}</span>
    </div>
  );
}
