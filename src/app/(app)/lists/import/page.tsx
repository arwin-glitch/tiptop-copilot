import { redirect } from 'next/navigation';
import { AFFINITY_IMPORT_HREF } from '@/lib/records-tabs';

// Rendered per request like the rest of the app. Left static, the build
// prerenders it with no session, and the app layout's sign-in redirect is
// baked in: every visit, signed in or not, would land on /login.
export const dynamic = 'force-dynamic';

/** The Affinity importer moved to Knowledge → Affinity import; old links land there. */
export default function AffinityImportPage(): never {
  redirect(AFFINITY_IMPORT_HREF);
}
