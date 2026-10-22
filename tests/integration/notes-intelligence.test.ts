import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '@/lib/ai/provider';
import { UnavailableAIProvider } from '@/lib/ai/unavailable';
import type { AuthContext } from '@/lib/auth/session';
import { resetEnvCache } from '@/lib/config/env';
import { DEMO_IDS } from '@/lib/demo/ids';
import { DEMO_NOTES_IDS } from '@/lib/demo/notes-fixtures';
import { buildFeedReport, readCaptureState } from '@/lib/services/feed-health';
import { countMeetingNotes, ingestGranolaNote, listMeetingNotes } from '@/lib/services/meetings';
import { fireMeetingFollowUp, followUpFireText } from '@/lib/services/notes-followup';
import { purgeNotes } from '@/lib/services/notes-purge';
import { searchEverything } from '@/lib/services/search';
import { knownSpeakersFor } from '@/lib/services/voice-profiles';
import { clusterKeyFor } from '@/lib/transcribe/cluster';
import {
  mockTranscriptEvents,
  mockVoiceIdentifiers,
  MOCK_CALL_LINES,
} from '@/lib/transcribe/mock-script';
import type { AuditEvent, MeetingNote } from '@/lib/types/domain';
import type {
  CreateMeetingResponse,
  Meeting,
  MeetingDetailResponse,
  RelabelSpeakerResponse,
  SegmentUpload,
  SpeakerView,
  TranscriptSegment,
  UploadSegmentsResponse,
} from '@/lib/types/notes';
import { err, ok } from '@/lib/util/result';
import { createHarness, type Harness } from '../helpers/harness';

/**
 * Copilot Notes' intelligence (D-076), end to end in demo mode with the
 * offline model: notes written through generateStructured (and the rules
 * draft when no model can), the naming ladder live and after a tap, voice
 * consent and enrolment, chat citations, the follow-up routine trigger,
 * settings, the event card, the roster, search, Granola twins, the purge and
 * the recorder feed. Fictional people only.
 */

let harness: Harness;
let caller: AuthContext | null = null;
let aiOverride: AIProvider | null = null;

vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  authOrError: async () => (caller ? ok(caller) : err('unauthenticated', 'Sign in.')),
}));

vi.mock('@/lib/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime')>();
  return { ...actual, getAI: () => aiOverride ?? actual.getAI() };
});

const meetingsRoute = await import('@/app/api/notes/meetings/route');
const meetingRoute = await import('@/app/api/notes/meetings/[id]/route');
const startRoute = await import('@/app/api/notes/meetings/[id]/start/route');
const stopRoute = await import('@/app/api/notes/meetings/[id]/stop/route');
const segmentsRoute = await import('@/app/api/notes/meetings/[id]/segments/route');
const speakerRoute = await import('@/app/api/notes/meetings/[id]/speakers/[clusterKey]/route');
const mergeRoute = await import('@/app/api/notes/meetings/[id]/speakers/merge/route');
const generateRoute = await import('@/app/api/notes/meetings/[id]/generate/route');
const chatRoute = await import('@/app/api/notes/meetings/[id]/chat/route');
const rosterRoute = await import('@/app/api/notes/meetings/[id]/roster/route');
const voiceRoute = await import('@/app/api/notes/voice-profiles/route');
const enrollRoute = await import('@/app/api/notes/voice-profiles/enroll/route');
const enrollSessionRoute = await import('@/app/api/notes/voice-profiles/enroll-session/route');
const preferencesRoute = await import('@/app/api/notes/preferences/route');
const rulesRoute = await import('@/app/api/notes/recording-rules/route');
const ruleRoute = await import('@/app/api/notes/recording-rules/[id]/route');
const templatesRoute = await import('@/app/api/notes/templates/route');
const templateRoute = await import('@/app/api/notes/templates/[id]/route');
const eventRoute = await import('@/app/api/notes/by-event/route');

const ORIGIN = 'http://localhost:3000';
const SAVED = {
  flag: process.env.NOTES_ENABLED,
  demo: process.env.DEMO_MODE,
  url: process.env.MEETING_FOLLOWUP_FIRE_URL,
  token: process.env.MEETING_FOLLOWUP_FIRE_TOKEN,
};

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

const CONSENT = { consent: { confirmed: true, method: 'chat_notice' }, captureSource: 'web' };
const DANA = { email: 'dana@acmerobotics.example', name: 'Dana Reyes' };
const PRIYA = { email: 'priya@acmerobotics.example', name: 'Priya Shah' };

