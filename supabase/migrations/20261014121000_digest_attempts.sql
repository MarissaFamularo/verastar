-- Scheduler fairness: attempt stamps and a per-day attempt cap. PROPOSED; applied only to
-- disposable local databases until the authorized release.
--
-- digest-run picked the first enabled schedule PostgREST happened to return, and an account
-- whose run errored every tick was picked again every tick: one always-failing account could
-- starve the cohort (beta audit 2026-10-14, docs/BETA_TEST_PLAN.md § H). Two additive pieces:
--
--   last_attempt_at   stamped by digest_claim_finish on EVERY finish, done or not, error or
--                     not. The handler orders runnable schedules by
--                     coalesce(last_attempt_at, 'epoch'), so the account tried most recently
--                     goes to the back of the queue and a never-tried account goes first.
--   attempts_today    how many finishes this local day (attempt_day, the account's timezone);
--   attempt_day       reset on the first finish of a new day. The handler skips a cron tick
--                     for an account at ATTEMPTS_PER_DAY (handler.js) until its next day.
--                     A manual "run mine now" is not capped: it targets one account and is
--                     already bounded by the claim and the spending checks.
--
-- Only a finished RUN counts. digest_claim_release clears a claim the handler took but did
-- not use (its post-claim re-check said another tick already finished, or storage was
-- unavailable) and stamps nothing, so a quick no-op cannot spend the day's attempts. The
-- handler used digest_claim_finish(..., false, null) for that before; both still work.
--
-- A timezone the schedule stored is a client-editable text column. digest_local_day falls
-- back to the UTC date for a name PostgreSQL rejects instead of failing the finish (an
-- unfinished finish would leave the claim to go stale). All SECURITY INVOKER, service-role
-- only. Release order: after 20261010130000_scheduler_hold.sql. Rollback: re-run the spending
-- migration's digest_claim_finish and drop digest_claim_release and digest_local_day; the
-- columns may stay.
begin;

alter table public.digest_schedules
  add column if not exists last_attempt_at timestamptz,
  add column if not exists attempt_day     date,
  add column if not exists attempts_today  integer not null default 0;

create or replace function public.digest_local_day(p_timezone text, p_at timestamptz default now())
returns date language plpgsql stable security invoker set search_path = '' as $$
begin
  return (p_at at time zone coalesce(nullif(p_timezone, ''), 'UTC'))::date;
exception when others then
  return (p_at at time zone 'UTC')::date;
end;
$$;

create or replace function public.digest_claim_finish(p_user_id uuid, p_token uuid, p_finished boolean, p_result text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.digest_schedules
     set claimed_at = null, claim_token = null,
         last_run_at = case when p_finished then now() else last_run_at end,
         last_result = coalesce(left(p_result, 200), last_result), updated_at = now(),
         last_attempt_at = now(),                                                                   -- attempt
         attempts_today = case when attempt_day = public.digest_local_day(timezone) then attempts_today + 1 else 1 end, -- attempt
         attempt_day = public.digest_local_day(timezone)                                             -- attempt
   where user_id = p_user_id and claim_token = p_token;
  return found;
end;
$$;

create or replace function public.digest_claim_release(p_user_id uuid, p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.digest_schedules set claimed_at = null, claim_token = null, updated_at = now()
   where user_id = p_user_id and claim_token = p_token;
  return found;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.digest_local_day(text,timestamptz)',
    'public.digest_claim_finish(uuid,uuid,boolean,text)',
    'public.digest_claim_release(uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
