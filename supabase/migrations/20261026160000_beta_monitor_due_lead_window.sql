-- Monitor: a build started in the scheduler's lead window satisfies the slot it precedes.
-- PROPOSED; applied only to disposable local databases until the authorized release.
-- Release order: after 20261025121000_beta_monitor_due_pause.sql (redefines its function).
--
-- private.beta_expected_digest_due (20261025121000) judged each slot by
-- private.beta_ran_on_local_day: a run or attempt on the slot's local calendar day. But
-- digest_schedules keeps one last_run_at / last_attempt_at, and the scheduler
-- (supabase/functions/digest-run/handler.js, BUILD_LEAD_HOURS = 1) may start tomorrow's
-- build up to an hour before the reader's hour. That build overwrites both stamps with a
-- timestamp on the next local day, so for the rest of the hour the monitor held no
-- evidence that yesterday's slot ran: ran_slot and ran_prev were both false, a long-active
-- account fell to the "stuck" branch (due at the previous slot, two days back), the
-- schedule check recorded overdue, and beta_monitor_record opened an incident at once
-- (that branch has no three-sample requirement). When the hour arrived the slot rolled
-- over, ran_slot became true, and the check "recovered".
--
-- Seen on production: the Australia/Melbourne account (hour 6) started its 2026-10-27
-- build at 2026-10-26 18:02:31Z (05:02 local); samples read overdue from 18:05Z to 18:55Z,
-- an incident email went out at 18:05Z and a recovery at 19:00Z when the slot became
-- Oct 27 06:00 local. The 2026-10-25 23:05Z blip was the same mechanism. The New York
-- cohort (hour 5 or 6, builds about 09:20Z) only escaped on 2026-10-26 because the
-- previous migration's monitor_started_at = now() reset put their activation more than
-- twelve hours after the previous slot.
--
-- Rule: a run or attempt at or after slot - BUILD_LEAD_HOURS (1 hour) also satisfies the
-- slot, for ran_slot and ran_prev alike. The monitor exists to detect a dead scheduler; a
-- build that started in the lead window proves it alive, and the single-column schema
-- cannot tell "ran yesterday and started today early" from "skipped yesterday and started
-- today early". The paused_at, invalid-timezone, and 12-hour activation branches are
-- unchanged, and beta_ran_on_local_day keeps its definition. No re-activation: the
-- expectation only widens, so no account becomes due that was not already.
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
   select e.*,
          case when (x.today_local at time zone e.timezone) <= p_at then x.today_local else x.today_local - interval '1 day' end as slot_local
   from eligible e
   cross join lateral (select date_trunc('day', p_at at time zone e.timezone) + e.hour_local * interval '1 hour' as today_local) x
 ), judged as (
   select s.user_id, s.activated_at,
          (s.slot_local at time zone s.timezone) as slot,
          ((s.slot_local - interval '1 day') at time zone s.timezone) as prev,
          ((s.slot_local + interval '1 day') at time zone s.timezone) as next,
          private.beta_ran_on_local_day(s.last_run_at, s.last_attempt_at, s.timezone, s.slot_local - interval '1 day')
            or coalesce(s.last_run_at, '-infinity') >= ((s.slot_local - interval '1 day') at time zone s.timezone) - interval '1 hour'
            or coalesce(s.last_attempt_at, '-infinity') >= ((s.slot_local - interval '1 day') at time zone s.timezone) - interval '1 hour'
            as ran_prev,
          private.beta_ran_on_local_day(s.last_run_at, s.last_attempt_at, s.timezone, s.slot_local)
            or coalesce(s.last_run_at, '-infinity') >= (s.slot_local at time zone s.timezone) - interval '1 hour'
            or coalesce(s.last_attempt_at, '-infinity') >= (s.slot_local at time zone s.timezone) - interval '1 hour'
            as ran_slot
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
