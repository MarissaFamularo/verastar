-- Beta admin dashboard and signup survey contract, on a DISPOSABLE database only
-- (supabase/tests/run_beta_admin_tests.sh builds one). One transaction, rolled back.
-- Covers: allowlist authorization (anon, signed-in non-admin, admin), survey submit /
-- skip / duplicate / invalid / RLS isolation, and the metric arithmetic for retries,
-- empty results, continuation ticks, browser runs, showcase exclusion and the range filter.
\set ON_ERROR_STOP on
begin;
set local timezone = 'UTC';
create or replace function pg_temp.ok(v boolean, label text) returns void language plpgsql as $$
begin if not coalesce(v, false) then raise exception 'FAIL: %', label; end if; raise notice 'ok: %', label; end $$;
-- Expect a call to fail with the given SQLSTATE.
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
-- The private-default-privileges migration revokes the default EXECUTE on new functions.
grant execute on function pg_temp.ok(boolean, text), pg_temp.fails(text, text, text), pg_temp.as_user(uuid) to anon, authenticated;

insert into auth.users(id) values
  ('b0000000-0000-0000-0000-00000000000a'), ('b0000000-0000-0000-0000-00000000000b'),
  ('b0000000-0000-0000-0000-00000000000c'), ('b0000000-0000-0000-0000-00000000000d'),
  ('b0000000-0000-0000-0000-00000000000e');
\set ADMIN '''b0000000-0000-0000-0000-00000000000a'''
\set B '''b0000000-0000-0000-0000-00000000000b'''
\set C '''b0000000-0000-0000-0000-00000000000c'''
\set D '''b0000000-0000-0000-0000-00000000000d'''
\set E '''b0000000-0000-0000-0000-00000000000e'''

-- ---------------------------------------------------------------- fixture
insert into public.sponsored_accounts (user_id, active, cohort, created_at) values
  (:B, true, 'pilot-1', now() - interval '10 days'),
  (:C, true, 'pilot-1', now() - interval '40 days'),
  (:D, false, 'pilot-2', now() - interval '5 days');

-- Scheduled ticks. D0 = today's UTC midnight.
create temp table d0 as select date_trunc('day', now()) as t;
insert into public.events (user_id, ts, type, payload)
select :B, (select t from d0) - interval '3 days' + x.off, 'digest_scheduled_run', x.p from (values
  (interval '6 hours',           '{"phase":"reading","papers":0,"read":3,"manual":false}'::jsonb),
  (interval '6 hours 5 minutes', '{"phase":"rank","papers":0,"read":1,"manual":false}'),
  (interval '6 hours 10 minutes','{"phase":"done","papers":4,"read":0,"manual":false}')) as x(off, p);
insert into public.events (user_id, ts, type, payload)
select :B, (select t from d0) - interval '2 days' + x.off, 'digest_scheduled_run', x.p from (values
  (interval '6 hours',            '{"phase":"error","papers":0,"read":0,"manual":false}'::jsonb),
  (interval '6 hours 30 minutes', '{"phase":"done","papers":2,"read":2,"manual":false}')) as x(off, p);
insert into public.events (user_id, ts, type, payload) values
  (:C, (select t from d0) - interval '2 days' + interval '7 hours', 'digest_scheduled_run', '{"phase":"empty","papers":0,"read":0,"manual":true}'),
  (:C, (select t from d0) - interval '1 day' + interval '7 hours', 'digest_scheduled_run', '{"phase":"error","papers":0,"read":0,"manual":false}'),
  (:C, (select t from d0) - interval '1 day' + interval '7 hours 20 minutes', 'digest_scheduled_run', '{"phase":"error","papers":0,"read":0,"manual":false}'),
  (:D, (select t from d0) - interval '1 day' + interval '8 hours', 'digest_scheduled_run', '{"phase":"reading","papers":0,"read":2,"manual":false}'),
  (:C, now() - interval '60 days', 'digest_scheduled_run', '{"phase":"done","papers":9,"read":9,"manual":false}');
