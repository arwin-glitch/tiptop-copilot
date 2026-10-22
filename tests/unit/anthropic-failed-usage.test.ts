import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicProvider } from '@/lib/ai/anthropic';
import { estimateCostUsd, modelFor } from '@/lib/ai/models';
import { resetEnvCache } from '@/lib/config/env';

/**
 * A tool conversation that fails after paid rounds still cost those rounds.
 * The provider puts what it spent on the error (`details`), so a caller with
 * a spending cap (the public booking chatbot, D-074) counts the real figure
 * instead of a guess. The model client is faked: nothing leaves the test.
 */

const SAVED = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';
  resetEnvCache();
});

afterEach(() => {
  if (SAVED === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = SAVED;
  resetEnvCache();
});

/** A provider whose client answers from a script instead of the network. */
function scripted(answers: (() => unknown)[]): AnthropicProvider {
  const provider = new AnthropicProvider();
  let i = 0;
  (provider as unknown as { client: unknown }).client = {
    messages: {
      create: async () => {
        const next = answers[Math.min(i, answers.length - 1)]!;
        i += 1;
        return next();
      },
    },
  };
  return provider;
}

const toolRound = () => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `t${Math.random()}`, name: 'get_faq', input: {} }],
  usage: { input_tokens: 5_000, output_tokens: 600 },
});

const request = {
  tier: 'fast' as const,
  operation: 'test.op',
  promptVersion: 'test@1',
  system: 'Test',
  messages: [{ role: 'user' as const, content: 'hi' }],
  tools: [{ name: 'get_faq', description: 'FAQ', inputSchema: { type: 'object' } }],
  execute: async () => ({ name: 'get_faq', ok: true, content: '{}', summary: 'ok', input: {} }),
  finalSchema: z.object({ reply: z.string() }),
  maxIterations: 3,
  maxTokens: 600,
};

describe('a failed tool conversation reports what it spent', () => {
  it('after running out of rounds', async () => {
    const result = await scripted([toolRound]).runToolConversation(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('timeout');
    const model = modelFor('fast');
    expect(result.error.details).toMatchObject({
      usageModel: model,
      usageInputTokens: 15_000,
      usageOutputTokens: 1_800,
      usageCostUsd: estimateCostUsd(model, 15_000, 1_800, 0),
    });
  });

  it('when the provider fails after a paid round, and not when nothing was paid', async () => {
    const down = () => {
      throw Object.assign(new Error('overloaded'), { status: 529 });
    };
    const mid = await scripted([toolRound, down]).runToolConversation(request);
    expect(!mid.ok && mid.error.details?.usageInputTokens).toBe(5_000);
    const first = await scripted([down]).runToolConversation(request);
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.details?.usageCostUsd).toBeUndefined();
  });

  it('when the final answer is not valid JSON', async () => {
    const bad = () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'not json' }],
      usage: { input_tokens: 2_000, output_tokens: 100 },
    });
    const result = await scripted([bad]).runToolConversation(request);
    expect(!result.ok && result.error.code).toBe('invalid_model_output');
    expect(!result.ok && result.error.details?.usageOutputTokens).toBe(100);
  });
});
