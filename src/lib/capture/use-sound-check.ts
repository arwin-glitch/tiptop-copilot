'use client';

import * as React from 'react';
import { SoundCheck, type SoundCheckSnapshot, type SoundCheckSource } from './sound-check';

/**
 * The sound check as a hook (D-076): local meters for the microphone and the
 * meeting audio, nothing sent anywhere. Leaving the page lets go of both.
 */
export function useSoundCheck(): {
  state: SoundCheckSnapshot;
  test: (source: SoundCheckSource) => Promise<void>;
  end: (source: SoundCheckSource) => void;
} {
  const [check] = React.useState(() => new SoundCheck());
  React.useEffect(() => () => void check.dispose(), [check]);
  const state = React.useSyncExternalStore(
    check.subscribe,
    check.getSnapshot,
    check.getServerSnapshot,
  );
  return React.useMemo(
    () => ({
      state,
      test: (source: SoundCheckSource) => check.test(source),
      end: (source: SoundCheckSource) => check.end(source),
    }),
    [check, state],
  );
}
