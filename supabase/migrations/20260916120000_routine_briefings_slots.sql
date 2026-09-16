-- Split the single routine_briefings row into independent slots keyed on
-- (organization_id, kind) instead of organization_id alone, so the
-- afternoon Recap's post only replaces the morning brief and leaves the
-- day's meeting dossier untouched. Previously a single row per organization
-- meant every post — brief or dossier — overwrote whatever was there.
--
-- 'dossier' joins 'morning'/'afternoon' as a third kind: the Daily
-- Overview now posts it as a second, independent write alongside the
-- morning brief.

alter table routine_briefings
  drop constraint routine_briefings_organization_id_key;

alter table routine_briefings
  add constraint routine_briefings_organization_id_kind_key unique (organization_id, kind);

alter table routine_briefings
  drop constraint routine_briefings_kind_check;

alter table routine_briefings
  add constraint routine_briefings_kind_check check (kind in ('morning', 'afternoon', 'dossier'));
