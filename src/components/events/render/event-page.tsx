import type { EventPageProps } from '@/lib/events/contracts';
import { renderRichText } from '@/lib/events/richtext';
import { orderedSections, type EventSection } from '@/lib/events/schema';
import { RsvpSlot } from '@/components/events/rsvp/rsvp-slot';

/**
 * CONTRACT STUB — owned by WS2 (Design system). Replace the body, keep the
 * export: `EventPage` (props: EventPageProps in lib/events/contracts.ts).
 *
 * A plain, safe fallback renderer so WS3 (Studio canvas) and WS4 (public
 * route) can mount the real component's contract before it lands. It keeps
 * the DOM contract — data-event-root + id="main" on the root,
 * data-section-id / data-block on each section, data-field on inline text in
 * studio mode — and renders every string as React text (never HTML).
 *
 * Isomorphic: no hooks, no server-only imports, so both a server page and
 * Studio's client canvas can render it.
 */

function text(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  return typeof value === 'string' ? value : '';
}

function SectionBody({
  section,
  title,
  rsvp,
  mode,
}: {
  section: EventSection;
  title: string;
  rsvp: EventPageProps['rsvp'];
  mode: EventPageProps['mode'];
}) {
  const props = section.props as Record<string, unknown>;
  const field = (key: string) => (mode === 'studio' ? { 'data-field': `props.${key}` } : {});
  switch (section.type) {
    case 'hero':
      return (
        <header>
          <h1 {...field('headline')}>{text(props, 'headline') || title}</h1>
          {text(props, 'subheadline') ? (
            <p {...field('subheadline')}>{text(props, 'subheadline')}</p>
          ) : null}
        </header>
      );
    case 'rsvp':
      return (
        <RsvpSlot
          variant={
            (['inline', 'sheet', 'sticky', 'corner'] as const).find((v) => v === section.variant) ??
            'inline'
          }
          labels={{
            cta: text(props, 'cta'),
            going: text(props, 'going'),
            maybe: text(props, 'maybe'),
            notGoing: text(props, 'notGoing'),
          }}
          mode={mode}
          context={rsvp}
        />
      );
    default: {
      const heading = text(props, 'heading') || text(props, 'title');
      const body = text(props, 'body');
      return (
        <div>
          {heading ? <h2 {...field(props.heading ? 'heading' : 'title')}>{heading}</h2> : null}
          {body ? renderRichText(body) : null}
        </div>
      );
    }
  }
}

export function EventPage({ doc, facts, mode, rsvp, selectedSectionId }: EventPageProps) {
  return (
    <main id="main" data-event-root data-mode={mode}>
      {orderedSections(doc.sections).map((section) => (
        <section
          key={section.id}
          data-section-id={section.id}
          data-block={section.type}
          data-selected={selectedSectionId === section.id ? 'true' : undefined}
        >
          <SectionBody section={section} title={facts.title} rsvp={rsvp} mode={mode} />
        </section>
      ))}
    </main>
  );
}
