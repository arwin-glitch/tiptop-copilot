'use client';

import { GrainGradient } from '@paper-design/shaders-react';
import { GRAIN_SHAPES, enumOption, numOption } from '@/lib/events/theme/effects';
import { sizing, split, type ShaderProps } from './common';

export default function GrainEngine(props: ShaderProps) {
  const { back, rest } = split(props.colors);
  return (
    <GrainGradient
      {...sizing(props)}
      speed={props.speed}
      colorBack={back}
      colors={rest}
      softness={numOption(props.options, 'softness', 0.6)}
      intensity={0.4}
      noise={numOption(props.options, 'noise', 0.2)}
      shape={enumOption(props.options, 'shape', GRAIN_SHAPES, 'corners')}
    />
  );
}
