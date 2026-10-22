import type { CSSProperties } from 'react';
import { heroProps, readProps } from '@/lib/events/blocks/props';
import { chromeOf } from '@/lib/events/theme/tokens';
import { boolOption } from '@/lib/events/theme/effects';
import type { BlockViewProps, RenderContext } from '../context';
import { fieldAttr } from '../context';
import { eventWhen, formatShortDate } from '../format';
import { Headline } from '../headline';
import { EvImage, EvMedia, resolveMediaRef } from '../media';
import { EvButton, linkOf, txt } from './shared';

/**
 * The cover. Variants: centered poster, split media, full-bleed image or
 * video, type-only kinetic, framed (arch, circle, polaroid, ticket, stamp)
 * and the envelope invitation card. An empty headline falls back to the
 * event title; {{first_name}} personalises it on invite links.
 */

function HostMarks({ ctx }: { ctx: RenderContext }) {
  const brand = ctx.theme.brand;
  const logo = resolveMediaRef(ctx, brand.logo);
  const lockup = brand.lockup.filter((l) => l.name.trim());
  if (!logo && !lockup.length) return null;
  return (
    <div className="ev-hero__marks">
      {logo ? (
        <EvImage ctx={ctx} media={brand.logo} className="ev-hero__logo" sizes="160px" decorative />
      ) : null}
      {lockup.length ? (
        <p className="ev-hero__lockup">
          {lockup.map((l, i) => (
            <span key={i}>
              {i > 0 ? (
                <span className="ev-hero__x" aria-hidden="true">
                  ×
                </span>
              ) : null}
              {l.name}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

function MetaLine({
  ctx,
  showDate,
  showVenue,
}: {
  ctx: RenderContext;
  showDate: boolean;
  showVenue: boolean;
}) {
  const { date, time } = eventWhen(ctx.facts);
  const venue = ctx.facts.venue?.name ?? null;
  const parts: string[] = [];
  if (showDate && date) parts.push(date);
  if (showDate && time) parts.push(time);
  if (showVenue && venue) parts.push(venue);
  if (!parts.length) return null;
  return (
    <p className="ev-hero__meta">
      {parts.map((p, i) => (
        <span key={i} className="ev-hero__meta-item">
          {p}
        </span>
      ))}
    </p>
  );
}

function Cta({
  ctx,
  label,
  target,
  href,
}: {
  ctx: RenderContext;
  label: string;
  target: string;
  href: string | null;
}) {
  if (target === 'none' || !label) return null;
  if (target === 'link') {
    return (
      <EvButton ctx={ctx} href={href} external field="ctaLabel">
        {label}
      </EvButton>
    );
  }
  return (
    <EvButton ctx={ctx} href="#rsvp" field="ctaLabel">
      {label}
    </EvButton>
  );
}

export function HeroView({ section, ctx }: BlockViewProps) {
  const p = readProps(heroProps, section.props);
  const variant = section.variant;
  const headline = txt(ctx, p.headline) || ctx.facts.title;
  const effect = section.motion.override
    ? section.motion.headlineEffect
    : ctx.theme.motion.headlineEffect;
  const eyebrow = txt(ctx, p.eyebrow);
  const sub = txt(ctx, p.subheadline);
  const showDate = p.showDate ?? true;
  const showVenue = p.showVenue ?? true;
  const ctaLabel = txt(ctx, p.ctaLabel) || (p.ctaLabel === undefined ? 'RSVP' : '');
  const ctaTarget = p.ctaTarget ?? 'rsvp';
  const chrome = chromeOf(ctx.theme);
  const position = p.textPosition ?? (variant === 'full_bleed' ? 'bottom-left' : 'center');
  const hasMedia = Boolean(resolveMediaRef(ctx, p.media));
  const glow = boolOption(ctx.theme.background.options, 'glow');

  const text = (
    <div className="ev-hero__text">
      {p.showLogo ? (
        <HostMarks ctx={ctx} />
      ) : ctx.theme.brand.lockup.length ? (
        <HostMarks ctx={ctx} />
      ) : null}
      {eyebrow || ctx.studio ? (
        <p
          className="ev-eyebrow ev-hero__eyebrow"
          data-empty={eyebrow ? undefined : 'true'}
          {...fieldAttr(ctx, 'eyebrow')}
        >
          {eyebrow || (ctx.studio ? 'Add a line above the title' : '')}
        </p>
      ) : null}
      <Headline
        ctx={ctx}
        text={headline}
        effect={effect}
        field="headline"
        className="ev-hero__title"
      />
      {sub ? (
        <p className="ev-hero__sub" {...fieldAttr(ctx, 'subheadline')}>
          {sub}
        </p>
      ) : null}
      <MetaLine ctx={ctx} showDate={showDate} showVenue={showVenue} />
      <div className="ev-hero__actions">
        <Cta ctx={ctx} label={ctaLabel} target={ctaTarget} href={linkOf(p.ctaHref)} />
      </div>
    </div>
  );

  const scrim = { '--ev-hero-scrim': String(p.scrim ?? 0.45) } as CSSProperties;

  if (variant === 'kinetic') {
    const date = formatShortDate(ctx.facts.startsAt, ctx.facts.timeZone).toUpperCase();
    const venue = (ctx.facts.venue?.name ?? '').toUpperCase();
    const ticker = [date, venue, ctx.facts.title.toUpperCase()].filter(Boolean).join('  ✦  ');
    return (
      <div
        className="ev-hero ev-hero--kinetic"
        data-chrome={chrome}
        data-length={headline.length > 36 ? 'long' : headline.length > 20 ? 'mid' : undefined}
      >
        {text}
        {ticker ? (
          <div className="ev-ticker" aria-hidden="true">
            <div className="ev-ticker__track">
              {Array.from({ length: 4 }, (_, i) => (
                <span key={i}>{ticker} ✦ </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (variant === 'split') {
    return (
      <div
        className="ev-hero ev-hero--split"
        data-has-media={hasMedia || ctx.studio ? 'true' : undefined}
        data-chrome={chrome}
      >
        {text}
        {hasMedia || ctx.studio ? (
          <div className="ev-hero__media" data-frame={p.frame ?? 'rounded'}>
            <EvMedia
              ctx={ctx}
              media={p.media}
              priority
              sizes="(min-width: 900px) 50vw, 100vw"
              emptyLabel="Add a cover photo or video"
            />
          </div>
        ) : null}
      </div>
    );
  }

  if (variant === 'full_bleed') {
    return (
      <div
        className="ev-hero ev-hero--full"
        data-position={position}
        data-has-media={hasMedia ? 'true' : undefined}
        style={scrim}
      >
        {hasMedia || ctx.studio ? (
          <div className="ev-hero__bleed" aria-hidden={hasMedia ? undefined : true}>
            <EvMedia
              ctx={ctx}
              media={p.media}
              priority
              sizes="100vw"
              emptyLabel="Add a cover photo or video"
            />
            {hasMedia ? <div className="ev-hero__scrim" /> : null}
          </div>
        ) : null}
        {text}
      </div>
    );
  }

  if (variant === 'framed') {
    return (
      <div
        className="ev-hero ev-hero--framed"
        data-chrome={chrome}
        data-has-media={hasMedia ? 'true' : undefined}
      >
        {hasMedia || ctx.studio ? (
          <div
            className="ev-hero__media"
            data-frame={p.frame && p.frame !== 'none' ? p.frame : 'arch'}
          >
            <EvMedia
              ctx={ctx}
              media={p.media}
              priority
              sizes="(min-width: 900px) 40vw, 80vw"
              emptyLabel="Add a photo"
            />
          </div>
        ) : null}
        <div className="ev-hero__frame">
          {chrome === 'terminal' ? (
            <div className="ev-term__bar" aria-hidden="true">
              <span />
              <span />
              <span />
              <em>~/{ctx.facts.slug || 'event'}</em>
            </div>
          ) : null}
          {text}
          {chrome === 'blueprint' ? <TitleBlock ctx={ctx} /> : null}
        </div>
      </div>
    );
  }

  if (variant === 'envelope') {
    return (
      <div className="ev-hero ev-hero--card">
        <div className="ev-invite-card">
          <p className="ev-invite-card__kicker">{eyebrow || 'You are cordially invited'}</p>
          <Headline
            ctx={ctx}
            text={headline}
            effect={effect}
            field="headline"
            className="ev-hero__title"
          />
          {sub ? (
            <p className="ev-hero__sub" {...fieldAttr(ctx, 'subheadline')}>
              {sub}
            </p>
          ) : null}
          <MetaLine ctx={ctx} showDate={showDate} showVenue={showVenue} />
          <div className="ev-hero__actions">
            <Cta ctx={ctx} label={ctaLabel} target={ctaTarget} href={linkOf(p.ctaHref)} />
          </div>
        </div>
      </div>
    );
  }

  // centered
  return (
    <div
      className="ev-hero ev-hero--centered"
      data-chrome={chrome}
      data-glow={glow ? 'true' : undefined}
    >
      <div className="ev-hero__frame">
        {chrome === 'terminal' ? (
          <div className="ev-term__bar" aria-hidden="true">
            <span />
            <span />
            <span />
            <em>~/{ctx.facts.slug || 'event'}</em>
          </div>
        ) : null}
        {text}
        {chrome === 'blueprint' ? <TitleBlock ctx={ctx} /> : null}
      </div>
      {hasMedia ? (
        <div className="ev-hero__media ev-hero__media--below" data-frame={p.frame ?? 'rounded'}>
          <EvMedia ctx={ctx} media={p.media} priority sizes="(min-width: 900px) 880px, 100vw" />
        </div>
      ) : null}
    </div>
  );
}

/** Blueprint's drawing title block: name, date, venue, revision. */
function TitleBlock({ ctx }: { ctx: RenderContext }) {
  const date = formatShortDate(ctx.facts.startsAt, ctx.facts.timeZone);
  return (
    <dl className="ev-titleblock" aria-hidden="true">
      <div>
        <dt>Project</dt>
        <dd>{ctx.facts.title}</dd>
      </div>
      <div>
        <dt>Date</dt>
        <dd>{date || 'TBA'}</dd>
      </div>
      <div>
        <dt>Site</dt>
        <dd>{ctx.facts.venue?.name ?? 'TBA'}</dd>
      </div>
      <div>
        <dt>Rev</dt>
        <dd>{String(Math.max(1, ctx.facts.publishedVersion)).padStart(2, '0')}</dd>
      </div>
    </dl>
  );
}
