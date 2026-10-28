import { describe, expect, it } from 'vitest';
import {
  buildFireCatalog,
  buildKnowledge,
  matchPerks,
  parsePerksSource,
  perkDigest,
  perkIndexLine,
  type PerkFact,
} from '@/lib/perks-ask/knowledge';

/** Entirely fictional catalog shaped like the public perks-data.js. */
const SOURCE = `
/* comment, as the real file has */
window.PERKS = [
  {
    slug: "acme-cloud",
    name: "Acme Cloud",
    kindLabel: "Software Vendor",
    catLabel: "Cloud & AI",
    tagline: "Credits for new teams — example only.",
    stat: "$10k",
    statLabel: "in credits",
    bullets: ["$10k in credits", "Priority support"],
    eligibility: "Portfolio companies.",
    redemption: {
      type: "email",
      note: "Email for an intro.",
      steps: ["Email", "Get intro"],
      email: "partners@acme.example",
      url: "https://acme.example/redeem",
      code: "SECRET-CODE"
    }
  },
  {
    slug: "pat-lee-advisory",
    name: "Pat Lee Advisory",
    kindLabel: "Consultant / Advisor",
    catLabel: "Product & Growth",
    provisional: true,
    tagline: "A warm introduction through the network.",
    bullets: [],
    redemption: { type: "email", note: "Warm intro.", steps: [] }
  },
  { not: "a perk" }
];
`;

describe('parsePerksSource', () => {
  it('runs the catalog in a sandbox and keeps only valid perks', () => {
    const parsed = parsePerksSource(SOURCE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.map((p) => p.slug)).toEqual(['acme-cloud', 'pat-lee-advisory']);
  });

  it('never carries redemption contacts, links or codes', () => {
    const parsed = parsePerksSource(SOURCE);
    if (!parsed.ok) throw new Error('expected ok');
    const flat = JSON.stringify(parsed.value);
    expect(flat).not.toContain('acme.example');
    expect(flat).not.toContain('SECRET-CODE');
  });

  it('refuses a catalog that is not a perks array', () => {
    expect(parsePerksSource('window.PERKS = 42;').ok).toBe(false);
    expect(parsePerksSource('throw new Error("boom")').ok).toBe(false);
  });
});

describe('perkDigest', () => {
  it('swaps em dashes for spaced hyphens and marks provisional listings', () => {
    const parsed = parsePerksSource(SOURCE);
    if (!parsed.ok) throw new Error('expected ok');
    const [acme, pat] = parsed.value as [PerkFact, PerkFact];
    const acmeBlock = perkDigest(acme);
    expect(acmeBlock).not.toContain('—');
    expect(acmeBlock).toContain('example only');
    expect(acmeBlock).toContain('perk.html?p=acme-cloud');
    const patBlock = perkDigest(pat);
    expect(patBlock).toContain('PROVISIONAL');
  });
});

describe('buildKnowledge', () => {
  it('splits the cohorts, counts them, and keeps the facts for the fire catalog', () => {
    const parsed = parsePerksSource(SOURCE);
    if (!parsed.ok) throw new Error('expected ok');
    const knowledge = buildKnowledge(parsed.value);
    expect(knowledge.count).toBe(2);
    expect(knowledge.softwareCount).toBe(1);
    expect(knowledge.consultantCount).toBe(1);
    expect(knowledge.digest).toContain('=== SOFTWARE VENDORS ===');
    expect(knowledge.digest).toContain('Pat Lee Advisory');
    expect(knowledge.facts).toHaveLength(2);
  });
});

describe('the fire-payload catalog', () => {
  function facts(): PerkFact[] {
    const parsed = parsePerksSource(SOURCE);
    if (!parsed.ok) throw new Error('expected ok');
    return parsed.value;
  }

  it('indexes every perk on one backtick-free line', () => {
    const [acme] = facts() as [PerkFact];
    const line = perkIndexLine({ ...acme, tagline: 'Has `ticks` — and dashes.' });
    expect(line).toContain('acme-cloud | Acme Cloud | Software Vendor');
    expect(line).not.toContain('`');
    expect(line).not.toContain('—');
  });

  it('matches perks by plain word overlap, directory noise ignored', () => {
    const all = facts();
    expect(matchPerks(all, 'Do we get cloud credits?').map((p) => p.slug)).toEqual(['acme-cloud']);
    expect(matchPerks(all, 'any growth advisory help?').map((p) => p.slug)).toEqual([
      'pat-lee-advisory',
    ]);
    expect(matchPerks(all, 'what perks do founders get?')).toEqual([]);
  });

  it('carries the whole index and full entries for the matches', () => {
    const block = buildFireCatalog(facts(), 'cloud credits');
    expect(block).toContain('PERKS_CATALOG_V1 (2 perks;');
    expect(block).toContain('pat-lee-advisory | Pat Lee Advisory');
    expect(block).toContain('PERKS_CATALOG_DETAIL_V1');
    expect(block).toContain('perk.html?p=acme-cloud');
    expect(block).not.toContain('`');
  });
});
