import { ChevronDown } from 'lucide-react';
import type { CSSProperties } from 'react';
import {
  agendaProps,
  buttonsProps,
  dividerProps,
  faqProps,
  footerProps,
  readProps,
  statsProps,
  textProps,
  type AgendaItem,
} from '@/lib/events/blocks/props';
import { forcesFullMotion } from '@/lib/events/theme/motion';
import { CountUp } from '@/components/events/effects/small-islands';
import type { BlockViewProps, RenderContext } from '../context';
import { fieldAttr } from '../context';
import { EvImage } from '../media';
import { Divider } from '../section-shell';
import { EvButton, linkOf, Rich, SectionHeading, StudioHint, txt } from './shared';

/** Agenda, Text, FAQ, Quote & stats, Buttons, Divider and Footer. */

/* -------------------------------------------------------------- agenda */

/** Items the viewer may see: an item tied to a session follows that session's visibility. */
export function visibleAgendaItems(ctx: RenderContext, items: readonly AgendaItem[]): AgendaItem[] {
  const allowed = new Set(ctx.facts.sessions.map((s) => s.id));
  return items.filter((item) => !item.sessionId || allowed.has(item.sessionId) || ctx.studio);
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'item'
  );
}

function ItemBody({ ctx, item }: { ctx: RenderContext; item: AgendaItem }) {
  return (
    <div className="ev-agenda__body">
      <p className="ev-agenda__title">{txt(ctx, item.title)}</p>
      {item.description ? <p className="ev-agenda__desc">{txt(ctx, item.description)}</p> : null}
      {item.speaker ? <p className="ev-agenda__speaker">{txt(ctx, item.speaker)}</p> : null}
    </div>
  );
}

function timeLabel(item: AgendaItem): string {
  return [item.time, item.endTime].filter(Boolean).join(' – ');
}

function TrackColor(track: string): string {
  let h = 0;
  for (const ch of track) h = (h * 31 + ch.charCodeAt(0)) % 4;
  return (
    ['var(--ev-accent)', 'var(--ev-highlight)', 'var(--ev-text)', 'var(--ev-muted)'][h] ??
    'var(--ev-accent)'
  );
}

