import { BoardHomePage, boardHomeMetadata } from '@/components/jobs-board/pages';

/**
 * Rendered per request from the board's shared data cache (ten minutes, or
 * dropped at once when Kraken changes the board). Never prerendered at build:
 * the free server restarts from its build files when it wakes, and a page
 * saved at build time would show the build day's roles until it refreshed.
 */
export const dynamic = 'force-dynamic';

const BASE = '/jobs';

export function generateMetadata() {
  return boardHomeMetadata({ base: BASE });
}

export default function JobsBoardHome() {
  return <BoardHomePage base={BASE} />;
}
