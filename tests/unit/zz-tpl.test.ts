import { it } from 'vitest';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
const D = 'C:/Users/TFIVE/AppData/Local/Temp/claude/E--/c0af71ea-671c-4078-a66a-d085194360e8/scratchpad/tpl/';
it('tpl', async () => {
  const b = await chromium.launch();
  for (const n of (process.env.PAGES ?? 'brief').split(',')) {
    const p = await b.newPage({ viewport: { width: 900, height: 1000 }, deviceScaleFactor: 1.5 });
    await p.goto(pathToFileURL(D + n + '.html').href, { waitUntil: 'networkidle' });
    await p.screenshot({ path: D + n + '-screen.png', fullPage: true });
    await p.emulateMedia({ media: 'print' });
    await p.pdf({ path: D + n + '.pdf', format: 'Letter', printBackground: true, preferCSSPageSize: true });
  }
  await b.close();
}, 90000);
