import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@/lib/auth/session';
import { resetEnvCache } from '@/lib/config/env';
import { DEMO_IDS } from '@/lib/demo/ids';
import { DEMO_NOTES_IDS } from '@/lib/demo/notes-fixtures';
import { resetLimiters } from '@/lib/security/limits';
import { resolveSharedNote } from '@/lib/services/notes-share';
import { mockTranscriptEvents } from '@/lib/transcribe/mock-script';
import { clusterKeyFor } from '@/lib/transcribe/cluster';
import type {
  CreateMeetingResponse,
  MeetingDetailResponse,
  SegmentUpload,
  UploadSegmentsResponse,
} from '@/lib/types/notes';
import type { Task } from '@/lib/types/domain';
import { ok, err } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Kraken Notes end to end through its routes (D-076), in demo mode with the
 * mock transcriber: make a meeting, refuse to start without consent, start,
 * mint speech sessions, upload the scripted call, rename a voice, split and
 * merge, stop (the notes job), share and revoke, add a task, and the flag.
 */

let harness: Harness;
let caller: AuthContext | null = null;

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => (caller ? ok(caller) : err('unauthenticated', 'Sign in.')),
}));

const meetingsRoute = await import('@/app/api/notes/meetings/route');
const meetingRoute = await import('@/app/api/notes/meetings/[id]/route');
const startRoute = await import('@/app/api/notes/meetings/[id]/start/route');
const pauseRoute = await import('@/app/api/notes/meetings/[id]/pause/route');
const stopRoute = await import('@/app/api/notes/meetings/[id]/stop/route');
const speechRoute = await import('@/app/api/notes/meetings/[id]/speech-setup/route');
const segmentsRoute = await import('@/app/api/notes/meetings/[id]/segments/route');
const segmentRoute = await import('@/app/api/notes/meetings/[id]/segments/[seq]/route');
const speakerRoute = await import('@/app/api/notes/meetings/[id]/speakers/[clusterKey]/route');
const splitRoute = await import('@/app/api/notes/meetings/[id]/speakers/split/route');
const mergeRoute = await import('@/app/api/notes/meetings/[id]/speakers/merge/route');
const generateRoute = await import('@/app/api/notes/meetings/[id]/generate/route');
const chatRoute = await import('@/app/api/notes/meetings/[id]/chat/route');
const shareRoute = await import('@/app/api/notes/meetings/[id]/share/route');
const linkRoute = await import('@/app/api/notes/meetings/[id]/share/[linkId]/route');
const actionRoute = await import('@/app/api/notes/meetings/[id]/action-items/route');
const templatesRoute = await import('@/app/api/notes/templates/route');
const voiceRoute = await import('@/app/api/notes/voice-profiles/route');
const betaRoute = await import('@/app/api/notes/beta/route');

const ORIGIN = 'http://localhost:3000';
const SAVED_FLAG = process.env.NOTES_ENABLED;

