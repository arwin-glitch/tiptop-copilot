import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { blockRegistry } from '@/lib/events/blocks';
import { eventPaths, type EventPanelProps } from '@/lib/events/contracts';
import { sectionLabel } from '@/lib/events/editor/fields';
import { orderedSections, parseEventDoc } from '@/lib/events/schema';
import { getStore } from '@/lib/runtime';
import { listEditorLinks, listEditorNotices } from '@/lib/services/event-editors';
import { eventMediaPublicUrl } from '@/lib/storage/provider';
import { EditorLinks } from './editor-links';
import { EditorNotices } from './editor-notices';
import { ShareKit } from './share-kit';

/**
 * The event's Sharing tab (WS5's /events/[id]?tab=sharing mounts it):
 * outside editors and viewer links, staff check-in links, what those links
 * have been doing, and the share kit (link, QR, share card). A server
 * component; the lists are client islands. Never passes the event row or a
 * link's hash to the browser.
 */
export async function SharingPanel({ event, viewer }: EventPanelProps) {
  const store = getStore();
  const [links, notices] = await Promise.all([
    listEditorLinks(store, viewer.organizationId, event.id),
    listEditorNotices(store, viewer.organizationId, { eventId: event.id, limit: 20 }),
  ]);
  const parsed = parseEventDoc(event.draft_doc);
  const sections = parsed.ok
    ? orderedSections(parsed.value.sections).map((s) => ({
        id: s.id,
        label: sectionLabel(s, blockRegistry),
      }))
    : [];
  const all = links.ok ? links.value : [];
  const editors = all.filter((l) => l.role !== 'checkin');
  const staff = all.filter((l) => l.role === 'checkin');
  const hasDate = Boolean(event.ends_at ?? event.starts_at);
  const canShare = viewer.capabilities.share;

  return (
    <div className="space-y-4" data-panel="sharing">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Outside editors</CardTitle>
            <CardDescription>
              Personal links for partners to work on the page design and words, with no account.
              They edit the draft only; changes go live when you publish. No link reaches guests,
              messages, settings or anything else in Copilot.
            </CardDescription>
          </div>
          <a
            href={eventPaths.studio(event.id)}
            className="shrink-0 text-sm text-[var(--accent)] underline underline-offset-4"
          >
            Open Studio
          </a>
        </CardHeader>
        <CardContent>
          {links.ok ? (
            <EditorLinks
              group="editors"
              eventId={event.id}
              eventTitle={event.title}
              initialLinks={editors}
              sections={sections}
              editingPaused={event.editing_paused}
              hasEventDate={hasDate}
              canManage={canShare}
            />
          ) : (
            <p className="text-sm text-[var(--fg-muted)]">{links.error.message}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Check-in staff</CardTitle>
            <CardDescription>
              Door-list links for whoever checks people in: names, sessions and plus-ones only. No
              emails, answers, exports or messages.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {links.ok ? (
            <EditorLinks
              group="staff"
              eventId={event.id}
              eventTitle={event.title}
              initialLinks={staff}
              sections={sections}
              editingPaused={event.editing_paused}
              hasEventDate={hasDate}
              canManage={canShare}
            />
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Link activity</CardTitle>
            <CardDescription>
              First opens, use from a new device or network, and “ready for review”. These also
              reach Today and your desktop and phone alerts.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <EditorNotices notices={notices.ok ? notices.value : []} timeZone={viewer.timeZone} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Share kit</CardTitle>
            <CardDescription>
              The page link, a QR code for signage, and the share card.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ShareKit
            path={eventPaths.page(event.slug)}
            published={event.status === 'published'}
            ogImageUrl={event.og_image_path ? eventMediaPublicUrl(event.og_image_path) : null}
            title={event.title}
          />
        </CardContent>
      </Card>
    </div>
  );
}
