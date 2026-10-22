import { describe, expect, it } from 'vitest';
import {
  ANSWER_MAX_CHARS,
  bookingQuestionText,
  buildQuestionFacts,
  cleanQuestion,
  parseBookingAnswer,
  QUESTION_MAX_CHARS,
  sanitiseBookingAnswer,
} from '@/lib/booking/chat-bridge';

/**
 * The routine half of the booking assistant (D-078), pure parts: what the
 * routine is sent (public facts only, by name), how its relay post is read,
 * and how its answer is made safe before a visitor sees it.
 */

const BOOKING_URL = 'https://copilot.example/meet/robin';
const ID = '3f2b8c1e-5d4a-4b6c-9e8f-1a2b3c4d5e6f';

describe('the question payload', () => {
  it('strips control characters and backticks and caps the question', () => {
    expect(cleanQuestion('Hi\u0000 there\n\n`rm -rf`‮')).toBe("Hi there 'rm -rf'");
    expect(cleanQuestion('x'.repeat(500))).toHaveLength(QUESTION_MAX_CHARS);
    expect(cleanQuestion(null)).toBe('');
  });

  it('carries named public facts only, whatever else the input object holds', () => {
    const input = {
      hostName: 'Robin Vale',
      firmName: 'Example Fund',
      title: 'Partner',
      bio: 'Backs first-time founders.',
      faqItems: [{ q: 'Stage?', a: 'Seed `only`.' }],
      offers: ['30-min call (video)'],
      nextOpenTimes: ['Tue, Nov 3, 9:30 AM (Central Time)'],
      // None of these may leak:
      homeCity: 'Private Town',
      email: 'robin@fund.example',
      calendarChoices: [{ id: 'family@group.calendar.example', counts: true }],
      organizationId: '00000000-0000-4000-8000-000000000001',
    };
    const facts = buildQuestionFacts(input);
    expect(Object.keys(facts).sort()).toEqual([
      'faq',
      'firm',
      'host_name',
      'next_open_times',
      'offers',
      'profile_text',
    ]);
    const text = JSON.stringify(facts);
    for (const secret of ['Private Town', 'robin@fund.example', 'family@group', '00000000-0000']) {
      expect(text).not.toContain(secret);
    }
    expect(facts.profile_text).toBe('Partner. Backs first-time founders.');
    expect(facts.faq).toEqual([{ q: 'Stage?', a: "Seed 'only'." }]);
  });

  it('is the marker line, then one backticked JSON object', () => {
    const text = bookingQuestionText({
      question_id: ID,
      question: 'Do you invest in `climate`?',
      facts: buildQuestionFacts({
        hostName: 'Robin Vale',
        firmName: 'Example Fund',
        title: '',
        bio: '',
        faqItems: [],
        offers: [],
        nextOpenTimes: [],
      }),
    });
    const [marker, fenced, ...rest] = text.split('\n');
    expect(marker).toBe('BOOKING_QUESTION_V1');
    expect(rest).toEqual([]);
    expect(fenced!.match(/`/g)).toHaveLength(2);
    expect(JSON.parse(fenced!.slice(1, -1))).toEqual({
      question_id: ID,
      question: "Do you invest in 'climate'?",
      facts: {
        host_name: 'Robin Vale',
        firm: 'Example Fund',
        profile_text: '',
        faq: [],
        offers: [],
        next_open_times: [],
      },
    });
  });
});

describe('reading the relay post', () => {
  const post = (payload: unknown) => `BOOKING_ANSWER_V1\n\`${JSON.stringify(payload)}\``;

  it('reads the marker and the backticked JSON, undoing Slack link markup first', () => {
    expect(parseBookingAnswer(post({ question_id: ID, answer: 'Seed only.' }))).toEqual({
      question_id: ID,
      answer: 'Seed only.',
    });
    const linked = `BOOKING_ANSWER_V1\n\`{"question_id":"${ID}","answer":"Book at <${BOOKING_URL}>"}\``;
    expect(parseBookingAnswer(linked)?.answer).toBe(`Book at ${BOOKING_URL}`);
  });

  it('ignores anything else', () => {
    expect(parseBookingAnswer('ASK_ANSWER_V1\n`{}`')).toBeNull();
    expect(parseBookingAnswer(post({ question_id: 'not-a-uuid', answer: 'x' }))).toBeNull();
    expect(parseBookingAnswer(post({ question_id: ID, answer: '   ' }))).toBeNull();
    expect(parseBookingAnswer('BOOKING_ANSWER_V1\n`{broken`')).toBeNull();
    expect(parseBookingAnswer(42)).toBeNull();
  });
});

describe('sanitiseBookingAnswer', () => {
  const clean = (text: string) => sanitiseBookingAnswer(text, { bookingUrl: BOOKING_URL });

  it('keeps plain text and this booking link only', () => {
    expect(clean(`Yes. Book a time at ${BOOKING_URL} anytime.`)).toBe(
      `Yes. Book a time at ${BOOKING_URL} anytime.`,
    );
    expect(clean('Pick a time at copilot.example/meet/robin.')).toBe(
      `Pick a time at ${BOOKING_URL}.`,
    );
    expect(clean('See https://evil.example/login or www.phish.example now.')).toBe('See or now.');
    expect(clean('Apply at fund.example/apply today.')).toBe('Apply at today.');
  });

  it('catches a link however it is written: capitals, [.] and spelled-out dots', () => {
    expect(clean('Visit EVIL.COM/login now.')).toBe('Visit now.');
    expect(clean('Visit Evil.Example today.')).toBe('Visit today.');
    expect(clean('Visit HTTPS://EVIL.EXAMPLE/x today.')).toBe('Visit today.');
    expect(clean('Visit evil[.]com or evil(dot)com today.')).toBe('Visit or today.');
    expect(clean('Visit evil dot com today.')).toBe('Visit today.');
    expect(clean('We back seed founders.')).toBe('We back seed founders.');
  });

  it('removes markup, code, emails and phone numbers', () => {
    expect(clean('**Seed** and _pre-seed_ `only`. <b>Bold</b> [link](https://x.example)')).toBe(
      'Seed and pre-seed only. Bold link',
    );
    expect(clean('Email robin@fund.example or call +1 (555) 010-2030 or 555.010.2030.')).toBe(
      'Email or call or.',
    );
    expect(clean('We started in 2021-2024 and invest on 2026-11-03.')).toBe(
      'We started in 2021-2024 and invest on 2026-11-03.',
    );
  });

  it('drops every sentence promising that a person will confirm, review or get back', () => {
    expect(clean('Seed only. Arwin will confirm by email.')).toBe('Seed only.');
    expect(clean("I'll confirm the time. Seed only.")).toBe('Seed only.');
    expect(clean('Seed only. Nick will review it and get back to you.')).toBe('Seed only.');
    expect(clean('It is pending approval. Seed only.')).toBe('Seed only.');
    expect(clean('Booking sends the invitation straight away.')).toBe(
      'Booking sends the invitation straight away.',
    );
  });

  it('caps at 600 characters and gives null when nothing is left', () => {
    const long = clean(`${'Seed rounds are our focus. '.repeat(40)}`)!;
    expect(long.length).toBeLessThanOrEqual(ANSWER_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(clean('https://evil.example')).toBeNull();
    expect(clean('Arwin will confirm.')).toBeNull();
    expect(sanitiseBookingAnswer(null, { bookingUrl: BOOKING_URL })).toBeNull();
  });
});
