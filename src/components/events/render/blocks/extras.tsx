import { Car, Gift, Hotel, Info, Plane, Shirt, Sun, Utensils, Video } from 'lucide-react';
import {
  EMBED_ID_RE,
  embedProps,
  guestWallProps,
  infoCardsProps,
  joinRemoteProps,
  readProps,
  type EmbedProvider,
} from '@/lib/events/blocks/props';
import { ClickToLoadFrame } from '@/components/events/effects/small-islands';
import type { BlockViewProps } from '../context';
import { EvButton, linkOf, Rich, SectionHeading, StudioHint, txt } from './shared';

/** v1-nice blocks: Embed, Guest wall, Join remotely, Info cards. */

/** The iframe URL for an allowlisted provider, built from a validated id (never a stored URL). */
export function embedSrc(provider: EmbedProvider, id: string): string | null {
  if (!EMBED_ID_RE[provider].test(id)) return null;
  switch (provider) {
    case 'youtube':
      return `https://www.youtube-nocookie.com/embed/${id}?rel=0`;
    case 'vimeo':
      return `https://player.vimeo.com/video/${id}?dnt=1`;
    case 'loom':
      return `https://www.loom.com/embed/${id}`;
    case 'spotify':
      return `https://open.spotify.com/embed/${id}`;
    case 'google_maps':
      return `https://www.google.com/maps?q=${encodeURIComponent(id)}&output=embed`;
  }
}

export function EmbedView({ section, ctx }: BlockViewProps) {
  const p = readProps(embedProps, section.props);
  const src = p.provider && p.embedId ? embedSrc(p.provider, p.embedId) : null;
  const title = txt(ctx, p.title);
  return (
    <>
      <SectionHeading ctx={ctx} heading={title} />
      {src && ctx.mode === 'live' ? (
        <ClickToLoadFrame
          src={src}
          title={title}
          label={
            p.provider === 'spotify'
              ? 'Play the playlist'
              : p.provider === 'google_maps'
                ? 'Show the map'
                : 'Play the video'
          }
          aspect={p.provider === 'spotify' ? '16 / 5' : '16 / 9'}
        />
      ) : (
        <div className="ev-embed ev-embed--idle" aria-hidden="true">
          <span className="ev-embed__play" />
          <span className="ev-embed__label">
            {src ? 'Loads when a guest taps it' : 'Paste a video, playlist or map link'}
          </span>
        </div>
      )}
      {p.caption ? <p className="ev-caption">{txt(ctx, p.caption)}</p> : null}
    </>
  );
}

export function GuestWallView({ section, ctx }: BlockViewProps) {
  const p = readProps(guestWallProps, section.props);
  const mode = ctx.rsvp?.registration.guestWall ?? 'hidden';
  // The list itself comes from the guest service when Registration allows it;
  // nothing about other guests is rendered here.
  if (mode === 'hidden' && !ctx.studio) return null;
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} placeholder="Who's going" />
      {p.note ? <p className="ev-lede">{txt(ctx, p.note)}</p> : null}
      <StudioHint ctx={ctx}>
        Guests appear here as Registration → Guest wall allows (hidden for invite-only events).
      </StudioHint>
    </>
  );
}

export function JoinRemoteView({ section, ctx }: BlockViewProps) {
  const p = readProps(joinRemoteProps, section.props);
  const href = linkOf(p.href);
  const replay = linkOf(p.replayHref);
  return (
    <div className="ev-card ev-remote">
      <Video aria-hidden="true" className="ev-remote__icon" />
      <div>
        <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} placeholder="Joining remotely" />
        <Rich ctx={ctx} source={p.body} />
        <div className="ev-remote__actions">
          {href ? (
            <EvButton ctx={ctx} href={href} external>
              {txt(ctx, p.label) || 'Join the call'}
            </EvButton>
          ) : (
            <StudioHint ctx={ctx}>Add the call link (owners only).</StudioHint>
          )}
          {replay ? (
            <EvButton ctx={ctx} href={replay} external variant="secondary">
              Watch the replay
            </EvButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const ICONS = {
  shirt: Shirt,
  plane: Plane,
  car: Car,
  hotel: Hotel,
  sun: Sun,
  info: Info,
  gift: Gift,
  utensils: Utensils,
} as const;

export function InfoCardsView({ section, ctx }: BlockViewProps) {
  const p = readProps(infoCardsProps, section.props);
  const items = (p.items ?? []).filter((c) => c.title);
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} />
      <ul className="ev-info-cards" data-variant={section.variant}>
        {items.map((card, i) => {
          const Icon = ICONS[card.icon ?? (section.variant === 'travel' ? 'plane' : 'shirt')];
          return (
            <li key={i} className="ev-card ev-info-card">
              <Icon aria-hidden="true" className="ev-info-card__icon" />
              <p className="ev-info-card__title">{txt(ctx, card.title)}</p>
              <Rich ctx={ctx} source={card.body} />
            </li>
          );
        })}
      </ul>
      {!items.length ? (
        <StudioHint ctx={ctx}>Add cards in the panel on the right.</StudioHint>
      ) : null}
    </>
  );
}
