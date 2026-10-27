\set ON_ERROR_STOP on
begin;
set local timezone='UTC';
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'FAIL: %',label; end if; raise notice 'ok: %',label; end$$;
create function pg_temp.fails(q text) returns void language plpgsql as $$begin begin execute q; raise exception 'expected denial'; exception when insufficient_privilege then null; end; end$$;
grant execute on function pg_temp.ok(boolean,text),pg_temp.fails(text) to anon,authenticated,service_role;
insert into auth.users(id,email_confirmed_at,raw_app_meta_data)
select ('c0000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,now(),jsonb_build_object('npi_match',jsonb_build_object('version',1,'npi','123456789'||i::text,'physician',true)) from generate_series(1,8)i;
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
('c0000000-0000-0000-0000-000000000004','digest_scheduled_run',now(),'{"phase":"done","claimLost":true}'),
('c0000000-0000-0000-0000-000000000004','paper_shared',now(),'{}'),
('c0000000-0000-0000-0000-000000000005','digest_opened',now(),'{}');
insert into public.beta_survey_responses(user_id,wave,survey_version,status,cohort) values('c0000000-0000-0000-0000-000000000005','signup','1','skipped','beta');
create temp table stats as select public.beta_release_stats(now()-interval '30 days',now()+interval '1 second') s;
select pg_temp.ok((s->'adoption'->>'signups')::int=3,'known test enrollment excluded') from stats;
select pg_temp.ok((s->'adoption'->>'active72')::int=2,'unique meaningful use; duplicates and cron excluded') from stats;
select pg_temp.ok((s->'adoption'->>'returned')::int=1,'return needs later UTC day') from stats;
select pg_temp.ok((s->'adoption'->>'eligible')::int=2 and (s->'adoption'->>'retained')::int=1,'retention includes mature nonusers; excludes immature cohort') from stats;
select pg_temp.ok((s->'survey'->>'skipped')::int=0,'historical smoke survey excluded without row edits') from stats;
select pg_temp.ok((s->'spend'->>'completed')::int=1,'scheduled completion ticks deduplicated; lost claims excluded') from stats;
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
select pg_temp.ok(public.beta_release_stats(now()-interval '30 days',now())->'health'->'checks'->0->>'state'='ok','quiet signup retains historical success without claiming freshness');
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
-- Match production: service_role has no direct SELECT on auth.users.
revoke select on auth.users from service_role;
set local role service_role;
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000007')->>'status'='enrolled','matched physician enrollment');
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000007')->>'status'='already','retry idempotent');
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000008')->>'status'='full','global limit enforced');
select pg_temp.ok((select daily_cap_usd is null and monthly_cap_usd is null from public.sponsored_accounts where user_id='c0000000-0000-0000-0000-000000000007'),'new account inherits existing spend caps');
reset role;
-- One public NPI cannot fund two accounts, through either path.
update public.sponsor_config set enrollment_limit=100;
update auth.users set raw_app_meta_data=(select raw_app_meta_data from auth.users where id='c0000000-0000-0000-0000-000000000007') where id='c0000000-0000-0000-0000-000000000008';
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000008')->>'status'='npi_in_use','second account with same NPI rejected');
insert into public.sponsor_invites(code,cohort,max_uses) values('SAME-NPI','beta',10);
select pg_temp.ok(public.redeem_sponsor_invite('SAME-NPI','c0000000-0000-0000-0000-000000000008')->>'status'='npi_in_use','invite path cannot bypass NPI claim');
select pg_temp.ok((select uses=0 from public.sponsor_invites where code='SAME-NPI'),'duplicate rejection consumes no invite');
update auth.users set raw_app_meta_data=jsonb_set(raw_app_meta_data,'{npi_match,npi}','"1234567890"') where id='c0000000-0000-0000-0000-000000000007';
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000007')->>'status'='already','existing account remains accessible after receipt change');
select pg_temp.ok(public.enroll_npi_beta('c0000000-0000-0000-0000-000000000008')->>'status'='npi_in_use','receipt changes cannot free a claimed NPI');
-- last_run_at may mean abandoned/retired. A tick must not create success or recover.
insert into public.digest_schedules(user_id,last_run_at,last_result) values('c0000000-0000-0000-0000-000000000007',now(),'abandoned');
select public.beta_monitor_record('digest',false,'failed');
update private.beta_monitor_samples set checked_at=now()-interval '6 minutes' where check_name='digest';
select public.beta_monitor_record('digest',false,'failed');
select public.beta_monitor_record('digest',false,'failed');
select public.beta_monitor_tick();
select pg_temp.ok((select state='failed' from private.beta_incidents where check_name='digest'),'recent abandoned schedule timestamp cannot recover digest incident');
select pg_temp.ok(not exists(select 1 from private.beta_monitor_samples where check_name='digest' and ok),'tick never invents successful digest evidence');
select public.beta_monitor_record('digest',true,'ok');
update private.beta_incidents set last_checked_at=now()-interval '16 minutes' where check_name='digest';
select public.beta_monitor_tick();
select pg_temp.ok((select last_checked_at<now()-interval '15 minutes' from private.beta_incidents where check_name='digest'),'tick cannot refresh stale success');

-- Fixed clock cases mirror the scheduler's calendar-day and local-hour gates.
update public.sponsored_accounts set created_at='2026-09-01T00:00Z',ends_at=null where user_id='c0000000-0000-0000-0000-000000000007';
update public.digest_schedules set timezone='UTC',hour_local=6,monitor_started_at='2026-09-01T00:00Z',last_run_at='2026-10-15T01:00Z';
update public.digest_schedules set monitor_started_at='2026-09-01T00:00Z';
select pg_temp.ok((select due_at='2026-10-16T06:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T09:00Z')),'completion before configured hour suppresses whole local day');
update public.digest_schedules set last_run_at=null,monitor_started_at='2026-10-15T10:00Z';
update public.digest_schedules set updated_at='2026-10-15T20:00Z';
select pg_temp.ok((select due_at='2026-10-15T10:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T11:00Z')),'new schedule after hour is due immediately');
-- Pause rule (20261025121000): an unopened digest no longer suspends expectation, opening
-- one no longer activates anything, and a missed earlier slot keeps the account overdue.
update public.digest_schedules set last_run_at='2026-10-01T10:00Z',monitor_started_at='2026-09-01T00:00Z';
insert into public.kv(user_id,collection,key,value) values('c0000000-0000-0000-0000-000000000007','digests','daily:latest','{"kind":"daily","results":[{}],"openedAt":null,"ranAt":"2026-10-01T10:00Z"}');
select pg_temp.ok((select due_at='2026-10-13T06:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T03:00Z')),'an unopened digest is still expected, and a missed earlier slot keeps it overdue');
update public.kv set value=value||'{"openedAt":"2026-10-15T01:00Z"}' where user_id='c0000000-0000-0000-0000-000000000007' and collection='digests' and key='daily:latest';
select pg_temp.ok((select due_at='2026-10-13T06:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T03:00Z')),'opening a digest does not move the expectation');
delete from public.kv where user_id='c0000000-0000-0000-0000-000000000007' and collection='digests' and key='daily:latest';
update public.digest_schedules set last_attempt_at='2026-10-15T06:03Z';
select pg_temp.ok((select due_at='2026-10-16T06:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T09:00Z')),'a run attempted today (in flight) is not overdue');
update public.digest_schedules set last_attempt_at=null,last_run_at='2026-10-13T06:05Z',monitor_started_at='2026-10-15T20:00Z';
select pg_temp.ok((select due_at='2026-10-16T06:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T21:00Z')),'activation past the catch-up window waits for the next morning');
update public.digest_schedules set monitor_started_at='2026-10-15T10:00Z';
select pg_temp.ok((select due_at='2026-10-15T10:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T21:00Z')),'activation within the catch-up window is due at activation');
update public.digest_schedules set paused_at='2026-10-15T00:00Z';
select pg_temp.ok(not exists(select 1 from private.beta_expected_digest_due('2026-10-15T21:00Z')),'a paused account is not expected');
update public.digest_schedules set paused_at=null,monitor_started_at='2026-09-01T00:00Z';
-- Build lead (20261026233000): the scheduler builds in the hour before the reader's hour.
update public.digest_schedules set last_run_at='2026-10-15T05:02Z',last_attempt_at='2026-10-15T05:02Z';
select pg_temp.ok((select due_at='2026-10-16T06:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T05:10Z')),'a build in the lead hour satisfies that morning, not a missed yesterday');
update public.digest_schedules set last_run_at='2026-10-14T05:05Z',last_attempt_at='2026-10-14T05:05Z';
select pg_temp.ok((select due_at='2026-10-15T06:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T05:20Z')),'an open build window not yet served is due at the hour, not overdue');
update public.digest_schedules set last_run_at='2026-10-13T05:05Z',last_attempt_at='2026-10-13T05:05Z';
select pg_temp.ok((select due_at='2026-10-14T06:00Z'::timestamptz from private.beta_expected_digest_due('2026-10-15T05:20Z')),'a missed yesterday stays overdue through the lead hour');
-- The 2026-10-26 23:35Z false alarm: India readers, 06:00 local, built at 05:02 local.
update public.digest_schedules set timezone='Asia/Calcutta',last_run_at='2026-10-26T23:32Z',last_attempt_at='2026-10-26T23:32Z',monitor_started_at='2026-10-26T01:52Z';
select pg_temp.ok((select due_at='2026-10-28T00:30Z'::timestamptz from private.beta_expected_digest_due('2026-10-26T23:37Z')),'half-hour-offset reader built in the lead hour is on track');
update public.digest_schedules set timezone='UTC',hour_local=6,last_run_at=null,last_attempt_at=null,monitor_started_at='2026-09-01T00:00Z';
-- Quiet outcomes do not expire; fresh schedule/heartbeat checks are independent.
update public.digest_schedules set last_run_at=now(),updated_at=now(),hour_local=extract(hour from now())::int,timezone='UTC';
select public.beta_monitor_tick();
select pg_temp.ok((select state='ok' from private.beta_incidents where check_name='schedule'),'quiet daily schedule is on track');
select pg_temp.ok((select min(due_at)>now() from private.beta_expected_digest_due(now())),'future local due slot is not overdue');
update public.sponsored_accounts set created_at=now()-interval '10 days' where user_id='c0000000-0000-0000-0000-000000000007';
update public.digest_schedules set last_run_at=now()-interval '3 days',monitor_started_at=now()-interval '4 days';
select public.beta_monitor_tick();
select pg_temp.ok((select state='failed' from private.beta_incidents where check_name='schedule'),'one stuck digest becomes actionable on first overdue check');
select public.beta_monitor_tick();
select pg_temp.ok((select count(*)=1 from private.beta_alert_outbox where check_name='schedule' and kind='incident'),'overdue ticks deduplicate incident');
update public.digest_schedules set last_run_at=now();
select public.beta_monitor_tick();
select public.beta_monitor_tick();
select pg_temp.ok((select count(*)=1 from private.beta_alert_outbox where check_name='schedule' and kind='recovery'),'resolved expected work queues one recovery');
update public.digest_schedules set last_run_at=now()-interval '7 days';
insert into public.kv(user_id,collection,key,value) values('c0000000-0000-0000-0000-000000000007','digests','daily:latest','{"kind":"daily","results":[{}],"runBy":"scheduler","server":{"phase":"done"}}');
select public.beta_monitor_tick();
select pg_temp.ok((select state='failed' from private.beta_incidents where check_name='schedule'),'an unopened digest a week old is overdue, not intentionally waiting (pause rule)');
update public.kv set value=value||jsonb_build_object('openedAt',now()) where collection='digests' and key='daily:latest' and user_id='c0000000-0000-0000-0000-000000000007';
select public.beta_monitor_tick();
select pg_temp.ok((select state='failed' from private.beta_incidents where check_name='schedule'),'opening it grants no grace period');
update public.digest_schedules set paused_at=now();
select public.beta_monitor_tick();
select pg_temp.ok((select state='ok' from private.beta_incidents where check_name='schedule'),'a paused account is not expected work');
update public.digest_schedules set paused_at=null,last_run_at=now();
update public.digest_schedules set timezone='Invalid/Zone';
select public.beta_monitor_tick();
select pg_temp.ok((select state='unknown' from private.beta_incidents where check_name='schedule'),'unreadable schedule cannot falsely pass');
update public.digest_schedules set timezone='UTC';
select public.beta_monitor_tick();
update private.beta_incidents set last_checked_at=now()-interval '16 minutes' where check_name='heartbeat';
select pg_temp.ok(exists(select 1 from jsonb_array_elements(public.beta_release_stats(now()-interval '30 days',now())->'health'->'checks') c where c->>'name'='heartbeat' and c->>'state'='stale'),'absent heartbeat is stale despite quiet healthy schedule');

