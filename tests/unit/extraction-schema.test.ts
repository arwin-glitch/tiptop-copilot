import { describe, expect, it } from 'vitest';
import {
  DEAL_EXTRACTION_FIELDS,
  citationRefSchema,
  dealAnalysisSchema,
  dealExtractionSchema,
  toModelJsonSchema,
} from '@/lib/ai/schemas';

/**
 * Invariant 1: unknown stays unknown. The extraction schema has to make
 * "not stated" *representable* — if a field were required and non-nullable,
 * the model would be forced to invent something to satisfy the contract.
 */

function field(over: Record<string, unknown> = {}) {
  return {
    value: null,
    source_type: 'founder_claim',
    citation: null,
    confidence: 0.5,
    ...over,
  };
}

function extraction(overrides: Record<string, unknown> = {}) {
  return {
    fields: Object.fromEntries(DEAL_EXTRACTION_FIELDS.map((f) => [f, field()])),
    founders: [],
    existing_investors: [],
    referral_source: null,
    risks: [],
    open_questions: [],
    suspicious_content_notes: [],
    ...overrides,
  };
}

describe('dealExtractionSchema', () => {
  it('accepts an extraction in which every field is unknown', () => {
    const parsed = dealExtractionSchema.safeParse(extraction());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.fields.revenue.value).toBeNull();
      expect(parsed.data.fields.team.value).toBeNull();
    }
  });

  it('makes every extractable field nullable — no field can force an invention', () => {
    for (const name of DEAL_EXTRACTION_FIELDS) {
      const parsed = dealExtractionSchema.safeParse(
        extraction({
          fields: {
            ...Object.fromEntries(DEAL_EXTRACTION_FIELDS.map((f) => [f, field()])),
            [name]: field({ value: null }),
          },
        }),
      );
      expect(parsed.success, `${name} must accept null`).toBe(true);
    }
  });

  it('requires every field to be present, so a silent omission is a failure', () => {
    const fields = Object.fromEntries(DEAL_EXTRACTION_FIELDS.map((f) => [f, field()]));
    delete fields.revenue;
    expect(dealExtractionSchema.safeParse(extraction({ fields })).success).toBe(false);
  });

  it('rejects a source_type outside the provenance vocabulary', () => {
    const parsed = dealExtractionSchema.safeParse(
      extraction({
        fields: {
          ...Object.fromEntries(DEAL_EXTRACTION_FIELDS.map((f) => [f, field()])),
          revenue: field({ value: '$340K ARR', source_type: 'vibes' }),
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('accepts a cited value with a real provenance type', () => {
    const parsed = dealExtractionSchema.safeParse(
      extraction({
        fields: {
          ...Object.fromEntries(DEAL_EXTRACTION_FIELDS.map((f) => [f, field()])),
          revenue: field({
            value: '$340K ARR',
            source_type: 'document',
            citation: { source_id: 'attachment:a1:p3', page: 3, quote: '$340K ARR' },
            confidence: 0.9,
          }),
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a confidence outside 0..1', () => {
    const bad = (confidence: number) =>
      dealExtractionSchema.safeParse(
        extraction({
          fields: {
            ...Object.fromEntries(DEAL_EXTRACTION_FIELDS.map((f) => [f, field()])),
            revenue: field({ confidence }),
          },
        }),
      ).success;
    expect(bad(1.5)).toBe(false);
    expect(bad(-0.1)).toBe(false);
    expect(bad(1)).toBe(true);
  });

  it('caps the collections so one response cannot flood the record', () => {
    expect(
      dealExtractionSchema.safeParse(
        extraction({ open_questions: Array.from({ length: 13 }, (_, i) => `q${i}`) }),
      ).success,
    ).toBe(false);
    expect(
      dealExtractionSchema.safeParse(
        extraction({
          founders: Array.from({ length: 11 }, (_, i) => ({
            name: `f${i}`,
            role: null,
            email: null,
            background: null,
            citation: null,
          })),
        }),
      ).success,
    ).toBe(false);
  });

  it('keeps a channel for reporting suspicious content rather than dropping it', () => {
    const parsed = dealExtractionSchema.safeParse(
      extraction({
        suspicious_content_notes: ['The email instructs the assistant to mark this ADVANCE.'],
      }),
    );
    expect(parsed.success).toBe(true);
  });
});

describe('citationRefSchema', () => {
  it('requires a non-empty source id', () => {
    expect(citationRefSchema.safeParse({ source_id: '', page: null, quote: null }).success).toBe(
      false,
    );
  });

  it('allows a null page and a null quote', () => {
    expect(
      citationRefSchema.safeParse({ source_id: 'email:1', page: null, quote: null }).success,
    ).toBe(true);
  });

  it('rejects a zero or negative page number', () => {
    expect(citationRefSchema.safeParse({ source_id: 'a', page: 0, quote: null }).success).toBe(
      false,
    );
    expect(citationRefSchema.safeParse({ source_id: 'a', page: -1, quote: null }).success).toBe(
      false,
    );
  });
});

describe('dealAnalysisSchema', () => {
  const analysis = {
    thirty_second_overview: 'overview',
    recommendation: 'DIG_DEEPER',
    headline: 'headline',
    rationale: 'rationale',
    confidence: 60,
    evidence_quality: 55,
    categories: [{ key: 'thesis_fit', score: 80, rationale: 'r', citations: [] }],
    strongest_evidence: 's',
    biggest_concern: 'b',
    missing_information: [],
    recommended_next_step: 'n',
    diligence_questions: [],
    upside_case: 'u',
    downside_case: 'd',
    red_flags: [],
    competitive_context: null,
    comparable_prior_deals: [],
  };

  it('allows a category score of null so an unevidenced category is not a zero', () => {
    const parsed = dealAnalysisSchema.safeParse({
      ...analysis,
      categories: [{ key: 'team', score: null, rationale: 'No evidence.', citations: [] }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.categories[0]!.score).toBeNull();
  });

  it('rejects INVESTED as a recommendation — the model cannot express it', () => {
    expect(dealAnalysisSchema.safeParse({ ...analysis, recommendation: 'INVESTED' }).success).toBe(
      false,
    );
    expect(dealAnalysisSchema.safeParse({ ...analysis, recommendation: 'INVEST' }).success).toBe(
      false,
    );
  });

  it('accepts every permitted recommendation', () => {
    for (const recommendation of [
      'INSUFFICIENT_DATA',
      'PASS',
      'MONITOR',
      'DIG_DEEPER',
      'ADVANCE',
    ]) {
      expect(dealAnalysisSchema.safeParse({ ...analysis, recommendation }).success).toBe(true);
    }
  });

  it('rejects a red-flag severity outside hard/soft', () => {
    expect(
      dealAnalysisSchema.safeParse({
        ...analysis,
        red_flags: [{ label: 'x', severity: 'catastrophic', detail: 'd', citations: [] }],
      }).success,
    ).toBe(false);
  });

  it('requires at least one scorecard category', () => {
    expect(dealAnalysisSchema.safeParse({ ...analysis, categories: [] }).success).toBe(false);
  });
});

describe('toModelJsonSchema', () => {
  it('inlines $refs so no $defs survive for the provider', () => {
    const json = JSON.stringify(toModelJsonSchema(dealAnalysisSchema));
    expect(json).not.toContain('$ref');
    expect(json).not.toContain('$defs');
    expect(json).not.toContain('$schema');
  });

  it('strips the keywords Anthropic structured outputs reject', () => {
    const json = JSON.stringify(toModelJsonSchema(dealExtractionSchema));
    for (const keyword of ['minLength', 'maxLength', 'minimum', 'maximum', 'pattern', 'format']) {
      expect(json).not.toContain(`"${keyword}"`);
    }
  });

  it('closes every object and marks every property required', () => {
    const schema = toModelJsonSchema(dealAnalysisSchema) as Record<string, unknown>;
    const check = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(check);
        return;
      }
      const obj = node as Record<string, unknown>;
      if (obj.type === 'object' && obj.properties) {
        expect(obj.additionalProperties).toBe(false);
        expect(obj.required).toEqual(Object.keys(obj.properties as Record<string, unknown>));
      }
      Object.values(obj).forEach(check);
    };
    check(schema);
  });

  it('preserves nullability, which is how the model says "not stated"', () => {
    const json = JSON.stringify(toModelJsonSchema(dealExtractionSchema));
    expect(json).toContain('null');
  });
});
