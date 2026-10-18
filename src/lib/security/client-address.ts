import 'server-only';
import { sha256 } from '@/lib/util/hash';

/**
 * The caller's address, for abuse brakes and the audit trail.
 *
 * Render serves through Cloudflare, which sets CF-Connecting-IP to the
 * address that reached its edge (overwriting whatever a client sent), so that
 * is preferred. Otherwise the last X-Forwarded-For hop: the first is whatever
 * the client wrote, while the last was added by the nearest proxy — though on
 * a host whose own proxy appends itself it is that proxy's address, shared by
 * every caller. So a brake keyed on it must stay an abuse brake: a wrong or
 * shared key may slow people down, and must never be what grants access.
 */
export function clientAddress(headers: Headers): string {
  const edge = headers.get('cf-connecting-ip')?.trim();
  if (edge) return edge;
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