function req(path: string, method = 'GET', body?: unknown): NextRequest {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, host: 'localhost:3000', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
async function json<T = Record<string, unknown>>(response: Response): Promise<T & { ok: boolean }> {
  return (await response.json()) as T & { ok: boolean };
}

function setFlag(value: string | undefined) {
  if (value === undefined) delete process.env.NOTES_ENABLED;
  else process.env.NOTES_ENABLED = value;
  resetEnvCache();
}

async function teammate(): Promise<AuthContext> {
  const profile = await harness.store.userProfileById(DEMO_IDS.userTeammate);
  if (!profile) throw new Error('No demo teammate');
  return { ...harness.auth, userId: DEMO_IDS.userTeammate, profile };
}

const CONSENT = {
  consent: { confirmed: true, method: 'chat_notice' },
  captureSource: 'web',
};

function scriptedUploads(): SegmentUpload[] {
  return mockTranscriptEvents(['mic', 'system']).map((e, seq) => ({
    seq,
    track: e.track,
    clusterKey: clusterKeyFor(e.track, e.speakerLabel),
    vendorLabel: e.speakerLabel,
    startMs: e.startMs,
    endMs: e.endMs,
    text: e.text,
    confidence: e.confidence,
    isFinal: true,
  }));
}

async function newMeeting(body: Record<string, unknown> = {}) {
  const res = await meetingsRoute.POST(
    req('/api/notes/meetings', 'POST', {
      source: 'calendar',
      providerEventId: 'evt-acme-1',
      title: 'Acme Robotics intro',
      attendees: [
        { email: 'dana@acmerobotics.example', name: 'Dana Reyes' },
        { email: 'priya@acmerobotics.example', name: 'Priya Shah' },
        { email: 'nick@tiptop.demo', name: 'Nick Tippmann' },
      ],
      ...body,
    }),
  );
  return json<CreateMeetingResponse>(res);
}

async function detail(id: string) {
  return json<MeetingDetailResponse>(
    await meetingRoute.GET(req(`/api/notes/meetings/${id}`), ctx({ id })),
  );
}

async function recordScriptedCall(id: string) {
  await startRoute.POST(req(`/api/notes/meetings/${id}/start`, 'POST', CONSENT), ctx({ id }));
  const res = await segmentsRoute.POST(
    req(`/api/notes/meetings/${id}/segments`, 'POST', { segments: scriptedUploads() }),
    ctx({ id }),
  );
  return json<UploadSegmentsResponse>(res);
}

beforeEach(async () => {
  setFlag('on');
  harness = await createHarness({ now: new Date() });
  caller = harness.auth;
});

afterEach(async () => {
  await harness.dispose();
  resetLimiters();
});

afterAll(() => setFlag(SAVED_FLAG));

describe('the flag', () => {
  it('hides every route while NOTES_ENABLED is off', async () => {
    setFlag(undefined);
    const res = await meetingsRoute.GET(req('/api/notes/meetings'));
    expect(res.status).toBe(404);
    const beta = await json<{ mode: string; enabled: boolean }>(await betaRoute.GET());
    expect(beta).toMatchObject({ ok: true, mode: 'off', enabled: false });
  });

  it("in beta, follows each person's own switch", async () => {
    setFlag('beta');
    expect((await meetingsRoute.GET(req('/api/notes/meetings'))).status).toBe(404);
    const on = await json(await betaRoute.POST(req('/api/notes/beta', 'POST', { enabled: true })));
    expect(on).toMatchObject({ ok: true, mode: 'beta', beta: true, enabled: true });
    expect((await meetingsRoute.GET(req('/api/notes/meetings'))).status).toBe(200);
    caller = await teammate();
    expect((await meetingsRoute.GET(req('/api/notes/meetings'))).status).toBe(404);
  });

  it('refuses a change from another site', async () => {
    const res = await meetingsRoute.POST(
      new NextRequest(`${ORIGIN}/api/notes/meetings`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', host: 'localhost:3000' },
        body: JSON.stringify({ source: 'adhoc', title: 'x' }),
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('meetings', () => {
  it('makes one meeting per calendar event and recorder, private to them', async () => {
    const first = await newMeeting();
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(first.meeting.visibility).toBe('private');
    expect(first.meeting.isRecorder).toBe(true);
    expect(first.meeting.qualifiedId).toBe(`copilot:${first.meeting.id}`);
    const again = await newMeeting();
    expect(again.created).toBe(false);
    expect(again.meeting.id).toBe(first.meeting.id);

    const d = await detail(first.meeting.id);
    expect(d.participants.map((p) => [p.role, p.email])).toEqual([
      ['self', 'nick@tiptop.demo'],
      ['guest', 'dana@acmerobotics.example'],
      ['guest', 'priya@acmerobotics.example'],
    ]);

    // A teammate cannot see a private meeting: it is "not found".
    caller = await teammate();
    expect(
      (
        await meetingRoute.GET(
          req(`/api/notes/meetings/${first.meeting.id}`),
          ctx({ id: first.meeting.id }),
        )
      ).status,
    ).toBe(404);
    caller = harness.auth;
    await meetingRoute.PATCH(
      req(`/api/notes/meetings/${first.meeting.id}`, 'PATCH', { visibility: 'team' }),
      ctx({ id: first.meeting.id }),
    );
    caller = await teammate();
    expect((await detail(first.meeting.id)).ok).toBe(true);
    // ...but only the recorder decides who sees it.
    const res = await meetingRoute.PATCH(
      req(`/api/notes/meetings/${first.meeting.id}`, 'PATCH', { visibility: 'private' }),
      ctx({ id: first.meeting.id }),
    );
    expect(res.status).toBe(403);
  });

  it('lists Kraken meetings beside Granola notes, and searches transcripts', async () => {
    const list = await json<{ meetings: { source: string; qualifiedId: string }[] }>(
      await meetingsRoute.GET(req('/api/notes/meetings')),
    );
    const sources = new Set(list.meetings.map((m) => m.source));
    expect(sources).toEqual(new Set(['copilot', 'granola']));
    expect(list.meetings.map((m) => m.qualifiedId)).toContain(
      `copilot:${DEMO_NOTES_IDS.meetingAcmeIntro}`,
    );

    const found = await json<{
      meetings: { meetingId: string | null }[];
      hits: { field: string; startMs: number | null; meetingId: string | null }[];
    }>(await meetingsRoute.GET(req('/api/notes/meetings?q=retention')));
    const transcriptHit = found.hits.find((h) => h.field === 'transcript');
    expect(transcriptHit?.meetingId).toBe(DEMO_NOTES_IDS.meetingAcmeIntro);
    expect(transcriptHit?.startMs).toBeGreaterThan(0);
    expect(found.meetings.map((m) => m.meetingId)).toContain(DEMO_NOTES_IDS.meetingAcmeIntro);
  });

  it('reads the finished demo meeting with names, notes and sources', async () => {
    const d = await detail(DEMO_NOTES_IDS.meetingAcmeIntro);
    expect(d.ok).toBe(true);
    expect(d.meeting.status).toBe('ready');
    const names = Object.fromEntries(d.speakers.map((s) => [s.clusterKey, s.displayName]));
    expect(names).toEqual({
      mic: 'Nick Tippmann',
      'sys:S1': 'Dana Reyes',
      'sys:S2': 'Priya Shah',
      'sys:S3': 'Guest 1',
    });
    expect(d.speakers.find((s) => s.clusterKey === 'mic')?.isOwner).toBe(true);
    expect(d.speakers.find((s) => s.clusterKey === 'sys:S3')?.resolved).toBe(false);
    expect(d.note?.blocks.some((b) => b.source === 'typed')).toBe(true);
    expect(
      d.note?.blocks
        .filter((b) => b.source === 'ai' && b.kind !== 'heading')
        .every((b) => b.sources.length > 0),
    ).toBe(true);
    expect(d.note?.actionItems.find((a) => a.isPrincipalPromise)?.ownerName).toBe('Nick Tippmann');
  });
});

describe('recording', () => {
  it('will not start until the consent box is ticked, and never on a never-record meeting', async () => {
    const { meeting } = await newMeeting();
    const id = meeting.id;
    const unticked = await startRoute.POST(
      req(`/api/notes/meetings/${id}/start`, 'POST', {
        ...CONSENT,
        consent: { method: 'chat_notice' },
      }),
      ctx({ id }),
    );
    expect(unticked.status).toBe(400);
    expect((await detail(id)).meeting.status).toBe('scheduled');

    const started = await json<{
      meeting: { status: string; consent: { state: string; method: string } };
    }>(await startRoute.POST(req(`/api/notes/meetings/${id}/start`, 'POST', CONSENT), ctx({ id })));
    expect(started.meeting.status).toBe('recording');
    expect(started.meeting.consent).toMatchObject({ state: 'confirmed', method: 'chat_notice' });

    const legal = await newMeeting({
      providerEventId: 'evt-legal',
      title: 'Legal review: side letter',
    });
    expect(legal.meeting.consent.state).toBe('blocked');
    expect(legal.meeting.consent.neverRecord?.label).toBe('legal');
    const refused = await startRoute.POST(
      req(`/api/notes/meetings/${legal.meeting.id}/start`, 'POST', CONSENT),
      ctx({ id: legal.meeting.id }),
    );
    expect(refused.status).toBe(403);
    expect(
      (await json<{ error: { details: { never_record: string } } }>(refused)).error.details
        .never_record,
    ).toBe('legal');
  });

  it('hands the recorder its speech settings, only while recording; no key, nothing paid', async () => {
    const { meeting } = await newMeeting();
    const id = meeting.id;
    const early = await speechRoute.POST(
      req(`/api/notes/meetings/${id}/speech-setup`, 'POST', { tracks: ['mic'] }),
      ctx({ id }),
    );
    expect(early.status).toBe(409);
    await startRoute.POST(req(`/api/notes/meetings/${id}/start`, 'POST', CONSENT), ctx({ id }));
    const setup = await json<{
      provider: string;
      sessions: { track: string; knownVoices: unknown[]; sessionConfig: Record<string, unknown> }[];
    }>(
      await speechRoute.POST(
        req(`/api/notes/meetings/${id}/speech-setup`, 'POST', { tracks: ['mic', 'system'] }),
        ctx({ id }),
      ),
    );
    expect(setup.provider).toBe('mock');
    expect(setup.sessions.map((s) => s.track)).toEqual(['mic', 'system']);
    expect(setup.sessions[0]?.knownVoices).toEqual([]);
    expect(JSON.stringify(setup)).not.toMatch(/token|wsUrl|wss:/);

    await meetingRoute.PATCH(
      req(`/api/notes/meetings/${id}`, 'PATCH', { visibility: 'team' }),
      ctx({ id }),
    );
    caller = await teammate();
    const notRecorder = await speechRoute.POST(
      req(`/api/notes/meetings/${id}/speech-setup`, 'POST', { tracks: ['mic'] }),
      ctx({ id }),
    );
    expect(notRecorder.status).toBe(403);
    const notUploader = await segmentsRoute.POST(
      req(`/api/notes/meetings/${id}/segments`, 'POST', {
        segments: scriptedUploads().slice(0, 1),
      }),
      ctx({ id }),
    );
    expect(notUploader.status).toBe(403);
  });

  it('stores the scripted call idempotently, naming the mic and numbering the guests', async () => {
    const { meeting } = await newMeeting();
    const id = meeting.id;
    const first = await recordScriptedCall(id);
    const all = scriptedUploads();
    expect(first).toMatchObject({
      ok: true,
      accepted: all.length,
      duplicates: 0,
      dropped: 0,
      lastSeq: all.length - 1,
    });
    const names = Object.fromEntries(first.speakers.map((s) => [s.clusterKey, s.displayName]));
    expect(names).toEqual({
      mic: 'Nick Tippmann',
      'sys:S1': 'Guest 1',
      'sys:S2': 'Guest 2',
      'sys:S3': 'Guest 3',
    });

    const retry = await json<UploadSegmentsResponse>(
      await segmentsRoute.POST(
        req(`/api/notes/meetings/${id}/segments`, 'POST', { segments: all.slice(0, 5) }),
        ctx({ id }),
      ),
    );
    expect(retry).toMatchObject({ accepted: 0, duplicates: 5 });

    const polled = await json<{ segments: unknown[]; lastSeq: number }>(
      await segmentsRoute.GET(req(`/api/notes/meetings/${id}/segments?after=19`), ctx({ id })),
    );
    expect(polled.segments).toHaveLength(all.length - 20);
    expect(polled.lastSeq).toBe(all.length - 1);
  });

  it('drops a mic line that echoes the meeting audio', async () => {
    const { meeting } = await newMeeting();
    const id = meeting.id;
    await startRoute.POST(req(`/api/notes/meetings/${id}/start`, 'POST', CONSENT), ctx({ id }));
    const said = {
      seq: 0,
      track: 'system',
      clusterKey: 'sys:S1',
      startMs: 1000,
      endMs: 5000,
      text: 'We have about 2.5 committed already.',
    };
    const echo = {
      seq: 1,
      track: 'mic',
      clusterKey: 'mic',
      startMs: 1200,
      endMs: 5100,
      text: 'we have about 2.5 committed already',
    };
    const res = await json<UploadSegmentsResponse>(
      await segmentsRoute.POST(
        req(`/api/notes/meetings/${id}/segments`, 'POST', { segments: [said, echo] }),
        ctx({ id }),
      ),
    );
    expect(res).toMatchObject({ accepted: 1, dropped: 1 });
  });

  it('renames a voice once and every line follows; split and merge move lines', async () => {
    const { meeting } = await newMeeting();
    const id = meeting.id;
    await recordScriptedCall(id);

    const renamed = await json<{
      updatedLines: number;
      speaker: { displayName: string; certainty: string; locked: boolean };
    }>(
      await speakerRoute.PATCH(
        req(`/api/notes/meetings/${id}/speakers/${encodeURIComponent('sys:S2')}`, 'PATCH', {
          person: { name: 'priya', email: 'priya@acmerobotics.example' },
        }),
        ctx({ id, clusterKey: encodeURIComponent('sys:S2') }),
      ),
    );
    // The spelling comes from the invite, not from what was typed.
    expect(renamed.speaker).toMatchObject({
      displayName: 'Priya Shah',
      certainty: 'confirmed',
      locked: true,
    });
    expect(renamed.updatedLines).toBe(
      scriptedUploads().filter((u) => u.clusterKey === 'sys:S2').length,
    );

    const d = await detail(id);
    const names = new Map(d.speakers.map((s) => [s.clusterKey, s.displayName]));
    const priyaLines = d.segments.filter((s) => names.get(s.clusterKey) === 'Priya Shah');
    expect(priyaLines).toHaveLength(renamed.updatedLines);

    const s1Seqs = d.segments.filter((s) => s.clusterKey === 'sys:S1').map((s) => s.seq);
    const split = await json<{ newClusterKey: string; movedLines: number }>(
      await splitRoute.POST(
        req(`/api/notes/meetings/${id}/speakers/split`, 'POST', {
          clusterKey: 'sys:S1',
          fromSeq: s1Seqs[2],
          mode: 'from_here',
        }),
        ctx({ id }),
      ),
    );
    expect(split).toMatchObject({
      ok: true,
      newClusterKey: 'sys:S1#2',
      movedLines: s1Seqs.length - 2,
    });

    const merged = await json<{
      movedLines: number;
      speakers: { clusterKey: string; mergedInto: string | null; lineCount: number }[];
    }>(
      await mergeRoute.POST(
        req(`/api/notes/meetings/${id}/speakers/merge`, 'POST', {
          from: 'sys:S1#2',
          into: 'sys:S1',
        }),
        ctx({ id }),
      ),
    );
    expect(merged.movedLines).toBe(s1Seqs.length - 2);
    const s1 = merged.speakers.find((s) => s.clusterKey === 'sys:S1');
    expect(s1?.lineCount).toBe(s1Seqs.length);
    expect(merged.speakers.find((s) => s.clusterKey === 'sys:S1#2')?.mergedInto).toBe('sys:S1');

    const edited = await json<{ segment: { text: string; edited: boolean; originalText: string } }>(
      await segmentRoute.PATCH(
        req(`/api/notes/meetings/${id}/segments/5`, 'PATCH', {
          text: 'We are at 1.3 million in ARR.',
        }),
        ctx({ id, seq: '5' }),
      ),
    );
    expect(edited.segment).toMatchObject({ text: 'We are at 1.3 million in ARR.', edited: true });
    expect(edited.segment.originalText).toContain('1.2 million');
  });

  it('pauses, stops and writes the notes with sources and action items', async () => {
    const { meeting } = await newMeeting();
    const id = meeting.id;
    await meetingRoute.PATCH(
      req(`/api/notes/meetings/${id}`, 'PATCH', { userNotes: '## Acme\n- Ask about margins' }),
      ctx({ id }),
    );
    await recordScriptedCall(id);
    const paused = await json<{ meeting: { status: string } }>(
      await pauseRoute.POST(
        req(`/api/notes/meetings/${id}/pause`, 'POST', { paused: true }),
        ctx({ id }),
      ),
    );
    expect(paused.meeting.status).toBe('paused');
    const early = await generateRoute.POST(
      req(`/api/notes/meetings/${id}/generate`, 'POST', {}),
      ctx({ id }),
    );
    expect(early.status).toBe(409);

    const stopped = await json<{ meeting: { status: string }; finalize: { queued: boolean } }>(
      await stopRoute.POST(
        req(`/api/notes/meetings/${id}/stop`, 'POST', { reason: 'user' }),
        ctx({ id }),
      ),
    );
    expect(stopped.finalize.queued).toBe(true);
    expect(stopped.meeting.status).toBe('ready');

    const d = await detail(id);
    const note = d.note;
    expect(note?.userNotes).toContain('Ask about margins');
    expect(note?.blocks.filter((b) => b.source === 'typed').map((b) => b.text)).toEqual([
      'Acme',
      'Ask about margins',
    ]);
    const promise = note?.actionItems.find((a) => a.isPrincipalPromise);
    expect(promise?.ownerName).toBe('Nick Tippmann');
    expect(promise?.due).not.toBeNull();
    expect(note?.actionItems.every((a) => a.sources.length === 1)).toBe(true);

    // "Add to Tasks" goes through the tasks service, once.
    const added = await json<{ taskId: string; created: boolean }>(
      await actionRoute.POST(
        req(`/api/notes/meetings/${id}/action-items`, 'POST', { itemId: promise?.id }),
        ctx({ id }),
      ),
    );
    expect(added.created).toBe(true);
    const task = (await harness.store.get(
      'tasks',
      harness.auth.organizationId,
      added.taskId,
    )) as Task;
    expect(task.title).toContain('portfolio operations lead');
    const twice = await json<{ taskId: string; created: boolean }>(
      await actionRoute.POST(
        req(`/api/notes/meetings/${id}/action-items`, 'POST', { itemId: promise?.id }),
        ctx({ id }),
      ),
    );
    expect(twice).toMatchObject({ taskId: added.taskId, created: false });

    const chat = await json<{ answer: string; citations: { label: string; speaker: string }[] }>(
      await chatRoute.POST(
        req(`/api/notes/meetings/${id}/chat`, 'POST', {
          scope: 'meeting',
          question: 'What is the net revenue retention?',
        }),
        ctx({ id }),
      ),
    );
    expect(chat.citations[0]?.speaker).toBe('Guest 1');
    expect(chat.citations[0]?.label).toMatch(/^\[\d+:\d{2} Guest 1\]$/);
  });
});

describe('share links', () => {
  it('share the summary, expire, and open nothing once revoked', async () => {
    const id = DEMO_NOTES_IDS.meetingAcmeIntro;
    const made = await json<{
      url: string;
      link: { id: string; active: boolean; includeTranscript: boolean };
    }>(await shareRoute.POST(req(`/api/notes/meetings/${id}/share`, 'POST', {}), ctx({ id })));
    expect(made.link).toMatchObject({ active: true, includeTranscript: false });
    const token = made.url.split('/n/')[1] ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    // Only the hash is stored.
    const rows = await harness.store.list('note_share_links', harness.auth.organizationId, {});
    expect(JSON.stringify(rows)).not.toContain(token);

    const viewed = await resolveSharedNote(harness.store, token, { ip: '203.0.113.7' });
    expect(viewed.ok).toBe(true);
    if (!viewed.ok) return;
    expect(viewed.value.transcript).toBeNull();
    expect(viewed.value.blocks.length).toBeGreaterThan(0);
    expect(JSON.stringify(viewed.value)).not.toMatch(/@/);

    const thirtyOneDays = new Date(Date.now() + 31 * 86_400_000);
    expect((await resolveSharedNote(harness.store, token, { now: thirtyOneDays })).ok).toBe(false);

    await linkRoute.DELETE(
      req(`/api/notes/meetings/${id}/share/${made.link.id}`, 'DELETE'),
      ctx({ id, linkId: made.link.id }),
    );
    const after = await resolveSharedNote(harness.store, token);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('not_found');

    const listed = await json<{ links: { viewCount: number; active: boolean }[] }>(
      await shareRoute.GET(req(`/api/notes/meetings/${id}/share`), ctx({ id })),
    );
    expect(listed.links[0]).toMatchObject({ viewCount: 1, active: false });
  });

  it('include the transcript only when asked, with names and no addresses', async () => {
    const id = DEMO_NOTES_IDS.meetingAcmeIntro;
    const made = await json<{ url: string }>(
      await shareRoute.POST(
        req(`/api/notes/meetings/${id}/share`, 'POST', {
          includeTranscript: true,
          expiresInDays: 7,
        }),
        ctx({ id }),
      ),
    );
    const viewed = await resolveSharedNote(harness.store, made.url.split('/n/')[1] ?? '');
    if (!viewed.ok) throw new Error('not shared');
    expect(viewed.value.transcript?.[1]?.speaker).toBe('Dana Reyes');
    expect(JSON.stringify(viewed.value)).not.toMatch(/@/);
    expect((await resolveSharedNote(harness.store, 'not-a-token')).ok).toBe(false);
  });
});

describe('share links when the feature is turned off', () => {
  it('open nothing', async () => {
    const id = DEMO_NOTES_IDS.meetingAcmeIntro;
    const made = await json<{ url: string }>(
      await shareRoute.POST(req(`/api/notes/meetings/${id}/share`, 'POST', {}), ctx({ id })),
    );
    const token = made.url.split('/n/')[1] ?? '';
    expect((await resolveSharedNote(harness.store, token)).ok).toBe(true);
    setFlag(undefined);
    expect((await resolveSharedNote(harness.store, token)).ok).toBe(false);
  });
});

describe('templates and voice consent', () => {
  it('lists the built-in templates', async () => {
    const listed = await json<{ templates: { id: string; isBuiltin: boolean }[] }>(
      await templatesRoute.GET(req('/api/notes/templates')),
    );
    expect(listed.templates.filter((t) => t.isBuiltin).map((t) => t.id)).toContain(
      'builtin:founder_pitch',
    );
  });

  it('lets a person consent for themselves, needs evidence for anyone else, and deletes on withdrawal', async () => {
    const forOther = await voiceRoute.POST(
      req('/api/notes/voice-profiles', 'POST', {
        action: 'grant',
        email: 'dana@acmerobotics.example',
        evidence: 'self_checkbox',
      }),
    );
    expect(forOther.status).toBe(400);
    const written = await json<{ profile: { consentStatus: string; enrolled: boolean } }>(
      await voiceRoute.POST(
        req('/api/notes/voice-profiles', 'POST', {
          action: 'grant',
          email: 'dana@acmerobotics.example',
          evidence: 'written',
        }),
      ),
    );
    expect(written.profile).toMatchObject({ consentStatus: 'granted', enrolled: false });

    const profile = await harness.store.findOne('voice_profiles', harness.auth.organizationId, {
      eq: { person_email: 'dana@acmerobotics.example' },
    });
    await harness.store.insert('voice_identifiers', {
      id: '0d000000-0000-4000-8000-0000000000aa',
      organization_id: harness.auth.organizationId,
      voice_profile_id: profile!.id,
      identifier_enc: { ciphertext: 'x', iv: 'y', authTag: 'z', keyVersion: 1 },
      model_version: 'test',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const listed = await json<{ profiles: { email: string; enrolled: boolean }[] }>(
      await voiceRoute.GET(req('/api/notes/voice-profiles')),
    );
    expect(listed.profiles.find((p) => p.email === 'dana@acmerobotics.example')?.enrolled).toBe(
      true,
    );
    expect(JSON.stringify(listed)).not.toContain('ciphertext');

    const revoked = await json<{ profile: { consentStatus: string; enrolled: boolean } }>(
      await voiceRoute.POST(
        req('/api/notes/voice-profiles', 'POST', {
          action: 'revoke',
          email: 'dana@acmerobotics.example',
        }),
      ),
    );
    expect(revoked.profile).toMatchObject({ consentStatus: 'revoked', enrolled: false });
    expect(await harness.store.count('voice_identifiers', harness.auth.organizationId, {})).toBe(0);
  });
});

describe('the readers that predate Kraken Notes', () => {
  it('keep a private Kraken note off shared pages, and Granola’s catch-up window on Granola', async () => {
    const { listMeetingNotes, catchUpSince } = await import('@/lib/services/meetings');
    const before = await catchUpSince(harness.store, harness.auth.organizationId);
    const { meeting } = await newMeeting({ providerEventId: 'evt-private', title: 'Quiet chat' });
    await meetingRoute.PATCH(
      req(`/api/notes/meetings/${meeting.id}`, 'PATCH', { userNotes: 'Private thoughts' }),
      ctx({ id: meeting.id }),
    );
    const titles = async () =>
      (await listMeetingNotes(harness.store, harness.auth.organizationId)).map((n) => n.title);
    expect(await titles()).not.toContain('Quiet chat');
    // A note from today does not move Granola's catch-up window.
    expect(await catchUpSince(harness.store, harness.auth.organizationId)).toBe(before);

    await meetingRoute.PATCH(
      req(`/api/notes/meetings/${meeting.id}`, 'PATCH', { visibility: 'team' }),
      ctx({ id: meeting.id }),
    );
    expect(await titles()).toContain('Quiet chat');
  });
});

describe('before the migration is applied', () => {
  it('answers "not set up yet" instead of failing', async () => {
    const missing = Object.assign(new Error('relation "meetings" does not exist'), {
      code: '42P01',
    });
    const store = new Proxy(harness.store, {
      get(target, prop, receiver) {
        if (prop === 'get' || prop === 'list' || prop === 'findOne') {
          return async (table: string, ...rest: unknown[]) => {
            if (table === 'meetings') throw missing;
            return (Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown).call(
              target,
              table,
              ...rest,
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const { getMeetingDetail } = await import('@/lib/services/notes');
    const result = await getMeetingDetail(
      { store, auth: harness.auth },
      DEMO_NOTES_IDS.meetingAcmeIntro,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_configured');
  });
});
