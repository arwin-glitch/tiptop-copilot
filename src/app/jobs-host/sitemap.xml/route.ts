import { boardSitemapXml } from '@/components/jobs-board/pages';

/** The board's sitemap, at canonical addresses; empty while the board is off. */
/**
 * Rendered per request from the board's shared data cache (ten minutes, or
 * dropped at once when Kraken changes the board). Never prerendered at build:
 * the free server restarts from its build files when it wakes, and a page
 * saved at build time would show the build day's roles until it refreshed.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return new Response(await boardSitemapXml(), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
