import { handleDesktopAlerts } from '@/lib/desktop/alerts-endpoint';

export const dynamic = 'force-dynamic';
// A cold start on the free plan can take most of a minute.
export const maxDuration = 60;

/**
 * The desktop app's alerts, asked for by its shell with its own token and no
 * session (lib/desktop/alerts-endpoint.ts): the alerts due for this computer.
 */
export async function GET(request: Request) {
  return handleDesktopAlerts(request, 'GET');
}

/** Which alerts this computer showed: its ledger. */
export async function POST(request: Request) {
  return handleDesktopAlerts(request, 'POST');
}

/** Turn desktop alerts off for this computer, from the app itself. */
export async function DELETE(request: Request) {
  return handleDesktopAlerts(request, 'DELETE');
}
