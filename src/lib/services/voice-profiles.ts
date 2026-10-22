import 'server-only';
import type { DataStore } from '@/lib/db/store';
import { openIdentifiers, sealIdentifiers } from '@/lib/notes/voiceprint-seal';
import { recordAudit } from '@/lib/security/audit';
import { log } from '@/lib/security/redact';
import { getTranscriber, type KnownSpeaker } from '@/lib/transcribe';
import {
  NOTES_LIMITS,
  VOICE_CONSENT_TEXT_VERSION,
  type SttSession,
  type TranscriberProvider,
  type VoiceConsentRequest,
  type VoiceEnrollRequest,
  type VoiceIdentifier,
  type VoiceProfile,
  type VoiceProfileView,
} from '@/lib/types/notes';
import { newId } from '@/lib/util/hash';
import { err, ok, type Result } from '@/lib/util/result';
import { guard, type NotesContext } from './notes';

/**
 * Voice profiles (D-076): opt-in only. Voiceprints are biometric identifiers
 * under Texas Bus. & Com. Code 503.001 (and Illinois BIPA): notice and
 * consent before capture, destroyed within a year of last use, deleted at
 * once on withdrawal, never exported.
 *
 * This service records consent and its withdrawal. A person may tick the box
 * for themselves (`self_checkbox`); anyone else's consent needs evidence of
 * its own (a signed form, a recorded yes). Withdrawing deletes the identifier
 * at once. The identifier itself (voice_identifiers, sealed with
 * VOICEPRINT_ENC_KEY) is never returned by anything here, and enrolment (a
 * 30-second solo clip turned into an identifier by the vendor) builds on the
 * consent recorded here.
 */

async function enrolledIds(ctx: NotesContext, profileIds: string[]): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();
  const rows = (await ctx.store.list('voice_identifiers', ctx.auth.organizationId, {
    in: { voice_profile_id: profileIds },
  })) as VoiceIdentifier[];
  return new Set(rows.map((r) => r.voice_profile_id));
}

function toView(p: VoiceProfile, enrolled: boolean): VoiceProfileView {
  return {
    email: p.person_email,
    name: p.display_name,
    consentStatus: p.consent_status,
    consentAt: p.consent_at,
    enrolled,
    expiresAt: p.expires_at,
  };
}

export async function listVoiceProfiles(ctx: NotesContext): Promise<Result<VoiceProfileView[]>> {
  return guard('read the voice profiles', async () => {
    const rows = (await ctx.store.list(
      'voice_profiles',
      ctx.auth.organizationId,
      {},
      { orderBy: [{ field: 'person_email', direction: 'asc' }] },
    )) as VoiceProfile[];
    const enrolled = await enrolledIds(
      ctx,
      rows.map((r) => r.id),
    );
    return ok(rows.map((r) => toView(r, enrolled.has(r.id))));
  });
}

