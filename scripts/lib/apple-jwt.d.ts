/** Types for the ES256 token helper the sender and the test suite import. */
import type { KeyObject } from 'node:crypto';

export function base64url(value: string | Uint8Array): string;
export function loadP8(text: string | null | undefined): KeyObject;
export function mintAppleJwt(
  key: KeyObject,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string;
export function apnsProviderToken(
  key: KeyObject,
  options: { keyId: string; teamId: string; now?: number },
): string;
