import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import type { z } from 'zod';
import { env } from '@/lib/config/env';
import { log } from '@/lib/security/redact';
import { err, ok, type Result } from '@/lib/util/result';
import { defaultMaxTokens, effortFor, estimateCostUsd, modelFor } from './models';
import type {
  AIProvider,
  StructuredRequest,
  StructuredResponse,
  TextRequest,
  TextResponse,
  ToolConversationRequest,
  ToolConversationResponse,
  ToolOutcome,
  UsageInfo,
  WebSource,
} from './provider';
import { toModelJsonSchema } from './schemas';

/**
 * Server-side Anthropic adapter. The API key is read here and nowhere else;
 * nothing in this module is importable from a client component.
 *
 * Two capability gates matter and are handled explicitly rather than assumed:
 *   - adaptive thinking + `effort` exist on the 4.6+ generation only; sending
 *     them to an older fast model is a 400.
 *   - the dynamic-filtering web-search tool needs a recent model; older ones
 *     take the basic variant.
 */

type RequestBody = Record<string, unknown>;

function supportsAdaptiveThinking(model: string): boolean {
  return /(opus-5|opus-4-8|opus-4-7|opus-4-6|sonnet-5|sonnet-4-6|fable-5|mythos-5)/.test(model);
}

function supportsEffort(model: string): boolean {
  return supportsAdaptiveThinking(model) || /opus-4-5/.test(model);
}

function webSearchToolType(model: string): string {
  return supportsAdaptiveThinking(model) ? 'web_search_20260209' : 'web_search_20250305';
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}

interface AnthropicMessageResponse {
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content: AnthropicContentBlock[];
  usage?: AnthropicUsage;
}

export class AnthropicProvider implements AIProvider {
  readonly kind = 'anthropic' as const;
  private client: Anthropic | null = null;