function uploads(): SegmentUpload[] {
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
  return json<CreateMeetingResponse>(
    await meetingsRoute.POST(
      req('/api/notes/meetings', 'POST', {
        source: 'calendar',
        providerEventId: `evt-${Math.random().toString(36).slice(2)}`,
        title: 'Acme Robotics intro',
        attendees: [DANA, PRIYA, { email: 'nick@tiptop.demo', name: 'Nick Tippmann' }],
        ...body,
      }),
    ),
  );
}

async function start(id: string) {
  return startRoute.POST(req(`/api/notes/meetings/${id}/start`, 'POST', CONSENT), ctx({ id }));
}

async function upload(id: string, segments: SegmentUpload[]) {
  return json<UploadSegmentsResponse>(
    await segmentsRoute.POST(
      req(`/api/notes/meetings/${id}/segments`, 'POST', { segments }),
      ctx({ id }),
    ),
  );
}

async function stop(id: string) {
  return json<{ meeting: { status: string }; finalize: { queued: boolean } }>(
    await stopRoute.POST(
      req(`/api/notes/meetings/${id}/stop`, 'POST', { reason: 'user' }),
      ctx({ id }),
    ),
  );
}

async function detail(id: string) {
  return json<MeetingDetailResponse>(
    await meetingRoute.GET(req(`/api/notes/meetings/${id}`), ctx({ id })),
  );
}

async function relabel(id: string, clusterKey: string, body: Record<string, unknown>) {
  return json<RelabelSpeakerResponse>(
    await speakerRoute.PATCH(
      req(`/api/notes/meetings/${id}/speakers/${encodeURIComponent(clusterKey)}`, 'PATCH', body),
      ctx({ id, clusterKey: encodeURIComponent(clusterKey) }),
    ),
  );
}

const names = (speakers: SpeakerView[]) =>
  Object.fromEntries(speakers.map((s) => [s.clusterKey, s.displayName]));

async function recordedAndStopped(typed?: string) {
  const { meeting } = await newMeeting();
  if (typed) {
    await meetingRoute.PATCH(
      req(`/api/notes/meetings/${meeting.id}`, 'PATCH', { userNotes: typed }),
      ctx({ id: meeting.id }),
    );
  }
  await start(meeting.id);
  await upload(meeting.id, uploads());
  const stopped = await stop(meeting.id);
  return { id: meeting.id, stopped };
}

function setFlag(value: string | undefined) {
  if (value === undefined) delete process.env.NOTES_ENABLED;
  else process.env.NOTES_ENABLED = value;
  resetEnvCache();
}

beforeEach(async () => {
  setFlag('on');
  aiOverride = null;
  harness = await createHarness({ now: new Date() });
  caller = harness.auth;
});

afterEach(async () => {
  aiOverride = null;
  caller = null;
  await harness.dispose();
});

afterAll(() => {
  setFlag(SAVED.flag);
  process.env.DEMO_MODE = SAVED.demo;
  resetEnvCache();
});

/* ===================================================================== */

