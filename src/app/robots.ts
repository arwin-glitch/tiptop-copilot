import type { MetadataRoute } from 'next';
import { appOrigin } from '@/lib/jobs-board/config';

/**
 * Kraken's own host: everything is private (and every page says noindex)
 * except the public job board at /jobs (D-077) and published event pages
 * (/e/<slug>, D-075). The board's own host (jobs.tiptop.vc) answers with
 * app/jobs-host/robots.txt instead.
 *
 * Event pages stay out of search results unless the event is public: each
 * page sets noindex in its own metadata otherwise. Personal and staff event
 * paths are disallowed outright, and proxy.ts and next.config.ts send
 * X-Robots-Tag: noindex on them as well: an invite's token or an edit entry
 * must never be crawled, cached or listed. Longest match wins, so /e/edit
 * beats Allow: /e/ and Allow: /e/ beats Disallow: /.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    // The board's own styles, scripts and fonts are allowed too, or search
    // engines would render its pages unstyled (and call them not mobile-friendly).
    rules: {
      userAgent: '*',
      allow: ['/jobs$', '/jobs/', '/_next/static/', '/icon.svg', '/e/'],
      disallow: ['/e/edit', '/e/checkin', '/e/*/i/', '/e/*/c/', '/api/', '/'],
    },
    sitemap: appOrigin() + '/jobs/sitemap.xml',
  };
}
