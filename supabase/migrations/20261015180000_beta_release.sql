-- Forward-only beta release. No account changes, no scheduling or spending-policy changes.
begin;
create table private.beta_measurement (
 id boolean primary key default true check(id), started_at timestamptz not null default now()
);
insert into private.beta_measurement(id) values(true);
create table private.beta_test_exclusions (
 user_id uuid not null references auth.users(id), starts_at timestamptz not null,
 ends_at timestamptz, reason text not null, primary key(user_id, starts_at),
 check(ends_at is null or ends_at > starts_at)
);
-- Exclusions are explicit time intervals; never infer a test person from their name/email.
-- The known smoke cohort is excluded at enrollment and its historical survey separately.
create function private.beta_is_test(p_user uuid, p_at timestamptz, p_cohort text default null)
returns boolean language sql stable set search_path='' as $$
 select coalesce(p_cohort = 'smoke-qa-20261015',false) or exists(
 select 1 from private.beta_test_exclusions where user_id=p_user and p_at>=starts_at and (ends_at is null or p_at<ends_at))
$$;
create table private.beta_monitor_samples (
 id bigint generated always as identity primary key, checked_at timestamptz not null default now(),
 check_name text not null check(check_name in ('signup','digest','heartbeat')),
 ok boolean not null, code text not null check(code in ('ok','unavailable','overdue','failed'))
);
create table private.beta_incidents (
 check_name text primary key, opened_at timestamptz, recovered_at timestamptz,
 last_checked_at timestamptz, state text not null default 'unknown'
);
create table private.beta_alert_outbox (
 id uuid primary key default gen_random_uuid(), check_name text not null,
 incident_at timestamptz not null, kind text not null check(kind in ('incident','recovery')),
 created_at timestamptz not null default now(), sent_at timestamptz,
 attempts integer not null default 0, last_attempt_at timestamptz, delivery_error boolean not null default false,
 unique(check_name,incident_at,kind)
);
-- Configure only during an approved release. No recipient or transport is seeded.
create table private.beta_alert_config (
 id boolean primary key default true check(id), enabled boolean not null default false
);
insert into private.beta_alert_config(id) values(true);
-- No client privileges on operational data, exclusions, or alert configuration.
do $$ declare t text; begin
 foreach t in array array['beta_measurement','beta_test_exclusions','beta_monitor_samples','beta_incidents','beta_alert_outbox','beta_alert_config'] loop
 execute format('alter table private.%I enable row level security', t);
 execute format('revoke all on private.%I from public, anon, authenticated',t);
 execute format('grant all on private.%I to service_role',t);
 end loop;
end $$;
grant usage, select on sequence private.beta_monitor_samples_id_seq to service_role;
revoke all on function private.beta_is_test(uuid,timestamptz,text) from public,anon,authenticated;

-- Service-only observations. A single bad sample never makes a sustained incident.
create function public.beta_monitor_record(p_check text,p_ok boolean,p_code text)
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
 if not p_ok and bad_count>=3 and exists(select 1 from private.beta_monitor_samples where check_name=p_check and not ok and checked_at<=now()-interval '5 minutes' and checked_at>now()-interval '30 minutes' and checked_at>coalesce((select max(checked_at) from private.beta_monitor_samples where check_name=p_check and ok),'-infinity')) then
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

create function public.beta_release_stats(p_from timestamptz,p_to timestamptz)
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
 select jsonb_build_object('checks',coalesce((select jsonb_agg(jsonb_build_object('name',n,'state',case when i.last_checked_at is null then 'unknown' when i.last_checked_at<now()-interval '15 minutes' then 'stale' else i.state end,'checked_at',i.last_checked_at)) from unnest(array['signup','digest','heartbeat']) n left join private.beta_incidents i on i.check_name=n),'[]'),
 'alerts_enabled',(select enabled from private.beta_alert_config where id),
 'mail_failed',exists(select 1 from private.beta_alert_outbox where delivery_error and sent_at is null),
 'pending_emails',(select count(*) from private.beta_alert_outbox where sent_at is null)) into health;
 return base || jsonb_build_object('adoption',adoption,'spend',spend,'survey',survey,'health',health);
end $$;
revoke all on function public.beta_release_stats(timestamptz,timestamptz) from public,anon;
grant execute on function public.beta_release_stats(timestamptz,timestamptz) to authenticated,service_role;

-- Alternate enrollment reuses the SAME global enrollment lock and existing configured caps.
-- Off by default until approved; no invitation is created and no account is enrolled here.
alter table public.sponsor_config add column npi_enrollment_enabled boolean not null default false;
create function public.enroll_npi_beta(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.sponsor_config%rowtype; a public.sponsored_accounts%rowtype; u auth.users%rowtype; n integer;
begin
 if p_user_id is null then raise exception using errcode='42501',message='sign in first'; end if;
 perform pg_catalog.pg_advisory_xact_lock(7243100002);
 select * into a from public.sponsored_accounts where user_id=p_user_id for update;
 if found then
   return jsonb_build_object('status',case when a.active and (a.ends_at is null or a.ends_at>now()) then 'already' else 'revoked' end,'cohort',a.cohort);
 end if;
 select * into u from auth.users where id=p_user_id;
 if not found or u.email_confirmed_at is null then return jsonb_build_object('status','email_required'); end if;
 if u.raw_app_meta_data->'npi_match'->>'version' is distinct from '1' or coalesce(u.raw_app_meta_data->'npi_match'->>'npi','')!~'^[12][0-9]{9}$' or u.raw_app_meta_data->'npi_match'->>'physician' is distinct from 'true' then return jsonb_build_object('status','npi_required'); end if;
 select * into c from public.sponsor_config where id for update;
 if not found or not c.npi_enrollment_enabled or c.enrollment_paused or c.enrollment_limit is null then return jsonb_build_object('status','paused'); end if;
 select count(*) into n from public.sponsored_accounts where active and (ends_at is null or ends_at>now());
 if n>=c.enrollment_limit then return jsonb_build_object('status','full'); end if;
 insert into public.sponsored_accounts(user_id,cohort,note) values(p_user_id,'beta-npi','Public individual physician NPI/name match; not identity verification');
 return jsonb_build_object('status','enrolled','cohort','beta-npi');
end $$;
revoke all on function public.enroll_npi_beta(uuid) from public,anon,authenticated;
grant execute on function public.enroll_npi_beta(uuid) to service_role;
commit;
