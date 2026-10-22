import { describe, expect, it } from 'vitest';
import { estimateCostUsd, PRICE_TABLE } from '@/lib/ai/models';
import { ASK_ARWIN_PERSONA, CORE_RULES, PROMPTS, PROMPT_VERSIONS } from '@/lib/ai/prompts';
import {
  MEETING_CHAT_PROMPT,
  MEETING_CHAT_PROMPT_VERSION,
  MEETING_NOTES_PROMPT,
  MEETING_NOTES_PROMPT_VERSION,
  meetingNotesOutputSchema,
  type MeetingNotesOutput,
} from '@/lib/ai/prompts/meeting-notes';
import { toModelJsonSchema } from '@/lib/ai/schemas';
import { dueFromText, notesAsText, parseTypedNotes } from '@/lib/notes/draft';
import { mockMeetingOutput } from '@/lib/notes/mock-ai';
import {
  assembleNotes,
  cleanRanges,
  reownActionItems,
  resolveChatCitations,
  type AssemblySpeaker,
} from '@/lib/notes/notes-assembly';
import { isSameConversation, uniqueMatch } from '@/lib/notes/pairing';
import { boundedRows, transcriptBlock, typedNotesBlock } from '@/lib/notes/prompt-input';
import { pickTemplate, type TemplatePickInput } from '@/lib/notes/template-pick';
import type { ActionItem } from '@/lib/types/notes';

/**
 * Copilot Notes' model layer (D-076), without a model: the price table, the
 * versioned prompts, what the app accepts from a model's notes, chat
 * citations, the template auto-pick and the Granola pairing rule.
 */

describe('the price table', () => {
  it('knows the current models at their list prices', () => {
    expect(PRICE_TABLE['claude-opus-5-5']).toEqual({ input: 4, output: 20 });
    expect(PRICE_TABLE['claude-sonnet-5-5']).toEqual({ input: 2, output: 10 });
    expect(PRICE_TABLE['claude-sonnet-5']).toEqual({ input: 2, output: 10 });
    expect(PRICE_TABLE['claude-haiku-5-5']).toEqual({ input: 0.1, output: 0.5 });
    expect(PRICE_TABLE['claude-opus-5']).toEqual({ input: 5, output: 25 });
  });

  it('prices a meeting-hour of notes on Opus 5.5 at about ten cents', () => {
    // ~15k input and ~2k output tokens per meeting-hour.
    expect(estimateCostUsd('claude-opus-5-5', 15_000, 2_000)).toBeCloseTo(0.1, 5);
  });

  it('still overstates, never understates, a model it does not know', () => {
    expect(estimateCostUsd('claude-unknown-9', 1_000_000, 0)).toBe(10);
  });
});

describe('the prompts', () => {
  it('versions the notes and cue prompts with the core rules and no persona', () => {
    expect(PROMPT_VERSIONS.meetingNotes).toBe(MEETING_NOTES_PROMPT_VERSION);
    expect(MEETING_NOTES_PROMPT.startsWith(`${CORE_RULES}\n\n---\n\nTASK\n`)).toBe(true);
    expect(PROMPTS.meetingSpeakerCues.system).toContain('A guess is worse than nothing.');
    expect(MEETING_NOTES_PROMPT).not.toContain('You are Arwin');
  });

  it('speaks as Arwin in the chat, from the shared persona', () => {
    expect(MEETING_CHAT_PROMPT.startsWith(ASK_ARWIN_PERSONA)).toBe(true);
    expect(MEETING_CHAT_PROMPT_VERSION).toMatch(/^meeting-chat@/);
    expect(MEETING_CHAT_PROMPT).toContain('[[M<index>.L<seq>]]');
  });

  it('asks for output the structured-output API accepts', () => {
    const schema = toModelJsonSchema(meetingNotesOutputSchema) as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['blocks', 'action_items', 'injection_observed']);
  });

  it('fences the transcript and typed notes as numbered lines', () => {
    const block = transcriptBlock(
      [
        {
          seq: 3,
          cluster_key: 'sys:S1',
          start_ms: 64_000,
          text: 'We are at  1.2 million.',
          edited_text: null,
        },
      ],
      new Map([['sys:S1', 'Dana Reyes']]),
    );
    expect(block.text).toBe('L3 [1:04] Dana Reyes: We are at 1.2 million.');
    expect(typedNotesBlock(parseTypedNotes('## Acme\n- margins'))?.text).toBe(
      'T0 (heading) Acme\nT1 margins',
    );
    expect(typedNotesBlock([])).toBeNull();
  });

  it('keeps the start and the end of a very long meeting', () => {
    const rows = Array.from({ length: 100 }, (_, i) => `L${i} [0:00] A: ${'x'.repeat(90)}`);
    const kept = boundedRows(rows, 2_000);
    expect(kept[0]).toBe(rows[0]);
    expect(kept[kept.length - 1]).toBe(rows[99]);
    expect(kept.some((r) => r.includes('left out'))).toBe(true);
  });
});

