import type { CSSProperties } from 'react';
import {
  hostsProps,
  readProps,
  SPONSOR_TIERS,
  sponsorsProps,
  type Person,
  type Sponsor,
} from '@/lib/events/blocks/props';
import type { BlockViewProps, RenderContext } from '../context';
import { fieldAttr } from '../context';
import { EvImage, resolveMediaRef } from '../media';
import { initials, linkOf, SectionHeading, StudioHint, txt } from './shared';

/** Hosts & speakers, and Sponsors & co-hosts. */

function PersonPhoto({
  ctx,
  person,
  size,
  forceTreatment,
}: {
  ctx: RenderContext;
  person: Person;
  size: string;
  forceTreatment?: string;
}) {
  const has = resolveMediaRef(ctx, person.photo);
  if (has) {
    return (
      <span className="ev-person-photo" data-treatment={forceTreatment}>
        <EvImage ctx={ctx} media={person.photo} sizes={size} />
      </span>
    );
  }
  return (
    <span className="ev-person-photo ev-person-photo--initials" aria-hidden="true">
      {initials(person.name ?? '') || '·'}
    </span>
  );
}

function PersonName({ ctx, person }: { ctx: RenderContext; person: Person }) {
  const href = linkOf(person.href);
  const name = txt(ctx, person.name);
  if (href && !ctx.studio && ctx.mode !== 'og') {
    return (
      <a className="ev-person__name" href={href} target="_blank" rel="noopener noreferrer">
        {name}
      </a>
    );
  }
  return <span className="ev-person__name">{name}</span>;
}

