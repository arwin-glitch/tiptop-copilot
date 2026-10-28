import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Toaster } from 'sonner';
import { DesktopAlertOpener } from '@/components/desktop/desktop-alert-opener';
import { DesktopTitleBar } from '@/components/desktop/desktop-title-bar';
import { ServiceWorkerRegistrar } from '@/components/shell/service-worker';
import { DOMAIN_MOVE_SCRIPT } from '@/lib/brand/domain-move';
import { FRAME_BOOT_SCRIPT } from '@/lib/desktop/frame-boot';
import { NONCE_HEADER, SURFACE_HEADER } from '@/lib/events/surface';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'TipTop Kraken',
    template: '%s · TipTop Kraken',
  },
  description:
    'An internal investment cockpit for TipTop VC: daily outlook, inbox intelligence, deal triage and decision support.',
  applicationName: 'TipTop Kraken',
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

/**
 * Which surface this request is for: Kraken itself, an event page (/e, which
 * alone gets the nonce CSP) or the booking link (/meet). proxy.ts sets both
 * headers there and strips them everywhere else (lib/events/surface.ts).
 * Reading them makes every route render per request, which the signed-in
 * pages already did.
 */
async function requestSurface(): Promise<'app' | 'event' | 'booking'> {
  try {
    const h = await headers();
    if (h.get(SURFACE_HEADER) !== 'public') return 'app';
    return h.has(NONCE_HEADER) ? 'event' : 'booking';
  } catch {
    return 'app';
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Guests on /e and /meet get none of Kraken's chrome: no desktop title bar
  // or alert opener, and no service worker registration, so an LP never
  // installs Kraken's worker or sees its offline page. /e gets no theme
  // script either (an inline script its nonce CSP would refuse anyway); the
  // booking page keeps the theme half, since it follows the visitor's light
  // or dark setting (D-074), but not the desktop top-bar flag, as no bar is
  // drawn there.
  const surface = await requestSurface();
  const publicSurface = surface !== 'app';
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Static, self-authored constants with no external input: the move
            from copilot.tiptop.vc to kraken.tiptop.vc (lib/brand/domain-move.ts),
            the standard no-flash theme bootstrap, and the desktop app's top-bar
            flag (lib/desktop/frame-boot.ts). Neither can carry untrusted
            content. Every other surface in the app renders text through
            <PlainText>. */}
        {surface === 'event' ? null : (
          <script
            // eslint-disable-next-line no-restricted-syntax -- static constants, see above
            dangerouslySetInnerHTML={{
              __html:
                DOMAIN_MOVE_SCRIPT +
                (surface === 'booking' ? themeScript : themeScript + FRAME_BOOT_SCRIPT),
            }}
          />
        )}
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
        {publicSurface ? null : <DesktopTitleBar />}
        {/* Follows a click on a desktop alert (0.4.0 and newer); renders nothing. */}
        {publicSurface ? null : <DesktopAlertOpener />}
        {children}
        {publicSurface ? null : <ServiceWorkerRegistrar />}
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
