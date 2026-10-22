import type {
  EventPublicFacts,
  EventRenderMode,
  EventRsvpContext,
  EventViewer,
  MediaMap,
  MotionPreview,
} from '@/lib/events/contracts';
import type { EventDoc, EventSection, EventTheme } from '@/lib/events/schema';
import type { MotionLevel } from '@/lib/events/theme/motion';

/**
 * Everything a block view needs, built once per render by EventPage. Plain
 * data (no functions that close over request state), so a block can be a
 * server component on the live page and a client component in Studio.
 */
export interface RenderContext {
  doc: EventDoc;
  theme: EventTheme;
  facts: EventPublicFacts;
  media: MediaMap;
  viewer: EventViewer;
  mode: EventRenderMode;
  motion: MotionLevel;
  motionPreview: MotionPreview | undefined;
  rsvp: EventRsvpContext | null;
  /** Merge values for {{first_name}} etc. (null fields fall back). */
  merge: { first_name: string | null; name: string | null; company: string | null };
  /** Studio: inline-editable fields carry data-field. */
  studio: boolean;
  /** The first hero section id (it gets LCP priority and the hero background). */
  heroId: string | null;
}

export interface BlockViewProps {
  section: EventSection;
  ctx: RenderContext;
}

/** data-field for inline editing in Studio (contract: data-field="props.<key>"). */
export function fieldAttr(ctx: RenderContext, key: string): { 'data-field'?: string } {
  return ctx.studio ? { 'data-field': `props.${key}` } : {};
}