export async function setVoiceConsent(
  ctx: NotesContext,
  input: VoiceConsentRequest,
): Promise<Result<VoiceProfileView>> {
  return guard('save the voice consent', async () => {
    const org = ctx.auth.organizationId;
    const email = input.email.toLowerCase();
    const own = email === (ctx.auth.profile.email ?? '').toLowerCase();
    const now = (ctx.now ?? new Date()).toISOString();
    const existing = await ctx.store.findOne('voice_profiles', org, {
      eq: { person_email: email, provider: 'speechmatics' },
    });

    if (input.action === 'grant') {
      if (input.evidence === 'self_checkbox' && !own) {
        return err(
          'invalid_input',
          'Only the person themselves can tick the box. For anyone else, record how they agreed (in writing, or a recorded yes).',
        );
      }
      const patch: Partial<VoiceProfile> = {
        display_name: input.name ?? existing?.display_name ?? null,
        user_id: own ? ctx.auth.userId : (existing?.user_id ?? null),
        consent_status: 'granted',
        consent_at: now,
        consent_evidence: input.evidence ?? null,
        consent_text_version: VOICE_CONSENT_TEXT_VERSION,
        consent_recorded_by: ctx.auth.userId,
        revoked_at: null,
      };
      const row = existing
        ? await ctx.store.update('voice_profiles', org, existing.id, patch)
        : await ctx.store.insert('voice_profiles', {
            id: newId(),
            organization_id: org,
            person_email: email,
            display_name: patch.display_name ?? null,
            crm_person_id: null,
            user_id: patch.user_id ?? null,
            provider: 'speechmatics',
            consent_status: 'granted',
            consent_at: now,
            consent_evidence: input.evidence ?? null,
            consent_text_version: VOICE_CONSENT_TEXT_VERSION,
            consent_recorded_by: ctx.auth.userId,
            enrolled_at: null,
            last_used_at: null,
            expires_at: null,
            revoked_at: null,
            created_at: now,
            updated_at: now,
          });
      await recordAudit(ctx.store, {
        organizationId: org,
        userId: ctx.auth.userId,
        action: 'voice.consent',
        entityType: 'voice_profile',
        entityId: row.id,
        metadata: {
          evidence: input.evidence ?? null,
          own,
          text_version: VOICE_CONSENT_TEXT_VERSION,
        },
      });
      const enrolled = await enrolledIds(ctx, [row.id]);
      return ok(toView(row, enrolled.has(row.id)));
    }

    if (!existing) return err('not_found', 'There is no voice consent on file for that person.');
    // Withdrawal deletes the identifier at once, before anything else.
    await ctx.store.removeWhere('voice_identifiers', org, {
      eq: { voice_profile_id: existing.id },
    });
    const row = await ctx.store.update('voice_profiles', org, existing.id, {
      consent_status: 'revoked',
      revoked_at: now,
      enrolled_at: null,
      expires_at: null,
    });
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'voice.revoke',
      entityType: 'voice_profile',
      entityId: row.id,
      metadata: { own },
    });
    return ok(toView(row, false));
  });
}

/* ============================================================ enrolment == */

const DAY_MS = 86_400_000;
const expiryFrom = (now: Date) =>
  new Date(now.getTime() + NOTES_LIMITS.voiceprintMaxDays * DAY_MS).toISOString();

async function consentedProfile(ctx: NotesContext, email: string): Promise<VoiceProfile | null> {
  const row = await ctx.store.findOne('voice_profiles', ctx.auth.organizationId, {
    eq: { person_email: email.toLowerCase(), provider: 'speechmatics' },
  });
  return row && row.consent_status === 'granted' && !row.revoked_at ? row : null;
}

const NO_CONSENT = () =>
  err(
    'forbidden',
    'There is no voice consent on file for that person, so their voice cannot be remembered.',
  );

/**
 * A speech session for one consented person's solo clip (5 to 30 seconds of
 * them talking alone). The recorder asks the vendor for that voice's
 * identifiers at the end and posts them to enrollVoice.
 */
export async function enrollmentSession(
  ctx: NotesContext,
  email: string,
): Promise<Result<{ provider: TranscriberProvider; session: SttSession }>> {
  return guard('start the voice clip', async () => {
    const profile = await consentedProfile(ctx, email);
    if (!profile) return NO_CONSENT();
    const transcriber = getTranscriber();
    const minted = await transcriber.mintSession({
      meetingId: profile.id,
      track: 'mic',
      language: 'en',
      knownSpeakers: [],
      vocabulary: [],
      purpose: 'enrollment',
      now: ctx.now,
    });
    if (!minted.ok) return minted;
    return ok({ provider: transcriber.provider, session: minted.value });
  });
}

/**
 * Store one consented person's voice identifiers, sealed with
 * VOICEPRINT_ENC_KEY, replacing any on file. Refused without consent; the
 * identifiers never appear in a log, an audit row or an answer.
 */
