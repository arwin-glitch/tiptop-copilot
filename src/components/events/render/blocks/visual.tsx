import {
  ArrowUpRight,
  FileSpreadsheet,
  FileText,
  Link2,
  Lock,
  Presentation,
  Video,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { galleryProps, materialsProps, mediaProps, readProps } from '@/lib/events/blocks/props';
import type { BlockViewProps } from '../context';
import { fieldAttr } from '../context';
import { EmptyMediaSlot, EvImage, EvMedia, resolveMediaRef } from '../media';
import { linkOf, SectionHeading, StudioHint, txt } from './shared';

/** Gallery, Photo or video, and Materials. */

export function GalleryView({ section, ctx }: BlockViewProps) {
  const p = readProps(galleryProps, section.props);
  const images = (p.images ?? []).filter((img) => resolveMediaRef(ctx, img.media));
  const v = section.variant;
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} />
      {images.length ? (
        <ul className={`ev-gallery ev-gallery--${v}`}>
          {images.map((img, i) => (
            <li
              key={i}
              className="ev-gallery__item ev-stagger"
              style={{ '--i': String(i), '--r': `${((i * 37) % 7) - 3}deg` } as CSSProperties}
            >
              <figure>
                <EvImage
                  ctx={ctx}
                  media={img.media}
                  sizes={v === 'carousel' ? '80vw' : '(min-width: 900px) 33vw, 50vw'}
                />
                {img.caption ? <figcaption>{txt(ctx, img.caption)}</figcaption> : null}
              </figure>
            </li>
          ))}
        </ul>
      ) : (
        <div className="ev-gallery-empty">
          <EmptyMediaSlot ctx={ctx} label="Add photos" />
        </div>
      )}
    </>
  );
}

const ASPECT: Record<string, string | undefined> = {
  auto: undefined,
  '16:9': '16 / 9',
  '4:3': '4 / 3',
  '1:1': '1 / 1',
  '3:4': '3 / 4',
  '21:9': '21 / 9',
};

export function MediaView({ section, ctx }: BlockViewProps) {
  const p = readProps(mediaProps, section.props);
  const caption = txt(ctx, p.caption);
  return (
    <figure
      className="ev-media-block"
      style={{ aspectRatio: ASPECT[p.aspect ?? 'auto'] } as CSSProperties}
      data-aspect={p.aspect ?? 'auto'}
    >
      <EvMedia
        ctx={ctx}
        media={p.media}
        poster={p.poster}
        sizes="(min-width: 1200px) 1200px, 100vw"
        emptyLabel={section.variant === 'video' ? 'Add a video' : 'Add a photo'}
      />
      {caption ? <figcaption {...fieldAttr(ctx, 'caption')}>{caption}</figcaption> : null}
    </figure>
  );
}

const KIND_ICON = {
  deck: Presentation,
  doc: FileText,
  link: Link2,
  video: Video,
  sheet: FileSpreadsheet,
} as const;

export function MaterialsView({ section, ctx }: BlockViewProps) {
  const p = readProps(materialsProps, section.props);
  const items = (p.items ?? []).filter((m) => m.title);
  const intro = txt(ctx, p.intro);
  const gated = section.visibility.mode !== 'everyone';
  return (
    <>
      <SectionHeading ctx={ctx} heading={txt(ctx, p.heading)} placeholder="Materials" />
      {gated ? (
        <p className="ev-materials__gate">
          <Lock aria-hidden="true" /> Shared with you as a guest. Please keep these to yourself.
        </p>
      ) : null}
      {intro ? (
        <p className="ev-lede" {...fieldAttr(ctx, 'intro')}>
          {intro}
        </p>
      ) : null}
      {!items.length ? (
        <StudioHint ctx={ctx}>Add files or links in the panel on the right.</StudioHint>
      ) : null}
      <ul className={`ev-materials ev-materials--${section.variant}`}>
        {items.map((m, i) => {
          const file = resolveMediaRef(ctx, m.file);
          const href = file?.src ?? linkOf(m.href);
          const Icon = KIND_ICON[m.kind ?? (file ? 'doc' : 'link')];
          const body = (
            <>
              <span className="ev-materials__icon">
                <Icon aria-hidden="true" />
              </span>
              <span className="ev-materials__text">
                <span className="ev-materials__title">{txt(ctx, m.title)}</span>
                {m.description ? (
                  <span className="ev-materials__desc">{txt(ctx, m.description)}</span>
                ) : null}
              </span>
              {href ? <ArrowUpRight className="ev-materials__go" aria-hidden="true" /> : null}
            </>
          );
          return (
            <li
              key={i}
              className="ev-materials__item ev-stagger"
              style={{ '--i': String(i) } as CSSProperties}
            >
              {href && !ctx.studio && ctx.mode !== 'og' ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="ev-materials__link"
                >
                  {body}
                </a>
              ) : (
                <span className="ev-materials__link">{body}</span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
