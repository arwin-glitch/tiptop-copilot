import { OG_CONTENT_TYPE, OG_SIZE, jobOgImage } from '@/components/jobs-board/og';

export const alt = 'An open role at a TipTop VC portfolio company';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const revalidate = 600;
export function generateStaticParams() {
  return [];
}

export default async function Image({
  params,
}: {
  params: Promise<{ company: string; role: string }>;
}) {
  const { company, role } = await params;
  return jobOgImage(company, role);
}
