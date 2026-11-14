-- Email readers (20261114120000_resume_exempt_and_email_survey.sql), on a DISPOSABLE database
-- only (supabase/tests/run_beta_admin_tests.sh). One transaction, rolled back.
-- Covers: the signed survey path records day 30 for the given account under the same rules
-- as the app (30-day gate, beta access, option codes, first write wins), only the service
-- role may call it, the app's wrapper still works, and pause_exempt_at exists and is not
-- readable by participants.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
create or replace function pg_temp.ok(v boolean, label text) returns void language plpgsql as $$
begin if not coalesce(v, false) then raise exception 'FAIL: %', label; end if; raise notice 'ok: %', label; end $$;
create or replace function pg_temp.fails(sql text, state text, label text) returns void language plpgsql as $$
begin
  begin execute sql; raise exception 'FAIL: % (no error)', label;
  exception when others then
    if sqlstate <> state then raise exception 'FAIL: % (got % %)', label, sqlstate, sqlerrm; end if;
  end;
  raise notice 'ok: %', label;
end $$;
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', u::text, true)
$$;
grant execute on function pg_temp.ok(boolean, text), pg_temp.fails(text, text, text), pg_temp.as_user(uuid) to anon, authenticated, service_role;

insert into auth.users(id) select ('d4000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 4) i;
\set OLD '''d4000000-0000-0000-0000-000000000001'''
\set NEW '''d4000000-0000-0000-0000-000000000002'''
\set NONBETA '''d4000000-0000-0000-0000-000000000003'''
\set APP '''d4000000-0000-0000-0000-000000000004'''
insert into public.sponsored_accounts (user_id, active, cohort, created_at) values
  (:OLD, true, 'pilot-1', now() - interval '31 days'),
  (:NEW, true, 'pilot-1', now() - interval '29 days'),
  (:APP, true, 'pilot-1', now() - interval '31 days');
\set GOOD '''{"read_frequency":"weekly","weekly_time":"1_3h","confidence":"4","if_gone":"very_disappointed","digest_fit":"5"}'''

-- ---------------------------------------------------------------- who may call it
set local role authenticated;
select pg_temp.as_user(:OLD);
select pg_temp.fails(format('select public.beta_survey_submit_signed(%L, %L, %L)', :OLD, 'day30-v1', :GOOD), '42501', 'a signed-in reader cannot call the signed path, even for themself');
reset role;
set local role anon;
select pg_temp.fails(format('select public.beta_survey_submit_signed(%L, %L, %L)', :OLD, 'day30-v1', :GOOD), '42501', 'anon cannot call the signed path');
reset role;
select pg_temp.ok(not has_function_privilege('authenticated', 'private.beta_survey_record(uuid, text, text, text, jsonb)', 'execute'), 'the shared body is not callable by readers');

-- ---------------------------------------------------------------- the signed path
set local role service_role;
select pg_temp.fails(format('select public.beta_survey_submit_signed(%L, %L, %L)', :NEW, 'day30-v1', :GOOD), '22023', 'refused before day 30');
select pg_temp.fails(format('select public.beta_survey_submit_signed(%L, %L, %L)', :NONBETA, 'day30-v1', :GOOD), '42501', 'refused without beta access');
select pg_temp.fails(format('select public.beta_survey_submit_signed(%L, %L, %L)', :OLD, 'day30-v1', '{"read_frequency":"weekly","weekly_time":"1_3h","confidence":"4","if_gone":"meh","digest_fit":"5"}'), '22023', 'refuses a code that is not offered');
select pg_temp.fails(format('select public.beta_survey_submit_signed(%L, %L, %L)', :OLD, 'day30-v1', '{}'), '22023', 'refuses an empty answer set (no skip)');
select pg_temp.ok((public.beta_survey_submit_signed(:OLD, 'day30-v1', :GOOD))->>'status' = 'recorded', 'records day 30 for the given account');
select pg_temp.ok((public.beta_survey_submit_signed(:OLD, 'day30-v1', :GOOD))->>'status' = 'already', 'a second answer is a no-op');
select pg_temp.ok((select wave = 'day30' and status = 'completed' and cohort = 'pilot-1' and digest_fit = 5 and if_gone = 'very_disappointed'
  from public.beta_survey_responses where user_id = :OLD), 'the row carries the answers and the cohort');
reset role;

-- ---------------------------------------------------------------- the app path is unchanged
set local role authenticated;
select pg_temp.as_user(:APP);
select pg_temp.ok((public.beta_survey_submit('day30', 'day30-v1', 'completed', :GOOD))->>'status' = 'recorded', 'the app wrapper records for the signed-in reader');
select pg_temp.ok((select (j->>'recorded') = 'completed' from (select public.beta_survey_day30_state() j) x), 'the app sees the answer');
select pg_temp.as_user(:OLD);
select pg_temp.ok((public.beta_survey_submit('day30', 'day30-v1', 'completed', :GOOD))->>'status' = 'already', 'an email answer counts in the app too');
select pg_temp.fails($q$select public.beta_survey_submit('day30', 'day30-v1', 'skipped')$q$, '22023', 'the app still cannot skip day 30');
select pg_temp.fails($q$select pause_exempt_at from public.digest_schedules$q$, '42501', 'participants cannot read pause_exempt_at');
reset role;

-- ---------------------------------------------------------------- the backfill
select pg_temp.ok((select count(*) = 1 from information_schema.columns where table_name = 'digest_schedules' and column_name = 'pause_exempt_at' and data_type like 'timestamp%'), 'pause_exempt_at exists');
insert into public.digest_schedules (user_id) values (:OLD), (:APP);
insert into public.events (user_id, type, payload, ts) values (:OLD, 'digest_resume_clicked', '{}', now() - interval '3 days'), (:OLD, 'digest_resume_clicked', '{}', now() - interval '1 day');
update public.digest_schedules d set pause_exempt_at = e.at
  from (select user_id, max(ts) as at from public.events where type = 'digest_resume_clicked' group by user_id) e
 where e.user_id = d.user_id and d.pause_exempt_at is null;
select pg_temp.ok((select pause_exempt_at = now() - interval '1 day' from public.digest_schedules where user_id = :OLD), 'backfill takes the latest press');
select pg_temp.ok((select pause_exempt_at is null from public.digest_schedules where user_id = :APP), 'no press, no exemption');

rollback;
