\set ON_ERROR_STOP on
begin;
set local timezone='UTC';
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'FAIL: %',label; end if; raise notice 'ok: %',label; end$$;
create function pg_temp.fails(q text) returns void language plpgsql as $$begin begin execute q; raise exception 'expected denial'; exception when insufficient_privilege then null; end; end$$;
grant execute on function pg_temp.ok(boolean,text),pg_temp.fails(text) to anon,authenticated,service_role;
insert into auth.users(id,email_confirmed_at,raw_app_meta_data)
select ('c0000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,now(),'{"npi_match":{"version":1,"npi":"1234567893","physician":true}}' from generate_series(1,8)i;
insert into private.beta_admins(user_id) values('c0000000-0000-0000-0000-000000000001');
select set_config('request.jwt.claim.sub','c0000000-0000-0000-0000-000000000001',true);
set local role authenticated;
select pg_temp.ok((public.beta_release_stats(now()-interval '30 days',now())->'adoption'->>'signups')::int=0,'empty signups are zero');
select pg_temp.ok(public.beta_release_stats(now()-interval '30 days',now())->'health'->'checks'->0->>'state'='unknown','no heartbeat is unknown');
select pg_temp.fails('select public.enroll_npi_beta(''c0000000-0000-0000-0000-000000000002'')');
select pg_temp.fails('select * from private.beta_test_exclusions');
reset role;
insert into public.sponsored_accounts(user_id,cohort,created_at) values
('c0000000-0000-0000-0000-000000000002','beta',now()-interval '20 days'),
('c0000000-0000-0000-0000-000000000003','beta',now()-interval '20 days'),
('c0000000-0000-0000-0000-000000000004','beta',now()-interval '5 days'),
('c0000000-0000-0000-0000-000000000005','smoke-qa-20261015',now()-interval '20 days');
update private.beta_measurement set started_at=now()-interval '30 days';
insert into public.events(user_id,type,ts,payload) values
('c0000000-0000-0000-0000-000000000002','digest_opened',now()-interval '12 days','{}'),
('c0000000-0000-0000-0000-000000000002','digest_viewed',now()-interval '1 day','{}'),
('c0000000-0000-0000-0000-000000000002','digest_viewed',now()-interval '1 day','{}'),
('c0000000-0000-0000-0000-000000000003','digest_scheduled_run',now(),'{"phase":"done"}'),
('c0000000-0000-0000-0000-000000000003','digest_scheduled_run',now(),'{"phase":"done"}'),
('c0000000-0000-0000-0000-000000000004','paper_shared',now(),'{}'),
('c0000000-0000-0000-0000-000000000005','digest_opened',now(),'{}');
insert into public.beta_survey_responses(user_id,wave,survey_version,status,cohort) values('c0000000-0000-0000-0000-000000000005','signup','1','skipped','beta');
create temp table stats as select public.beta_release_stats(now()-interval '30 days',now()+interval '1 second') s;
select pg_temp.ok((s->'adoption'->>'signups')::int=3,'known test enrollment excluded') from stats;
select pg_temp.ok((s->'adoption'->>'active72')::int=2,'unique meaningful use; duplicates and cron excluded') from stats;
select pg_temp.ok((s->'adoption'->>'returned')::int=1,'return needs later UTC day') from stats;
select pg_temp.ok((s->'adoption'->>'eligible')::int=2 and (s->'adoption'->>'retained')::int=1,'retention includes mature nonusers; excludes immature cohort') from stats;
select pg_temp.ok((s->'survey'->>'skipped')::int=0,'historical smoke survey excluded without row edits') from stats;
select pg_temp.ok((s->'spend'->>'completed')::int=1,'scheduled completion ticks deduplicated') from stats;
insert into public.model_spend(user_id,model,usd) values('c0000000-0000-0000-0000-000000000005','test',1.25),('c0000000-0000-0000-0000-000000000002','test',2.50);
select pg_temp.ok((public.beta_release_stats(now()-interval '30 days',now())->'spend'->>'month')::numeric=3.75,'test API spending remains counted');
select pg_temp.ok(public.beta_release_stats(now()-interval '30 days',now())->'spend'->'credit_balance'='null'::jsonb,'no fabricated provider balance');
insert into public.spend_reservations(user_id,request_id,fingerprint,model,source,reserved_micro,max_input_tokens,max_output_tokens,state) values
('c0000000-0000-0000-0000-000000000002','test-outstanding',repeat('a',64),'test','proxy',500000,1,1,'ambiguous'),
('c0000000-0000-0000-0000-000000000005','test-settled',repeat('b',64),'test','scheduler',2000000,1,1,'settled');
select pg_temp.ok((public.beta_release_stats(now()-interval '30 days',now())->'spend'->>'outstanding')::numeric=0.5,'only unresolved reservations are liabilities');
select pg_temp.ok((public.beta_release_stats(now()-interval '30 days',now())->'spend'->>'month')::numeric=3.75,'settled reservations do not double count usage');
-- Repeated failures over time, single incident; fresh success emits one recovery.
select public.beta_monitor_record('signup',false,'failed');
select pg_temp.ok((select state='unknown' from private.beta_incidents where check_name='signup'),'one failure not red');
update private.beta_monitor_samples set checked_at=now()-interval '6 minutes';
select public.beta_monitor_record('signup',false,'failed');
select public.beta_monitor_record('signup',false,'failed');
select public.beta_monitor_record('signup',false,'failed');
select pg_temp.ok((select count(*)=1 from private.beta_alert_outbox),'incident deduped');
select public.beta_monitor_record('signup',true,'ok');
select public.beta_monitor_record('signup',true,'ok');
select pg_temp.ok((select count(*)=2 from private.beta_alert_outbox),'one recovery only');
select pg_temp.ok(public.beta_alert_claim() is null,'delivery disabled by default');
update private.beta_alert_config set enabled=true;
select pg_temp.ok(public.beta_alert_claim() is not null,'claim configured incident');
select pg_temp.ok((select count(*)=1 from private.beta_alert_outbox where attempts=1 and delivery_error),'uncertain delivery visible and not retried');
select public.beta_alert_claim();
select pg_temp.ok(public.beta_alert_claim() is null,'no duplicate dispatch under retries');
update private.beta_incidents set last_checked_at=now()-interval '16 minutes';
select pg_temp.ok(public.beta_release_stats(now()-interval '30 days',now())->'health'->'checks'->0->>'state'='stale','stale successful evidence never healthy');
insert into private.beta_test_exclusions(user_id,starts_at,reason) values('c0000000-0000-0000-0000-000000000004',now()-interval '1 hour','synthetic test interval');
select pg_temp.ok((public.beta_release_stats(now()-interval '30 days',now())->'adoption'->>'signups')::int=3,'later test interval does not relabel historic enrollment');
select pg_temp.ok((public.beta_release_stats(now()-interval '30 days',now())->'adoption'->>'active72')::int=1,'activity inside explicit test interval excluded');
-- Enrollment: caps configured independently; defaults stay intact.
insert into public.sponsor_config(id,default_daily_cap_usd,default_monthly_cap_usd,global_monthly_ceiling_usd,enrollment_limit,enrollment_paused,npi_enrollment_enabled) values(true,1,5,30,5,true,true);
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000006')->>'status'='paused','pause enforced');
update public.sponsor_config set enrollment_paused=false;
update auth.users set email_confirmed_at=null where id='c0000000-0000-0000-0000-000000000006';
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000006')->>'status'='email_required','email confirmation required');
update auth.users set email_confirmed_at=now(),raw_app_meta_data='{}' where id='c0000000-0000-0000-0000-000000000006';
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000006')->>'status'='npi_required','missing server match denied');
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000007')->>'status'='enrolled','matched physician enrollment');
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000007')->>'status'='already','retry idempotent');
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000008')->>'status'='full','global limit enforced');
select pg_temp.ok((select daily_cap_usd is null and monthly_cap_usd is null from public.sponsored_accounts where user_id='c0000000-0000-0000-0000-000000000007'),'new account inherits existing spend caps');
set local role anon;
select pg_temp.fails('select public.enroll_npi_beta(''c0000000-0000-0000-0000-000000000008'')');
select pg_temp.fails('select public.beta_release_stats(now()-interval ''1 day'',now())');
select pg_temp.fails('select public.beta_monitor_record(''heartbeat'',true,''ok'')');
reset role;
rollback;
