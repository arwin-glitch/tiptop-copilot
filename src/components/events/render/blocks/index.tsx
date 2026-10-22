import type { BlockViewProps } from '../context';
import {
  AgendaView,
  ButtonsView,
  DividerView,
  FaqView,
  FooterView,
  StatsView,
  TextView,
} from './content';
import { EmbedView, GuestWallView, InfoCardsView, JoinRemoteView } from './extras';
import { HeroView } from './hero';
import { CountdownView, DetailsView, RsvpView, VenueView } from './info';
import { HostsView, SponsorsView } from './people';
import { GalleryView, MaterialsView, MediaView } from './visual';

/** Block type → view. Every BLOCK_TYPES member has one (tests/unit/events-blocks.test.ts). */
export function BlockView(props: BlockViewProps) {
  switch (props.section.type) {
    case 'hero':
      return <HeroView {...props} />;
    case 'details':
      return <DetailsView {...props} />;
    case 'rsvp':
      return <RsvpView {...props} />;
    case 'agenda':
      return <AgendaView {...props} />;
    case 'text':
      return <TextView {...props} />;
    case 'hosts':
      return <HostsView {...props} />;
    case 'sponsors':
      return <SponsorsView {...props} />;
    case 'venue':
      return <VenueView {...props} />;
    case 'countdown':
      return <CountdownView {...props} />;
    case 'faq':
      return <FaqView {...props} />;
    case 'gallery':
      return <GalleryView {...props} />;
    case 'media':
      return <MediaView {...props} />;
    case 'stats':
      return <StatsView {...props} />;
    case 'materials':
      return <MaterialsView {...props} />;
    case 'buttons':
      return <ButtonsView {...props} />;
    case 'divider':
      return <DividerView {...props} />;
    case 'footer':
      return <FooterView {...props} />;
    case 'embed':
      return <EmbedView {...props} />;
    case 'guest_wall':
      return <GuestWallView {...props} />;
    case 'join_remote':
      return <JoinRemoteView {...props} />;
    case 'info_cards':
      return <InfoCardsView {...props} />;
    default:
      return null;
  }
}
