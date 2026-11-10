import { describe, expect, it } from 'vitest';
import { normalizeUtterance, spokenText, voiceIntent } from '@/lib/voice/intent';

function nav(text: string) {
  const intent = voiceIntent(text);
  if (intent.kind !== 'navigate') throw new Error(`${text} → ${intent.kind}`);
  return intent;
}

describe('normalizeUtterance', () => {
  it('drops fillers, the wake word and end punctuation', () => {
    expect(normalizeUtterance('Hey Arwin, can you please open my inbox for me?')).toBe(
      'open my inbox',
    );
    expect(normalizeUtterance('  OK arwin   pull up tasks.  ')).toBe('pull up tasks');
  });
});

describe('voiceIntent', () => {
  it('opens pages named outright', () => {
    expect(nav('Open my inbox').match.group).toBe('inbox');
    expect(nav('Hey Arwin, take me to tasks please').match.group).toBe('tasks');
    expect(nav('go to the calendar page').match.group).toBe('calendar');
    expect(nav('pull up portfolio').match.group).toBe('portfolio');
    expect(nav('Inbox').match.group).toBe('inbox');
  });

  it('opens a tab when one is named', () => {
    const intent = nav('show me my snoozed tasks');
    expect(intent.match.id).toBe('tasks:snoozed');
    expect(intent.reply).toMatch(/^Opening Tasks, Snoozed\.$/);
    expect(intent.match.href).toBeTruthy();
  });

  it('searches for things that are not pages', () => {
    expect(voiceIntent('find Acme Robotics')).toMatchObject({
      kind: 'search',
      query: 'Acme Robotics',
    });
    expect(voiceIntent('search for jane doe')).toMatchObject({ kind: 'search', query: 'jane doe' });
    expect(voiceIntent('pull up Northwind')).toMatchObject({ kind: 'search', query: 'Northwind' });
  });

  it('sends questions and requests to Ask, as said', () => {
    expect(voiceIntent("What's on my calendar today?")).toEqual({
      kind: 'ask',
      question: "What's on my calendar today?",
    });
    expect(voiceIntent('Hey Arwin, draft a reply to the Acme founder')).toEqual({
      kind: 'ask',
      question: 'draft a reply to the Acme founder',
    });
    expect(voiceIntent("show me what's due today").kind).toBe('ask');
  });

  it('stops and ignores silence', () => {
    expect(voiceIntent('Never mind.')).toEqual({ kind: 'stop' });
    expect(voiceIntent('stop')).toEqual({ kind: 'stop' });
    expect(voiceIntent('   ')).toEqual({ kind: 'empty' });
  });
});

describe('spokenText', () => {
  it('reads answers without markdown or links', () => {
    expect(spokenText('**Two** meetings:\n- 10am [Acme](https://x.test/a)\n- 2pm Beta')).toBe(
      'Two meetings: 10am Acme. 2pm Beta',
    );
  });

  it('keeps long answers short and points at the chat', () => {
    const long = 'This is one sentence about the deal. '.repeat(20);
    const out = spokenText(long, 120);
    expect(out.length).toBeLessThan(160);
    expect(out).toMatch(/The rest is in the chat\.$/);
  });
});