-- Browser runs.
insert into public.events (user_id, ts, type, payload) values
  (:B, now() - interval '4 days', 'digest_run', '{"papers":3,"processed":3,"errors":0,"append":false,"showcase":false}'),
  (:B, now() - interval '3 days', 'digest_run', '{"papers":0,"processed":0,"errors":0,"append":false,"showcase":false}'),
  (:E, now() - interval '3 days', 'digest_run', '{"papers":5,"processed":5,"errors":0,"append":false,"showcase":true}'),
  (:C, now() - interval '2 days', 'digest_run', '{"papers":2,"processed":2,"errors":1,"append":true,"showcase":false}');
insert into public.events (user_id, ts, type, payload) values
  (:B, now() - interval '3 days', 'digest_opened', '{"runBy":"scheduler","papers":4}'),
  (:B, now() - interval '2 days', 'digest_opened', '{"runBy":"scheduler","papers":2}'),
  (:C, now() - interval '2 days', 'digest_opened', '{"runBy":"user","papers":2}');
insert into public.evidence_cache_trusted (pmid, extraction_version, source_hash, source_tier, extraction, model, provenance, created_by, created_at) values
  ('11111', 'v1', repeat('a', 64), 'abstract_only', '{}', 'm', '{"writer":"digest-run","bundle_source_sha256":"x"}', :B, now() - interval '3 days'),
  ('11111', 'v1', repeat('b', 64), 'full_text', '{}', 'm', '{"writer":"digest-run","bundle_source_sha256":"x"}', :B, now() - interval '2 days'),
  ('22222', 'v1', repeat('c', 64), 'abstract_only', '{}', 'm', '{"writer":"digest-run","bundle_source_sha256":"x"}', :C, now() - interval '2 days'),
  ('33333', 'v1', repeat('d', 64), 'abstract_only', '{}', 'm', '{"writer":"digest-run","bundle_source_sha256":"x"}', :C, now() - interval '50 days');

