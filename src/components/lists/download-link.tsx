'use client';

import * as React from 'react';
import { toast } from 'sonner';

/**
 * A link that downloads an export, and says so on screen when the export is
 * refused or fails.
 *
 * A plain `<a download>` saves whatever comes back: a refusal (403), a rate
 * limit (429) or a server error arrives as a file of JSON with nothing on
 * screen. So a plain click fetches the file instead, saves it when it is one
 * and shows the error as a toast when it is not. The element is still a real
 * link with `download`, so it works before hydration, and a modified click
 * (new tab, save link as) is left to the browser.
 */
export function DownloadLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
  'aria-label'?: string;
}) {
  const [busy, setBusy] = React.useState(false);

  const onClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch(href, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        const failure = await readFailure(response);
        toast.error(failure.message, { description: failure.stillUsable });
        return;
      }
      const blob = await response.blob();
      saveBlob(blob, filenameOf(response.headers.get('content-disposition')) ?? 'export');
      if (response.headers.get('x-export-truncated') === 'true') {
        const rows = Number(response.headers.get('x-export-rows') ?? '');
        toast.warning(
          Number.isFinite(rows) && rows > 0
            ? `Only the first ${rows.toLocaleString('en-US')} rows were exported.`
            : 'Only the first rows were exported.',
          { description: 'Narrow the view with a search or a filter to export the rest.' },
        );
      }
    } catch {
      toast.error('The export could not be downloaded: no connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <a
      {...rest}
      href={href}
      download
      onClick={onClick}
      aria-busy={busy || undefined}
      className={className}
      data-busy={busy || undefined}
    >
      {children}
    </a>
  );
}

/** The app's `{ ok: false, error }` body, or a plain message for anything else. */
async function readFailure(response: Response): Promise<{ message: string; stillUsable?: string }> {
  const fallback =
    response.status === 403
      ? 'You do not have permission to export this.'
      : response.status === 429
        ? 'Too many exports just now. Try again in a minute.'
        : 'The export could not be made just now. Try again.';
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown; stillUsable?: unknown };
    };
    const message = typeof body.error?.message === 'string' ? body.error.message : fallback;
    const stillUsable =
      typeof body.error?.stillUsable === 'string' ? body.error.stillUsable : undefined;
    return { message, stillUsable };
  } catch {
    return { message: fallback };
  }
}

/** The file name a Content-Disposition header gives, if any. */
export function filenameOf(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (encoded) {
    try {
      return decodeURIComponent((encoded[1] as string).trim().replace(/^"|"$/g, '')) || null;
    } catch {
      // Fall through to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
  const name = (plain?.[1] ?? plain?.[2] ?? '').trim();
  return name || null;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
