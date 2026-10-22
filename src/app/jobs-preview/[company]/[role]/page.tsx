import { requireAuth } from '@/lib/auth/session';
import { JobPage, jobMetadata } from '@/components/jobs-board/pages';

export const dynamic = 'force-dynamic';

const BASE = '/jobs-preview';

interface Props {
  params: Promise<{ company: string; role: string }>;
}

export async function generateMetadata({ params }: Props) {
  const { company, role } = await params;
  return jobMetadata({ base: BASE, companySlug: company, roleSlug: role, preview: true });
}

export default async function JobsBoardPreviewRole({ params }: Props) {
  await requireAuth();
  const { company, role } = await params;
  return <JobPage base={BASE} companySlug={company} roleSlug={role} preview />;
}
