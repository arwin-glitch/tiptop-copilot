import { describe, expect, it } from 'vitest';
import { contentHash, parseCache, toPayload } from '../../scripts/granola-watch.mjs';

/**
 * The watcher script's pure half.
 *
 * The script itself runs on Nick's Mac against a cache file this repository
 * never sees, so what can be tested here is the part most likely to be wrong:
 * reading the double-encoded cache shape the community exporters document,
 * turning a document into the webhook payload, and refusing to invent fields
 * that are not there.
 */

const DOC = {
  id: 'doc-1',
  title: 'Vetrix — corpus licensing',
  notes_markdown: 'Priya walked through the licensing question.',
  created_at: '2026-08-15T15:00:00.000Z',
  google_calendar_event: {
    summary: 'Vetrix sync',
    start: { dateTime: '2026-08-15T15:00:00.000Z' },
    attendees: [
      { email: 'nick@tiptop.demo', displayName: 'Nick Tippmann' },
      { email: 'priya@vetrix.demo', displayName: 'Dr. Priya Raman' },
    ],
  },
};

describe('parseCache', () => {
  it('reads the double-encoded shape: cache is a JSON string holding state.documents', () => {
    const raw = JSON.stringify({
      cache: JSON.stringify({ state: { documents: { 'doc-1': DOC } } }),
    });
    const docs = parseCache(raw);
    expect(docs).toHaveLength(1);
    expect((docs[0] as { id: string }).id).toBe('doc-1');
  });

  it('accepts documents as an array as well as an id-keyed object', () => {
    const raw = JSON.stringify({ cache: JSON.stringify({ state: { documents: [DOC] } }) });
    expect(parseCache(raw)).toHaveLength(1);
  });

  it('returns nothing rather than guessing when the shape is unrecognised', () => {
    expect(parseCache(JSON.stringify({ some: 'other app entirely' }))).toEqual([]);
  });
});

describe('toPayload', () => {
  it('maps a document onto exactly the webhook shape', () => {
    const payload = toPayload(DOC);
    expect(payload).toEqual({
      external_id: 'doc-1',
      title: 'Vetrix — corpus licensing',
      occurred_at: '2026-08-15T15:00:00.000Z',
      attendee_emails: 'nick@tiptop.demo, priya@vetrix.demo',
      attendee_names: 'Nick Tippmann, Dr. Priya Raman',
      content: 'Priya walked through the licensing question.',
    });
  });

  it('skips a meeting whose note is still empty — there is nothing to ingest', () => {
    expect(toPayload({ ...DOC, notes_markdown: '', notes_plain: '' })).toBeNull();
  });

  it('skips a document with no usable date rather than stamping it with now', () => {
    expect(
      toPayload({ ...DOC, created_at: undefined, google_calendar_event: undefined }),
    ).toBeNull();
  });

  it('drops attendees without an address instead of inventing one', () => {
    const payload = toPayload({
      ...DOC,
      google_calendar_event: {
        ...DOC.google_calendar_event,
        attendees: [{ displayName: 'Mystery Guest' }, { email: 'real@x.com' }],
      },
    });
    expect(payload?.attendee_emails).toBe('real@x.com');
  });
});

describe('contentHash', () => {
  it('changes when the note is edited, so edits are re-sent and no-ops are not', () => {
    const before = toPayload(DOC)!;
    const after = toPayload({ ...DOC, notes_markdown: 'Updated after the meeting.' })!;
    expect(contentHash(before)).not.toBe(contentHash(after));
    expect(contentHash(before)).toBe(contentHash(toPayload(DOC)!));
  });
});
