'use client';

import { GodRays } from '@paper-design/shaders-react';
import { numOption } from '@/lib/events/theme/effects';
import { sizing, split, type ShaderProps } from './common';

export default function GodRaysEngine(props: ShaderProps) {
  const { back, rest } = split(props.colors);
  return (
    <GodRays
      {...sizing(props)}
      speed={props.speed}
      colorBack={back}
      colors={rest}
      colorBloom={rest[0] ?? '#FFFFFF'}
      density={numOption(props.options, 'density', 0.3)}
      spotty={numOption(props.options, 'spotty', 0.3)}
      bloom={numOption(props.options, 'bloom', 0.4)}
      midSize={numOption(props.options, 'midSize', 0.2)}
      midIntensity={0.4}
      intensity={0.8}
    />
  );
}
