import type { CSSProperties } from 'react';
import { FONT_LIBRARY } from '@/lib/events/fonts';
import type { EventPageProps } from '@/lib/events/contracts';
import { orderedSections, type EventSection, type EventTheme } from '@/lib/events/schema';
import { mergePlainText } from '@/lib/events/richtext';
import { hexToRgb } from '@/lib/events/theme/color';
import { forcesFullMotion, hasLoopingMotion, motionLevel } from '@/lib/events/theme/motion';
import { heroTextScrim } from '@/lib/events/theme/readability';
import { primaryPalette, themeAttributes, themeVars } from '@/lib/events/theme/tokens';
import { BackgroundLayer, backgroundTone } from '@/components/events/effects/background-layer';
import { FinishLayer } from '@/components/events/effects/finish-layer';
import { IntroGate, type EnvelopeView } from '@/components/events/effects/intro-gate';
import { OverlayLayer } from '@/components/events/effects/overlay-layer';
import { PauseMotion } from '@/components/events/effects/pause-motion';
import { RevealObserver } from '@/components/events/effects/reveal-observer';
import { RsvpMoments } from '@/components/events/effects/rsvp-moments';
import { BlockView } from './blocks';
import { RsvpDock } from './blocks/info';
import { initials } from './blocks/shared';
import type { RenderContext } from './context';
import { formatShortDate, venueCity } from './format';
import { resolveMediaRef } from './media';
import { FontPreload } from './font-preload';
import { SectionShell, sectionBand } from './section-shell';
import './event-fonts.css';
import './event.css';
import './event-effects.css';
import './event-blocks.css';

/**
 * The guest renderer (D-075, WS2). Export kept from the contract:
 * `EventPage` (props: EventPageProps in lib/events/contracts.ts).
 *
 * Isomorphic and synchronous: the public route renders it as a server
 * component; Studio renders the same component inside its client canvas.
 * Effects are lazily loaded client islands (one WebGL canvas per page at
 * most, DPR ≤ 1.5, paused offscreen and on hidden tabs, poster frames when
 * WebGL is missing or motion is reduced).
 *
 * It renders what it is given: `doc` is already filtered for this viewer on
 * the server (filterDocForViewer), so a gated section never reaches here for
 * a viewer who does not qualify. Every string renders as React text; rich
 * text goes through lib/events/richtext.ts into React nodes.
 *
 * DOM contract: root data-event-root + id="main"; each section
 * data-section-id + data-block; studio inline fields data-field="props.<key>";
 * scoped CSS ([data-event-root]), --ev-* variables, container queries.
 *
 * Fixed-position UI (the Pause control, the RSVP dock, the intro) sits
 * outside the container-query wrapper so it is fixed to the viewport. In
 * Studio's frame, give the frame `transform` or `contain: paint` to keep it
 * inside the device.
 */

function anchorFor(section: EventSection, rsvpId: string | null): string {
  if (section.id === rsvpId) return 'rsvp';
  return `s-${section.id.slice(0, 8)}`;
}

/** An SVG duotone filter id unique to its two colours (Studio may render several pages). */
function duotone(
  theme: EventTheme,
): { id: string; dark: [number, number, number]; light: [number, number, number] } | null {
  if (theme.peoplePhotos.treatment !== 'duotone') return null;
  const palette = primaryPalette(theme);
  const a = hexToRgb(palette.text);
  const b = hexToRgb(palette.highlight === palette.text ? palette.bg : palette.highlight);
  const id = `ev-duotone-${palette.text.slice(1)}${palette.highlight.slice(1)}`;
  return { id, dark: [a.r / 255, a.g / 255, a.b / 255], light: [b.r / 255, b.g / 255, b.b / 255] };
}

