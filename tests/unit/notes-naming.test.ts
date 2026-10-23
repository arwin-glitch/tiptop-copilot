import { describe, expect, it } from 'vitest';
import { eliminate } from '@/lib/speakers/calendar-elimination';
import { planNaming, type NamingInput } from '@/lib/speakers/naming';
import { alignRoster } from '@/lib/speakers/roster';
import {
  candidateKey,
  findCues,
  scoreCues,
  type CueCandidate,
  type CueLine,
} from '@/lib/speakers/transcript-cues';
import { clusterKeyFor } from '@/lib/transcribe/cluster';
import { mockTranscriptEvents } from '@/lib/transcribe/mock-script';
import type { MeetingParticipant, MeetingSpeaker } from '@/lib/types/notes';

/**
 * The naming ladder below a person's tap (D-076): transcript cues,
 * calendar elimination, the roster, voiceprints, and the planner that
 * combines them. Fictional people only (the scripted Acme Robotics call).
 */

const DANA: CueCandidate = {
  key: 'dana@acmerobotics.example',
  name: 'Dana Reyes',
  email: 'dana@acmerobotics.example',
  crmPersonId: null,
};
const PRIYA: CueCandidate = {
  key: 'priya@acmerobotics.example',
  name: 'Priya Shah',
  email: 'priya@acmerobotics.example',
  crmPersonId: null,
};

const line = (seq: number, clusterKey: string, text: string, startMs = seq * 5000): CueLine => ({
  seq,
  clusterKey,
  startMs,
  text,
});

function scriptLines(): CueLine[] {
  return mockTranscriptEvents(['mic', 'system']).map((e, seq) => ({
    seq,
    clusterKey: clusterKeyFor(e.track, e.speakerLabel),
    startMs: e.startMs,
    text: e.text,
  }));
}

function speaker(key: string, extra: Partial<MeetingSpeaker> = {}): MeetingSpeaker {
  const now = '2026-10-01T15:00:00.000Z';
  return {
    id: `id-${key}`,
    organization_id: 'org',
    meeting_id: 'm1',
    cluster_key: key,
    track: key.startsWith('mic') ? 'mic' : key.startsWith('mix') ? 'mixed' : 'system',
    person_email: null,
    display_name: null,
    crm_person_id: null,
    user_id: null,
    guest_number: null,
    source: null,
    confidence: null,
    locked: false,
    suggestions: [],
    merged_into: null,
    split_from: null,
    split_at_seq: null,
    confirmed_by: null,
    confirmed_at: null,
    created_at: now,
    updated_at: now,
    ...extra,
  };
}

const OWNER_MIC = speaker('mic', {
  person_email: 'owner@tiptop.example',
  display_name: 'Morgan Lee',
  user_id: 'user-owner',
  source: 'channel',
  confidence: 1,
});

const INVITE: NamingInput['participants'] = [
  {
    email: 'owner@tiptop.example',
    name: 'Morgan Lee',
    role: 'self',
    crm_person_id: null,
    user_id: 'user-owner',
  },
  { email: DANA.email, name: DANA.name, role: 'guest', crm_person_id: null, user_id: null },
  { email: PRIYA.email, name: PRIYA.name, role: 'guest', crm_person_id: null, user_id: null },
] satisfies Pick<MeetingParticipant, 'email' | 'name' | 'role' | 'crm_person_id' | 'user_id'>[];

describe('transcript cues', () => {
  it('finds self-introductions, a name before an answer, and thanks after one', () => {
    const cues = findCues(scriptLines(), [DANA, PRIYA], new Set(['mic']));
    const s1 = cues.filter((c) => c.clusterKey === 'sys:S1').map((c) => c.candidateKey);
    const s2 = cues.filter((c) => c.clusterKey === 'sys:S2').map((c) => c.candidateKey);
    expect(s1).toContain(DANA.key);
    expect(s2).toContain(PRIYA.key);
    expect(s2).not.toContain(DANA.key);
    // The late joiner is never named.
    expect(cues.some((c) => c.clusterKey === 'sys:S3')).toBe(false);
    // Reasons are in plain words, with the moment.
    expect(cues.find((c) => c.clusterKey === 'sys:S1')?.reason).toMatch(/Dana/);
  });

  it('never names the recorder, and never a name nobody invited', () => {
    const lines = [line(0, 'sys:S1', "Hi, I'm Morgan."), line(1, 'mic', "I'm Dana's colleague.")];
    expect(findCues(lines, [DANA], new Set(['mic']))).toEqual([]);
  });

  it('uses a first name only when no other candidate shares it', () => {
    const danaB: CueCandidate = {
      ...DANA,
      key: 'dana@other.example',
      name: 'Dana Park',
      email: 'dana@other.example',
    };
    const ambiguous = findCues(
      [line(0, 'sys:S1', "I'm Dana, thanks for having me.")],
      [DANA, danaB],
    );
    expect(ambiguous).toEqual([]);
    const full = findCues([line(0, 'sys:S1', 'This is Dana Park speaking.')], [DANA, danaB]);
    expect(full.map((c) => c.candidateKey)).toEqual(['dana@other.example']);
  });

  it('folds cues into one score per voice and person', () => {
    const scores = scoreCues(findCues(scriptLines(), [DANA, PRIYA], new Set(['mic'])));
    expect(scores.get('sys:S1')?.get(DANA.key)?.score).toBeGreaterThan(0.8);
    expect(scores.get('sys:S2')?.get(PRIYA.key)?.score).toBeGreaterThan(0.6);
  });

  it('keys people by email, else by name', () => {
    expect(candidateKey({ email: 'A@X.example', name: 'A' })).toBe('a@x.example');
    expect(candidateKey({ email: null, name: ' Sam Lee ' })).toBe('name:sam lee');
  });
});

