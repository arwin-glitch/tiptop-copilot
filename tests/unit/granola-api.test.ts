import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isIngestableEvent,
  toIngestPayload,
  verifyGranolaSignature,
  GRANOLA_EVENT_SCHEMA,
  type GranolaRemoteNote,
} from '@/lib/services/granola-api';

/**
 * Granola's native webhook and API.
 *
 * The signature is the only thing standing between this endpoint and anyone
 * who can guess the URL, so it gets the attention: a forged body, a replayed
 * delivery and a wrong key must all fail, and the genuine one must pass.
 *
 * The mapping matters for a different reason. A Granola delivery names a note
 * but carries none of it, so everything a reader eventually sees — title,
 * text, who was in the room — comes out of this translation. Getting it wrong
 * is how a real meeting becomes an empty or mislabelled record.
 */

const SECRET_BYTES = Buffer.from('a-signing-key-for-tests-0123456789ab');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

const BODY = JSON.stringify({
  event_id: '8f1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b',
  event_type: 'note.generated',
  note_id: 'not_1d3tmYTlCICgjy',
  occurred_at: '2026-08-21T15:30:00Z',
});

const NOW = new Date('2026-08-21T15:30:10Z');
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const WEBHOOK_ID = '8f1c2a4e-6b3d-4e8f-9a2b-1c5d7e9f0a3b';

function sign(body: string, id = WEBHOOK_ID, timestamp = TIMESTAMP): string {
  return `v1,${createHmac('sha256', SECRET_BYTES).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

describe('signature verification', () => {
  const base = {
    secret: SECRET,
    webhookId: WEBHOOK_ID,
    webhookTimestamp: TIMESTAMP,
    rawBody: BODY,
    now: NOW,
  };

  it('accepts a genuine delivery', () => {
    expect(verifyGranolaSignature({ ...base, signatureHeader: sign(BODY) })).toBe(true);
  });

  it('rejects a body altered after signing', () => {
    const tampered = BODY.replace('not_1d3tmYTlCICgjy', 'not_aaaaaaaaaaaaaa');
    expect(
      verifyGranolaSignature({ ...base, rawBody: tampered, signatureHeader: sign(BODY) }),
    ).toBe(false);
  });

  it('rejects a signature made with a different key', () => {
    const forged = `v1,${createHmac('sha256', Buffer.from('wrong-key')).update(`${WEBHOOK_ID}.${TIMESTAMP}.${BODY}`).digest('base64')}`;
    expect(verifyGranolaSignature({ ...base, signatureHeader: forged })).toBe(false);
  });

  it('rejects a replay of a delivery captured hours ago', () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);
    expect(
      verifyGranolaSignature({
        ...base,
        webhookTimestamp: old,
        signatureHeader: sign(BODY, WEBHOOK_ID, old),
      }),
    ).toBe(false);
  });

  it('accepts when several versioned signatures are offered, as during a rotation', () => {
    const header = `v1,AAAAinvalidAAAA ${sign(BODY)}`;
    expect(verifyGranolaSignature({ ...base, signatureHeader: header })).toBe(true);
  });

  it('rejects missing pieces rather than treating absence as valid', () => {
    expect(verifyGranolaSignature({ ...base, signatureHeader: '' })).toBe(false);
    expect(
      verifyGranolaSignature({ ...base, webhookTimestamp: '', signatureHeader: sign(BODY) }),
    ).toBe(false);
  });
});

describe('event parsing', () => {
  it('accepts the documented payload', () => {
    const parsed = GRANOLA_EVENT_SCHEMA.safeParse(JSON.parse(BODY));
    expect(parsed.success).toBe(true);
  });

  it('refuses a note id that is not one', () => {
    const bad = { ...JSON.parse(BODY), note_id: 'https://evil.example/x' };
    expect(GRANOLA_EVENT_SCHEMA.safeParse(bad).success).toBe(false);
  });

  it('ingests the three note events and nothing else', () => {
    expect(isIngestableEvent('note.generated')).toBe(true);
    expect(isIngestableEvent('note.edited')).toBe(true);
    expect(isIngestableEvent('note.access_granted')).toBe(true);
    expect(isIngestableEvent('workspace.member_added')).toBe(false);
  });
});

describe('mapping a fetched note', () => {
  const NOTE: GranolaRemoteNote = {
    id: 'not_1d3tmYTlCICgjy',
    title: 'Vetrix — corpus licensing walk-through',
    summary_text: 'plain version',
    summary_markdown: '## Licensing\n\nYear-six rights are capped.',
    created_at: '2026-08-21T16:02:00Z',
    web_url: 'https://notes.granola.ai/d/abc',
    owner: { name: 'Nick Tippmann', email: 'nick@tiptop.vc' },
    attendees: [{ name: 'Dr. Priya Raman', email: 'priya@vetrix.demo' }],
    calendar_event: {
      event_title: 'Vetrix sync',
      scheduled_start_time: '2026-08-21T15:00:00Z',
      invitees: [{ name: 'Priya', email: 'PRIYA@vetrix.demo' }],
    },
  };

  it('prefers the markdown summary and the scheduled start', () => {
    const payload = toIngestPayload(NOTE)!;
    expect(payload.content).toContain('Year-six rights are capped');
    // The calendar's start is when the meeting happened; created_at is merely
    // when the summary was written, minutes to hours later.
    expect(payload.occurred_at).toBe('2026-08-21T15:00:00.000Z');
  });

  it('collects attendees across sources, deduplicated case-insensitively', () => {
    const payload = toIngestPayload(NOTE)!;
    // The ingest schema accepts either shape from Zapier-style senders; this
    // mapper always produces the joined string.
    const emails = String(payload.attendee_emails).split(', ');
    expect(emails).toContain('priya@vetrix.demo');
    expect(emails).toContain('nick@tiptop.vc');
    // "PRIYA@…" from the invitee list is the same person, listed once.
    expect(emails.filter((email: string) => email === 'priya@vetrix.demo')).toHaveLength(1);
  });

  it('falls back to the calendar title when the note is untitled', () => {
    expect(toIngestPayload({ ...NOTE, title: null })!.title).toBe('Vetrix sync');
  });

  it('skips a note whose summary has not been written yet', () => {
    // `note.generated` can land fractionally ahead of the summary; ingesting
    // then would file an empty meeting that never fills in.
    expect(toIngestPayload({ ...NOTE, summary_markdown: null, summary_text: null })).toBeNull();
  });

  it('survives a note with no calendar event at all', () => {
    const adhoc = toIngestPayload({ ...NOTE, calendar_event: null })!;
    expect(adhoc.occurred_at).toBe('2026-08-21T16:02:00.000Z');
    expect(adhoc.title).toBe('Vetrix — corpus licensing walk-through');
  });
});
