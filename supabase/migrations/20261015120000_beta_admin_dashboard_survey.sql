-- Beta admin dashboard and signup survey. PROPOSED; applied only to disposable local
-- databases until an authorized release (docs/BETA_ADMIN_DASHBOARD.md).
--
-- Additive only: one allowlist table in schema private, one survey table, and three
-- SECURITY DEFINER functions. Nothing here touches the digest pipeline, the scheduler, the
-- spending functions, or any existing table, grant, or policy.
--
-- Authorization. The project has no admin role of any kind. private.beta_admins is the
-- allowlist: no client grants, filled by an operator with SQL
--   insert into private.beta_admins (user_id, note) values ('<auth.users.id>', 'owner');
-- Until a row exists nobody is an admin and beta_admin_stats refuses every caller (42501).
-- The client shows the dashboard entry only when beta_admin_check() answers true, and the
-- data itself is served only by beta_admin_stats, which checks the allowlist again, so a
-- hidden URL or a client-side flag exposes nothing.
--
-- Survey. One row per (user_id, wave). wave = 'signup' is the only wave accepted today;
-- 'day30' is reserved so a later follow-up can reuse the table and the option codes. Rows
-- are written only through beta_survey_submit (validated option codes, cohort label copied
-- from sponsored_accounts, first write wins). Users may read their own row; the dashboard
-- sees counts only. No free text, no invite code, no email is stored here.
--
-- Metrics read existing records only: sponsored_accounts, events (digest_scheduled_run,
-- digest_run, digest_opened), evidence_cache_trusted, and the survey table. The events
-- table is editable by its own user under the existing RLS, so counts from it are
-- "as recorded", not tamper-proof; the dashboard says so.
--
-- Rollback:
--   drop function if exists public.beta_admin_stats(timestamptz, timestamptz);
--   drop function if exists public.beta_admin_check();
--   drop function if exists public.beta_survey_submit(text, text, text, jsonb);
--   drop table if exists public.beta_survey_responses;
--   drop table if exists private.beta_admins;
begin;

create schema if not exists private;

-- --- Admin allowlist ---------------------------------------------------------------------
create table if not exists private.beta_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);
alter table private.beta_admins enable row level security;
revoke all on private.beta_admins from public, anon, authenticated;
grant select on private.beta_admins to service_role;

-- --- Survey responses --------------------------------------------------------------------
create table if not exists public.beta_survey_responses (
  user_id        uuid not null references auth.users(id) on delete cascade,
  wave           text not null check (wave in ('signup', 'day30')),
  survey_version text not null check (length(survey_version) between 1 and 32),
  status         text not null check (status in ('completed', 'skipped')),
  cohort         text,                                  -- sponsored_accounts.cohort at submit time
  reason         text check (reason in ('stay_current', 'find_papers', 'support_project', 'explore_topic', 'other')),
  read_frequency text check (read_frequency in ('lt_monthly', 'monthly', 'weekly', 'several_weekly', 'daily')),
  weekly_time    text check (weekly_time in ('lt_30m', '30_60m', '1_3h', 'gt_3h')),
  confidence     smallint check (confidence between 1 and 5),
  responded_at   timestamptz not null default now(),
  primary key (user_id, wave),
  check (
    (status = 'completed' and reason is not null and read_frequency is not null and weekly_time is not null and confidence is not null)
    or (status = 'skipped' and reason is null and read_frequency is null and weekly_time is null and confidence is null)
  )
);
create index if not exists beta_survey_responses_wave_at_idx on public.beta_survey_responses (wave, responded_at);
alter table public.beta_survey_responses enable row level security;
revoke all on public.beta_survey_responses from public, anon, authenticated;
grant select on public.beta_survey_responses to authenticated;
grant select, insert on public.beta_survey_responses to service_role;
drop policy if exists "beta_survey_select_own" on public.beta_survey_responses;
create policy "beta_survey_select_own" on public.beta_survey_responses
  for select to authenticated using (user_id = (select auth.uid()));
-- No insert/update/delete policy for authenticated: writes go through beta_survey_submit.

