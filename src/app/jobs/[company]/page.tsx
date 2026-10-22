import { CompanyPage, companyMetadata } from '@/components/jobs-board/pages';

/** Built on first visit, then cached like the home page. */
export const revalidate = 600;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

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
