import type { Metadata } from 'next';
import { EditEntry } from '@/components/events/studio/edit-entry';

export const metadata: Metadata = {
  title: { absolute: 'Edit an event page' },
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};
export const dynamic = 'force-dynamic';

/**
 * The outside editor's entry: copilot.tiptop.vc/e/edit#k=<secret>.
 * Side-effect free on GET. The secret is in the fragment, so it never
 * reaches the server here; the page reads it, removes it from the address
 * bar, shows who the link is for, and claims it only on an explicit click.
 */
export default function EditEntryPage() {
  return <EditEntry />;
}
