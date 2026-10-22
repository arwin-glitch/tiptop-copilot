import { boardHostOrigin } from '@/lib/jobs-board/config';

/** jobs.tiptop.vc/robots.txt: the whole host is the public board. */
export const revalidate = 3600;

export function GET() {
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    'Sitemap: ' + boardHostOrigin() + '/sitemap.xml',
    '',
  ].join(String.fromCharCode(10));
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
