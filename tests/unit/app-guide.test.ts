import { describe, expect, it } from 'vitest';
import {
  APP_GUIDE_SUGGESTIONS,
  answerAppQuestion,
  appGuideEntry,
  appGuideHints,
  appGuideIndex,
  helpCitation,
  isAppQuestion,
  judgeMatches,
  searchAppGuide,
  SYNONYMS,
  type AppGuideMatch,
} from '@/lib/help/app-guide';
import { HELP_PAGES, HELP_SECTIONS, isTourId } from '@/lib/help/registry';
import { helpActions } from '@/lib/chat/help-actions';
import type { Citation } from '@/lib/types/domain';

/**
 * Ask Arwin's map of Kraken. Everything it knows comes from the Help
 * registry, so these tests are mostly about staying in step with it: every
 * page findable by its own name, every hand-written synonym pointing at a
 * real entry, and the line between "where is…" questions (answered at once)
 * and questions about Nick's data (left to the full answer). Names in the
 * data-question examples are invented.
 */

describe('the index', () => {
  it('holds every page, every Help section, and the tabs without a section of their own', () => {
    const ids = new Set(appGuideIndex().map((e) => e.id));
    for (const page of HELP_PAGES) {
      expect(ids.has(page.id)).toBe(true);
      for (const tab of page.subtabs) {
        const section = HELP_SECTIONS.find((s) => s.parent === page.id && s.tab === tab.key);
        expect(ids.has(section ? section.id : `${page.id}:${tab.key}`)).toBe(true);
      }
    }
    for (const section of HELP_SECTIONS) expect(ids.has(section.id)).toBe(true);
  });

  it('gives every entry an in-app link and only tours that exist', () => {
    for (const entry of appGuideIndex()) {
      expect(entry.href, entry.id).toMatch(/^\/[^/]/);
      if (entry.tourId) {
        expect(isTourId(entry.tourId), entry.id).toBe(true);
        expect(entry.tourHref).toContain(`tour=${entry.tourId}`);
      }
    }
  });
});

describe('tab links', () => {
  it('links every tab past the first to that tab', () => {
    for (const page of HELP_PAGES) {
      // Inbox's tabs live inside the inbox client, not in the URL.
      if (page.id === 'inbox') continue;
      for (const tab of page.subtabs.slice(1)) {
        expect(tab.href, `${page.id}:${tab.key}`).toBeDefined();
        // A tab that links to another page (Settings › Booking link) is exempt.
        if (page.href && tab.href?.startsWith(page.href)) {
          expect(tab.href, `${page.id}:${tab.key}`).toContain(tab.key);
        }
      }
    }
  });

  it('opens Settings › Preferences on that tab, and Show me starts the tour there', () => {
    const answer = answerAppQuestion('How do I turn on phone alerts?');
    expect(answer?.matches[0]).toMatchObject({
      id: 'settings:preferences',
      href: '/settings?tab=preferences',
      tourHref: '/settings?tab=preferences&tour=settings',
    });
  });

  it('starts a tab tour on the tab, or on the page its link opens', () => {
    expect(appGuideEntry('booking:availability')?.tourHref).toBe(
      '/booking?tab=availability&tour=booking',
    );
    expect(appGuideEntry('settings:booking')).toMatchObject({
      href: '/booking',
      tourId: 'booking',
      tourHref: '/booking?tour=booking',
    });
  });
});

describe('synonyms', () => {
  it('each points at a real entry', () => {
    for (const s of SYNONYMS) expect(appGuideEntry(s.target), s.phrase).toBeDefined();
  });

  it('a weak synonym never makes an answer confident on its own', () => {
    // "intro" and "feedback" are also tab names (Intros, Feedback): a name is strong.
    const tabNames = new Set(['intro', 'feedback']);
    for (const s of SYNONYMS.filter((x) => x.weak && !tabNames.has(x.phrase))) {
      expect(answerAppQuestion(`where is the ${s.phrase}`), s.phrase).toBeNull();
    }
  });

  it('pins the synonyms added for common misses', () => {
    const targets = new Map(SYNONYMS.map((s) => [s.phrase, s.target]));
    expect(targets.get('opened the deck')).toBe('fund-ii:readers');
    expect(targets.get('connect')).toBe('settings:integrations');
    expect(targets.get('booking request')).toBe('booking:bookings');
    expect(targets.get('tour')).toBe('help');
  });

  it('each one finds the entry it names', () => {
    for (const s of SYNONYMS) {
      const ids = searchAppGuide(`where is ${s.phrase}`).map((m) => m.id);
      expect(ids, s.phrase).toContain(s.target);
    }
  });
});

