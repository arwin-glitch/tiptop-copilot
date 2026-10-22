import type { MetadataRoute } from 'next';
import { appOrigin } from '@/lib/jobs-board/config';

/**
 * Copilot's own host: everything is private (and every page says noindex)
 * except the public job board at /jobs. The board's own host
 * (jobs.tiptop.vc) answers with app/jobs-host/robots.txt instead.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: ['/jobs$', '/jobs/'], disallow: '/' },
    sitemap: appOrigin() + '/jobs/sitemap.xml',
  };
}
