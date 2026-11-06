-- Apply before deploying digest-run. No existing counters, pauses or settings are reset.
begin;
alter table public.digest_schedules add column inactivity_counted_at timestamptz;
comment on column public.digest_schedules.inactivity_counted_at is
  'Stable ranAt identity of the last digest accounted for inactivity; service-owned and monotonic.';

-- Compare only inactivity-relevant record fields, not scientific content. A browser
-- open, resume click, Settings save, newer digest or lost claim invalidates a stale write.
create function public.digest_inactivity_update(
 p_user_id uuid, p_token uuid, p_expected_streak integer,
 p_expected_counted_at timestamptz, p_expected_paused_at timestamptz,
 p_expected_engaged_at timestamptz, p_expected_record jsonb,
 p_streak integer, p_counted_at timestamptz, p_pause boolean, p_clear_pause boolean
) returns boolean language plpgsql security invoker set search_path='' as $$
declare current_record jsonb;
begin
 if p_streak is null or p_streak<0 or p_streak>7 or p_pause is null or p_clear_pause is null
    or (p_pause and p_clear_pause) or (p_pause and p_streak<>7)
    or (p_counted_at is not null and (not isfinite(p_counted_at) or p_counted_at>now())) then
   raise exception 'invalid inactivity transition';
 end if;
 if p_streak>p_expected_streak and (p_streak<>p_expected_streak+1 or p_counted_at is null or (p_expected_counted_at is not null and p_counted_at<=p_expected_counted_at)) then
   raise exception 'a digest may increment inactivity only once';
 end if;
 if p_expected_counted_at is not null and (p_counted_at is null or p_counted_at<p_expected_counted_at) then
   raise exception 'inactivity checkpoint cannot move backwards';
 end if;
 -- Row lock order is schedule then digest, matching the scheduler's fenced writes.
 perform 1 from public.digest_schedules where user_id=p_user_id and claim_token=p_token for update;
 if not found then return false; end if;
 select value into current_record from public.kv where user_id=p_user_id and collection='digests' and key='daily:latest' for share;
 if jsonb_build_object('kind',current_record->'kind','runBy',current_record->'runBy',
     'ranAt',current_record->'ranAt','savedAt',case when coalesce(current_record->>'ranAt','')<>'' then null else current_record->'savedAt' end,
     'phase',current_record->'server'->'phase','finishedAt',current_record->'server'->'finishedAt',
     'openedAt',current_record->'openedAt','papers',case when jsonb_typeof(current_record->'results')='array' then jsonb_array_length(current_record->'results') else 0 end
   ) is distinct from p_expected_record then return false; end if;
 update public.digest_schedules set unopened_streak=p_streak,inactivity_counted_at=p_counted_at,
   paused_at=case when p_pause then now() when p_clear_pause then null else paused_at end,
   claim_token=case when p_pause then null else claim_token end,
   claimed_at=case when p_pause then null else now() end, updated_at=now()
 where user_id=p_user_id and enabled and claim_token=p_token
   and unopened_streak=p_expected_streak
   and inactivity_counted_at is not distinct from p_expected_counted_at
   and paused_at is not distinct from p_expected_paused_at
   and engaged_at is not distinct from p_expected_engaged_at;
 return found;
end $$;
revoke all on function public.digest_inactivity_update(uuid,uuid,integer,timestamptz,timestamptz,timestamptz,jsonb,integer,timestamptz,boolean,boolean) from public,anon,authenticated;
grant execute on function public.digest_inactivity_update(uuid,uuid,integer,timestamptz,timestamptz,timestamptz,jsonb,integer,timestamptz,boolean,boolean) to service_role;
commit;
