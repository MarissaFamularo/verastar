-- Scheduler hold and explicit recovery. PROPOSED; applied only to disposable local databases.
--
-- The spending migration remembers an unresolved paid attempt in the ledger, but the scheduler
-- did not: after a worker died mid-attempt, or an attempt ended ambiguous, the next cron tick or
-- "run mine now" sent the unfinished step again (reproduced 2026-10-10 on a local stack). This
-- migration makes the ledger's memory the scheduler's rule:
--
--   An account with an UNRESOLVED scheduler attempt is not runnable by the scheduler, and stays
--   that way until an operator has both reconciled the attempt and explicitly recovered the account.
--
--   held  :=  a scheduler reservation for the account is 'reserved' or 'ambiguous'   (cost unknown)
--         or  one is 'reconciled' and no recovery has released it yet                (cost known,
--                                                                                     run not released)
--
-- "Released" is a stamp on the reservation itself (recovered_at), set only by scheduler_recover.
-- It is deliberately not a comparison of timestamps: a reconciliation's resolved_at is the start
-- time of the operator's transaction, so "reconciled after the last acknowledgement" could be
-- wrong for a reconciliation made inside a long-open session, and wrong in the unsafe direction.
--
-- "Unresolved" is read from the ledger, not from a flag a worker has to remember to set, so a
-- worker that died is covered: its reservation is still 'reserved'. Settled attempts never hold.
-- A denial never creates a reservation, so it never holds. Reconciliation records the cost and
-- does not lift the hold. Only scheduler_recover lifts it; it is refused while anything is
-- unresolved, writes an audit row, makes no provider call and starts no run.
--
-- Enforced twice. spend_status (the scheduler's preflight, called before the claim) reports the
-- hold, so neither cron nor a manual run starts any phase, search included. spend_reserve denies
-- a scheduler attempt for a held account in the same transaction as the claim check, so no code
-- path can dispatch one.
--
-- Scope: source = 'scheduler' only. Browser-proxy attempts (source 'proxy') neither create a hold
-- nor are stopped by one; their policy is unchanged.
--
-- Additive: two nullable columns, two new functions, and two functions from the spending migration
-- replaced with the same bodies plus the hold check. No cap, amount, reservation state, claim,
-- fence, settlement or reconciliation changes. Everything is SECURITY INVOKER and service-role only.
-- A reconciled scheduler reservation that exists before this migration holds its account until
-- recovered; production has none (the spending migration is not deployed there yet).
--
-- Release order: after 20261009120000_beta_spending_safeguards.sql (it replaces spend_status and
-- spend_reserve from that migration) and 20261010120000_digest_write_guard.sql. Rollback: re-run
-- the spend_status and spend_reserve definitions from the spending migration, then
--   drop function if exists public.scheduler_recover(uuid, text, text);
--   drop function if exists public.scheduler_hold_reason(uuid);
-- The columns may stay; nothing else reads them.
begin;

-- When an operator last released this account's scheduled runs (for the record and for
-- monitoring; the rule itself reads the reservations). Server-owned: no client grant.
alter table public.digest_schedules add column if not exists recovery_ack_at timestamptz;
-- When scheduler_recover released the run this reconciled attempt was holding. Null on every
-- other reservation. It changes no amount and no state.
alter table public.spend_reservations add column if not exists recovered_at timestamptz;

create or replace function public.scheduler_hold_reason(p_user_id uuid)
returns text language sql stable security invoker set search_path = '' as $$
  select case when exists (
    select 1 from public.spend_reservations r
     where r.user_id = p_user_id and r.source = 'scheduler'
       and (r.state in ('reserved', 'ambiguous') or (r.state = 'reconciled' and r.recovered_at is null))
  ) then 'unresolved_liability' end
$$;

