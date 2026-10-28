import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_IDS } from '@/lib/demo/ids';
import { DEMO_NOTES_IDS } from '@/lib/demo/notes-fixtures';
import type { McpToolOutput } from '@/lib/mcp/protocol';
import { MCP_TOOLS, runMcpTool, type McpToolContext } from '@/lib/mcp/tools';
import type { Meeting, TranscriptSegment } from '@/lib/types/notes';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Kraken Notes' Granola-shaped MCP tools (D-076) against the demo store:
 * the finished Acme Robotics meeting (team-visible, nine days ago), the
 * Granola demo notes, and the private Coaching folder. What must hold in
 * every answer: no private meeting, nothing from a private folder, content
 * fenced as untrusted, and no LP amount.
 */

let harness: Harness;
let ctx: McpToolContext;

beforeEach(async () => {
  harness = await createHarness({ now: new Date() });
  ctx = {
    store: harness.store,
    organizationId: harness.auth.organizationId,
    now: new Date(),
    appUrl: 'https://copilot.example',
  };
});

afterEach(async () => {
  await harness.dispose();
});

const INTRO = `copilot:${DEMO_NOTES_IDS.meetingAcmeIntro}`;
const run = (name: string, args: Record<string, unknown> = {}): Promise<McpToolOutput> =>
  runMcpTool(ctx, name, args);
const everything = (out: McpToolOutput) => `${out.text}\n${JSON.stringify(out.structured)}`;

async function addMeeting(
  partial: Partial<Meeting> & Pick<Meeting, 'id' | 'title'>,
): Promise<Meeting> {
  const intro = (await harness.store.get(
    'meetings',
    harness.auth.organizationId,
    DEMO_NOTES_IDS.meetingAcmeIntro,
  )) as Meeting;
  const row: Meeting = {
    ...intro,
    provider_event_id: null,
    granola_external_id: null,
    last_seq: null,
    ...partial,
  };
  await harness.store.insert('meetings', row);
  return row;
}

describe('tools/list', () => {
  it('describes the five meeting tools as read-only, Granola-shaped', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const name of [
      'list_meetings',
      'get_meetings',
      'get_meeting_transcript',
      'query_meetings',
      'list_meeting_folders',
    ]) {
      expect(names).toContain(name);
    }
    const transcript = MCP_TOOLS.find((t) => t.name === 'get_meeting_transcript');
    expect(transcript?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(transcript?.inputSchema).toMatchObject({ type: 'object' });
  });
});

