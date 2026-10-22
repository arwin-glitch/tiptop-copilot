import { CalendarDays, Clock, Lock, MapPin, Navigation, Ticket, Users } from 'lucide-react';
import {
  countdownProps,
  detailsProps,
  readProps,
  rsvpProps,
  venueProps,
} from '@/lib/events/blocks/props';
import type { BlockVariant } from '@/lib/events/schema';
import { forcesFullMotion } from '@/lib/events/theme/motion';
import { RsvpSlot } from '@/components/events/rsvp/rsvp-slot';
import { CountdownIsland, type CountdownStyle } from '@/components/events/effects/countdown-island';
import { ClickToLoadFrame, LocalTimeHint } from '@/components/events/effects/small-islands';
import type { BlockViewProps, RenderContext } from '../context';
import { fieldAttr } from '../context';
import {
  accessLabel,
  dateParts,
  formatDate,
  directionsLinks,
  eventWhen,
  formatTimeRange,
  mapEmbedUrl,
  safeHref,
  sessionWhen,
} from '../format';
import { EvImage } from '../media';
import { EvButton, Rich, SectionHeading, txt } from './shared';

/** Key details, Venue & map, Countdown and the RSVP shell: the blocks built on the event's settings. */

function islandMotion(ctx: RenderContext) {
  return {
    master: ctx.theme.motion.master,
    level: ctx.motion,
    forced: forcesFullMotion(ctx.motionPreview),
  };
}

/* ------------------------------------------------------------- details */

