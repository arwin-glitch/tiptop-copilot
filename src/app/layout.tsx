import type { Metadata, Viewport } from 'next';
import { Toaster } from 'sonner';
import { ServiceWorkerRegistrar } from '@/components/shell/service-worker';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'TipTop Copilot',
    template: '%s · TipTop Copilot',
  },
  description:
    'An internal investment cockpit for TipTop VC: daily outlook, inbox intelligence, deal triage and decision support.',
  applicationName: 'TipTop Copilot',
  appleWebApp: {
    capable: true,
    title: 'TipTop',
    statusBarStyle: 'default',
  },
  formatDetection: { telephone: false },
  // This is an internal tool holding confidential deal data. It should never
  // appear in a search index.
  robots: { index: false, follow: false, nocache: true },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
    apple: [{ url: '/apple-icon.png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#faf8f6' },
    { media: '(prefers-color-scheme: dark)', color: '#191212' },
  ],
};

/**
 * The theme class is applied before first paint so a dark-mode user never sees
 * a flash of the light theme. It reads a display preference only — no
 * authoritative or sensitive state is kept in localStorage anywhere in this app.
 */
const themeScript = `(function(){try{var t=localStorage.getItem('tiptop-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(t!=='light'&&d)){document.documentElement.classList.add('dark')}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* eslint-disable-next-line no-restricted-syntax -- a static,
            self-authored constant with no external input. This is the standard
            no-flash theme bootstrap; it cannot carry untrusted content. Every
            other surface in the app renders text through <PlainText>. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh antialiased">
        {/* The skip link outranks the demo banner deliberately. Both used to sit
            on z-50, and the banner renders later in the document, so the first
            thing a keyboard user reached could be painted underneath it. */}
        <a
          href="#main"
          className="focus:shadow-lifted sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[var(--z-toast)] focus:rounded-md focus:bg-[var(--accent)] focus:px-3 focus:py-2 focus:text-sm focus:text-[var(--accent-fg)]"
        >
          Skip to content
        </a>
        {children}
        <ServiceWorkerRegistrar />
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: 'var(--bg-raised)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
            },
          }}
        />
      </body>
    </html>
  );
}
