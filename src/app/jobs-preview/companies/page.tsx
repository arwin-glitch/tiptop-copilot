import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth/session';
import { CompaniesPage } from '@/components/jobs-board/pages';

export const dynamic = 'force-dynamic';

const BASE = '/jobs-preview';

export default async function JobsBoardPreviewCompanies() {
  if (!(await getAuthContext())) redirect('/login');
  return <CompaniesPage base={BASE} preview />;
}
