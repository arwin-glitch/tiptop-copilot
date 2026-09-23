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
 *
 * `preferLabel` unwraps a labelled link to its label, which is the text the
 * poster actually typed: Slack turns a bare `zeta.ai` into
 * `<http://zeta.ai|zeta.ai>`, and a relay whose fields are names and plain
 * text (not URLs) wants `zeta.ai` back, not `http://zeta.ai`.
 */
export function unwrapSlackText(text: string, options: { preferLabel?: boolean } = {}): string {
  return text
    .replace(/<mailto:([^|>\s]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/<(https?:[^|>\s]+)(?:\|([^>]*))?>/g, (_match, url: string, label?: string) =>
      options.preferLabel && label ? label : url,
    )
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