export async function enrollVoice(
  ctx: NotesContext,
  input: VoiceEnrollRequest,
): Promise<Result<VoiceProfileView>> {
  return guard('remember the voice', async () => {
    const profile = await consentedProfile(ctx, input.email);
    if (!profile) return NO_CONSENT();
    const sealed = sealIdentifiers(input.identifiers, profile.id);
    if (!sealed.ok) return sealed;
    const org = ctx.auth.organizationId;
    const now = ctx.now ?? new Date();
    await ctx.store.removeWhere('voice_identifiers', org, { eq: { voice_profile_id: profile.id } });
    await ctx.store.insert('voice_identifiers', {
      id: newId(),
      organization_id: org,
      voice_profile_id: profile.id,
      identifier_enc: sealed.value,
      model_version: input.modelVersion,
      created_at: now.toISOString(),
      expires_at: expiryFrom(now),
    });
    const row = await ctx.store.update('voice_profiles', org, profile.id, {
      enrolled_at: now.toISOString(),
      expires_at: expiryFrom(now),
    });
    await recordAudit(ctx.store, {
      organizationId: org,
      userId: ctx.auth.userId,
      action: 'voice.enrolled',
      entityType: 'voice_profile',
      entityId: profile.id,
      metadata: { identifiers: input.identifiers.length, model_version: input.modelVersion },
    });
    return ok(toView(row, true));
  });
}

/**
 * The enrolled, consented voices a meeting's speech session should
 * recognise: people on the invite plus the team, at most the vendor's 50.
 * Each is labelled with its profile's id, never a name. Using a voice moves
 * its expiry a year past today. Anything that cannot be read is skipped.
 */
export async function knownSpeakersFor(
  ctx: NotesContext,
  inviteEmails: readonly (string | null)[],
): Promise<KnownSpeaker[]> {
  const org = ctx.auth.organizationId;
  const now = ctx.now ?? new Date();
  const invited = new Set(
    inviteEmails.filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()),
  );
  const profiles = (
    (await ctx.store.list('voice_profiles', org, {
      eq: { consent_status: 'granted' },
      notNull: ['enrolled_at'],
    })) as VoiceProfile[]
  ).filter((p) => !p.revoked_at && (invited.has(p.person_email.toLowerCase()) || p.user_id));
  if (profiles.length === 0) return [];
  const rows = (await ctx.store.list('voice_identifiers', org, {
    in: { voice_profile_id: profiles.map((p) => p.id) },
  })) as VoiceIdentifier[];
  const out: KnownSpeaker[] = [];
  for (const profile of profiles) {
    if (out.length >= NOTES_LIMITS.maxVoiceIdentifiersPerSession) break;
    const row = rows.find((r) => r.voice_profile_id === profile.id);
    if (!row || Date.parse(row.expires_at) <= now.getTime()) continue;
    const opened = openIdentifiers(row.identifier_enc, profile.id);
    if (!opened.ok) {
      log.warn('Copilot Notes: a voice identifier could not be opened', { profile: profile.id });
      continue;
    }
    out.push({ label: profile.id, identifiers: opened.value });
  }
  const used = out.map((k) => k.label);
  if (used.length) {
    const expires = expiryFrom(now);
    await ctx.store.updateWhere(
      'voice_profiles',
      org,
      { in: { id: used } },
      { last_used_at: now.toISOString(), expires_at: expires },
    );
    await ctx.store.updateWhere(
      'voice_identifiers',
      org,
      { in: { voice_profile_id: used } },
      { expires_at: expires },
    );
  }
  return out;
}

/**
 * Delete every voice identifier past its expiry (a year after last use) and
 * mark its profile no longer enrolled. Consent stays on file; the voice must
 * be recorded again to be remembered again.
 */
export async function purgeExpiredVoices(
  store: DataStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  const expired = (await store.list('voice_identifiers', organizationId, {
    lt: { expires_at: now.toISOString() },
  })) as VoiceIdentifier[];
  if (expired.length === 0) return 0;
  const profiles = [...new Set(expired.map((r) => r.voice_profile_id))];
  await store.removeWhere('voice_identifiers', organizationId, {
    lt: { expires_at: now.toISOString() },
  });
  await store.updateWhere(
    'voice_profiles',
    organizationId,
    { in: { id: profiles } },
    {
      enrolled_at: null,
    },
  );
  for (const id of profiles) {
    await recordAudit(store, {
      organizationId,
      userId: null,
      action: 'voice.expired',
      entityType: 'voice_profile',
      entityId: id,
      metadata: {},
    });
  }
  return expired.length;
}
