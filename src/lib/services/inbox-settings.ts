import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { sanitizeSignatureHtml } from '@/lib/email/signature-html';
import { canManageFilters } from '@/lib/google/gmail-filters';
import { readSignature, writeSignature } from '@/lib/google/gmail-settings';
import type { Integration } from '@/lib/types/domain';
import { processWide } from '@/lib/util/process-state';
import { err, ok, type Result } from '@/lib/util/result';

/**
 * The Inbox's Gmail settings: the signature (and, below, the vacation
 * responder). Reading is free; each save happens only from a person's Save
 * click in its dialog. Saving needs the "Turn on filters" grant
 * (gmail.settings.basic), the same one filters use. The demo keeps its
 * settings in this process with fictional values; nothing reaches Gmail.
 *
 * Kraken's send rule stays as it was: drafts never carry a typed signature,
 * and Send attaches the real Gmail signature read at that moment, so a
 * signature saved here is the one the next Send uses.
 */

export type SettingsAccess = 'on' | 'off' | 'demo' | 'not_connected';

export function settingsAccess(demo: boolean, integration: Integration | null): SettingsAccess {
  if (demo) return 'demo';
  if (!integration || integration.status === 'disconnected') return 'not_connected';
  return canManageFilters(integration) ? 'on' : 'off';
}

const DEMO_SIGNATURE =
  'Sam Rivera<br>Partner, Example Ventures<br><a href="https://example.com" target="_blank" rel="noopener noreferrer">example.com</a>';

const demo = processWide('inbox-settings-demo', () => ({ signature: DEMO_SIGNATURE }));

/** Test hook. */
export function resetDemoSettings(): void {
  demo.signature = DEMO_SIGNATURE;
}

export interface SignatureRead {
  access: SettingsAccess;
  email: string | null;
  html: string;
}

export async function getSignature(
  store: DataStore,
  isDemo: boolean,
  integration: Integration | null,
): Promise<Result<SignatureRead>> {
  const access = settingsAccess(isDemo, integration);
  if (access === 'demo') return ok({ access, email: 'sam@example.com', html: demo.signature });
  if (access === 'not_connected' || !integration) return ok({ access, email: null, html: '' });
  const read = await readSignature(store, integration);
  if (!read.ok) return read;
  return ok({ access, ...read.value });
}

/** Save the signature: from a person's Save click in the Signature dialog only. */
export async function saveSignature(
  store: DataStore,
  isDemo: boolean,
  integration: Integration | null,
  html: string,
): Promise<Result<SignatureRead>> {
  const access = settingsAccess(isDemo, integration);
  if (access === 'demo') {
    demo.signature = sanitizeSignatureHtml(html);
    return ok({ access, email: 'sam@example.com', html: demo.signature });
  }
  if (access !== 'on' || !integration) {
    return err('forbidden', 'Mail settings are off. Turn on filters and settings first.');
  }
  const saved = await writeSignature(store, integration, html);
  if (!saved.ok) return saved;
  return ok({ access, ...saved.value });
}
