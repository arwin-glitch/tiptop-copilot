import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { Blocks, Mrkdwn } from '@/components/updates/mrkdwn';
import { SetupBanner } from '@/components/updates/source-status';
import { UpdatePostCard } from '@/components/updates/update-card';
import { getUpdatesFeed } from '@/lib/runtime';
import { readUpdates, resetUpdatesCache, type UpdatesFeed } from '@/lib/services/updates';
import { inline, toBlocks } from '@/lib/updates/mrkdwn';
import type { Block, Seg, UpdatePost, UpdatesSnapshot } from '@/lib/updates/types';

/**
 * What actually reaches the page. Slack text is hostile input as far as the
 * markup is concerned: whatever it contains, the rendered HTML must hold no
 * script, no event handler and no `javascript:` URL, and every link must open
 * with rel="noreferrer". All text here is invented.
 */

const FIXED_NOW = new Date('2026-09-23T15:00:00Z');

function demoFeed(): UpdatesFeed {
  const f = getUpdatesFeed(FIXED_NOW);
  if (!f) throw new Error('demo mode always has a feed');
  return f;
}

async function demoSnapshot(): Promise<UpdatesSnapshot> {
  resetUpdatesCache();
  return readUpdates(demoFeed(), { now: FIXED_NOW });
}

function card(snapshot: UpdatesSnapshot, post: UpdatePost, compact = false): string {
  const view = snapshot.sources.find((v) => v.posts.includes(post));
  if (!view) throw new Error('post not in snapshot');
  return renderToStaticMarkup(
    createElement(UpdatePostCard, {
      post,
      source: view.source,
      now: FIXED_NOW,
      timeZone: 'America/Chicago',
      compact,
    }),
  );
}

