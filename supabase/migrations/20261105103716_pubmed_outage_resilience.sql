-- Apply before deploying digest-run. No cron, transport, account enablement, or
-- spending policy changes. All operational state and RPCs are service-role only.
begin;
alter table public.digest_schedules
  add column next_attempt_at timestamptz,
  add column retry_failures integer not null default 0;

create table private.pubmed_circuit (
 id boolean primary key default true check(id),
 failures integer not null default 0 check(failures >= 0),
 next_probe_at timestamptz not null default '-infinity',
 token uuid, lease_until timestamptz,
 last_failure_at timestamptz, last_success_at timestamptz
);
insert into private.pubmed_circuit(id) values(true);
create table private.digest_health (
 user_id uuid primary key references auth.users(id) on delete cascade,
 failed boolean not null, observed_at timestamptz not null default now(),
 paper_success_at timestamptz
);
alter table private.pubmed_circuit enable row level security;
alter table private.digest_health enable row level security;
revoke all on private.pubmed_circuit, private.digest_health from public, anon, authenticated;
grant all on private.pubmed_circuit, private.digest_health to service_role;
-- Preserve unresolved failures from the old worker at cutover. These are
-- service-written schedule results, never client-authored analytics events.
insert into private.digest_health(user_id,failed,observed_at)
 select user_id,true,coalesce(last_attempt_at,updated_at) from public.digest_schedules
 where last_result like 'error:%' or last_result like 'held:%'
    or last_result='skipped: unresolved_liability';

-- Serialize scheduled discovery even while healthy. Lease survives worker death;
-- a stale worker's finish cannot close a successor's circuit or clear its lease.
create function public.pubmed_search_claim()
returns uuid language plpgsql security definer set search_path='' as $$
declare t uuid := gen_random_uuid();
begin
 update private.pubmed_circuit set token=t, lease_until=now()+interval '4 minutes'
 where id and next_probe_at<=now() and (token is null or lease_until<=now());
 if not found then return null; end if;
 return t;
end $$;

create function public.pubmed_search_finish(p_token uuid,p_outcome text,p_retry_after_seconds integer default 0)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_outcome not in ('ok','unavailable','cancelled') or p_outcome is null then raise exception 'invalid outcome'; end if;
 update private.pubmed_circuit set
   failures=case when p_outcome='unavailable' then least(failures+1,20) when p_outcome='ok' then 0 else failures end,
   next_probe_at=case when p_outcome='unavailable' then now()+make_interval(secs => greatest(900 * power(2,least(failures,2)),least(greatest(coalesce(p_retry_after_seconds,0),0),86400))::double precision)
                     when p_outcome='ok' then now()+interval '1 second' else greatest(next_probe_at,now()+interval '1 minute') end,
   last_failure_at=case when p_outcome='unavailable' then now() else last_failure_at end,
   last_success_at=case when p_outcome='ok' then now() else last_success_at end,
   token=null,lease_until=null
 where id and token=p_token and lease_until>now();
 if not found then return false; end if;
 if p_outcome='unavailable' then perform public.beta_monitor_record('digest',false,'unavailable'); end if;
 return true;
end $$;

-- An upstream failure consumed no paid work: keep today's attempts, last_run_at,
-- delivered_day and the stored digest untouched. Fairness still moves it to the back.
create function public.digest_claim_defer(p_user_id uuid,p_token uuid,p_result text)
returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update public.digest_schedules set claimed_at=null,claim_token=null,
 last_attempt_at=now(),last_result=left(p_result,200),updated_at=now()
 where user_id=p_user_id and claim_token=p_token;
 return found;
end $$;

create or replace function public.digest_claim_finish(p_user_id uuid, p_token uuid, p_finished boolean, p_result text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.digest_schedules
     set claimed_at = null, claim_token = null,
         last_run_at = case when p_finished then now() else last_run_at end,
         last_result = coalesce(left(p_result, 200), last_result), updated_at = now(),
         next_attempt_at = case when p_result like 'error:%' then now()+make_interval(mins => (15*power(2,least(retry_failures,2)))::integer) else null end,
         retry_failures = case when p_result like 'error:%' then least(retry_failures+1,20) else 0 end,
         last_attempt_at = now(),                                                                   -- attempt
         attempts_today = case when attempt_day = public.digest_local_day(timezone) then attempts_today + 1 else 1 end, -- attempt
         attempt_day = public.digest_local_day(timezone)                                             -- attempt
   where user_id = p_user_id and claim_token = p_token;
  return found;
end;
$$;

-- A quiet/empty account can resolve its own failure, but never supplies the
-- paper-bearing evidence required for a shared all-clear. Silence is not recovery.
create function private.digest_recovery_ready()
returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.pubmed_circuit where failures>0 or last_failure_at>now()-interval '30 minutes')
 and not exists(select 1 from private.beta_monitor_samples where check_name='digest' and not ok and checked_at>now()-interval '30 minutes')
 and not exists(select 1 from private.digest_health h join public.digest_schedules d using(user_id) join public.sponsored_accounts a using(user_id)
   where h.failed and d.enabled and d.paused_at is null and a.active and (a.ends_at is null or a.ends_at>now()))
 and exists(select 1 from private.digest_health h where h.paper_success_at>=now()-interval '24 hours'
   and h.paper_success_at>coalesce((select max(checked_at) from private.beta_monitor_samples where check_name='digest' and not ok),'-infinity'))
