import { JobPage, jobMetadata } from '@/components/jobs-board/pages';

/** Built on first visit, then cached like the home page. */
export const revalidate = 600;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

const BASE = '';

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