describe('notes written by the model', () => {
  it('Stop writes the notes through the model: typed lines verbatim, every point cited, the template picked', async () => {
    const { id, stopped } = await recordedAndStopped('## Acme\n- Ask about margins');
    expect(stopped).toMatchObject({ meeting: { status: 'ready' }, finalize: { queued: true } });
    const d = await detail(id);
    const note = d.note;
    expect(note?.model).toBe('demo-offline-model');
    expect(note?.promptVersion).toBe('meeting-notes@1.0.0');
    expect(note?.blocks.filter((b) => b.source === 'typed').map((b) => b.text)).toEqual([
      'Acme',
      'Ask about margins',
    ]);
    const seqs = new Set(d.segments.map((s) => s.seq));
    for (const block of note?.blocks.filter((b) => b.source === 'ai' && b.kind !== 'heading') ??
      []) {
      expect(block.sources.length).toBeGreaterThan(0);
      for (const r of block.sources) expect(seqs.has(r.fromSeq) && seqs.has(r.toSeq)).toBe(true);
    }
    const promise = note?.actionItems.find((a) => a.isPrincipalPromise);
    expect(promise).toMatchObject({ ownerName: 'Nick Tippmann' });
    expect(promise?.due).not.toBeNull();
    // "intro" in the title, nothing in the CRM: the intro call template, chosen automatically.
    expect(d.template?.id).toBe('builtin:intro_call');
    const usage = await harness.store.list('ai_usage', harness.auth.organizationId, {
      eq: { operation: 'meeting.notes' },
    });
    expect(usage.length).toBe(1);
  });

  it('without a model, the rules draft keeps the meeting usable; Regenerate uses the model once it is back', async () => {
    aiOverride = new UnavailableAIProvider();
    const { id, stopped } = await recordedAndStopped();
    expect(stopped.meeting.status).toBe('ready');
    expect((await detail(id)).note).toMatchObject({
      model: 'none',
      promptVersion: 'meeting-notes-draft@0.1.0',
    });

    aiOverride = null;
    const again = await json<{ note: { model: string } }>(
      await generateRoute.POST(req(`/api/notes/meetings/${id}/generate`, 'POST', {}), ctx({ id })),
    );
    expect(again.note.model).toBe('demo-offline-model');
  });

  it('a model that fails is recorded and the draft is kept', async () => {
    const failing: AIProvider = {
      kind: 'anthropic',
      available: () => true,
      generateStructured: async () => err('provider_unavailable', 'Down for the test.'),
      generateText: async () => err('provider_unavailable', 'Down for the test.'),
      runToolConversation: async () => err('provider_unavailable', 'Down for the test.'),
    };
    aiOverride = failing;
    const { id } = await recordedAndStopped();
    expect((await detail(id)).note?.model).toBe('none');
    const audits = (await harness.store.list('audit_events', harness.auth.organizationId, {
      eq: { action: 'notes.generated', entity_id: id },
    })) as AuditEvent[];
    expect(audits[0]?.metadata).toMatchObject({ ai_error: 'provider_unavailable', model: 'none' });
  });

  it('chat answers from the transcript and cites "[0:40 Guest 1]"', async () => {
    const { id } = await recordedAndStopped();
    const chat = await json<{
      answer: string;
      citations: { label: string; speaker: string; seq: number }[];
    }>(
      await chatRoute.POST(
        req(`/api/notes/meetings/${id}/chat`, 'POST', {
          scope: 'meeting',
          question: 'What is the net revenue retention?',
        }),
        ctx({ id }),
      ),
    );
    expect(chat.answer).toContain('[0:40 Guest 1]');
    expect(chat.citations[0]).toMatchObject({ speaker: 'Guest 1', label: '[0:40 Guest 1]' });
    const all = await json<{ answer: string }>(
      await chatRoute.POST(
        req(`/api/notes/meetings/${id}/chat`, 'POST', {
          scope: 'company',
          companyDomain: 'acmerobotics.example',
          question: 'retention',
        }),
        ctx({ id }),
      ),
    );
    expect(all.ok).toBe(true);
  });
});