  available(): boolean {
    return Boolean(env().anthropicApiKey);
  }

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic({
        apiKey: env().anthropicApiKey,
        maxRetries: 2,
        timeout: 180_000,
      });
    }
    return this.client;
  }

  private baseBody(
    tier: 'fast' | 'deep',
    system: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
    maxTokens: number | undefined,
  ): { model: string; body: RequestBody } {
    const model = modelFor(tier);
    const body: RequestBody = {
      model,
      max_tokens: maxTokens ?? defaultMaxTokens(tier),
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (supportsAdaptiveThinking(model)) {
      body.thinking = { type: 'adaptive' };
    }
    return { model, body };
  }

  private usageFrom(
    response: AnthropicMessageResponse,
    model: string,
    startedAt: number,
  ): UsageInfo {
    const u = response.usage ?? {};
    const input = u.input_tokens ?? null;
    const output = u.output_tokens ?? null;
    const cached = u.cache_read_input_tokens ?? null;
    return {
      model: response.model ?? model,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cached,
      estimatedCostUsd: estimateCostUsd(response.model ?? model, input, output, cached),
      durationMs: Date.now() - startedAt,
    };
  }

  async generateStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
  ): Promise<Result<StructuredResponse<z.infer<T>>>> {
    if (!this.available()) {
      return err('not_configured', 'ANTHROPIC_API_KEY is not set.', {
        stillUsable: 'Stored data, search and manual workflows are unaffected.',
      });
    }
    const startedAt = Date.now();
    const { model, body } = this.baseBody(
      request.tier,
      request.system,
      request.messages,
      request.maxTokens,
    );

    const outputConfig: RequestBody = {
      format: { type: 'json_schema', schema: toModelJsonSchema(request.schema) },
    };
    if (supportsEffort(model)) outputConfig.effort = effortFor(request.tier);
    body.output_config = outputConfig;

    if (request.enableWebSearch) {
      body.tools = [{ type: webSearchToolType(model), name: 'web_search', max_uses: 5 }];
    }

    try {
      const response = (await this.getClient().messages.create(
        body as unknown as Anthropic.MessageCreateParamsNonStreaming,
      )) as unknown as AnthropicMessageResponse;

      const usage = this.usageFrom(response, model, startedAt);

      if (response.stop_reason === 'refusal') {
        return err('provider_unavailable', 'The model declined to answer this request.', {
          details: { category: response.stop_details?.category ?? 'unknown' },
        });
      }
      if (response.stop_reason === 'max_tokens') {
        return err(
          'invalid_model_output',
          'The model response was cut off before it was complete. Try again, or reduce the amount of source material.',
          { retryable: true },
        );
      }

      const text = response.content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text ?? '')
        .join('');

      if (!text.trim()) {
        return err('invalid_model_output', 'The model returned an empty response.', {
          retryable: true,
        });
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        return err('invalid_model_output', 'The model response was not valid JSON.', {
          retryable: true,
        });
      }

      const parsed = request.schema.safeParse(parsedJson);
      if (!parsed.success) {
        log.warn('Structured output failed schema validation', {
          operation: request.operation,
          promptVersion: request.promptVersion,
          issues: parsed.error.issues.slice(0, 5).map((i) => ({
            path: i.path.join('.'),
            code: i.code,
          })),
        });
        return err('invalid_model_output', 'The model response did not match the expected shape.', {
          retryable: true,
        });
      }

      return ok({
        value: parsed.data as z.infer<T>,
        usage,
        webSources: extractWebSources(response.content),
      });
    } catch (error) {
      return mapProviderError(error, request.operation);
    }
  }

  async generateText(request: TextRequest): Promise<Result<TextResponse>> {
    if (!this.available()) {
      return err('not_configured', 'ANTHROPIC_API_KEY is not set.');
    }
    const startedAt = Date.now();
    const { model, body } = this.baseBody(
      request.tier,
      request.system,
      request.messages,
      request.maxTokens,
    );
    if (supportsEffort(model)) {
      body.output_config = { effort: effortFor(request.tier) };
    }
    try {
      const response = (await this.getClient().messages.create(
        body as unknown as Anthropic.MessageCreateParamsNonStreaming,
      )) as unknown as AnthropicMessageResponse;
      if (response.stop_reason === 'refusal') {
        return err('provider_unavailable', 'The model declined to answer this request.');
      }
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return ok({ text, usage: this.usageFrom(response, model, startedAt) });
    } catch (error) {
      return mapProviderError(error, request.operation);
    }
  }

  /**
   * Manual tool loop rather than the SDK tool runner: every tool call has to
   * pass through the allowlisted, authorization-checked executor, and we need
   * the per-call outcomes for the UI transcript and audit trail.
   */
  async runToolConversation<T extends z.ZodType>(
    request: ToolConversationRequest<T>,
  ): Promise<Result<ToolConversationResponse<z.infer<T>>>> {
    if (!this.available()) {
      return err('not_configured', 'ANTHROPIC_API_KEY is not set.');
    }
    const startedAt = Date.now();
    const model = modelFor(request.tier);
    const maxIterations = request.maxIterations ?? 6;
    const outcomes: ToolOutcome[] = [];

    const conversation: { role: 'user' | 'assistant'; content: unknown }[] = request.messages.map(
      (m) => ({ role: m.role, content: m.content }),
    );

    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;

    const outputConfig: RequestBody = {
      format: { type: 'json_schema', schema: toModelJsonSchema(request.finalSchema) },
    };
    if (supportsEffort(model)) outputConfig.effort = effortFor(request.tier);

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const body: RequestBody = {
        model,
        max_tokens: request.maxTokens ?? defaultMaxTokens(request.tier),
        system: request.system,
        messages: conversation,
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        output_config: outputConfig,
      };
      if (supportsAdaptiveThinking(model)) body.thinking = { type: 'adaptive' };

      let response: AnthropicMessageResponse;
      try {
        response = (await this.getClient().messages.create(
          body as unknown as Anthropic.MessageCreateParamsNonStreaming,
        )) as unknown as AnthropicMessageResponse;
      } catch (error) {
        return mapProviderError(error, request.operation);
      }

      const u = response.usage ?? {};
      totalInput += u.input_tokens ?? 0;
      totalOutput += u.output_tokens ?? 0;
      totalCached += u.cache_read_input_tokens ?? 0;

      if (response.stop_reason === 'refusal') {
        return err('provider_unavailable', 'The model declined to answer this request.');
      }

      const toolUses = response.content.filter((b) => b.type === 'tool_use');

      if (toolUses.length === 0) {
        const text = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(text);
        } catch {
          return err('invalid_model_output', 'The assistant response was not valid JSON.', {
            retryable: true,
          });
        }
        const parsed = request.finalSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return err('invalid_model_output', 'The assistant response did not match its schema.', {
            retryable: true,
          });
        }
        return ok({
          value: parsed.data as z.infer<T>,
          toolOutcomes: outcomes,
          usage: {
            model,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            cacheReadTokens: totalCached,
            estimatedCostUsd: estimateCostUsd(model, totalInput, totalOutput, totalCached),
            durationMs: Date.now() - startedAt,
          },
        });
      }

      conversation.push({ role: 'assistant', content: response.content });

      const results: unknown[] = [];
      for (const block of toolUses) {
        const outcome = await request.execute({
          name: block.name ?? '',
          input: (block.input ?? {}) as Record<string, unknown>,
        });
        outcomes.push(outcome);
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: outcome.content,
          is_error: !outcome.ok,
        });
      }
      // All results go back in a single user turn; splitting them trains the
      // model out of parallel tool use.
      conversation.push({ role: 'user', content: results });
    }

    return err(
      'timeout',
      'The assistant used its tool budget without reaching an answer. Try a narrower question.',
      { retryable: true },
    );
  }
}