export function EventPage({
  doc,
  facts,
  media,
  viewer,
  mode,
  motion: preview,
  rsvp,
  selectedSectionId,
}: EventPageProps) {
  const theme = doc.theme;
  const level = motionLevel(theme, preview);
  const forced = forcesFullMotion(preview);
  const islandMotion = { master: theme.motion.master, level, forced };
  const studio = mode === 'studio';
  const live = mode === 'live' || mode === 'preview';
  const sections = orderedSections(doc.sections).filter(
    (s) => studio || s.visibility.mode !== 'hidden',
  );
  const hero = sections.find((s) => s.type === 'hero') ?? null;
  const rsvpSection = sections.find((s) => s.type === 'rsvp') ?? null;
  const palette = primaryPalette(theme);
  const tone = backgroundTone(theme, palette);
  const heroTone = theme.background.scope === 'hero' ? tone : null;
  // A page-wide background sets the tone of the whole page (event.css reads
  // data-page-tone): readable in Auto whatever the visitor's setting.
  const pageTone = theme.background.scope === 'page' ? tone : null;
  // A scrim behind the hero's text when it would fall below AA over the engine.
  const heroScrim = heroTextScrim(theme, tone);
  const merge = { first_name: viewer.firstName, name: viewer.name, company: viewer.company };

  const ctx: RenderContext = {
    doc,
    theme,
    facts,
    media,
    viewer,
    mode,
    motion: level,
    motionPreview: preview,
    rsvp,
    merge,
    studio,
    heroId: hero?.id ?? null,
  };

  // The display and body faces start downloading with the HTML, so the
  // headline rarely swaps fonts after first paint (a layout shift).
  const fontHrefs: string[] = [];
  if (mode !== 'og') {
    const faces: [typeof theme.typography.display, number][] = [
      [theme.typography.display, theme.typography.displayWeight],
      [theme.typography.body, 400],
    ];
    for (const [id, weight] of faces) {
      const files = (FONT_LIBRARY[id]?.files ?? []).filter((f) => f.style === 'normal');
      const fits = (w: string) => {
        const [lo, hi] = w.split(' ').map(Number);
        return hi === undefined ? lo === weight : weight >= lo! && weight <= hi;
      };
      const file = files.find((f) => fits(f.weight)) ?? files[0];
      if (file && !fontHrefs.includes(`/event-fonts/${file.file}`)) {
        fontHrefs.push(`/event-fonts/${file.file}`);
      }
    }
  }
  // Endless motion from the page itself counts too (a kinetic hero's ticker,
  // a sponsors marquee): the Pause control must be there (WCAG 2.2.2).
  const sectionLoops = sections.some(
    (s) => (s.type === 'hero' && s.variant === 'kinetic') || s.variant === 'marquee',
  );
  const looping = (hasLoopingMotion(theme) || sectionLoops) && level === 'full';
  const filter = duotone(theme);
  const style = {
    ...themeVars(theme),
    ...(filter ? { '--ev-duotone-filter': `url(#${filter.id})` } : {}),
  } as CSSProperties;

  // Arrival intro: the live page and owners' previews only (never Studio's canvas or the OG capture).
  const intro = theme.intro;
  const introKind =
    intro.kind === 'envelope' || intro.kind === 'curtain' || intro.kind === 'fade'
      ? intro.kind
      : intro.kind === 'none'
        ? null
        : 'fade';
  let envelope: EnvelopeView | null = null;
  if (introKind === 'envelope' && intro.envelope) {
    const e = intro.envelope;
    const stamp = resolveMediaRef(ctx, theme.brand.logo);
    const city = venueCity(facts.venue);
    const date = formatShortDate(facts.startsAt, facts.timeZone);
    envelope = {
      color: e.color,
      liner: e.liner,
      linerColor: e.linerColor,
      sealColor: e.sealColor,
      greeting: mergePlainText(e.greeting || 'Dear {{first_name|friend}},', merge),
      postmark: e.postmark || [city, date].filter(Boolean).join(' · '),
      stampUrl: stamp?.src ?? null,
      monogram: initials(facts.title).slice(0, 2) || '✦',
    };
  }
  const introShown = introKind === 'envelope' && !envelope ? 'fade' : introKind;
  const rsvpProps = (rsvpSection?.props ?? {}) as Record<string, unknown>;
  const dockLabel = typeof rsvpProps.cta === 'string' && rsvpProps.cta ? rsvpProps.cta : 'RSVP';

  return (
    <main
      id="main"
      data-event-root=""
      data-mode={mode}
      data-motion={level}
      data-motion-force={forced ? 'true' : undefined}
      data-master={theme.motion.master}
      data-looping={looping ? 'true' : undefined}
      data-page-tone={pageTone ?? undefined}
      data-bg-scope={theme.background.scope}
      data-bg-engine={theme.background.engine}
      {...themeAttributes(theme)}
      style={style}
    >
      {fontHrefs.length ? <FontPreload hrefs={fontHrefs} /> : null}
      {filter ? (
        <svg className="ev-defs" aria-hidden="true" focusable="false" width="0" height="0">
          <filter id={filter.id} colorInterpolationFilters="sRGB">
            <feColorMatrix
              type="matrix"
              values="0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0.2126 0.7152 0.0722 0 0 0 0 0 1 0"
            />
            <feComponentTransfer>
              <feFuncR
                type="table"
                tableValues={`${filter.dark[0].toFixed(3)} ${filter.light[0].toFixed(3)}`}
              />
              <feFuncG
                type="table"
                tableValues={`${filter.dark[1].toFixed(3)} ${filter.light[1].toFixed(3)}`}
              />
              <feFuncB
                type="table"
                tableValues={`${filter.dark[2].toFixed(3)} ${filter.light[2].toFixed(3)}`}
              />
            </feComponentTransfer>
          </filter>
        </svg>
      ) : null}
      {theme.background.scope === 'page' ? (
        <BackgroundLayer theme={theme} ctx={ctx} scope="page" islandMotion={islandMotion} />
      ) : null}
      <OverlayLayer theme={theme} ctx={ctx} area="page" islandMotion={islandMotion} />
      <FinishLayer theme={theme} />
      <div className="ev-page">
        {facts.cancelled ? (
          <div className="ev-cancelled" role="status">
            <p className="ev-cancelled__title">This event has been cancelled</p>
            {facts.cancelled.message ? (
              <p className="ev-cancelled__msg">{facts.cancelled.message}</p>
            ) : null}
          </div>
        ) : null}
        {sections.map((section, i) => {
          const isHero = section.id === hero?.id;
          const band = sectionBand(section, heroTone, isHero);
          return (
            <SectionShell
              key={section.id}
              section={section}
              ctx={ctx}
              band={band}
              first={i === 0}
              anchor={anchorFor(section, rsvpSection?.id ?? null)}
              selected={studio && selectedSectionId === section.id}
              textScrim={isHero ? heroScrim : 0}
              background={
                isHero && theme.background.scope === 'hero' ? (
                  <>
                    <BackgroundLayer
                      theme={theme}
                      ctx={ctx}
                      scope="hero"
                      islandMotion={islandMotion}
                    />
                    <OverlayLayer theme={theme} ctx={ctx} area="hero" islandMotion={islandMotion} />
                  </>
                ) : isHero ? (
                  <OverlayLayer theme={theme} ctx={ctx} area="hero" islandMotion={islandMotion} />
                ) : undefined
              }
            >
              <BlockView section={section} ctx={ctx} />
            </SectionShell>
          );
        })}
        {studio && !sections.length ? (
          <div className="ev-empty-page">
            <p>This page has no sections yet. Add a cover to begin.</p>
          </div>
        ) : null}
      </div>
      {rsvpSection && (rsvpSection.variant === 'sticky' || rsvpSection.variant === 'corner') ? (
        <RsvpDock ctx={ctx} variant={rsvpSection.variant} label={dockLabel} />
      ) : null}
      {live && looping ? (
        <PauseMotion position={theme.motion.pausePosition} forced={forced} />
      ) : null}
      {live || studio ? (
        <RsvpMoments
          moment={theme.motion.rsvpMoment}
          colors={[palette.highlight, palette.accent, ...theme.overlay.colors].slice(0, 6)}
          motion={islandMotion}
          allowPreviewOnly={studio}
        />
      ) : null}
      {level === 'full' && mode !== 'og' && !studio ? <RevealObserver /> : null}
      {live && introShown ? (
        <IntroGate
          kind={introShown}
          eventKey={facts.id}
          title={facts.title}
          dateLine={[formatShortDate(facts.startsAt, facts.timeZone), facts.venue?.name]
            .filter(Boolean)
            .join(' · ')}
          envelope={envelope}
          colors={{
            bg: palette.bg,
            text: palette.text,
            accent: palette.accent,
            accentFg: palette.accentFg,
            highlight: palette.highlight,
          }}
          oncePerVisitor={intro.oncePerVisitor}
          motion={islandMotion}
        />
      ) : null}
    </main>
  );
}