-- --- Survey submit (idempotent, validated) -----------------------------------------------
create or replace function public.beta_survey_submit(p_wave text, p_version text, p_status text, p_answers jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_existing text;
  v_cohort text;
  v_reason text; v_freq text; v_time text; v_conf integer;
begin
  if v_uid is null then raise exception using errcode = '42501', message = 'sign in first'; end if;
  if p_wave is distinct from 'signup' then raise exception using errcode = '22023', message = 'unknown survey wave'; end if;
  if p_version is null or length(p_version) not between 1 and 32 then raise exception using errcode = '22023', message = 'survey version required'; end if;
  if p_status is null or p_status not in ('completed', 'skipped') then raise exception using errcode = '22023', message = 'status must be completed or skipped'; end if;

  select status into v_existing from public.beta_survey_responses where user_id = v_uid and wave = p_wave;
  if found then return jsonb_build_object('status', 'already', 'recorded_status', v_existing); end if;

  if p_status = 'completed' then
    v_reason := p_answers->>'reason';
    v_freq := p_answers->>'read_frequency';
    v_time := p_answers->>'weekly_time';
    if p_answers->>'confidence' !~ '^[1-5]$' then raise exception using errcode = '22023', message = 'confidence must be 1..5'; end if;
    v_conf := (p_answers->>'confidence')::integer;
    if v_reason is null or v_reason not in ('stay_current', 'find_papers', 'support_project', 'explore_topic', 'other')
       or v_freq is null or v_freq not in ('lt_monthly', 'monthly', 'weekly', 'several_weekly', 'daily')
       or v_time is null or v_time not in ('lt_30m', '30_60m', '1_3h', 'gt_3h') then
      raise exception using errcode = '22023', message = 'an answer is missing or not one of the offered options';
    end if;
  end if;

  select cohort into v_cohort from public.sponsored_accounts where user_id = v_uid;

  insert into public.beta_survey_responses (user_id, wave, survey_version, status, cohort, reason, read_frequency, weekly_time, confidence)
    values (v_uid, p_wave, p_version, p_status, v_cohort, v_reason, v_freq, v_time, v_conf)
    on conflict (user_id, wave) do nothing;
  if not found then
    select status into v_existing from public.beta_survey_responses where user_id = v_uid and wave = p_wave;
    return jsonb_build_object('status', 'already', 'recorded_status', v_existing);
  end if;
  return jsonb_build_object('status', 'recorded', 'recorded_status', p_status);
end;
$$;

-- --- Admin check (boolean only) ----------------------------------------------------------
create or replace function public.beta_admin_check()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.beta_admins where user_id = auth.uid())
$$;

