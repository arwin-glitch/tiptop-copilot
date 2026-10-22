import * as React from 'react';
import {
  DEFAULT_FALLBACKS,
  RSVP_LINK_PLACEHOLDER,
  isRsvpLinkUrl,
  mergeValue,
  type Block,
  type Inline,
} from '@/lib/campaigns/template';
import type { CampaignMerge } from '@/lib/types/domain';
import { cn } from '@/lib/util/cn';

/**
 * A campaign email as the recipient will read it, drawn from the same parsed
 * tree the server renders to HTML — as React elements, never as markup, so
 * nothing in a template or a merge value can run on this page. Filled merge
 * fields are tinted so a fallback stands out.
 */
export function EmailBody({
  blocks,
  merge,
  className,
}: {
  blocks: Block[];
  merge: CampaignMerge | null;
  className?: string;
}) {
  return (
    <div className={cn('space-y-3 text-sm leading-relaxed break-words', className)}>
      {blocks.map((block, i) => {
        if (block.t === 'p') {
          return (
            <p key={i}>
              <InlineNodes nodes={block.c} merge={merge} />
            </p>
          );
        }
        const List = block.t === 'ul' ? 'ul' : 'ol';
        return (
          <List key={i} className={cn('ml-5', block.t === 'ul' ? 'list-disc' : 'list-decimal')}>
            {block.items.map((item, j) => (
              <li key={j}>
                <InlineNodes nodes={item} merge={merge} />
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

function InlineNodes({ nodes, merge }: { nodes: Inline[]; merge: CampaignMerge | null }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.t) {
          case 'text':
            return <React.Fragment key={i}>{node.v}</React.Fragment>;
          case 'br':
            return <br key={i} />;
          case 'b':
            return (
              <strong key={i}>
                <InlineNodes nodes={node.c} merge={merge} />
              </strong>
            );
          case 'i':
            return (
              <em key={i}>
                <InlineNodes nodes={node.c} merge={merge} />
              </em>
            );
          case 'a':
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--accent)] underline underline-offset-2"
              >
                <InlineNodes nodes={node.c} merge={merge} />
              </a>
            );
          case 'rsvp': {
            // The recipient's personal RSVP link (event messages, D-075).
            const url = isRsvpLinkUrl(merge?.rsvp_link) ? merge.rsvp_link : null;
            const text = node.label ?? url ?? RSVP_LINK_PLACEHOLDER;
            return url ? (
              <a
                key={i}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title="{{rsvp_link}}: this person's own RSVP link"
                className="rounded-sm bg-[var(--accent-soft)] px-0.5 text-[var(--accent)] underline underline-offset-2"
              >
                {text}
              </a>
            ) : (
              <mark
                key={i}
                title="{{rsvp_link}}: each guest gets their own link when the email goes out"
                className="rounded-sm bg-[var(--warn-soft)] px-0.5 text-inherit"
              >
                {text}
              </mark>
            );
          }
          case 'merge': {
            const value = mergeValue(node.field, merge);
            const shown = value || (node.fallback ?? DEFAULT_FALLBACKS[node.field]);
            return (
              <mark
                key={i}
                title={value ? `{{${node.field}}}` : `{{${node.field}}} is empty: fallback shown`}
                className={cn(
                  'rounded-sm px-0.5 text-inherit',
                  value ? 'bg-[var(--accent-soft)]' : 'bg-[var(--warn-soft)]',
                )}
              >
                {shown}
              </mark>
            );
          }
        }
      })}
    </>
  );
}
