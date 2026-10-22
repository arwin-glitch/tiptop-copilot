'use client';

import {
  Dithering,
  GodRays,
  GrainGradient,
  MeshGradient,
  Metaballs,
  SmokeRing,
  Swirl,
  Warp,
  Waves,
} from '@paper-design/shaders-react';
import type { CSSProperties } from 'react';
import {
  DITHER_SHAPES,
  DITHER_TYPES,
  GRAIN_SHAPES,
  MESH_VARIANTS,
  enumOption,
  numOption,
} from '@/lib/events/theme/effects';

/**
 * Our engine interface over Paper's shaders (pinned 0.0.81, a 0.0.x API:
 * nothing outside this file imports the package). Loaded only by the shader
 * island, only on pages whose theme uses a WebGL engine.
 */

export type ShaderEngine = 'mesh' | 'grain' | 'dither' | 'waves' | 'smoke' | 'god_rays';

export interface ShaderProps {
  engine: ShaderEngine;
  colors: string[];
  options: Record<string, unknown>;
  /** Final animation speed (0 renders one still frame and stops). */
  speed: number;
  /** Zoom of the pattern (theme background.scale). */
  scale: number;
  /** DPR cap as a pixel budget for the canvas. */
  maxPixelCount: number;
  style?: CSSProperties;
}

export function ShaderEngineView({
  engine,
  colors,
  options,
  speed,
  scale,
  maxPixelCount,
  style,
}: ShaderProps) {
  const back = colors[0] ?? '#000000';
  const rest = colors.length > 1 ? colors.slice(1) : [back];
  const common = {
    style: { position: 'absolute', inset: 0, ...style } as CSSProperties,
    minPixelRatio: 1,
    maxPixelCount,
    fit: 'cover' as const,
    scale,
    speed,
  };
  switch (engine) {
    case 'mesh': {
      const variant = enumOption(options, 'variant', MESH_VARIANTS, 'mesh');
      if (variant === 'metaballs') {
        return <Metaballs {...common} colorBack={back} colors={rest} count={9} size={0.82} />;
      }
      if (variant === 'warp') {
        return (
          <Warp
            {...common}
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
          <Swirl
            {...common}
            colorBack={back}
            colors={rest}
            bandCount={4}
            twist={0.3}
            softness={0.8}
          />
        );
      }
      return (
        <MeshGradient
          {...common}
          colors={colors}
          distortion={numOption(options, 'distortion', 0.6)}
          swirl={numOption(options, 'swirl', 0.1)}
          grainOverlay={numOption(options, 'grain', 0)}
          grainMixer={numOption(options, 'grain', 0) * 0.5}
        />
      );
    }
    case 'grain':
      return (
        <GrainGradient
          {...common}
          colorBack={back}
          colors={rest}
          softness={numOption(options, 'softness', 0.6)}
          intensity={0.4}
          noise={numOption(options, 'noise', 0.2)}
          shape={enumOption(options, 'shape', GRAIN_SHAPES, 'corners')}
        />
      );
    case 'dither':
      return (
        <Dithering
          {...common}
          colorBack={back}
          colorFront={rest[0] ?? '#000000'}
          shape={enumOption(options, 'shape', DITHER_SHAPES, 'warp')}
          type={enumOption(options, 'type', DITHER_TYPES, '4x4')}
          size={numOption(options, 'size', 2)}
        />
      );
    case 'waves':
      return (
        <Waves
          style={common.style}
          minPixelRatio={1}
          maxPixelCount={maxPixelCount}
          fit="cover"
          scale={scale}
          colorBack={back}
          colorFront={rest[0] ?? '#000000'}
          frequency={numOption(options, 'frequency', 0.5)}
          amplitude={numOption(options, 'amplitude', 0.5)}
          spacing={numOption(options, 'spacing', 1)}
          rotation={numOption(options, 'rotation', 0)}
          proportion={0.1}
          softness={0}
        />
      );
    case 'smoke':
      return (
        <SmokeRing
          {...common}
          colorBack={back}
          colors={rest}
          thickness={numOption(options, 'thickness', 0.6)}
          radius={numOption(options, 'radius', 0.3)}
          noiseScale={numOption(options, 'noiseScale', 3)}
        />
      );
    case 'god_rays':
      return (
        <GodRays
          {...common}
          colorBack={back}
          colors={rest}
          colorBloom={rest[0] ?? '#FFFFFF'}
          density={numOption(options, 'density', 0.3)}
          spotty={numOption(options, 'spotty', 0.3)}
          bloom={numOption(options, 'bloom', 0.4)}
          midSize={numOption(options, 'midSize', 0.2)}
          midIntensity={0.4}
          intensity={0.8}
        />
      );
  }
}
