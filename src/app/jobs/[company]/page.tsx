import { CompanyPage, companyMetadata } from '@/components/jobs-board/pages';

/**
 * Rendered per request from the board's one shared cache entry, never cached
 * per address: an address anyone can make up must not add a file to the
 * server's cache (see readPublicBoardCached).
 */
export const dynamic = 'force-dynamic';

const BASE = '/jobs';

interface Props {
  params: Promise<{ company: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { company } = await params;
  return companyMetadata({ base: BASE, slug: company });
}

export default async function JobsBoardCompany({ params }: Props) {
  const { company } = await params;
  return <CompanyPage base={BASE} slug={company} />;
}