-- ---------------------------------------------------------------- survey: submit, skip, duplicates, validation
set local role authenticated;
select pg_temp.fails($q$select public.beta_survey_submit('signup', 'v1', 'skipped')$q$, '42501', 'no jwt: survey refused');
select pg_temp.as_user(:B);
select pg_temp.ok((public.beta_survey_submit('signup', 'v1', 'completed', '{"reason":"stay_current","read_frequency":"weekly","weekly_time":"1_3h","confidence":"4"}'))->>'status' = 'recorded', 'B completes the survey');
select pg_temp.ok((public.beta_survey_submit('signup', 'v1', 'completed', '{"reason":"other","read_frequency":"daily","weekly_time":"gt_3h","confidence":"1"}'))->>'status' = 'already', 'B resubmitting is idempotent');
select pg_temp.ok((public.beta_survey_submit('signup', 'v1', 'skipped'))->>'recorded_status' = 'completed', 'a later skip does not overwrite the completed row');
select pg_temp.ok((select count(*) = 1 and bool_and(status = 'completed' and wave = 'signup') from public.beta_survey_responses), 'B sees exactly her own row''s status');
select pg_temp.fails($q$select cohort from public.beta_survey_responses$q$, '42501', 'B cannot read the cohort label through the survey row');
select pg_temp.fails($q$select reason from public.beta_survey_responses$q$, '42501', 'B cannot read answers back through the API either');
select pg_temp.fails($q$insert into public.beta_survey_responses (user_id, wave, survey_version, status) values ('b0000000-0000-0000-0000-00000000000b', 'day30', 'v1', 'skipped')$q$, '42501', 'direct insert by a user is refused');
select pg_temp.as_user(:C);
select pg_temp.ok((select count(*) from public.beta_survey_responses) = 0, 'C cannot read B''s row');
select pg_temp.fails($q$select cohort from public.beta_survey_responses$q$, '42501', 'C cannot read any cohort label');
select pg_temp.ok((public.beta_survey_submit('signup', 'v1', 'skipped'))->>'status' = 'recorded', 'C skips');
select pg_temp.fails($q$select cohort from public.beta_survey_responses$q$, '42501', 'a skipped row hides the cohort label too');
select pg_temp.ok((public.beta_survey_submit('signup', 'v1', 'completed', '{"reason":"other","read_frequency":"daily","weekly_time":"gt_3h","confidence":"5"}'))->>'recorded_status' = 'skipped', 'C''s skip is final: no second prompt result');
select pg_temp.as_user(:D);
select pg_temp.fails($q$select public.beta_survey_submit('signup', 'v1', 'completed', '{"reason":"stay_current","read_frequency":"weekly","weekly_time":"1_3h","confidence":"7"}')$q$, '22023', 'confidence outside 1..5 is refused');
select pg_temp.fails($q$select public.beta_survey_submit('signup', 'v1', 'completed', '{"reason":"free text here","read_frequency":"weekly","weekly_time":"1_3h","confidence":"3"}')$q$, '22023', 'an answer outside the offered options is refused');
select pg_temp.fails($q$select public.beta_survey_submit('signup', 'v1', 'completed', '{"reason":"stay_current","read_frequency":"weekly","confidence":"3"}')$q$, '22023', 'a missing answer is refused');
select pg_temp.fails($q$select public.beta_survey_submit('day30', 'v1', 'skipped')$q$, '22023', 'the day-30 wave is not accepted yet');
select pg_temp.fails($q$select public.beta_survey_submit('signup', 'v1', 'maybe')$q$, '22023', 'an unknown status is refused');
select pg_temp.ok((select count(*) from public.beta_survey_responses) = 0, 'a refused submit stores nothing for D');
-- Eligibility: E is signed in but never redeemed a code (no sponsored_accounts row).
select pg_temp.as_user(:E);
select pg_temp.fails($q$select public.beta_survey_submit('signup', 'v1', 'skipped')$q$, '42501', 'a non-beta account cannot skip');
select pg_temp.fails($q$select public.beta_survey_submit('signup', 'v1', 'completed', '{"reason":"stay_current","read_frequency":"weekly","weekly_time":"1_3h","confidence":"3"}')$q$, '42501', 'a non-beta account cannot complete');
select pg_temp.ok((select count(*) from public.beta_survey_responses) = 0, 'nothing stored for the non-beta account');
reset role;
select pg_temp.ok((select count(*) from public.beta_survey_responses) = 2, 'two rows in all: one completed, one skipped');
select pg_temp.ok((select cohort from public.beta_survey_responses where user_id = :B) = 'pilot-1' and (select cohort from public.beta_survey_responses where user_id = :C) = 'pilot-1', 'the cohort label is stored and readable by the service role only');
-- A response recorded before eligibility was enforced (or after access ended) still answers idempotently.
insert into public.beta_survey_responses (user_id, wave, survey_version, status) values (:E, 'signup', 'v0', 'skipped');
set local role authenticated;
select pg_temp.as_user(:E);
select pg_temp.ok((public.beta_survey_submit('signup', 'v1', 'completed', '{"reason":"other","read_frequency":"daily","weekly_time":"gt_3h","confidence":"5"}'))->>'recorded_status' = 'skipped', 'an existing row answers already even without beta access');
reset role;
delete from public.beta_survey_responses where user_id = :E;

-- ---------------------------------------------------------------- authorization
set local role anon;
select pg_temp.fails($q$select public.beta_admin_check()$q$, '42501', 'anon cannot call the admin check');
select pg_temp.fails($q$select public.beta_admin_stats(now() - interval '30 days', now())$q$, '42501', 'anon cannot read stats');
reset role;
set local role authenticated;
select pg_temp.as_user(:B);
select pg_temp.ok(not public.beta_admin_check(), 'a beta user is not an admin');
select pg_temp.fails($q$select public.beta_admin_stats(now() - interval '30 days', now())$q$, '42501', 'a beta user cannot read stats');
select pg_temp.fails($q$select count(*) from private.beta_admins$q$, '42501', 'a user cannot read the allowlist');
select pg_temp.as_user(:ADMIN);
select pg_temp.ok(not public.beta_admin_check(), 'nobody is an admin before the allowlist has a row');
select pg_temp.fails($q$select public.beta_admin_stats(now() - interval '30 days', now())$q$, '42501', 'empty allowlist: stats refused');
reset role;
insert into private.beta_admins (user_id, note) values (:ADMIN, 'test admin');
set local role authenticated;
select pg_temp.as_user(:ADMIN);
select pg_temp.ok(public.beta_admin_check(), 'an allowlisted user is an admin');
select pg_temp.fails($q$select public.beta_admin_stats(now(), now() - interval '1 day')$q$, '22023', 'an empty range is refused');
select pg_temp.fails($q$select public.beta_admin_stats(now() - interval '2 years', now())$q$, '22023', 'a range over 400 days is refused');

