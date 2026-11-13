import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { authOrError } from '@/lib/auth/session';
import { avatarAddress, gravatarUrl, logoDomain, logoUrl } from '@/lib/email/avatar-source';
import { rateLimit } from '@/lib/security/limits';
import { processWide } from '@/lib/util/process-state';

export const dynamic = 'force-dynamic';

const DAY_MS = 24 * 60 * 60_000;
const MAX_BYTES = 200_000;
const MAX_KEPT = 3000;

interface Picture {
  at: number;
  image: { bytes: Uint8Array; type: string } | null;
}

const kept = processWide('inbox-avatars', () => new Map<string, Picture>());

async function fetchImage(url: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: 'follow' });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/^image\/(png|jpe?g|gif|webp|x-icon|vnd\.microsoft\.icon)/i.test(type)) {
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= MAX_BYTES ? { bytes, type } : null;
  } catch {
    return null;
  }
}

async function pictureFor(address: string): Promise<Picture['image']> {
  const hash = createHash('sha256').update(address).digest('hex');
  const photo = await fetchImage(gravatarUrl(hash));
  if (photo) return photo;
  const domain = logoDomain(address);
  return domain ? fetchImage(logoUrl(domain)) : null;
}

/**
 * A sender's picture for the Inbox avatars (lib/email/avatar-source.ts):
 * their Gravatar, else their company's logo, else 404 and the avatar keeps
 * its initial. Signed in only; each answer is kept a day in this process.
 */
export async function GET(request: NextRequest) {
  const auth = await authOrError();
  if (!auth.ok) return new NextResponse(null, { status: 401 });
  const address = avatarAddress(request.nextUrl.searchParams.get('e'));
  if (!address) return new NextResponse(null, { status: 400 });
  const now = Date.now();
  let hit = kept.get(address);
  if (!hit || now - hit.at > DAY_MS) {
    const limited = rateLimit(`avatar:${auth.value.userId}`, 300, 60_000);
    if (!limited.ok) return new NextResponse(null, { status: 429 });
    hit = { at: now, image: await pictureFor(address) };
    kept.set(address, hit);
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
  }
  const headers = { 'Cache-Control': 'private, max-age=86400' };
  if (!hit.image) return new NextResponse(null, { status: 404, headers });
  return new NextResponse(Buffer.from(hit.image.bytes), {
    headers: { ...headers, 'Content-Type': hit.image.type, 'X-Content-Type-Options': 'nosniff' },
  });
}
