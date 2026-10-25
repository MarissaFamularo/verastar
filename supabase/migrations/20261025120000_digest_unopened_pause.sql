-- Scheduler: pause after seven consecutive unopened digests, instead of after one.
-- PROPOSED; applied only to disposable local databases until the authorized release.
--
-- Until now digest-run refused to replace a finished digest nobody had opened
-- (schedulerMayRun, src/lib/digestStore.js). With no delivery channel that rule froze every
-- account after its first missed morning: on 2026-10-25, 39 of the 40 enabled beta schedules
-- sat on an unopened digest, 32 of them for two days or more (docs/DIGEST_DELIVERY.md).
--
-- Two additive columns, written only by the service role from digest-run/handler.js:
--
--   unopened_streak  how many finished digests with papers, in a row, were replaced without
--                    ever being opened. Stamped when a scheduled run claims the account:
--                    0 when the previous digest was opened (or the reader pressed "run now"),
--                    +1 when it was not, unchanged when the previous day was empty or the run
--                    is resuming mid-flight.
--   paused_at        set when the streak reaches PAUSE_AFTER_UNOPENED (handler.js, 7) and the
--                    scheduler stops starting new runs for the account; cleared on the next
--                    scheduled run, which happens as soon as the reader opens the digest
--                    (the app stamps openedAt) or presses "run now".
--
--   email_digest     the reader's email switch (Settings, or the signed unsubscribe link,
--                    supabase/functions/digest-unsubscribe). digest-run sends nothing to an
--                    account with it off. Default on: delivery is the point of the schedule,
--                    and every email carries the one-click way off.
--
-- Readers may select all three through the existing own-row policy so Settings can show
-- them, and update email_digest through the update-own policy (that is the Settings switch).
-- A reader resetting the streak only resumes their own digest, which "run now" already
-- does. No function changes; rollback drops the columns.
begin;

alter table public.digest_schedules
  add column if not exists unopened_streak integer not null default 0,
  add column if not exists paused_at       timestamptz,
  add column if not exists email_digest    boolean not null default true;

comment on column public.digest_schedules.unopened_streak is
  'Consecutive finished digests with papers that were replaced unopened (digest-run stamps it at claim time).';
comment on column public.digest_schedules.paused_at is
  'Set when unopened_streak reached the pause threshold; the scheduler starts no new run until the reader opens the digest.';
comment on column public.digest_schedules.email_digest is
  'Email each finished scheduled digest to the account address. Off by the Settings switch or the signed unsubscribe link; the in-app digest is unaffected.';

commit;
