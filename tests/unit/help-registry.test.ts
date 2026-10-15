import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HELP_PAGES,
  helpPage,
  helpPageForPath,
  isTourId,
  pinNumber,
  tourSteps,
} from '@/lib/help/registry';
import { CARD_GAP, EDGE_MARGIN, placeCard, visiblePart } from '@/lib/help/placement';
import { GRAND_TOUR_ID, navTourId } from '@/lib/help/tour-ids';
import { DEALS_TABS, RECORDS_TABS } from '@/lib/records-tabs';

/**
 * The help centre and the guided tours are data (lib/help/registry.ts), and
 * data drifts from the screens it describes. These checks hold it to the
 * code: every page in the navigation has an entry, every step points at an
 * element that really carries its `data-tour` attribute, the Records tab
 * labels are the tab bars' own, and the copy stays short enough to read at a
 * glance.
 */

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Every file outside lib/help, which is where the targets are only named. */
const FILES = sourceFiles(SRC)
  .filter((file) => !relative(SRC, file).split(sep).join('/').startsWith('lib/help/'))
  .map((file) => ({ file, text: readFileSync(file, 'utf8') }));

const NAV_SOURCE = readFileSync(join(SRC, 'components', 'shell', 'nav.tsx'), 'utf8');

/** The hrefs in NAV_ITEMS, read from the source: the module is a client component. */
const NAV_HREFS = (() => {
  const block = NAV_SOURCE.slice(
    NAV_SOURCE.indexOf('export const NAV_ITEMS'),
    NAV_SOURCE.indexOf('] as const;'),
  );
  return [...block.matchAll(/href: '([^']+)'/g)].map((m) => m[1]!);
})();