describe('the naming ladder, live', () => {
  it('streamed lines: two guests and two voices are named as they talk; a late joiner stays a guest', async () => {
    const { meeting } = await newMeeting();
    await start(meeting.id);
    const all = uploads();
    const first = await upload(meeting.id, all.slice(0, 9));
    expect(names(first.speakers)).toEqual({
      mic: 'Nick Tippmann',
      'sys:S1': 'Dana Reyes',
      'sys:S2': 'Priya Shah',
    });
    expect(first.speakers.find((s) => s.clusterKey === 'sys:S1')?.certainty).toBe('calendar');
    const rest = await upload(meeting.id, all.slice(9));
    expect(names(rest.speakers)).toEqual({
      mic: 'Nick Tippmann',
      'sys:S1': 'Dana Reyes',
      'sys:S2': 'Priya Shah',
      'sys:S3': 'Guest 3',
    });
  });

  it('all at once with an uninvited voice: guests with ranked chips, until a tap names the late joiner', async () => {
    const { meeting } = await newMeeting();
    await start(meeting.id);
    const uploaded = await upload(meeting.id, uploads());
    const s1 = uploaded.speakers.find((s) => s.clusterKey === 'sys:S1');
    expect(s1?.resolved).toBe(false);
    expect(s1?.suggestions[0]).toMatchObject({ name: 'Dana Reyes' });

    const tapped = await relabel(meeting.id, 'sys:S3', { person: { name: 'Sam Lee' } });
    expect(names(tapped.speakers)).toEqual({
      mic: 'Nick Tippmann',
      'sys:S1': 'Dana Reyes',
      'sys:S2': 'Priya Shah',
      'sys:S3': 'Sam Lee',
    });
    expect(tapped.speaker).toMatchObject({ locked: true, certainty: 'confirmed' });
  });

  it('a rename re-owns action items and rewrites the notes; a merge hands items to the voice it joined', async () => {
    const { id } = await recordedAndStopped();
    const before = (await detail(id)).note;
    expect(before?.actionItems.find((a) => a.text.includes('case study'))?.ownerName).toBe(
      'Guest 3',
    );
    const tapped = await relabel(id, 'sys:S3', { person: { name: 'Sam Lee' } });
    expect(tapped.notesRefreshing).toBe(true);
    const after = (await detail(id)).note;
    expect(after?.actionItems.find((a) => a.text.includes('case study'))?.ownerName).toBe(
      'Sam Lee',
    );
    expect(after?.stale).toBe(false);

    await json(
      await mergeRoute.POST(
        req(`/api/notes/meetings/${id}/speakers/merge`, 'POST', { from: 'sys:S3', into: 'sys:S1' }),
        ctx({ id }),
      ),
    );
    const merged = (await detail(id)).note;
    expect(merged?.actionItems.find((a) => a.text.includes('case study'))?.ownerName).toBe(
      'Dana Reyes',
    );
  });

  it('the meeting app roster names voices nobody picked', async () => {
    const { meeting } = await newMeeting();
    await start(meeting.id);
    await upload(meeting.id, uploads());
    const turnsOf = (who: string, name: string, email: string) =>
      MOCK_CALL_LINES.filter((l) => l.speaker === who).map((l) => ({
        name,
        email,
        startMs: l.startMs,
        endMs: l.endMs,
      }));
    const applied = await json<{ speakers: SpeakerView[]; named: number }>(
      await rosterRoute.POST(
        req(`/api/notes/meetings/${meeting.id}/roster`, 'POST', {
          turns: [
            ...turnsOf('dana', DANA.name, DANA.email),
            ...turnsOf('priya', PRIYA.name, PRIYA.email),
          ],
        }),
        ctx({ id: meeting.id }),
      ),
    );
    expect(applied.named).toBeGreaterThanOrEqual(2);
    expect(applied.speakers.find((s) => s.clusterKey === 'sys:S1')).toMatchObject({
      displayName: 'Dana Reyes',
      certainty: 'roster',
    });
  });
});

describe('voice profiles', () => {
  it('nobody is remembered without consent; with it, enrolment seals and recognises the voice', async () => {
    const { meeting } = await newMeeting();
    await start(meeting.id);
    await upload(meeting.id, uploads());
    const refused = await relabel(meeting.id, 'sys:S1', { person: DANA, rememberVoice: true });
    expect(refused.rememberVoice).toEqual({
      status: 'no_consent',
      vendorLabel: null,
      email: DANA.email,
    });
    const noConsent = await enrollRoute.POST(
      req('/api/notes/voice-profiles/enroll', 'POST', {
        email: DANA.email,
        identifiers: ['x'],
        modelVersion: 'test',
      }),
    );
    expect(noConsent.status).toBe(403);

    await voiceRoute.POST(
      req('/api/notes/voice-profiles', 'POST', {
        action: 'grant',
        email: DANA.email,
        name: DANA.name,
        evidence: 'written',
      }),
    );
    const asked = await relabel(meeting.id, 'sys:S1', { rememberVoice: true });
    expect(asked.rememberVoice).toEqual({
      status: 'requested',
      vendorLabel: 'S1',
      email: DANA.email,
    });

    const session = await json<{
      provider: string;
      session: { sessionConfig: Record<string, unknown> };
    }>(
      await enrollSessionRoute.POST(
        req('/api/notes/voice-profiles/enroll-session', 'POST', { email: DANA.email }),
      ),
    );
    expect(session).toMatchObject({
      provider: 'mock',
      session: { sessionConfig: { enrollment: true } },
    });
    const enrolled = await json<{ profile: { enrolled: boolean } }>(
      await enrollRoute.POST(
        req('/api/notes/voice-profiles/enroll', 'POST', {
          email: DANA.email,
          identifiers: mockVoiceIdentifiers(DANA.email),
          modelVersion: 'test',
        }),
      ),
    );
    expect(enrolled.profile.enrolled).toBe(true);
    const stored = JSON.stringify(
      await harness.store.list('voice_identifiers', harness.auth.organizationId),
    );
    expect(stored).not.toContain(mockVoiceIdentifiers(DANA.email)[0]);

    const known = await knownSpeakersFor({ store: harness.store, auth: harness.auth }, [
      DANA.email,
    ]);
    expect(known).toEqual([
      { label: expect.any(String), identifiers: mockVoiceIdentifiers(DANA.email) },
    ]);

    // A later meeting: the vendor labels Dana's words with her profile id.
    const second = await newMeeting({ title: 'Acme second call' });
    await start(second.meeting.id);
    const profileKey = `sys:${known[0]?.label}`;
    const matched = await upload(second.meeting.id, [
      {
        seq: 0,
        track: 'system',
        clusterKey: profileKey,
        startMs: 0,
        endMs: 3000,
        text: 'Good to see you again, everyone.',
      },
    ]);
    expect(matched.speakers.find((s) => s.clusterKey === profileKey)).toMatchObject({
      displayName: 'Dana Reyes',
      certainty: 'voice',
    });

    // Withdrawn: the identifier is gone at once.
    await voiceRoute.POST(
      req('/api/notes/voice-profiles', 'POST', { action: 'revoke', email: DANA.email }),
    );
    expect(await harness.store.list('voice_identifiers', harness.auth.organizationId)).toEqual([]);
    expect(
      await knownSpeakersFor({ store: harness.store, auth: harness.auth }, [DANA.email]),
    ).toEqual([]);
  });
});

