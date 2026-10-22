#!/usr/bin/env node
/**
 * Fetch the Events font library (D-075) into the repo, once, so event pages
 * self-host every font (the /e CSP allows font-src 'self' only, and guests'
 * browsers never call a font CDN).
 *
 *   node scripts/events/fetch-fonts.mjs          # download what is missing
 *   node scripts/events/fetch-fonts.mjs --force  # re-download everything
 *
 * Source: the Fontsource packages on the npm registry, read through the
 * jsDelivr npm mirror (OFL-1.1 / Apache-2.0 families, Latin subset only).
 *
 *   public/event-fonts/<id>/…woff2   what guests download (variable where the
 *                                    family has a wght axis, else static cuts)
 *   assets/og-fonts/<id>-<w>.woff    static WOFF cuts for the share card:
 *                                    next/og (Satori) reads TTF/OTF/WOFF, not
 *                                    WOFF2, and no variable fonts
 *
 * src/lib/events/fonts.ts names the same files; tests/unit/events-fonts.test.ts
 * fails when the two disagree. Add a family here, in schema.ts FONT_IDS and in
 * fonts.ts in the same change.
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const VERSION = '5.3.0';
const ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
  '..',
);
const WEB_DIR = path.join(ROOT, 'public', 'event-fonts');
const OG_DIR = path.join(ROOT, 'assets', 'og-fonts');
const force = process.argv.includes('--force');

/**
 * id → what to fetch.
 *   v: variable axis file stem for the web ('wght', 'full', …); null: static
 *   vi: also the italic variable file
 *   w: static web weights (when v is null), wi: static italic weights
 *   og: static weights for the share card
 */
export const FONT_FILES = {
  anton: { v: null, w: [400], og: [400] },
  archivo: { v: 'wght', og: [400, 700] },
  audiowide: { v: null, w: [400], og: [400] },
  'bagel-fat-one': { v: null, w: [400], og: [400] },
  'big-shoulders-display': { v: 'wght', og: [400, 700] },
  'bodoni-moda': { v: 'wght', vi: true, og: [400, 700] },
  'bricolage-grotesque': { v: 'wght', og: [400, 700] },
  caveat: { v: 'wght', og: [400, 700] },
  'cormorant-garamond': { v: 'wght', vi: true, og: [400, 600] },
  'dm-sans': { v: 'wght', og: [400, 700] },
  'dm-serif-display': { v: null, w: [400], wi: [400], og: [400] },
  'eb-garamond': { v: 'wght', vi: true, og: [400, 600] },
  figtree: { v: 'wght', og: [400, 700] },
  fraunces: { v: 'wght', vi: true, og: [400, 700] },
  fredoka: { v: 'wght', og: [400, 600] },
  geist: { v: 'wght', og: [400, 600] },
  'geist-mono': { v: 'wght', og: [400, 600] },
  gloock: { v: null, w: [400], og: [400] },
  'hanken-grotesk': { v: 'wght', og: [400, 700] },
  'ibm-plex-mono': { v: null, w: [400, 600], og: [400, 600] },
  'ibm-plex-sans-condensed': { v: null, w: [400, 600, 700], og: [400, 600] },
  'instrument-sans': { v: 'wght', og: [400, 600] },
  'instrument-serif': { v: null, w: [400], wi: [400], og: [400] },
  inter: { v: 'wght', vi: true, og: [400, 600] },
  'inter-tight': { v: 'wght', og: [400, 700] },
  italiana: { v: null, w: [400], og: [400] },
  'jetbrains-mono': { v: 'wght', og: [400, 700] },
  'josefin-sans': { v: 'wght', og: [400, 600] },
  jost: { v: 'wght', og: [400, 600] },
  karla: { v: 'wght', og: [400, 700] },
  'libre-caslon-display': { v: null, w: [400], og: [400] },
  'libre-franklin': { v: 'wght', og: [400, 700] },
  manrope: { v: 'wght', og: [400, 700] },
  monoton: { v: null, w: [400], og: [400] },
  mulish: { v: 'wght', og: [400, 700] },
  outfit: { v: 'wght', og: [400, 600] },
  'pinyon-script': { v: null, w: [400], og: [400] },
  'playfair-display': { v: 'wght', vi: true, og: [400, 700] },
  'plus-jakarta-sans': { v: 'wght', og: [400, 700] },
  'poiret-one': { v: null, w: [400], og: [400] },
  'roboto-flex': { v: 'wght', og: [400] },
  rye: { v: null, w: [400], og: [400] },
  shrikhand: { v: null, w: [400], og: [400] },
  silkscreen: { v: null, w: [400, 700], og: [400] },
  'space-grotesk': { v: 'wght', og: [400, 700] },
  'space-mono': { v: null, w: [400, 700], og: [400, 700] },
  syne: { v: 'wght', og: [400, 700] },
  'tilt-neon': { v: 'full', og: [400] },
  unbounded: { v: 'wght', og: [400, 700] },
  vt323: { v: null, w: [400], og: [400] },
  'work-sans': { v: 'wght', og: [400, 600] },
  'young-serif': { v: null, w: [400], og: [400] },
  'zilla-slab': { v: null, w: [400, 600, 700], og: [400, 700] },
};

const cdn = (pkg, file) => `https://cdn.jsdelivr.net/npm/${pkg}@${VERSION}/${file}`;

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function fetchTo(url, dest) {
  if (!force && (await exists(dest))) return 'kept';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  return 'fetched';
}

async function main() {
  let fetched = 0;
  for (const [id, spec] of Object.entries(FONT_FILES)) {
    const jobs = [];
    if (spec.v) {
      const pkg = `@fontsource-variable/${id}`;
      jobs.push([
        cdn(pkg, `files/${id}-latin-${spec.v}-normal.woff2`),
        path.join(WEB_DIR, id, `${id}-${spec.v}-normal.woff2`),
      ]);
      if (spec.vi)
        jobs.push([
          cdn(pkg, `files/${id}-latin-${spec.v}-italic.woff2`),
          path.join(WEB_DIR, id, `${id}-${spec.v}-italic.woff2`),
        ]);
      jobs.push([cdn(pkg, 'LICENSE'), path.join(WEB_DIR, id, 'LICENSE.txt')]);
    } else {
      const pkg = `@fontsource/${id}`;
      for (const w of spec.w ?? [])
        jobs.push([
          cdn(pkg, `files/${id}-latin-${w}-normal.woff2`),
          path.join(WEB_DIR, id, `${id}-${w}-normal.woff2`),
        ]);
      for (const w of spec.wi ?? [])
        jobs.push([
          cdn(pkg, `files/${id}-latin-${w}-italic.woff2`),
          path.join(WEB_DIR, id, `${id}-${w}-italic.woff2`),
        ]);
      jobs.push([cdn(pkg, 'LICENSE'), path.join(WEB_DIR, id, 'LICENSE.txt')]);
    }
    for (const w of spec.og)
      jobs.push([
        cdn(`@fontsource/${id}`, `files/${id}-latin-${w}-normal.woff`),
        path.join(OG_DIR, `${id}-${w}.woff`),
      ]);
    const results = await Promise.all(jobs.map(([url, dest]) => fetchTo(url, dest)));
    fetched += results.filter((r) => r === 'fetched').length;
  }
  console.log(
    `event fonts: ${fetched} file(s) fetched, ${Object.keys(FONT_FILES).length} families`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