describe('list_meetings', () => {
  it('lists Kraken and Granola meetings with source-qualified ids, newest first', async () => {
    const out = await run('list_meetings', { time_range: 'last_30_days' });
    const meetings = out.structured.meetings as {
      id: string;
      source: string;
      has_transcript: boolean;
    }[];
    expect(meetings.map((m) => m.id)).toContain(INTRO);
    expect(meetings.find((m) => m.id === INTRO)).toMatchObject({
      source: 'copilot',
      has_transcript: true,
    });
    expect(meetings.some((m) => m.source === 'granola')).toBe(true);
    expect(out.text).toContain(INTRO);
  });

  it('defaults to the last seven days', async () => {
    const out = await run('list_meetings');
    const ids = (out.structured.meetings as { id: string }[]).map((m) => m.id);
    // The demo meeting is nine days old; the Girder debrief is six.
    expect(ids).not.toContain(INTRO);
    expect(ids.some((id) => id.startsWith('granola:'))).toBe(true);
  });

  it('never lists a private meeting or one in a private folder', async () => {
    await addMeeting({
      id: '00000000-0000-4000-8000-0000000d9001',
      title: 'Quiet one-to-one',
      visibility: 'private',
    });
    await addMeeting({
      id: '00000000-0000-4000-8000-0000000d9002',
      title: 'Coaching session',
      visibility: 'team',
      folder_id: DEMO_NOTES_IDS.folderCoaching,
    });
    const out = await run('list_meetings', { time_range: 'last_30_days' });
    expect(out.text).not.toContain('Quiet one-to-one');
    expect(out.text).not.toContain('Coaching session');
  });

  it('filters by participant, and pages', async () => {
    const withDana = await run('list_meetings', {
      time_range: 'last_30_days',
      participant_email: 'dana@acmerobotics.example',
    });
    expect((withDana.structured.meetings as { id: string }[]).map((m) => m.id)).toEqual([INTRO]);
    const page = await run('list_meetings', { time_range: 'last_30_days', limit: 1 });
    expect(page.structured.pagination).toMatchObject({ has_more: true, next_cursor: '1' });
  });

  it('lists a conversation both tools captured once', async () => {
    const intro = (await harness.store.get(
      'meetings',
      harness.auth.organizationId,
      DEMO_NOTES_IDS.meetingAcmeIntro,
    )) as Meeting;
    await harness.store.insert('meeting_notes', {
      id: '00000000-0000-4000-8000-0000000d9101',
      organization_id: harness.auth.organizationId,
      provider: 'granola',
      external_id: 'demo-granola-acme-twin',
      title: intro.title,
      occurred_at: intro.started_at as string,
      attendees: [{ name: 'Dana Reyes', email: 'dana@acmerobotics.example' }],
      content: 'The Granola copy of the same call.',
      source_url: null,
      injection_flagged: false,
      created_at: intro.started_at as string,
      updated_at: intro.started_at as string,
    });
    await harness.store.update('meetings', harness.auth.organizationId, intro.id, {
      granola_external_id: 'demo-granola-acme-twin',
    });
    const out = await run('list_meetings', { time_range: 'last_30_days' });
    const meetings = out.structured.meetings as { id: string; paired_with: string | null }[];
    expect(meetings.find((m) => m.id === INTRO)?.paired_with).toBe(
      'granola:00000000-0000-4000-8000-0000000d9101',
    );
    expect(meetings.some((m) => m.id === 'granola:00000000-0000-4000-8000-0000000d9101')).toBe(
      false,
    );
  });
});

