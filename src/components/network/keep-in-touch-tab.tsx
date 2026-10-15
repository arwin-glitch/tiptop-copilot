import { requireAuth } from '@/lib/auth/session';
import { getStore } from '@/lib/runtime';
import { listKeepInTouch } from '@/lib/services/keep-in-touch';
import { KeepInTouchList } from '@/components/network/keep-in-touch-list';
import { EmptyState, ErrorState } from '@/components/ui/feedback';

/** Network's "Keep in touch" tab: every cadence set on a profile, overdue first. */
export async function KeepInTouchTab() {
  const auth = await requireAuth();
  const found = await listKeepInTouch(getStore(), auth.organizationId);
  if (!found.ok) {
    return found.error.code === 'not_configured' ? (
      <EmptyState
        title="Lists are not set up yet"
        description={found.error.message}
        action={{ label: 'Open Lists', href: '/lists' }}
      />
    ) : (
      <ErrorState
        title="Keep in touch could not be loaded"
        message={found.error.message}
        stillUsable="The rest of Network, and every profile."
      />
    );
  }
  if (!found.value.length) {
    return (
      <EmptyState
        title="No cadences yet"
        description="Open a company or person in Lists and choose how often to check in under “Keep in touch”. When one comes due, a “Check in with” task appears on Tasks."
        action={{ label: 'Open Lists', href: '/lists' }}
      />
    );
  }
  return <KeepInTouchList rows={found.value} timezone={auth.profile.timezone} />;
}
