'use client';

import { MeshGradient, Metaballs, Swirl, Warp } from '@paper-design/shaders-react';
import { MESH_VARIANTS, enumOption, numOption } from '@/lib/events/theme/effects';
import { sizing, split, type ShaderProps } from './common';

/** The mesh engine and its variants: mesh gradient, metaballs, warp, swirl. */
export default function MeshEngine(props: ShaderProps) {
  const { colors, options, speed } = props;
  const { back, rest } = split(colors);
  const base = { ...sizing(props), speed };
  const variant = enumOption(options, 'variant', MESH_VARIANTS, 'mesh');
  if (variant === 'metaballs') {
    return <Metaballs {...base} colorBack={back} colors={rest} count={9} size={0.82} />;
  }
  if (variant === 'warp') {
    return (
      <Warp
        {...base}
        colors={colors}
        distortion={numOption(options, 'distortion', 0.3)}
        swirl={numOption(options, 'swirl', 0.8)}
        proportion={0.45}
        softness={1}
        shape="edge"
      />
    );
  }
  if (variant === 'swirl') {
    return (
      <Swirl {...base} colorBack={back} colors={rest} bandCount={4} twist={0.3} softness={0.8} />
    );
  }
  return (
    <MeshGradient
      {...base}
      colors={colors}
      distortion={numOption(options, 'distortion', 0.6)}
      swirl={numOption(options, 'swirl', 0.1)}
      grainOverlay={numOption(options, 'grain', 0)}
      grainMixer={numOption(options, 'grain', 0) * 0.5}
    />
  );
}
