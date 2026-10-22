import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoNotes } from '@/lib/demo/notes-fixtures';
import { NOTES_API, formatOffset, meetingPagePath, sharedNotePath } from '@/lib/notes/api';
import {
  CREATE_MEETING,
  CREATE_SHARE_LINK,
  MERGE_SPEAKERS,
  NOTES_CHAT,
  RELABEL_SPEAKER,
  START_RECORDING,
  STT_TOKEN,
  UPLOAD_SEGMENTS,
  VOICE_CONSENT,
} from '@/lib/notes/schemas';
import { CLUSTER_KEY_RE } from '@/lib/transcribe/cluster';
import { BUILTIN_TEMPLATES, NOTES_LIMITS, isBuiltinTemplateId } from '@/lib/types/notes';

/**
 * The Copilot Notes contract (D-076): the request schemas say what the routes
 * accept, the migration has every column the row types name, and the rules
 * that are privacy promises (no audio, voice identifiers server-only, consent
 * before recording) are written into the schema itself.
 */

const SQL = readFileSync(
  path.resolve(import.meta.dirname, '../../supabase/migrations/20261024000000_copilot_notes.sql'),
  'utf8',
);

/** The column names declared in one `create table` block, plus later `add column`s. */
function columnsOf(table: string): Set<string> {
  const block = SQL.match(new RegExp(`create table if not exists ${table} \\(([\\s\\S]*?)\\n\\);`));
  const cols = new Set<string>();
  for (const line of (block?.[1] ?? '').split('\n')) {
    const m = line.match(
      /^\s{2}([a-z_]+)\s+(uuid|text|integer|smallint|boolean|real|jsonb|timestamptz)/,
    );
    if (m?.[1]) cols.add(m[1]);
  }
  for (const m of SQL.matchAll(
    new RegExp(`alter table ${table}\\s+add column if not exists ([a-z_]+)`, 'g'),
  )) {
    if (m[1]) cols.add(m[1]);
  }
  return cols;
}

describe('the migration matches the row types', () => {
  const seed = demoNotes(new Date('2026-10-22T15:00:00Z'));
  const tables = [
    'meetings',
    'meeting_participants',
    'meeting_speakers',
    'transcript_segments',
    'meeting_folders',
    'meeting_consent_log',
    'voice_profiles',
  ] as const;

  for (const table of tables) {
    it(`declares every field of a ${table} row`, () => {
      const rows = seed[table] as unknown as Record<string, unknown>[];
      expect(rows.length).toBeGreaterThan(0);
      const cols = columnsOf(table);
      const missing = Object.keys(rows[0] as object).filter((k) => !cols.has(k));
      expect(missing).toEqual([]);
    });
  }

  it('declares every Copilot field of a meeting_notes row', () => {
    const note = seed.meeting_notes[0] as unknown as Record<string, unknown>;
    const added = [
      ...SQL.matchAll(/alter table meeting_notes add column if not exists ([a-z_]+)/g),
    ].map((m) => m[1]);
    for (const key of [
      'meeting_id',
      'user_notes',
      'enhanced_blocks',
      'action_items',
      'template_id',
      'prompt_version',
      'model',
      'generated_at',
      'edited_at',
      'visibility',
      'owner_id',
    ]) {
      expect(note).toHaveProperty(key);
      expect(added).toContain(key);
    }
  });

  it('pins audio off in the schema, not just the code', () => {
    expect(SQL).toMatch(
      /audio_retained boolean not null default false check \(audio_retained = false\)/,
    );
    expect(SQL).not.toMatch(/\baudio_(url|path|blob|bytes|data)\b/);
  });

  it('keeps voice identifiers server-only: RLS on, no policy', () => {
    expect(SQL).toMatch(/alter table voice_identifiers enable row level security;/);
    expect(SQL).not.toMatch(/create policy [a-z_]+ on voice_identifiers/);
  });

  it('turns RLS on for every new table', () => {
    const created = [...SQL.matchAll(/create table if not exists ([a-z_]+)/g)].map((m) => m[1]);
    expect(created).toHaveLength(12);
    for (const table of created) {
      const viaLoop = new RegExp(`'${table}'`).test(SQL);
      const direct = new RegExp(`alter table ${table} enable row level security`).test(SQL);
      expect(viaLoop || direct, table).toBe(true);
    }
  });

  it('stores share links as hashes only, with a 90-day ceiling', () => {
    const cols = columnsOf('note_share_links');
    expect(cols.has('token_hash')).toBe(true);
    expect([...cols].some((c) => c === 'token')).toBe(false);
    expect(SQL).toMatch(/expires_at <= created_at \+ interval '90 days/);
  });

  it('checks cluster keys with the same pattern the app uses', () => {
    const sqlPattern = SQL.match(/cluster_key ~ '([^']+)'/)?.[1];
    expect(sqlPattern).toBe(CLUSTER_KEY_RE.source);
  });
});