-- The scheduler's preflight (its only caller is digest-run/handler.js): a held account is skipped
-- before it is claimed. The hold is reported ahead of the cap and configuration reasons.
create or replace function public.spend_status(p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_reason text;
begin
  v_reason := coalesce(public.scheduler_hold_reason(p_user_id), public.spend_denial_reason(p_user_id, 1));
  return jsonb_build_object('allowed', v_reason is null, 'reason', v_reason);
end;
$$;

-- The authoritative stop. Same body as the spending migration plus the two marked lines. The check
-- sits before this attempt's own reservation is inserted, and a run makes its paid attempts one
-- after another, so a run is never stopped by its own in-flight attempt.
create or replace function public.spend_reserve(
  p_user_id uuid, p_request_id text, p_fingerprint text, p_model text, p_purpose text,
  p_source text, p_reserve_micro bigint, p_max_input_tokens integer, p_max_output_tokens integer,
  p_claim_token uuid default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.spend_reservations%rowtype; v_reason text;
begin
  perform public.spend_lock();
  select * into r from public.spend_reservations where user_id = p_user_id and request_id = p_request_id;
  if found then
    return jsonb_build_object('status', case when r.fingerprint = p_fingerprint then 'duplicate' else 'mismatch' end,
                              'state', r.state, 'reservation_id', r.id);
  end if;
  if p_source = 'scheduler' then
    if p_claim_token is null then return jsonb_build_object('status', 'denied', 'reason', 'claim_lost'); end if;
    update public.digest_schedules set claimed_at = now(), updated_at = now()
     where user_id = p_user_id and claim_token = p_claim_token;
    if not found then return jsonb_build_object('status', 'denied', 'reason', 'claim_lost'); end if;
    v_reason := public.scheduler_hold_reason(p_user_id);                                                  -- hold
    if v_reason is not null then return jsonb_build_object('status', 'denied', 'reason', v_reason); end if; -- hold
  elsif p_claim_token is not null then
    raise exception using errcode = '22023', message = 'only scheduler reservations carry a claim token';
  end if;
  v_reason := public.spend_denial_reason(p_user_id, p_reserve_micro);
  if v_reason is not null then return jsonb_build_object('status', 'denied', 'reason', v_reason); end if;
  insert into public.spend_reservations (user_id, request_id, fingerprint, model, purpose, source, reserved_micro, max_input_tokens, max_output_tokens)
    values (p_user_id, p_request_id, p_fingerprint, p_model, left(p_purpose, 40), p_source, p_reserve_micro, p_max_input_tokens, p_max_output_tokens)
    returning * into r;
  return jsonb_build_object('status', 'reserved', 'reservation_id', r.id, 'reserved_micro', r.reserved_micro);
end;
$$;

-- Operator recovery of a held account. One of:
--   resume   acknowledge only. The next tick may continue the unfinished digest through the usual
--            claim and spending checks. This IS a decision to let the scheduler send the
--            unfinished step again.
--   abandon  close the unfinished scheduler digest as done AND abandoned (the app shows it as
--            stopped, not as a completed digest) and mark the day run, so no tick continues it
--            and cron does not start another today. What was read stays stored.
--   retire   abandon, and also disable the schedule. For operator-owned preparation accounts.
-- Refused, changing nothing, while any scheduler attempt is unresolved (reconcile first), while a
-- tick holds a live claim, or when the account is not held at all (reconciled liability is the
-- only thing this releases). Lock order matches spend_reserve: the spend lock, then the schedule
-- row. Under that lock no reconciliation can interleave: every reconciled attempt this call
-- sees is released by it, and one reconciled later holds the account again.
create or replace function public.scheduler_recover(p_user_id uuid, p_action text, p_note text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  -- The claim lease, in seconds: CLAIM_STALE_SECONDS in supabase/functions/_shared/timeouts.js.
  c_claim_lease constant integer := 240;
  s public.digest_schedules%rowtype;
  v_now timestamptz;
  v_held text;
  v_closed integer := 0;
  v_released integer := 0;
begin
  if p_note is null or length(trim(p_note)) < 8 then raise exception using errcode = '22023', message = 'recovery needs an explanatory note'; end if;
  if p_action is null or p_action not in ('resume', 'abandon', 'retire') then raise exception using errcode = '22023', message = 'action must be resume, abandon or retire'; end if;
  perform public.spend_lock();
  select * into s from public.digest_schedules where user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  v_now := clock_timestamp();
  if exists (select 1 from public.spend_reservations where user_id = p_user_id and source = 'scheduler' and state in ('reserved', 'ambiguous')) then
    return jsonb_build_object('status', 'refused', 'reason', 'unresolved_liability');
  end if;
  if s.claim_token is not null and s.claimed_at > v_now - make_interval(secs => c_claim_lease) then
    return jsonb_build_object('status', 'refused', 'reason', 'run_in_progress');
  end if;
  -- Nothing unresolved and nothing awaiting release: there is no hold to recover from.
  v_held := public.scheduler_hold_reason(p_user_id);
  if v_held is null then return jsonb_build_object('status', 'refused', 'reason', 'not_held'); end if;
  if p_action in ('abandon', 'retire') then
    update public.kv
       set value = jsonb_set(jsonb_set(jsonb_set(value, '{server,phase}', '"done"'), '{server,abandoned}', 'true'), '{server,abandonedAt}', to_jsonb(v_now)),
           updated_at = v_now
     where user_id = p_user_id and collection = 'digests' and key = 'daily:latest'
       and value ->> 'kind' = 'daily' and value ->> 'runBy' = 'scheduler'
       and coalesce(value -> 'server' ->> 'phase', '') not in ('', 'done');
    get diagnostics v_closed = row_count;
  end if;
  update public.spend_reservations set recovered_at = v_now
   where user_id = p_user_id and source = 'scheduler' and state = 'reconciled' and recovered_at is null;
  get diagnostics v_released = row_count;
  update public.digest_schedules
     set recovery_ack_at = v_now, claimed_at = null, claim_token = null, updated_at = v_now,
         last_run_at = case when p_action in ('abandon', 'retire') then v_now else last_run_at end,
         last_result = left('recovered: ' || p_action, 200),
         enabled = case when p_action = 'retire' then false else enabled end
   where user_id = p_user_id;
  insert into public.spend_audit (action, detail)
    values ('scheduler_recover', jsonb_build_object('user_id', p_user_id, 'action', p_action, 'note', p_note,
            'released_reservations', v_released, 'digest_closed', v_closed > 0, 'previous_ack_at', s.recovery_ack_at, 'role', current_user));
  return jsonb_build_object('status', 'recovered', 'action', p_action, 'released_reservations', v_released, 'digest_closed', v_closed > 0);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.scheduler_hold_reason(uuid)',
    'public.scheduler_recover(uuid,text,text)',
    'public.spend_status(uuid)',
    'public.spend_reserve(uuid,text,text,text,text,text,bigint,integer,integer,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
