'use client';

import { Waves } from '@paper-design/shaders-react';
import { numOption } from '@/lib/events/theme/effects';
import { sizing, split, type ShaderProps } from './common';

/** Waves is a still pattern in Paper (no speed); motion comes from the page around it. */
export default function WavesEngine(props: ShaderProps) {
  const { back, rest } = split(props.colors);
  return (
    <Waves
      {...sizing(props)}
      colorBack={back}
      colorFront={rest[0] ?? '#000000'}
      frequency={numOption(props.options, 'frequency', 0.5)}
      amplitude={numOption(props.options, 'amplitude', 0.5)}
      spacing={numOption(props.options, 'spacing', 1)}
      rotation={numOption(props.options, 'rotation', 0)}
      proportion={0.1}
      softness={0}
    />
  );
}
