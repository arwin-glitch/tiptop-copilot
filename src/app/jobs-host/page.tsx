import { BoardHomePage, boardHomeMetadata } from '@/components/jobs-board/pages';

/** Cached; rebuilt every ten minutes, or at once when Kraken changes the board. */
export const revalidate = 600;

const BASE = '';

export function generateMetadata() {
  return boardHomeMetadata({ base: BASE });
}

export default function JobsBoardHome() {
  return <BoardHomePage base={BASE} />;
}
