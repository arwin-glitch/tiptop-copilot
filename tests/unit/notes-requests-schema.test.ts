import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NotesRequest } from '@/lib/types/notes';

/**
 * notes_requests (D-076, zero spend): the migration declares every field the
 * row type names, keeps line ids only (never the words) in line_map, has its
 * own RLS with the meeting visibility rule, and the note row can point at
 * the request behind its text.
 */

const SQL = readFileSync(
  path.resolve(import.meta.dirname, '../../supabase/migrations/20261024000000_copilot_notes.sql'),
  'utf8',
);

const ROW: NotesRequest = {
  id: '00000000-0000-4000-8000-000000000001',
  organization_id: '00000000-0000-4000-8000-000000000002',
  meeting_id: '00000000-0000-4000-8000-000000000003',
  kind: 'notes',
  status: 'pending',
  reason: 'stop',
  message_id: null,
  thread_id: null,
  template_id: null,
  meeting_day: '2026-10-20',
  requested_by: null,
  fired_at: null,
  fire_attempts: 0,
  last_fire_at: null,
  line_map: {},
  parts: {},
  payload_chars: null,
  omitted_lines: 0,
  error: null,
  completed_at: null,
  expires_at: '2026-10-21T15:00:00.000Z',
  created_at: '2026-10-20T15:00:00.000Z',
  updated_at: '2026-10-20T15:00:00.000Z',
};

describe('notes_requests in the migration', () => {
  const block = SQL.match(/create table if not exists notes_requests \(([\s\S]*?)\n\);/)?.[1] ?? '';

  it('declares every field of a row', () => {
    const cols = new Set(
      block
        .split('\n')
        .map((l) => l.match(/^\s{2}([a-z_]+)\s+(uuid|text|integer|jsonb|timestamptz|date)/)?.[1])
        .filter((c): c is string => Boolean(c)),
    );
    expect(Object.keys(ROW).filter((k) => !cols.has(k))).toEqual([]);
  });

  it('pins the kinds, statuses and reasons the app writes', () => {
    expect(block).toContain("check (kind in ('notes', 'chat'))");
    expect(block).toContain("check (status in ('pending', 'ready', 'failed', 'expired'))");
    expect(block).toContain("reason in ('stop', 'regenerate', 'template')");
  });

  it('has row-level security with the meeting visibility rule, and no named auto-constraint', () => {
    expect(SQL).toMatch(/alter table notes_requests enable row level security;/);
    expect(SQL).toMatch(
      /create policy notes_requests_select on notes_requests\s+for select using \(is_org_member\(organization_id\) and can_read_meeting\(meeting_id\)\);/,
    );
    expect(SQL).not.toMatch(/constraint notes_requests_[a-z_]+_check/);
  });

  it('lets a note point at the request behind its text', () => {
    expect(SQL).toMatch(
      /alter table meeting_notes add column if not exists notes_request_id uuid\s+references notes_requests\(id\) on delete set null;/,
    );
  });
});
