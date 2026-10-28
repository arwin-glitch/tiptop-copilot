'use client';

import * as React from 'react';
import QRCode from 'qrcode';
import { Copy, Download, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * The share kit: the page link (copy, open), a QR code to download as PNG
 * or SVG for signage, and the share card guests see in messages. Links to
 * /e/* are plain anchors in a new tab, so the guest page loads with its own
 * policy and none of Kraken's chrome.
 */
export function ShareKit({
  path,
  published,
  ogImageUrl,
  title,
}: {
  path: string;
  published: boolean;
  ogImageUrl: string | null;
  title: string;
}) {
  const [url, setUrl] = React.useState(path);
  const [png, setPng] = React.useState<string | null>(null);

  React.useEffect(() => {
    const full = `${window.location.origin}${path}`;
    void QRCode.toDataURL(full, { margin: 1, width: 512, errorCorrectionLevel: 'M' }).then(
      (data) => {
        setUrl(full);
        setPng(data);
      },
    );
  }, [path]);

  const file =
    title
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'event';

  async function downloadSvg() {
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = `${file}-qr.svg`;
    a.click();
    URL.revokeObjectURL(href);
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
      <div className="min-w-0 space-y-3">
        <p className="text-sm">
          <span className="font-medium">Page link</span>
          <span className="block font-mono text-xs break-all text-[var(--fg-muted)]">{url}</span>
        </p>
        {!published ? (
          <p className="text-xs text-[var(--fg-muted)]">
            The link works once the page is published; until then it shows “not found”.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void navigator.clipboard?.writeText(url).then(
                () => toast.success('Link copied.'),
                () => toast.error('Copy did not work.'),
              )
            }
          >
            <Copy aria-hidden="true" />
            Copy link
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href={path} target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden="true" />
              Open page
            </a>
          </Button>
        </div>
        <div>
          <p className="mb-1 text-sm font-medium">Share card</p>
          {ogImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- the event's own published share card
            <img
              src={ogImageUrl}
              alt={`Share card for ${title}`}
              className="aspect-[1200/630] w-full max-w-sm rounded-md border border-[var(--border)] object-cover"
            />
          ) : (
            <p className="text-xs text-[var(--fg-muted)]">
              The share card is made from the theme when you publish.
            </p>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {png ? (
          // eslint-disable-next-line @next/next/no-img-element -- a generated data URL
          <img
            src={png}
            alt={`QR code for ${title}`}
            className="size-40 rounded-md border border-[var(--border)] bg-white p-1"
          />
        ) : (
          <div className="size-40 rounded-md bg-[var(--bg-sunken)]" aria-hidden="true" />
        )}
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" asChild disabled={!png}>
            <a href={png ?? '#'} download={`${file}-qr.png`}>
              <Download aria-hidden="true" />
              PNG
            </a>
          </Button>
          <Button size="sm" variant="secondary" onClick={() => void downloadSvg()}>
            <Download aria-hidden="true" />
            SVG
          </Button>
        </div>
      </div>
    </div>
  );
}
