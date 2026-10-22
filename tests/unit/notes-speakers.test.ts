import { describe, expect, it } from 'vitest';
import { isEcho, overlapShare } from '@/lib/speakers/echo-dedupe';
import { certaintyOf, mayOverride, newSpeakerRow, speakerDisplayName } from '@/lib/speakers/ladder';
import { planMerge, planSplit } from '@/lib/speakers/split-merge';
import { LIST_RULE_LABEL, matchNeverRecord, rulesFromList } from '@/lib/notes/never-record';
import type { MeetingSpeaker } from '@/lib/types/notes';

/** The naming ladder, Split and Merge, echo removal and never-record rules (D-076). */

const NOW = '2026-10-22T15:00:00.000Z';
const recorder = { userId: 'user-1', email: 'nick@tiptop.demo', name: 'Nick Tippmann' };

function row(key: string, existing: Pick<MeetingSpeaker, 'guest_number'>[] = []) {
  return newSpeakerRow({
    id: `id-${key}`,
    organizationId: 'org',
    meetingId: 'm1',
    clusterKey: key,
    track: key.startsWith('mic') ? 'mic' : 'system',
    recorder,
    existing,
    now: NOW,
  });
}

describe('the ladder', () => {
  it('names the recorder’s mic from the first word, and numbers everyone else', () => {
    const mic = row('mic');
    expect(mic.display_name).toBe('Nick Tippmann');
    expect(mic.source).toBe('channel');
    expect(mic.confidence).toBe(1);
    expect(certaintyOf(mic)).toBe('channel');

    const first = row('sys:S1');
    const second = row('sys:S2', [first]);
    expect(speakerDisplayName(first)).toBe('Guest 1');
    expect(speakerDisplayName(second)).toBe('Guest 2');
    expect(certaintyOf(first)).toBe('unknown');

    // Someone else at the recorder's computer (a split of the mic) is a guest.
    expect(row('mic#2', [first, second]).guest_number).toBe(3);
  });

  it('never lets automation override a locked name, and ranks evidence', () => {
    const tapped: MeetingSpeaker = { ...row('sys:S1'), source: 'manual', locked: true };
    expect(mayOverride(tapped, 'channel')).toBe(false);
    const calendar: MeetingSpeaker = { ...row('sys:S1'), source: 'calendar' };
    expect(mayOverride(calendar, 'voiceprint')).toBe(true);
    expect(mayOverride(calendar, 'llm_cue')).toBe(false);
    expect(mayOverride(row('sys:S1'), 'llm_cue')).toBe(true);
  });
});

describe('split and merge', () => {
  const speakers = [
    { cluster_key: 'mic', merged_into: null },
    { cluster_key: 'sys:S1', merged_into: null },
    { cluster_key: 'sys:S2', merged_into: null },
    { cluster_key: 'sys:S3', merged_into: 'sys:S2' },
  ];
  const segments = [
    { seq: 0, cluster_key: 'mic' },
    { seq: 1, cluster_key: 'sys:S1' },
    { seq: 2, cluster_key: 'sys:S1' },
    { seq: 3, cluster_key: 'sys:S2' },
    { seq: 4, cluster_key: 'sys:S1' },
  ];

  it('moves one line, or that line and every later one of the voice', () => {
    const one = planSplit(speakers, segments, { clusterKey: 'sys:S1', fromSeq: 2, mode: 'line' });
    expect(one.ok && one.value).toEqual({ newClusterKey: 'sys:S1#2', moveSeqs: [2] });
    const rest = planSplit(speakers, segments, {
      clusterKey: 'sys:S1',
      fromSeq: 2,
      mode: 'from_here',
    });
    expect(rest.ok && rest.value.moveSeqs).toEqual([2, 4]);
  });

  it('refuses a line from another voice, and a merged voice', () => {
    const wrong = planSplit(speakers, segments, { clusterKey: 'sys:S1', fromSeq: 3, mode: 'line' });
    expect(!wrong.ok && wrong.error.code).toBe('invalid_input');
    const merged = planSplit(speakers, segments, {
      clusterKey: 'sys:S3',
      fromSeq: 3,
      mode: 'line',
    });
    expect(!merged.ok && merged.error.code).toBe('conflict');
  });

  it('merges every line and repoints voices merged before', () => {
    const plan = planMerge(speakers, segments, 'sys:S2', 'sys:S1');
    expect(plan.ok && plan.value).toEqual({ moveSeqs: [3], repoint: ['sys:S3'] });
    expect(planMerge(speakers, segments, 'sys:S1', 'sys:S1').ok).toBe(false);
    expect(planMerge(speakers, segments, 'sys:S3', 'sys:S1').ok).toBe(false);
  });
});

