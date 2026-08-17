-- scheduling-reply@1.0.0: meeting-logistics drafts written in the EA's voice.
-- Additive and idempotent, like every migration in this repository.
alter type draft_kind add value if not exists 'scheduling';
