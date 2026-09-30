import { describe, expect, it } from 'vitest';
import { conversationBefore } from '@/lib/services/ask-bridge';
import { fireText } from '@/lib/services/ask-routine';
import { linkifyTrusted } from '@/lib/util/linkify';
import { stripSlackLinks } from '@/lib/util/slack-text';
import type { ChatMessage } from '@/lib/types/domain';

function msg(role: ChatMessage['role'], content: string, status = 'answered'): ChatMessage {
  return {
    id: `${role}-${content.slice(0, 8)}`,
    organization_id: 'org',
    thread_id: 't',
    role,
    content,
    citations: [],
    tool_calls: [],
    model: null,
    prompt_version: null,
    status,
    created_at: '2026-09-30T00:00:00Z',
  } as ChatMessage;
}

describe('conversationBefore', () => {
  const thread = [
    msg('user', 'What emails might be time sensitive but not in Primary?'),
    msg('assistant', 'A Bill.com approval, an Amex AutoPay, and a Cura digest.'),
    msg('user', 'Can you attach the links to those threads?'),
    msg('assistant', '', 'pending'),
  ];

  it('carries the earlier question and answer into a follow-up', () => {
    expect(conversationBefore(thread, 2)).toEqual([
      { role: 'user', content: 'What emails might be time sensitive but not in Primary?' },
      { role: 'assistant', content: 'A Bill.com approval, an Amex AutoPay, and a Cura digest.' },
    ]);
  });

  it('skips pending and failed turns and keeps the newest within budget', () => {
    const long = Array.from({ length: 20 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `turn ${i} ${'x'.repeat(2_000)}`),
    );
    const turns = conversationBefore([...long, msg('assistant', 'oops', 'failed')], 21);
    expect(turns.length).toBeLessThanOrEqual(8);
    expect(turns.at(-1)!.content.startsWith('turn 19')).toBe(true);
    expect(turns.reduce((n, t) => n + t.content.length, 0)).toBeLessThanOrEqual(6_000);
  });

  it('travels to the routine inside the fired question', () => {
    const text = fireText({
      message_id: 'm',
      thread_id: 't',
      deal_id: null,
      question: 'Can you attach the links?',
      created_at: 'now',
      history: conversationBefore(thread, 2),
    });
    const json = JSON.parse(/`([^`]+)`/.exec(text)![1]!);
    expect(json.history).toHaveLength(2);
  });
});

describe('answer links', () => {
  it('strips Slack link markup to what was written', () => {
    expect(stripSlackLinks('A <http://Bill.com|Bill.com> approval')).toBe('A Bill.com approval');
    expect(stripSlackLinks('see <https://mail.google.com/mail/#all/abc>')).toBe(
      'see https://mail.google.com/mail/#all/abc',
    );
  });

  it('links Gmail but leaves an outside URL as text', () => {
    const parts = linkifyTrusted(
      'Thread: https://mail.google.com/mail/?authuser=nick@tiptop.vc#all/1a0f. Pitch: https://evil.example/login',
    );
    expect(parts).toEqual([
      { type: 'text', text: 'Thread: ' },
      {
        type: 'link',
        href: 'https://mail.google.com/mail/?authuser=nick@tiptop.vc#all/1a0f',
        label: 'Open in Gmail',
      },
      { type: 'text', text: '. Pitch: https://evil.example/login' },
    ]);
  });

  it('refuses look-alike hosts and credentials in the URL', () => {
    expect(linkifyTrusted('https://mail.google.com.evil.io/x')).toEqual([
      { type: 'text', text: 'https://mail.google.com.evil.io/x' },
    ]);
    expect(linkifyTrusted('https://user:pw@mail.google.com/x')[0]!.type).toBe('text');
  });
});
