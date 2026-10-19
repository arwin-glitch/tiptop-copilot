import type { Metadata } from 'next';
import { PageHeader, PageShell } from '@/components/shell/page-header';
import { DownloadCards } from '@/components/desktop/download-cards';
import { Notice } from '@/components/ui/feedback';
import { requireAuth } from '@/lib/auth/session';
import { latestDesktopRelease } from '@/lib/desktop/releases';
import { desktopVersionHint } from '@/lib/desktop/server';
import { isInstallerPlatform } from '@/lib/desktop/shared';

export const metadata: Metadata = { title: 'Desktop app' };
export const dynamic = 'force-dynamic';

/**
 * Download the desktop app: Copilot in its own window. The installers come
 * through /api/desktop/download, never a link to where they are published.
 * In the navigation under System, and linked from Settings > Preferences;
 * neither link shows in the iPhone app, which cannot install it, and this
 * page says so there.
 */
export default async function DownloadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAuth();
  const [params, release, desktopVersion] = await Promise.all([
    searchParams,
    latestDesktopRelease(),
    desktopVersionHint(),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Desktop app"
        subtitle="TipTop Copilot in its own window, with an icon in your Dock or taskbar."
      />
      <Notice className="ios-app:flex hidden">
        Do this on your computer: open Copilot on your Mac or PC and choose Download there.
      </Notice>
      <div className="ios-app:hidden">
        <DownloadCards
          release={release}
          unavailable={isInstallerPlatform(params.unavailable) ? params.unavailable : null}
          failed={isInstallerPlatform(params.failed) ? params.failed : null}
          serverVersion={desktopVersion}
        />
      </div>
    </PageShell>
  );
}
