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
