import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addressMatches,
  cleanDomain,
  cleanEmail,
  cleanKeyword,
  gmailQuery,
  meetingMatches,
  nameFromDomain,
  rulesFromForm,
  ruleSet,
  textMatches,
  threadMatches,
} from '@/lib/spaces/rules';

/** A Space's rules: cleaning what a person typed, the Gmail search, the matchers. Fictional names only. */

describe('cleaning rules', () => {
  it('reads domains the way people paste them', () => {
    expect(cleanDomain('https://www.Northwind.Example/about')).toBe('northwind.example');
    expect(cleanDomain('@northwind.example')).toBe('northwind.example');
    expect(cleanDomain('dana@northwind.example')).toBe('northwind.example');
    expect(cleanDomain('not a domain')).toBeNull();
  });

  it('reads addresses and keywords, refusing Gmail operators', () => {
    expect(cleanEmail('Dana Reyes <DANA@northwind.example>')).toBe('dana@northwind.example');
    expect(cleanEmail('dana')).toBeNull();
    expect(cleanKeyword('  "Project   Lighthouse" ')).toBe('Project Lighthouse');
    expect(cleanKeyword('from:someone')).toBeNull();
    expect(cleanKeyword('OR')).toBeNull();
    expect(cleanKeyword('a')).toBeNull();
  });

  it('turns the form into deduped rules and names what it could not read', () => {
    const { rules, invalid } = rulesFromForm({
      domains: 'northwind.example, NORTHWIND.example, ???',
      emails: 'dana@partner.example',
      keywords: 'Lighthouse, Lighthouse',
    });
    expect(rules).toEqual([
      { kind: 'domain', value: 'northwind.example' },
      { kind: 'email', value: 'dana@partner.example' },
      { kind: 'keyword', value: 'Lighthouse' },
    ]);
    expect(invalid).toEqual(['???']);
  });
});

describe('the Gmail search', () => {
  it('is from/to the domains and addresses, or a keyword', () => {
    const set = ruleSet([
      { kind: 'domain', value: 'northwind.example' },
      { kind: 'email', value: 'dana@partner.example' },
      { kind: 'keyword', value: 'Project Lighthouse' },
    ]);
    expect(gmailQuery(set)).toBe(
      'from:northwind.example OR to:northwind.example OR from:dana@partner.example OR to:dana@partner.example OR "Project Lighthouse"',
    );
  });

  it('is nothing when there are no rules (never the whole mailbox)', () => {
    expect(gmailQuery(ruleSet([]))).toBeNull();
  });
});

describe('matching', () => {
  const set = ruleSet([
    { kind: 'domain', value: 'northwind.example' },
    { kind: 'keyword', value: 'Lighthouse' },
  ]);

  it('matches addresses at the domain and its subdomains, not lookalikes', () => {
    expect(addressMatches('Dana <dana@northwind.example>', set)).toBe(true);
    expect(addressMatches('ops@eu.northwind.example', set)).toBe(true);
    expect(addressMatches('x@notnorthwind.example', set)).toBe(false);
  });

  it('matches keywords as whole words', () => {
    expect(textMatches('Lighthouse kickoff', set)).toBe(true);
    expect(textMatches('lighthouses everywhere', set)).toBe(false);
  });

  it('matches threads and meetings by people or words', () => {
    expect(
      threadMatches(
        {
          subject: 'Hello',
          messages: [
            {
              from_address: 'me@fund.example',
              to_addresses: ['dana@northwind.example'],
              cc_addresses: [],
            },
          ],
        },
        set,
      ),
    ).toBe(true);
    expect(
      meetingMatches(
        { title: 'Lighthouse review', attendees: [{ email: 'x@other.example' }] },
        set,
      ),
    ).toBe(true);
    expect(meetingMatches({ title: 'Lunch', attendees: [{ email: 'x@other.example' }] }, set)).toBe(
      false,
    );
  });

  it('names a suggested Space from its domain', () => {
    expect(nameFromDomain('acme-robotics.example')).toBe('Acme Robotics');
  });
});

describe('spaces migration', () => {
  const SQL = readFileSync(
    path.resolve(import.meta.dirname, '../../supabase/migrations/20261106000000_spaces.sql'),
    'utf8',
  );

  it('is additive and re-runnable', () => {
    for (const t of ['spaces', 'space_rules', 'space_members', 'space_hidden_items']) {
      expect(SQL, t).toContain(`create table if not exists ${t} (`);
    }
    expect(SQL).not.toMatch(/\bdrop table\b|\bdrop column\b/i);
    expect(SQL).toMatch(
      /alter table tasks add column if not exists space_id uuid references spaces\(id\) on delete set null/,
    );
    expect(SQL).toMatch(/drop trigger if exists spaces_updated_at/);
  });

  it('names every constraint itself, dropping it before adding it', () => {
    expect(SQL).not.toMatch(/constraint \w+_\w+_check\b/);
    const added = [...SQL.matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(5);
    for (const name of added) expect(SQL).toContain(`drop constraint if exists ${name}`);
  });

  it('keeps every Space members only', () => {
    expect(SQL).toMatch(
      /create policy spaces_select on spaces for select using \(\s*is_org_member\(organization_id\) and \(created_by = auth\.uid\(\) or is_space_member\(id\)\)/,
    );
    expect(SQL).toMatch(
      /foreach t in array array\['space_rules', 'space_members', 'space_hidden_items'\] loop/,
    );
    expect(SQL).toMatch(/security definer\s+set search_path = public/);
    expect(SQL).toMatch(/Until it is applied the Spaces tab says it needs a database\s+-- update/);
  });

  it('uses no real names', () => {
    expect(SQL.toLowerCase()).not.toContain('athena');
  });
});
