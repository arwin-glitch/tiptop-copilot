import type { CSSProperties } from 'react';
import { thumbHashToDataURL } from 'thumbhash';
import type { ResolvedMedia } from '@/lib/events/contracts';
import type { MediaRef } from '@/lib/events/schema';
import { VideoLoop } from '@/components/events/effects/video-loop';
import type { RenderContext } from './context';

/**
 * Images and video on the page. URLs come ONLY from the MediaMap the route
 * resolved (public URLs for published media, short-lived signed URLs for
 * gated media); a component never builds a storage URL. A missing id renders
 * an "Add photo" slot in Studio and nothing on the live page.
 */

function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The blurred placeholder behind an image while it loads (thumbhash → tiny PNG data URL). */
export function placeholderUrl(media: ResolvedMedia): string | null {
  if (!media.thumbhash) return null;
  const bytes = decodeBase64(media.thumbhash);
  if (!bytes || bytes.length < 5 || bytes.length > 64) return null;
  try {
    return thumbHashToDataURL(bytes);
  } catch {
    return null;
  }
}

export function resolveMediaRef(
  ctx: RenderContext,
  ref: MediaRef | null | undefined,
): ResolvedMedia | null {
  if (!ref) return null;
  const media = ctx.media[ref.mediaId];
  return media && media.status !== 'failed' ? media : null;
}

function focalPosition(ref: MediaRef | null | undefined): string | undefined {
  if (!ref?.focal) return undefined;
  return `${Math.round(ref.focal.x * 100)}% ${Math.round(ref.focal.y * 100)}%`;
}

function srcSet(media: ResolvedMedia, format: string): string {
  return media.variants
    .filter((v) => v.format === format && v.w > 0)
    .sort((a, b) => a.w - b.w)
    .map((v) => `${v.url} ${v.w}w`)
    .join(', ');
}

export function EmptyMediaSlot({
  ctx,
  label = 'Add photo',
  className,
}: {
  ctx: RenderContext;
  label?: string;
  className?: string;
}) {
  if (!ctx.studio) return null;
  return (
    <div className={`ev-media-empty ${className ?? ''}`} data-empty-media="">
      <span>{label}</span>
    </div>
  );
}

export function EvImage({
  ctx,
  media: ref,
  className,
  sizes = '(min-width: 900px) 50vw, 100vw',
  priority = false,
  decorative = false,
  emptyLabel,
  style,
}: {
  ctx: RenderContext;
  media: MediaRef | null | undefined;
  className?: string;
  sizes?: string;
  priority?: boolean;
  decorative?: boolean;
  emptyLabel?: string;
  style?: CSSProperties;
}) {
  const media = resolveMediaRef(ctx, ref);
  if (!media || media.kind === 'file' || media.kind === 'video') {
    return <EmptyMediaSlot ctx={ctx} label={emptyLabel} className={className} />;
  }
  const fallback = media.src ?? media.variants.at(-1)?.url ?? null;
  if (!fallback) return <EmptyMediaSlot ctx={ctx} label={emptyLabel} className={className} />;
  const avif = srcSet(media, 'avif');
  const webp = srcSet(media, 'webp');
  const placeholder = placeholderUrl(media);
  const alt = decorative || media.decorative ? '' : (media.alt ?? '');
  return (
    <picture
      className={`ev-img ${className ?? ''}`}
      style={{
        ...(placeholder ? { backgroundImage: `url("${placeholder}")` } : {}),
        ...style,
      }}
    >
      {avif ? <source type="image/avif" srcSet={avif} sizes={sizes} /> : null}
      {webp ? <source type="image/webp" srcSet={webp} sizes={sizes} /> : null}
      <img
        src={fallback}
        alt={alt}
        width={media.width ?? undefined}
        height={media.height ?? undefined}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={priority ? 'high' : 'auto'}
        style={{ objectPosition: focalPosition(ref) }}
      />
    </picture>
  );
}

export function EvVideo({
  ctx,
  media: ref,
  poster: posterRef,
  className,
  autoplay = true,
}: {
  ctx: RenderContext;
  media: MediaRef | null | undefined;
  poster?: MediaRef | null;
  className?: string;
  autoplay?: boolean;
}) {
  const media = resolveMediaRef(ctx, ref);
  if (!media || media.kind !== 'video') {
    return <EmptyMediaSlot ctx={ctx} label="Add video" className={className} />;
  }
  const poster = resolveMediaRef(ctx, posterRef);
  const posterUrl = poster?.src ?? media.posterUrl ?? undefined;
  const sources = media.variants.filter((v) => v.format === 'mp4' || v.format === 'webm');
  const canPlay = autoplay && ctx.motion === 'full' && ctx.mode !== 'og';
  return (
    <VideoLoop
      className={`ev-video ${className ?? ''}`}
      poster={posterUrl}
      sources={
        sources.length
          ? sources.map((s) => ({ url: s.url, type: `video/${s.format}` }))
          : media.src
            ? [{ url: media.src, type: 'video/mp4' }]
            : []
      }
      autoplay={canPlay}
      label={media.alt ?? ''}
      objectPosition={focalPosition(ref)}
    />
  );
}

/** Image or video, whichever the media id is. */
export function EvMedia(props: {
  ctx: RenderContext;
  media: MediaRef | null | undefined;
  poster?: MediaRef | null;
  className?: string;
  sizes?: string;
  priority?: boolean;
  emptyLabel?: string;
}) {
  const resolved = resolveMediaRef(props.ctx, props.media);
  if (resolved?.kind === 'video') {
    return (
      <EvVideo
        ctx={props.ctx}
        media={props.media}
        poster={props.poster}
        className={props.className}
      />
    );
  }
  return (
    <EvImage
      ctx={props.ctx}
      media={props.media}
      className={props.className}
      sizes={props.sizes}
      priority={props.priority}
      emptyLabel={props.emptyLabel}
    />
  );
}
