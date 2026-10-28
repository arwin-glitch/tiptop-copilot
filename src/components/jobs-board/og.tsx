import { ImageResponse } from 'next/og';
import { placeLine } from '@/lib/jobs-board/fields';
import { DEFAULT_BOARD_ACCENT } from '@/lib/jobs-board/public';
import { readPublicBoardCached } from '@/lib/services/jobs-board';

/**
 * The board's link-preview images (Open Graph): the board's emerald card
 * with TipTop's mark (brand green), a gold Jobs tag and hairline, a title and
 * a line under it. The same values as board.css. Public fields only.
 */

const OG = {
  bg: '#0C231C',
  glow: '#2E7D62',
  ink: '#EEE8D6',
  muted: '#BFCBBF',
  accent: '#45D6A0',
  gold: '#D4AF37',
  goldInk: '#D8B663',
  mark: '#0FC382',
};

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function boardOgImage({
  eyebrow,
  title,
  subtitle,
  accent = OG.accent,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  accent?: string;
}) {
  // The stock accent keeps the theme's lit emerald, as on the pages.
  const lit = accent.toUpperCase() === DEFAULT_BOARD_ACCENT.toUpperCase() ? OG.accent : accent;
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        background: OG.bg,
        backgroundImage: `radial-gradient(circle at 85% 0%, ${OG.glow}80, transparent 55%)`,
        color: OG.ink,
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <svg width="64" height="39" viewBox="0 0 139 84" fill={OG.mark}>
          <path d="M66.2955 26.3643L42.7802 83.8142L20.8093 83.8148L47.122 19.2074H6.98452L0 0H54.6497L66.2955 26.3643Z" />
          <path d="M72.3906 26.3643L95.9059 83.8142L117.877 83.8148L91.564 19.2074H131.702L138.686 0H84.0363L72.3906 26.3643Z" />
        </svg>
        <div style={{ display: 'flex', fontSize: 34, fontWeight: 800 }}>
          TipTop <span style={{ color: OG.muted, fontWeight: 500, marginLeft: 10 }}>VC</span>
        </div>
        <div
          style={{
            display: 'flex',
            marginLeft: 12,
            fontSize: 20,
            color: OG.goldInk,
            border: `2px solid ${OG.gold}`,
            borderRadius: 999,
            padding: '4px 16px',
            textTransform: 'uppercase',
            letterSpacing: 2,
          }}
        >
          Jobs
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            display: 'flex',
            width: 120,
            height: 2,
            marginBottom: 26,
            backgroundImage: `linear-gradient(90deg, ${OG.gold}, transparent)`,
          }}
        />
        <div
          style={{
            display: 'flex',
            fontSize: 26,
            color: lit,
            textTransform: 'uppercase',
            letterSpacing: 3,
          }}
        >
          {clip(eyebrow, 60)}
        </div>
        <div
          style={{
            display: 'flex',
            fontSize: 72,
            fontWeight: 800,
            lineHeight: 1.05,
            marginTop: 18,
          }}
        >
          {clip(title, 70)}
        </div>
        <div style={{ display: 'flex', fontSize: 32, color: OG.muted, marginTop: 22 }}>
          {clip(subtitle, 90)}
        </div>
      </div>
    </div>,
    OG_SIZE,
  );
}

/** The home page's card: no data, so it is built once. */
export function boardHomeOgImage() {
  return boardOgImage({
    eyebrow: 'TipTop VC · Portfolio jobs',
    title: 'Jobs at TipTop portfolio companies',
    subtitle: 'Open roles at the companies TipTop backs',
  });
}

/**
 * A role's card: its title and company. A role that is not public (or an
 * address nobody published) is a 404, never a drawn image: drawing costs real
 * CPU, and a made-up address must not be able to ask for it.
 */
export async function jobOgImage(companySlug: string, roleSlug: string) {
  const read = await readPublicBoardCached(false);
  const job =
    read.state === 'on'
      ? read.board.jobs.find((j) => j.companySlug === companySlug && j.slug === roleSlug)
      : undefined;
  if (read.state !== 'on' || !job) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const place = placeLine(job.locations, job.remote);
  return boardOgImage({
    eyebrow: job.companyName,
    title: job.title,
    subtitle: place ? `${place} · Apply at ${job.companyName}` : `Apply at ${job.companyName}`,
    accent: read.board.accent,
  });
}