describe('request schemas', () => {
  it('needs an event id for a meeting from the calendar', () => {
    expect(CREATE_MEETING.safeParse({ source: 'calendar', title: 'Intro' }).success).toBe(false);
    expect(
      CREATE_MEETING.safeParse({ source: 'calendar', title: 'Intro', providerEventId: 'evt1' })
        .success,
    ).toBe(true);
    expect(CREATE_MEETING.safeParse({ source: 'adhoc', title: 'Hallway chat' }).success).toBe(true);
  });

  it('refuses to start without the consent box ticked', () => {
    const base = { captureSource: 'web', consent: { method: 'chat_notice' } };
    expect(START_RECORDING.safeParse(base).success).toBe(false);
    expect(
      START_RECORDING.safeParse({ ...base, consent: { ...base.consent, confirmed: false } })
        .success,
    ).toBe(false);
    expect(
      START_RECORDING.safeParse({ ...base, consent: { ...base.consent, confirmed: true } }).success,
    ).toBe(true);
  });

  it('caps a segment batch and checks every line', () => {
    const line = (seq: number) => ({
      seq,
      track: 'system',
      clusterKey: 'sys:S1',
      startMs: seq * 1000,
      endMs: seq * 1000 + 900,
      text: 'A line.',
    });
    const max = NOTES_LIMITS.maxSegmentsPerRequest;
    expect(
      UPLOAD_SEGMENTS.safeParse({ segments: Array.from({ length: max }, (_, i) => line(i)) })
        .success,
    ).toBe(true);
    expect(
      UPLOAD_SEGMENTS.safeParse({ segments: Array.from({ length: max + 1 }, (_, i) => line(i)) })
        .success,
    ).toBe(false);
    expect(
      UPLOAD_SEGMENTS.safeParse({ segments: [{ ...line(1), clusterKey: 'Dana Reyes' }] }).success,
    ).toBe(false);
    expect(UPLOAD_SEGMENTS.safeParse({ segments: [{ ...line(1), endMs: 10 }] }).success).toBe(
      false,
    );
    expect(UPLOAD_SEGMENTS.safeParse({ segments: [{ ...line(1), text: '   ' }] }).success).toBe(
      false,
    );
  });

  it('mints one or two distinct tracks', () => {
    expect(STT_TOKEN.safeParse({ tracks: ['mic', 'system'] }).success).toBe(true);
    expect(STT_TOKEN.safeParse({ tracks: ['mic', 'mic'] }).success).toBe(false);
    expect(STT_TOKEN.safeParse({ tracks: [] }).success).toBe(false);
  });

  it('relabels with something to change, and merges two different voices', () => {
    expect(RELABEL_SPEAKER.safeParse({}).success).toBe(false);
    expect(RELABEL_SPEAKER.safeParse({ person: null }).success).toBe(true);
    expect(
      RELABEL_SPEAKER.safeParse({
        person: { name: 'Priya Shah', email: 'PRIYA@AcmeRobotics.example' },
      }).data?.person?.email,
    ).toBe('priya@acmerobotics.example');
    expect(MERGE_SPEAKERS.safeParse({ from: 'sys:S1', into: 'sys:S1' }).success).toBe(false);
  });

  it('offers 7, 30 or 90 days for a link', () => {
    expect(CREATE_SHARE_LINK.safeParse({ expiresInDays: 30 }).success).toBe(true);
    expect(CREATE_SHARE_LINK.safeParse({ expiresInDays: 45 }).success).toBe(false);
    expect(CREATE_SHARE_LINK.safeParse({}).success).toBe(true);
  });

  it('asks who or which company for a scoped chat', () => {
    expect(NOTES_CHAT.safeParse({ scope: 'person', question: 'What did they say?' }).success).toBe(
      false,
    );
    expect(
      NOTES_CHAT.safeParse({
        scope: 'company',
        question: 'Runway?',
        companyDomain: 'acmerobotics.example',
      }).success,
    ).toBe(true);
  });

  it('wants evidence for granted voice consent', () => {
    expect(
      VOICE_CONSENT.safeParse({ action: 'grant', email: 'dana@acmerobotics.example' }).success,
    ).toBe(false);
    expect(
      VOICE_CONSENT.safeParse({ action: 'revoke', email: 'dana@acmerobotics.example' }).success,
    ).toBe(true);
  });
});

describe('templates and paths', () => {
  it('has the five built-in VC templates with unique ids', () => {
    expect(BUILTIN_TEMPLATES.map((t) => t.key)).toEqual([
      'founder_pitch',
      'lp_call',
      'portfolio_checkin',
      'intro_call',
      'internal_1on1',
    ]);
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(5);
    expect(isBuiltinTemplateId('builtin:lp_call')).toBe(true);
    expect(isBuiltinTemplateId('builtin:nope')).toBe(false);
  });

  it('encodes cluster keys and ids in paths', () => {
    expect(NOTES_API.speaker('m1', 'sys:S1#2')).toBe(
      '/api/notes/meetings/m1/speakers/sys%3AS1%232',
    );
    expect(sharedNotePath('abc_DEF-123')).toBe('/n/abc_DEF-123');
    expect(meetingPagePath('m1', 61_500)).toBe('/meetings/m1?tab=transcript&t=61500');
    expect(formatOffset(751_000)).toBe('12:31');
    expect(formatOffset(3_751_000)).toBe('1:02:31');
  });
});
