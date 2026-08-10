import 'server-only';
import type { z } from 'zod';
import { err, type Result } from '@/lib/util/result';
import type {
  AIProvider,
  StructuredResponse,
  TextResponse,
  ToolConversationResponse,
} from './provider';

/**
 * The AI seam with nothing behind it.
 *
 * Live mode without an API key used to fall through to `MockAIProvider`. That
 * is right for a demo over fictional data and wrong everywhere else: the mock
 * would have produced fabricated analysis of *real* deals — labelled
 * `demo-offline-model`, but sitting in the same scorecard a partner reads to
 * make a decision.
 *
 * So this refuses instead, in the same shape as `NoResearchProvider`: the app
 * states that a capability is unavailable rather than guessing. Every service
 * already returns a failed `Result` unchanged, so the refusal surfaces as a
 * "not configured" state rather than an error page.
 */
export class UnavailableAIProvider implements AIProvider {
  readonly kind = 'none' as const;

  available(): boolean {
    return false;
  }

  unavailableReason(): string {
    return 'AI features are not configured. Set ANTHROPIC_API_KEY to enable them. Nothing here is answered from model memory.';
  }

  private refuse<T>(): Result<T> {
    return err('not_configured', this.unavailableReason(), {
      stillUsable:
        'Email, calendar, deals, documents, tasks and portfolio records are unaffected. Only AI-generated analysis is unavailable.',
    });
  }

  async generateStructured<T extends z.ZodType>(): Promise<Result<StructuredResponse<z.infer<T>>>> {
    return this.refuse();
  }

  async generateText(): Promise<Result<TextResponse>> {
    return this.refuse();
  }

  async runToolConversation<T extends z.ZodType>(): Promise<
    Result<ToolConversationResponse<z.infer<T>>>
  > {
    return this.refuse();
  }
}
