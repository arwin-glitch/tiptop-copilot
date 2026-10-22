import { CompaniesPage, companiesMetadata } from '@/components/jobs-board/pages';

export const revalidate = 600;

const BASE = '';

export function generateMetadata() {
  return companiesMetadata({ base: BASE });
}

export default function JobsBoardCompanies() {
  return <CompaniesPage base={BASE} />;
}