describe('echo removal', () => {
  const said = { startMs: 10_000, endMs: 14_000, text: 'Net revenue retention is 130 percent.' };

  it('drops a mic line that repeats the meeting audio at the same moment', () => {
    expect(
      isEcho({ startMs: 10_400, endMs: 14_200, text: 'net revenue retention is 130 percent' }, [
        said,
      ]),
    ).toBe(true);
  });

  it('keeps it when it is later, different, or too short to tell', () => {
    expect(isEcho({ startMs: 30_000, endMs: 33_000, text: said.text }, [said])).toBe(false);
    expect(
      isEcho({ startMs: 10_000, endMs: 13_000, text: 'What does churn look like?' }, [said]),
    ).toBe(false);
    expect(isEcho({ startMs: 10_000, endMs: 11_000, text: 'Okay.' }, [said])).toBe(false);
    expect(overlapShare('', said.text)).toBe(0);
  });
});

describe('never-record rules', () => {
  const subject = (title: string, emails: string[] = [], calendarId: string | null = null) => ({
    title,
    calendarId,
    attendeeEmails: emails,
  });

  it('blocks legal and family meetings by whole words in the title', () => {
    expect(matchNeverRecord(subject('Legal review: side letter'), [])?.label).toBe('legal');
    expect(matchNeverRecord(subject('Call with counsel'), [])?.label).toBe('legal');
    expect(matchNeverRecord(subject('Kids pickup'), [])?.label).toBe('family');
    expect(matchNeverRecord(subject('Paralegal hiring sync'), [])).toBeNull();
    expect(matchNeverRecord(subject('Acme Robotics intro'), [])).toBeNull();
  });

  it("applies the organization's own rules first, and skips disabled ones", () => {
    const rules = [
      {
        id: 'r1',
        kind: 'attendee_domain' as const,
        pattern: 'holdco.example',
        label: 'portfolio',
        enabled: true,
      },
      {
        id: 'r2',
        kind: 'attendee_email' as const,
        pattern: 'pat@other.example',
        label: 'personal',
        enabled: false,
      },
      {
        id: 'r3',
        kind: 'calendar_id' as const,
        pattern: 'c_private@group.calendar.google.com',
        label: 'family',
        enabled: true,
      },
    ];
    expect(matchNeverRecord(subject('Sync', ['a@team.holdco.example']), rules)?.ruleId).toBe('r1');
    expect(matchNeverRecord(subject('Sync', ['pat@other.example']), rules)).toBeNull();
    expect(
      matchNeverRecord(subject('Sync', [], 'C_PRIVATE@group.calendar.google.com'), rules)?.ruleId,
    ).toBe('r3');
    expect(matchNeverRecord(subject('Legal sync'), rules, { includeDefaults: false })).toBeNull();
  });

  it("reads the server's own list: a domain, an address, or words in the title", () => {
    const rules = rulesFromList([
      'sistercap.example',
      '@other-fund.example',
      'pat@holdco.example',
      'Sister Capital',
      '  ',
    ]);
    expect(rules.map((r) => [r.kind, r.pattern])).toEqual([
      ['attendee_domain', 'sistercap.example'],
      ['attendee_domain', 'other-fund.example'],
      ['attendee_email', 'pat@holdco.example'],
      ['title', 'Sister Capital'],
    ]);
    expect(rules.every((r) => r.enabled && r.label === LIST_RULE_LABEL)).toBe(true);
    expect(matchNeverRecord(subject('Weekly sync', ['dana@sistercap.example']), rules)?.label).toBe(
      LIST_RULE_LABEL,
    );
    expect(matchNeverRecord(subject('Sister Capital quarterly'), rules)?.label).toBe(
      LIST_RULE_LABEL,
    );
    expect(matchNeverRecord(subject('Weekly sync', ['dana@acme.example']), rules)).toBeNull();
  });
});