-- Claim exposes the queued observation timestamp, not the older incident opening.
update private.beta_alert_config set enabled=true;
update private.beta_alert_outbox set attempts=1;
insert into private.beta_alert_outbox(check_name,incident_at,kind,created_at) values('digest',now()-interval '1 day','recovery',now()-interval '1 minute');
select pg_temp.ok((public.beta_alert_claim()->>'observed_at')::timestamptz=now()-interval '1 minute','recovery claim uses recovery observation time');
select pg_temp.ok(public.beta_alert_claim() is null,'claim remains at most once');
select pg_temp.ok(public.beta_alert_test_claim() is not null,'test claimed once');
select pg_temp.ok(public.beta_alert_test_claim() is null,'test retry cannot send twice');
select public.beta_alert_test_finish(true);
select pg_temp.ok((select test_sent_at is not null and not test_failed from private.beta_alert_config),'test acceptance saved');
set local role anon;
select pg_temp.fails('select public.beta_alert_test_claim()');
select pg_temp.fails('select public.beta_alert_test_finish(true)');
select pg_temp.fails('select public.enroll_npi_beta(''c0000000-0000-0000-0000-000000000008'')');
select pg_temp.fails('select public.beta_release_stats(now()-interval ''1 day'',now())');
select pg_temp.fails('select public.beta_monitor_record(''heartbeat'',true,''ok'')');
select pg_temp.fails('select * from private.beta_npi_claims');
reset role;
rollback;
