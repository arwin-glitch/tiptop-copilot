/**
 * The write scopes this codebase may request, each only through its own
 * opt-in flow started by a person. Kept in one file so a test can pin them
 * here: any other file naming a write scope fails the suite.
 */

/** "Turn on sending": the email session's Send button, the Inbox tab, campaigns. */
export const SEND_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'] as const;

/**
 * "Turn on calendar editing": create, change, move and delete events from
 * the Calendar tab, on a person's tap, and nowhere else. Event-level only:
 * it cannot share, create or delete a calendar. Reading the calendar list and
 * Google's colours stays on the default read-only calendar scope.
 */
export const CALENDAR_EDIT_SCOPES = ['https://www.googleapis.com/auth/calendar.events'] as const;

/**
 * "Turn on filters": Gmail's Create filter from the Inbox's search options,
 * and the Filters list (view and delete). Only on a person's click: Kraken
 * never makes, changes or deletes a filter on its own. The basic settings
 * scope covers filters and labels-in-settings only; it cannot set up
 * forwarding addresses or delegates (that is gmail.settings.sharing, which
 * is never asked for), and the filter path itself refuses a forward action.
 */
export const FILTER_SCOPES = ['https://www.googleapis.com/auth/gmail.settings.basic'] as const;

/**
 * "Connect your Google to contribute" (Spaces): a member's own Google,
 * READ-ONLY, and nothing else. Pinned here beside the write scopes so the
 * test that pins them proves this list holds no write scope and never grows
 * one. A member connection never asks for sending, calendar editing or
 * filters; the OAuth builder sends exactly this list for it, without
 * include_granted_scopes, and the callback refuses a grant that carries
 * anything outside it (D-081).
 */
export const MEMBER_READ_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;
