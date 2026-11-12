-- Day-30 beta survey: the follow-up wave reserved in 20261015120000_beta_admin_dashboard_survey.sql.
-- PROPOSED; applied only to disposable local databases until an authorized release
-- (docs/BETA_ADMIN_DASHBOARD.md, "Day-30 survey").
--
-- Same table, same rules as the signup survey: one row per (user_id, wave), option codes
-- only (no free text), first write wins, answers linked to the account and never readable
-- back through the API. One difference: the day-30 wave cannot be skipped. Beta testers
-- are asked until they answer (the app may be told "not now", which records nothing), so
-- the server refuses a day-30 'skipped' status rather than let one call opt out for good.
--
-- The day-30 wave repeats the three habit questions from signup (read_frequency,
-- weekly_time, confidence) so an account that answered both can be compared with itself,
-- drops `reason`, and adds two columns:
--   if_gone      "How would you feel if you could no longer use Verastar?"
--                very_disappointed | somewhat_disappointed | not_disappointed | stopped_using
--   digest_fit   "How well do the papers in your digest match your work?" 1..5
--
-- It opens 30 days after the account's sponsored_accounts.created_at (enrollment). The
-- server refuses a day-30 answer before then, so the client and the email only decide
-- when to ASK; they cannot widen who may answer.
--
-- New functions:
--   beta_survey_day30_state()  the caller's own { eligible, opens_at, recorded } for the
--                              in-app prompt. No answers, no cohort.
--   beta_survey30_stats()      admins only: eligible and completed counts, answer distributions, and the paired
--                              signup -> day-30 change for accounts that completed both.
--                              Counts only, no user ids. Same test exclusions as the
--                              signup block of beta_release_stats.
--
-- Rollback:
--   drop function if exists public.beta_survey30_stats();
--   drop function if exists public.beta_survey_day30_state();
--   delete from public.beta_survey_responses where wave = 'day30';
--   alter table public.beta_survey_responses drop constraint beta_survey_responses_check;
--   alter table public.beta_survey_responses add constraint beta_survey_responses_check check (
--     (status = 'completed' and reason is not null and read_frequency is not null and weekly_time is not null and confidence is not null)
--     or (status = 'skipped' and reason is null and read_frequency is null and weekly_time is null and confidence is null));
--   alter table public.beta_survey_responses drop column if_gone, drop column digest_fit;
--   then re-apply beta_survey_submit from 20261015120000_beta_admin_dashboard_survey.sql.
begin;

alter table public.beta_survey_responses
  add column if not exists if_gone text
    check (if_gone in ('very_disappointed', 'somewhat_disappointed', 'not_disappointed', 'stopped_using')),
  add column if not exists digest_fit smallint check (digest_fit between 1 and 5);

-- Which answers a row must carry now depends on the wave.
alter table public.beta_survey_responses drop constraint if exists beta_survey_responses_check;
alter table public.beta_survey_responses add constraint beta_survey_responses_check check (
  (status = 'skipped'
     and reason is null and read_frequency is null and weekly_time is null and confidence is null
     and if_gone is null and digest_fit is null)
  or (status = 'completed' and wave = 'signup'
     and reason is not null and read_frequency is not null and weekly_time is not null and confidence is not null
     and if_gone is null and digest_fit is null)
  or (status = 'completed' and wave = 'day30'
     and reason is null and read_frequency is not null and weekly_time is not null and confidence is not null
     and if_gone is not null and digest_fit is not null)
);
-- The column grant to authenticated is unchanged: status columns only, so the new answer
-- columns are not readable by participants either. service_role has table-level select.

