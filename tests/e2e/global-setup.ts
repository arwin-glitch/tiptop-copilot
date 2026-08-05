import { rm } from 'node:fs/promises';
import path from 'node:path';

/**
 * Clear the e2e demo store before the run.
 *
 * The demo store is file-backed and survives between runs, so without this the
 * suite would inherit whatever the previous run left behind — and the steps
 * that assert a starting state ("this deal has not been analysed yet") would
 * pass once and then fail for ever. `DemoStore` reseeds from the fixtures when
 * the file is missing, so deleting it is the whole reset.
 */
export default async function globalSetup(): Promise<void> {
  const dir = path.resolve(process.cwd(), '.demo-data/e2e');
  await rm(dir, { recursive: true, force: true });
}