describe('the follow-up routine', () => {
  afterEach(() => {
    process.env.DEMO_MODE = SAVED.demo;
    for (const [key, value] of [
      ['MEETING_FOLLOWUP_FIRE_URL', SAVED.url],
      ['MEETING_FOLLOWUP_FIRE_TOKEN', SAVED.token],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
  });

  it('is told the meeting id once, for a team meeting only, and never in demo mode', async () => {
    const meeting = (await harness.store.get(
      'meetings',
      harness.auth.organizationId,
      DEMO_NOTES_IDS.meetingAcmeIntro,
    )) as Meeting;
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const notesCtx = { store: harness.store, auth: harness.auth };

    expect(await fireMeetingFollowUp(notesCtx, meeting, fakeFetch)).toBe('not_set_up');
    process.env.MEETING_FOLLOWUP_FIRE_URL = 'https://routines.example/fire';
    process.env.MEETING_FOLLOWUP_FIRE_TOKEN = 'test-token-not-real';
    resetEnvCache();
    expect(await fireMeetingFollowUp(notesCtx, meeting, fakeFetch)).toBe('not_set_up');

    process.env.DEMO_MODE = 'false';
    resetEnvCache();
    expect(
      await fireMeetingFollowUp(notesCtx, { ...meeting, visibility: 'private' }, fakeFetch),
    ).toBe('private');
    expect(await fireMeetingFollowUp(notesCtx, meeting, fakeFetch)).toBe('fired');
    expect(await fireMeetingFollowUp(notesCtx, meeting, fakeFetch)).toBe('already');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://routines.example/fire');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ text: followUpFireText(meeting.id) });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token-not-real',
    );
  });
});

describe('settings', () => {
  it("each person's default visibility applies to the meetings they record", async () => {
    const before = await newMeeting();
    expect(before.meeting.visibility).toBe('private');
    const saved = await json<{ preferences: { defaultVisibility: string } }>(
      await preferencesRoute.POST(
        req('/api/notes/preferences', 'POST', { defaultVisibility: 'team' }),
      ),
    );
    expect(saved.preferences.defaultVisibility).toBe('team');
    expect((await newMeeting()).meeting.visibility).toBe('team');
    const read = await json<{ preferences: { defaultVisibility: string } }>(
      await preferencesRoute.GET(req('/api/notes/preferences')),
    );
    expect(read.preferences.defaultVisibility).toBe('team');
  });

  it('never-record rules: any member adds one, only an admin removes one, the built-ins are fixed', async () => {
    const made = await json<{ rule: { id: string; pattern: string } }>(
      await rulesRoute.POST(
        req('/api/notes/recording-rules', 'POST', {
          kind: 'attendee_domain',
          pattern: '@Sister.example',
          label: 'sister company',
        }),
      ),
    );
    expect(made.rule.pattern).toBe('sister.example');
    const blocked = await newMeeting({
      attendees: [{ email: 'pat@sister.example', name: 'Pat Doe' }],
    });
    expect(blocked.meeting.consent).toMatchObject({ state: 'blocked' });

    const listed = await json<{ rules: { id: string; isDefault: boolean }[] }>(
      await rulesRoute.GET(req('/api/notes/recording-rules')),
    );
    const builtin = listed.rules.find((r) => r.isDefault);
    expect(listed.rules[0]?.id).toBe(made.rule.id);
    const fixed = await ruleRoute.PATCH(
      req(`/api/notes/recording-rules/${builtin?.id}`, 'PATCH', { enabled: false }),
      ctx({ id: encodeURIComponent(builtin?.id ?? '') }),
    );
    expect(fixed.status).toBe(403);

    caller = { ...harness.auth, role: 'member' };
    const asMember = await ruleRoute.DELETE(
      req(`/api/notes/recording-rules/${made.rule.id}`, 'DELETE'),
      ctx({ id: made.rule.id }),
    );
    expect(asMember.status).toBe(403);
    caller = harness.auth;
    const asOwner = await ruleRoute.DELETE(
      req(`/api/notes/recording-rules/${made.rule.id}`, 'DELETE'),
      ctx({ id: made.rule.id }),
    );
    expect(asOwner.status).toBe(200);
  });

  it('custom templates can be edited and archived; built-in ones cannot', async () => {
    const made = await json<{ template: { id: string } }>(
      await templatesRoute.POST(
        req('/api/notes/templates', 'POST', {
          name: 'Hardware diligence',
          sections: [{ heading: 'Unit economics', prompt: 'Margins and costs.' }],
        }),
      ),
    );
    const renamed = await json<{ template: { name: string } }>(
      await templateRoute.PATCH(
        req(`/api/notes/templates/${made.template.id}`, 'PATCH', { name: 'Hardware deep dive' }),
        ctx({ id: made.template.id }),
      ),
    );
    expect(renamed.template.name).toBe('Hardware deep dive');
    const builtin = await templateRoute.PATCH(
      req('/api/notes/templates/builtin%3Afounder_pitch', 'PATCH', { name: 'Mine now' }),
      ctx({ id: 'builtin%3Afounder_pitch' }),
    );
    expect(builtin.status).toBe(403);
    await templateRoute.DELETE(
      req(`/api/notes/templates/${made.template.id}`, 'DELETE'),
      ctx({ id: made.template.id }),
    );
    const listed = await json<{ templates: { id: string }[] }>(
      await templatesRoute.GET(req('/api/notes/templates')),
    );
    expect(listed.templates.some((t) => t.id === made.template.id)).toBe(false);
  });
});

describe('the event card', () => {
  it('finds the meeting for an event and earlier notes with the same guests', async () => {
    const found = await json<{
      meeting: { id: string } | null;
      pastNotes: { qualifiedId: string }[];
    }>(
      await eventRoute.GET(
        req(
          `/api/notes/by-event?eventId=demo-notes-acme-follow-up&emails=${encodeURIComponent(`${DANA.email},nick@tiptop.demo`)}`,
        ),
      ),
    );
    expect(found.meeting?.id).toBe(DEMO_NOTES_IDS.meetingAcmeFollowUp);
    expect(found.pastNotes.map((n) => n.qualifiedId)).toEqual([
      `copilot:${DEMO_NOTES_IDS.meetingAcmeIntro}`,
    ]);
  });
});

describe('search', () => {
  it('global search finds a transcript line and opens it at that moment, for people with Notes on', async () => {
    const results = await searchEverything(
      harness.store,
      harness.auth.organizationId,
      'retention',
      harness.auth,
    );
    const hit = results.find((r) => r.href.includes('tab=transcript'));
    expect(
      hit?.href.startsWith(`/meetings/${DEMO_NOTES_IDS.meetingAcmeIntro}?tab=transcript&t=`),
    ).toBe(true);
    expect(hit?.sub).toMatch(/^Transcript · \d+:\d{2} /);
    setFlag(undefined);
    const off = await searchEverything(
      harness.store,
      harness.auth.organizationId,
      'retention',
      harness.auth,
    );
    expect(off.some((r) => r.href.includes('tab=transcript'))).toBe(false);
  });

  it("never shows a line from someone else's private meeting", async () => {
    await harness.store.update(
      'meetings',
      harness.auth.organizationId,
      DEMO_NOTES_IDS.meetingAcmeIntro,
      {
        visibility: 'private',
        recorded_by: DEMO_IDS.userTeammate,
      },
    );
    const results = await searchEverything(
      harness.store,
      harness.auth.organizationId,
      'retention',
      harness.auth,
    );
    expect(results.some((r) => r.href.includes('tab=transcript'))).toBe(false);
  });
});

describe('Granola twins', () => {
  it('a Granola note of a recorded meeting is paired on arrival and listed once', async () => {
    const intro = (await harness.store.get(
      'meetings',
      harness.auth.organizationId,
      DEMO_NOTES_IDS.meetingAcmeIntro,
    )) as Meeting;
    const before = await countMeetingNotes(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
    );
    const ingested = await ingestGranolaNote(harness.store, harness.auth.organizationId, {
      external_id: 'granola-acme-twin',
      title: intro.title,
      occurred_at: intro.started_at as string,
      attendee_emails: [DANA.email],
      attendee_names: [DANA.name],
      content: "Granola's summary of the same call.",
    });
    expect(ingested.ok).toBe(true);
    const paired = (await harness.store.get(
      'meetings',
      harness.auth.organizationId,
      intro.id,
    )) as Meeting;
    expect(paired.granola_external_id).toBe('granola-acme-twin');
    const listed = (await listMeetingNotes(
      harness.store,
      harness.auth.organizationId,
    )) as MeetingNote[];
    expect(listed.some((n) => n.external_id === 'granola-acme-twin')).toBe(false);
    expect(listed.some((n) => n.provider === 'copilot' && n.external_id === intro.id)).toBe(true);
    const after = await countMeetingNotes(
      harness.store,
      harness.auth.organizationId,
      harness.auth.userId,
    );
    expect(after).toEqual({
      granola: before.granola + 1,
      copilot: before.copilot,
      total: before.total,
    });
  });
});

describe('housekeeping', () => {
  it('purges meetings a week in the trash, with everything under them', async () => {
    const org = harness.auth.organizationId;
    const now = new Date();
    await harness.store.update('meetings', org, DEMO_NOTES_IDS.meetingAcmeIntro, {
      deleted_at: new Date(now.getTime() - 8 * 86_400_000).toISOString(),
    });
    await harness.store.update('meetings', org, DEMO_NOTES_IDS.meetingAcmeFollowUp, {
      deleted_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    });
    const purged = await purgeNotes(harness.store, org, now);
    expect(purged.meetings).toBe(1);
    expect(await harness.store.get('meetings', org, DEMO_NOTES_IDS.meetingAcmeIntro)).toBeNull();
    expect(
      await harness.store.get('meetings', org, DEMO_NOTES_IDS.meetingAcmeFollowUp),
    ).not.toBeNull();
    const lines = (await harness.store.list('transcript_segments', org, {
      eq: { meeting_id: DEMO_NOTES_IDS.meetingAcmeIntro },
    })) as TranscriptSegment[];
    expect(lines).toEqual([]);
    expect(await harness.store.get('meeting_notes', org, DEMO_NOTES_IDS.noteAcmeIntro)).toBeNull();
  });

  it('notices a recorder that went quiet', async () => {
    const org = harness.auth.organizationId;
    const now = new Date();
    await harness.store.update('meetings', org, DEMO_NOTES_IDS.meetingAcmeFollowUp, {
      status: 'recording',
      started_at: new Date(now.getTime() - 40 * 60_000).toISOString(),
    });
    const capture = await readCaptureState(harness.store, org, now);
    expect(capture.stuck).toBe(1);
    const base = {
      readAt: now.toISOString(),
      dealRelay: { state: 'off' as const, reason: 'test' },
      askRelay: { state: 'off' as const, reason: 'test' },
      reports: [],
      jobs: {},
      affinity: null,
      notes: null,
      ask: null,
    };
    const row = (capture2: Parameters<typeof buildFeedReport>[0]['capture']) =>
      buildFeedReport({ ...base, capture: capture2 }, now, 'America/Chicago').rows.find(
        (r) => r.id === 'meeting-capture',
      );
    expect(row({ configured: true, ...capture })?.status).toBe('stopped');
    expect(row({ configured: true, lastAt: capture.lastAt, stuck: 0 })?.status).toBe('ok');
    expect(row({ configured: false, lastAt: null, stuck: 0 })?.status).toBe('off');
    expect(row(null)?.status).toBe('unknown');
  });
});
