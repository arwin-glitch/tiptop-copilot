import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_INSTALLERS, DESKTOP_UPDATE_FILES } from '@/lib/desktop/shared';

/**
 * The download and update routes ask GitHub for these exact file names, and
 * the release workflow is what publishes them. If the two ever disagree, every
 * download and in-app update 404s while the rest of the tests stay green.
 */
const WORKFLOW = readFileSync(join(process.cwd(), '.github/workflows/desktop.yml'), 'utf8');

describe('desktop asset names', () => {
  it('match the files the release workflow publishes', () => {
    const names = [...Object.values(DESKTOP_INSTALLERS), ...Object.values(DESKTOP_UPDATE_FILES)];
    for (const name of names) {
      expect(WORKFLOW, `${name} is not published by desktop.yml`).toContain(`out/${name}`);
    }
  });
});
