import type { MetadataRoute } from 'next';
import { appOrigin } from '@/lib/jobs-board/config';

/**
 * Copilot's own host: everything is private (and every page says noindex)
 * except the public job board at /jobs. The board's own host
 * (jobs.tiptop.vc) answers with app/jobs-host/robots.txt instead.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    // The board's own styles, scripts and fonts are allowed too, or search
    // engines would render its pages unstyled (and call them not mobile-friendly).
    rules: {
      userAgent: '*',
      allow: ['/jobs$', '/jobs/', '/_next/static/', '/icon.svg'],
      disallow: '/',
    },
    sitemap: appOrigin() + '/jobs/sitemap.xml',
  };
}
