-- Monitor: a digest built in the hour before the reader's hour satisfies that morning.
-- Release order: after 20261025121000_beta_monitor_due_pause.sql.
--
-- Since 018e6fa the scheduler starts a build BUILD_LEAD_HOURS (1) before the reader's hour
-- (digest-run/handler.js, digestGate in functions/model/logic.js) and emails it at the hour.
-- private.beta_expected_digest_due still moved to today's slot only at the hour itself. In
-- the lead hour it was judging yesterday's slot, but last_run_at already held today's
-- early build, so yesterday looked missed and the account read as many hours overdue.
-- That was the "schedule: failed" on 2026-10-26 23:35Z: two Asia/Calcutta readers built at
-- 05:02 local for a 06:00 slot, after both had run and been emailed on 2026-10-26.
--
-- The one change: today's slot becomes the slot to judge once its build window opens, at
-- greatest(0, hour_local - 1) local, the same floor the gate uses (a midnight reader gets
-- no lead). Due times are unchanged: an expected run is still due at the reader's hour, so
-- a build window that has opened but not yet been served is never overdue. A missed
-- yesterday still keeps the account due at yesterday's slot (the "stuck" rule).
--
-- Rollback: re-run the definition in 20261025121000_beta_monitor_due_pause.sql.
begin;

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
   -- Lead hours (1) mirror BUILD_LEAD_HOURS in supabase/functions/digest-run/handler.js.
   select e.*,
          case when (x.window_local at time zone e.timezone) <= p_at then x.today_local else x.today_local - interval '1 day' end as slot_local
   from eligible e
   cross join lateral (select date_trunc('day', p_at at time zone e.timezone) as day_local) d
   cross join lateral (select d.day_local + e.hour_local * interval '1 hour' as today_local,
                              d.day_local + greatest(0, e.hour_local - 1) * interval '1 hour' as window_local) x
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

commit;
