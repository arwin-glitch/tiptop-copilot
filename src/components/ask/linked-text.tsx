import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/util/cn';
import { linkifyTrusted } from '@/lib/util/linkify';
import { stripSlackLinks } from '@/lib/util/slack-text';

/**
 * Answer text with links into trusted tools (Gmail, Calendar, Drive, Slack,
 * claude.ai, this app) made clickable and shortened to what they open. Any
 * other URL stays plain text — answers quote third-party email. Slack's link
 * markup is stripped first for answers stored before that was done on ingest.
 */
export function LinkedText({ text, className }: { text: string; className?: string }) {
  const parts = linkifyTrusted(stripSlackLinks(text));
  return (
    <span className={cn('whitespace-pre-line', className)}>
      {parts.map((part, i) =>
        part.type === 'text' ? (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        ) : (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            title={part.href}
            className="inline-flex items-center gap-0.5 font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            {part.label}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ),
      )}
    </span>
  );
}
