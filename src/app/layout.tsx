import type { Metadata, Viewport } from 'next';
import { Toaster } from 'sonner';
import { DesktopAlertOpener } from '@/components/desktop/desktop-alert-opener';
import { DesktopTitleBar } from '@/components/desktop/desktop-title-bar';
import { ServiceWorkerRegistrar } from '@/components/shell/service-worker';
import { FRAME_BOOT_SCRIPT } from '@/lib/desktop/frame-boot';
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
  // Meta tags cannot read CSS variables: these are --bg from globals.css
  // (light :root and .dark). Keep them in step with it.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f1e4' },
    { media: '(prefers-color-scheme: dark)', color: '#0e0f0f' },
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
        {/* eslint-disable-next-line no-restricted-syntax -- two static,
            self-authored constants with no external input: the standard
            no-flash theme bootstrap, and the desktop app's top-bar flag
            (lib/desktop/frame-boot.ts). Neither can carry untrusted content.
            Every other surface in the app renders text through <PlainText>. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript + FRAME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh antialiased">
        {/* The skip link outranks the demo banner deliberately. Both used to sit
            on z-50, and the banner renders later in the document, so the first
            thing a keyboard user reached could be painted underneath it. */}
        <a
          href="#main"
          className="focus:shadow-lifted sr-only focus:not-sr-only focus:absolute focus:top-[calc(var(--titlebar-h)+0.5rem)] focus:left-2 focus:z-[var(--z-toast)] focus:rounded-md focus:bg-[var(--primary)] focus:px-3 focus:py-2 focus:text-sm focus:text-[var(--primary-fg)]"
        >
          Skip to content
        </a>
        {/* The desktop app's own title bar, on every page (login and offline
            too, so the window can always be moved and closed). Shown only in
            the app's main window from 0.3.0; after the skip link, so that
            stays the first Tab stop. */}
        <DesktopTitleBar />
        {/* Follows a click on a desktop alert (0.4.0 and newer); renders nothing. */}
        <DesktopAlertOpener />
        {children}
        <ServiceWorkerRegistrar />
        <Toaster
          position="bottom-right"
          // Above the phone tab bar, so an 8-second Undo toast never covers it.
          mobileOffset={{ bottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
          // No `theme` and no inline colours: every toast colour (surface,
          // edge, description, the Undo button, focus) is a token, set in the
          // Toasts block at the end of globals.css, so toasts follow the app's
          // own light/dark choice rather than Sonner's light default.
        />
      </body>
    </html>
  );
}
