import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Arwin's rule: every email or thread link in Copilot offers two places to
 * read it, "Copilot" (the Inbox's reading pane, `/inbox?thread=<id>`) and
 * "Gmail". Pages and components draw those with `ThreadLinks` (or
 * `ThreadLinksForHref` for a Gmail link built earlier), never a bare Gmail
 * link of their own. This scan keeps new code from slipping back to a
 * Gmail-only link, and from the old `/inbox?message=` links the Inbox never
 * read.
 *
 * The few places allowed a Gmail link of their own are listed with why.
 */

const SRC = path.resolve(import.meta.dirname, '../../src');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** What builds or names a Gmail link to one email, or the Inbox's dead old link. */
const BARE_LINK: { name: string; re: RegExp }[] = [
  { name: 'gmailThreadUrl()', re: /\bgmailThreadUrl\(/ },
  { name: 'gmailMessageHref()', re: /\bgmailMessageHref\(/ },
  { name: 'a Gmail URL', re: /mail\.google\.com/ },
  { name: "Gmail's #all/<id>", re: /#all\// },
  { name: '/inbox?message=', re: /\/inbox\?message=/ },
];

/** File (from src) → the patterns it may use, and why. */
const ALLOWED: Record<string, { names: string[]; why: string }> = {
  'components/today/top-priorities.tsx': {
    names: ['gmailThreadUrl()'],
    why: "Arwin's rule: the Top priorities card keeps its single Gmail link.",
  },
  'components/inbox/live-inbox.tsx': {
    names: ['a Gmail URL', "Gmail's #all/<id>"],
    why: 'The Inbox is Copilot: its reading pane offers Gmail as the other place, "Try in Gmail" for a link it could not open, and Send in Gmail when sending is off.',
  },
  'components/followups/email-session-client.tsx': {
    names: ['a Gmail URL', "Gmail's #all/<id>"],
    why: 'Send in Gmail: finishing a reply there when sending is off, not a link to read an email.',
  },
  'components/tasks/task-dialogs.tsx': {
    names: ['a Gmail URL'],
    why: "A proof field's placeholder text, not a link.",
  },
  'app/(app)/tasks/page.tsx': {
    names: ['gmailMessageHref()'],
    why: 'Builds the "Seen sent" proof link, drawn through ThreadLinksForHref.',
  },
  'app/(app)/today/page.tsx': {
    names: ['gmailMessageHref()'],
    why: 'Builds the proof check view; its link is drawn through ThreadLinksForHref.',
  },
};

/** The pages and components that show email links: each draws them with ThreadLinks. */
const DRAWS_THREAD_LINKS = [
  'app/(app)/calendar/page.tsx',
  'app/(app)/deals/[id]/page.tsx',
  'app/(app)/follow-ups/page.tsx',
  'app/(app)/fund-ii/page.tsx',
  'app/(app)/portfolio/page.tsx',
  'app/(app)/portfolio/[id]/page.tsx',
  'app/(app)/today/page.tsx',
  'components/ask/linked-text.tsx',
  'components/calendar/event-panel.tsx',
  'components/campaigns/campaign-report.tsx',
  'components/evidence/source-drawer.tsx',
  'components/followups/full-email.tsx',
  'components/followups/relay-cards.tsx',
  'components/fund-ii/docsend-readers.tsx',
  'components/fund-ii/warm-paths.tsx',
  'components/network/record-relationship.tsx',
  'components/network/relationship-alerts.tsx',
  'components/network/students-interns.tsx',
  'components/portfolio/portfolio-jobs.tsx',
  'components/portfolio/portfolio-numbers.tsx',
  'components/tasks/completed-tasks.tsx',
  'components/tasks/money-legal-tasks.tsx',
  'components/tasks/proof-check.tsx',
  'components/today/sections.tsx',
  'components/updates/company-updates.tsx',
  'components/updates/mrkdwn.tsx',
  'components/updates/update-card.tsx',
];

const rel = (file: string) => path.relative(SRC, file).split(path.sep).join('/');

describe('email links in pages and components', () => {
  const ui = walk(SRC).filter((file) => /^(app|components)\//.test(rel(file)));

  it('finds the pages and components', () => {
    expect(ui.length).toBeGreaterThan(100);
  });

  it('offer Copilot and Gmail: no bare Gmail link outside the listed exceptions', () => {
    const offenders: string[] = [];
    for (const file of ui) {
      const name = rel(file);
      if (name === 'components/email/thread-links.tsx') continue;
      const allowed = ALLOWED[name]?.names ?? [];
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          for (const pattern of BARE_LINK) {
            if (pattern.re.test(line) && !allowed.includes(pattern.name)) {
              offenders.push(`${name}:${i + 1} ${pattern.name}`);
            }
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('keep every exception real, so a fixed one leaves the list', () => {
    for (const [name, { names, why }] of Object.entries(ALLOWED)) {
      expect(why.length, name).toBeGreaterThan(10);
      const source = readFileSync(path.join(SRC, ...name.split('/')), 'utf8');
      for (const pattern of BARE_LINK.filter((p) => names.includes(p.name))) {
        expect(pattern.re.test(source), `${name} no longer uses ${pattern.name}`).toBe(true);
      }
    }
  });

  it('draw their email links with ThreadLinks', () => {
    for (const name of DRAWS_THREAD_LINKS) {
      const source = readFileSync(path.join(SRC, ...name.split('/')), 'utf8');
      expect(source, name).toMatch(/from '@\/components\/email\/thread-links'/);
      expect(source, name).toMatch(/<ThreadLinks(ForHref)?\b/);
    }
  });
});
