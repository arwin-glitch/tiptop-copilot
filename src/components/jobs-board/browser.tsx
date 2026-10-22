'use client';

import * as React from 'react';
import {
  EMPLOYMENT_TYPE_LABELS,
  JOB_FUNCTION_LABELS,
  JOB_REMOTE_LABELS,
  SENIORITY_LABELS,
} from '@/lib/jobs-board/fields';
import {
  EMPTY_FILTERS,
  boardFiltersToSearch,
  facetCounts,
  filterBoardJobs,
  hasFilters,
  parseBoardFilters,
  type BoardFilters,
  type Facet,
  type PublicCompany,
  type PublicJob,
} from '@/lib/jobs-board/public';
import { JobRow } from './parts';

/**
 * The board's search and filters, in the browser: the page arrives with
 * every role in its HTML (fast, and readable by search engines), and this
 * narrows it as you type or pick. The filters live in the address bar
 * (`?q=…&fn=engineering`), so a filtered board can be shared.
 */

const STEP = 60;
const FILTER_EVENT = 'jb-filters-change';

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  window.addEventListener(FILTER_EVENT, onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener(FILTER_EVENT, onChange);
  };
}
const readSearch = () => window.location.search;
const serverSearch = () => '';

function writeFilters(filters: BoardFilters) {
  const url = `${window.location.pathname}${boardFiltersToSearch(filters)}`;
  window.history.replaceState(window.history.state, '', url);
  window.dispatchEvent(new Event(FILTER_EVENT));
}

function Select<T extends string>({
  id,
  label,
  anyLabel,
  value,
  facets,
  onChange,
}: {
  id: string;
  label: string;
  anyLabel: string;
  value: T | null;
  facets: Facet<T>[];
  onChange: (value: T | null) => void;
}) {
  const options =
    value && !facets.some((f) => f.value === value)
      ? [...facets, { value, label: value, count: 0 }]
      : facets;
  return (
    <div className="jb-select">
      <label htmlFor={id} className="jb-sr">
        {label}
      </label>
      <select
        id={id}
        value={value ?? ''}
        className={value ? 'jb-on' : undefined}
        onChange={(e) => onChange((e.target.value || null) as T | null)}
      >
        <option value="">{anyLabel}</option>
        {options.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label} ({f.count})
          </option>
        ))}
      </select>
    </div>
  );
}

export function BoardBrowser({
  jobs,
  companies,
  base,
}: {
  jobs: PublicJob[];
  companies: PublicCompany[];
  base: string;
}) {
  const search = React.useSyncExternalStore(subscribe, readSearch, serverSearch);
  const filters = React.useMemo(
    () => (search ? parseBoardFilters(search) : EMPTY_FILTERS),
    [search],
  );
  const [shown, setShown] = React.useState(STEP);
  const companyBySlug = React.useMemo(
    () => new Map(companies.map((c) => [c.slug, c])),
    [companies],
  );

  const set = (patch: Partial<BoardFilters>) => {
    setShown(STEP);
    writeFilters({ ...filters, ...patch });
  };

  const visible = filterBoardJobs(jobs, filters);
  const facet = <K extends keyof BoardFilters>(key: K) => filterBoardJobs(jobs, filters, key);

  const companyFacets = facetCounts(
    facet('company'),
    (j) => [j.companySlug],
    (slug) => companyBySlug.get(slug)?.name ?? slug,
    100,
  ).sort((a, b) => a.label.localeCompare(b.label));
  const fnFacets = facetCounts(
    facet('fn'),
    (j) => [j.fn === 'other' ? null : j.fn],
    (v) => JOB_FUNCTION_LABELS[v],
  );
  const locationFacets = facetCounts(
    facet('location'),
    (j) => j.locations.filter((l) => !/^remote\b/i.test(l)),
    (v) => v,
    20,
  );
  const remoteFacets = facetCounts(
    facet('remote'),
    (j) => [j.remote],
    (v) => JOB_REMOTE_LABELS[v],
  );
  const levelFacets = facetCounts(
    facet('seniority'),
    (j) => [j.seniority],
    (v) => SENIORITY_LABELS[v],
  );
  const typeFacets = facetCounts(
    facet('type'),
    (j) => [j.employmentType],
    (v) => EMPLOYMENT_TYPE_LABELS[v],
  );
  const filtered = hasFilters(filters);

  return (
    <section className="jb-browser" aria-label="All open roles">
      <div className="jb-section-head">
        <h2 id="all-roles">All open roles</h2>
      </div>
      <div className="jb-search" role="search">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8" />
          <path
            d="m13.5 13.5 3.5 3.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
        <label htmlFor="jb-q" className="jb-sr">
          Search roles
        </label>
        <input
          id="jb-q"
          type="search"
          autoComplete="off"
          placeholder="Search title, company or place"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
        />
      </div>
      <div className="jb-filters">
        <Select
          id="jb-company"
          label="Company"
          anyLabel="All companies"
          value={filters.company}
          facets={companyFacets}
          onChange={(company) => set({ company })}
        />
        <Select
          id="jb-fn"
          label="Team"
          anyLabel="Any team"
          value={filters.fn}
          facets={fnFacets}
          onChange={(fn) => set({ fn })}
        />
        <Select
          id="jb-location"
          label="Location"
          anyLabel="Any location"
          value={filters.location}
          facets={locationFacets}
          onChange={(location) => set({ location })}
        />
        <Select
          id="jb-remote"
          label="Remote or on-site"
          anyLabel="Remote or on-site"
          value={filters.remote}
          facets={remoteFacets}
          onChange={(remote) => set({ remote })}
        />
        <Select
          id="jb-level"
          label="Level"
          anyLabel="Any level"
          value={filters.seniority}
          facets={levelFacets}
          onChange={(seniority) => set({ seniority })}
        />
        <Select
          id="jb-type"
          label="Job type"
          anyLabel="Any job type"
          value={filters.type}
          facets={typeFacets}
          onChange={(type) => set({ type })}
        />
      </div>

      <div className="jb-result-bar" aria-live="polite">
        <span>
          <strong>{visible.length}</strong> {visible.length === 1 ? 'role' : 'roles'}
          {filtered ? ` of ${jobs.length}` : ''}
        </span>
        {filtered ? (
          <button type="button" className="jb-link-btn" onClick={() => set(EMPTY_FILTERS)}>
            Clear filters
          </button>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <div className="jb-empty">
          <h3>No roles match</h3>
          <p>Try fewer filters, or a different word.</p>
          {filtered ? (
            <button
              type="button"
              className="jb-btn jb-btn-ghost jb-btn-small"
              onClick={() => set(EMPTY_FILTERS)}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="jb-jobs" aria-labelledby="all-roles">
            {visible.slice(0, shown).map((job) => (
              <li key={job.key}>
                <JobRow job={job} company={companyBySlug.get(job.companySlug)} base={base} />
              </li>
            ))}
          </ul>
          {visible.length > shown ? (
            <p style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                type="button"
                className="jb-btn jb-btn-ghost"
                onClick={() => setShown(shown + STEP)}
              >
                Show {Math.min(STEP, visible.length - shown)} more
              </button>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
