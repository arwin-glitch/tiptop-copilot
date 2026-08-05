import type { MetadataRoute } from 'next';

export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'TipTop Copilot',
    short_name: 'TipTop',
    description:
      'An internal investment cockpit for TipTop VC: daily outlook, inbox intelligence, deal triage and decision support.',
    start_url: '/today',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#faf8f4',
    theme_color: '#faf8f4',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Today', short_name: 'Today', url: '/today' },
      { name: 'Inbox', short_name: 'Inbox', url: '/inbox' },
      { name: 'Ask TipTop', short_name: 'Ask', url: '/ask' },
    ],
  };
}