export function HostsView({ section, ctx }: BlockViewProps) {
  const p = readProps(hostsProps, section.props);
  const people = (p.people ?? []).filter((x) => x.name);
  const intro = txt(ctx, p.intro);
  const v = section.variant;
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} placeholder="Hosts" />
      {intro ? (
        <p className="ev-lede" {...fieldAttr(ctx, 'intro')}>
          {intro}
        </p>
      ) : null}
      {!people.length ? (
        <StudioHint ctx={ctx}>
          Pick people from Network or CRM in the panel on the right.
        </StudioHint>
      ) : null}
      {v === 'leaderboard' ? (
        <ol className="ev-leaderboard">
          {people.map((person, i) => (
            <li
              key={i}
              className="ev-leaderboard__row ev-stagger"
              style={{ '--i': String(i) } as CSSProperties}
            >
              <span className="ev-leaderboard__pos">{String(i + 1).padStart(2, '0')}</span>
              <PersonPhoto ctx={ctx} person={person} size="48px" />
              <span className="ev-person__meta">
                <PersonName ctx={ctx} person={person} />
                <span className="ev-person__role">
                  {[txt(ctx, person.title), txt(ctx, person.company)].filter(Boolean).join(' · ')}
                </span>
              </span>
              <span className="ev-leaderboard__stat">{txt(ctx, person.stat) || 'E'}</span>
            </li>
          ))}
        </ol>
      ) : (
        <ul className={`ev-people ev-people--${v}`}>
          {people.map((person, i) => (
            <li
              key={i}
              className="ev-person ev-stagger"
              style={{ '--i': String(i) } as CSSProperties}
            >
              <PersonPhoto
                ctx={ctx}
                person={person}
                size={v === 'row' ? '96px' : '(min-width: 900px) 240px, 45vw'}
                forceTreatment={v === 'dithered' ? 'dither' : undefined}
              />
              <span className="ev-person__meta">
                <PersonName ctx={ctx} person={person} />
                {person.title || person.company ? (
                  <span className="ev-person__role">
                    {[txt(ctx, person.title), txt(ctx, person.company)].filter(Boolean).join(', ')}
                  </span>
                ) : null}
                {person.bio && v === 'grid' ? (
                  <span className="ev-person__bio">{txt(ctx, person.bio)}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SponsorMark({
  ctx,
  sponsor,
  size,
}: {
  ctx: RenderContext;
  sponsor: Sponsor;
  size: string;
}) {
  const logo = resolveMediaRef(ctx, sponsor.logo);
  const href = linkOf(sponsor.href);
  const inner = logo ? (
    <EvImage ctx={ctx} media={sponsor.logo} className="ev-sponsor__logo" sizes={size} />
  ) : (
    <span className="ev-sponsor__word">{txt(ctx, sponsor.name)}</span>
  );
  const label = txt(ctx, sponsor.name);
  if (href && !ctx.studio && ctx.mode !== 'og') {
    return (
      <a
        className="ev-sponsor"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={logo ? label : undefined}
      >
        {inner}
      </a>
    );
  }
  return (
    <span
      className="ev-sponsor"
      aria-label={logo ? label : undefined}
      role={logo ? 'img' : undefined}
    >
      {inner}
    </span>
  );
}

const TIER_LABEL: Record<(typeof SPONSOR_TIERS)[number], string> = {
  presenting: 'Presented by',
  gold: 'Gold',
  partner: 'Partners',
  community: 'Community',
};

export function SponsorsView({ section, ctx }: BlockViewProps) {
  const p = readProps(sponsorsProps, section.props);
  const items = (p.items ?? []).filter((s) => s.name || s.logo);
  const intro = txt(ctx, p.intro);
  const v = section.variant;
  const head = (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} />
      {intro ? (
        <p className="ev-lede" {...fieldAttr(ctx, 'intro')}>
          {intro}
        </p>
      ) : null}
    </>
  );

  if (v === 'lockup') {
    const names = ctx.theme.brand.lockup.length
      ? ctx.theme.brand.lockup.map((l) => l.name)
      : items.map((s) => txt(ctx, s.name));
    return (
      <>
        {head}
        <p className="ev-lockup">
          {names.filter(Boolean).map((name, i) => (
            <span key={i}>
              {i > 0 ? (
                <span className="ev-lockup__x" aria-hidden="true">
                  ×
                </span>
              ) : null}
              <span className="ev-lockup__name">{name}</span>
            </span>
          ))}
        </p>
        {!names.length ? (
          <StudioHint ctx={ctx}>Add co-hosts in the panel on the right.</StudioHint>
        ) : null}
      </>
    );
  }

  if (v === 'marquee') {
    return (
      <>
        {head}
        <div className="ev-marquee" aria-label={items.map((s) => txt(ctx, s.name)).join(', ')}>
          <div className="ev-marquee__track" aria-hidden="true">
            {[0, 1].map((copy) => (
              <span key={copy} className="ev-marquee__set">
                {items.map((s, i) => (
                  <SponsorMark key={i} ctx={ctx} sponsor={s} size="200px" />
                ))}
              </span>
            ))}
          </div>
        </div>
      </>
    );
  }

  if (v === 'holes') {
    const holes = items
      .map((s, i) => ({ ...s, hole: s.hole ?? i + 1 }))
      .sort((a, b) => (a.hole ?? 0) - (b.hole ?? 0));
    return (
      <>
        {head}
        <ul className="ev-holes">
          {holes.map((s, i) => (
            <li
              key={i}
              className="ev-hole ev-stagger"
              style={{ '--i': String(i) } as CSSProperties}
            >
              <span className="ev-hole__no">
                <small>Hole</small>
                {s.hole}
              </span>
              <SponsorMark ctx={ctx} sponsor={s} size="160px" />
              {s.note ? <span className="ev-hole__note">{txt(ctx, s.note)}</span> : null}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <>
      {head}
      {SPONSOR_TIERS.map((tier) => {
        const list = items.filter((s) => (s.tier ?? 'partner') === tier);
        if (!list.length) return null;
        return (
          <div key={tier} className="ev-tier" data-tier={tier}>
            <p className="ev-tier__label">{TIER_LABEL[tier]}</p>
            <ul className="ev-tier__logos">
              {list.map((s, i) => (
                <li key={i}>
                  <SponsorMark
                    ctx={ctx}
                    sponsor={s}
                    size={tier === 'presenting' ? '320px' : '200px'}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {!items.length ? (
        <StudioHint ctx={ctx}>Add sponsors in the panel on the right.</StudioHint>
      ) : null}
    </>
  );
}
