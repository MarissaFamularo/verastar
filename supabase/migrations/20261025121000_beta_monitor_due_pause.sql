-- Monitor: expect a scheduled digest every local day unless the account is paused.
-- PROPOSED; applied only to disposable local databases until the authorized release.
-- Release order: after 20261025120000_digest_unopened_pause.sql (reads paused_at).
--
-- private.beta_expected_digest_due (20261015183000_beta_expected_work.sql) encoded the
-- freeze rule: an account sitting on an unopened digest was not expected to run, and
-- opening the digest "activated" it. Under the pause rule (docs/DIGEST_DELIVERY.md) the
-- scheduler replaces an unopened digest every morning and stops only at paused_at, so the
-- old model would have been wrong both ways after the release: silent about a scheduler
-- that stops serving the 39 unopened accounts, and loud for the whole first morning while
-- they caught up one at a time (each run looked days overdue until it finished). It also
-- flagged every catch-up run in flight, the "schedule: failed" seen on 2026-10-25 23:05Z.
--
-- The model now mirrors the handler's gates:
--   slot        the latest occurrence of the account's local hour at p_at (today's if
--               reached, else yesterday's). A run or attempt on the slot's local day
--               satisfies it (the handler's ranToday); the next expectation is the next slot.
--   missed      nothing ran or was attempted on the slot's day. Due at the slot, or at
--               activation when the account was activated after the slot and within the
--               handler's CATCH_UP_HOURS (12; a later activation waits for the next slot).
--   stuck       the previous slot was also expected and missed: due stays at the previous
--               slot, so a dead scheduler does not read as recovered for two hours every
--               morning.
--   paused      paused_at set: not expected at all. Resuming clears paused_at.
-- Activation is greatest(monitor_started_at, account created_at); opening a digest no
-- longer activates anything. An unfinished scheduler run counts as an attempt (the handler
-- stamps last_attempt_at on every finished tick), so a run in flight is never overdue.
--
-- Re-activation: every enabled schedule gets monitor_started_at = now(), because the
-- expectation changed at this moment. Accounts the old rule had frozen for days are
-- expected from their next slot, or now if their hour was within the last twelve hours,
-- which is exactly when the deployed handler will run them.
--
-- Rollback: re-run the definition in 20261015183000_beta_expected_work.sql.
begin;

create or replace function private.beta_ran_on_local_day(p_run timestamptz, p_attempt timestamptz, p_tz text, p_day_local timestamp)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(date_trunc('day', p_run at time zone p_tz) = date_trunc('day', p_day_local), false)
     or coalesce(date_trunc('day', p_attempt at time zone p_tz) = date_trunc('day', p_day_local), false)
$$;
revoke all on function private.beta_ran_on_local_day(timestamptz,timestamptz,text,timestamp) from public,anon,authenticated;

create or replace function private.beta_expected_digest_due(p_at timestamptz)
returns table(user_id uuid, due_at timestamptz) language sql stable security definer set search_path='' as $$
 with eligible as (
   select d.user_id, d.timezone, d.hour_local, d.last_run_at, d.last_attempt_at,
          greatest(d.monitor_started_at, s.created_at) as activated_at
   from public.digest_schedules d join public.sponsored_accounts s using(user_id)
   where d.enabled and s.active and (s.ends_at is null or s.ends_at > p_at)
     and d.paused_at is null
     and exists(select 1 from pg_catalog.pg_timezone_names z where z.name = d.timezone)
 ), slotted as (
   select e.*,
          case when (x.today_local at time zone e.timezone) <= p_at then x.today_local else x.today_local - interval '1 day' end as slot_local
   from eligible e
   cross join lateral (select date_trunc('day', p_at at time zone e.timezone) + e.hour_local * interval '1 hour' as today_local) x
 ), judged as (
   select s.user_id, s.activated_at,
          (s.slot_local at time zone s.timezone) as slot,
          ((s.slot_local - interval '1 day') at time zone s.timezone) as prev,
          ((s.slot_local + interval '1 day') at time zone s.timezone) as next,
          private.beta_ran_on_local_day(s.last_run_at, s.last_attempt_at, s.timezone, s.slot_local - interval '1 day') as ran_prev,
          private.beta_ran_on_local_day(s.last_run_at, s.last_attempt_at, s.timezone, s.slot_local) as ran_slot
   from slotted s
 )
 select user_id,
   case
     when ran_slot then next
     when activated_at <= prev and not ran_prev then prev
     when activated_at <= slot then slot
     when activated_at < slot + interval '12 hours' then activated_at
     else next
   end
 from judged;
$$;
revoke all on function private.beta_expected_digest_due(timestamptz) from public,anon,authenticated;
grant execute on function private.beta_expected_digest_due(timestamptz) to service_role;

update public.digest_schedules set monitor_started_at = now() where enabled;

commit;