describe('calendar elimination', () => {
  it('one guest left and one voice left: that guest, at 0.9', () => {
    const result = eliminate({ guests: [DANA], voices: [{ clusterKey: 'sys:S1', lineCount: 4 }] });
    expect(result.assign).toEqual([
      expect.objectContaining({ clusterKey: 'sys:S1', confidence: 0.9, candidate: DANA }),
    ]);
  });

  it('as many guests as voices: the pairs the cues single out, then the last by elimination', () => {
    const scores = scoreCues([
      { clusterKey: 'sys:S1', candidateKey: DANA.key, weight: 0.8, reason: 'said "Dana"', seq: 1 },
    ]);
    const result = eliminate({
      guests: [DANA, PRIYA],
      voices: [
        { clusterKey: 'sys:S1', lineCount: 3 },
        { clusterKey: 'sys:S2', lineCount: 3 },
      ],
      cueScores: scores,
    });
    expect(result.assign.map((a) => [a.clusterKey, a.candidate.name, a.confidence])).toEqual([
      ['sys:S1', 'Dana Reyes', 0.8],
      ['sys:S2', 'Priya Shah', 0.9],
    ]);
  });

  it('more voices than guests: nothing is named, every voice gets ranked chips', () => {
    const scores = scoreCues(findCues(scriptLines(), [DANA, PRIYA], new Set(['mic'])));
    const result = eliminate({
      guests: [DANA, PRIYA],
      voices: ['sys:S1', 'sys:S2', 'sys:S3'].map((clusterKey) => ({ clusterKey, lineCount: 3 })),
      cueScores: scores,
    });
    expect(result.assign).toEqual([]);
    expect(result.suggestions.get('sys:S1')?.[0]).toMatchObject({
      name: 'Dana Reyes',
      source: 'llm_cue',
    });
    expect(result.suggestions.get('sys:S2')?.[0]).toMatchObject({
      name: 'Priya Shah',
      source: 'llm_cue',
    });
    expect(result.suggestions.get('sys:S3')?.map((s) => s.source)).toEqual([
      'calendar',
      'calendar',
    ]);
  });

  it('a voice with no lines (a merged-away one) is left out', () => {
    const result = eliminate({ guests: [DANA], voices: [{ clusterKey: 'sys:S1', lineCount: 0 }] });
    expect(result.assign).toEqual([]);
  });
});

describe('the roster', () => {
  it("names a voice whose talk time falls in one person's speaking turns", () => {
    const matches = alignRoster(
      [
        { name: 'Dana Reyes', email: null, startMs: 0, endMs: 10_000 },
        { name: 'Priya Shah', email: null, startMs: 10_000, endMs: 20_000 },
      ],
      [
        { clusterKey: 'sys:S1', startMs: 500, endMs: 4000 },
        { clusterKey: 'sys:S1', startMs: 5000, endMs: 9000 },
        { clusterKey: 'sys:S2', startMs: 11_000, endMs: 15_000 },
        { clusterKey: 'mic', startMs: 0, endMs: 20_000 },
      ],
    );
    // S2 has one line only: not enough to go on. The mic is never matched.
    expect(matches).toEqual([
      expect.objectContaining({ clusterKey: 'sys:S1', name: 'Dana Reyes', share: 1 }),
    ]);
  });
});

