'use client';

import * as React from 'react';
import { withInlineImages } from '@/lib/email/email-html';
import type { AttachmentRef } from '@/lib/services/inbox-live';

/**
 * An email shown as the sender laid it out: their signature logo, tables,
 * colours and links, like Gmail. The HTML is cleaned on the server
 * (lib/email/email-html.ts) and shown here in a sandboxed frame that runs no
 * script at all (no allow-scripts), under its own content policy. Links open
 * in a new tab. Images written into the email (`cid:`) load from Kraken's
 * attachment link, so they show in place instead of as attachments.
 *
 * The quoted earlier messages (Gmail's and Outlook's markers) stay folded
 * until "Show quoted text".
 */

const QUOTE_MARKERS =
  /class=["'][^"']*\bgmail_quote\b|<blockquote\b[^>]*type=["']?cite|id=["']?divRplyFwdMsg|id=["']?appendonsend/i;

/** Whether the email carries earlier messages quoted below it. */
export function hasQuotedHtml(html: string): boolean {
  return QUOTE_MARKERS.test(html);
}

export function EmailFrame({
  messageId,
  html,
  inline,
  showQuoted,
}: {
  messageId: string;
  html: string;
  /** The email's own images (`cid:`), from inbox-live. */
  inline: readonly AttachmentRef[];
  showQuoted: boolean;
}) {
  const ref = React.useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = React.useState(120);

  const doc = React.useMemo(() => {
    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    const byCid = new Map(inline.filter((a) => a.cid).map((a) => [a.cid!, a]));
    const body = withInlineImages(html, (cid) => {
      const a = byCid.get(cid);
      if (!a) return null;
      const q = new URLSearchParams({ m: messageId, a: a.id, name: a.name, type: a.mimeType });
      return `${origin}/api/inbox/attachment?${q.toString()}`;
    });
    const hideQuotes = showQuoted
      ? ''
      : '.gmail_quote, blockquote[type="cite"], #divRplyFwdMsg, #divRplyFwdMsg ~ *, #appendonsend ~ * { display: none !important; }';
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data: ${origin}; style-src 'unsafe-inline' https:; font-src https: data:;">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; background: #ffffff; color: #1f2328; }
  body { padding: 14px 16px; font: 14px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #0b57d0; }
  ${hideQuotes}
</style></head><body>${body}</body></html>`;
  }, [html, inline, messageId, showQuoted]);

  // Grow to the email's own height, again when images arrive or the width changes.
  React.useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const d = frame.contentDocument;
      if (!d?.documentElement) return;
      const h = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0);
      if (h > 0) setHeight(Math.min(h + 2, 20_000));
    };
    const onLoad = () => {
      measure();
      const d = frame.contentDocument;
      if (d?.body && typeof ResizeObserver !== 'undefined') {
        observer?.disconnect();
        observer = new ResizeObserver(measure);
        observer.observe(d.body);
      }
      d?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
    };
    frame.addEventListener('load', onLoad);
    if (frame.contentDocument?.readyState === 'complete') onLoad();
    return () => {
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    };
  }, [doc]);

  return (
    <iframe
      ref={ref}
      title="Email"
      srcDoc={doc}
      // No allow-scripts: nothing in the email ever runs. Same origin only so
      // Kraken can read its height; links open in a new tab.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="block w-full rounded-md border border-[var(--border)] bg-white"
      style={{ height }}
    />
  );
}
