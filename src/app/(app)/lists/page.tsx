import { redirect } from 'next/navigation';
import { AFFINITY_LISTS_HREF } from '@/lib/records-tabs';

// Rendered per request like the rest of the app. Left static, the build
// prerenders it with no session, and the app layout's sign-in redirect is
// baked in: every visit, signed in or not, would land on /login.
export const dynamic = 'force-dynamic';

/**
 * The lists moved under Knowledge (Affinity lists), grouped by the page each
 * one feeds; Lists is no longer in the main navigation. Old links and
 * bookmarks land there. A list's own page and record profiles stay at
 * `/lists/<id>` and `/lists/records/<id>`.
 */
export default function ListsPage(): never {
  redirect(AFFINITY_LISTS_HREF);
}
