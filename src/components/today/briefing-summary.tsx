'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';

/**
 * The routine posts full content now (every section, not a teaser), which
 * makes for a wall of text on first paint — exactly what a card at the top
 * of the page should not be. Collapsed to a short preview by default; the
 * full text is already in the DOM, just clamped, so it stays searchable and
 * accessible without a second request.
 */
export function BriefingSummary({ summary }: { summary: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const isLong = summary.length > 320 || summary.split('\n').length > 6;

  return (
    <div>
      <p
        className="text-[15px] leading-relaxed whitespace-pre-line"
        style={
          expanded || !isLong
            ? undefined
            : {
                display: '-webkit-box',
                WebkitLineClamp: 4,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }
        }
      >
        {summary}
      </p>
      {isLong ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 -ml-2"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </div>
  );
}
