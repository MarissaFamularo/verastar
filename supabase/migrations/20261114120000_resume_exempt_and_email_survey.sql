-- Two changes for readers who use Verastar from the email and never open the site.
-- PROPOSED; applied only to disposable local databases until an authorized release
-- (docs/DIGEST_DELIVERY.md § Release: email readers).
--
-- 1. A "No, don't pause me" press is a lasting answer.
--    Between 2026-10-24 and 2026-11-14, 16 of the 34 beta testers the scheduler paused pressed
--    the pause email's resume button: they were reading the email without clicking a link,
--    so the scheduler could not tell. digest-resume now stamps pause_exempt_at, and
--    digest-run never auto-pauses an account that carries it (the streak still counts, capped
--    one below the threshold, so digest_inactivity_update's rules are unchanged). The
--    reader can still unsubscribe, switch automatic runs off, or be stopped by spending caps.
--
-- 2. The day-30 survey can be answered from the email without signing in.
--    The digest email's invitation now links to the digest-survey function with a signed
--    token (same secret as the unsubscribe and resume links, own "digest-survey:" prefix).
--    beta_survey_submit_signed lets that function record the answer for the token's account
--    and is callable by service_role only. It applies the same rules as beta_survey_submit
--    (beta access, day 30 opened, option codes only, first write wins, no skip) by sharing
--    one private body with it; the app's signed-in path is unchanged.
--
-- Rollback:
--   drop function if exists public.beta_survey_submit_signed(uuid, text, jsonb);
--   re-apply beta_survey_submit from 20261111120000_beta_survey_day30.sql;
--   drop function if exists private.beta_survey_record(uuid, text, text, text, jsonb);
--   alter table public.digest_schedules drop column if exists pause_exempt_at;
begin;

-- --- 1. Lasting resume ------------------------------------------------------------------
alter table public.digest_schedules add column if not exists pause_exempt_at timestamptz;
comment on column public.digest_schedules.pause_exempt_at is
  'When the reader pressed the pause email''s "No, don''t pause me" button. Service-owned; while set, the scheduler never auto-pauses the account.';
-- Not granted to authenticated: the Settings page neither reads nor writes it.
-- Readers who already pressed the button keep that answer: backfill from the events log.
update public.digest_schedules d set pause_exempt_at = e.at
  from (select user_id, max(ts) as at from public.events where type = 'digest_resume_clicked' group by user_id) e
 where e.user_id = d.user_id and d.pause_exempt_at is null;
-- Apply this migration BEFORE deploying digest-run: the scheduler selects the new column.

-- --- 2. One survey body, two callers -------------------------------------------------------
-- The body of beta_survey_submit from 20261111120000_beta_survey_day30.sql, unchanged except
-- that the account is a parameter instead of auth.uid().
create or replace function private.beta_survey_record(p_uid uuid, p_wave text, p_version text, p_status text, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing text;
  v_cohort text;
  v_enrolled timestamptz;
  v_reason text; v_freq text; v_time text; v_conf integer; v_gone text; v_fit integer;
begin
  if p_uid is null then raise exception using errcode = '42501', message = 'sign in first'; end if;
  if p_wave is null or p_wave not in ('signup', 'day30') then raise exception using errcode = '22023', message = 'unknown survey wave'; end if;
  if p_version is null or length(p_version) not between 1 and 32 then raise exception using errcode = '22023', message = 'survey version required'; end if;
  if p_status is null or p_status not in ('completed', 'skipped') then raise exception using errcode = '22023', message = 'status must be completed or skipped'; end if;
  if p_wave = 'day30' and p_status = 'skipped' then raise exception using errcode = '22023', message = 'the day-30 survey cannot be skipped'; end if;

  select status into v_existing from public.beta_survey_responses where user_id = p_uid and wave = p_wave;
  if found then return jsonb_build_object('status', 'already', 'recorded_status', v_existing); end if;

  select cohort, created_at into v_cohort, v_enrolled from public.sponsored_accounts where user_id = p_uid;
  if not found then raise exception using errcode = '42501', message = 'beta access required'; end if;
  if p_wave = 'day30' and v_enrolled > now() - interval '30 days' then
    raise exception using errcode = '22023', message = 'the day-30 survey opens 30 days after enrollment';
  end if;

  if p_status = 'completed' then
    p_answers := coalesce(p_answers, '{}'::jsonb);
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
    values (p_uid, p_wave, p_version, p_status, v_cohort, v_reason, v_freq, v_time, v_conf, v_gone, v_fit)
    on conflict (user_id, wave) do nothing;
  if not found then
    select status into v_existing from public.beta_survey_responses where user_id = p_uid and wave = p_wave;
    return jsonb_build_object('status', 'already', 'recorded_status', v_existing);
  end if;
  return jsonb_build_object('status', 'recorded', 'recorded_status', p_status);
end;
$$;
revoke all on function private.beta_survey_record(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- The app's path: same signature and behaviour as before, now a thin wrapper.
create or replace function public.beta_survey_submit(p_wave text, p_version text, p_status text, p_answers jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return private.beta_survey_record(auth.uid(), p_wave, p_version, p_status, p_answers);
end;
$$;

-- The email's path: digest-survey verifies the signed link, then records for that account.
-- Day 30 only, answers only (no skip); service_role only.
create or replace function public.beta_survey_submit_signed(p_user_id uuid, p_version text, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  return private.beta_survey_record(p_user_id, 'day30', p_version, 'completed', p_answers);
end;
$$;
revoke all on function public.beta_survey_submit_signed(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.beta_survey_submit_signed(uuid, text, jsonb) to service_role;

commit;
