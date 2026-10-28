import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hiringOrgMatches,
  isCareersPageRole,
  jsonLdBlocks,
  MAX_PAGE_ROLES,
  pageSourceKey,
  parseCareersPageJobs,
} from '@/lib/jobs-board/careers-page';
import { isLinkedInJobsUrl, linkedInJobsUrl } from '@/lib/jobs-board/linkedin';

/**
 * Reading a careers page's JobPosting structured data, and the LinkedIn jobs
 * link. Every company, role and address here is fictional.
 */

const PAGE = readFileSync(path.join('tests', 'fixtures', 'careers', 'acme-robotics.html'), 'utf8');
const NOW = new Date('2026-10-28T12:00:00.000Z');
const PAGE_URL = 'https://acme-robotics.example.com/careers';

function read(html: string, companyName: string | null = 'Acme Robotics') {
  return parseCareersPageJobs(html, { pageUrl: PAGE_URL, companyName, now: NOW });
}

function page(...nodes: unknown[]): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(nodes.length === 1 ? nodes[0] : nodes)}</script></head></html>`;
}

describe('parseCareersPageJobs', () => {
  it('reads JobPostings from @graph, arrays and single blocks, mapping every field', () => {
    const parsed = read(PAGE);
    expect(parsed.hasJsonLd).toBe(true);
    expect(parsed.postings.map((p) => p.title)).toEqual([
      'Senior Robotics Engineer',
      'Customer Success Lead',
      'Field Technician',
    ]);
    const [eng, cs, tech] = parsed.postings;
    expect(eng).toMatchObject({
      externalId: 'ENG-104',
      locations: ['Austin, TX, US'],
      remote: null,
      employmentType: 'full_time',
      comp: '$150K – $185K / year',
      // A relative link is resolved against the page.
      applyUrl: 'https://acme-robotics.example.com/careers/senior-robotics-engineer',
      postedAt: '2026-10-01T00:00:00.000Z',
      team: null,
    });
    expect(eng!.description).toContain('Build the arms.');
    expect(eng!.description).toContain('- ROS 2');
    expect(eng!.description).not.toMatch(/alert|tracker|<|script/);
    expect(cs).toMatchObject({
      remote: 'remote',
      locations: ['Remote (USA)'],
      employmentType: 'contract',
      applyUrl: 'https://jobs.acme-robotics.example.com/cs-lead',
    });
    expect(tech).toMatchObject({
      locations: ['Denver, CO', 'Boise, ID'],
      employmentType: 'full_time',
    });
    // No identifier: a stable id from the link and title, the same every read.
    expect(tech!.externalId).toMatch(/^[0-9a-f]{16}$/);
    expect(read(PAGE).postings[2]!.externalId).toBe(tech!.externalId);
  });

  it('leaves out expired roles, bad links, other companies, untitled entries and broken JSON', () => {
    const parsed = read(PAGE);
    expect(parsed.expired).toBe(1);
    // "Bad Link Role" (javascript:), "Someone Else's Role" (Globex), the untitled one.
    expect(parsed.skipped).toBe(3);
    const titles = parsed.postings.map((p) => p.title);
    expect(titles).not.toContain('Old Role');
    expect(titles).not.toContain('Bad Link Role');
    expect(titles).not.toContain("Someone Else's Role");
    // A plain script that only looks like JSON-LD is never read.
    expect(titles).not.toContain('Hidden');
  });

  it('keeps only http and https links, and never a link with credentials', () => {
    const bad = [
      'data:text/html,hi',
      'ftp://acme-robotics.example.com/x',
      'https://u:p@x.example/',
    ];
    for (const url of bad) {
      expect(read(page({ '@type': 'JobPosting', title: 'Role', url })).postings).toEqual([]);
    }
    const none = read(page({ '@type': 'JobPosting', title: 'No Link Role' }));
    expect(none.postings[0]!.applyUrl).toBeNull();
  });

  it('accepts @type as a list or a full schema.org address', () => {
    const parsed = read(
      page(
        { '@type': ['Thing', 'JobPosting'], title: 'Listed Type', identifier: 'a-1' },
        { '@type': 'https://schema.org/JobPosting', title: 'Full Type', identifier: 'a-2' },
        {
          '@type': 'ItemList',
          itemListElement: [
            { item: { '@type': 'JobPosting', title: 'In List', identifier: 'a-3' } },
          ],
        },
      ),
    );
    expect(parsed.postings.map((p) => p.title)).toEqual(['Listed Type', 'Full Type', 'In List']);
  });

  it('caps the roles read from one page, and keeps one per id', () => {
    const nodes = Array.from({ length: MAX_PAGE_ROLES + 40 }, (_, i) => ({
      '@type': 'JobPosting',
      title: `Role ${i}`,
      identifier: `r-${i}`,
    }));
    expect(read(page(...nodes)).postings).toHaveLength(MAX_PAGE_ROLES);
    const twice = read(
      page(
        { '@type': 'JobPosting', title: 'Same', identifier: 'x' },
        { '@type': 'JobPosting', title: 'Same again', identifier: 'x' },
      ),
    );
    expect(twice.postings).toHaveLength(1);
    expect(twice.skipped).toBe(1);
  });

  it('skips an oversized block and reads a hostile page in linear time', () => {
    const huge = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Huge',
      description: 'x'.repeat(500_000),
    })}</script>`;
    expect(read(huge).postings).toEqual([]);
    const hostile = '<script type="application/ld+json">'.repeat(20_000);
    const started = Date.now();
    expect(read(hostile).postings).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(jsonLdBlocks('<script>no</script>')).toEqual([]);
  });

  it('reads nothing from an empty page or one with no JSON-LD', () => {
    expect(read('')).toMatchObject({ postings: [], hasJsonLd: false });
    expect(read('<html><body>Careers</body></html>')).toMatchObject({
      postings: [],
      hasJsonLd: false,
    });
  });
});

