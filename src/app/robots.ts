import type { MetadataRoute } from 'next';

/**
 * robots.txt. Copilot is a private tool, so crawlers are kept out of all of
 * it except published event pages (/e/<slug>, D-075). Even those stay out of
 * search results unless the event is public: each page sets noindex in its
 * own metadata otherwise.
 *
 * Personal and staff paths are disallowed outright, and proxy.ts and
 * next.config.ts send X-Robots-Tag: noindex on them as well: an invite's
 * token or an edit entry must never be crawled, cached or listed.
 * Longest match wins, so /e/edit beats Allow: /e/ and Allow: /e/ beats
 * Disallow: /.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/e/'],
      disallow: ['/e/edit', '/e/checkin', '/e/*/i/', '/e/*/c/', '/api/', '/'],
    },
  };
}
