-- Disposable local DB only; run after the beta fixture/migrations and outage migration.
begin;
create function pg_temp.ok(v boolean, label text) returns void language plpgsql as $$
begin if v is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label; end $$;
insert into auth.users(id) values ('e0000000-0000-0000-0000-000000000001'),('e0000000-0000-0000-0000-000000000002');
insert into public.sponsored_accounts(user_id) values ('e0000000-0000-0000-0000-000000000001'),('e0000000-0000-0000-0000-000000000002');
insert into public.digest_schedules(user_id,timezone,attempts_today,attempt_day,last_run_at,delivered_day)
 values ('e0000000-0000-0000-0000-000000000001','America/New_York',3,public.digest_local_day('America/New_York'),now()-interval '1 day',public.digest_local_day('America/New_York')-1),
 ('e0000000-0000-0000-0000-000000000002','UTC',0,null,null,null);
create temp table tokens(t uuid);
insert into tokens values(public.pubmed_search_claim());
select pg_temp.ok((select t is not null from tokens),'first search obtains global lease');
select pg_temp.ok(public.pubmed_search_claim() is null,'second account cannot search concurrently');
select pg_temp.ok(not public.pubmed_search_finish(gen_random_uuid(),'ok',0),'wrong token cannot clear circuit');
select pg_temp.ok(public.pubmed_search_finish((select t from tokens),'unavailable',0),'owner records outage');
select pg_temp.ok((select failures=1 and next_probe_at=now()+interval '15 minutes' from private.pubmed_circuit),'first retry waits 15 minutes');
select pg_temp.ok(public.pubmed_search_claim() is null,'outage cooldown blocks manual and cron admission');
select pg_temp.ok((select state='failed' from private.beta_incidents where check_name='digest'),'explicit upstream outage opens incident immediately');
select pg_temp.ok((select count(*)=1 from private.beta_alert_outbox where check_name='digest' and kind='incident'),'one incident queued');
update private.pubmed_circuit set next_probe_at=now()-interval '1 second';
update tokens set t=public.pubmed_search_claim();
select public.pubmed_search_finish((select t from tokens),'unavailable',0);
select pg_temp.ok((select next_probe_at=now()+interval '30 minutes' from private.pubmed_circuit),'second retry waits 30 minutes');
update private.pubmed_circuit set next_probe_at=now()-interval '1 second';
update tokens set t=public.pubmed_search_claim();
select public.pubmed_search_finish((select t from tokens),'unavailable',0);
select pg_temp.ok((select next_probe_at=now()+interval '60 minutes' from private.pubmed_circuit),'third retry waits 60 minutes');
update private.pubmed_circuit set next_probe_at=now()-interval '1 second';
update tokens set t=public.pubmed_search_claim();
select public.pubmed_search_finish((select t from tokens),'unavailable',7200);
select pg_temp.ok((select next_probe_at=now()+interval '2 hours' from private.pubmed_circuit),'longer Retry-After respected');
select pg_temp.ok((select count(*)=1 from private.beta_alert_outbox where check_name='digest' and kind='incident'),'repeated failures do not spam alerts');
-- Even after a full day of hourly probes, deferred searches never spend work attempts.
do $$ declare i integer; t uuid; begin
 for i in 1..30 loop
 t:=public.digest_claim('e0000000-0000-0000-0000-000000000001',240);
 perform pg_temp.ok(public.digest_claim_defer('e0000000-0000-0000-0000-000000000001',t,'deferred: PubMed'),'deferral releases owner');
 end loop;
end $$;
select pg_temp.ok((select attempts_today=3 and last_run_at=now()-interval '1 day' and delivered_day=public.digest_local_day('America/New_York')-1 and claim_token is null from public.digest_schedules where user_id='e0000000-0000-0000-0000-000000000001'),'deferrals preserve attempts, delivery day and completion');
select pg_temp.ok(not public.digest_claim_defer('e0000000-0000-0000-0000-000000000001',gen_random_uuid(),'deferred'),'stale owner cannot release successor');
select public.digest_claim_finish('e0000000-0000-0000-0000-000000000001',public.digest_claim('e0000000-0000-0000-0000-000000000001',240),false,'error: permanent request');
select pg_temp.ok((select attempts_today=4 and next_attempt_at=now()+interval '15 minutes' from public.digest_schedules where user_id='e0000000-0000-0000-0000-000000000001'),'ordinary errors count but are spaced');
-- Stopped worker: one replacement lease, never an early second probe.
update private.pubmed_circuit set next_probe_at=now()-interval '1 second';
update tokens set t=public.pubmed_search_claim();
update private.pubmed_circuit set lease_until=now()-interval '1 second';
select pg_temp.ok(public.pubmed_search_claim() is not null,'expired lease can be replaced');
select pg_temp.ok(not public.pubmed_search_finish((select t from tokens),'ok',0),'expired lease cannot publish success');
select public.pubmed_search_finish(token,'ok',0) from private.pubmed_circuit;
select pg_temp.ok((select failures=0 from private.pubmed_circuit),'validated search closes circuit');
select public.beta_digest_observe('e0000000-0000-0000-0000-000000000001','failed');
select public.beta_digest_observe('e0000000-0000-0000-0000-000000000002','empty');
select public.beta_monitor_record('digest',true,'ok');
select pg_temp.ok((select state='failed' from private.beta_incidents where check_name='digest'),'empty run cannot resolve another account failure');
select public.beta_digest_observe('e0000000-0000-0000-0000-000000000002','done');
select pg_temp.ok(not private.digest_recovery_ready(),'paper-bearing success cannot hide another failing account');
select public.beta_digest_observe('e0000000-0000-0000-0000-000000000001','empty');
select pg_temp.ok(not private.digest_recovery_ready(),'recovery waits through a 30-minute quiet period');
update private.beta_monitor_samples set checked_at=now()-interval '31 minutes' where check_name='digest' and not ok;
update private.pubmed_circuit set last_failure_at=now()-interval '31 minutes';
select pg_temp.ok(private.digest_recovery_ready(),'cohort resolved plus later papers plus quiet period allows recovery');
select public.beta_monitor_tick();
select public.beta_monitor_tick();
select pg_temp.ok((select count(*)=1 from private.beta_alert_outbox where check_name='digest' and kind='recovery'),'one recovery queued despite repeated monitor ticks');
-- A queued all-clear must not be sent after a new failure.
select public.beta_monitor_record('digest',false,'unavailable');
update private.beta_alert_config set enabled=true;
update private.beta_alert_outbox set attempts=1 where kind<>'recovery';
select pg_temp.ok(public.beta_alert_claim() is null,'queued stale recovery is not dispatched');
-- Authenticated clients cannot bypass the circuit or rewrite the operational ledger.
select pg_temp.ok(not has_function_privilege('authenticated','public.pubmed_search_claim()','execute'),'client cannot admit searches');
select pg_temp.ok(not has_function_privilege('anon','public.pubmed_search_finish(uuid,text,integer)','execute'),'anon cannot close circuit');
select pg_temp.ok(not has_function_privilege('authenticated','public.beta_digest_observe(uuid,text)','execute'),'client cannot forge recovery');
select pg_temp.ok(not has_table_privilege('authenticated','private.pubmed_circuit','select'),'circuit state is private');
select pg_temp.ok(not has_column_privilege('authenticated','public.digest_schedules','next_attempt_at','update'),'client cannot bypass retry cooldown');
rollback;