-- --- Submit: signup as before, day30 now accepted ------------------------------------------
create or replace function public.beta_survey_submit(p_wave text, p_version text, p_status text, p_answers jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_existing text;
  v_cohort text;
  v_enrolled timestamptz;
  v_reason text; v_freq text; v_time text; v_conf integer; v_gone text; v_fit integer;
begin
  if v_uid is null then raise exception using errcode = '42501', message = 'sign in first'; end if;
  if p_wave is null or p_wave not in ('signup', 'day30') then raise exception using errcode = '22023', message = 'unknown survey wave'; end if;
  if p_version is null or length(p_version) not between 1 and 32 then raise exception using errcode = '22023', message = 'survey version required'; end if;
  if p_status is null or p_status not in ('completed', 'skipped') then raise exception using errcode = '22023', message = 'status must be completed or skipped'; end if;
  if p_wave = 'day30' and p_status = 'skipped' then raise exception using errcode = '22023', message = 'the day-30 survey cannot be skipped'; end if;

  select status into v_existing from public.beta_survey_responses where user_id = v_uid and wave = p_wave;
  if found then return jsonb_build_object('status', 'already', 'recorded_status', v_existing); end if;

  -- A first response needs beta eligibility: a sponsored_accounts row, i.e. a redeemed code.
  select cohort, created_at into v_cohort, v_enrolled from public.sponsored_accounts where user_id = v_uid;
  if not found then raise exception using errcode = '42501', message = 'beta access required'; end if;
  if p_wave = 'day30' and v_enrolled > now() - interval '30 days' then
    raise exception using errcode = '22023', message = 'the day-30 survey opens 30 days after enrollment';
  end if;

  if p_status = 'completed' then
    v_freq := p_answers->>'read_frequency';
    v_time := p_answers->>'weekly_time';
    if coalesce(p_answers->>'confidence', '') !~ '^[1-5]$' then raise exception using errcode = '22023', message = 'confidence must be 1..5'; end if;
    v_conf := (p_answers->>'confidence')::integer;
    if v_freq is null or v_freq not in ('lt_monthly', 'monthly', 'weekly', 'several_weekly', 'daily')
       or v_time is null or v_time not in ('lt_30m', '30_60m', '1_3h', 'gt_3h') then
      raise exception using errcode = '22023', message = 'an answer is missing or not one of the offered options';
    end if;
    if p_wave = 'signup' then
      v_reason := p_answers->>'reason';
      if v_reason is null or v_reason not in ('stay_current', 'find_papers', 'support_project', 'explore_topic', 'other') then
        raise exception using errcode = '22023', message = 'an answer is missing or not one of the offered options';
      end if;
    else
      v_gone := p_answers->>'if_gone';
      if coalesce(p_answers->>'digest_fit', '') !~ '^[1-5]$' then raise exception using errcode = '22023', message = 'digest_fit must be 1..5'; end if;
      v_fit := (p_answers->>'digest_fit')::integer;
      if v_gone is null or v_gone not in ('very_disappointed', 'somewhat_disappointed', 'not_disappointed', 'stopped_using') then
        raise exception using errcode = '22023', message = 'an answer is missing or not one of the offered options';
      end if;
    end if;
  end if;

  insert into public.beta_survey_responses (user_id, wave, survey_version, status, cohort, reason, read_frequency, weekly_time, confidence, if_gone, digest_fit)
    values (v_uid, p_wave, p_version, p_status, v_cohort, v_reason, v_freq, v_time, v_conf, v_gone, v_fit)
    on conflict (user_id, wave) do nothing;
  if not found then
    select status into v_existing from public.beta_survey_responses where user_id = v_uid and wave = p_wave;
    return jsonb_build_object('status', 'already', 'recorded_status', v_existing);
  end if;
  return jsonb_build_object('status', 'recorded', 'recorded_status', p_status);
end;
$$;

-- --- The caller's own day-30 state, for the in-app prompt ---------------------------------
-- eligible: a beta account at least 30 days past enrollment. recorded: 'completed' or
-- null ('skipped' only for a row written outside beta_survey_submit). opens_at: when the wave opens (null without beta access).
create or replace function public.beta_survey_day30_state()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_enrolled timestamptz;
  v_recorded text;
begin
  if v_uid is null then raise exception using errcode = '42501', message = 'sign in first'; end if;
  select created_at into v_enrolled from public.sponsored_accounts where user_id = v_uid;
  if not found then return jsonb_build_object('eligible', false, 'opens_at', null, 'recorded', null); end if;
  select status into v_recorded from public.beta_survey_responses where user_id = v_uid and wave = 'day30';
  return jsonb_build_object(
    'eligible', v_enrolled <= now() - interval '30 days',
    'opens_at', v_enrolled + interval '30 days',
    'recorded', v_recorded);
end;
$$;
revoke all on function public.beta_survey_day30_state() from public, anon;
grant execute on function public.beta_survey_day30_state() to authenticated;

-- --- Admin: day-30 answers and the paired change ------------------------------------------
create or replace function public.beta_survey30_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null or not exists (select 1 from private.beta_admins where user_id = v_uid) then
    raise exception using errcode = '42501', message = 'beta admin only';
  end if;

  with people as (
    select s.* from public.sponsored_accounts s
     where not private.beta_is_test(s.user_id, s.created_at, s.cohort)
  ), r as (
    select r.* from public.beta_survey_responses r join people p on p.user_id = r.user_id
     where not private.beta_is_test(r.user_id, r.responded_at, r.cohort)
  ), d30 as (
    select * from r where wave = 'day30' and status = 'completed'
  ), pairs as (
    select d.user_id,
           sign(d.confidence - s.confidence)::int as conf_change,
           sign(array_position(array['lt_30m','30_60m','1_3h','gt_3h'], d.weekly_time)
              - array_position(array['lt_30m','30_60m','1_3h','gt_3h'], s.weekly_time))::int as time_change
      from d30 d join r s on s.user_id = d.user_id and s.wave = 'signup' and s.status = 'completed'
  )
  select jsonb_build_object(
    'eligible_now', (select count(*) from people where created_at <= now() - interval '30 days'),
    'completed', (select count(*) from d30),
    'read_frequency', (select coalesce(jsonb_object_agg(k, n), '{}') from (select read_frequency k, count(*) n from d30 group by 1) x),
    'weekly_time', (select coalesce(jsonb_object_agg(k, n), '{}') from (select weekly_time k, count(*) n from d30 group by 1) x),
    'confidence', (select coalesce(jsonb_object_agg(k, n), '{}') from (select confidence::text k, count(*) n from d30 group by 1) x),
    'if_gone', (select coalesce(jsonb_object_agg(k, n), '{}') from (select if_gone k, count(*) n from d30 group by 1) x),
    'digest_fit', (select coalesce(jsonb_object_agg(k, n), '{}') from (select digest_fit::text k, count(*) n from d30 group by 1) x),
    'paired', (select jsonb_build_object(
        'n', count(*),
        'confidence', jsonb_build_object('up', count(*) filter (where conf_change > 0), 'same', count(*) filter (where conf_change = 0), 'down', count(*) filter (where conf_change < 0)),
        'weekly_time', jsonb_build_object('more', count(*) filter (where time_change > 0), 'same', count(*) filter (where time_change = 0), 'less', count(*) filter (where time_change < 0)))
      from pairs))
  into v_out;
  return v_out;
end;
$$;
revoke all on function public.beta_survey30_stats() from public, anon;
grant execute on function public.beta_survey30_stats() to authenticated;

commit;
