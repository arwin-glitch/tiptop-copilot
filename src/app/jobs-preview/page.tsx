import { requireAuth } from '@/lib/auth/session';
import { BoardHomePage, boardHomeMetadata } from '@/components/jobs-board/pages';

export const dynamic = 'force-dynamic';

const BASE = '/jobs-preview';

export function generateMetadata() {
  return boardHomeMetadata({ base: BASE, preview: true });
}

export default async function JobsBoardPreviewHome() {
  await requireAuth();
  return <BoardHomePage base={BASE} preview />;
}
