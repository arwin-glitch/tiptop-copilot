import Link from 'next/link';
import { partyLabel, type IntroParty } from '@/lib/crm/affinity-introductions';
import { recordPath } from '@/lib/crm/cadence';
import { getStore } from '@/lib/runtime';
import { introductionsForRecord, type IntroductionLine } from '@/lib/services/introductions';
import type { CrmRecord } from '@/lib/types/domain';
import { formatDate } from '@/lib/util/time';
import { SectionHeading } from '@/components/shell/page-header';

const SHOWN = 8;

/**
 * Introductions on a profile, from Affinity's introductions export: who
 * introduced this company or person, and whom they introduced. Nothing is
 * shown until an introductions export has been imported, so a profile
 * without any does not grow an empty section.
 */
export async function RecordIntroductions({
  record,
  organizationId,
  timezone,
}: {
  record: Pick<CrmRecord, 'id' | 'kind' | 'name' | 'emails' | 'domain'>;
  organizationId: string;
  timezone: string;
}) {
  const found = await introductionsForRecord(getStore(), organizationId, record);
  if (!found.ok) return null;
  const { introducedBy, introduced } = found.value;
  if (!introducedBy.length && !introduced.length) return null;
  return (
    <section aria-labelledby="profile-introductions">
      <SectionHeading count={introducedBy.length + introduced.length}>
        <span id="profile-introductions">Introductions</span>
      </SectionHeading>
      <div className="space-y-4">
        {introducedBy.length ? (
          <IntroGroup title="Introduced by" lines={introducedBy} timezone={timezone} />
        ) : null}
        {introduced.length ? (
          <IntroGroup title="Introduced" lines={introduced} timezone={timezone} />
        ) : null}
      </div>
    </section>
  );
}

function IntroGroup({
  title,
  lines,
  timezone,
}: {
  title: string;
  lines: IntroductionLine[];
  timezone: string;
}) {
  return (
    <div>
      <h3 className="text-mini mb-1.5 font-semibold text-[var(--fg-subtle)] uppercase">
        {title}
        <span className="tabular ml-1.5 font-normal">{lines.length}</span>
      </h3>
      <ul className="space-y-1.5">
        {lines.slice(0, SHOWN).map((line) => (
          <li key={`${line.intro}-${line.party.email ?? line.party.name}`} className="text-sm">
            <Party party={line.party} recordId={line.partyRecordId} />
            {line.others.length ? (
              <span className="text-[var(--fg-muted)]">
                {' '}
                with {line.others.map((p) => partyLabel(p)).join(', ')}
              </span>
            ) : null}
            <span className="text-mini block text-[var(--fg-subtle)]">
              {line.date ? formatDate(`${line.date}T12:00:00.000Z`, timezone) : 'No date'}
              {line.evidence === 'email'
                ? ' · seen in email'
                : line.evidence === 'chat'
                  ? ' · seen in chat'
                  : ' · set in Affinity'}
            </span>
          </li>
        ))}
      </ul>
      {lines.length > SHOWN ? (
        <p className="text-mini mt-1.5 text-[var(--fg-subtle)]">And {lines.length - SHOWN} more.</p>
      ) : null}
    </div>
  );
}

function Party({ party, recordId }: { party: IntroParty; recordId: string | null }) {
  const label = partyLabel(party);
  return recordId ? (
    <Link
      href={recordPath(recordId)}
      className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
    >
      {label}
    </Link>
  ) : (
    <span className="font-medium">{label}</span>
  );
}
