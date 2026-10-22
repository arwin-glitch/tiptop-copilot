import 'server-only';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageResponse } from 'next/og';
import type { MediaMap, OgImageInput, RenderOgImage } from '@/lib/events/contracts';
import { FONT_LIBRARY, fontFaceName } from '@/lib/events/fonts';
import { heroProps, readProps } from '@/lib/events/blocks/props';
import { orderedSections, type EventDoc, type FontId, type MediaRef } from '@/lib/events/schema';
import { isHex, mix } from '@/lib/events/theme/color';
import { engineColors, primaryPalette } from '@/lib/events/theme/tokens';

/**
 * The share card (D-075, WS2). Export kept from the contract:
 * `renderOgImage` (RenderOgImage in lib/events/contracts.ts).
 *
 * A 1200×630 PNG rendered from the THEME (palette, display font, background
 * colours), the title, date, venue and the cover photo, in one of three
 * layouts: cover (title over the cover or the theme's background), type
 * (typography only) and ticket. WS1's publish stores it at
 * event-media/og/<event>/v<n>.png, so the URL changes each version and
 * Slack, iMessage and LinkedIn fetch it again.
 *
 * next/og (Satori): flexbox only, WOFF/TTF fonts read from assets/og-fonts.
 * Returns null on any failure: publish proceeds without a card.
 */

const WIDTH = 1200;
const HEIGHT = 630;
const FONT_DIR = path.join(process.cwd(), 'assets', 'og-fonts');

type OgFont = { name: string; data: Buffer; weight: 400 | 600 | 700; style: 'normal' };

const fontCache = new Map<string, Buffer | null>();

async function loadFontFile(file: string): Promise<Buffer | null> {
  if (fontCache.has(file)) return fontCache.get(file) ?? null;
  try {
    const data = await readFile(path.join(FONT_DIR, file));
    fontCache.set(file, data);
    return data;
  } catch {
    fontCache.set(file, null);
    return null;
  }
}