describe('hiringOrgMatches', () => {
  it('matches the company by a shared word, ignoring legal suffixes', () => {
    const node = (name: string) => ({ hiringOrganization: { name } });
    expect(hiringOrgMatches(node('Acme Robotics, Inc.'), 'Acme Robotics')).toBe(true);
    expect(hiringOrgMatches(node('Acme'), 'Acme Robotics')).toBe(true);
    expect(hiringOrgMatches(node('Globex Shipping LLC'), 'Acme Robotics')).toBe(false);
    expect(hiringOrgMatches({}, 'Acme Robotics')).toBe(true);
    expect(hiringOrgMatches(node('Globex'), null)).toBe(true);
  });

  it('never matches on a stop word or a common industry word alone', () => {
    const node = (name: string) => ({ hiringOrganization: { name } });
    expect(hiringOrgMatches(node('The Other Corp'), 'The Acme Co')).toBe(false);
    expect(hiringOrgMatches(node('Beta AI'), 'Acme AI')).toBe(false);
    expect(hiringOrgMatches(node('Globex Robotics Group'), 'Acme Robotics')).toBe(false);
    expect(hiringOrgMatches(node('Acme Health Capital'), 'Beta Health Capital')).toBe(false);
    // The company's own names still match.
    expect(hiringOrgMatches(node('The Acme Company'), 'The Acme Co')).toBe(true);
    expect(hiringOrgMatches(node('Acme AI, Inc.'), 'Acme AI')).toBe(true);
    expect(hiringOrgMatches(node('Acme'), 'Acme Robotics Group')).toBe(true);
    // A name made only of common words is compared as it is.
    expect(hiringOrgMatches(node('AI Health'), 'AI Health')).toBe(true);
  });

  it('leaves out roles naming no company on a page that lists other companies', () => {
    const role = (id: string, org?: string) => ({
      '@type': 'JobPosting',
      title: `Role ${id}`,
      identifier: id,
      url: `${PAGE_URL}/${id}`,
      ...(org ? { hiringOrganization: { name: org } } : {}),
    });
    const mixed = read(
      page(
        role('a', 'Acme Robotics'),
        role('b', 'Globex AI'),
        role('d', 'Initech Health'),
        role('c'),
      ),
    );
    expect(mixed.postings.map((p) => p.externalId)).toEqual(['a']);
    expect(mixed.skipped).toBe(3);
    // More of another company's roles than the company's own: the same.
    const theirs = read(page(role('b', 'Globex AI'), role('e', 'Globex AI'), role('c')));
    expect(theirs.postings).toEqual([]);
    // On the company's own page, a role naming no one is still read.
    const own = read(page(role('a', 'Acme Robotics'), role('b', 'Globex AI'), role('c')));
    expect(own.postings.map((p) => p.externalId)).toEqual(['a', 'c']);
  });
});

