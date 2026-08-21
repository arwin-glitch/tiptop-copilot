#!/usr/bin/env node
/**
 * Export every Granola note to markdown files.
 *
 * A local, readable copy of the meeting record — for backup, for Obsidian, for
 * anywhere that is not a database. One file per meeting, named by date and
 * title so a directory listing is already a chronology, with YAML frontmatter
 * that Obsidian and most note tools read natively.
 *
 * Writes to `.granola-export/`, which is gitignored. That is not a detail:
 * this repository is public, and these notes contain real conversations with
 * founders, LPs and co-investors. The directory is refused if it is ever not
 * ignored, so a change to .gitignore cannot quietly turn an export into a leak.
 *
 * Usage:
 *   GRANOLA_API_KEY=grn_… node scripts/granola-export.mjs
 *   GRANOLA_API_KEY=grn_… node scripts/granola-export.mjs --limit 50
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const OUT_DIR = path.resolve(process.cwd(), '.granola-export');
const API = 'https://public-api.granola.ai/v1';

/* ------------------------------------------------------------- formatting */

/** A filesystem-safe name that still reads as the meeting it came from. */
export function fileNameFor(note) {
  const date = (note.calendar_event?.scheduled_start_time ?? note.created_at ?? '').slice(0, 10);
  const title = (note.title ?? note.calendar_event?.event_title ?? 'Untitled meeting')
    .replace(/[\\/:*?"<>|]/g, '-') // characters Windows forbids outright
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${date || 'undated'}_${title}.md`.replace(/\s/g, '_');
}

/** Escapes a value for a YAML double-quoted scalar. */
function yaml(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function toMarkdown(note) {
  const attendees = [...(note.attendees ?? []), ...(note.calendar_event?.invitees ?? [])].filter(
    (a) => a?.email,
  );

  const seen = new Set();
  const unique = attendees.filter((a) => {
    const key = a.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const front = [
    '---',
    `title: ${yaml(note.title ?? note.calendar_event?.event_title ?? 'Untitled meeting')}`,
    `date: ${yaml(note.calendar_event?.scheduled_start_time ?? note.created_at ?? '')}`,
    `granola_id: ${yaml(note.id)}`,
    note.web_url ? `url: ${yaml(note.web_url)}` : null,
    note.owner?.email ? `owner: ${yaml(note.owner.email)}` : null,
    'attendees:',
    ...unique.map((a) => `  - ${yaml(a.name ? `${a.name} <${a.email}>` : a.email)}`),
    '---',
    '',
  ].filter((line) => line !== null);

  const body = note.summary_markdown ?? note.summary_text ?? '_No summary._';
  return `${front.join('\n')}${body}\n`;
}

/* ------------------------------------------------------------------ fetch */

async function api(pathname, apiKey) {
  const response = await fetch(`${API}${pathname}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Granola rejected the API key.');
  }
  if (!response.ok) throw new Error(`Granola answered ${response.status} for ${pathname}`);
  return response.json();
}

/** Refuses to write unless git is genuinely ignoring the destination. */
function assertIgnored() {
  try {
    execFileSync('git', ['check-ignore', '-q', '.granola-export'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      '.granola-export is not gitignored, and this repository is public. ' +
        'Add ".granola-export/" to .gitignore before exporting real notes.',
    );
  }
}

async function main() {
  const apiKey = process.env.GRANOLA_API_KEY;
  if (!apiKey) {
    console.error('Set GRANOLA_API_KEY to your Granola API key.');
    process.exitCode = 1;
    return;
  }

  try {
    assertIgnored();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg !== -1 ? Number.parseInt(process.argv[limitArg + 1] ?? '0', 10) : Infinity;

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  let cursor = null;
  let written = 0;
  let failed = 0;
  const seenNames = new Map();

  console.log(`Exporting to ${OUT_DIR}\n`);

  for (;;) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const page = await api(`/notes${query}`, apiKey);
    const ids = (page.notes ?? []).map((n) => n.id);

    for (const id of ids) {
      if (written >= limit) break;
      let note;
      try {
        note = await api(`/notes/${encodeURIComponent(id)}`, apiKey);
      } catch {
        failed++;
        continue;
      }

      let name = fileNameFor(note);
      // Two meetings can share a day and a title; keep both rather than
      // silently overwriting the earlier one.
      const count = seenNames.get(name) ?? 0;
      seenNames.set(name, count + 1);
      if (count > 0) name = name.replace(/\.md$/, `_${count + 1}.md`);

      writeFileSync(path.join(OUT_DIR, name), toMarkdown(note), 'utf8');
      written++;
      if (written % 25 === 0) console.log(`  ${written} exported…`);
    }

    if (written >= limit || !page.hasMore) break;
    cursor = page.cursor;
    if (!cursor) break;
  }

  console.log(`\nDone. ${written} notes written${failed ? `, ${failed} unreadable` : ''}.`);
  console.log('These are real, private notes. The folder is gitignored — copy it somewhere safe.');
}

if (process.argv[1]?.endsWith('granola-export.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
