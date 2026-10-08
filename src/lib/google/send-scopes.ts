/**
 * The one write scope this codebase may request, and only through the
 * opt-in "Turn on sending" flow. Kept in its own file so a test can pin it
 * here: any other file naming a write scope fails the suite.
 */
export const SEND_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'] as const;
