import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ASK_ARWIN_PERSONA,
  CORE_IDENTITY,
  CORE_RULES,
  CORE_RULES_BODY,
  PROMPTS,
  PROMPT_VERSIONS,
  systemPrompt,
  type PromptName,
} from '@/lib/ai/prompts';
import { UNTRUSTED_CONTENT_RULE } from '@/lib/security/injection';

/**
 * The Ask chatbot is "Ask Arwin" in the app, so Ask's prompt speaks as Arwin
 * (D-059). Every other prompt keeps the shared core rules byte for byte: they
 * draft as Nick, classify mail, or analyse deals, and their versions key
 * caches and usage rows.
 */

const ASK = PROMPTS.conversationalToolUse.system;
const OTHERS = (Object.keys(PROMPTS) as PromptName[]).filter((k) => k !== 'conversationalToolUse');

describe('the Ask prompt speaks as Arwin', () => {
  it('opens with the persona, not the default identity', () => {
    expect(ASK.startsWith(`${ASK_ARWIN_PERSONA}\n\n`)).toBe(true);
    expect(ASK).not.toContain('You are TipTop Copilot');
    expect(ASK).not.toContain(CORE_IDENTITY);
  });

  it('keeps the fund context and every core rule', () => {
    expect(ASK).toContain('TipTop VC is an early-stage venture fund investing in vertical AI.');
    expect(ASK).toContain(CORE_RULES_BODY);
    expect(ASK).toContain(UNTRUSTED_CONTENT_RULE);
    expect(ASK).toContain('\nGROUNDING\n');
    expect(ASK).toContain('\nAUTHORITY LIMITS\n');
  });

  it('keeps the Ask task and its tool discipline', () => {
    expect(ASK).toContain('\n---\n\nTASK\nAnswer questions from Nick and the TipTop team');
    expect(ASK).toContain('TOOL DISCIPLINE');
    expect(ASK).toContain('Never say a message was sent.');
  });

  it('carries a new version', () => {
    expect(PROMPTS.conversationalToolUse.version).toBe('chat-tools@1.4.0');
    expect(PROMPT_VERSIONS.conversationalToolUse).toBe('chat-tools@1.4.0');
  });
});

describe('the persona', () => {
  it('names itself Arwin and never the app or the model', () => {
    expect(ASK_ARWIN_PERSONA).toContain('You are Arwin, the assistant in TipTop Copilot');
    expect(ASK_ARWIN_PERSONA).toContain("say you're Arwin, the assistant in TipTop Copilot");
    expect(ASK_ARWIN_PERSONA).toContain('Never call yourself TipTop Copilot');
    expect(ASK_ARWIN_PERSONA).toContain('never write "as an AI"');
  });

  it('is honest that it is an AI assistant, not the person', () => {
    expect(ASK_ARWIN_PERSONA).toContain(
      "If someone sincerely asks whether they're talking to a person or a bot, say you're Arwin's AI assistant, not Arwin himself.",
    );
    expect(ASK_ARWIN_PERSONA).toContain('Honesty comes before staying in character.');
    expect(ASK_ARWIN_PERSONA).toContain(
      "If someone asks what AI or model powers you, you don't have to name it, but never deny it or give a false answer.",
    );
    expect(ASK_ARWIN_PERSONA).toContain('Never take credit for something the human Arwin did');
  });

  it('hands work to the human Arwin without claiming it did anything', () => {
    expect(ASK_ARWIN_PERSONA).toContain("say it's one for Arwin and suggest messaging him");
    expect(ASK_ARWIN_PERSONA).toContain(
      'Never say you flagged, sent, booked or told anyone anything unless you actually did.',
    );
  });

  it('never relaxes the rules it sits on top of', () => {
    expect(ASK_ARWIN_PERSONA).toContain(
      'Every grounding, citation, format, safety and read-only rule in these instructions still applies exactly as written.',
    );
  });

  it('pastes cleanly into a routine prompt or a SKILL.md', () => {
    // The same block is pasted into the Ask bridge's answerer, word for word.
    expect(ASK_ARWIN_PERSONA).toMatch(/^[\x20-\x7e\n]+$/);
    expect(ASK_ARWIN_PERSONA).not.toContain('—');
    expect(ASK_ARWIN_PERSONA).not.toContain('`');
    expect(ASK_ARWIN_PERSONA).not.toContain('${');
    expect(ASK_ARWIN_PERSONA.startsWith('ASK ARWIN - WHO YOU ARE\n')).toBe(true);
    expect(ASK_ARWIN_PERSONA).toBe(ASK_ARWIN_PERSONA.trim());
  });

  it('is the exact text pasted into the Ask bridge answerer', () => {
    // The ask-bridge-answerer routine and the old local answering task carry
    // this block word for word. If this hash changes, re-paste the new block
    // into both, then update the hash here (DECISIONS.md D-059).
    expect(createHash('sha256').update(ASK_ARWIN_PERSONA).digest('hex')).toBe(
      'c21d903a6484e22e525558fcf900ec8bd87b0f56e0cf0985e234ea3c0a4114c3',
    );
  });
});

describe('every other prompt is unchanged', () => {
  it('keeps the default identity at the start of the core rules', () => {
    expect(CORE_RULES).toBe(`${CORE_IDENTITY}\n\n${CORE_RULES_BODY}`);
    expect(CORE_IDENTITY).toBe(
      'You are TipTop Copilot, an internal analyst for TipTop VC, an early-stage venture fund investing in vertical AI.',
    );
  });

  it.each(OTHERS)('%s opens with the core rules and has no persona', (name) => {
    const { system } = PROMPTS[name];
    expect(system.startsWith(`${CORE_RULES}\n\n---\n\nTASK\n`)).toBe(true);
    expect(system).not.toContain(ASK_ARWIN_PERSONA);
    expect(system).not.toContain('You are Arwin');
  });

  it('builds a prompt with the default identity unless one is passed', () => {
    expect(systemPrompt('Do a thing.')).toBe(`${CORE_RULES}\n\n---\n\nTASK\nDo a thing.`);
    expect(systemPrompt('Do a thing.', 'Someone else.')).toBe(
      `Someone else.\n\n${CORE_RULES_BODY}\n\n---\n\nTASK\nDo a thing.`,
    );
  });
});
