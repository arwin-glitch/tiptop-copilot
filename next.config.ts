import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // pdfjs-dist and mammoth are Node-only and must not be bundled for the browser.
  serverExternalPackages: ['pdfjs-dist', 'mammoth'],
  // Render's free plan builds with little memory, and `next build`'s own
  // TypeScript pass plus parallel page workers pushed it over the limit (the
  // deploy failed ~2 minutes in). Types are checked before every push
  // (`npx tsc --noEmit` is a required gate), so the build skips that pass and
  // collects pages with one worker.
  typescript: { ignoreBuildErrors: true },
  experimental: { cpus: 1 },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
      // Event pages (D-075): no Referer leaves an event page (a personal
      // invite's token is in its path). After the catch-all above, so this
      // value wins; proxy.ts sets the same, plus the page's nonce CSP.
      {
        source: '/e',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/e/:path*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      // The staff door list may open the camera (in-app QR scanner).
      {
        source: '/e/checkin/:path*',
        headers: [
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
      // Personal and staff paths are never indexed, whatever the event.
      ...[
        '/e/edit',
        '/e/edit/:path*',
        '/e/checkin',
        '/e/checkin/:path*',
        '/e/:slug/i/:path*',
        '/e/:slug/c/:path*',
      ].map((source) => ({
        source,
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' }],
      })),
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
