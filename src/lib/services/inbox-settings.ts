import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { sanitizeSignatureHtml } from '@/lib/email/signature-html';
import { canManageFilters } from '@/lib/google/gmail-filters';
import {
  readSignature,
  readVacation,
  writeSignature,
  writeVacation,
} from '@/lib/google/gmail-settings';
import { VACATION_OFF, vacationProblem, type VacationSettings } from '@/lib/email/vacation';
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

const demo = processWide('inbox-settings-demo', () => ({
  signature: DEMO_SIGNATURE,
  vacation: { ...VACATION_OFF } as VacationSettings,
}));

/** Test hook. */
export function resetDemoSettings(): void {
  demo.signature = DEMO_SIGNATURE;
  demo.vacation = { ...VACATION_OFF };
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

export interface VacationRead {
  access: SettingsAccess;
  mailbox: string | null;
  /** Null when it cannot be read (settings off, or no mailbox). */
  vacation: VacationSettings | null;
}

/** Gmail's vacation responder now, for the Inbox's banner and the dialog. */
export async function getVacation(
  store: DataStore,
  isDemo: boolean,
  integration: Integration | null,
): Promise<Result<VacationRead>> {
  const access = settingsAccess(isDemo, integration);
  if (access === 'demo') return ok({ access, mailbox: 'sam@example.com', vacation: demo.vacation });
  const mailbox = integration?.account_email ?? null;
  if (access !== 'on' || !integration) return ok({ access, mailbox, vacation: null });
  const read = await readVacation(store, integration);
  if (!read.ok) return read;
  return ok({ access, mailbox, vacation: read.value });
}

/**
 * Set the vacation responder: from a person's Save click after the confirm
 * that says it will auto-reply, or their Turn off click. It auto-replies
 * only; nothing here forwards mail.
 */
export async function saveVacation(
  store: DataStore,
  isDemo: boolean,
  integration: Integration | null,
  next: VacationSettings,
): Promise<Result<VacationSettings>> {
  const clean: VacationSettings = { ...next, html: sanitizeSignatureHtml(next.html) };
  const problem = vacationProblem(clean);
  if (problem) return err('invalid_input', problem);
  const access = settingsAccess(isDemo, integration);
  if (access === 'demo') {
    demo.vacation = clean;
    return ok(clean);
  }
  if (access !== 'on' || !integration) {
    return err('forbidden', 'Mail settings are off. Turn on filters and settings first.');
  }
  return writeVacation(store, integration, clean);
}