describe('the naming pass', () => {
  const base = (speakers: MeetingSpeaker[], lines: CueLine[]): NamingInput => ({
    speakers,
    lines,
    participants: INVITE,
  });

  it('streamed: two voices for two guests are named by cue and elimination, and keep their names when a third joins', () => {
    const all = scriptLines();
    const firstTwo = all.filter((l) => l.clusterKey !== 'sys:S3' && l.seq <= 8);
    let speakers = [
      OWNER_MIC,
      speaker('sys:S1', { guest_number: 1 }),
      speaker('sys:S2', { guest_number: 2 }),
    ];
    const apply = (rows: MeetingSpeaker[], patches: ReturnType<typeof planNaming>) =>
      rows.map((r) => {
        const p = patches.find((x) => x.id === r.id);
        return p ? { ...r, ...p.patch } : r;
      });
    speakers = apply(speakers, planNaming(base(speakers, firstTwo)));
    expect(speakers.find((s) => s.cluster_key === 'sys:S1')).toMatchObject({
      display_name: 'Dana Reyes',
      source: 'calendar',
    });
    expect(speakers.find((s) => s.cluster_key === 'sys:S2')).toMatchObject({
      display_name: 'Priya Shah',
      source: 'calendar',
    });

    speakers = [...speakers, speaker('sys:S3', { guest_number: 3 })];
    speakers = apply(speakers, planNaming(base(speakers, all)));
    expect(speakers.find((s) => s.cluster_key === 'sys:S1')?.display_name).toBe('Dana Reyes');
    expect(speakers.find((s) => s.cluster_key === 'sys:S2')?.display_name).toBe('Priya Shah');
    const late = speakers.find((s) => s.cluster_key === 'sys:S3');
    expect(late?.display_name).toBeNull();
    expect(late?.suggestions).toEqual([]);
  });

  it('all at once with an uninvited voice: no names, only chips; the mic stays the recorder', () => {
    const speakers = [
      OWNER_MIC,
      speaker('sys:S1', { guest_number: 1 }),
      speaker('sys:S2', { guest_number: 2 }),
      speaker('sys:S3', { guest_number: 3 }),
    ];
    const patches = planNaming(base(speakers, scriptLines()));
    expect(patches.some((p) => p.clusterKey === 'mic')).toBe(false);
    expect(patches.every((p) => p.patch.display_name === undefined)).toBe(true);
    const s1 = patches.find((p) => p.clusterKey === 'sys:S1');
    expect(s1?.patch.suggestions?.[0]).toMatchObject({ name: 'Dana Reyes' });
  });

  it('a person picked once is never overridden, and frees that guest for elimination', () => {
    const speakers = [
      OWNER_MIC,
      speaker('sys:S1', { guest_number: 1 }),
      speaker('sys:S2', { guest_number: 2 }),
      speaker('sys:S3', {
        guest_number: 3,
        display_name: 'Sam Lee',
        source: 'manual',
        locked: true,
      }),
    ];
    const patches = planNaming(base(speakers, scriptLines()));
    expect(patches.find((p) => p.clusterKey === 'sys:S3')).toBeUndefined();
    expect(patches.find((p) => p.clusterKey === 'sys:S1')?.patch).toMatchObject({
      display_name: 'Dana Reyes',
    });
    expect(patches.find((p) => p.clusterKey === 'sys:S2')?.patch).toMatchObject({
      display_name: 'Priya Shah',
    });
  });

  it('one person, one voice: a tap elsewhere clears an automated name', () => {
    const speakers = [
      OWNER_MIC,
      speaker('sys:S1', {
        display_name: 'Dana Reyes',
        person_email: DANA.email,
        source: 'calendar',
        confidence: 0.9,
      }),
      speaker('sys:S2', {
        display_name: 'Dana Reyes',
        person_email: DANA.email,
        source: 'manual',
        locked: true,
      }),
    ];
    const patches = planNaming(
      base(speakers, [line(0, 'sys:S1', 'Hello there.'), line(1, 'sys:S2', 'Hi.')]),
    );
    // Cleared, then named by elimination (still the calendar rung, so `source` is unchanged).
    expect(patches.find((p) => p.clusterKey === 'sys:S1')?.patch).toMatchObject({
      display_name: 'Priya Shah',
      person_email: PRIYA.email,
    });
  });

  it('a consented, enrolled voice is named by its profile, with the invite spelling', () => {
    const profileId = '0f5c1a5e-2c9b-4c3e-9f0a-3f1d2e4b5a6c';
    const key = `sys:${profileId}`;
    const patches = planNaming({
      speakers: [OWNER_MIC, speaker(key, { guest_number: 1 })],
      lines: [line(0, key, 'Good morning everyone, thanks for joining.')],
      participants: INVITE,
      voiceProfiles: [
        {
          id: profileId,
          email: PRIYA.email as string,
          name: 'P. Shah',
          crmPersonId: null,
          userId: null,
        },
      ],
    });
    expect(patches[0]?.patch).toMatchObject({
      display_name: 'Priya Shah',
      source: 'voiceprint',
      confidence: 0.95,
    });
  });

  it('a split voice is not matched by a voiceprint', () => {
    const profileId = '0f5c1a5e-2c9b-4c3e-9f0a-3f1d2e4b5a6c';
    const key = `sys:${profileId}#2`;
    const patches = planNaming({
      speakers: [OWNER_MIC, speaker(key, { guest_number: 1 })],
      lines: [line(0, key, 'Someone else entirely.')],
      participants: [INVITE[0] as NamingInput['participants'][number]],
      voiceProfiles: [
        {
          id: profileId,
          email: PRIYA.email as string,
          name: null,
          crmPersonId: null,
          userId: null,
        },
      ],
    });
    expect(patches.every((p) => p.patch.source !== 'voiceprint')).toBe(true);
  });

  it('in person, the recorder is a voice like everyone else', () => {
    const speakers = [speaker('mix:S1', { guest_number: 1 })];
    const patches = planNaming({
      speakers,
      lines: [line(0, 'mix:S1', 'Let us begin.')],
      participants: [INVITE[0] as NamingInput['participants'][number]],
    });
    expect(patches[0]?.patch).toMatchObject({ display_name: 'Morgan Lee', source: 'calendar' });
  });
});