async function fontsFor(ids: FontId[]): Promise<OgFont[]> {
  const out: OgFont[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const family = FONT_LIBRARY[id];
    if (!family) continue;
    for (const w of family.og) {
      const key = `${id}-${w}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const data = await loadFontFile(`${key}.woff`);
      if (data)
        out.push({
          name: fontFaceName(id),
          data,
          weight: (w >= 700 ? 700 : w >= 600 ? 600 : 400) as OgFont['weight'],
          style: 'normal',
        });
    }
  }
  return out;
}

function fmt(iso: string | null, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(d);
  }
}

function coverSrc(doc: EventDoc, media: MediaMap): string | null {
  const hero = orderedSections(doc.sections).find((s) => s.type === 'hero');
  if (!hero) return null;
  const props = readProps(heroProps, hero.props);
  const ref: MediaRef | null | undefined = props.media;
  const item = ref ? media[ref.mediaId] : null;
  if (!item || item.kind !== 'image' || item.status !== 'ready') return null;
  const best = [...item.variants]
    .filter((v) => (v.format === 'jpg' || v.format === 'png') && v.w > 0)
    .sort((a, b) => Math.abs(a.w - 1200) - Math.abs(b.w - 1200))[0];
  const src = best?.url ?? item.src;
  return src && /^(https?:|data:image\/(png|jpeg);)/.test(src) ? src : null;
}

function heroText(doc: EventDoc): { eyebrow: string; sub: string } {
  const hero = orderedSections(doc.sections).find((s) => s.type === 'hero');
  if (!hero) return { eyebrow: '', sub: '' };
  const p = readProps(heroProps, hero.props);
  const clean = (v: string | undefined) => (v && !v.includes('{{') ? v.trim() : '');
  return { eyebrow: clean(p.eyebrow), sub: clean(p.subheadline) };
}

/** Shorten at a word boundary with an ellipsis. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

function titleSize(title: string, base: number): number {
  const n = title.length;
  if (n <= 18) return base;
  if (n <= 32) return Math.round(base * 0.82);
  if (n <= 50) return Math.round(base * 0.66);
  return Math.round(base * 0.52);
}

/** Pure element builder (exported for tests): what the card shows, as Satori JSX. */
export function ogElement(input: OgImageInput, cover: string | null) {
  const { doc, facts, layout } = input;
  const theme = doc.theme;
  const p = primaryPalette(theme);
  const display = `'${fontFaceName(theme.typography.display)}'`;
  const body = `'${fontFaceName(theme.typography.body)}'`;
  const title = (doc.meta.seoTitle || facts.title).trim() || 'Event';
  const { eyebrow, sub } = heroText(doc);
  const date = fmt(facts.startsAt, facts.timeZone, {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const time = fmt(facts.startsAt, facts.timeZone, {
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).replace(':00', '');
  const venue = facts.venue?.name ?? '';
  const meta = [date, time, venue].filter(Boolean).join('  ·  ');
  const upper = theme.typography.displayCase === 'upper';
  const lockup = theme.brand.lockup
    .map((l) => l.name)
    .filter(Boolean)
    .join('  ×  ');
  const colors = engineColors(theme, p).filter((c) => isHex(c));
  const poster = [
    ...colors
      .slice(1, 4)
      .map(
        (c, i) =>
          `radial-gradient(circle at ${['18% 25%', '85% 20%', '70% 90%'][i]}, ${c} 0%, transparent 60%)`,
      ),
    `linear-gradient(160deg, ${colors[0] ?? p.bg}, ${mix(colors[0] ?? p.bg, colors.at(-1) ?? p.bg, 0.4)})`,
  ].join(', ');

  if (layout === 'ticket') {
    const month = fmt(facts.startsAt, facts.timeZone, { month: 'short' }).toUpperCase();
    const day = fmt(facts.startsAt, facts.timeZone, { day: 'numeric' });
    return (
      <div
        style={{
          width: WIDTH,
          height: HEIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: p.bg,
          fontFamily: body,
        }}
      >
        <div
          style={{
            display: 'flex',
            width: 1040,
            height: 470,
            borderRadius: 28,
            background: p.surface,
            boxShadow: '0 30px 60px rgba(0,0,0,0.18)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              flex: 1,
              padding: '56px 60px',
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 22,
                letterSpacing: 6,
                color: p.highlight,
                textTransform: 'uppercase',
              }}
            >
              {eyebrow || 'Admit one'}
            </div>
            <div
              style={{
                display: 'flex',
                fontFamily: display,
                fontSize: titleSize(title, 84),
                lineHeight: 1.02,
                color: p.text,
                textTransform: upper ? 'uppercase' : 'none',
              }}
            >
              {title}
            </div>
            <div style={{ display: 'flex', fontSize: 26, color: p.muted }}>{meta}</div>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-around',
              alignItems: 'center',
              width: 26,
              padding: '24px 0',
              background: p.surface,
            }}
          >
            {Array.from({ length: 12 }, (_, i) => (
              <div key={i} style={{ width: 10, height: 10, borderRadius: 5, background: p.bg }} />
            ))}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              width: 250,
              background: p.accent,
              color: p.accentFg,
            }}
          >
            <div style={{ display: 'flex', fontSize: 34, letterSpacing: 8 }}>{month || 'SOON'}</div>
            <div style={{ display: 'flex', fontFamily: display, fontSize: 132, lineHeight: 1 }}>
              {day}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (layout === 'type') {
    return (
      <div
        style={{
          width: WIDTH,
          height: HEIGHT,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 84px',
          background: p.bg,
          color: p.text,
          fontFamily: body,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 22,
            letterSpacing: 5,
            color: p.highlight,
            textTransform: 'uppercase',
          }}
        >
          <div style={{ display: 'flex' }}>{eyebrow || date}</div>
          <div style={{ display: 'flex' }}>{lockup}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              width: 90,
              height: 3,
              background: p.highlight,
              marginBottom: 34,
            }}
          />
          <div
            style={{
              display: 'flex',
              fontFamily: display,
              fontSize: titleSize(title, 112),
              lineHeight: 1,
              letterSpacing: -1,
              textTransform: upper ? 'uppercase' : 'none',
            }}
          >
            {title}
          </div>
          {sub ? (
            <div
              style={{
                display: 'flex',
                marginTop: 26,
                fontSize: 30,
                lineHeight: 1.35,
                color: p.muted,
                maxWidth: 900,
              }}
            >
              {clip(sub, 110)}
            </div>
          ) : null}
        </div>
        <div style={{ display: 'flex', fontSize: 28, color: p.muted }}>{meta}</div>
      </div>
    );
  }

  // cover
  const textColor = cover ? '#FFFFFF' : p.text;
  const tone =
    colors.reduce(
      (s, c) =>
        s + parseInt(c.slice(1, 3), 16) + parseInt(c.slice(3, 5), 16) + parseInt(c.slice(5, 7), 16),
      0,
    ) / Math.max(1, colors.length * 3);
  const posterText = tone < 120 ? theme.paletteDark.text : theme.palette.text;
  const posterAccent = tone < 120 ? theme.paletteDark.highlight : theme.palette.highlight;
  return (
    <div
      style={{
        width: WIDTH,
        height: HEIGHT,
        display: 'flex',
        position: 'relative',
        background: cover ? '#111111' : poster,
        fontFamily: body,
      }}
    >
      {cover ? (
        // eslint-disable-next-line @next/next/no-img-element -- Satori renders plain <img>
        <img
          src={cover}
          width={WIDTH}
          height={HEIGHT}
          alt=""
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: WIDTH,
            height: HEIGHT,
            objectFit: 'cover',
          }}
        />
      ) : null}
      {cover ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: WIDTH,
            height: HEIGHT,
            display: 'flex',
            background:
              'linear-gradient(180deg, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.25) 40%, rgba(0,0,0,0.78) 100%)',
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: WIDTH,
          height: HEIGHT,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '64px 76px',
        }}
      >
        <div
          style={{
            display: 'flex',
            fontSize: 22,
            letterSpacing: 5,
            textTransform: 'uppercase',
            color: cover ? 'rgba(255,255,255,0.9)' : posterAccent,
          }}
        >
          {eyebrow || lockup || ' '}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontFamily: display,
              fontSize: titleSize(title, 108),
              lineHeight: 1,
              letterSpacing: -1,
              color: cover ? textColor : posterText,
              textTransform: upper ? 'uppercase' : 'none',
            }}
          >
            {title}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 28,
              fontSize: 28,
              color: cover ? 'rgba(255,255,255,0.88)' : posterText,
              opacity: cover ? 1 : 0.85,
            }}
          >
            {meta}
          </div>
        </div>
      </div>
    </div>
  );
}

export const renderOgImage: RenderOgImage = async (input) => {
  try {
    const theme = input.doc.theme;
    const fonts = await fontsFor([theme.typography.display, theme.typography.body, 'inter']);
    if (!fonts.length) return null;
    const element = ogElement(input, coverSrc(input.doc, input.media));
    const response = new ImageResponse(element, { width: WIDTH, height: HEIGHT, fonts });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length > 8 ? bytes : null;
  } catch {
    return null;
  }
};
