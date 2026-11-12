-- Day-30 survey contract (20261111120000_beta_survey_day30.sql), on a DISPOSABLE database
-- only (supabase/tests/run_beta_admin_tests.sh). One transaction, rolled back.
-- Covers: the 30-day gate, no skipping the day-30 wave, per-wave validation, idempotency, the
-- caller's own state, that answers stay unreadable to participants, and the admin stats
-- (authorization, distributions, paired change, test exclusions, no user ids).
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
grant execute on function pg_temp.ok(boolean, text), pg_temp.fails(text, text, text), pg_temp.as_user(uuid) to anon, authenticated;

insert into auth.users(id) select ('d3000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid from generate_series(1, 8) i;
\set ADMIN '''d3000000-0000-0000-0000-000000000001'''
\set OLD1 '''d3000000-0000-0000-0000-000000000002'''
\set OLD2 '''d3000000-0000-0000-0000-000000000003'''
\set NEW '''d3000000-0000-0000-0000-000000000004'''
\set NONBETA '''d3000000-0000-0000-0000-000000000005'''
\set SMOKE '''d3000000-0000-0000-0000-000000000006'''
\set OLD3 '''d3000000-0000-0000-0000-000000000007'''
insert into private.beta_admins (user_id) values (:ADMIN);
insert into public.sponsored_accounts (user_id, active, cohort, created_at) values
  (:OLD1, true, 'pilot-1', now() - interval '35 days'),
  (:OLD2, true, 'pilot-1', now() - interval '31 days'),
  (:OLD3, false, 'pilot-1', now() - interval '45 days'),
  (:NEW, true, 'pilot-1', now() - interval '29 days 23 hours'),
  (:SMOKE, true, 'smoke-qa-20261015', now() - interval '40 days');
-- Signup answers recorded directly (as the service role) so the pairing has a baseline.
insert into public.beta_survey_responses (user_id, wave, survey_version, status, cohort, reason, read_frequency, weekly_time, confidence, responded_at) values
  (:OLD1, 'signup', 'signup-v1', 'completed', 'pilot-1', 'stay_current', 'weekly', '1_3h', 2, now() - interval '35 days'),
  (:OLD2, 'signup', 'signup-v1', 'completed', 'pilot-1', 'find_papers', 'monthly', '30_60m', 3, now() - interval '31 days'),
  (:SMOKE, 'signup', 'signup-v1', 'completed', 'smoke-qa-20261015', 'other', 'daily', 'gt_3h', 1, now() - interval '40 days');

\set GOOD '''{"read_frequency":"several_weekly","weekly_time":"30_60m","confidence":"4","if_gone":"very_disappointed","digest_fit":"5"}'''

-- ---------------------------------------------------------------- the 30-day gate
set local role authenticated;
select pg_temp.fails($q$select public.beta_survey_day30_state()$q$, '42501', 'no jwt: state refused');
select pg_temp.as_user(:NEW);
select pg_temp.ok((select (j->>'eligible')::boolean = false and j->>'recorded' is null and j->>'opens_at' is not null from (select public.beta_survey_day30_state() j) x), 'state: an account at day 29 is not eligible yet');
select pg_temp.fails(format('select public.beta_survey_submit(%L, %L, %L, %L)', 'day30', 'day30-v1', 'completed', :GOOD), '22023', 'day 29: a completed day-30 answer is refused');
select pg_temp.fails($q$select public.beta_survey_submit('day30', 'day30-v1', 'skipped')$q$, '22023', 'day 29: a skip is refused too');
select pg_temp.as_user(:NONBETA);
select pg_temp.ok((select (j->>'eligible')::boolean = false and j->>'opens_at' is null from (select public.beta_survey_day30_state() j) x), 'state: a non-beta account is never eligible');
select pg_temp.fails(format('select public.beta_survey_submit(%L, %L, %L, %L)', 'day30', 'day30-v1', 'completed', :GOOD), '42501', 'a non-beta account cannot answer');
select pg_temp.fails($q$select public.beta_survey_submit('day60', 'v1', 'skipped')$q$, '22023', 'an unknown wave is refused');

-- ---------------------------------------------------------------- answers: per-wave validation
select pg_temp.as_user(:OLD1);
select pg_temp.ok((select (j->>'eligible')::boolean and j->>'recorded' is null from (select public.beta_survey_day30_state() j) x), 'state: day 35, eligible, nothing recorded');
select pg_temp.fails($q$select public.beta_survey_submit('day30', 'day30-v1', 'completed', '{"reason":"stay_current","read_frequency":"weekly","weekly_time":"1_3h","confidence":"4"}')$q$, '22023', 'the signup answer set is not a day-30 answer (no if_gone / digest_fit)');
select pg_temp.fails($q$select public.beta_survey_submit('day30', 'day30-v1', 'completed', '{"read_frequency":"weekly","weekly_time":"1_3h","confidence":"4","if_gone":"meh","digest_fit":"3"}')$q$, '22023', 'if_gone outside the offered options is refused');
select pg_temp.fails($q$select public.beta_survey_submit('day30', 'day30-v1', 'completed', '{"read_frequency":"weekly","weekly_time":"1_3h","confidence":"4","if_gone":"not_disappointed","digest_fit":"6"}')$q$, '22023', 'digest_fit outside 1..5 is refused');
select pg_temp.fails($q$select public.beta_survey_submit('day30', 'day30-v1', 'completed', '{"read_frequency":"weekly","weekly_time":"1_3h","if_gone":"not_disappointed","digest_fit":"3"}')$q$, '22023', 'a missing habit answer is refused');
select pg_temp.ok((select count(*) = 1 from public.beta_survey_responses), 'refused submits stored nothing (only the signup row is visible)');
select pg_temp.ok((public.beta_survey_submit('day30', 'day30-v1', 'completed', :GOOD))->>'status' = 'recorded', 'OLD1 completes the day-30 survey');
select pg_temp.ok((public.beta_survey_submit('day30', 'day30-v1', 'completed', :GOOD))->>'status' = 'already', 'a repeat answer is a no-op');
select pg_temp.ok((select j->>'recorded' = 'completed' from (select public.beta_survey_day30_state() j) x), 'state: recorded = completed');
select pg_temp.fails($q$select if_gone from public.beta_survey_responses$q$, '42501', 'participants cannot read if_gone back');
select pg_temp.fails($q$select digest_fit from public.beta_survey_responses$q$, '42501', 'participants cannot read digest_fit back');
-- The signup wave is untouched: OLD1's signup row still answers already.
select pg_temp.ok((public.beta_survey_submit('signup', 'signup-v1', 'skipped'))->>'recorded_status' = 'completed', 'signup row unaffected');
select pg_temp.as_user(:NEW);
select pg_temp.fails($q$select public.beta_survey_submit('signup', 'v1', 'completed', '{"read_frequency":"weekly","weekly_time":"1_3h","confidence":"4","if_gone":"very_disappointed","digest_fit":"5"}')$q$, '22023', 'a day-30 answer set is not a signup answer (no reason)');

select pg_temp.as_user(:OLD2);
select pg_temp.ok((public.beta_survey_submit('day30', 'day30-v1', 'completed', '{"read_frequency":"monthly","weekly_time":"30_60m","confidence":"2","if_gone":"stopped_using","digest_fit":"2"}'))->>'status' = 'recorded', 'OLD2 completes (lower confidence, same time)');
select pg_temp.as_user(:OLD3);
select pg_temp.fails($q$select public.beta_survey_submit('day30', 'day30-v1', 'skipped')$q$, '22023', 'the day-30 wave cannot be skipped');
select pg_temp.ok((select (j->>'eligible')::boolean and j->>'recorded' is null from (select public.beta_survey_day30_state() j) x), 'state: after a refused skip, still eligible and unanswered (asked again)');
select pg_temp.as_user(:SMOKE);
select pg_temp.ok((public.beta_survey_submit('day30', 'day30-v1', 'completed', '{"read_frequency":"daily","weekly_time":"lt_30m","confidence":"5","if_gone":"very_disappointed","digest_fit":"5"}'))->>'status' = 'recorded', 'the smoke account can answer (excluded from stats below)');
reset role;

-- Table constraint holds even for the service role.
select pg_temp.fails(format('insert into public.beta_survey_responses (user_id, wave, survey_version, status, read_frequency, weekly_time, confidence) values (%L, %L, %L, %L, %L, %L, 3)', :NEW, 'day30', 'v1', 'completed', 'weekly', '1_3h'), '23514', 'a completed day-30 row without its new answers violates the check');
select pg_temp.fails(format('insert into public.beta_survey_responses (user_id, wave, survey_version, status, reason, read_frequency, weekly_time, confidence, if_gone) values (%L, %L, %L, %L, %L, %L, %L, 3, %L)', :NEW, 'signup', 'v1', 'completed', 'other', 'weekly', '1_3h', 'stopped_using'), '23514', 'a signup row cannot carry day-30 answers');

-- ---------------------------------------------------------------- admin stats
set local role authenticated;
select pg_temp.as_user(:OLD1);
select pg_temp.fails($q$select public.beta_survey30_stats()$q$, '42501', 'a non-admin is refused');
select pg_temp.as_user(:ADMIN);
create temp table s30 as select public.beta_survey30_stats() j;
select pg_temp.ok((select (j->>'eligible_now')::int = 3 from s30), 'eligible_now: OLD1, OLD2, OLD3 (not NEW at day 29, not the smoke account)');
select pg_temp.ok((select (j->>'completed')::int = 2 and not j ? 'skipped' from s30), '2 completed (OLD3 has not answered); the smoke answer is excluded');
select pg_temp.ok((select j->'if_gone' = '{"very_disappointed": 1, "stopped_using": 1}'::jsonb from s30), 'if_gone distribution');
select pg_temp.ok((select j->'digest_fit' = '{"5": 1, "2": 1}'::jsonb and j->'confidence' = '{"4": 1, "2": 1}'::jsonb from s30), 'digest_fit and confidence distributions');
select pg_temp.ok((select (j->'paired'->>'n')::int = 2 from s30), 'paired: both completers had a signup answer');
select pg_temp.ok((select j->'paired'->'confidence' = '{"up": 1, "same": 0, "down": 1}'::jsonb from s30), 'paired confidence: OLD1 2->4 up, OLD2 3->2 down');
select pg_temp.ok((select j->'paired'->'weekly_time' = '{"more": 0, "same": 1, "less": 1}'::jsonb from s30), 'paired time: OLD1 1-3h -> 30-60m less, OLD2 same');
select pg_temp.ok((select j::text not like '%d3000000-%' from s30), 'stats carry no user ids');
reset role;

rollback;
