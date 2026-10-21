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
