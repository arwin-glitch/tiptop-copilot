'use client';

import { Dithering } from '@paper-design/shaders-react';
import { DITHER_SHAPES, DITHER_TYPES, enumOption, numOption } from '@/lib/events/theme/effects';
import { sizing, split, type ShaderProps } from './common';

export default function DitherEngine(props: ShaderProps) {
  const { back, rest } = split(props.colors);
  return (
    <Dithering
      {...sizing(props)}
      speed={props.speed}
      colorBack={back}
      colorFront={rest[0] ?? '#000000'}
      shape={enumOption(props.options, 'shape', DITHER_SHAPES, 'warp')}
      type={enumOption(props.options, 'type', DITHER_TYPES, '4x4')}
      size={numOption(props.options, 'size', 2)}
    />
  );
}
