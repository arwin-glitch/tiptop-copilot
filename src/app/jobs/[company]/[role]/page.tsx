import { JobPage, jobMetadata } from '@/components/jobs-board/pages';

/**
 * Rendered per request from the board's one shared cache entry, never cached
 * per address: an address anyone can make up must not add a file to the
 * server's cache (see readPublicBoardCached).
 */
export const dynamic = 'force-dynamic';

const BASE = '/jobs';

interface Props {
  params: Promise<{ company: string; role: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { company, role } = await params;
  return jobMetadata({ base: BASE, companySlug: company, roleSlug: role });
}

export default async function JobsBoardRole({ params }: Props) {
  const { company, role } = await params;
  return <JobPage base={BASE} companySlug={company} roleSlug={role} />;
}
