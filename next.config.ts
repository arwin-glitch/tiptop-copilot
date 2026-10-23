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
