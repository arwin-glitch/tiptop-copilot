import { requireAuth } from '@/lib/auth/session';
import { CompanyPage, companyMetadata } from '@/components/jobs-board/pages';

export const dynamic = 'force-dynamic';

const BASE = '/jobs-preview';

interface Props {
  params: Promise<{ company: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { company } = await params;
  return companyMetadata({ base: BASE, slug: company, preview: true });
}

export default async function JobsBoardPreviewCompany({ params }: Props) {
  await requireAuth();
  const { company } = await params;
  return <CompanyPage base={BASE} slug={company} preview />;
}
