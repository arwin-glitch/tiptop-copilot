import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireAuth } from '@/lib/auth/session';
import { ownerOf } from '@/lib/events/route-helpers';
import { ID_RE } from '@/lib/events/schema';
import { getStore } from '@/lib/runtime';
import { loadOwnerStudio } from '@/components/events/studio/load-studio';
import { Studio } from '@/components/events/studio/studio';
import { NotConfigured } from '@/components/ui/not-configured';

export const metadata: Metadata = { title: 'Studio' };
export const dynamic = 'force-dynamic';

/**
 * Events Studio for owners (any signed-in member): the page editor, full
 * screen. Outside editors reach the same component at /e/edit/[id].
 */
export default async function StudioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID_RE.test(id)) notFound();
  const auth = await requireAuth();
  const boot = await loadOwnerStudio(getStore(), ownerOf(auth), id);
  if (!boot.ok) {
    if (boot.error.code === 'not_found') notFound();
    return (
      <main id="main" className="mx-auto max-w-xl p-6">
        <h1 className="mb-3 font-serif text-2xl font-semibold">Studio</h1>
        <NotConfigured
          title="Studio could not open"
          description={boot.error.message}
          stillWorks={boot.error.stillUsable ?? 'Everything else in Copilot works as before.'}
          action={null}
        />
        <p className="mt-4 text-sm">
          <Link href="/today" className="underline underline-offset-4">
            Back to Copilot
          </Link>
        </p>
      </main>
    );
  }
  return <Studio boot={boot.value} />;
}
