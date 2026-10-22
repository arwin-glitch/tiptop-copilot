import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DangerZone,
  LinkForm,
  PasswordForm,
  SeoForm,
  VisibilityForm,
  type SeoValues,
} from '@/components/events/settings/settings-forms';
import { env } from '@/lib/config/env';
import type { EventPanelProps } from '@/lib/events/contracts';
import { parseEventDoc } from '@/lib/events/schema';

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'copilot.tiptop.vc';
  }
}

/**
 * Manage (the `settings` tab): the event's link, who can find it, search and
 * share text, the password, and duplicate, cancel, unpublish, archive and
 * delete. The page's own content is edited in Studio; registration in its tab.
 */
export function SettingsPanel({ event }: EventPanelProps) {
  const doc = parseEventDoc(event.draft_doc);
  const meta: SeoValues = doc.ok
    ? {
        seoTitle: doc.value.meta.seoTitle,
        seoDescription: doc.value.meta.seoDescription,
        ogLayout: doc.value.meta.ogLayout,
        rev: doc.value.meta.rev,
      }
    : { seoTitle: '', seoDescription: '', ogLayout: 'cover', rev: 0 };
  return (
    <div data-panel="settings" className="grid gap-4 lg:grid-cols-2">
      <Card aria-labelledby="settings-link-title">
        <CardHeader>
          <CardTitle as="h2" id="settings-link-title">
            Link
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LinkForm eventId={event.id} slug={event.slug} origin={host(env().appUrl)} />
        </CardContent>
      </Card>
      <Card aria-labelledby="settings-visibility-title">
        <CardHeader>
          <CardTitle as="h2" id="settings-visibility-title">
            Who can find it
          </CardTitle>
        </CardHeader>
        <CardContent>
          <VisibilityForm eventId={event.id} visibility={event.visibility} />
        </CardContent>
      </Card>
      <Card aria-labelledby="settings-seo-title">
        <CardHeader>
          <div>
            <CardTitle as="h2" id="settings-seo-title">
              Search and share text
            </CardTitle>
            <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
              What search results and link previews show. Unlisted and private pages are never
              listed.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {doc.ok ? (
            <SeoForm
              eventId={event.id}
              draftVersion={event.draft_version}
              initial={meta}
              title={event.title}
            />
          ) : (
            <p className="text-sm text-[var(--fg-muted)]">
              The draft could not be read. Open Studio and restore an earlier version first.
            </p>
          )}
        </CardContent>
      </Card>
      <Card aria-labelledby="settings-password-title">
        <CardHeader>
          <CardTitle as="h2" id="settings-password-title">
            Password
          </CardTitle>
        </CardHeader>
        <CardContent>
          <PasswordForm eventId={event.id} hasPassword={Boolean(event.password_hash)} />
        </CardContent>
      </Card>
      <Card aria-labelledby="settings-danger-title" className="lg:col-span-2">
        <CardHeader>
          <CardTitle as="h2" id="settings-danger-title">
            Copy, cancel or remove
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DangerZone
            eventId={event.id}
            title={event.title}
            status={event.status}
            cancelMessage={event.cancel_message}
          />
        </CardContent>
      </Card>
    </div>
  );
}