export function AgendaView({ section, ctx }: BlockViewProps) {
  const p = readProps(agendaProps, section.props);
  const items = visibleAgendaItems(ctx, p.items ?? []);
  const heading = txt(ctx, p.heading);
  const intro = txt(ctx, p.intro);
  const head = (
    <>
      <SectionHeading ctx={ctx} heading={heading} placeholder="Agenda" />
      {intro ? (
        <p className="ev-lede" {...fieldAttr(ctx, 'intro')}>
          {intro}
        </p>
      ) : null}
    </>
  );
  if (!items.length) {
    return (
      <>
        {head}
        <StudioHint ctx={ctx}>Add agenda items in the panel on the right.</StudioHint>
      </>
    );
  }
  const v = section.variant;

  if (v === 'two_column') {
    const a = items.filter((i) => (i.column ?? 'a') === 'a');
    const b = items.filter((i) => i.column === 'b');
    const col = (label: string, list: AgendaItem[], key: string) => (
      <div className="ev-agenda__col">
        {label ? (
          <p className="ev-agenda__col-title" {...fieldAttr(ctx, key)}>
            {label}
          </p>
        ) : null}
        <ol className="ev-agenda__list">
          {list.map((item, i) => (
            <li
              key={i}
              className="ev-agenda__item ev-stagger"
              style={{ '--i': String(i) } as CSSProperties}
            >
              <span className="ev-agenda__time">{timeLabel(item)}</span>
              <ItemBody ctx={ctx} item={item} />
            </li>
          ))}
        </ol>
      </div>
    );
    return (
      <>
        {head}
        <div className="ev-agenda ev-agenda--two" data-cols={b.length && a.length ? '2' : '1'}>
          {a.length ? col(b.length ? txt(ctx, p.columnA) : '', a, 'columnA') : null}
          {b.length ? col(a.length ? txt(ctx, p.columnB) : '', b, 'columnB') : null}
        </div>
      </>
    );
  }

  if (v === 'day_tabs') {
    const days = [...new Set(items.map((i) => txt(ctx, i.day) || 'Day 1'))];
    const group = `ev-days-${section.id.slice(0, 8)}`;
    return (
      <>
        {head}
        <div className="ev-agenda ev-agenda--tabs" role="group" aria-label="Days">
          {days.map((day, d) => (
            <input
              key={`r${d}`}
              type="radio"
              name={group}
              id={`${group}-${d}`}
              className="ev-tab-radio"
              defaultChecked={d === 0}
            />
          ))}
          <div className="ev-tabs">
            {days.map((day, d) => (
              <label key={`l${d}`} htmlFor={`${group}-${d}`} className="ev-tab" data-tab={d}>
                {day}
              </label>
            ))}
          </div>
          {days.map((day, d) => (
            <ol key={`p${d}`} className="ev-agenda__list ev-tab-panel" data-tab={d}>
              {items
                .filter((i) => (txt(ctx, i.day) || 'Day 1') === day)
                .map((item, i) => (
                  <li key={i} className="ev-agenda__item">
                    <span className="ev-agenda__time">{timeLabel(item)}</span>
                    <ItemBody ctx={ctx} item={item} />
                  </li>
                ))}
            </ol>
          ))}
        </div>
      </>
    );
  }

  if (v === 'scorecard') {
    return (
      <>
        {head}
        <div className="ev-scorecard" role="table" aria-label={heading || 'Agenda'}>
          <div className="ev-scorecard__row ev-scorecard__row--head" role="row">
            <span role="columnheader">Hole</span>
            <span role="columnheader">Tee</span>
            <span role="columnheader">On the card</span>
          </div>
          {items.map((item, i) => (
            <div key={i} className="ev-scorecard__row" role="row">
              <span role="cell" className="ev-scorecard__hole">
                {item.hole ?? i + 1}
              </span>
              <span role="cell" className="ev-scorecard__time">
                {timeLabel(item)}
              </span>
              <span role="cell">
                <ItemBody ctx={ctx} item={item} />
              </span>
            </div>
          ))}
        </div>
      </>
    );
  }

  if (v === 'menu') {
    return (
      <>
        {head}
        <ol className="ev-menu">
          {items.map((item, i) => (
            <li
              key={i}
              className="ev-menu__course ev-stagger"
              style={{ '--i': String(i) } as CSSProperties}
            >
              {item.time ? <span className="ev-menu__time">{timeLabel(item)}</span> : null}
              <p className="ev-menu__title">{txt(ctx, item.title)}</p>
              {item.description ? (
                <p className="ev-menu__desc">{txt(ctx, item.description)}</p>
              ) : null}
              {item.speaker ? <p className="ev-agenda__speaker">{txt(ctx, item.speaker)}</p> : null}
              {i < items.length - 1 ? (
                <span className="ev-menu__sep" aria-hidden="true">
                  ◆
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </>
    );
  }

  if (v === 'terminal') {
    return (
      <>
        {head}
        <div className="ev-terminal" role="list">
          <p className="ev-terminal__prompt" aria-hidden="true">
            $ ls -la ./{slug(ctx.facts.title)}
          </p>
          {items.map((item, i) => (
            <div key={i} className="ev-terminal__line" role="listitem">
              <span className="ev-terminal__perm" aria-hidden="true">
                -rw-r--r--
              </span>
              <span className="ev-terminal__time">{timeLabel(item) || '--:--'}</span>
              <span className="ev-terminal__name">{slug(txt(ctx, item.title))}</span>
              <span className="ev-sr">{txt(ctx, item.title)}</span>
              {item.speaker ? (
                <span className="ev-terminal__who"># {txt(ctx, item.speaker)}</span>
              ) : null}
            </div>
          ))}
          <p className="ev-terminal__prompt" aria-hidden="true">
            $ <span className="ev-caret" />
          </p>
        </div>
      </>
    );
  }

  if (v === 'bento') {
    return (
      <>
        {head}
        <ol className="ev-bento">
          {items.map((item, i) => (
            <li
              key={i}
              className="ev-bento__tile ev-stagger"
              data-wide={i === 0 ? 'true' : undefined}
              style={
                {
                  '--i': String(i),
                  '--ev-track': item.track ? TrackColor(item.track) : 'var(--ev-accent)',
                } as CSSProperties
              }
            >
              <div className="ev-bento__top">
                <span className="ev-agenda__time">{timeLabel(item)}</span>
                {item.track ? (
                  <span className="ev-bento__track">{txt(ctx, item.track)}</span>
                ) : null}
              </div>
              <ItemBody ctx={ctx} item={item} />
            </li>
          ))}
        </ol>
      </>
    );
  }

  return (
    <>
      {head}
      <ol className="ev-agenda ev-agenda--timeline">
        {items.map((item, i) => (
          <li
            key={i}
            className="ev-agenda__item ev-stagger"
            style={{ '--i': String(i) } as CSSProperties}
          >
            <span className="ev-agenda__time">{timeLabel(item)}</span>
            <span className="ev-agenda__dot" aria-hidden="true" />
            <ItemBody ctx={ctx} item={item} />
          </li>
        ))}
      </ol>
    </>
  );
}

/* ---------------------------------------------------------------- text */

export function TextView({ section, ctx }: BlockViewProps) {
  const p = readProps(textProps, section.props);
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} eyebrow={txt(ctx, p.eyebrow)} />
      <div className="ev-text" data-variant={section.variant}>
        {p.body ? (
          <Rich ctx={ctx} source={p.body} className="ev-text__body" />
        ) : (
          <StudioHint ctx={ctx}>Write the text in the panel on the right.</StudioHint>
        )}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- faq */

export function FaqView({ section, ctx }: BlockViewProps) {
  const p = readProps(faqProps, section.props);
  const items = (p.items ?? []).filter((i) => i.q);
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} placeholder="Questions" />
      {items.length ? (
        <div className="ev-faq" data-variant={section.variant}>
          {items.map((item, i) =>
            section.variant === 'two_column' ? (
              <div key={i} className="ev-faq__pair">
                <p className="ev-faq__q">{txt(ctx, item.q)}</p>
                <Rich ctx={ctx} source={item.a} className="ev-faq__a" />
              </div>
            ) : (
              <details key={i} className="ev-faq__item">
                <summary>
                  <span>{txt(ctx, item.q)}</span>
                  <ChevronDown aria-hidden="true" />
                </summary>
                <Rich ctx={ctx} source={item.a} className="ev-faq__a" />
              </details>
            ),
          )}
        </div>
      ) : (
        <StudioHint ctx={ctx}>Add questions in the panel on the right.</StudioHint>
      )}
    </>
  );
}

/* --------------------------------------------------------------- stats */

export function StatsView({ section, ctx }: BlockViewProps) {
  const p = readProps(statsProps, section.props);
  const motion = {
    master: ctx.theme.motion.master,
    level: ctx.motion,
    forced: forcesFullMotion(ctx.motionPreview),
  };
  if (section.variant === 'quote') {
    const quote = txt(ctx, p.quote);
    return (
      <figure className="ev-quote">
        <blockquote {...fieldAttr(ctx, 'quote')}>
          <p>{quote || (ctx.studio ? 'Add a quote' : '')}</p>
        </blockquote>
        {p.attribution ? (
          <figcaption>
            <EvImage
              ctx={ctx}
              media={p.photo}
              className="ev-quote__photo ev-person-photo"
              sizes="64px"
            />
            <span>
              <strong>{txt(ctx, p.attribution)}</strong>
              {p.role ? <span>{txt(ctx, p.role)}</span> : null}
            </span>
          </figcaption>
        ) : null}
      </figure>
    );
  }
  const stats = (p.stats ?? []).filter((s) => s.value);
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} />
      {stats.length ? (
        <dl className="ev-stats">
          {stats.map((s, i) => {
            const value = `${s.prefix ?? ''}${s.value ?? ''}${s.suffix ?? ''}`;
            return (
              <div
                key={i}
                className="ev-stat ev-stagger"
                style={{ '--i': String(i) } as CSSProperties}
              >
                <dt>{txt(ctx, s.label)}</dt>
                <dd>
                  {p.countUp !== false && ctx.mode !== 'og' && !ctx.studio ? (
                    <CountUp value={value} motion={motion} />
                  ) : (
                    value
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <StudioHint ctx={ctx}>Add numbers in the panel on the right.</StudioHint>
      )}
    </>
  );
}

/* ------------------------------------------------------------- buttons */

export function ButtonsView({ section, ctx }: BlockViewProps) {
  const p = readProps(buttonsProps, section.props);
  const items = (p.items ?? []).filter((b) => b.label);
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} />
      <div className="ev-buttons" data-variant={section.variant}>
        {items.map((b, i) => (
          <EvButton
            key={i}
            ctx={ctx}
            href={linkOf(b.href)}
            external
            variant={b.style ?? (i === 0 ? 'primary' : 'secondary')}
          >
            {txt(ctx, b.label)}
          </EvButton>
        ))}
        {!items.length ? (
          <StudioHint ctx={ctx}>Add buttons in the panel on the right.</StudioHint>
        ) : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------- divider */

export function DividerView({ section, ctx }: BlockViewProps) {
  const p = readProps(dividerProps, section.props);
  const size = p.size ?? 'm';
  if (section.variant === 'space')
    return <div className="ev-spacer" data-size={size} aria-hidden="true" />;
  if (section.variant === 'ornament') {
    return (
      <div className="ev-divider-block" data-size={size}>
        <Divider kind={ctx.theme.layout.divider === 'deco' ? 'deco' : 'ornament'} />
      </div>
    );
  }
  return (
    <div className="ev-divider-block" data-size={size}>
      <Divider kind="hairline" />
    </div>
  );
}

/* -------------------------------------------------------------- footer */

export function FooterView({ section, ctx }: BlockViewProps) {
  const p = readProps(footerProps, section.props);
  const contact = linkOf(p.contactHref);
  const links = (p.links ?? []).filter((l) => l.label && linkOf(l.href));
  const text = txt(ctx, p.text);
  return (
    <footer className="ev-footer" data-variant={section.variant}>
      {text ? (
        <p className="ev-footer__text" {...fieldAttr(ctx, 'text')}>
          {text}
        </p>
      ) : (
        <p className="ev-footer__text ev-footer__title">{ctx.facts.title}</p>
      )}
      {contact || links.length ? (
        <nav className="ev-footer__links" aria-label="Event links">
          {contact ? (
            <a
              href={contact}
              {...(contact.startsWith('mailto:')
                ? {}
                : { target: '_blank', rel: 'noopener noreferrer' })}
            >
              {txt(ctx, p.contactLabel) || 'Contact the host'}
            </a>
          ) : null}
          {links.map((l, i) => (
            <a key={i} href={linkOf(l.href) ?? undefined} target="_blank" rel="noopener noreferrer">
              {txt(ctx, l.label)}
            </a>
          ))}
        </nav>
      ) : null}
      {p.showMadeWith ? <p className="ev-footer__made">Made with TipTop</p> : null}
    </footer>
  );
}
