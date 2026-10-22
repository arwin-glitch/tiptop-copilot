import type { ThemePreset, ThemeVibe } from '@/lib/events/contracts';
import type { BlockType } from '@/lib/events/schema';
import { CELEBRATION_PRESETS } from './celebration';
import type { DefinedPreset } from './define';
import { FORMAL_PRESETS, tiptopSignature } from './formal';
import { MODERN_PRESETS } from './modern';
import { WAVE2_PRESETS } from './wave2';

/**
 * The theme presets (D-075, WS2): 24 launch + 9 wave 2, all JSON over the
 * shared engines. Exports kept from the contract: THEME_PRESETS,
 * DEFAULT_THEME_PRESET_ID, getThemePreset.
 *
 * Order is gallery order: the AGM-critical presets first (TipTop
 * Signature, Annual Letter, Boardroom Noir, Envelope), then the rest of the
 * launch set, then wave 2.
 */

export const DEFAULT_THEME_PRESET_ID = 'tiptop-signature';

const ALL: readonly DefinedPreset[] = [
  ...FORMAL_PRESETS,
  ...MODERN_PRESETS,
  ...CELEBRATION_PRESETS,
  ...WAVE2_PRESETS,
];

export const THEME_PRESETS: readonly ThemePreset[] = ALL.map(
  ({ id, name, vibes, wave, description, theme }) => ({
    id,
    name,
    vibes,
    wave,
    description,
    theme,
  }),
);

export const LAUNCH_PRESETS = THEME_PRESETS.filter((p) => p.wave === 'launch');
export const WAVE2_THEME_PRESETS = THEME_PRESETS.filter((p) => p.wave === 'wave2');

export function getThemePreset(id: string | null | undefined): ThemePreset {
  return THEME_PRESETS.find((p) => p.id === id) ?? (THEME_PRESETS[0] as ThemePreset);
}

/** Whether an id names a shipped preset (a saved "My theme" keeps its base preset's id). */
export function isThemePresetId(id: string | null | undefined): boolean {
  return THEME_PRESETS.some((p) => p.id === id);
}

/** Presets for a gallery filter. */
export function presetsByVibe(vibe: ThemeVibe | null): readonly ThemePreset[] {
  return vibe ? THEME_PRESETS.filter((p) => p.vibes.includes(vibe)) : THEME_PRESETS;
}

/** The section layouts a preset looks best with: Studio offers them when the preset is applied. */
export function presetVariants(id: string): Partial<Record<BlockType, string>> {
  return ALL.find((p) => p.id === id)?.variants ?? tiptopSignature.variants;
}

export const THEME_VIBES: readonly { id: ThemeVibe; label: string }[] = [
  { id: 'formal', label: 'Formal' },
  { id: 'modern', label: 'Modern' },
  { id: 'playful', label: 'Playful' },
  { id: 'golf', label: 'Golf' },
  { id: 'night', label: 'Night' },
  { id: 'seasonal', label: 'Seasonal' },
];
