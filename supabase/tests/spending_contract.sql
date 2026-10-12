-- Spending / scheduler-claim / invitation contract, on a DISPOSABLE database only
-- (supabase/tests/run_spending_tests.sh builds one). Everything runs inside one
-- transaction that is rolled back. Every dollar amount here is a TEST FIXTURE, not a
-- proposed beta value.
\set ON_ERROR_STOP on
begin;
create or replace function pg_temp.ok(v boolean, label text) returns void language plpgsql as $$
begin if not coalesce(v, false) then raise exception 'FAIL: %', label; end if; raise notice 'ok: %', label; end $$;
-- Reserve as the service role; returns the jsonb result.
create or replace function pg_temp.res(u uuid, rid text, micro bigint, fp text default repeat('a', 64)) returns jsonb language sql as $$
  select public.spend_reserve(u, rid, fp, 'claude-sonnet-5-5', 'test', 'proxy', micro, 100, 100)
$$;
create or replace function pg_temp.reason(u uuid, micro bigint) returns text language sql as $$ select public.spend_denial_reason(u, micro) $$;

insert into auth.users(id) values
  ('a0000000-0000-0000-0000-000000000001'), ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005'), ('a0000000-0000-0000-0000-000000000006');
\set A '''a0000000-0000-0000-0000-000000000001'''
\set B '''a0000000-0000-0000-0000-000000000002'''
\set BIG '''a0000000-0000-0000-0000-000000000003'''

-- ---------------------------------------------------------------- unconfigured fails closed
set local role service_role;
select pg_temp.ok(pg_temp.reason(:A, 1) = 'config_missing', 'no config row: denied');
reset role;
insert into public.sponsor_config (id, default_daily_cap_usd, default_monthly_cap_usd, global_monthly_ceiling_usd)
  values (true, 1.0, 5.0, 100.0); -- FIXTURE amounts
select pg_temp.ok((select spending_paused and enrollment_paused and beta_budget_usd is null and enrollment_limit is null from public.sponsor_config), 'migration defaults: both paused, budget and limit unset');
set local role service_role;
select pg_temp.ok(pg_temp.reason(:A, 1) = 'spending_paused', 'default paused: denied');
reset role;
update public.sponsor_config set spending_paused = false;
set local role service_role;
select pg_temp.ok(pg_temp.reason(:A, 1) = 'config_invalid', 'unset total budget: denied');
reset role;
update public.sponsor_config set beta_budget_usd = 50.0, beta_budget_starts_at = now() + interval '1 day';
set local role service_role;
select pg_temp.ok(pg_temp.reason(:A, 1) = 'config_invalid', 'budget starting in the future: denied');
reset role;
update public.sponsor_config set beta_budget_starts_at = now() - interval '1 hour';
update public.sponsor_config set default_daily_cap_usd = -1;
set local role service_role;
select pg_temp.ok(pg_temp.reason(:A, 1) = 'config_invalid', 'negative cap: denied');
reset role;
update public.sponsor_config set default_daily_cap_usd = 1.0;
set local role service_role;
select pg_temp.ok(pg_temp.reason(:A, 1) = 'account_inactive', 'no sponsorship: denied');
reset role;
insert into public.sponsored_accounts (user_id, active) values (:A, true), (:B, true), (:BIG, true);

-- ---------------------------------------------------------------- caps at the boundary
set local role service_role;
select pg_temp.ok(pg_temp.res(:A, 'req-day-0001', 999999)->>'status' = 'reserved', 'reserve just below the daily cap');
select pg_temp.ok(pg_temp.res(:A, 'req-day-0002', 1)->>'status' = 'reserved', 'reserve exactly to the daily cap');
select pg_temp.ok(pg_temp.res(:A, 'req-day-0003', 1)->>'reason' = 'cap_day', 'one micro-dollar over the daily cap: denied');
select pg_temp.ok(pg_temp.res(:B, 'req-day-0003', 1)->>'status' = 'reserved', 'same request id under another account is independent');

-- settle releases only the unused balance
select pg_temp.ok(public.spend_settle((select id from public.spend_reservations where request_id = 'req-day-0001'), 250000, 'claude-sonnet-5-5', 10, 10, 0, 0, 'req_x', 'msg_x')->>'status' = 'settled', 'settle below reservation');
select pg_temp.ok(pg_temp.res(:A, 'req-day-0004', 749999)->>'status' = 'reserved', 'unused balance came back');
select pg_temp.ok(pg_temp.res(:A, 'req-day-0005', 1)->>'reason' = 'cap_day', 'cap again exactly full');
select pg_temp.ok((select count(*) = 1 and sum(usd) = 0.25 from public.model_spend where user_id = :A), 'one ledger row with the actual cost');

-- idempotent settlement
select pg_temp.ok(public.spend_settle((select id from public.spend_reservations where request_id = 'req-day-0001'), 250000, 'claude-sonnet-5-5', 10, 10, 0, 0, 'req_x', 'msg_x')->>'status' = 'already_settled', 'duplicate settlement is a no-op');
select pg_temp.ok(public.spend_settle((select id from public.spend_reservations where request_id = 'req-day-0001'), 1, 'claude-sonnet-5-5', 10, 10, 0, 0, 'req_x', 'msg_x')->>'status' = 'conflict', 'different settlement of the same reservation is a conflict');
select pg_temp.ok((select count(*) = 1 from public.model_spend where user_id = :A), 'no second ledger row');

-- duplicate and mismatched request ids
select pg_temp.ok(pg_temp.res(:A, 'req-day-0002', 1)->>'status' = 'duplicate', 'reused id + same fingerprint: duplicate');
select pg_temp.ok(pg_temp.res(:A, 'req-day-0002', 1, repeat('b', 64))->>'status' = 'mismatch', 'reused id + different fingerprint: mismatch');
select pg_temp.ok((select count(*) = 1 from public.spend_reservations where user_id = :A and request_id = 'req-day-0002'), 'no extra reservation from reuse');

