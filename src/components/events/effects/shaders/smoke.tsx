'use client';

import { SmokeRing } from '@paper-design/shaders-react';
import { numOption } from '@/lib/events/theme/effects';
import { sizing, split, type ShaderProps } from './common';

export default function SmokeEngine(props: ShaderProps) {
  const { back, rest } = split(props.colors);
  return (
    <SmokeRing
      {...sizing(props)}
      speed={props.speed}
      colorBack={back}
      colors={rest}
      thickness={numOption(props.options, 'thickness', 0.6)}
      radius={numOption(props.options, 'radius', 0.3)}
      noiseScale={numOption(props.options, 'noiseScale', 3)}
    />
  );
}
