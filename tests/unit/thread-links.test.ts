import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ThreadLinks, ThreadLinksForHref } from '@/components/email/thread-links';
import {
  copilotThreadHref,
  emailIdFromInboxHref,
  emailLinkId,
  inboxThreadParam,
  isGmailId,
  isSyncedEmailId,
  parseGmailThreadUrl,
  threadLinks,
  wantsGmail,
} from '@/lib/email/thread-links';

/**
 * Every email link offers two places to read it: Copilot's Inbox
 * (`/inbox?thread=<id>`) and Gmail. Both are rebuilt from a validated hex id;
 * anything else gets no link at all. Every id and address is fictional.
 */

const ID = '0f00000000005101';
const MAILBOX = 'nick@tiptop.demo';
/** Copilot's own id for a synced email (a UUID). */
const SYNCED = '00000000-0000-4000-8000-000000000400';

describe('the two places to read an email', () => {
  it('builds the Inbox deep link and the Gmail link from a hex id', () => {
    expect(copilotThreadHref(ID)).toBe(`/inbox?thread=${ID}`);
    expect(copilotThreadHref('0F00000000005101')).toBe(`/inbox?thread=${ID}`);
    expect(threadLinks(ID, MAILBOX)).toEqual({
      copilot: `/inbox?thread=${ID}`,
      gmail: `https://mail.google.com/mail/?authuser=nick%40tiptop.demo#all/${ID}`,
    });
    // No mailbox known where the link is drawn: by way of the Inbox, which
    // knows the connected mailbox (Gmail's /u/0/ opens whichever account the
    // browser signed in first).
    expect(threadLinks(ID, null)?.gmail).toBe(`/inbox?thread=${ID}&open=gmail`);
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
    // A synced email's id, and the older ?message= that briefs and bookmarks still carry.
    expect(inboxThreadParam({ thread: SYNCED.toUpperCase() })).toBe(SYNCED);
    expect(inboxThreadParam({ message: SYNCED })).toBe(SYNCED);
    expect(inboxThreadParam({ thread: ID, message: SYNCED })).toBe(ID);
  });

  it("links a synced email by Copilot's id, Gmail by way of the Inbox", () => {
    expect(isSyncedEmailId(SYNCED)).toBe(true);
    expect(isSyncedEmailId(ID)).toBe(false);
    expect(isGmailId(SYNCED)).toBe(false);
    expect(copilotThreadHref(SYNCED)).toBe(`/inbox?thread=${SYNCED}`);
    expect(threadLinks(SYNCED, MAILBOX)).toEqual({
      copilot: `/inbox?thread=${SYNCED}`,
      gmail: `/inbox?thread=${SYNCED}&open=gmail`,
    });
    expect(wantsGmail({ open: 'gmail' })).toBe(true);
    expect(wantsGmail({ open: ['gmail'] })).toBe(true);
    expect(wantsGmail({ open: 'copilot' })).toBe(false);
    expect(wantsGmail({})).toBe(false);
  });

  it("prefers a synced email's own Gmail id, so Gmail opens without a stop in the app", () => {
    expect(emailLinkId({ id: SYNCED, provider_message_id: ID })).toBe(ID);
    // The demo's fictional ids, or another provider's: Copilot's id.
    expect(emailLinkId({ id: SYNCED, provider_message_id: 'demo-msg-0400' })).toBe(SYNCED);
    expect(emailLinkId({ id: SYNCED })).toBe(SYNCED);
  });

  it('reads one Gmail email back out of a Gmail link, and nothing else', () => {
    expect(
      parseGmailThreadUrl(`https://mail.google.com/mail/?authuser=${MAILBOX}#all/${ID}`),
    ).toEqual({ id: ID, mailbox: MAILBOX });
    expect(
      parseGmailThreadUrl(`https://mail.google.com/mail/?authuser=nick%40tiptop.demo#inbox/${ID}`),
    ).toEqual({ id: ID, mailbox: MAILBOX });
    expect(
      parseGmailThreadUrl(`https://mail.google.com/mail/u/0/#all/${ID.toUpperCase()}`),
    ).toEqual({
      id: ID,
      mailbox: null,
    });
    expect(parseGmailThreadUrl(`https://mail.google.com/mail/u/0/#search/ledgerly/${ID}`)).toEqual({
      id: ID,
      mailbox: null,
    });
    for (const other of [
      null,
      '',
      'not a url',
      // A search, a label, Gmail's newer opaque ids: not one email Copilot can open.
      'https://mail.google.com/mail/u/0/#search/from%3Aada%40school.demo',
      'https://mail.google.com/mail/u/0/#label/Deals',
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzQXJWDsKmzfbqNzrKdLxbHCtqxb',
      `http://mail.google.com/mail/u/0/#all/${ID}`,
      `https://mail.google.com.example.test/mail/u/0/#all/${ID}`,
      `https://calendar.google.com/calendar/#all/${ID}`,
    ]) {
      expect(parseGmailThreadUrl(other), String(other)).toBeNull();
    }
  });

  it('reads the email an in-app Inbox link opens', () => {
    expect(emailIdFromInboxHref(`/inbox?thread=${ID}`)).toBe(ID);
    expect(emailIdFromInboxHref(`/inbox?message=${SYNCED}`)).toBe(SYNCED);
    expect(emailIdFromInboxHref('/inbox?message=m1')).toBeNull();
    expect(emailIdFromInboxHref('/inbox?category=portfolio_company')).toBeNull();
    expect(emailIdFromInboxHref(`/deals/${SYNCED}`)).toBeNull();
    expect(emailIdFromInboxHref(null)).toBeNull();
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

  it('turns an earlier Gmail link into the two links, and leaves any other link as it was', () => {
    const forHref = (props: Parameters<typeof ThreadLinksForHref>[0]) =>
      renderToStaticMarkup(createElement(ThreadLinksForHref, props));
    const html = forHref({
      href: `https://mail.google.com/mail/?authuser=${MAILBOX}#all/${ID}`,
      text: 'Seen sent · email to Ada',
      label: 'Seen sent · email to Ada',
      variant: 'text',
      fallback: createElement('a', { href: 'https://example.test/' }, 'other'),
    });
    expect(html).toContain('Seen sent · email to Ada');
    expect(html).toContain(`href="/inbox?thread=${ID}"`);
    expect(html).toContain('aria-label="Open in Gmail: Seen sent · email to Ada"');
    expect(html).not.toContain('example.test');

    const search = forHref({
      href: 'https://mail.google.com/mail/u/0/#search/ledgerly',
      fallback: createElement(
        'a',
        { href: 'https://mail.google.com/mail/u/0/#search/ledgerly' },
        'Search Gmail',
      ),
    });
    expect(search).toContain('Search Gmail');
    expect(search).not.toContain('/inbox?thread=');
  });
});