$$;
create or replace function public.beta_monitor_record(p_check text,p_ok boolean,p_code text)
returns void language plpgsql security definer set search_path='' as $$
declare s private.beta_incidents%rowtype; bad_count integer;
begin
 perform pg_catalog.pg_advisory_xact_lock(7243100003);
 if p_check='digest' and p_ok and not private.digest_recovery_ready() then return; end if;
 insert into private.beta_monitor_samples(check_name,ok,code) values(p_check,p_ok,p_code);
 insert into private.beta_incidents(check_name) values(p_check) on conflict do nothing;
 select * into s from private.beta_incidents where check_name=p_check for update;
 select count(*) into bad_count from private.beta_monitor_samples
 where check_name=p_check and not ok and checked_at>now()-interval '30 minutes'
 and checked_at>coalesce((select max(checked_at) from private.beta_monitor_samples where check_name=p_check and ok),'-infinity');
 if not p_ok and (p_check='digest' and p_code='unavailable' or p_check='schedule' and p_code='overdue' or bad_count>=3 and exists(select 1 from private.beta_monitor_samples where check_name=p_check and not ok and checked_at<=now()-interval '5 minutes' and checked_at>now()-interval '30 minutes' and checked_at>coalesce((select max(checked_at) from private.beta_monitor_samples where check_name=p_check and ok),'-infinity'))) then
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


create function public.beta_digest_observe(p_user_id uuid,p_outcome text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_outcome not in ('done','empty','failed') or p_outcome is null then raise exception 'invalid outcome'; end if;
 perform pg_catalog.pg_advisory_xact_lock(7243100003);
 insert into private.digest_health(user_id,failed,paper_success_at)
 values(p_user_id,p_outcome='failed',case when p_outcome='done' then now() end)
 on conflict(user_id) do update set failed=excluded.failed,observed_at=now(),
 paper_success_at=coalesce(excluded.paper_success_at,private.digest_health.paper_success_at);
 if p_outcome='failed' then perform public.beta_monitor_record('digest',false,'failed');
 elsif p_outcome='done' then perform public.beta_monitor_record('digest',true,'ok'); end if;
end $$;
create or replace function public.beta_monitor_tick()
returns void language plpgsql security definer set search_path='' as $$
declare overdue boolean; invalid_timezone boolean;
begin
 -- A single due slot beyond two hours is already sustained evidence. No retry
 -- counter is needed; a monitor invocation is not a new digest attempt.
 select exists(select 1 from private.beta_expected_digest_due(now()) where due_at<now()-interval '2 hours') into overdue;
 select exists(select 1 from public.digest_schedules d join public.sponsored_accounts a using(user_id) where d.enabled and a.active and (a.ends_at is null or a.ends_at>now()) and not exists(select 1 from pg_catalog.pg_timezone_names z where z.name=d.timezone)) into invalid_timezone;
 perform public.beta_monitor_record('schedule',not overdue and not invalid_timezone,case when overdue then 'overdue' when invalid_timezone then 'unavailable' else 'ok' end);
 if exists(select 1 from private.pubmed_circuit where failures>0) then
   perform public.beta_monitor_record('digest',false,'unavailable');
 elsif exists(select 1 from private.digest_health h join public.digest_schedules d using(user_id) join public.sponsored_accounts a using(user_id)
   where h.failed and d.enabled and d.paused_at is null and a.active and (a.ends_at is null or a.ends_at>now())) then
   perform public.beta_monitor_record('digest',false,'failed');
 else
   perform public.beta_monitor_record('digest',true,'ok'); -- guarded by real evidence and quiet period
 end if;
 perform public.beta_monitor_record('heartbeat',true,'ok');
end $$;
do $$ declare f text; begin
 foreach f in array array[
 'public.pubmed_search_claim()', 'public.pubmed_search_finish(uuid,text,integer)',
 'public.digest_claim_defer(uuid,uuid,text)', 'public.digest_claim_finish(uuid,uuid,boolean,text)',
 'private.digest_recovery_ready()', 'public.beta_digest_observe(uuid,text)', 'public.beta_monitor_tick()'
 ] loop
 execute format('revoke all on function %s from public,anon,authenticated',f);
 execute format('grant execute on function %s to service_role',f);
 end loop;
end $$;
create or replace function public.beta_alert_claim()
returns jsonb language plpgsql security definer set search_path='' as $$
declare r private.beta_alert_outbox%rowtype;
begin
 if not exists(select 1 from private.beta_alert_config where id and enabled) then return null; end if;
 select * into r from private.beta_alert_outbox where attempts=0 and sent_at is null
 and (kind<>'recovery' or check_name<>'digest' or exists(select 1 from private.beta_incidents i
   where i.check_name=beta_alert_outbox.check_name and i.opened_at=beta_alert_outbox.incident_at and i.state='ok')
   and private.digest_recovery_ready())
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update private.beta_alert_outbox set attempts=1,last_attempt_at=now(),delivery_error=true where id=r.id;
 return jsonb_build_object('id',r.id,'check',r.check_name,'kind',r.kind,'incident_at',r.incident_at,'observed_at',r.created_at);
end $$;
revoke all on function public.beta_alert_claim() from public,anon,authenticated;
grant execute on function public.beta_alert_claim() to service_role;

commit;
