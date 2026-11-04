'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';

/** Pages drawn at most; Gmail's preview pages on too, the rest open in a new tab. */
const MAX_PAGES = 20;

interface PdfPage {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
    canvas: HTMLCanvasElement;
  }) => {
    promise: Promise<void>;
  };
}
interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
}

/**
 * A PDF attachment drawn page by page onto canvases with pdf.js, in this
 * page: no browser PDF plugin, no frame, and pdf.js runs no script from the
 * file (scripting off, eval off). The bytes come from the attachment route
 * as any download does.
 */
export function PdfPreview({ href, name }: { href: string; name: string }) {
  const holder = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<'loading' | 'ok' | 'failed'>('loading');
  const [more, setMore] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    let doc: PdfDoc | null = null;
    let worker: Worker | null = null;
    (async () => {
      try {
        const pdfjs = (await import('pdfjs-dist')) as unknown as {
          GlobalWorkerOptions: { workerPort: Worker | null };
          getDocument: (o: Record<string, unknown>) => { promise: Promise<PdfDoc> };
        };
        worker = new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), {
          type: 'module',
        });
        pdfjs.GlobalWorkerOptions.workerPort = worker;
        const res = await fetch(href);
        if (!res.ok) throw new Error('fetch');
        const data = new Uint8Array(await res.arrayBuffer());
        doc = await pdfjs.getDocument({
          data,
          isEvalSupported: false,
          enableScripting: false,
        }).promise;
        if (cancelled || !holder.current) return;
        const box = holder.current;
        box.replaceChildren();
        const count = Math.min(doc.numPages, MAX_PAGES);
        for (let n = 1; n <= count; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const width = Math.max(320, box.clientWidth - 16);
          const base = page.getViewport({ scale: 1 });
          const ratio = window.devicePixelRatio || 1;
          const viewport = page.getViewport({ scale: (width / base.width) * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${viewport.width / ratio}px`;
          canvas.style.height = `${viewport.height / ratio}px`;
          canvas.className = 'mx-auto mb-3 block bg-white shadow';
          canvas.setAttribute('aria-label', `${name}, page ${n}`);
          box.appendChild(canvas);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('canvas');
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
          if (n === 1 && !cancelled) setState('ok');
        }
        if (!cancelled) setMore(Math.max(0, doc.numPages - count));
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
      void doc?.destroy();
      worker?.terminate();
    };
  }, [href, name]);

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md bg-[var(--bg-sunken)] p-2">
      {state === 'loading' ? (
        <p className="flex items-center gap-2 p-4 text-sm text-[var(--fg-muted)]">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Opening the PDF…
        </p>
      ) : null}
      {state === 'failed' ? (
        <p className="p-4 text-sm text-[var(--fg-muted)]">
          This PDF could not be shown here. Use Download or Open in a new tab.
        </p>
      ) : null}
      <div ref={holder} data-pdf-pages />
      {more ? (
        <p className="p-2 text-center text-xs text-[var(--fg-muted)]">
          {more} more page{more === 1 ? '' : 's'}: open it in a new tab to see them all.
        </p>
      ) : null}
    </div>
  );
}
