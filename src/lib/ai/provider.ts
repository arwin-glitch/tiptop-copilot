import type { z } from 'zod';
import type { Result } from '@/lib/util/result';

/** Which model tier a call needs. Never a model id at a call site. */
export type ModelTier = 'fast' | 'deep';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface UsageInfo {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  estimatedCostUsd: number;
  durationMs: number;
}

export interface StructuredRequest<T extends z.ZodType> {
  tier: ModelTier;
  operation: string;
  promptVersion: string;
  system: string;
  messages: AiMessage[];
  schema: T;
  maxTokens?: number;
  /** Enables the Anthropic web-search server tool for this call. */
  enableWebSearch?: boolean;
}

export interface StructuredResponse<T> {
  value: T;
  usage: UsageInfo;
  /** Web sources the model consulted, when web search was enabled. */
  webSources: WebSource[];
}

export interface WebSource {
  title: string;
  url: string;
  publisher: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  excerpt: string | null;
}

export interface TextRequest {
  tier: ModelTier;
  operation: string;
  promptVersion: string;
  system: string;
  messages: AiMessage[];
  maxTokens?: number;
}

export interface TextResponse {
  text: string;
  usage: UsageInfo;
}

/* --------------------------------------------------------------- tool use */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolInvocation {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolOutcome {
  name: string;
  ok: boolean;
  /** Serialised tool result handed back to the model. */
  content: string;
  /** Short human-readable line shown in the UI transcript. */
  summary: string;
  input: Record<string, unknown>;
}

export interface ToolConversationRequest<T extends z.ZodType> {
  tier: ModelTier;
  operation: string;
  promptVersion: string;
  system: string;
  messages: AiMessage[];
  tools: ToolDefinition[];
  /** Executes one tool call. Implemented by the allowlisted server tool layer. */
  execute: (invocation: ToolInvocation) => Promise<ToolOutcome>;
  finalSchema: T;
  maxIterations?: number;
  maxTokens?: number;
}

export interface ToolConversationResponse<T> {
  value: T;
  toolOutcomes: ToolOutcome[];
  usage: UsageInfo;
}

/**
 * The AI seam. `AnthropicProvider` talks to the real API; `MockAIProvider`
 * produces deterministic, evidence-derived output so the whole product is
 * testable and demonstrable without a key; `UnavailableAIProvider` refuses,
 * which is the only safe answer when the data is real and no key is set.
 *
 * The mock is reachable in demo mode alone. Fabricated analysis of fictional
 * companies is a demonstration; the same output over a real deal is a hazard.
 */
export interface AIProvider {
  readonly kind: 'anthropic' | 'mock' | 'none';
  /** False when the provider cannot serve requests (e.g. missing API key). */
  available(): boolean;

  generateStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
  ): Promise<Result<StructuredResponse<z.infer<T>>>>;

  generateText(request: TextRequest): Promise<Result<TextResponse>>;

  runToolConversation<T extends z.ZodType>(
    request: ToolConversationRequest<T>,
  ): Promise<Result<ToolConversationResponse<z.infer<T>>>>;
}