describe('get_meetings', () => {
  it("returns fenced notes, owners and Nick's promises flagged", async () => {
    const out = await run('get_meetings', {
      meeting_ids: [INTRO, `granola:${DEMO_IDS.org}`, 'nonsense'],
    });
    const meetings = out.structured.meetings as {
      id: string;
      action_items: { is_nicks_promise: boolean }[];
    }[];
    expect(meetings).toHaveLength(1);
    expect(meetings[0]?.action_items.some((a) => a.is_nicks_promise)).toBe(true);
    expect(out.text).toContain('<untrusted-content');
    expect(out.text).toContain("[Nick's promise]");
    expect(out.structured.invalid_ids).toEqual(['nonsense']);
    expect(out.structured.not_found_ids).toEqual([`granola:${DEMO_IDS.org}`]);
  });

  it('reads a Granola note by its qualified id', async () => {
    const list = await run('list_meetings', { time_range: 'last_30_days', source: 'granola' });
    const id = (list.structured.meetings as { id: string }[])[0]?.id as string;
    const out = await run('get_meetings', { meeting_ids: [id] });
    expect((out.structured.meetings as { source: string }[])[0]?.source).toBe('granola');
  });

  it("masks an LP meeting's amounts", async () => {
    const id = '00000000-0000-4000-8000-0000000d9003';
    await addMeeting({
      id,
      title: 'Fund II LP call',
      template_id: 'builtin:lp_call',
      visibility: 'team',
    });
    await harness.store.insert('meeting_notes', {
      id: '00000000-0000-4000-8000-0000000d9102',
      organization_id: harness.auth.organizationId,
      provider: 'copilot',
      external_id: id,
      title: 'Fund II LP call',
      occurred_at: new Date().toISOString(),
      attendees: [],
      content: 'They are thinking about $2M for Fund II.',
      source_url: null,
      injection_flagged: false,
      meeting_id: id,
      user_notes: 'Commit $2,000,000 maybe',
      enhanced_blocks: null,
      action_items: [],
      visibility: 'team',
      owner_id: DEMO_IDS.user,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const out = await run('get_meetings', { meeting_ids: [`copilot:${id}`] });
    expect(everything(out)).not.toContain('$2,000,000');
    expect(everything(out)).toContain('[amount]');
  });

  it('never opens a private meeting, even by id', async () => {
    const id = '00000000-0000-4000-8000-0000000d9004';
    await addMeeting({ id, title: 'Private chat', visibility: 'private' });
    const out = await run('get_meetings', { meeting_ids: [`copilot:${id}`] });
    expect(out.structured.meetings).toEqual([]);
    expect(out.structured.not_found_ids).toEqual([`copilot:${id}`]);
  });
});

describe('get_meeting_transcript', () => {
  it('pages the transcript at line boundaries, with names from the ladder', async () => {
    const first = await run('get_meeting_transcript', {
      meeting_id: INTRO,
      max_chars: 1_000,
      include_timestamps: true,
    });
    const [page] = first.structured.meetings as {
      transcript_untrusted: string;
      truncated: boolean;
      next_offset: number;
      total_chars: number;
    }[];
    expect(page?.truncated).toBe(true);
    expect(
      page?.transcript_untrusted.startsWith('[0:00] Nick Tippmann: Thanks for making the time'),
    ).toBe(true);
    expect(page?.transcript_untrusted).toContain('Dana Reyes:');
    const second = await run('get_meeting_transcript', {
      meeting_id: INTRO,
      max_chars: 80_000,
      offset: page?.next_offset,
      // Offsets count the text as it is read: the same format on every page.
      include_timestamps: true,
    });
    const [rest] = second.structured.meetings as {
      transcript_untrusted: string;
      truncated: boolean;
    }[];
    expect(rest?.truncated).toBe(false);
    expect(rest?.transcript_untrusted).toContain('Guest 1:');
    // No line is lost or repeated across the two pages.
    const lines = (await harness.store.list('transcript_segments', harness.auth.organizationId, {
      eq: { meeting_id: DEMO_NOTES_IDS.meetingAcmeIntro },
    })) as TranscriptSegment[];
    const all = `${page?.transcript_untrusted}\n${rest?.transcript_untrusted}`;
    expect(all.split('\n')).toHaveLength(lines.length);
  });

  it('says a Granola note has no transcript', async () => {
    const list = await run('list_meetings', { time_range: 'last_30_days', source: 'granola' });
    const id = (list.structured.meetings as { id: string }[])[0]?.id as string;
    const out = await run('get_meeting_transcript', { meeting_ids: [id] });
    expect(
      (out.structured.meetings as { transcript_unavailable: { reason: string } }[])[0]
        ?.transcript_unavailable.reason,
    ).toBe('no_transcript');
  });

  it('refuses a call with no meeting', async () => {
    const out = await run('get_meeting_transcript', {});
    expect(out.isError).toBe(true);
  });
});

describe('query_meetings', () => {
  it('finds a transcript passage with the moment it was said', async () => {
    const out = await run('query_meetings', { query: 'retention' });
    const results = out.structured.results as {
      meeting_id: string;
      field: string;
      at: string | null;
      speaker: string | null;
    }[];
    const hit = results.find((r) => r.field === 'transcript' && r.speaker === 'Dana Reyes');
    expect(hit).toMatchObject({ meeting_id: INTRO });
    expect(hit?.at).toMatch(/^\d+:\d{2}$/);
    expect(out.text).toContain('<untrusted-content');
  });

  it('searches notes too, Granola included', async () => {
    const out = await run('query_meetings', { query: 'estimator' });
    expect(
      (out.structured.results as { meeting_id: string }[]).some((r) =>
        r.meeting_id.startsWith('granola:'),
      ),
    ).toBe(true);
  });
});

describe('list_meeting_folders', () => {
  it('never lists a private folder', async () => {
    const now = new Date().toISOString();
    await harness.store.insert('meeting_folders', {
      id: '00000000-0000-4000-8000-0000000d9201',
      organization_id: harness.auth.organizationId,
      name: 'Portfolio',
      is_private: false,
      slack_channel_id: null,
      position: 1,
      created_by: DEMO_IDS.user,
      created_at: now,
      updated_at: now,
    });
    const out = await run('list_meeting_folders');
    const titles = (out.structured.folders as { title: string }[]).map((f) => f.title);
    expect(titles).toEqual(['Portfolio']);
    expect(everything(out)).not.toContain('Coaching');
  });
});
