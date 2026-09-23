/**
 * Slack rewrites message text on the way out: a bare URL becomes `<url>` or
 * `<url|label>` even inside a code span, and `&`, `<` and `>` are entity
 * escaped. A relay payload is JSON carried in that text, so both have to be
 * undone before it will parse — a `source_url` of `<https://…>` is not a URL.
 *
 * Links are unwrapped first: a `<` that is still raw at that point is Slack's
 * own link markup, whereas a literal `<` in the sender's text arrives as `&lt;`.
 * An auto-linked email address (`<mailto:a@b.co|a@b.co>`) unwraps to the bare
 * address: kept with its scheme it fails every email validator downstream, and
 * one failing field drops the whole payload.
 */
export function unwrapSlackText(text: string): string {
  return text
    .replace(/<mailto:([^|>\s]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/<(https?:[^|>\s]+)(?:\|[^>]*)?>/g, '$1')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