describe('roles with no identifier of their own', () => {
  it('keep one key when the link gains tracking parameters, a fragment or a trailing slash', () => {
    const keyOf = (url: string) =>
      read(page({ '@type': 'JobPosting', title: 'Field Technician', url })).postings[0]!.externalId;
    const base = keyOf('https://acme-robotics.example.com/careers/field-tech');
    for (const url of [
      'https://acme-robotics.example.com/careers/field-tech?utm_source=board&gh_src=x1',
      'https://acme-robotics.example.com/careers/field-tech/?session=abc123#apply',
      'http://www.Acme-Robotics.example.com/careers/field-tech',
    ]) {
      expect(keyOf(url), url).toBe(base);
    }
    expect(keyOf('https://acme-robotics.example.com/careers/other-role')).not.toBe(base);
  });
});

describe('careers page source keys', () => {
  it('keys roles by host and id, and marks them as careers-page roles', () => {
    const key = pageSourceKey('https://www.acme-robotics.example.com/careers', {
      externalId: 'ENG-1',
    });
    expect(key).toBe('page:acme-robotics.example.com:ENG-1');
    expect(isCareersPageRole({ source: 'ats', source_key: key })).toBe(true);
    expect(isCareersPageRole({ source: 'ats', source_key: 'greenhouse:acme:1' })).toBe(false);
    expect(isCareersPageRole({ source: 'manual', source_key: key })).toBe(false);
  });
});

describe('linkedInJobsUrl', () => {
  it('derives the jobs tab from a LinkedIn company address', () => {
    const jobs = 'https://www.linkedin.com/company/acme-robotics/jobs/';
    for (const raw of [
      'https://www.linkedin.com/company/acme-robotics',
      'linkedin.com/company/acme-robotics/',
      'http://uk.linkedin.com/company/Acme-Robotics/about/?trk=x',
      'https://www.linkedin.com/company/acme-robotics/jobs/',
      '  https://linkedin.com/company/acme-robotics  ',
    ]) {
      expect(linkedInJobsUrl(raw)).toBe(jobs);
    }
    expect(isLinkedInJobsUrl(jobs)).toBe(true);
  });

  it('refuses anything that is not a LinkedIn company page', () => {
    for (const raw of [
      null,
      '',
      'https://www.linkedin.com/in/pat-example',
      'https://www.linkedin.com/jobs/view/123',
      'https://www.linkedin.com/company/',
      'https://linkedin.com.evil.example/company/acme',
      'https://evil.example/www.linkedin.com/company/acme',
      'javascript://www.linkedin.com/company/acme',
      'https://user:pw@www.linkedin.com/company/acme',
      'https://www.linkedin.com:8443/company/acme',
      'https://www.linkedin.com/company/acme%22onmouseover',
      'https://www.linkedin.com/company/<script>',
    ]) {
      expect(linkedInJobsUrl(raw)).toBeNull();
    }
    expect(isLinkedInJobsUrl('https://www.linkedin.com/company/acme')).toBe(false);
  });
});
