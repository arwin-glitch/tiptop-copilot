'use client';

import * as React from 'react';

/**
 * Share a role: copy its link, the phone's own share sheet when there is
 * one, or LinkedIn and X share pages (plain links: no third-party script on
 * the page). Only the role's public address and title are shared.
 */
export function ShareButtons({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = React.useState(false);
  const canShare = React.useSyncExternalStore(
    () => () => undefined,
    () => typeof navigator !== 'undefined' && typeof navigator.share === 'function',
    () => false,
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link', url);
    }
  };

  return (
    <div className="jb-share" aria-label="Share this role">
      <button type="button" className="jb-btn jb-btn-ghost jb-btn-small" onClick={copy}>
        {copied ? 'Link copied' : 'Copy link'}
      </button>
      {canShare ? (
        <button
          type="button"
          className="jb-btn jb-btn-ghost jb-btn-small"
          onClick={() => navigator.share({ title, url }).catch(() => undefined)}
        >
          Share
        </button>
      ) : null}
      <a
        className="jb-btn jb-btn-ghost jb-btn-small"
        href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        LinkedIn
      </a>
      <a
        className="jb-btn jb-btn-ghost jb-btn-small"
        href={`https://x.com/intent/post?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        X
      </a>
    </div>
  );
}
