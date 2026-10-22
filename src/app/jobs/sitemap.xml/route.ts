import { boardSitemapXml } from '@/components/jobs-board/pages';

/** The board's sitemap, at canonical addresses; empty while the board is off. */
export const revalidate = 600;

export async function GET() {
  return new Response(await boardSitemapXml(), {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
