import 'server-only';
import { sha256 } from '@/lib/util/hash';

/**
 * Whether CF-Connecting-IP can be believed: only behind Cloudflare, which
 * overwrites whatever a client sent. Render serves through Cloudflare (and
 * sets RENDER=true on every service); anywhere else (the Vercel standby, a
 * direct origin) a client could set the header and walk past every brake.
 * TRUST_CF_CONNECTING_IP=true/false overrides the guess.
 */
function trustsCloudflare(): boolean {
  const explicit = process.env.TRUST_CF_CONNECTING_IP?.trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return process.env.RENDER === 'true';
}

/**
 * The caller's address, for abuse brakes and the audit trail.
 *
 * Behind Cloudflare (above), CF-Connecting-IP; on Vercel, its own
 * x-vercel-forwarded-for (set by its edge). Otherwise the last
 * X-Forwarded-For hop: the first is whatever the client wrote, while the last
 * was added by the nearest proxy — though on a host whose own proxy appends
 * itself it is that proxy's address, shared by every caller. So a brake keyed
 * on it must stay an abuse brake: a wrong or shared key may slow people down,
 * and must never be what grants access.
 */
export function clientAddress(headers: Headers): string {
  if (trustsCloudflare()) {
    const edge = headers.get('cf-connecting-ip')?.trim();
    if (edge) return edge;
  }
  if (process.env.VERCEL === '1') {
    const vercel = headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim();
    if (vercel) return vercel;
  }
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.at(-1) || headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * The part of an address one party controls: the whole of an IPv4 address,
 * the /64 prefix of an IPv6 one. A single IPv6 customer is routinely given a
 * /64 (2^64 addresses), so a brake keyed on the full address is no brake at
 * all, and every fresh address would be another bucket in memory.
 */
export function addressBucket(address: string): string {
  // Brackets from a host:port form, and an interface zone (`fe80::1%eth0`).
  const bare = address
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  if (!bare.includes(':')) return bare || 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare);
  if (mapped) return mapped[1] as string;
  const [head = '', tail = ''] = bare.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = bare.includes('::') && tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = bare.includes('::')
    ? [...left, ...Array<string>(missing).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, '') || '0')
    .join(':')}::/64`;
}

/**
 * A short, non-reversible key for a per-address limiter: never the raw
 * address, so nothing that holds the limiter's map holds who called.
 */
export function addressKey(headers: Headers): string {
  return sha256(addressBucket(clientAddress(headers))).slice(0, 16);
}