-- ambiguous / no release
select pg_temp.ok(public.spend_mark_ambiguous((select id from public.spend_reservations where request_id = 'req-day-0002'), 'timeout', null)->>'status' = 'ambiguous', 'timeout marks ambiguous');
select pg_temp.ok(to_regprocedure('public.spend_release(uuid,text,text)') is null, 'there is no release operation: post-dispatch liability is never released');
select pg_temp.ok(pg_temp.reason(:A, 1) = 'cap_day', 'ambiguous liability still counts');
-- A provider 4xx after dispatch is ambiguous; only an audited reconciliation (here: the
-- console shows no charge) brings it to zero.
select pg_temp.ok(public.spend_mark_ambiguous((select id from public.spend_reservations where request_id = 'req-day-0004'), 'provider_status_400', 'req_y')->>'status' = 'ambiguous', 'a post-dispatch 400 is ambiguous');
select pg_temp.ok(pg_temp.reason(:A, 1) = 'cap_day', 'the 400''s full reservation still counts');
select pg_temp.ok(public.spend_reconcile((select id from public.spend_reservations where request_id = 'req-day-0004'), 0, 'console: request req_y not billed')->>'status' = 'reconciled', 'reconciled to zero with evidence');
select pg_temp.ok(public.spend_settle((select id from public.spend_reservations where request_id = 'req-day-0004'), 5, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status' = 'conflict', 'a reconciled reservation cannot be settled differently');

-- reconciliation needs a note and moves the liability into the ledger
do $$ begin
  begin perform public.spend_reconcile((select id from public.spend_reservations where request_id = 'req-day-0002'), 0, ''); raise exception 'reconcile without note allowed';
  exception when invalid_parameter_value then null; end;
end $$;
select pg_temp.ok(public.spend_reconcile((select id from public.spend_reservations where request_id = 'req-day-0002'), 1, 'console shows 1 micro billed')->>'status' = 'reconciled', 'reconcile ambiguous');
select pg_temp.ok((select count(*) = 2 from public.spend_audit where action = 'reconcile' and reservation_id in (select id from public.spend_reservations where request_id in ('req-day-0002', 'req-day-0004'))), 'both reconciliations audited');

-- ---------------------------------------------------------------- rollover keeps outstanding liability
reset role;
insert into public.spend_reservations (user_id, request_id, fingerprint, model, source, reserved_micro, max_input_tokens, max_output_tokens, created_at)
  values (:B, 'req-yesterday-1', repeat('c', 64), 'claude-sonnet-5-5', 'scheduler', 900000, 1, 1, now() - interval '1 day');
set local role service_role;
-- B has 1 micro reserved today + 900000 outstanding from yesterday: 99,999 more fits, 100,000 does not.
select pg_temp.ok(pg_temp.reason(:B, 99999) is null and pg_temp.reason(:B, 100000) = 'cap_day', 'an unresolved reservation from yesterday still counts today');
select pg_temp.ok(public.spend_settle((select id from public.spend_reservations where request_id = 'req-yesterday-1'), 900000, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status' = 'settled', 'settle yesterday''s');
select pg_temp.ok(pg_temp.reason(:B, 999999) is null, 'settled into yesterday''s window: today is free again');

-- ---------------------------------------------------------------- ledger beyond the REST row limit
reset role;
update public.sponsored_accounts set daily_cap_usd = 100, monthly_cap_usd = 100 where user_id = :BIG;
insert into public.model_spend (user_id, model, usd) select :BIG, 'claude-sonnet-5-5', 0.001 from generate_series(1, 5000);
-- The ceiling column has 4 decimals: round the in-window total up to it, then the exact
-- micro-dollar headroom fits and one more does not.
update public.sponsor_config set global_monthly_ceiling_usd = ceil((
  (select sum(usd) from public.model_spend where ts >= date_trunc('month', now() at time zone 'utc') at time zone 'utc')
  + (select coalesce(sum(reserved_micro), 0) from public.spend_reservations where state in ('reserved', 'ambiguous'))::numeric / 1000000
  ) * 10000) / 10000 + 0.0001;
create temp table t_head as select ((select global_monthly_ceiling_usd from public.sponsor_config)
  - (select sum(usd) from public.model_spend where ts >= date_trunc('month', now() at time zone 'utc') at time zone 'utc')
  - (select coalesce(sum(reserved_micro), 0) from public.spend_reservations where state in ('reserved', 'ambiguous'))::numeric / 1000000) * 1000000 as micro;
grant select on t_head to service_role;
set local role service_role;
select pg_temp.ok((select micro::bigint = micro from t_head), 'headroom is a whole number of micro-dollars');
select pg_temp.ok(pg_temp.reason(:BIG, (select micro::bigint from t_head)) is null and pg_temp.reason(:BIG, (select micro::bigint + 1 from t_head)) = 'cap_global', 'global ceiling sums 5,000+ ledger rows exactly');
reset role;
update public.sponsor_config set global_monthly_ceiling_usd = 100.0;

-- ---------------------------------------------------------------- total beta budget and its start
insert into public.model_spend (user_id, ts, model, usd) values (:BIG, now() - interval '400 days', 'claude-sonnet-5-5', 9999); -- before budget start
-- In scope since the start (one hour ago): 5.0 (BIG) + 0.250001 (A) + 1 micro outstanding (B).
-- B's 0.9 is stamped yesterday, before the start, as is the 9999 row.
update public.sponsor_config set beta_budget_usd = 5.2501;
set local role service_role;
select pg_temp.ok(pg_temp.reason(:BIG, 98) is null and pg_temp.reason(:BIG, 99) = 'budget_total', 'total budget: exact headroom since its start; earlier spend excluded');
reset role;
update public.sponsor_config set beta_budget_usd = 50.0;

-- ---------------------------------------------------------------- pause, revocation, end date
update public.sponsor_config set spending_paused = true;
set local role service_role;
select pg_temp.ok(pg_temp.res(:BIG, 'req-paused-01', 1)->>'reason' = 'spending_paused', 'spending pause stops new reservations');
reset role;
update public.sponsor_config set spending_paused = false;
update public.sponsored_accounts set active = false where user_id = :BIG;
set local role service_role;
select pg_temp.ok(pg_temp.res(:BIG, 'req-revoked-1', 1)->>'reason' = 'account_inactive', 'revoked account denied');
reset role;
update public.sponsored_accounts set active = true, ends_at = now() - interval '1 minute' where user_id = :BIG;
set local role service_role;
select pg_temp.ok(pg_temp.res(:BIG, 'req-ended-001', 1)->>'reason' = 'account_inactive', 'ended account denied');
reset role;
update public.sponsored_accounts set ends_at = null where user_id = :BIG;

-- ---------------------------------------------------------------- overrun fails closed
set local role service_role;
select pg_temp.ok(pg_temp.res(:BIG, 'req-overrun-1', 10)->>'status' = 'reserved', 'reserve small');
select pg_temp.ok(public.spend_settle((select id from public.spend_reservations where request_id = 'req-overrun-1'), 25, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status' = 'overrun', 'actual above reservation recorded as overrun');
select pg_temp.ok((select usd = 0.000025 from public.model_spend where request_id = 'req-overrun-1'), 'full actual liability recorded, not capped');
select pg_temp.ok(pg_temp.res(:B, 'req-after-ovr', 1)->>'reason' = 'overrun_review', 'any unacknowledged overrun stops everyone');
select pg_temp.ok(public.spend_acknowledge_overrun((select id from public.spend_overruns limit 1), 'bound reviewed in test')->>'status' = 'acknowledged', 'acknowledge');
select pg_temp.ok(pg_temp.res(:B, 'req-after-ack', 1)->>'status' = 'reserved', 'resumes after acknowledgement');

-- ---------------------------------------------------------------- client roles cannot touch any of it
reset role;
do $$
declare stmt text;
begin
  foreach stmt in array array[
    $q$select public.spend_reserve('a0000000-0000-0000-0000-000000000001','req-forged-01',repeat('a',64),'claude-sonnet-5-5','x','proxy',1,1,1)$q$,
    $q$select public.spend_settle(gen_random_uuid(),0,'m',0,0,0,0,null,null)$q$,
    $q$select public.spending_contract_version()$q$,
    $q$insert into public.evidence_cache_trusted(pmid,extraction_version,source_hash,source_tier,extraction,model,provenance) values ('1','v',repeat('a',64),'full_text','{}','m','{"writer":"digest-run","bundle_source_sha256":"x"}')$q$,
    $q$update public.evidence_cache_trusted set model='x'$q$,
    $q$delete from public.evidence_cache_trusted$q$,
    $q$select public.spend_mark_ambiguous(gen_random_uuid(),'x',null)$q$,
    $q$select public.spend_reconcile(gen_random_uuid(),0,'long enough note')$q$,
    $q$select public.spend_acknowledge_overrun(1,'long enough note')$q$,
    $q$select public.spend_status('a0000000-0000-0000-0000-000000000001')$q$,
    $q$select public.spend_denial_reason('a0000000-0000-0000-0000-000000000001',1)$q$,
    $q$select public.digest_claim('a0000000-0000-0000-0000-000000000001',240)$q$,
    $q$select public.digest_claim_finish('a0000000-0000-0000-0000-000000000001',gen_random_uuid(),true,'x')$q$,
    $q$select public.scheduler_kv_write('a0000000-0000-0000-0000-000000000001',gen_random_uuid(),'digests','k','{}',false)$q$,
    $q$select public.redeem_sponsor_invite('X','a0000000-0000-0000-0000-000000000001')$q$,
    $q$select count(*) from public.spend_reservations$q$,
    $q$select count(*) from public.spend_overruns$q$,
    $q$select count(*) from public.spend_audit$q$,
    $q$select count(*) from public.model_spend$q$,
    $q$insert into public.model_spend(user_id,model,usd) values ('a0000000-0000-0000-0000-000000000001','m',-5)$q$,
    $q$update public.spend_reservations set state='reconciled'$q$,
    $q$update public.sponsor_config set spending_paused=false$q$,
    $q$select count(*) from public.sponsor_config$q$,
    $q$select count(*) from public.sponsor_invites$q$,
    $q$update public.digest_schedules set claim_token=null$q$
  ] loop
    foreach stmt in array array[stmt] loop
      begin
        execute 'set local role anon'; execute stmt; raise exception 'anon allowed: %', stmt;
      exception when insufficient_privilege then null; end;
      execute 'reset role';
      begin
        execute 'set local role authenticated';
        perform set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000001', true);
        execute stmt; raise exception 'authenticated allowed: %', stmt;
      exception when insufficient_privilege then null; end;
      execute 'reset role';
    end loop;
  end loop;
  raise notice 'ok: anon and authenticated rejected for every spending/claim/invite RPC and table write';
end $$;
reset role;
-- The trusted cache is readable by signed-in users only.
do $$ begin
  begin execute 'set local role anon'; perform count(*) from public.evidence_cache_trusted; raise exception 'anon read trusted cache';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
end $$;
set local role authenticated;
select pg_temp.ok((select count(*) >= 0 from public.evidence_cache_trusted), 'authenticated can read the trusted cache');
reset role;
-- Trusted rows must carry server provenance; the legacy table is untouched.
do $$ begin
  begin
    insert into public.evidence_cache_trusted(pmid,extraction_version,source_hash,source_tier,extraction,model,provenance) values ('1','v',repeat('a',64),'full_text','{}','m','{}');
    raise exception 'row without provenance accepted';
  exception when check_violation then null; end;
  begin
    insert into public.evidence_cache_trusted(pmid,extraction_version,source_hash,source_tier,extraction,model,provenance) values ('1','v',repeat('a',64),'user_text','{}','m','{"writer":"digest-run","bundle_source_sha256":"x"}');
    raise exception 'user_text accepted';
  exception when check_violation then null; end;
end $$;
insert into public.evidence_cache(pmid,extraction_version,source_hash,source_tier,extraction,model) values ('7','v1',repeat('c',64),'user_text','{"legacy":true}','m');
set local role service_role;
insert into public.evidence_cache_trusted(pmid,extraction_version,source_hash,source_tier,extraction,model,provenance) values ('7','v1',repeat('c',64),'full_text','{"trusted":true}','m','{"writer":"digest-run","bundle_source_sha256":"x"}');
select pg_temp.ok((select extraction->>'legacy' = 'true' from public.evidence_cache where pmid = '7') and (select extraction->>'trusted' = 'true' from public.evidence_cache_trusted where pmid = '7'), 'a trusted write with a legacy row''s key neither collides nor overwrites');
select pg_temp.ok(public.spending_contract_version() = '2026-10-09.spending-v2', 'contract marker');
reset role;

-- ---------------------------------------------------------------- scheduler claims
insert into public.digest_schedules (user_id) values (:A), (:B);
set local role service_role;
create temp table t_claim(tok uuid);
insert into t_claim select public.digest_claim(:A, 240);
select pg_temp.ok((select tok is not null from t_claim), 'first claim acquired');
select pg_temp.ok(public.digest_claim(:A, 240) is null, 'second claim refused while fresh');
select pg_temp.ok(public.digest_claim(:B, 240) is not null, 'another account claims independently');
select pg_temp.ok(public.scheduler_kv_write(:A, (select tok from t_claim), 'digests', 'daily:latest', '{"v":"owner"}', false), 'owner write lands');
select pg_temp.ok(not public.scheduler_kv_write(:A, gen_random_uuid(), 'digests', 'daily:latest', '{"v":"forged"}', false), 'wrong token writes nothing');
select pg_temp.ok(not public.digest_claim_finish(:A, gen_random_uuid(), true, 'forged'), 'wrong token cannot finish');
reset role;
update public.digest_schedules set claimed_at = now() - interval '10 minutes' where user_id = :A; -- the owner stalled
set local role service_role;
create temp table t_claim2(tok uuid);
insert into t_claim2 select public.digest_claim(:A, 240);
select pg_temp.ok((select t_claim2.tok is not null and t_claim2.tok <> t_claim.tok from t_claim, t_claim2), 'stale claim recovered with a new owner token');
select pg_temp.ok(not public.scheduler_kv_write(:A, (select tok from t_claim), 'digests', 'daily:latest', '{"v":"stale"}', false), 'stale owner cannot overwrite');
select pg_temp.ok(not public.digest_claim_finish(:A, (select tok from t_claim), true, 'stale done'), 'stale owner cannot clear the successor''s claim');
select pg_temp.ok((select claim_token = (select tok from t_claim2) from public.digest_schedules where user_id = :A), 'successor still holds the claim');
select pg_temp.ok((select value->>'v' = 'owner' from public.kv where user_id = :A and collection = 'digests'), 'stale write did not land');
do $$ begin
  begin perform public.scheduler_kv_write('a0000000-0000-0000-0000-000000000001', (select tok from t_claim2), 'papers', 'p', '{}', false); raise exception 'paper write allowed';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.ok(public.digest_claim_finish(:A, (select tok from t_claim2), true, 'done: 3 papers'), 'owner finishes');
select pg_temp.ok((select claim_token is null and claimed_at is null and last_run_at is not null and last_result = 'done: 3 papers' from public.digest_schedules where user_id = :A), 'finish clears claim and records the run');

-- ---------------------------------------------------------------- invitation state table
reset role;
insert into public.sponsor_invites (code, cohort, max_uses, expires_at) values
  ('BETA-OK', 'beta-test', 2, null), ('BETA-OTHER', 'other-cohort', 5, null),
  ('BETA-EXPIRED', 'beta-test', 5, now() - interval '1 minute'), ('BETA-ONE', 'beta-test', 1, null);
insert into public.sponsor_invites (code, cohort, max_uses, revoked_at) values ('BETA-REVOKED', 'beta-test', 5, now());
update public.sponsored_accounts set daily_cap_usd = 7, cohort = 'founder' where user_id = :A;
update public.sponsor_config set enrollment_paused = true, enrollment_limit = null;
set local role service_role;
select pg_temp.ok(public.redeem_sponsor_invite('NOPE', 'a0000000-0000-0000-0000-000000000004')->>'status' = 'invalid', 'invalid code');
select pg_temp.ok(public.redeem_sponsor_invite('BETA-OK', 'a0000000-0000-0000-0000-000000000004')->>'status' = 'paused', 'enrollment paused by default');
reset role;
update public.sponsor_config set enrollment_paused = false;
set local role service_role;
select pg_temp.ok(public.redeem_sponsor_invite('BETA-OK', 'a0000000-0000-0000-0000-000000000004')->>'status' = 'paused', 'no enrollment limit configured: fail closed');
reset role;
update public.sponsor_config set enrollment_limit = 5; -- active now: A, B, BIG
set local role service_role;
select pg_temp.ok(public.redeem_sponsor_invite('BETA-OK', 'a0000000-0000-0000-0000-000000000004')->>'status' = 'enrolled', 'new account enrolls');
select pg_temp.ok(public.redeem_sponsor_invite('BETA-OTHER', 'a0000000-0000-0000-0000-000000000004')->>'status' = 'already', 'repeat redemption with another code: already');
select pg_temp.ok((select uses = 0 from public.sponsor_invites where code = 'BETA-OTHER'), 'repeat redemption consumed no use');
select pg_temp.ok(public.redeem_sponsor_invite('BETA-OTHER', 'a0000000-0000-0000-0000-000000000001')->>'status' = 'already', 'existing active account: already');
select pg_temp.ok((select daily_cap_usd = 7 and cohort = 'founder' and ends_at is null from public.sponsored_accounts where user_id = 'a0000000-0000-0000-0000-000000000001'), 'existing account keeps cap/cohort/end');
select pg_temp.ok(public.redeem_sponsor_invite('BETA-EXPIRED', 'a0000000-0000-0000-0000-000000000005')->>'status' = 'expired', 'expired code');
select pg_temp.ok(public.redeem_sponsor_invite('BETA-REVOKED', 'a0000000-0000-0000-0000-000000000005')->>'status' = 'inactive', 'revoked code');
select pg_temp.ok(public.redeem_sponsor_invite('BETA-ONE', 'a0000000-0000-0000-0000-000000000005')->>'status' = 'enrolled', 'last use');
select pg_temp.ok(public.redeem_sponsor_invite('BETA-OTHER', 'a0000000-0000-0000-0000-000000000006')->>'status' = 'full', 'enrollment limit reached'); -- 5 active
reset role;
update public.sponsor_config set enrollment_limit = 10;
set local role service_role;
select pg_temp.ok(public.redeem_sponsor_invite('BETA-ONE', 'a0000000-0000-0000-0000-000000000006')->>'status' = 'exhausted', 'exhausted code');
reset role;
update public.sponsored_accounts set active = false where user_id = :B;
update public.sponsored_accounts set ends_at = now() - interval '1 day' where user_id = :BIG;
set local role service_role;
select pg_temp.ok(public.redeem_sponsor_invite('BETA-OTHER', 'a0000000-0000-0000-0000-000000000002')->>'status' = 'revoked', 'revoked account is not reactivated by a code');
select pg_temp.ok(public.redeem_sponsor_invite('BETA-OTHER', 'a0000000-0000-0000-0000-000000000003')->>'status' = 'revoked', 'ended account is not reactivated by a code');
select pg_temp.ok((select not active from public.sponsored_accounts where user_id = 'a0000000-0000-0000-0000-000000000002'), 'still inactive');
select pg_temp.ok(public.spend_reserve('a0000000-0000-0000-0000-000000000002', 'req-revoked-2', repeat('a', 64), 'claude-sonnet-5-5', 't', 'proxy', 1, 1, 1)->>'reason' = 'account_inactive', 'revocation stops spending');
reset role;
-- Expiring a code does not stop spending by accounts it already enrolled.
update public.sponsor_invites set expires_at = now() - interval '1 second' where code = 'BETA-OK';
set local role service_role;
select pg_temp.ok(public.spend_reserve('a0000000-0000-0000-0000-000000000004', 'req-expired-code', repeat('a', 64), 'claude-sonnet-5-5', 't', 'proxy', 1, 1, 1)->>'status' = 'reserved', 'code expiry is not revocation');
reset role;

-- ---------------------------------------------------------------- reservations bound to the scheduler claim
update public.sponsor_config set spending_paused = false, beta_budget_usd = 100000, global_monthly_ceiling_usd = 100000;
update public.spend_overruns set acknowledged_at = now() where acknowledged_at is null;
create or replace function pg_temp.sres(u uuid, rid text, tok uuid) returns jsonb language sql as $$
  select public.spend_reserve(u, rid, repeat('d', 64), 'claude-sonnet-5-5', 'scheduled-digest', 'scheduler', 1, 1, 1, tok)
$$;
set local role service_role;
create temp table t_claim3(tok uuid);
insert into t_claim3 select public.digest_claim(:A, 240);
select pg_temp.ok(pg_temp.sres(:A, 'sched-0001', null)->>'reason' = 'claim_lost', 'scheduler reservation without a token: denied');
select pg_temp.ok(pg_temp.sres(:A, 'sched-0002', gen_random_uuid())->>'reason' = 'claim_lost', 'scheduler reservation with a stale/foreign token: denied');
select pg_temp.ok(pg_temp.sres(:B, 'sched-0003', (select tok from t_claim3))->>'reason' = 'claim_lost', 'another account''s token does not transfer');
select pg_temp.ok((select count(*) = 0 from public.spend_reservations where request_id in ('sched-0001', 'sched-0002', 'sched-0003')), 'denied attempts reserved nothing');
reset role;
update public.digest_schedules set claimed_at = now() - interval '10 minutes' where user_id = :A; -- quiet long enough to look stale
set local role service_role;
select pg_temp.ok(pg_temp.sres(:A, 'sched-0004', (select tok from t_claim3))->>'status' = 'reserved', 'the owner''s attempt is admitted');
select pg_temp.ok((select claimed_at = now() from public.digest_schedules where user_id = :A), 'admission renewed the lease in the same transaction');
select pg_temp.ok(public.digest_claim(:A, 240) is null, 'so no successor can take over during the admitted attempt');
do $$ begin
  begin perform public.spend_reserve('a0000000-0000-0000-0000-000000000001', 'proxy-tok-01', repeat('d', 64), 'claude-sonnet-5-5', 'x', 'proxy', 1, 1, 1, gen_random_uuid()); raise exception 'proxy token accepted';
  exception when invalid_parameter_value then null; end;
end $$;
select pg_temp.ok(public.digest_claim_finish(:A, (select tok from t_claim3), true, 'done'), 'owner finishes');
select pg_temp.ok(pg_temp.sres(:A, 'sched-0005', (select tok from t_claim3))->>'reason' = 'claim_lost', 'after finishing, the old token reserves nothing');
reset role;

-- ---------------------------------------------------------------- liability survives account deletion
-- Codex review reproduction (2026-10-09), inverted and extended: historical, settled,
-- unresolved and post-deletion-reconciled spend of a deleted account keep counting for
-- every other account's global and total-budget admission, without double counting.
insert into auth.users(id) values ('d0000000-0000-0000-0000-000000000001'), ('d0000000-0000-0000-0000-000000000002');
insert into public.sponsored_accounts(user_id, active, daily_cap_usd, monthly_cap_usd) values
  ('d0000000-0000-0000-0000-000000000001', true, 1000, 1000), ('d0000000-0000-0000-0000-000000000002', true, 1000, 1000);
insert into public.model_spend(user_id, model, usd) values ('d0000000-0000-0000-0000-000000000001', 'claude-sonnet-5-5', 1.5); -- historical (pre-reservation) row
set local role service_role;
create temp table t_del(settled uuid, open uuid, later uuid);
insert into t_del values (
  (public.spend_reserve('d0000000-0000-0000-0000-000000000001', 'del-settled-1', repeat('e', 64), 'claude-sonnet-5-5', 't', 'proxy', 2000000, 1, 1)->>'reservation_id')::uuid,
  (public.spend_reserve('d0000000-0000-0000-0000-000000000001', 'del-open-0001', repeat('e', 64), 'claude-sonnet-5-5', 't', 'proxy', 700000, 1, 1)->>'reservation_id')::uuid,
  (public.spend_reserve('d0000000-0000-0000-0000-000000000001', 'del-later-001', repeat('e', 64), 'claude-sonnet-5-5', 't', 'proxy', 300000, 1, 1)->>'reservation_id')::uuid);
select pg_temp.ok(public.spend_settle((select settled from t_del), 1000000, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status' = 'settled', 'settled $1.00');
select pg_temp.ok(public.spend_mark_ambiguous((select later from t_del), 'timeout', null)->>'status' = 'ambiguous', 'one ambiguous, one still reserved');
reset role;
-- Headroom helpers, in micro-dollars, for the total budget and the global ceiling.
create or replace function pg_temp.head_budget() returns numeric language sql as $$
  select (c.beta_budget_usd
          - (select coalesce(sum(usd), 0) from public.model_spend where ts >= c.beta_budget_starts_at)
          - (select coalesce(sum(reserved_micro), 0) from public.spend_reservations where state in ('reserved', 'ambiguous'))::numeric / 1000000) * 1000000
  from public.sponsor_config c $$;
create or replace function pg_temp.head_global() returns numeric language sql as $$
  select (c.global_monthly_ceiling_usd
          - (select coalesce(sum(usd), 0) from public.model_spend where ts >= date_trunc('month', now() at time zone 'utc') at time zone 'utc')
          - (select coalesce(sum(reserved_micro), 0) from public.spend_reservations where state in ('reserved', 'ambiguous'))::numeric / 1000000) * 1000000
  from public.sponsor_config c $$;
-- Make the total budget the binding limit with a small, exact headroom.
update public.sponsor_config set beta_budget_usd = ceil(((100000 - pg_temp.head_budget() / 1000000) + 0.0001) * 10000) / 10000;
create temp table t_h(budget bigint);
insert into t_h select pg_temp.head_budget()::bigint;
grant select on t_h, t_del to service_role;
set local role service_role;
select pg_temp.ok((select budget between 1 and 200 from t_h), 'budget headroom is small and exact');
select pg_temp.ok(pg_temp.reason('d0000000-0000-0000-0000-000000000002', (select budget from t_h)) is null
              and pg_temp.reason('d0000000-0000-0000-0000-000000000002', (select budget + 1 from t_h)) = 'budget_total', 'before deletion: the other account sits exactly at the budget');
reset role;
delete from auth.users where id = 'd0000000-0000-0000-0000-000000000001';
select pg_temp.ok((select count(*) = 2 from public.model_spend where user_id = 'd0000000-0000-0000-0000-000000000001'), 'historical and settled ledger rows survive deletion');
select pg_temp.ok((select count(*) = 3 from public.spend_reservations where user_id = 'd0000000-0000-0000-0000-000000000001'), 'reservations survive deletion');
select pg_temp.ok(pg_temp.head_budget()::bigint = (select budget from t_h), 'headroom unchanged by deletion');
set local role service_role;
select pg_temp.ok(pg_temp.reason('d0000000-0000-0000-0000-000000000002', (select budget + 1 from t_h)) = 'budget_total', 'after deletion: the budget is still exhausted for everyone else');
select pg_temp.ok(public.spend_reconcile((select later from t_del), 300000, 'console: charged in full before the account was deleted')->>'status' = 'reconciled', 'an unresolved reservation of a deleted account reconciles into the ledger');
select pg_temp.ok(public.spend_settle((select open from t_del), 700000, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status' = 'settled', 'and settles after deletion');
reset role;
select pg_temp.ok(pg_temp.head_budget()::bigint = (select budget from t_h), 'moving liability into the ledger does not double count');
select pg_temp.ok((select count(*) = 4 from public.model_spend where user_id = 'd0000000-0000-0000-0000-000000000001'), 'four ledger rows for the deleted account');
-- Global ceiling, same check.
update public.sponsor_config set beta_budget_usd = 100000;
update public.sponsor_config set global_monthly_ceiling_usd = ceil(((100000 - pg_temp.head_global() / 1000000) + 0.0001) * 10000) / 10000;
create temp table t_g(head bigint);
insert into t_g select pg_temp.head_global()::bigint;
grant select on t_g to service_role;
set local role service_role;
select pg_temp.ok(pg_temp.reason('d0000000-0000-0000-0000-000000000002', (select head from t_g)) is null
              and pg_temp.reason('d0000000-0000-0000-0000-000000000002', (select head + 1 from t_g)) = 'cap_global', 'global ceiling still counts the deleted account''s spend');
reset role;

-- ---------------------------------------------------------------- scheduler hold and explicit recovery
-- supabase/migrations/20261010130000_scheduler_hold.sql. FIXTURE amounts throughout.
update public.sponsor_config set spending_paused = false, beta_budget_usd = 100000, global_monthly_ceiling_usd = 100000, beta_budget_starts_at = now() - interval '400 days';
update public.spend_overruns set acknowledged_at = now() where acknowledged_at is null;
insert into auth.users(id) values ('e0000000-0000-0000-0000-000000000001'), ('e0000000-0000-0000-0000-000000000002'), ('e0000000-0000-0000-0000-000000000003'), ('e0000000-0000-0000-0000-000000000004');
insert into public.sponsored_accounts(user_id, active, daily_cap_usd, monthly_cap_usd)
  select id, true, 1000, 1000 from auth.users where id::text like 'e0000000-%';
insert into public.digest_schedules(user_id) select id from auth.users where id::text like 'e0000000-%';
\set H1 '''e0000000-0000-0000-0000-000000000001'''
\set H2 '''e0000000-0000-0000-0000-000000000002'''
\set H3 '''e0000000-0000-0000-0000-000000000003'''
\set H4 '''e0000000-0000-0000-0000-000000000004'''
create or replace function pg_temp.status(u uuid) returns text language sql as $$ select coalesce(public.spend_status(u)->>'reason', 'allowed') $$;
create or replace function pg_temp.recover(u uuid, a text, n text default 'contract test recovery note') returns text language sql as $$
  select coalesce(r->>'reason', r->>'status') from (select public.scheduler_recover(u, a, n) as r) x $$;
create or replace function pg_temp.age_claim(u uuid) returns void language sql as $$
  update public.digest_schedules set claimed_at = now() - interval '241 seconds' where user_id = u $$;
create temp table t_hold(k text primary key, v uuid);
grant select, insert, update on t_hold to service_role;

set local role service_role;
select pg_temp.ok(public.scheduler_hold_reason(:H1) is null and pg_temp.status(:H1) = 'allowed', 'an account with no scheduler attempt is not held');
-- H4: settled attempts and denials never hold.
insert into t_hold values ('h4tok', public.digest_claim(:H4, 240));
insert into t_hold values ('h4res', (pg_temp.sres(:H4, 'hold-h4-0001', (select v from t_hold where k = 'h4tok'))->>'reservation_id')::uuid);
select pg_temp.ok(public.spend_settle((select v from t_hold where k = 'h4res'), 1, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status' = 'settled', 'H4: attempt settled');
select pg_temp.ok(public.scheduler_hold_reason(:H4) is null, 'a settled attempt never holds');
select pg_temp.ok(pg_temp.sres(:H4, 'hold-h4-0002', (select v from t_hold where k = 'h4tok'))->>'status' = 'reserved', 'so the same run''s next attempt is admitted (bounded retry, next step)');
select pg_temp.ok(public.spend_settle((pg_temp.sres(:H4, 'hold-h4-0002', (select v from t_hold where k = 'h4tok'))->>'reservation_id')::uuid, 1, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status' = 'settled', 'H4: second attempt settled');
select pg_temp.ok(public.digest_claim_finish(:H4, (select v from t_hold where k = 'h4tok'), true, 'done'), 'H4 finishes');

-- H1: a worker dies with an attempt reserved.
insert into t_hold values ('h1tok', public.digest_claim(:H1, 240));
insert into t_hold values ('h1res', (pg_temp.sres(:H1, 'hold-h1-0001', (select v from t_hold where k = 'h1tok'))->>'reservation_id')::uuid);
select pg_temp.ok(public.scheduler_hold_reason(:H1) = 'unresolved_liability' and pg_temp.status(:H1) = 'unresolved_liability', 'a reserved scheduler attempt holds the account; the preflight names it');
select pg_temp.ok(pg_temp.status(:H2) = 'allowed', 'another account is not held by it');
reset role;
select pg_temp.age_claim(:H1);
set local role service_role;
insert into t_hold values ('h1tok2', public.digest_claim(:H1, 240));
select pg_temp.ok((select v is not null from t_hold where k = 'h1tok2'), 'after the lease a successor CAN claim (claims are unchanged)');
select pg_temp.ok(pg_temp.sres(:H1, 'hold-h1-0002', (select v from t_hold where k = 'h1tok2'))->>'reason' = 'unresolved_liability', 'but it cannot reserve: the hold is enforced at reservation, under the claim');
select pg_temp.ok((select count(*) = 1 from public.spend_reservations where user_id = :H1), 'the refusal created no reservation');
select pg_temp.ok(pg_temp.res(:H1, 'hold-h1-proxy-1', 1)->>'status' = 'reserved', 'a browser-proxy attempt for the same account is unaffected (policy unchanged)');
select pg_temp.ok(pg_temp.recover(:H1, 'resume') = 'unresolved_liability', 'recovery is refused while the attempt is unresolved');
select pg_temp.ok(pg_temp.recover(:H1, 'abandon') = 'unresolved_liability' and pg_temp.recover(:H1, 'retire') = 'unresolved_liability', 'for every action');
do $$ begin
  begin perform public.scheduler_recover('e0000000-0000-0000-0000-000000000001', 'resume', 'short'); raise exception 'short note accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.scheduler_recover('e0000000-0000-0000-0000-000000000001', 'release', 'a long enough note'); raise exception 'unknown action accepted'; exception when invalid_parameter_value then null; end;
  begin perform public.scheduler_recover('e0000000-0000-0000-0000-000000000001', null, 'a long enough note'); raise exception 'null action accepted'; exception when invalid_parameter_value then null; end;
end $$;
select pg_temp.ok(public.scheduler_recover(gen_random_uuid(), 'resume', 'a long enough note')->>'status' = 'not_found', 'an account with no schedule: not_found');
reset role;
-- Across dates: the attempt is now from last month. Still held.
update public.spend_reservations set created_at = created_at - interval '40 days', updated_at = updated_at - interval '40 days' where user_id = :H1 and source = 'scheduler';
set local role service_role;
select pg_temp.ok(pg_temp.status(:H1) = 'unresolved_liability', 'the hold does not expire with the day or the month');
-- Reconciliation records the cost and releases nothing.
select pg_temp.ok(public.spend_reconcile((select v from t_hold where k = 'h1res'), 1, 'contract test: reconciled from the provider record')->>'status' = 'reconciled', 'H1: attempt reconciled');
select pg_temp.ok(pg_temp.status(:H1) = 'unresolved_liability', 'reconciling alone does not lift the hold');
select pg_temp.ok(pg_temp.sres(:H1, 'hold-h1-0003', (select v from t_hold where k = 'h1tok2'))->>'reason' = 'unresolved_liability', 'nor admit an attempt');
select pg_temp.ok(pg_temp.recover(:H1, 'resume') = 'run_in_progress', 'recovery is refused while a tick holds a live claim');
select pg_temp.ok((select recovery_ack_at is null and claim_token is not null from public.digest_schedules where user_id = :H1), 'a refused recovery changes nothing');
reset role;
select pg_temp.age_claim(:H1);
set local role service_role;
select pg_temp.ok(pg_temp.recover(:H1, 'resume') = 'recovered', 'explicit recovery (resume) succeeds once reconciled and no tick is live');
select pg_temp.ok((select recovery_ack_at is not null and claim_token is null and claimed_at is null and last_run_at is null and enabled and last_result = 'recovered: resume' from public.digest_schedules where user_id = :H1), 'resume acknowledges and clears the dead claim; the day is NOT marked run; the schedule stays enabled');
select pg_temp.ok((select recovered_at is not null and state = 'reconciled' and actual_micro = 1 and reserved_micro = 1 from public.spend_reservations where id = (select v from t_hold where k = 'h1res')), 'the reconciled attempt is stamped released; its state and amounts are untouched');
select pg_temp.ok((select count(*) = 0 from public.spend_reservations where recovered_at is not null and id <> (select v from t_hold where k = 'h1res')), 'no other reservation is stamped (the proxy attempt, other accounts)');
select pg_temp.ok((select count(*) = 1 and bool_and(detail->>'action' = 'resume' and detail->>'note' = 'contract test recovery note' and detail->>'role' = 'service_role') from public.spend_audit where action = 'scheduler_recover' and detail->>'user_id' = 'e0000000-0000-0000-0000-000000000001'), 'one audit row with the action, the note and the role');
select pg_temp.ok((select (detail->>'released_reservations')::int = 1 from public.spend_audit where action = 'scheduler_recover' and detail->>'user_id' = 'e0000000-0000-0000-0000-000000000001'), 'the audit row says how many reconciled attempts it released');
select pg_temp.ok(public.scheduler_hold_reason(:H1) is null and pg_temp.status(:H1) = 'allowed', 'the hold is lifted');
select pg_temp.ok(pg_temp.sres(:H1, 'hold-h1-0004', (select v from t_hold where k = 'h1tok2'))->>'reason' = 'claim_lost', 'the dead worker''s token is gone: recovery cannot be used to bypass the claim');
select pg_temp.ok(pg_temp.recover(:H1, 'resume') = 'not_held', 'a second recovery is refused: nothing is held');
select pg_temp.ok((select count(*) = 1 from public.spend_audit where action = 'scheduler_recover' and detail->>'user_id' = 'e0000000-0000-0000-0000-000000000001'), 'and writes no audit row');
-- The released run continues through the usual claim, and a NEW unresolved attempt holds again.
insert into t_hold values ('h1tok3', public.digest_claim(:H1, 240));
insert into t_hold values ('h1res2', (pg_temp.sres(:H1, 'hold-h1-0005', (select v from t_hold where k = 'h1tok3'))->>'reservation_id')::uuid);
select pg_temp.ok((select v is not null from t_hold where k = 'h1res2'), 'after recovery the next tick is admitted');
select pg_temp.ok(public.spend_mark_ambiguous((select v from t_hold where k = 'h1res2'), 'provider_status_500', null)->>'status' = 'ambiguous', 'its attempt ends ambiguous');
select pg_temp.ok(pg_temp.status(:H1) = 'unresolved_liability', 'an earlier acknowledgement does not pre-authorise a later failure');
select pg_temp.ok(public.digest_claim_finish(:H1, (select v from t_hold where k = 'h1tok3'), false, 'held: 0 papers'), 'the run ends without finishing the day');

-- H2: abandon. The unfinished scheduler digest is closed as abandoned; what was read is kept.
insert into t_hold values ('h2tok', public.digest_claim(:H2, 240));
select pg_temp.ok(public.scheduler_kv_write(:H2, (select v from t_hold where k = 'h2tok'), 'digests', 'daily:latest',
  '{"kind":"daily","runBy":"scheduler","ranAt":"2026-10-10T10:00:00Z","results":[{"paper":{"id":"p1"}}],"processedResults":[{"paper":{"id":"p1"}}],"triaged":{},"server":{"phase":"rank","held":{"reason":"unresolved_liability"}}}', false), 'H2: a digest with one paper read, waiting to rank');
insert into t_hold values ('h2res', (pg_temp.sres(:H2, 'hold-h2-0001', (select v from t_hold where k = 'h2tok'))->>'reservation_id')::uuid);
select pg_temp.ok(public.spend_mark_ambiguous((select v from t_hold where k = 'h2res'), 'timeout', null)->>'status' = 'ambiguous', 'H2: ranking ambiguous');
select pg_temp.ok(public.digest_claim_finish(:H2, (select v from t_hold where k = 'h2tok'), false, 'held: 1 papers'), 'H2: tick ends held');
select pg_temp.ok(public.spend_reconcile((select v from t_hold where k = 'h2res'), 0, 'contract test: provider shows no charge')->>'status' = 'reconciled', 'H2: reconciled at zero');
select pg_temp.ok(pg_temp.status(:H2) = 'unresolved_liability', 'a zero-cost reconciliation still does not resume');
select pg_temp.ok(public.scheduler_recover(:H2, 'abandon', 'contract test: abandon the digest')::text like '%"digest_closed": true%', 'abandon closes the unfinished digest');
select pg_temp.ok((select value->'server'->>'phase' = 'done' and (value->'server'->>'abandoned')::boolean and value->'server'->>'abandonedAt' is not null
                      and jsonb_array_length(value->'processedResults') = 1 and jsonb_array_length(value->'results') = 1 and value->'triaged' = '{}'::jsonb
                    from public.kv where user_id = :H2 and collection = 'digests' and key = 'daily:latest'), 'closed as done AND abandoned, with the read paper kept and no summary invented');
select pg_temp.ok((select last_run_at is not null and enabled and recovery_ack_at is not null and last_result = 'recovered: abandon' from public.digest_schedules where user_id = :H2), 'abandon marks the day run and leaves the schedule enabled');
select pg_temp.ok(pg_temp.status(:H2) = 'allowed', 'H2 is released');

-- H3: retire. Also: only an UNFINISHED SCHEDULER digest is ever closed.
insert into t_hold values ('h3tok', public.digest_claim(:H3, 240));
select pg_temp.ok(public.scheduler_kv_write(:H3, (select v from t_hold where k = 'h3tok'), 'digests', 'daily:latest',
  '{"kind":"daily","runBy":"scheduler","ranAt":"2026-10-09T10:00:00Z","results":[{"paper":{"id":"p9"}}],"processedResults":[{"paper":{"id":"p9"}}],"triaged":{"p9":{"score":80}},"server":{"phase":"done"}}', false), 'H3: yesterday''s FINISHED digest is on record');
insert into t_hold values ('h3res', (pg_temp.sres(:H3, 'hold-h3-0001', (select v from t_hold where k = 'h3tok'))->>'reservation_id')::uuid);
select pg_temp.ok(public.digest_claim_finish(:H3, (select v from t_hold where k = 'h3tok'), false, null), 'H3: tick ends');
select pg_temp.ok(public.spend_reconcile((select v from t_hold where k = 'h3res'), 1, 'contract test: reconciled from the provider record')->>'status' = 'reconciled', 'H3: reserved attempt reconciled');
select pg_temp.ok(public.scheduler_recover(:H3, 'retire', 'contract test: retire the account')::text like '%"digest_closed": false%', 'retire with no unfinished digest closes nothing');
select pg_temp.ok((select value->'server' = '{"phase":"done"}'::jsonb from public.kv where user_id = :H3 and collection = 'digests' and key = 'daily:latest'), 'a finished digest is never marked abandoned');
select pg_temp.ok((select not enabled and last_run_at is not null from public.digest_schedules where user_id = :H3), 'retire disables the schedule');
select pg_temp.ok(public.digest_claim(:H3, 240) is null, 'so nothing can claim the account afterwards');
reset role;

-- The health query (supabase/ops/spending_health.sql), run as written.
\set health_sql `sed -e 's/--.*$//' supabase/ops/spending_health.sql | tr '\n' ' ' | sed -e 's/;[[:space:]]*$//'`
create temp table t_health as select * from (:health_sql) h;
select pg_temp.ok((select count(*) = 1 and bool_and(state = 'unresolved_liability' and usd = 0.000001) from t_health where finding = 'scheduler_held' and ref = 'e0000000-0000-0000-0000-000000000001'), 'health: H1 (ambiguous) is reported as held with its unresolved amount');
select pg_temp.ok((select count(*) = 0 from t_health where finding = 'scheduler_held' and ref in ('e0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000004')), 'health: released and never-held accounts are not reported');
set local role service_role;
select pg_temp.ok(public.spend_reconcile((select v from t_hold where k = 'h1res2'), 1, 'contract test: reconciled from the provider record')->>'status' = 'reconciled', 'H1: second attempt reconciled');
insert into t_hold values ('h4tok2', public.digest_claim(:H4, 240));
select pg_temp.ok(pg_temp.sres(:H4, 'hold-h4-0003', (select v from t_hold where k = 'h4tok2'))->>'status' = 'reserved', 'H4: a live tick has an attempt in flight');
reset role;
create temp table t_health2 as select * from (:health_sql) h;
select pg_temp.ok((select count(*) = 1 and bool_and(state = 'reconciled_awaiting_recovery' and usd = 0) from t_health2 where finding = 'scheduler_held' and ref = 'e0000000-0000-0000-0000-000000000001'), 'health: reconciled but not released is reported as awaiting recovery');
select pg_temp.ok((select count(*) = 0 from t_health2 where finding = 'scheduler_held' and ref = 'e0000000-0000-0000-0000-000000000004'), 'health: the attempt a live tick is making is not a hold');
select pg_temp.age_claim(:H4);
create temp table t_health3 as select * from (:health_sql) h;
select pg_temp.ok((select count(*) = 1 and bool_and(state = 'unresolved_liability') from t_health3 where finding = 'scheduler_held' and ref = 'e0000000-0000-0000-0000-000000000004'), 'health: once the lease expires the same reservation IS a hold (killed worker)');

-- Client roles: no recovery, no hold probe, and the acknowledgement column is server-owned.
do $$
declare stmt text;
begin
  foreach stmt in array array[
    $q$select public.scheduler_recover('e0000000-0000-0000-0000-000000000001','resume','a long enough note')$q$,
    $q$select public.scheduler_recover('e0000000-0000-0000-0000-000000000001','abandon','a long enough note')$q$,
    $q$select public.scheduler_recover('e0000000-0000-0000-0000-000000000001','retire','a long enough note')$q$,
    $q$select public.scheduler_hold_reason('e0000000-0000-0000-0000-000000000001')$q$,
    $q$select public.spend_status('e0000000-0000-0000-0000-000000000001')$q$,
    $q$update public.digest_schedules set recovery_ack_at = now() where user_id = 'e0000000-0000-0000-0000-000000000001'$q$,
    $q$select recovery_ack_at from public.digest_schedules$q$,
    $q$update public.spend_reservations set recovered_at = now()$q$
  ] loop
    begin execute 'set local role anon'; execute stmt; raise exception 'anon allowed: %', stmt; exception when insufficient_privilege then null; end;
    execute 'reset role';
    begin
      execute 'set local role authenticated';
      perform set_config('request.jwt.claim.sub', 'e0000000-0000-0000-0000-000000000001', true);
      execute stmt; raise exception 'authenticated allowed: %', stmt;
    exception when insufficient_privilege then null; end;
    execute 'reset role';
  end loop;
end $$;
select pg_temp.ok((select recovery_ack_at is not null and pg_temp.status('e0000000-0000-0000-0000-000000000001') = 'unresolved_liability' from public.digest_schedules where user_id = :H1), 'the held account''s own user cannot recover it: still held');

select 'PASS: spending_contract.sql' as result;
rollback;
