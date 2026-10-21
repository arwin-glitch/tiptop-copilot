import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThreadLinks } from '@/components/email/thread-links';
import {
  copilotThreadHref,
  inboxThreadParam,
  isGmailId,
  threadLinks,
} from '@/lib/email/thread-links';

/**
 * Every email link offers two places to read it: Copilot's Inbox
 * (`/inbox?thread=<id>`) and Gmail. Both are rebuilt from a validated hex id;
 * anything else gets no link at all. Every id and address is fictional.
 */

const ID = '0f00000000005101';
const MAILBOX = 'nick@tiptop.demo';

describe('the two places to read an email', () => {
  it('builds the Inbox deep link and the Gmail link from a hex id', () => {
    expect(copilotThreadHref(ID)).toBe(`/inbox?thread=${ID}`);
    expect(copilotThreadHref('0F00000000005101')).toBe(`/inbox?thread=${ID}`);
    expect(threadLinks(ID, MAILBOX)).toEqual({
      copilot: `/inbox?thread=${ID}`,
      gmail: `https://mail.google.com/mail/?authuser=nick%40tiptop.demo#all/${ID}`,
    });
    // No mailbox known: Gmail's first signed-in account.
    expect(threadLinks(ID, null)?.gmail).toBe(`https://mail.google.com/mail/u/0/#all/${ID}`);
  });

  it('gives nothing that is not a Gmail id a link', () => {
    for (const bad of ['', 'zz', 'javascript:alert(1)', '../inbox', `${ID}&x=1`, null, undefined]) {
      expect(isGmailId(bad)).toBe(false);
      expect(copilotThreadHref(bad)).toBeNull();
      expect(threadLinks(bad, MAILBOX)).toBeNull();
    }
  });

  it('reads the id an Inbox URL asks for, keeping a bad one to say so', () => {
    expect(inboxThreadParam({})).toBeNull();
    expect(inboxThreadParam({ thread: '  ' })).toBeNull();
    expect(inboxThreadParam({ thread: ID.toUpperCase() })).toBe(ID);
    expect(inboxThreadParam({ thread: [ID, 'ffffffffffff'] })).toBe(ID);
    expect(inboxThreadParam({ thread: 'not-an-id' })).toBe('not-an-id');
    expect(inboxThreadParam({ thread: 'x'.repeat(500) })).toHaveLength(100);
  });
});

describe('<ThreadLinks>', () => {
  const render = (props: Parameters<typeof ThreadLinks>[0]) =>
    renderToStaticMarkup(createElement(ThreadLinks, props));

  it('renders "Copilot" in this tab and "Gmail" in a new one, named for a screen reader', () => {
    const html = render({ id: ID, mailbox: MAILBOX, label: 'Mentoring this fall' });
    expect(html).toContain(`href="/inbox?thread=${ID}"`);
    expect(html).toContain('aria-label="Open in Copilot: Mentoring this fall"');
    expect(html).toContain('aria-label="Open in Gmail: Mentoring this fall"');
    expect(html).toContain(
      `href="https://mail.google.com/mail/?authuser=nick%40tiptop.demo#all/${ID}"`,
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/>Copilot<\/a>/);
    expect(html).toMatch(/>Gmail<\/a>/);
    // Only the Gmail link leaves the app.
    expect(html.match(/target="_blank"/g)).toHaveLength(1);
  });

  it('names the links plainly without a label, and draws icons alone when asked', () => {
    expect(render({ id: ID, mailbox: MAILBOX })).toContain('aria-label="Open in Copilot"');
    const icons = render({ id: ID, mailbox: MAILBOX, variant: 'icons' });
    expect(icons).toContain('title="Open in Gmail"');
    expect(icons).not.toMatch(/>Copilot<\/a>/);
  });

  it('renders nothing for an id that is not a Gmail id', () => {
    expect(render({ id: 'not-an-id', mailbox: MAILBOX })).toBe('');
    expect(render({ id: null, mailbox: MAILBOX })).toBe('');
  });
});
