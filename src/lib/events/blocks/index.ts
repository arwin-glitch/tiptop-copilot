import type { BlockDefinition, BlockRegistry } from '@/lib/events/contracts';
import { BLOCK_TYPES, BLOCK_VARIANTS, type BlockType } from '@/lib/events/schema';

/**
 * CONTRACT STUB — owned by WS2 (Design system). Replace the body, keep the
 * export: `blockRegistry` (shape: BlockRegistry in lib/events/contracts.ts).
 *
 * Until the real registry lands, every block type exists with no fields and
 * accepts any props that pass the schema's generic guards (bounded JSON,
 * allowed hrefs, media ids). WS1's ops service and publish already call
 * validateProps / validateTheme / isOwnerOnlyProp through this export, so
 * strict per-block validation switches on the moment WS2 fills it in.
 */

function label(type: BlockType): string {
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const definitions = new Map<BlockType, BlockDefinition>(
  BLOCK_TYPES.map((type) => [
    type,
    {
      type,
      label: label(type),
      description: '',
      variants: BLOCK_VARIANTS[type],
      defaults: () => ({ variant: BLOCK_VARIANTS[type][0], props: {} }),
      fields: [],
      summary: () => label(type),
    } satisfies BlockDefinition,
  ]),
);

export const blockRegistry: BlockRegistry = {
  get: (type) => definitions.get(type),
  list: () => [...definitions.values()],
  validateProps: () => [],
  isOwnerOnlyProp: () => false,
  validateTheme: () => [],
};
