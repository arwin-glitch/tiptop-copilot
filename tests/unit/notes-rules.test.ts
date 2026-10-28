import { describe, expect, it } from 'vitest';
import { estimateCostUsd, PRICE_TABLE } from '@/lib/ai/models';
import { PROMPTS, PROMPT_VERSIONS } from '@/lib/ai/prompts';
import { draftNotes, draftPicks, dueFromText, lineScore, notesAsText } from '@/lib/notes/draft';
import { isSameConversation, uniqueMatch } from '@/lib/notes/pairing';
import { pickTemplate, type TemplatePickInput } from '@/lib/notes/template-pick';
import { reownActionItems, type AssemblySpeaker } from '@/lib/notes/voices';
import type { ActionItem } from '@/lib/types/notes';

/**
 * Kraken Notes' rules (D-076), with no model anywhere: Quick notes (the key
 * lines by a simple score, promises as action items), owners re-read after a
 * rename, the template auto-pick and the Granola pairing rule. Arwin's notes
 * are written by his Claude routine through the Ask bridge (tested in
 * notes-bridge-protocol.test.ts), so no meeting prompt ships in the app.
 * Fictional people only.
 */

describe('zero spend', () => {
  it('ships no meeting prompt for an in-app model', () => {
    expect(Object.keys(PROMPTS).some((k) => /meeting/i.test(k))).toBe(false);
    expect(Object.values(PROMPT_VERSIONS).some((v) => /^meeting/.test(v))).toBe(false);
  });

  it('keeps the price table for the in-app calls that remain, overstating an unknown model', () => {
    expect(PRICE_TABLE['claude-opus-5-5']).toEqual({ input: 4, output: 20 });
    expect(estimateCostUsd('claude-unknown', 1_000_000, 0)).toBeGreaterThanOrEqual(
      estimateCostUsd('claude-opus-5-5', 1_000_000, 0),
    );
  });
});

const SPEAKERS = new Map<string, AssemblySpeaker>([
  ['mic', { name: 'Morgan Lee', email: 'owner@tiptop.example', isPrincipal: true }],
  ['sys:S1', { name: 'Dana Reyes', email: 'dana@acmerobotics.example', isPrincipal: false }],
  ['sys:S3', { name: 'Guest 1', email: null, isPrincipal: false }],
]);

const line = (seq: number, key: string, text: string) => ({
  seq,
  cluster_key: key,
  text,
  edited_text: null,
});

describe('Quick notes', () => {
  it('scores lines that carry numbers, money and the round above small talk', () => {
    expect(
      lineScore('We are raising a $4 million seed round with a lead in place.'),
    ).toBeGreaterThan(lineScore('Great to see you, how was the weekend?'));
    expect(lineScore('Yes.')).toBeLessThan(1);
    expect(lineScore('Net revenue retention is 130 percent across 19 customers.')).toBeGreaterThan(
      3,
    );
  });

  it('lifts the best few key lines in the order they were said, and promises as action items', () => {
    const segments = [
      line(0, 'mic', 'Thanks for making the time today, really appreciate it.'),
      line(1, 'sys:S1', 'Net revenue retention is 130 percent across 19 customers.'),
      line(2, 'sys:S1', 'Nice weather out there.'),
      line(3, 'sys:S1', 'We are raising a $4 million seed round, closing in November.'),
      line(4, 'mic', "I'll send you an intro to our operations lead by Friday."),
    ];
    const picks = draftPicks(segments);
    expect(picks.keyPoints.map((p) => p.seq)).toEqual([1, 3]);
    expect(picks.promises.map((p) => p.seq)).toEqual([4]);

    const notes = draftNotes({
      userNotes: '## Our take\n- Retention is the story',
      segments,
      speakers: new Map([
        ['mic', { name: 'Morgan Lee', email: null, isPrincipal: true }],
        ['sys:S1', { name: 'Dana Reyes', email: null, isPrincipal: false }],
      ]),
      meetingDay: '2026-10-05',
    });
    expect(notes.blocks.filter((b) => b.source === 'typed').map((b) => b.text)).toEqual([
      'Our take',
      'Retention is the story',
    ]);
    expect(notes.actionItems[0]).toMatchObject({
      ownerName: 'Morgan Lee',
      isPrincipalPromise: true,
      due: '2026-10-09',
      sources: [{ fromSeq: 4, toSeq: 4 }],
    });
    for (const b of notes.blocks.filter((x) => x.source === 'ai' && x.kind === 'bullet')) {
      expect(b.sources.length).toBe(1);
    }
  });

  it('re-reads owners after a rename or a merge, with no model call', () => {
    const items: ActionItem[] = [
      {
        id: 'a',
        text: 'Case study',
        ownerEmail: null,
        ownerName: 'Guest 1',
        ownerClusterKey: 'sys:S3',
        due: null,
        isPrincipalPromise: false,
        taskId: null,
        sources: [],
      },
    ];
    const renamed = new Map(SPEAKERS).set('sys:S3', {
      name: 'Sam Lee',
      email: null,
      isPrincipal: false,
    });
    expect(reownActionItems(items, renamed)[0]?.ownerName).toBe('Sam Lee');
    expect(reownActionItems(items, SPEAKERS, new Map([['sys:S3', 'sys:S1']]))[0]).toMatchObject({
      ownerClusterKey: 'sys:S1',
      ownerName: 'Dana Reyes',
    });
  });

  it('writes plain text for the older readers, action items included', () => {
    const text = notesAsText(
      [{ id: 'h', kind: 'heading', text: 'Round', depth: 0, source: 'ai', sources: [] }],
      [
        {
          id: 'x',
          text: 'Send the deck',
          ownerEmail: null,
          ownerName: 'Dana Reyes',
          ownerClusterKey: 'sys:S1',
          due: '2026-10-09',
          isPrincipalPromise: false,
          taskId: null,
          sources: [],
        },
      ],
    );
    expect(text).toBe('Round\n\nAction items\n- Dana Reyes: Send the deck (by 2026-10-09)');
  });

  it('reads a due date said in a line', () => {
    expect(dueFromText("I'll send it by Friday", '2026-10-05')).toBe('2026-10-09');
    expect(dueFromText('we will follow up next week', '2026-10-05')).toBe('2026-10-12');
    expect(dueFromText('someday', '2026-10-05')).toBeNull();
  });
});

