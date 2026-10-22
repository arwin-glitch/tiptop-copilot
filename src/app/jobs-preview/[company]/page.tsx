import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth/session';
import { CompanyPage } from '@/components/jobs-board/pages';

export const dynamic = 'force-dynamic';

const BASE = '/jobs-preview';

interface Props {
  params: Promise<{ company: string }>;
}

export default async function JobsBoardPreviewCompany({ params }: Props) {
  if (!(await getAuthContext())) redirect('/login');
  const { company } = await params;
  return <CompanyPage base={BASE} slug={company} preview />;
}
