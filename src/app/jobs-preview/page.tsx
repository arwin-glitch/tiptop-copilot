import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth/session';
import { BoardHomePage } from '@/components/jobs-board/pages';

export const dynamic = 'force-dynamic';

const BASE = '/jobs-preview';

export default async function JobsBoardPreviewHome() {
  if (!(await getAuthContext())) redirect('/login');
  return <BoardHomePage base={BASE} preview />;
}
