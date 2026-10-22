import 'server-only';
import { recordAudit } from '@/lib/security/audit';
import {
  VOICE_CONSENT_TEXT_VERSION,
  type VoiceConsentRequest,
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
