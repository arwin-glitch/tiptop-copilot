/**
 * Does this cookie name carry a Supabase session?
 *
 * Supabase splits the auth cookie into numbered chunks when it exceeds the
 * 4KB-per-cookie limit — `sb-<ref>-auth-token.0`, `.1`, and so on — and whether
 * it does depends on how much the identity provider returns. Google, with a
 * display name and an avatar URL, is comfortably over.
 *
 * Matching only the unchunked name cost a live deployment a redirect loop that
 * looked like anything but this. The proxy concluded there was no session and
 * sent /today to /login; the page reassembled the chunks perfectly well,
 * resolved the session, and sent it back to /today. Neither side was wrong on
 * its own terms, and the browser saw only ERR_TOO_MANY_REDIRECTS.
 *
 * Lives in its own module because both the proxy and the session layer need it
 * and neither should import the other.
 */
export function isSupabaseAuthCookie(name: string): boolean {
  return /^sb-.+-auth-token(\.\d+)?$/.test(name);
}