-- --- Admin aggregates for [p_from, p_to) -------------------------------------------------
-- Every number is a count over records that already exist; see docs/BETA_ADMIN_DASHBOARD.md
-- for the plain-language definition of each key. `first_seen` carries the earliest record
-- of each source so the client can show "Not available" for a range that predates it.
create or replace function public.beta_admin_stats(p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_users jsonb; v_sched jsonb; v_browser jsonb; v_requesters bigint; v_opened jsonb;
  v_papers jsonb; v_survey jsonb; v_first jsonb;
begin
  if v_uid is null or not exists (select 1 from private.beta_admins where user_id = v_uid) then
    raise exception using errcode = '42501', message = 'beta admin only';
  end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '400 days' then
    raise exception using errcode = '22023', message = 'range must be non-empty and at most 400 days';
  end if;

  select jsonb_build_object(
    'new_in_range', count(*) filter (where created_at >= p_from and created_at < p_to),
    'total', count(*),
    'active', count(*) filter (where active and (ends_at is null or ends_at > now())))
  into v_users from public.sponsored_accounts;

  with ticks as (
    select id, user_id, ts, (ts at time zone 'UTC')::date as day,
           payload->>'phase' as phase,
           case when payload->>'papers' ~ '^[0-9]+$' then (payload->>'papers')::integer else 0 end as papers,
           coalesce(payload->>'manual', '') = 'true' as manual
      from public.events
     where type = 'digest_scheduled_run' and ts >= p_from and ts < p_to
  ), ordered as (
    select t.*,
           coalesce(bool_or(phase in ('error', 'held', 'capped')) over (partition by user_id, day order by ts, id rows between unbounded preceding and 1 preceding), false) as after_failure
      from ticks t
  ), last_tick as (
    select distinct on (user_id, day) user_id, day, phase from ticks order by user_id, day, ts desc, id desc
  )
  select jsonb_build_object(
    'ticks', (select count(*) from ticks),
    'manual_ticks', (select count(*) from ticks where manual),
    'users_any', (select count(distinct user_id) from ticks),
    'users_manual', (select count(distinct user_id) from ticks where manual),
    'user_days', (select count(*) from last_tick),
    'generated', (select count(*) from last_tick where phase = 'done'),
    'empty', (select count(*) from last_tick where phase = 'empty'),
    'failed', (select count(*) from last_tick where phase in ('error', 'held', 'capped')),
    'unfinished', (select count(*) from last_tick where phase is null or phase not in ('done', 'empty', 'error', 'held', 'capped')),
    'failure_ticks', (select count(*) from ticks where phase in ('error', 'held', 'capped')),
    'retry_ticks', (select count(*) from ordered where after_failure),
    'summaries', (select coalesce(sum(papers), 0) from ticks where phase = 'done'))
  into v_sched;

  with runs as (
    select user_id,
           case when payload->>'papers' ~ '^[0-9]+$' then (payload->>'papers')::integer else 0 end as papers,
           case when payload->>'errors' ~ '^[0-9]+$' then (payload->>'errors')::integer else 0 end as errors,
           coalesce(payload->>'append', '') = 'true' as append
      from public.events
     where type = 'digest_run' and ts >= p_from and ts < p_to
       and coalesce(payload->>'showcase', '') <> 'true'
  )
  select jsonb_build_object(
    'runs', count(*),
    'users', count(distinct user_id),
    'generated', count(*) filter (where papers > 0),
    'empty', count(*) filter (where papers = 0 and errors = 0),
    'with_errors', count(*) filter (where errors > 0),
    'append_runs', count(*) filter (where append),
    'summaries', coalesce(sum(papers) filter (where not append), 0))
  into v_browser from runs;

  select count(distinct user_id) into v_requesters from (
    select user_id from public.events
     where type = 'digest_scheduled_run' and ts >= p_from and ts < p_to and coalesce(payload->>'manual', '') = 'true'
    union
    select user_id from public.events
     where type = 'digest_run' and ts >= p_from and ts < p_to and coalesce(payload->>'showcase', '') <> 'true'
  ) u;

  select jsonb_build_object('events', count(*), 'users', count(distinct user_id))
  into v_opened from public.events where type = 'digest_opened' and ts >= p_from and ts < p_to;

  select jsonb_build_object('extractions', count(*), 'unique_pmids', count(distinct pmid))
  into v_papers from public.evidence_cache_trusted where created_at >= p_from and created_at < p_to;

  with r as (
    select * from public.beta_survey_responses where wave = 'signup' and responded_at >= p_from and responded_at < p_to
  )
  select jsonb_build_object(
    'completed', (select count(*) from r where status = 'completed'),
    'skipped', (select count(*) from r where status = 'skipped'),
    'completed_all_time', (select count(*) from public.beta_survey_responses where wave = 'signup' and status = 'completed'),
    'reason', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select reason k, count(*) n from r where status = 'completed' group by 1) x),
    'read_frequency', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select read_frequency k, count(*) n from r where status = 'completed' group by 1) x),
    'weekly_time', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select weekly_time k, count(*) n from r where status = 'completed' group by 1) x),
    'confidence', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select confidence::text k, count(*) n from r where status = 'completed' group by 1) x))
  into v_survey;

  select jsonb_build_object(
    'sponsored_accounts', (select min(created_at) from public.sponsored_accounts),
    'digest_scheduled_run', (select min(ts) from public.events where type = 'digest_scheduled_run'),
    'digest_run', (select min(ts) from public.events where type = 'digest_run'),
    'digest_opened', (select min(ts) from public.events where type = 'digest_opened'),
    'evidence_cache_trusted', (select min(created_at) from public.evidence_cache_trusted),
    'beta_survey_responses', (select min(responded_at) from public.beta_survey_responses))
  into v_first;

  return jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'generated_at', now(),
    'users', v_users,
    'scheduled', v_sched,
    'browser', v_browser,
    'requesters', v_requesters,
    'opened', v_opened,
    'papers', v_papers,
    'verifier', jsonb_build_object('available', false),
    'survey', v_survey,
    'first_seen', v_first);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.beta_survey_submit(text,text,text,jsonb)',
    'public.beta_admin_check()',
    'public.beta_admin_stats(timestamptz,timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

commit;
