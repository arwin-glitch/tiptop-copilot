import { createJiti } from 'jiti';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const jiti = createJiti(import.meta.url, { alias: { '@': path.join(root, 'src') } });
const { fontFaceCss } = await jiti.import(path.join(root, 'src/lib/events/fonts.ts'));
const header = `/*
 * Self-hosted event fonts (D-075). GENERATED from src/lib/events/fonts.ts:
 * edit the table there, then regenerate (see tests/unit/events-fonts.test.ts,
 * which fails while this file and the table disagree). Browsers download a
 * face only when an element on the page uses it.
 */
`;
writeFileSync(
  path.join(root, 'src/components/events/render/event-fonts.css'),
  header + fontFaceCss() + '\n',
);
console.log('ok');