export function DetailsView({ section, ctx }: BlockViewProps) {
  const p = readProps(detailsProps, section.props);
  const { date, time } = eventWhen(ctx.facts);
  const venue = ctx.facts.venue;
  const items: { icon: React.ReactNode; label: string; value: string; hint?: React.ReactNode }[] =
    [];
  if ((p.showDate ?? true) && date)
    items.push({ icon: <CalendarDays aria-hidden="true" />, label: 'Date', value: date });
  if ((p.showTime ?? true) && time) {
    items.push({
      icon: <Clock aria-hidden="true" />,
      label: 'Time',
      value: time,
      hint:
        (p.showTimezone ?? true) && ctx.mode !== 'og' ? (
          <LocalTimeHint startsAt={ctx.facts.startsAt} venueZone={ctx.facts.timeZone} />
        ) : null,
    });
  }
  if ((p.showVenue ?? true) && venue) {
    const where =
      venue.kind === 'online'
        ? 'Online'
        : venue.revealed && venue.address
          ? [venue.name, venue.address].filter(Boolean).join(', ')
          : (venue.name ?? 'Venue shared with guests');
    items.push({ icon: <MapPin aria-hidden="true" />, label: 'Where', value: where });
  }
  if (p.showAccess)
    items.push({
      icon: <Lock aria-hidden="true" />,
      label: 'Access',
      value: accessLabel(ctx.facts),
    });
  for (const extra of p.items ?? []) {
    if (extra.label || extra.value)
      items.push({
        icon: <Ticket aria-hidden="true" />,
        label: txt(ctx, extra.label),
        value: txt(ctx, extra.value),
      });
  }
  const heading = txt(ctx, p.heading);

  if (section.variant === 'ticket') {
    const parts = dateParts(ctx.facts.startsAt, ctx.facts.timeZone);
    return (
      <>
        <SectionHeading ctx={ctx} heading={heading} />
        <div className="ev-ticket">
          <div className="ev-ticket__main">
            <p className="ev-ticket__label">Admit one</p>
            <p className="ev-ticket__title">{ctx.facts.title}</p>
            <dl className="ev-ticket__grid">
              {items.map((it, i) => (
                <div key={i}>
                  <dt>{it.label}</dt>
                  <dd>
                    {it.value}
                    {it.hint}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="ev-ticket__stub" aria-hidden={parts ? undefined : true}>
            {parts ? (
              <>
                <span className="ev-ticket__month">{parts.month}</span>
                <span className="ev-ticket__day">{parts.day}</span>
                <span className="ev-ticket__year">{parts.weekday}</span>
              </>
            ) : (
              <span className="ev-ticket__month">TBA</span>
            )}
          </div>
        </div>
      </>
    );
  }

  if (section.variant === 'card') {
    return (
      <>
        <SectionHeading ctx={ctx} heading={heading} />
        <dl className="ev-card ev-details-card">
          {items.map((it, i) => (
            <div key={i} className="ev-details-card__row">
              {/* dl > div > (dt, dd): the icon lives inside the term. */}
              <dt>
                <span className="ev-details-card__icon" aria-hidden="true">
                  {it.icon}
                </span>
                {it.label}
              </dt>
              <dd>
                {it.value}
                {it.hint}
              </dd>
            </div>
          ))}
        </dl>
      </>
    );
  }

  return (
    <>
      <SectionHeading ctx={ctx} heading={heading} />
      <ul className="ev-chips">
        {items.map((it, i) => (
          <li key={i} className="ev-chip">
            {it.icon}
            <span className="ev-chip__text">
              <span className="ev-sr">{it.label}: </span>
              {it.value}
              {it.hint}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/* --------------------------------------------------------------- venue */

export function VenueView({ section, ctx }: BlockViewProps) {
  const p = readProps(venueProps, section.props);
  const venue = ctx.facts.venue;
  const heading = txt(ctx, p.heading);
  const directions = (p.showDirections ?? true) ? directionsLinks(venue) : null;
  const mapsUrl = safeHref(venue?.mapsUrl);
  const embed = p.showMap && ctx.mode === 'live' ? mapEmbedUrl(venue) : null;
  const online = venue?.revealed ? safeHref(venue.onlineUrl) : null;
  const hidden = venue && !venue.revealed;
  const revealWord = venue?.revealRule === 'going' ? 'confirmed guests' : 'registered guests';

  const details = (
    <div className="ev-venue__details">
      {venue?.name ? <p className="ev-venue__name">{venue.name}</p> : null}
      {venue?.revealed && venue.address ? (
        <p className="ev-venue__address">{venue.address}</p>
      ) : null}
      {hidden ? (
        <p className="ev-venue__hidden">
          <Lock aria-hidden="true" /> The address is shared with {revealWord}.
        </p>
      ) : null}
      {venue?.notes ? <p className="ev-venue__note">{venue.notes}</p> : null}
      <Rich ctx={ctx} source={p.notes} />
      {p.parking ? (
        <p className="ev-venue__extra">
          <strong>Parking</strong> {txt(ctx, p.parking)}
        </p>
      ) : null}
      {p.arrival ? (
        <p className="ev-venue__extra">
          <strong>On arrival</strong> {txt(ctx, p.arrival)}
        </p>
      ) : null}
      <div className="ev-venue__actions">
        {directions ? (
          <>
            <EvButton ctx={ctx} href={directions.google} external variant="secondary">
              <Navigation aria-hidden="true" /> Google Maps
            </EvButton>
            <EvButton ctx={ctx} href={directions.apple} external variant="ghost">
              Apple Maps
            </EvButton>
          </>
        ) : mapsUrl ? (
          <EvButton ctx={ctx} href={mapsUrl} external variant="secondary">
            <Navigation aria-hidden="true" /> Directions
          </EvButton>
        ) : null}
        {online ? (
          <EvButton ctx={ctx} href={online} external>
            Join online
          </EvButton>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      <SectionHeading ctx={ctx} heading={heading} placeholder="Getting there" />
      <div className="ev-venue" data-variant={section.variant}>
        {section.variant === 'map' ? (
          <div className="ev-venue__map">
            {embed ? (
              <ClickToLoadFrame
                src={embed}
                title={`Map of ${venue?.name ?? 'the venue'}`}
                label="Show the map"
                aspect="16 / 9"
              />
            ) : (
              <div className="ev-venue__map-art" aria-hidden="true">
                <MapPin />
              </div>
            )}
          </div>
        ) : null}
        {section.variant === 'card' ? (
          <div className="ev-venue__photo">
            <EvImage
              ctx={ctx}
              media={p.photo}
              sizes="(min-width: 900px) 40vw, 100vw"
              emptyLabel="Add a venue photo"
            />
          </div>
        ) : null}
        {details}
      </div>
    </>
  );
}

/* ----------------------------------------------------------- countdown */

export function CountdownView({ section, ctx }: BlockViewProps) {
  const p = readProps(countdownProps, section.props);
  const target =
    p.target && p.target !== 'event' ? ctx.facts.sessions.find((s) => s.id === p.target) : null;
  const startsAt = target ? target.startsAt : ctx.facts.startsAt;
  const endsAt = target ? target.endsAt : ctx.facts.endsAt;
  const themeStyle = ctx.theme.motion.countdownStyle;
  const style: CountdownStyle =
    section.variant === 'ring' && themeStyle === 'constellation'
      ? 'constellation'
      : (section.variant as CountdownStyle);
  const heading = txt(ctx, p.heading);
  return (
    <>
      <SectionHeading ctx={ctx} heading={heading} />
      <div className="ev-countdown" data-variant={style}>
        <CountdownIsland
          startsAt={startsAt}
          endsAt={endsAt}
          variant={style}
          liveLabel={txt(ctx, p.liveLabel) || 'Happening now'}
          endedLabel={txt(ctx, p.endedLabel) || 'Thanks for coming'}
          fallback={formatDate(startsAt, ctx.facts.timeZone)}
          motion={islandMotion(ctx)}
        />
        {target ? <p className="ev-countdown__session">{target.name}</p> : null}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- rsvp */

export function RsvpView({ section, ctx }: BlockViewProps) {
  const p = readProps(rsvpProps, section.props);
  const variant =
    (['inline', 'sheet', 'sticky', 'corner'] as const).find((v) => v === section.variant) ??
    'inline';
  const heading = txt(ctx, p.heading);
  const response = ctx.rsvp?.registration.responseSet;
  const labels = {
    cta: txt(ctx, p.cta) || 'RSVP',
    going: txt(ctx, p.going) || response?.labels.going || 'Going',
    maybe: txt(ctx, p.maybe) || response?.labels.maybe || 'Maybe',
    notGoing: txt(ctx, p.notGoing) || response?.labels.not_going || "Can't go",
  };
  const sessions = ctx.facts.sessions;
  return (
    <div className="ev-rsvp" data-variant={variant}>
      <div className="ev-rsvp__card">
        <SectionHeading ctx={ctx} heading={heading} placeholder="Will you join us?" />
        <Rich ctx={ctx} source={p.body} />
        {sessions.length > 1 ? (
          <ul className="ev-rsvp__sessions">
            {sessions.map((s) => (
              <li key={s.id}>
                <Users aria-hidden="true" />
                <span>
                  <strong>{s.name}</strong> {sessionWhen(s, ctx.facts.timeZone)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {ctx.facts.cancelled ? (
          <p className="ev-rsvp__closed">This event has been cancelled.</p>
        ) : (
          <RsvpSlot
            variant={variant as BlockVariant<'rsvp'>}
            labels={labels}
            mode={ctx.mode}
            context={ctx.rsvp}
          />
        )}
        {p.note ? (
          <p className="ev-rsvp__note" {...fieldAttr(ctx, 'note')}>
            {txt(ctx, p.note)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The sticky RSVP bar / corner ticket button some RSVP variants add (live page only, an anchor, no script). */
export function RsvpDock({
  ctx,
  variant,
  label,
}: {
  ctx: RenderContext;
  variant: 'sticky' | 'corner';
  label: string;
}) {
  if (ctx.mode !== 'live' && ctx.mode !== 'preview') return null;
  if (ctx.facts.cancelled) return null;
  const when = formatTimeRange(ctx.facts.startsAt, ctx.facts.endsAt, ctx.facts.timeZone);
  if (variant === 'corner') {
    return (
      <a className="ev-dock ev-dock--corner" href="#rsvp">
        <Ticket aria-hidden="true" />
        <span>{label}</span>
      </a>
    );
  }
  return (
    <div className="ev-dock ev-dock--bar">
      <span className="ev-dock__title">
        <strong>{ctx.facts.title}</strong>
        {when ? <span>{when}</span> : null}
      </span>
      <a className="ev-btn ev-btn--primary" href="#rsvp">
        {label}
      </a>
    </div>
  );
}
