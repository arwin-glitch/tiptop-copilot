import type { CSSProperties, ReactNode } from 'react';
import type { EventSection, EventTheme } from '@/lib/events/schema';
import type { RenderContext } from './context';
import { EvMedia } from './media';

/**
 * One section's frame: its band (light/dark/accent/surface/media), padding,
 * width, alignment, divider and entrance. Every rule is a data attribute the
 * scoped CSS reads; nothing here takes a colour or size from text.
 *
 * DOM contract: data-section-id and data-block on the section root.
 */

export type Band = 'dark' | 'light' | 'surface' | 'alt' | 'accent' | null;

export function sectionBand(
  section: EventSection,
  heroTone: 'dark' | 'light' | null,
  isHero: boolean,
): Band {
  switch (section.style.background) {
    case 'surface':
      return 'surface';
    case 'alt':
      return 'alt';
    case 'accent':
      return 'accent';
    case 'dark':
      return 'dark';
    case 'light':
      return 'light';
    case 'image':
    case 'video':
      return 'dark';
    case 'inherit':
    default:
      return isHero ? heroTone : null;
  }
}

export function SectionShell({
  section,
  ctx,
  band,
  first,
  anchor,
  children,
  background,
  selected = false,
  textScrim = 0,
}: {
  selected?: boolean;
  /**
   * How strong a scrim of the band's own background sits behind the hero's
   * text (lib/events/theme/readability.ts heroTextScrim): 0 for none.
   */
  textScrim?: number;
  section: EventSection;
  ctx: RenderContext;
  band: Band;
  first: boolean;
  anchor: string;
  children: ReactNode;
  /** The hero's theme background layer, rendered behind the content. */
  background?: ReactNode;
}) {
  const theme: EventTheme = ctx.theme;
  const motion = section.motion.override ? section.motion : null;
  const entrance = motion ? motion.entrance : theme.motion.entrance;
  const divider =
    section.style.divider === 'inherit' ? theme.layout.divider : section.style.divider;
  const media =
    section.style.background === 'image' || section.style.background === 'video'
      ? section.style.backgroundMedia
      : null;
  return (
    <section
      id={anchor}
      className="ev-section"
      data-section-id={section.id}
      data-block={section.type}
      data-variant={section.variant}
      data-band={band ?? undefined}
      data-bg={section.style.background}
      data-pad={section.style.padding}
      data-align={section.style.align === 'inherit' ? undefined : section.style.align}
      data-width={section.style.width === 'inherit' ? undefined : section.style.width}
      data-divider={first ? undefined : divider}
      data-entrance={entrance}
      data-selected={selected ? 'true' : undefined}
      data-text-scrim={textScrim > 0 ? '' : undefined}
      style={
        textScrim > 0
          ? ({ '--ev-text-scrim': `${Math.round(textScrim * 100)}%` } as CSSProperties)
          : undefined
      }
    >
      {background}
      {media ? (
        <div className="ev-section__media" aria-hidden="true">
          <EvMedia ctx={ctx} media={media} sizes="100vw" />
          <div className="ev-section__scrim" />
        </div>
      ) : null}
      {!first && divider !== 'none' ? <Divider kind={divider} /> : null}
      <div className="ev-section__inner">{children}</div>
    </section>
  );
}

export function Divider({ kind }: { kind: EventTheme['layout']['divider'] }) {
  if (kind === 'hairline')
    return <div className="ev-divider ev-divider--hairline" aria-hidden="true" />;
  if (kind === 'ornament') {
    return (
      <div className="ev-divider ev-divider--ornament" aria-hidden="true">
        <svg viewBox="0 0 120 16" width="120" height="16">
          <path d="M0 8 H44 M76 8 H120" stroke="currentColor" strokeWidth="1" />
          <path d="M60 2 L66 8 L60 14 L54 8 Z" fill="currentColor" />
          <circle cx="48" cy="8" r="1.6" fill="currentColor" />
          <circle cx="72" cy="8" r="1.6" fill="currentColor" />
        </svg>
      </div>
    );
  }
  if (kind === 'wave') {
    return (
      <div className="ev-divider ev-divider--wave" aria-hidden="true">
        <svg viewBox="0 0 240 12" width="240" height="12" preserveAspectRatio="none">
          <path
            d="M0 6 Q 10 0 20 6 T 40 6 T 60 6 T 80 6 T 100 6 T 120 6 T 140 6 T 160 6 T 180 6 T 200 6 T 220 6 T 240 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      </div>
    );
  }
  if (kind === 'deco') {
    return (
      <div className="ev-divider ev-divider--deco" aria-hidden="true">
        <svg viewBox="0 0 200 20" width="200" height="20">
          <path d="M0 10 H70 M130 10 H200" stroke="currentColor" strokeWidth="1" />
          <path
            d="M70 10 L80 4 L90 10 L100 2 L110 10 L120 4 L130 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
          />
          <path d="M80 14 H120" stroke="currentColor" strokeWidth="1" />
        </svg>
      </div>
    );
  }
  return null;
}
