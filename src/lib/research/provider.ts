import 'server-only';
import { z } from 'zod';
import { env } from '@/lib/config/env';
import { log } from '@/lib/security/redact';
import { err, ok, type Result } from '@/lib/util/result';
import type { AIProvider, WebSource } from '@/lib/ai/provider';
import { systemPrompt } from '@/lib/ai/prompts';

/**
 * Optional public-web research.
 *
 * The default is `none`. When research is unavailable the app *says so* — it
 * never answers a "what's happening in the market" question from model memory
 * and presents it as current. Stale-vs-current is the whole reason this
 * provider records publication and retrieval dates separately.
 */

export interface ResearchQuery {
  query: string;
  purpose:
    | 'company_background'
    | 'founder_background'
    | 'competitors'
    | 'market_context'
    | 'funding_announcements'
    | 'product_claims'
    | 'industry_developments';
  maxResults?: number;
}

export interface ResearchFinding {
  summary: string;
  sources: WebSource[];
}

export interface ResearchProvider {
  readonly kind: 'none' | 'anthropic' | 'custom';
  available(): boolean;
  /** Human-readable reason shown in the UI when unavailable. */
  unavailableReason(): string | null;
  research(query: ResearchQuery): Promise<Result<ResearchFinding>>;
}

/* ------------------------------------------------------------------ none */

export class NoResearchProvider implements ResearchProvider {
  readonly kind = 'none' as const;
  available(): boolean {
    return false;
  }
  unavailableReason(): string {
    return 'Web research is disabled. Set RESEARCH_PROVIDER to enable it. Nothing here is answered from model memory.';
  }
  async research(): Promise<Result<ResearchFinding>> {
    return err('not_configured', this.unavailableReason(), {
      stillUsable: 'Email, deals, documents and calendar are unaffected.',
    });
  }
}

/* -------------------------------------------------------------- anthropic */

const webResearchSchema = z.object({
  summary: z.string().min(1).max(2000),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(500),
        source_url: z.string().min(1).max(500),
        source_title: z.string().max(300),
        published_date: z.string().max(40).nullable(),
      }),
    )
    .max(10),
  nothing_found: z.boolean(),
});

/** Uses the Anthropic server-side web-search tool via the shared AI provider. */
export class AnthropicResearchProvider implements ResearchProvider {
  readonly kind = 'anthropic' as const;

  constructor(private readonly ai: AIProvider) {}

  available(): boolean {
    return this.ai.kind === 'anthropic' && this.ai.available();
  }

  unavailableReason(): string | null {
    return this.available()
      ? null
      : 'Web research is configured for Anthropic but no API key is available.';
  }

  async research(query: ResearchQuery): Promise<Result<ResearchFinding>> {
    if (!this.available()) {
      return err('not_configured', this.unavailableReason() ?? 'Research unavailable.');
    }
    const result = await this.ai.generateStructured({
      tier: 'deep',
      operation: 'research.web',
      promptVersion: 'web-research@1.0.0',
      system: systemPrompt(
        `Research a public-web question for an investor.

Use the web search tool. Report only what the retrieved pages state, with the URL for each claim. If the search returns nothing relevant, set nothing_found to true and leave findings empty rather than answering from memory.

Include the publication date whenever the page states one. If a page has no date, return null — do not guess, and do not present undated material as current.`,
      ),
      messages: [
        {
          role: 'user',
          content: `Purpose: ${query.purpose}\nQuery: ${query.query}\nToday: ${new Date().toISOString().slice(0, 10)}`,
        },
      ],
      schema: webResearchSchema,
      enableWebSearch: true,
      maxTokens: 8000,
    });
    if (!result.ok) return result;

    const retrievedAt = new Date().toISOString();
    const sources: WebSource[] = result.value.value.findings.map((f) => ({
      title: f.source_title || f.source_url,
      url: f.source_url,
      publisher: safeHostname(f.source_url),
      publishedAt: f.published_date,
      retrievedAt,
      excerpt: f.claim,
    }));
    // Prefer sources the API itself reported; fall back to the model's list.
    const merged = result.value.webSources.length > 0 ? result.value.webSources : sources;

    return ok({
      summary: result.value.value.nothing_found
        ? 'The search returned nothing relevant. No claim is being made.'
        : result.value.value.summary,
      sources: merged,
    });
  }
}

/* ----------------------------------------------------------------- custom */

interface CustomSearchResponse {
  results?: {
    title?: string;
    url?: string;
    snippet?: string;
    published_date?: string;
    publisher?: string;
  }[];
}

/**
 * Adapter for any external search API that accepts `{ query, limit }` and
 * returns `{ results: [...] }`. Configured entirely by environment variable so
 * a different provider needs no code change.
 */
export class CustomSearchProvider implements ResearchProvider {
  readonly kind = 'custom' as const;

  available(): boolean {
    const e = env();
    return Boolean(e.researchApiUrl && e.researchApiKey);
  }

  unavailableReason(): string | null {
    return this.available()
      ? null
      : 'RESEARCH_PROVIDER is set to custom but RESEARCH_API_URL or RESEARCH_API_KEY is missing.';
  }

  async research(query: ResearchQuery): Promise<Result<ResearchFinding>> {
    const e = env();
    if (!this.available()) {
      return err('not_configured', this.unavailableReason() ?? 'Research unavailable.');
    }
    try {
      const response = await fetch(e.researchApiUrl!, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${e.researchApiKey}`,
        },
        body: JSON.stringify({ query: query.query, limit: query.maxResults ?? 5 }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        log.warn('Custom research provider failed', { status: response.status });
        return err('provider_unavailable', 'The configured research provider returned an error.', {
          retryable: true,
          stillUsable: 'Everything except public web research is unaffected.',
        });
      }
      const data = (await response.json()) as CustomSearchResponse;
      const retrievedAt = new Date().toISOString();
      const sources: WebSource[] = (data.results ?? [])
        .filter((r) => r.url)
        .map((r) => ({
          title: r.title ?? r.url!,
          url: r.url!,
          publisher: r.publisher ?? safeHostname(r.url!),
          publishedAt: r.published_date ?? null,
          retrievedAt,
          excerpt: r.snippet ?? null,
        }));
      return ok({
        summary:
          sources.length === 0
            ? 'The search returned nothing relevant. No claim is being made.'
            : `${sources.length} public source${sources.length === 1 ? '' : 's'} retrieved. Each claim below is attributed to its page.`,
        sources,
      });
    } catch {
      return err('provider_unavailable', 'Could not reach the configured research provider.', {
        retryable: true,
        stillUsable: 'Everything except public web research is unaffected.',
      });
    }
  }
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
