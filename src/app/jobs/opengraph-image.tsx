import { OG_CONTENT_TYPE, OG_SIZE, boardHomeOgImage } from '@/components/jobs-board/og';

export const alt = 'Jobs at TipTop portfolio companies';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return boardHomeOgImage();
}
