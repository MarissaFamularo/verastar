-- Monitor cadence independently of demand. No changes to scheduler eligibility/policy.
begin;
alter table private.beta_monitor_samples drop constraint beta_monitor_samples_check_name_check;
alter table private.beta_monitor_samples add constraint beta_monitor_samples_check_name_check check(check_name in ('signup','digest','heartbeat','schedule'));
-- Stable monitoring activation. Existing schedules get a rollout grace period;
-- failed attempts updating updated_at must never postpone expected work.
alter table public.digest_schedules add column monitor_started_at timestamptz not null default now();
create function private.beta_schedule_monitor_start() returns trigger language plpgsql set search_path='' as $$
begin
 if new.enabled is distinct from old.enabled or new.hour_local is distinct from old.hour_local or new.timezone is distinct from old.timezone then new.monitor_started_at:=now(); end if;
 return new;
end $$;
revoke all on function private.beta_schedule_monitor_start() from public,anon,authenticated;
create trigger beta_schedule_monitor_start before update on public.digest_schedules for each row execute function private.beta_schedule_monitor_start();
-- A completion suppresses its entire local day. Activation/opening may run
-- the same day once the configured hour is reached. Unopened completed digests intentionally suspend generation.
-- No weekly cadence/next-due column exists in the current scheduler schema.
create function private.beta_monitor_timestamp(v text) returns timestamptz
language plpgsql stable set search_path='' as $$ begin return v::timestamptz; exception when others then return null; end $$;
revoke all on function private.beta_monitor_timestamp(text) from public,anon,authenticated;
create function private.beta_expected_digest_due(p_at timestamptz)
returns table(user_id uuid, due_at timestamptz) language sql stable security definer set search_path='' as $$
 with eligible as (
 select d.*, k.value,
 greatest(d.last_run_at,
 case when jsonb_array_length(case when jsonb_typeof(k.value->'results')='array' then k.value->'results' else '[]'::jsonb end)>0
 and not coalesce(k.value->>'runBy'='scheduler' and nullif(k.value#>>'{server,phase}','') is not null and k.value#>>'{server,phase}'<>'done',false)
 then private.beta_monitor_timestamp(coalesce(k.value->>'ranAt',k.value->>'savedAt')) end) completed_at,
 greatest(d.monitor_started_at,s.created_at,private.beta_monitor_timestamp(k.value->>'openedAt')) activated_at
 from public.digest_schedules d join public.sponsored_accounts s using(user_id)
 left join public.kv k on k.user_id=d.user_id and k.collection='digests' and k.key='daily:latest'
 where d.enabled and s.active and (s.ends_at is null or s.ends_at>p_at)
 and exists(select 1 from pg_catalog.pg_timezone_names z where z.name=d.timezone)
 and not coalesce(k.value->>'kind'='daily' and k.value->>'openedAt' is null
 and jsonb_array_length(case when jsonb_typeof(k.value->'results')='array' then k.value->'results' else '[]'::jsonb end)>0
 and not coalesce(k.value->>'runBy'='scheduler' and nullif(k.value#>>'{server,phase}','') is not null and k.value#>>'{server,phase}'<>'done',false),false)
 ) select user_id, greatest(
 (date_trunc('day',completed_at at time zone timezone)+interval '1 day'+hour_local*interval '1 hour') at time zone timezone,
 (date_trunc('day',activated_at at time zone timezone)+hour_local*interval '1 hour') at time zone timezone,
 activated_at) from eligible;
$$;
revoke all on function private.beta_expected_digest_due(timestamptz) from public,anon,authenticated;
grant execute on function private.beta_expected_digest_due(timestamptz) to service_role;
create or replace function public.beta_monitor_record(p_check text,p_ok boolean,p_code text)
returns void language plpgsql security definer set search_path='' as $$
declare s private.beta_incidents%rowtype; bad_count integer;
begin
 perform pg_catalog.pg_advisory_xact_lock(7243100003);
 insert into private.beta_monitor_samples(check_name,ok,code) values(p_check,p_ok,p_code);
 insert into private.beta_incidents(check_name) values(p_check) on conflict do nothing;
 select * into s from private.beta_incidents where check_name=p_check for update;
 select count(*) into bad_count from private.beta_monitor_samples
 where check_name=p_check and not ok and checked_at>now()-interval '30 minutes'
 and checked_at>coalesce((select max(checked_at) from private.beta_monitor_samples where check_name=p_check and ok),'-infinity');
 if not p_ok and (p_check='schedule' and p_code='overdue' or bad_count>=3 and exists(select 1 from private.beta_monitor_samples where check_name=p_check and not ok and checked_at<=now()-interval '5 minutes' and checked_at>now()-interval '30 minutes' and checked_at>coalesce((select max(checked_at) from private.beta_monitor_samples where check_name=p_check and ok),'-infinity'))) then
   if s.state<>'failed' then
     s.opened_at:=now();
     insert into private.beta_alert_outbox(check_name,incident_at,kind) values(p_check,s.opened_at,'incident') on conflict do nothing;
   end if;
   update private.beta_incidents set state='failed',opened_at=s.opened_at,recovered_at=null,last_checked_at=now() where check_name=p_check;
 elsif p_ok then
   if s.state='failed' then
     insert into private.beta_alert_outbox(check_name,incident_at,kind) values(p_check,s.opened_at,'recovery') on conflict do nothing;
   end if;
   update private.beta_incidents set state='ok',recovered_at=case when s.state='failed' then now() else recovered_at end,last_checked_at=now() where check_name=p_check;
 else
   update private.beta_incidents set state=case when state='failed' then state else 'unknown' end,last_checked_at=now() where check_name=p_check;
 end if;
end $$;
revoke all on function public.beta_monitor_record(text,boolean,text) from public,anon,authenticated;
grant execute on function public.beta_monitor_record(text,boolean,text) to service_role;


create or replace function public.beta_monitor_tick()
returns void language plpgsql security definer set search_path='' as $$
declare overdue boolean; invalid_timezone boolean;
begin
 -- A single due slot beyond two hours is already sustained evidence. No retry
 -- counter is needed; a monitor invocation is not a new digest attempt.
 select exists(select 1 from private.beta_expected_digest_due(now()) where due_at<now()-interval '2 hours') into overdue;
 select exists(select 1 from public.digest_schedules d join public.sponsored_accounts a using(user_id) where d.enabled and a.active and (a.ends_at is null or a.ends_at>now()) and not exists(select 1 from pg_catalog.pg_timezone_names z where z.name=d.timezone)) into invalid_timezone;
 perform public.beta_monitor_record('schedule',not overdue and not invalid_timezone,case when overdue then 'overdue' when invalid_timezone then 'unavailable' else 'ok' end);
 perform public.beta_monitor_record('heartbeat',true,'ok');
end $$;
create or replace function public.beta_release_stats(p_from timestamptz,p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare base jsonb; adoption jsonb; spend jsonb; survey jsonb; health jsonb; coverage timestamptz;
begin
 -- Existing RPC validates range and private.beta_admins authorization first.
 base:=public.beta_admin_stats(p_from,p_to);
 select started_at into coverage from private.beta_measurement where id;
 with people as (
   select * from public.sponsored_accounts s where not private.beta_is_test(s.user_id,s.created_at,s.cohort)
 ), activity as (
   select distinct e.user_id,(e.ts at time zone 'UTC')::date as day,e.ts
   from public.events e join people s on s.user_id=e.user_id
   where e.type in ('digest_opened','digest_viewed','digest_item_opened','paper_favorited','paper_shared','badge_clicked')
   and e.ts>=s.created_at and e.ts<=now() and not private.beta_is_test(e.user_id,e.ts)
 ), eligible as (
   select * from people where created_at>=coverage and created_at<=now()-interval '14 days'
 ), retained as (
   select s.user_id from eligible s where exists(select 1 from activity a where a.user_id=s.user_id
    and a.ts>=s.created_at+interval '7 days' and a.ts<s.created_at+interval '14 days')
 )
 select jsonb_build_object('signups',(select count(*) from people),
 'active72',(select count(distinct user_id) from activity where ts>=now()-interval '72 hours'),
 'returned',(select count(*) from (select user_id from activity group by user_id having count(distinct day)>1) r),
 'eligible',(select count(*) from eligible),'retained',(select count(*) from retained),
 'coverage_since',coverage,'complete72',coverage<=now()-interval '72 hours',
 'access_now',(select count(*) from people where active and (ends_at is null or ends_at>now()))) into adoption;
 with costs as (select * from public.model_spend where not cache_hit),
 finished as (
   select distinct user_id,(ts at time zone 'UTC')::date as day from public.events
   where type='digest_scheduled_run' and payload->>'phase'='done' and coalesce(payload->>'claimLost','')<>'true' and ts>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' and ts<=now()
 ), browser as (
   select count(*) n from public.events e where type='digest_run' and coalesce(payload->>'showcase','')<>'true'
   and coalesce(payload->>'append','')<>'true' and private.beta_payload_count(payload,'papers')>0
   and ts>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' and ts<=now()
   and exists(select 1 from public.sponsored_accounts s where s.user_id=e.user_id)
 )
 select jsonb_build_object(
 'today',coalesce(sum(usd) filter(where ts>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' and ts<=now()),0),
 'month',coalesce(sum(usd) filter(where ts>=date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' and ts<=now()),0),
 'completed',(select count(*) from finished)+(select n from browser),
 'outstanding',(select coalesce(sum(reserved_micro),0)::numeric/1000000 from public.spend_reservations where state in ('reserved','ambiguous')),
 'released_unknown',(select count(*) from public.spend_reservations where state='released'),
 'credit_balance',null,'cash_charge',null,
 'first_record',(select min(ts) from public.model_spend)) into spend from costs;
 with r as (
 select r.* from public.beta_survey_responses r
 where wave='signup' and not private.beta_is_test(r.user_id,r.responded_at,r.cohort)
 -- Known smoke user's survey was recorded under the original beta cohort; exclude that
 -- survey only, without changing the account or relabeling historical real-use events.
 and not exists(select 1 from public.sponsored_accounts s where s.user_id=r.user_id and s.cohort='smoke-qa-20261015')
 ), ranged as (select * from r where responded_at>=p_from and responded_at<p_to)
 select jsonb_build_object('completed',(select count(*) from ranged where status='completed'),
 'skipped',(select count(*) from ranged where status='skipped'),
 'completed_all_time',(select count(*) from r where status='completed'),
 'reason',(select coalesce(jsonb_object_agg(k,n),'{}') from(select reason k,count(*) n from ranged where status='completed' group by 1)x),
 'read_frequency',(select coalesce(jsonb_object_agg(k,n),'{}') from(select read_frequency k,count(*) n from ranged where status='completed' group by 1)x),
 'weekly_time',(select coalesce(jsonb_object_agg(k,n),'{}') from(select weekly_time k,count(*) n from ranged where status='completed' group by 1)x),
 'confidence',(select coalesce(jsonb_object_agg(k,n),'{}') from(select confidence::text k,count(*) n from ranged where status='completed' group by 1)x)) into survey;
 select jsonb_build_object('checks',coalesce((select jsonb_agg(jsonb_build_object('name',n,'state',case when i.last_checked_at is null then 'unknown' when n in ('heartbeat','schedule') and i.state<>'failed' and i.last_checked_at<now()-interval '15 minutes' then 'stale' else i.state end,'checked_at',i.last_checked_at)) from unnest(array['signup','digest','heartbeat','schedule']) n left join private.beta_incidents i on i.check_name=n),'[]'),
 'alerts_enabled',(select enabled from private.beta_alert_config where id),
 'mail_failed',exists(select 1 from private.beta_alert_outbox where delivery_error and sent_at is null),
 'pending_emails',(select count(*) from private.beta_alert_outbox where sent_at is null)) into health;
 return base || jsonb_build_object('adoption',adoption,'spend',spend,'survey',survey,'health',health);
end $$;
revoke all on function public.beta_release_stats(timestamptz,timestamptz) from public,anon;
grant execute on function public.beta_release_stats(timestamptz,timestamptz) to authenticated,service_role;


commit;