/** Visible text of some markup, collapsed or not. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function assertSafe(markup: string): void {
  expect(markup).not.toMatch(/<script/i);
  expect(markup).not.toMatch(/<img/i);
  expect(markup).not.toMatch(/javascript:/i);
  // An event-handler attribute inside a tag. Escaped text (`&lt;img onerror=`)
  // cannot open a tag, so only real attributes can match.
  expect(markup).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  for (const anchor of markup.match(/<a\s[^>]*>/g) ?? []) {
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noreferrer"');
  }
}

const HOSTILE: Block[] = [
  ...toBlocks('&lt;script&gt;alert(1)&lt;/script&gt;'),
  ...toBlocks('• <javascript:alert(1)|x> and <JaVaScRiPt:alert(1)|y>'),
  ...toBlocks('<https://a.example/|"&gt;&lt;img src=x onerror=alert(1)&gt;>'),
  { type: 'para', lines: [[{ text: 'forged', href: 'javascript:alert(1)' }]] },
  { type: 'label', segs: [{ text: 'data', href: 'data:text/html,hi' }] },
];

describe('rendered markup', () => {
  it('never renders script, handlers or javascript: URLs from hostile text', () => {
    const markup = renderToStaticMarkup(createElement(Blocks, { blocks: HOSTILE }));
    assertSafe(markup);
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).toContain('forged');
  });

  it('re-checks a segment href at render time', () => {
    const forged: Seg[] = [{ text: 'click', href: 'javascript:alert(1)' }];
    const markup = renderToStaticMarkup(createElement(Mrkdwn, { segs: forged }));
    expect(markup).toBe('click');
  });

  it('renders allowed https and mailto links as anchors that open safely', () => {
    const markup = renderToStaticMarkup(
      createElement(Mrkdwn, {
        segs: inline('<https://decks.example/pitch/1|Deck> or <mailto:x@y.example>'),
      }),
    );
    expect(markup).toContain('href="https://decks.example/pitch/1"');
    expect(markup).toContain('href="mailto:x@y.example"');
    assertSafe(markup);
  });

  it('renders emphasis as elements, not markup strings', () => {
    const markup = renderToStaticMarkup(createElement(Mrkdwn, { segs: inline('*b* _i_ `c`') }));
    expect(markup).toContain('<strong');
    expect(markup).toContain('<em>');
    expect(markup).toContain('<code');
  });
});

describe('every demo card', () => {
  beforeEach(() => resetUpdatesCache());

  it('renders safely, collapsed, and without ledger lines or footers', async () => {
    const snapshot = await readUpdates(demoFeed(), { now: FIXED_NOW });
    let cards = 0;
    for (const view of snapshot.sources) {
      for (const post of view.posts) {
        for (const compact of [false, true]) {
          const markup = renderToStaticMarkup(
            createElement(UpdatePostCard, {
              post,
              source: view.source,
              now: FIXED_NOW,
              timeZone: 'America/Chicago',
              compact,
            }),
          );
          assertSafe(markup);
          expect(markup).not.toMatch(/Ledger|Sent using/);
          expect(markup).not.toMatch(/Roster v1\b/i);
          // Nothing starts open.
          expect(markup).not.toMatch(/<details[^>]*\sopen/);
          cards++;
        }
      }
    }
    expect(cards).toBeGreaterThan(10);
  });
});

describe('what a card keeps in view', () => {
  it("keeps a digest's open question visible and its run notes one click away", async () => {
    const snapshot = await demoSnapshot();
    const digest = snapshot.sources.find((v) => v.source.group === 'digest');
    const weekly = digest?.posts.find((p) => p.type === 'digest' && p.kind === 'weekly');
    const markup = card(snapshot, weekly as UpdatePost);
    const visible = text(markup.replace(/<details[\s\S]*?<\/details>/g, ''));
    expect(visible).toContain('Needs your call');
    expect(visible).toContain('Reply "add Harborview Notes"');
    expect(text(markup)).toContain('Run notes');
    expect(text(markup)).toContain('Running on ROSTER v2.');
  });

  it("previews a run's flag sentence when it has no attention list", async () => {
    const snapshot = await demoSnapshot();
    const digest = snapshot.sources.find((v) => v.source.group === 'digest');
    const supplemental = digest?.posts.find(
      (p) => p.type === 'digest' && p.kind === 'supplemental',
    );
    const markup = card(snapshot, supplemental as UpdatePost);
    const visible = text(markup.replace(/<details[\s\S]*?<\/details>/g, ''));
    expect(visible).toContain('One is time-sensitive: Gullwing Bikes');
  });

  it("shows people's replies to a report apart from the report", async () => {
    const snapshot = await demoSnapshot();
    const harbor = snapshot.sources.find((v) => v.source.key === 'harbor');
    const markup = text(card(snapshot, harbor?.posts[0] as UpdatePost));
    expect(markup).toContain('Replies · 1');
    expect(markup).toContain("Let's pass on Quillmark");
  });

  it('links each channel in the scope steps once the workspace is known', () => {
    const views = [
      {
        source: {
          key: 'a',
          group: 'dealflow' as const,
          label: 'Alpha',
          channelId: 'CDEMO0000A1',
          channelName: null,
          cadence: 'Weekly · Fri',
          staleAfterDays: 8,
          icon: 'rocket' as const,
        },
        access: { state: 'missing_scope' as const, needed: 'groups:history' },
        posts: [],
        lastPostAt: null,
        overdue: false,
        stale: null,
        channelUrl: 'https://demo-workspace.slack.com/archives/CDEMO0000A1',
        checkedAt: FIXED_NOW.toISOString(),
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(SetupBanner, {
        setup: { kind: 'missing_scope', needed: 'groups:history' },
        botHandle: 'copilot_demo_bot',
        views,
      }),
    );
    expect(markup).toContain('href="https://demo-workspace.slack.com/archives/CDEMO0000A1"');
    expect(text(markup)).toContain('the Alpha channel');
    expect(text(markup)).not.toMatch(/by itself/);
    assertSafe(markup);
  });
});