describe('search ranking', () => {
  it.each(HELP_PAGES.map((p) => [p.name, p.id]))(
    'finds the %s page by its own name',
    (name, id) => {
      for (const q of [`Where is ${name}?`, `where's the ${name.toLowerCase()} page`]) {
        const verdict = judgeMatches(searchAppGuide(q));
        expect(verdict.kind, q).toBe('confident');
        if (verdict.kind === 'confident') expect(verdict.match.group, q).toBe(id);
      }
    },
  );

  it.each(HELP_SECTIONS.map((s) => [s.name, s.id]))(
    'finds the %s tab by its own name',
    (name, id) => {
      expect(searchAppGuide(`Where is ${name}?`)[0]?.id).toBe(id);
    },
  );

  it.each([
    ['Where are my snoozed tasks?', 'tasks:snoozed'],
    ['Where is the job board?', 'jobs'],
    ['How do I turn on phone alerts?', 'settings:preferences'],
    ['Which tab shows DocSend readers?', 'fund-ii:readers'],
    ['Where are meeting notes?', 'meetings:notes'],
    ['How do I give feedback on the app?', 'ask:feedback'],
    ['Where are wires and signatures?', 'tasks:money'],
    ['How do I import from Affinity?', 'knowledge:import'],
    ['Where do I find interns?', 'students'],
    ['How do I install the desktop app?', 'download'],
    ['Where are the intros I owe?', 'network:intros'],
    ['How do I set up the booking chatbot?', 'booking-chatbot'],
    ['What does the Numbers tab do?', 'portfolio:numbers'],
  ])('%s → %s', (q, id) => {
    const verdict = judgeMatches(searchAppGuide(q));
    expect(verdict.kind).toBe('confident');
    if (verdict.kind === 'confident') expect(verdict.match.id).toBe(id);
  });

  it('finds nothing for words Kraken does not use', () => {
    expect(searchAppGuide('where is the quantum flux capacitor')).toEqual([]);
    expect(searchAppGuide('where is it?')).toEqual([]);
  });

  it('offers a short list when two pages fit equally', () => {
    const match = (id: string, group: string, score: number, strong = true): AppGuideMatch => ({
      id,
      group,
      title: id,
      pageName: group,
      tabLabel: null,
      href: `/${group}`,
      tourId: null,
      tourHref: null,
      why: 'x',
      score,
      strong,
    });
    const verdict = judgeMatches([
      match('a', 'a', 16),
      match('a:tab', 'a', 15),
      match('b', 'b', 15),
      match('c', 'c', 10),
      match('d', 'd', 2),
    ]);
    expect(verdict.kind).toBe('ambiguous');
    if (verdict.kind === 'ambiguous')
      expect(verdict.matches.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    // A page and its own tab never compete.
    expect(judgeMatches([match('a', 'a', 10), match('a:tab', 'a', 10)]).kind).toBe('confident');
    expect(judgeMatches([match('a', 'a', 3)]).kind).toBe('none');
  });

  it('gives up rather than offer a list of weak or thin matches', () => {
    const match = (id: string, score: number, strong: boolean): AppGuideMatch => ({
      id,
      group: id,
      title: id,
      pageName: id,
      tabLabel: null,
      href: `/${id}`,
      tourId: null,
      tourHref: null,
      why: 'x',
      score,
      strong,
    });
    // Close, but the top score is under twice the confident line.
    expect(judgeMatches([match('a', 10, true), match('b', 9, true)]).kind).toBe('none');
    // High enough, but one choice is only a hint.
    expect(judgeMatches([match('a', 16, true), match('b', 14, false)]).kind).toBe('none');
  });

  it.each([
    ['where are my bookings', 'booking:bookings'],
    ['where do I see booking requests', 'booking:bookings'],
    ['where is the calendar', 'calendar'],
    ['where is the booking page', 'booking'],
    ['where can I see who opened the deck', 'fund-ii:readers'],
    ['where is the help page', 'help'],
    ['how do I connect google', 'settings:integrations'],
  ])('ranks the place the question names: %s → %s', (q, id) => {
    const verdict = judgeMatches(searchAppGuide(q));
    expect(verdict.kind, q).toBe('confident');
    if (verdict.kind === 'confident') expect(verdict.match.id, q).toBe(id);
  });
});

describe('isAppQuestion', () => {
  it.each([
    'Where is the job board?',
    "Where's my booking link?",
    'where can I see snoozed tasks',
    'How do I snooze a task?',
    'How can I turn on phone alerts?',
    'how to import from Affinity',
    'Which tab has DocSend readers?',
    'Which page shows intros?',
    'What does the Numbers tab do?',
    'What is the Going cold tab for?',
    "What's on the Reports page?",
    'Find the settings page',
    'Take me to Fund II',
    'Go to the calendar',
    'How does the booking page work?',
    'How to use the Inbox',
    'Where do I find meeting notes in Kraken?',
    'Is there a page for events?',
    'Where are the Follow-ups?',
    'How do I install the desktop app?',
    'Where do I give feedback?',
    'where is the today page',
    "where's the today tab",
    "where's the meetings page",
    'where is fund ii',
    'how do I add a deal',
    'how do i get to the inbox',
    'how to import from affinity',
    'how do I connect slack',
  ])('yes: %s', (q) => {
    expect(isAppQuestion(q)).toBe(true);
  });

  it.each([
    'What did Acme say about the round?',
    'Who is Jane Placeholder?',
    'Summarise my meetings this week',
    'When is my next meeting?',
    "When's the board call?",
    'How is Examplify doing?',
    'How many deals came in this week?',
    'Did Jordan reply to my email?',
    "What's my next meeting?",
    'Where is my next meeting?',
    'Where is the dinner tonight?',
    'Where is Riley based?',
    'Where do I see Acme numbers?',
    'How do I reply to Jane about the deck?',
    'What needs my attention today?',
    'Give me a 30-second overview of the newest deal.',
    'Which portfolio companies need help?',
    'Draft a reply to the LP update',
    '',
  ])('no: %s', (q) => {
    expect(isAppQuestion(q)).toBe(false);
  });
});

/**
 * Questions about someone's mail, deals or meetings, typed the way people
 * type in chat (lowercase, no capitals to give names away), plus advice and
 * status questions. A wrong page pointer costs the real answer, so every one
 * of these must fall through. Names are invented.
 */
describe('data questions never get an instant answer', () => {
  it.each([
    // a name after from / for / about / with
    'where is the wire for acme',
    'where are the metrics for acme',
    'where are the kpis from beta corp',
    'where is my email from bob',
    'where are my emails from sarah',
    'how do i find the intro email from tom',
    'where is the pitch deck from acme',
    'where is the feedback from the founders',
    'where can i find the founders of acme',
    'how do I book a meeting with jane',
    'how do I add jane to the intros',
    // a possessive
    "where is nick's calendly link",
    "where do i see acme's numbers",
    // advice, or asking Arwin to act
    'how do I reply to jane about the intro?',
    'how do I say no to the pitch from zed',
    'how should I reply to the invoice email',
    'how should we respond to the docsend request',
    'how can we improve dealflow',
    'how can I help the portfolio with hiring',
    'how do we get the money in',
    'how can i reach the founder',
    'how do I contact the lawyer',
    'how do i get a meeting with them',
    'how can I connect with the founder',
    'how do I respond to the lp email',
    // status
    'where are we on the habu wire',
    'where are we on the wire',
    'where are we with fund ii',
    'where do things stand with the round',
    'where is the money',
    'where are the funds',
    'where is the wire for the habu deal?',
    // a time: their own notes and meetings
    'where are my notes from yesterday',
    "where do I find yesterday's notes",
    "where are today's meetings",
    "where is the recap from today's call",
    'where are my notes from monday',
    // a bare "where is the X" with only a hint, or two pages at once
    'where are the notes',
    'where are my reminders',
    'what did the lp say about the wire',
  ])('%s', (q) => {
    expect(answerAppQuestion(q)).toBeNull();
  });
});

describe('answerAppQuestion', () => {
  it('names the page and tab, then what it holds, and offers its tour', () => {
    const answer = answerAppQuestion('Where are my snoozed tasks?');
    expect(answer).not.toBeNull();
    if (!answer) return;
    const [first, second] = answer.content.split('\n');
    expect(first).toBe("It's on Tasks, in the Snoozed tab.");
    expect(second).toMatch(/\.$/);
    expect(answer.matches.map((m) => m.id)).toEqual(['tasks:snoozed']);
    expect(answer.showMe).toBe(true);
  });

  it('says the page for a page', () => {
    expect(answerAppQuestion('Where is Download?')?.content.split('\n')[0]).toBe(
      "It's on the Download page, in the menu.",
    );
  });

  it('leaves data questions and unknown places to the full answer', () => {
    expect(answerAppQuestion('What did Acme say about hiring?')).toBeNull();
    expect(answerAppQuestion('Where is the quantum flux capacitor?')).toBeNull();
  });

  it('quotes a reason that fits the question, or the plain purpose', () => {
    // A step sharing only the word "deal" (the deal sorter's) is not quoted.
    const deal = answerAppQuestion('how do I add a deal');
    expect(deal?.matches[0]?.id).toBe('deals');
    expect(deal?.content.split('\n')[1]).toBe(HELP_PAGES.find((p) => p.id === 'deals')?.purpose);
    // "email" is how the question found Inbox, not what to quote.
    const archive = answerAppQuestion('How do I archive an email?');
    expect(archive?.matches[0]?.id).toBe('inbox');
    expect(archive?.content).not.toContain('Compose');
  });

  it('points at Help itself', () => {
    const answer = answerAppQuestion('where is the help page');
    expect(answer?.matches[0]).toMatchObject({ id: 'help', href: '/help' });
    expect(answer?.showMe).toBe(false);
  });

  it('answers every suggested app question at once', () => {
    for (const q of APP_GUIDE_SUGGESTIONS) {
      const answer = answerAppQuestion(q);
      expect(answer, q).not.toBeNull();
      expect(answer?.matches).toHaveLength(1);
    }
  });

  it('never puts an em dash in an answer', () => {
    for (const page of HELP_PAGES) {
      expect(answerAppQuestion(`Where is ${page.name}?`)?.content ?? '').not.toContain('—');
    }
  });
});

describe('hints for the routine and the tool', () => {
  it('makes links absolute on the given origin and keeps only good matches', () => {
    const hints = appGuideHints('Where is the job board?', { origin: 'https://kraken.example/' });
    expect(hints[0]).toMatchObject({
      title: 'Portfolio › Jobs',
      page: 'Portfolio',
      tab: 'Jobs',
      link: 'https://kraken.example/portfolio?tab=jobs',
    });
    expect(hints[0]?.tour_link).toContain('https://kraken.example/portfolio?tab=jobs&tour=jobs');
    expect(hints.length).toBeLessThanOrEqual(3);
    expect(appGuideHints('What did Acme say?')).toEqual([]);
  });

  it('turns a match into a Help citation', () => {
    const [match] = searchAppGuide('Where is the job board?');
    const citation = helpCitation(match!, { tour: true });
    expect(citation).toMatchObject({
      id: 'help:jobs',
      kind: 'help',
      label: 'Portfolio › Jobs',
      url: '/portfolio?tab=jobs',
      section: 'Kraken Help',
    });
    expect(citation.tour_url).toContain('tour=jobs');
    expect(helpCitation(match!).tour_url).toBeNull();
  });
});

describe('helpActions (the buttons on an answer)', () => {
  const record: Citation = {
    id: 'deal:1',
    kind: 'deal',
    ref_id: '1',
    label: 'Examplify',
    page: null,
    section: null,
    url: null,
    occurred_at: null,
    retrieved_at: null,
    publisher: null,
    excerpt: null,
  };

  it('splits page buttons and Show me from record sources', () => {
    const [match] = searchAppGuide('Where are my snoozed tasks?');
    const actions = helpActions([record, helpCitation(match!, { tour: true })]);
    expect(actions.sources).toEqual([record]);
    expect(actions.links).toEqual([
      { key: 'help:tasks:snoozed', label: 'Tasks › Snoozed', href: '/tasks?view=snoozed' },
    ]);
    expect(actions.showMe).toEqual({
      key: 'help:tasks:snoozed:tour',
      label: 'Show me',
      href: '/tasks?view=snoozed&tour=tasks',
    });
  });

  it('never links outside the app', () => {
    const outside = {
      ...helpCitation(searchAppGuide('Where is Inbox?')[0]!, { tour: true }),
      url: 'https://elsewhere.example/x',
      tour_url: '//elsewhere.example/y',
    };
    const actions = helpActions([outside]);
    expect(actions.links).toEqual([]);
    expect(actions.showMe).toBeNull();
  });
});
