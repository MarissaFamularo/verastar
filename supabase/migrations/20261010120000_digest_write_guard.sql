-- Digest write guard: browser and scheduler writes to one account's daily digest.
--
-- The scheduled digest and the app both write the single record kv(user, 'digests',
-- 'daily:latest'). The scheduler's writes are fenced by its claim token
-- (scheduler_kv_write), which stops an OLD scheduler worker. Nothing stopped the browser:
-- it replaces the whole record from the copy on screen, after a separate read. A scheduler
-- write landing between that read and that write was lost, and a finished digest could be
-- replaced by an older or partial one (reproduced 2026-10-10 on a local stack).
--
-- This migration makes those browser writes conditional INSIDE the database, under the row
-- lock of the write itself, so the check and the write cannot be separated. It is additive:
-- one trigger function and two triggers scoped to that one record. No table, column,
-- policy, grant or existing function changes; every other kv record (library papers, the
-- profile, the seen ledger, other digests keys) never reaches the function.
--
-- Rules. "Browser" means a request whose JWT role is not service_role (the app, signed in).
-- The scheduler (service role, through scheduler_kv_write) and direct SQL sessions are not
-- restricted; rule 5 applies to every writer.
--   1. scheduler_in_flight  While the stored digest is a scheduler run that has not finished
--                           (runBy 'scheduler', server.phase set and not 'done'), a browser
--                           write may change only openedAt. Anything else is refused.
--   2. newer_digest         A browser write may not replace a digest with one from an older
--                           scan (ranAt earlier than the stored ranAt).
--   3. phase_regression     A browser write may not turn a finished scheduler digest back
--                           into an unfinished copy of the same scan.
--   4. scheduler_running    A browser delete is refused while a scheduler tick holds a live
--                           claim on an unfinished scheduler digest. With no live claim the
--                           owner's delete is allowed, so a stalled run can always be cleared.
--   5. opened stamp kept    Within one scan (same ranAt) openedAt is never unset: a write
--                           that omits it keeps the stored value. This is what lets the
--                           scheduler, which writes its in-memory copy, keep a stamp the
--                           reader set while the run was in progress.
-- A refusal raises SQLSTATE P0001 with message 'digest_stale:<rule>'. Nothing is written.
-- The app reports the save as not made (src/lib/digestStore.js); an older deployed bundle
-- gets the same refusal as a failed save, which it already tolerates.
--
-- Release order: after 20261009120000_beta_spending_safeguards.sql (rule 4 reads
-- digest_schedules.claim_token, which that migration adds). Rollback:
--   drop trigger if exists kv_digest_guard_update on public.kv;
--   drop trigger if exists kv_digest_guard_delete on public.kv;
--   drop function if exists public.digest_write_guard();

create or replace function public.digest_write_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  -- The claim lease, in seconds: CLAIM_STALE_SECONDS in supabase/functions/_shared/timeouts.js.
  c_claim_lease constant integer := 240;
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), ''),
    '');
  v_browser boolean := v_role not in ('service_role', '');
  o jsonb := old.value;
  n jsonb;
  v_in_flight boolean;
  v_same_scan boolean;
  v_old_ran timestamptz;
  v_new_ran timestamptz;
begin
  if coalesce(o ->> 'kind', '') <> 'daily' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_in_flight := o ->> 'runBy' = 'scheduler'
    and coalesce(o -> 'server' ->> 'phase', '') not in ('', 'done');

  if tg_op = 'DELETE' then
    if v_browser and v_in_flight and exists (
      select 1 from public.digest_schedules s
       where s.user_id = old.user_id and s.claim_token is not null
         and s.claimed_at > now() - make_interval(secs => c_claim_lease)
    ) then
      raise exception using errcode = 'P0001', message = 'digest_stale:scheduler_running',
        hint = 'A scheduled digest run is writing this record.';
    end if;
    return old;
  end if;

  n := new.value;
  v_same_scan := n ->> 'kind' = 'daily' and (o ->> 'ranAt') is not null and (o ->> 'ranAt') = (n ->> 'ranAt');

  if v_browser then
    if v_in_flight then
      if (n - 'openedAt') is distinct from (o - 'openedAt') then
        raise exception using errcode = 'P0001', message = 'digest_stale:scheduler_in_flight',
          hint = 'A scheduled digest run is in progress; only the opened stamp may change.';
      end if;
    elsif n ->> 'kind' = 'daily' then
      begin
        v_old_ran := (o ->> 'ranAt')::timestamptz;
        v_new_ran := (n ->> 'ranAt')::timestamptz;
      exception when others then
        -- A scan date that does not parse is never a reason to refuse (as in the app).
        v_old_ran := null;
        v_new_ran := null;
      end;
      if v_old_ran is not null and v_new_ran is not null and v_new_ran < v_old_ran then
        raise exception using errcode = 'P0001', message = 'digest_stale:newer_digest',
          hint = 'A newer digest has replaced the one this write was made from.';
      end if;
      if v_same_scan and o ->> 'runBy' = 'scheduler' and o -> 'server' ->> 'phase' = 'done'
         and n ->> 'runBy' = 'scheduler' and coalesce(n -> 'server' ->> 'phase', '') not in ('', 'done') then
        raise exception using errcode = 'P0001', message = 'digest_stale:phase_regression',
          hint = 'This digest has finished since the copy this write was made from.';
      end if;
    end if;
  end if;

  if v_same_scan and jsonb_typeof(o -> 'openedAt') = 'string' and coalesce(jsonb_typeof(n -> 'openedAt'), 'null') = 'null' then
    new.value := jsonb_set(n, '{openedAt}', o -> 'openedAt', true);
  end if;
  return new;
end;
$$;

revoke all on function public.digest_write_guard() from public, anon, authenticated;

drop trigger if exists kv_digest_guard_update on public.kv;
create trigger kv_digest_guard_update
  before update on public.kv
  for each row
  when (old.collection = 'digests' and old.key = 'daily:latest')
  execute function public.digest_write_guard();

drop trigger if exists kv_digest_guard_delete on public.kv;
create trigger kv_digest_guard_delete
  before delete on public.kv
  for each row
  when (old.collection = 'digests' and old.key = 'daily:latest')
  execute function public.digest_write_guard();