function extractWebSources(content: AnthropicContentBlock[]): WebSource[] {
  const sources: WebSource[] = [];
  const retrievedAt = new Date().toISOString();
  for (const block of content) {
    if (block.type !== 'web_search_tool_result') continue;
    const results = Array.isArray(block.content) ? block.content : [];
    for (const r of results) {
      const item = r as {
        title?: string;
        url?: string;
        page_age?: string;
        encrypted_content?: string;
      };
      if (!item.url) continue;
      let publisher: string | null = null;
      try {
        publisher = new URL(item.url).hostname.replace(/^www\./, '');
      } catch {
        publisher = null;
      }
      sources.push({
        title: item.title ?? item.url,
        url: item.url,
        publisher,
        publishedAt: item.page_age ?? null,
        retrievedAt,
        excerpt: null,
      });
    }
  }
  return sources;
}

function mapProviderError(error: unknown, operation: string): Result<never> {
  const e = error as { status?: number; message?: string; name?: string };
  const status = e?.status;
  log.warn('Anthropic request failed', {
    operation,
    status: status ?? null,
    name: e?.name ?? null,
  });
  if (status === 401 || status === 403) {
    return err('provider_unauthorized', 'The Anthropic API key was rejected. Check the key.', {
      stillUsable: 'Stored data and manual workflows are unaffected.',
    });
  }
  if (status === 429) {
    return err('rate_limited', 'Anthropic rate limit reached. Try again shortly.', {
      retryable: true,
    });
  }
  if (status === 400) {
    return err('invalid_input', 'The request was rejected as malformed by the model provider.');
  }
  if (e?.name === 'APIConnectionTimeoutError' || status === 504) {
    return err('timeout', 'The model took too long to respond. Try again.', { retryable: true });
  }
  if (status && status >= 500) {
    return err('provider_unavailable', 'The model provider is unavailable. Try again shortly.', {
      retryable: true,
    });
  }
  return err('provider_unavailable', 'The model request failed.', { retryable: true });
}
