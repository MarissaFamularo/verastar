-- Day-30 survey for readers who get no digest.
-- PROPOSED; applied only to disposable local databases until an authorized release
-- (docs/DIGEST_DELIVERY.md § Release: day-30 survey outside the digest).
--
-- The day-30 invitation rides in the digest email, so readers who get no digest never see
-- it: on 2026-11-18, 25 of the 50 testers reaching day 30 by 2026-11-25 (14 paused by the
-- scheduler, 8 with no schedule row, 3 unsubscribed). digest-run now sends those readers one
-- standalone survey email (unsubscribed readers excluded). This column is the "once": the
-- scheduler claims it with a compare-and-set before sending, so overlapping cron ticks cannot
-- both send and a failed send is not retried.
--
-- Service-owned. Not granted to authenticated (the column grant on sponsored_accounts stays
-- user_id, active, ends_at); service_role already has table-level select and update.
--
-- Apply BEFORE deploying digest-run: without the column the scheduler's select fails and it
-- sends no survey email (digests are unaffected either way).
--
-- Rollback: alter table public.sponsored_accounts drop column if exists day30_survey_emailed_at;
begin;
alter table public.sponsored_accounts add column if not exists day30_survey_emailed_at timestamptz;
comment on column public.sponsored_accounts.day30_survey_emailed_at is
  'When digest-run sent the one standalone day-30 survey email to a reader who was getting no digest. Service-owned; set once, before sending.';
commit;
