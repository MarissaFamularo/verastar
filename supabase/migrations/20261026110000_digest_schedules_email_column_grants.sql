-- digest_schedules has column-level grants (20260917190000_digest_schedules.sql): a reader
-- may select and write only named columns. The four columns added by
-- 20261025120000_digest_unopened_pause.sql were not granted, so the Settings page's select
-- (src/lib/digestSchedule.js) failed with "permission denied for table digest_schedules" for
-- every signed-in reader, and the checkboxes rendered unchecked. Reported 2026-10-26 05:58 ET,
-- applied to the live project the same morning.
--
-- Readers may read all four and write only their email switch; unopened_streak, paused_at
-- and delivered_day stay service-role writes (the "a reader resetting the streak" note in the
-- earlier migration was wrong: the column grants never allowed it).
begin;

grant select (unopened_streak, paused_at, email_digest, delivered_day) on public.digest_schedules to authenticated;
grant insert (email_digest) on public.digest_schedules to authenticated;
grant update (email_digest) on public.digest_schedules to authenticated;

commit;
