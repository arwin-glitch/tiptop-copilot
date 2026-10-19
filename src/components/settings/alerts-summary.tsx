/**
 * What alerts there are and when: one paragraph, shared by the phone and
 * desktop cards in Settings > Preferences, since both get the same alerts.
 */
export function AlertsSummary() {
  return (
    <p className="mt-1 text-sm text-[var(--fg-muted)]">
      A ping 5 minutes before each real meeting (calendar blocks like Focus, Hold or Lunch never
      ping; the Calendar tab shows which is which), plus money or legal items going stale, your
      morning top 3, LPs and founders waiting on you, portfolio companies newly at risk, someone
      outside TipTop opening your fund materials on DocSend, and a campaign finishing sending (its
      name and counts). Each item alerts once; everything but meetings stays within 8am to 8pm.
    </p>
  );
}