/** Literal `data-tour="..."` values anywhere in the app. */
const LITERAL_TARGETS = new Set(
  FILES.flatMap(({ text }) => [...text.matchAll(/data-tour="([^"]+)"/g)].map((m) => m[1]!)),
);

const words = (text: string) => text.trim().split(/\s+/).length;

const allSteps = () => [
  ...HELP_PAGES.flatMap((page) => page.steps.map((step) => ({ page: page.id, step }))),
  ...tourSteps(GRAND_TOUR_ID).map((step) => ({ page: GRAND_TOUR_ID, step })),
];

describe('the help registry covers the app', () => {
  it('reads the navigation it is checked against', () => {
    expect(NAV_HREFS).toContain('/today');
    expect(NAV_HREFS).toContain('/settings');
    expect(NAV_HREFS).toContain('/help');
  });

  it('has an entry for every page in the navigation, and nothing that is not one', () => {
    const helpHrefs = HELP_PAGES.flatMap((p) => (p.href ? [p.href] : []));
    for (const href of NAV_HREFS) {
      if (href === '/help') continue;
      expect(helpHrefs, `no help entry for ${href}`).toContain(href);
    }
    for (const href of helpHrefs) expect(NAV_HREFS).toContain(href);
    expect(new Set(HELP_PAGES.map((p) => p.id)).size).toBe(HELP_PAGES.length);
  });

  it('lists the pages in navigation order, with the Ask Arwin widget last', () => {
    const order = HELP_PAGES.flatMap((p) => (p.href ? [p.href] : []));
    expect(order).toEqual(NAV_HREFS.filter((h) => h !== '/help'));
    const ask = HELP_PAGES[HELP_PAGES.length - 1];
    expect(ask?.id).toBe('ask');
    expect(ask?.href).toBeNull();
  });

  it('puts Help in the System group of the navigation', () => {
    expect(NAV_SOURCE).toMatch(/label: 'System', hrefs: \['\/settings', '\/help'\]/);
  });
});

describe('every tour step points at something real', () => {
  it('names only targets that exist in the code', () => {
    for (const { page, step } of allSteps()) {
      if (step.target.startsWith('nav-')) {
        expect(
          NAV_HREFS.map(navTourId),
          `${page}: ${step.target} is not a navigation entry`,
        ).toContain(step.target);
      } else {
        expect(LITERAL_TARGETS, `${page}: no element has data-tour="${step.target}"`).toContain(
          step.target,
        );
      }
    }
  });

  it('marks both the sidebar and the bottom bar entries with their tour target', () => {
    expect(NAV_SOURCE.match(/data-tour=\{navTourId\(item\.href\)\}/g)).toHaveLength(2);
    expect(NAV_SOURCE.match(/data-tour="main-nav"/g)).toHaveLength(2);
  });

  it('names nav targets after their path', () => {
    expect(navTourId('/today')).toBe('nav-today');
    expect(navTourId('/fund-ii')).toBe('nav-fund-ii');
    expect(navTourId('/updates')).toBe('nav-updates');
  });

  it('starts each page tour where the page lives in the menu', () => {
    for (const page of HELP_PAGES) {
      if (!page.href) continue;
      expect(page.steps[0]?.target, page.id).toBe(navTourId(page.href));
    }
  });
});

describe('the copy stays short', () => {
  it('gives each page three to six steps', () => {
    for (const page of HELP_PAGES) {
      expect(page.steps.length, page.id).toBeGreaterThanOrEqual(3);
      expect(page.steps.length, page.id).toBeLessThanOrEqual(6);
    }
  });

  it('keeps titles to five words and bodies to twenty', () => {
    for (const { page, step } of allSteps()) {
      expect(words(step.title), `${page}: "${step.title}"`).toBeLessThanOrEqual(5);
      expect(words(step.body), `${page}: "${step.body}"`).toBeLessThanOrEqual(20);
      expect(step.body.trim()).not.toBe('');
    }
  });

  it('keeps every page purpose to one short line', () => {
    for (const page of HELP_PAGES) {
      expect(words(page.purpose), page.id).toBeLessThanOrEqual(16);
    }
  });

  it('speaks to the reader rather than about Nick', () => {
    for (const { page, step } of allSteps()) {
      expect(`${step.title} ${step.body}`, page).not.toMatch(/\bNick\b/);
    }
  });
});

describe('subtabs', () => {
  it("are the Records tab bars' own labels, in order, with their links", () => {
    for (const config of RECORDS_TABS) {
      const page = HELP_PAGES.find((p) => p.href === config.path);
      expect(page, config.path).toBeDefined();
      expect(page?.subtabs.map((t) => t.label)).toEqual(config.tabs.map((t) => t.label));
      expect(page?.subtabs[0]?.href).toBe(config.path);
    }
  });

  it("give Deals its own tab bar's labels and links", () => {
    expect(helpPage('deals')?.subtabs.map((t) => t.label)).toEqual(
      DEALS_TABS.tabs.map((t) => t.label),
    );
    expect(helpPage('deals')?.subtabs[0]?.href).toBe(DEALS_TABS.path);
  });

  it('word the subtab step from the same labels', () => {
    const portfolio = helpPage('portfolio');
    const step = portfolio?.steps.find((s) => s.target === 'subtabs');
    expect(step?.body).toBe(
      'Health · Requests · Numbers · Companies · Founders · Angel. Tap one to switch.',
    );
  });

  it('name tabs that really exist on the other pages', () => {
    const text = (path: string) => readFileSync(join(SRC, ...path.split('/')), 'utf8');
    const where: Record<string, string> = {
      tasks: text('components/tasks/tasks-tabs.tsx'),
      inbox: text('components/inbox/live-inbox.tsx'),
      settings: text('app/(app)/settings/page.tsx').replace(/&amp;/g, '&'),
    };
    for (const [id, source] of Object.entries(where)) {
      const page = helpPage(id);
      expect(page?.subtabs.length, id).toBeGreaterThan(0);
      for (const tab of page?.subtabs ?? []) {
        expect(source, `${id}: tab "${tab.label}"`).toContain(tab.label);
      }
    }
  });
});

describe('the sketches', () => {
  it('stay on their grid and pin only steps of their own tour', () => {
    for (const page of HELP_PAGES) {
      for (const block of page.sketch) {
        expect(block.x + block.w, page.id).toBeLessThanOrEqual(24.01);
        expect(block.y + block.h, page.id).toBeLessThanOrEqual(16.01);
        if (block.pin)
          expect(pinNumber(page, block.pin), `${page.id}: ${block.pin}`).toBeGreaterThan(0);
      }
    }
  });

  it('pin every step that is drawn on the page (all but the menu entry)', () => {
    for (const page of HELP_PAGES) {
      const pinned = new Set(page.sketch.flatMap((b) => (b.pin ? [b.pin] : [])));
      for (const step of page.steps) {
        if (step.target.startsWith('nav-')) continue;
        // Ask Arwin's "Ask about today" lives on Today, not in the widget's sketch.
        if (page.id === 'ask' && step.target === 'today-ask') continue;
        expect(pinned, `${page.id}: ${step.target} has no pin`).toContain(step.target);
      }
    }
  });

  it('number a pin by its first step, so a step that returns keeps its number', () => {
    const ask = helpPage('ask');
    expect(ask && pinNumber(ask, 'ask-launcher')).toBe(1);
    expect(ask && pinNumber(ask, 'nothing-here')).toBe(0);
  });
});

describe('tours', () => {
  it('resolve each page tour onto its own page', () => {
    const deals = tourSteps('deals');
    expect(deals.length).toBe(helpPage('deals')?.steps.length);
    expect(deals.every((s) => s.path === '/deals' && s.pageName === 'Deals')).toBe(true);
    // The widget's tour runs on whatever page is open.
    expect(tourSteps('ask').every((s) => s.path === null)).toBe(true);
  });

  it('walk the 2-minute tour through every page in menu order, briefly', () => {
    const grand = tourSteps(GRAND_TOUR_ID);
    expect(grand[0]?.target).toBe('main-nav');
    expect(grand[grand.length - 1]?.target).toBe(navTourId('/help'));
    expect(grand.length).toBeLessThanOrEqual(20);
    const pages = grand.slice(1, -1).map((s) => s.pageName);
    expect(pages).toEqual(HELP_PAGES.map((p) => p.name));
  });

  it('know which ids can start', () => {
    expect(isTourId('today')).toBe(true);
    expect(isTourId(GRAND_TOUR_ID)).toBe(true);
    expect(isTourId('nope')).toBe(false);
    expect(tourSteps('')).toEqual([]);
  });

  it('match the "?" button to the exact page only', () => {
    expect(helpPageForPath('/deals')?.id).toBe('deals');
    expect(helpPageForPath('/updates')?.id).toBe('reports');
    expect(helpPageForPath('/deals/123')).toBeUndefined();
    expect(helpPageForPath('/help')).toBeUndefined();
  });
});

describe('placing the tour card', () => {
  const desktop = { width: 1366, height: 860 };
  const phone = { width: 412, height: 915 };
  const card = { width: 352, height: 200 };

  it('floats below a target when there is room', () => {
    const target = { top: 100, left: 500, width: 200, height: 40 };
    const pos = placeCard(target, card, desktop, 'bottom');
    expect(pos).toEqual({ mode: 'float', top: 100 + 40 + CARD_GAP, left: 600 - 176 });
  });

  it('flips to the other side when the preferred one has no room', () => {
    const target = { top: 760, left: 500, width: 200, height: 40 };
    const pos = placeCard(target, card, desktop, 'bottom');
    expect(pos.mode).toBe('float');
    if (pos.mode === 'float') expect(pos.top).toBe(760 - CARD_GAP - card.height);
  });

  it('keeps the card inside the window', () => {
    const target = { top: 300, left: 1300, width: 60, height: 40 };
    const pos = placeCard(target, card, desktop, 'bottom');
    if (pos.mode !== 'float') throw new Error('expected a floating card');
    expect(pos.left + card.width).toBeLessThanOrEqual(desktop.width - EDGE_MARGIN);
    expect(pos.left).toBeGreaterThanOrEqual(EDGE_MARGIN);
  });

  it('sits beside a sidebar entry', () => {
    const target = { top: 180, left: 12, width: 230, height: 36 };
    const pos = placeCard(target, card, desktop, 'right');
    if (pos.mode !== 'float') throw new Error('expected a floating card');
    expect(pos.left).toBe(12 + 230 + CARD_GAP);
  });

  it('falls back to the bottom of the window around a target bigger than it', () => {
    const target = { top: -200, left: 0, width: 1366, height: 2000 };
    const pos = placeCard(target, card, desktop, 'top');
    expect(pos).toEqual({
      mode: 'float',
      top: desktop.height - card.height - EDGE_MARGIN,
      left: (desktop.width - card.width) / 2,
    });
  });

  it('docks on a phone, on the side that leaves the target showing', () => {
    expect(
      placeCard({ top: 150, left: 16, width: 380, height: 120 }, card, phone, 'bottom'),
    ).toEqual({ mode: 'dock', edge: 'bottom' });
    // A bottom-bar entry: the card goes to the top.
    expect(placeCard({ top: 850, left: 0, width: 80, height: 56 }, card, phone, 'right')).toEqual({
      mode: 'dock',
      edge: 'top',
    });
    // A tall target is read from its top, so the card keeps clear of it.
    expect(placeCard({ top: 300, left: 16, width: 380, height: 1400 }, card, phone, 'top')).toEqual(
      { mode: 'dock', edge: 'bottom' },
    );
    expect(placeCard(null, card, phone, 'top')).toEqual({ mode: 'dock', edge: 'bottom' });
  });

  it('measures only the part of a target inside the window', () => {
    expect(visiblePart({ top: -50, left: 10, width: 100, height: 200 }, desktop)).toEqual({
      top: 0,
      left: 10,
      width: 100,
      height: 150,
    });
  });
});
