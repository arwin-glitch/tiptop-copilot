import type { BlockDefinition, BlockRegistry } from '@/lib/events/contracts';
import { BLOCK_TYPES, BLOCK_VARIANTS, type BlockType } from '@/lib/events/schema';
import { validateThemeEffects } from '@/lib/events/theme/effects';
import { BLOCK_DEFINITIONS, OWNER_ONLY_PROPS } from './definitions';
import { BLOCK_PROPS } from './props';

/**
 * The block registry (D-075, WS2). Export kept from the contract:
 * `blockRegistry` (BlockRegistry in lib/events/contracts.ts).
 *
 * WS1's ops service and publish validate every write through
 * validateProps / validateTheme / isOwnerOnlyProp; Studio builds its
 * inspector from `fields`. Pure: no React here, so the server's validation
 * path never loads a component.
 */

function zodMessages(error: { issues: { path: PropertyKey[]; message: string }[] }): string[] {
  return error.issues.slice(0, 20).map((issue) => {
    const path = issue.path.map(String).join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}

export const blockRegistry: BlockRegistry = {
  get: (type) => BLOCK_DEFINITIONS[type],
  list: () => BLOCK_TYPES.map((type) => BLOCK_DEFINITIONS[type]),
  validateProps(type, variant, props) {
    const issues: string[] = [];
    const variants = BLOCK_VARIANTS[type] as readonly string[] | undefined;
    if (!variants) return [`"${String(type)}" is not a block.`];
    if (!variants.includes(variant)) issues.push(`"${variant}" is not a ${type} layout.`);
    const schema = BLOCK_PROPS[type];
    const parsed = schema.safeParse(props);
    if (!parsed.success) issues.push(...zodMessages(parsed.error));
    return issues;
  },
  isOwnerOnlyProp(type, key) {
    return OWNER_ONLY_PROPS[type]?.includes(key) ?? false;
  },
  validateTheme: (theme) => validateThemeEffects(theme),
};

/** The definition for a type (always present for a schema BlockType). */
export function blockDefinition(type: BlockType): BlockDefinition {
  return BLOCK_DEFINITIONS[type];
}

/** Blocks Studio's gallery offers first (v1 must), then the v1-nice ones. */
export const CORE_BLOCKS: readonly BlockType[] = [
  'hero',
  'details',
  'rsvp',
  'agenda',
  'text',
  'hosts',
  'sponsors',
  'venue',
  'countdown',
  'faq',
  'gallery',
  'media',
  'stats',
  'materials',
  'buttons',
  'divider',
  'footer',
];
export const EXTRA_BLOCKS: readonly BlockType[] = [
  'embed',
  'guest_wall',
  'join_remote',
  'info_cards',
];

export { BLOCK_PROPS } from './props';
export { BLOCK_DEFINITIONS, OWNER_ONLY_PROPS } from './definitions';