-- ---------------------------------------------------------------- metrics (last 30 days)
create temp table s as select public.beta_admin_stats(now() - interval '30 days', now() + interval '1 minute') as j;
select pg_temp.ok((select (j->'users'->>'new_in_range')::int = 2 and (j->'users'->>'total')::int = 3 and (j->'users'->>'active')::int = 2 from s), 'users: 2 new in range, 3 total, 2 active');
select pg_temp.ok((select (j->'scheduled'->>'ticks')::int = 9 from s), 'scheduled: 9 ticks in range (the 60-day-old tick is excluded)');
select pg_temp.ok((select (j->'scheduled'->>'user_days')::int = 5 from s), 'scheduled: 5 user-days');
select pg_temp.ok((select (j->'scheduled'->>'generated')::int = 2 and (j->'scheduled'->>'empty')::int = 1 and (j->'scheduled'->>'failed')::int = 1 and (j->'scheduled'->>'unfinished')::int = 1 from s), 'scheduled: outcomes by last tick: 2 generated, 1 empty, 1 failed, 1 unfinished');
select pg_temp.ok((select (j->'scheduled'->>'failure_ticks')::int = 3 and (j->'scheduled'->>'retry_ticks')::int = 2 from s), 'scheduled: 3 failure ticks, 2 retry ticks (one recovered, one failed again)');
select pg_temp.ok((select (j->'scheduled'->>'summaries')::int = 6 from s), 'scheduled: 6 summaries from done ticks only');
select pg_temp.ok((select (j->'scheduled'->>'manual_ticks')::int = 1 and (j->'scheduled'->>'users_manual')::int = 1 and (j->'scheduled'->>'users_any')::int = 3 from s), 'scheduled: manual vs any users');
select pg_temp.ok((select (j->'browser'->>'runs')::int = 3 and (j->'browser'->>'users')::int = 2 from s), 'browser: showcase runs excluded, 3 runs by 2 users');
select pg_temp.ok((select (j->'browser'->>'generated')::int = 2 and (j->'browser'->>'empty')::int = 1 and (j->'browser'->>'with_errors')::int = 1 and (j->'browser'->>'append_runs')::int = 1 from s), 'browser: generated/empty/errors/append');
select pg_temp.ok((select (j->'browser'->>'summaries')::int = 3 from s), 'browser: summaries exclude append runs');
select pg_temp.ok((select (j->>'requesters')::int = 2 from s), 'requesters: B (browser) and C (manual + browser), not D (cron only) nor E (showcase)');
select pg_temp.ok((select (j->'opened'->>'events')::int = 3 and (j->'opened'->>'users')::int = 2 from s), 'opened: 3 events by 2 users');
select pg_temp.ok((select (j->'papers'->>'extractions')::int = 3 and (j->'papers'->>'unique_pmids')::int = 2 from s), 'papers: 3 extractions, 2 unique pmids in range');
select pg_temp.ok((select (j->'verifier'->>'available')::boolean = false from s), 'verifier reasons are reported as not available');
select pg_temp.ok((select (j->'survey'->>'completed')::int = 1 and (j->'survey'->>'skipped')::int = 1 from s), 'survey: 1 completed, 1 skipped');
select pg_temp.ok((select j->'survey'->'reason' = '{"stay_current": 1}'::jsonb and j->'survey'->'confidence' = '{"4": 1}'::jsonb and j->'survey'->'weekly_time' = '{"1_3h": 1}'::jsonb from s), 'survey: aggregate answers only');
select pg_temp.ok((select j->'survey' ? 'reason' and not (j::text like '%b0000000-0000-0000-0000-00000000000b%') from s), 'stats carry no user ids');
select pg_temp.ok((select (j->'earliest_retained'->>'digest_scheduled_run')::timestamptz < now() - interval '59 days' from s), 'earliest_retained reports the oldest retained record even outside the range');
select pg_temp.ok((select j->'earliest_retained'->>'digest_opened' is not null and j ? 'earliest_retained' and not (j ? 'first_seen') from s), 'the coverage key is named for what it is');

