import 'server-only';
import { escapeHtml } from './template';

/**
 * The few bits of public HTML the tracking routes serve: no app shell, no
 * session, nothing loaded from anywhere. Recipients land here from an email.
 */

/** 1x1 transparent GIF. */
export const PIXEL_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

export const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

export function publicPage(
  title: string,
  body: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f5ef; --fg: #1d2a24; --muted: #5b6b62; --card: #ffffff; --line: #d9d4c4; --primary: #1f5c45; --primary-fg: #ffffff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1a15; --fg: #ece8dc; --muted: #a9b5ad; --card: #16241d; --line: #2c3d34; --primary: #c9a54c; --primary-fg: #14201a; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 28rem; margin: 12vh auto 0; padding: 0 16px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  p { margin: 0 0 12px; color: var(--muted); }
  button { font: inherit; font-weight: 600; background: var(--primary); color: var(--primary-fg); border: 0; border-radius: 8px; padding: 10px 16px; min-height: 44px; cursor: pointer; }
  .from { margin-top: 16px; font-size: 0.875rem; color: var(--muted); }
</style></head>
<body><main><div class="card">${body}</div><p class="from">TipTop VC</p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, ...extraHeaders },
  });
}

export const invalidLinkPage = () =>
  publicPage(
    'Link not valid',
    '<h1>This link is not valid</h1><p>It may have been copied incompletely. Nothing was changed.</p>',
    404,
  );