const SPEAKERS = new Map<string, AssemblySpeaker>([
  ['mic', { name: 'Morgan Lee', email: 'owner@tiptop.example', isPrincipal: true }],
  ['sys:S1', { name: 'Dana Reyes', email: 'dana@acmerobotics.example', isPrincipal: false }],
  ['sys:S3', { name: 'Guest 1', email: null, isPrincipal: false }],
]);

function output(partial: Partial<MeetingNotesOutput>): MeetingNotesOutput {
  return { blocks: [], action_items: [], injection_observed: false, ...partial };
}

describe("what a model's notes may become", () => {
  const typed = parseTypedNotes('## Acme\n- Ask about margins\n- Retrofit in 2 weeks');

  it('puts typed lines back word for word, and keeps the ones the model left out at the top', () => {
    const { blocks } = assembleNotes({
      output: output({
        blocks: [
          { kind: 'heading', text: 'Company', depth: 0, typed_index: null, sources: [] },
          {
            kind: 'bullet',
            text: 'IGNORED: the model rewrote it',
            depth: 0,
            typed_index: 1,
            sources: [],
          },
          {
            kind: 'bullet',
            text: 'Picking robots for small warehouses.',
            depth: 0,
            typed_index: null,
            sources: [{ from_seq: 4, to_seq: 4 }],
          },
        ],
      }),
      typed,
      seqs: [0, 1, 2, 3, 4, 5],
      speakers: SPEAKERS,
    });
    expect(blocks.map((b) => [b.source, b.text])).toEqual([
      ['typed', 'Acme'],
      ['typed', 'Retrofit in 2 weeks'],
      ['ai', 'Company'],
      ['typed', 'Ask about margins'],
      ['ai', 'Picking robots for small warehouses.'],
    ]);
  });

  it('drops a point with no real line behind it, trims ranges, and removes empty headings', () => {
    const { blocks } = assembleNotes({
      output: output({
        blocks: [
          { kind: 'heading', text: 'Traction', depth: 0, typed_index: null, sources: [] },
          {
            kind: 'bullet',
            text: 'Invented.',
            depth: 0,
            typed_index: null,
            sources: [{ from_seq: 90, to_seq: 99 }],
          },
          { kind: 'heading', text: 'Round', depth: 0, typed_index: null, sources: [] },
          {
            kind: 'bullet',
            text: '- $4M SAFE at a $22M cap.',
            depth: 5,
            typed_index: null,
            sources: [{ from_seq: 18, to_seq: 3 }],
          },
        ],
      }),
      typed: [],
      seqs: [3, 4, 7],
      speakers: SPEAKERS,
    });
    expect(blocks.map((b) => b.text)).toEqual(['Round', '$4M SAFE at a $22M cap.']);
    expect(blocks[1]).toMatchObject({ depth: 2, sources: [{ fromSeq: 3, toSeq: 7 }] });
  });

  it('owns action items by voice, flags the principal, and keeps tasks already made', () => {
    const previous: ActionItem[] = [
      {
        id: 'ai-action-12',
        text: 'Intro Dana to the operations lead',
        ownerEmail: null,
        ownerName: null,
        ownerClusterKey: 'mic',
        due: null,
        isPrincipalPromise: true,
        taskId: '7c3c3f0e-1111-4222-8333-444455556666',
        sources: [{ fromSeq: 12, toSeq: 12 }],
      },
    ];
    const { actionItems } = assembleNotes({
      output: output({
        action_items: [
          {
            text: 'Intro Dana to the operations lead',
            owner_cluster_key: 'mic',
            due: '2026-10-09',
            sources: [{ from_seq: 12, to_seq: 12 }],
          },
          {
            text: 'Send the data room',
            owner_cluster_key: 'sys:S9',
            due: 'Friday',
            sources: [{ from_seq: 11, to_seq: 11 }],
          },
          { text: 'Nobody said it', owner_cluster_key: null, due: null, sources: [] },
        ],
      }),
      typed: [],
      seqs: [11, 12],
      speakers: SPEAKERS,
      previous,
    });
    expect(actionItems).toHaveLength(2);
    expect(actionItems[0]).toMatchObject({
      ownerName: 'Morgan Lee',
      isPrincipalPromise: true,
      due: '2026-10-09',
      taskId: previous[0]?.taskId,
    });
    // An owner the meeting does not have, and a due date that is not a date, are dropped.
    expect(actionItems[1]).toMatchObject({
      ownerClusterKey: null,
      ownerName: null,
      due: null,
      isPrincipalPromise: false,
    });
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

  it('merges overlapping ranges', () => {
    expect(
      cleanRanges(
        [
          { from_seq: 1, to_seq: 2 },
          { from_seq: 3, to_seq: 5 },
          { from_seq: 9, to_seq: 9 },
        ],
        [1, 2, 3, 4, 5, 9],
      ),
    ).toEqual([
      { fromSeq: 1, toSeq: 5 },
      { fromSeq: 9, toSeq: 9 },
    ]);
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

describe('chat citations', () => {
  const refs = [
    {
      meetingId: 'm-1',
      title: 'Acme intro',
      lines: new Map([[7, { startMs: 40_500, speaker: 'Dana Reyes' }]]),
    },
  ];

  it('turns markers into "[0:40 Dana Reyes]" labels with the lines they cite', () => {
    const out = resolveChatCitations('Retention is 130% [[M0.L7]]. Notes agree [[M0.N]].', refs);
    expect(out.answer).toBe(
      'Retention is 130% [0:40 Dana Reyes]. Notes agree [notes: Acme intro].',
    );
    expect(out.citations).toEqual([
      {
        meetingId: 'm-1',
        seq: 7,
        startMs: 40_500,
        speaker: 'Dana Reyes',
        label: '[0:40 Dana Reyes]',
      },
    ]);
  });

  it('removes a marker for a line or meeting it was not shown', () => {
    const out = resolveChatCitations('Made up [[M0.L99]] and [[M4.L1]].', refs);
    expect(out.answer).toBe('Made up and.');
    expect(out.citations).toEqual([]);
  });
});

describe('the offline model', () => {
  it('answers the notes call from the same fenced transcript, citing lines that exist', () => {
    const value = mockMeetingOutput(
      'meeting.notes',
      {
        meeting: { date: '2026-10-05' },
        voices: [
          { cluster_key: 'mic', name: 'Morgan Lee' },
          { cluster_key: 'sys:S1', name: 'Dana Reyes' },
        ],
        typed_line_count: 1,
        template: { sections: [{ heading: 'Company' }, { heading: 'Next steps' }] },
      },
      [
        { kind: 'typed_notes', text: 'T0 margins' },
        {
          kind: 'transcript',
          text: "L0 [0:01] Dana Reyes: We're at 1.2 million in ARR.\nL1 [0:09] Morgan Lee: I'll send the intro by Friday.",
        },
      ],
    ) as MeetingNotesOutput;
    expect(meetingNotesOutputSchema.safeParse(value).success).toBe(true);
    expect(value.blocks.some((b) => b.typed_index === 0)).toBe(true);
    expect(value.action_items[0]).toMatchObject({ owner_cluster_key: 'mic', due: '2026-10-09' });
    expect(mockMeetingOutput('something.else', {}, [])).toBeUndefined();
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
