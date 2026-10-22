import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth/session';
import { JobPage } from '@/components/jobs-board/pages';

export const dynamic = 'force-dynamic';

const BASE = '/jobs-preview';

interface Props {
  params: Promise<{ company: string; role: string }>;
}

export default async function JobsBoardPreviewRole({ params }: Props) {
  if (!(await getAuthContext())) redirect('/login');
  const { company, role } = await params;
  return <JobPage base={BASE} companySlug={company} roleSlug={role} preview />;
}
