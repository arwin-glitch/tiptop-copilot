-- The perks assistant's one-time answer key (D-079, amended): same design the
-- job board assistant shipped the same day. The key is fired with each
-- question and must be echoed in the answer; only its SHA-256 is kept here,
-- and settling clears it so the key works once. With the key verified
-- timing-safely, the routine may post as the SAME Slack account the other
-- routines use - a forged post without the key settles nothing - so the
-- perks routine no longer needs a Slack account of its own.
--
-- Additive and idempotent like every migration here: safe to run again.

alter table perks_chat_questions add column if not exists answer_key_hash text;
alter table perks_chat_questions drop constraint if exists perks_chat_questions_answer_key_shape;
alter table perks_chat_questions add constraint perks_chat_questions_answer_key_shape
  check (answer_key_hash is null or answer_key_hash ~ '^[0-9a-f]{64}$');

comment on column perks_chat_questions.answer_key_hash is
  'SHA-256 hex of the one-time key fired with the question; cleared once the answer settles.';