-- Malformed and oversized telemetry must not crash the RPC: the tick still counts, the value does not.
reset role;
insert into public.events (user_id, ts, type, payload) values
  (:D, (select t from d0) - interval '5 days' + interval '12 hours', 'digest_scheduled_run', '{"phase":"done","papers":"2147483648","read":0,"manual":false}'),
  (:D, (select t from d0) - interval '5 days' + interval '11 hours', 'digest_scheduled_run', '{"phase":"done","papers":99999999999999999999,"read":0,"manual":false}'),
  (:D, (select t from d0) - interval '5 days' + interval '10 hours', 'digest_scheduled_run', '{"phase":"done","papers":"abc","read":0,"manual":false}'),
  (:D, (select t from d0) - interval '5 days' + interval '9 hours', 'digest_scheduled_run', '{"phase":"done","papers":-5,"read":0,"manual":false}'),
  (:D, (select t from d0) - interval '5 days' + interval '8 hours', 'digest_scheduled_run', '{"phase":"done","papers":2.5,"read":0,"manual":false}'),
  (:D, (select t from d0) - interval '5 days' + interval '7 hours', 'digest_scheduled_run', '{"phase":"done","papers":{"n":1},"read":0,"manual":false}'),
  (:D, (select t from d0) - interval '5 days' + interval '6 hours', 'digest_scheduled_run', '{"phase":"done","papers":null,"manual":false}'),
  (:D, (select t from d0) - interval '5 days' + interval '5 hours', 'digest_scheduled_run', '{"phase":"done","papers":"007","manual":"yes"}'),
  (:D, now() - interval '12 hours', 'digest_run', '{"papers":"2147483648","errors":"9223372036854775808","append":false,"showcase":false}'),
  (:D, now() - interval '11 hours', 'digest_run', '{"papers":"1e3","errors":"-1","append":"no","showcase":null}'),
  (:D, now() - interval '10 hours', 'digest_run', '{"papers":3,"errors":"x"}'),
  (:D, now() - interval '9 hours',  'digest_run', '{}');
set local role authenticated;
select pg_temp.as_user(:ADMIN);
create temp table s3 as select public.beta_admin_stats(now() - interval '30 days', now() + interval '1 minute') as j;
select pg_temp.ok((select (j->'scheduled'->>'ticks')::int = 17 and (j->'scheduled'->>'summaries')::int = 13 from s3), 'oversized and malformed scheduled papers count as 0 (only "007" = 7 counts); ticks still count');
select pg_temp.ok((select (j->'scheduled'->>'manual_ticks')::int = 1 from s3), 'a non-boolean manual flag is not manual');
select pg_temp.ok((select (j->'browser'->>'runs')::int = 7 and (j->'browser'->>'summaries')::int = 6 and (j->'browser'->>'with_errors')::int = 1 and (j->'browser'->>'empty')::int = 4 from s3), 'oversized and malformed browser papers/errors count as 0; runs still count');
select pg_temp.ok((select (j->'scheduled'->>'user_days')::int = 6 and (j->'scheduled'->>'generated')::int = 3 from s3), 'the malformed day still resolves to its last phase');
select pg_temp.fails($q$select private.beta_payload_count('{"n":"1"}', 'n')$q$, '42501', 'the count helper is not callable by users');
reset role;
select pg_temp.ok(private.beta_payload_count('{"n":"999999999"}', 'n') = 999999999 and private.beta_payload_count('{"n":"1000000000"}', 'n') = 0 and private.beta_payload_count('{"n":"0"}', 'n') = 0 and private.beta_payload_count('{}', 'n') = 0, 'payload counts are bounded to nine digits');

-- A range before any retained record: zeros, with earliest_retained letting the client say "not available".
set local role authenticated;
select pg_temp.as_user(:ADMIN);
create temp table s2 as select public.beta_admin_stats(now() - interval '400 days', now() - interval '300 days') as j;
select pg_temp.ok((select (j->'scheduled'->>'ticks')::int = 0 and (j->'users'->>'new_in_range')::int = 0 and (j->'users'->>'total')::int = 3 from s2), 'old range: zero activity, totals unchanged');
select pg_temp.ok((select (j->'survey'->>'completed_all_time')::int = 1 and (j->'survey'->>'completed')::int = 0 from s2), 'completed-all-time does not depend on the range');
reset role;

rollback;
