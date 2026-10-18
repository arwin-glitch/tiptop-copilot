/** Types for the check the test suite imports from the update signature verifier. */

export function verifyUpdateSignature(input: {
  data: Uint8Array;
  signature: string;
  pubkey: string;
  version: string;
}): string | null;