describe('the template auto-pick', () => {
  const base: TemplatePickInput = {
    title: 'Catch up',
    externalEmails: ['dana@acmerobotics.example'],
    internalOnly: false,
    dealDomains: new Set(),
    portfolioDomains: new Set(),
    lpKeys: new Set(),
    customTemplates: [],
  };

  it('reads the meeting type from the CRM', () => {
    expect(
      pickTemplate({ ...base, dealDomains: new Set(['acmerobotics.example']) }).templateId,
    ).toBe('builtin:founder_pitch');
    expect(
      pickTemplate({ ...base, portfolioDomains: new Set(['acmerobotics.example']) }).templateId,
    ).toBe('builtin:portfolio_checkin');
    expect(
      pickTemplate({ ...base, lpKeys: new Set(['dana@acmerobotics.example']) }).templateId,
    ).toBe('builtin:lp_call');
    expect(pickTemplate({ ...base, externalEmails: [], internalOnly: true }).templateId).toBe(
      'builtin:internal_1on1',
    );
  });

  it('falls back to the title, then to general notes', () => {
    expect(pickTemplate({ ...base, title: 'Board meeting Q3' }).templateId).toBe(
      'builtin:portfolio_checkin',
    );
    expect(pickTemplate({ ...base, title: 'Intro: Dana <> Morgan' }).templateId).toBe(
      'builtin:intro_call',
    );
    expect(pickTemplate(base)).toMatchObject({ templateId: null, meetingType: 'other' });
  });

  it('lets a custom template rule win: domain, then title, then type', () => {
    const custom = [
      {
        id: 'c-type',
        name: 'Pitch, short',
        meeting_type: 'pitch' as const,
        auto_rule: { meetingTypes: ['pitch' as const] },
        archived: false,
      },
      {
        id: 'c-domain',
        name: 'Acme board',
        meeting_type: 'portfolio' as const,
        auto_rule: { domains: ['acmerobotics.example'] },
        archived: false,
      },
    ];
    expect(pickTemplate({ ...base, customTemplates: custom }).templateId).toBe('c-domain');
    expect(
      pickTemplate({
        ...base,
        externalEmails: ['x@other.example'],
        dealDomains: new Set(['other.example']),
        customTemplates: custom,
      }).templateId,
    ).toBe('c-type');
  });
});

describe('pairing with Granola', () => {
  const meeting = {
    title: 'Acme Robotics intro',
    at: '2026-10-05T15:00:00.000Z',
    externalEmails: ['dana@acmerobotics.example'],
  };

  it('pairs on the title, or on a shared outside guest, within three hours', () => {
    expect(
      isSameConversation(meeting, {
        title: 'Acme Robotics — intro!',
        occurredAt: '2026-10-05T15:30:00.000Z',
        attendeeEmails: [],
      }),
    ).toBe(true);
    expect(
      isSameConversation(meeting, {
        title: 'Call',
        occurredAt: '2026-10-05T16:00:00.000Z',
        attendeeEmails: ['dana@acmerobotics.example'],
      }),
    ).toBe(true);
    expect(
      isSameConversation(meeting, {
        title: 'Acme Robotics intro',
        occurredAt: '2026-10-06T15:00:00.000Z',
        attendeeEmails: [],
      }),
    ).toBe(false);
  });

  it('makes no pair from two candidates', () => {
    expect(uniqueMatch([1, 2], () => true)).toBeNull();
    expect(uniqueMatch([1, 2], (n) => n === 2)).toBe(2);
  });
});
