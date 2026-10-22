import { requireAuth } from '@/lib/auth/session';
import { CompaniesPage, companiesMetadata } from '@/components/jobs-board/pages';

export const dynamic = 'force-dynamic';

const BASE = '/jobs-preview';

export function generateMetadata() {
  return companiesMetadata({ base: BASE, preview: true });
}

export default async function JobsBoardPreviewCompanies() {
  await requireAuth();
  return <CompaniesPage base={BASE} preview />;
}
