-- Physician-beta spending safeguards. PROPOSED; not applied anywhere but disposable test
-- databases. Contract and release order: docs/SPENDING_CONTRACT.md.
--
-- Additive only: new columns default safe, new tables, new service-role RPCs, and a
-- replacement redeem_sponsor_invite. No ledger row is changed or removed.
--
-- SAFE UNCONFIGURED STATE. After this migration, sponsored spending is PAUSED and the
-- total beta budget is UNSET, so every reservation is denied (fail closed) until an
-- operator sets beta_budget_usd + beta_budget_starts_at and clears spending_paused.
-- Enrollment is likewise paused with no enrollment limit. Old edge functions do not read
-- these columns, so the cutover deploys the NEW functions FIRST: before this migration
-- they find no spend_* RPCs / contract marker and refuse every paid call and redemption.
-- See docs/SPENDING_CONTRACT.md § Cutover.
--
-- Privilege model: every function here is SECURITY INVOKER with EXECUTE revoked from
-- public, anon and authenticated and granted to service_role only. Tables have no client
-- grants. Nothing relies on current_user inside a SECURITY DEFINER body to identify the
-- original caller (the old redeem function did, and that check was always the owner).
begin;

-- --- Config: pause switches, total beta budget, enrollment limit -------------------------
alter table public.sponsor_config
  add column if not exists spending_paused       boolean not null default true,
  add column if not exists enrollment_paused     boolean not null default true,
  add column if not exists beta_budget_usd       numeric(10,4),   -- null = unset: fail closed
  add column if not exists beta_budget_starts_at timestamptz,     -- spend at/after this counts
  add column if not exists enrollment_limit      integer,         -- null = unset: no new enrollment
  add column if not exists pause_note            text;

-- --- Reservations: the liability of every sponsor-paid provider attempt ------------------
-- No foreign key to auth.users: a deleted account must not erase what it may have cost.
create table if not exists public.spend_reservations (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  request_id          text not null check (length(request_id) between 8 and 128),
  fingerprint         text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  model               text not null,
  purpose             text,
  source              text not null check (source in ('proxy', 'scheduler')),
  reserved_micro      bigint not null check (reserved_micro > 0),
  max_input_tokens    integer not null check (max_input_tokens >= 0),
  max_output_tokens   integer not null check (max_output_tokens >= 0),
  -- reserved: may have been dispatched; counts in full until resolved.
  -- ambiguous: outcome unknown; counts in full until reconciled.
  -- settled / reconciled: actual cost moved to model_spend; no longer outstanding.
  -- (There is no 'released' state: after dispatch, nothing short of priced usage or an
  -- audited reconciliation reduces a liability. Requests refused before dispatch never
  -- create a reservation.)
  state               text not null default 'reserved' check (state in ('reserved', 'ambiguous', 'settled', 'reconciled')),
  state_reason        text,
  actual_micro        bigint check (actual_micro >= 0),
  provider_request_id text,
  provider_message_id text,
  reconciliation_note text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  resolved_at         timestamptz,
  unique (user_id, request_id)
);
create index if not exists spend_reservations_outstanding_idx on public.spend_reservations (user_id) where state in ('reserved', 'ambiguous');
alter table public.spend_reservations enable row level security;
revoke all on public.spend_reservations from public, anon, authenticated;
grant select, insert, update on public.spend_reservations to service_role;

-- Settlements that exceeded their reservation. Any unacknowledged row stops all new
-- reservations: the bound that should have covered it is wrong.
create table if not exists public.spend_overruns (
  id               bigint generated always as identity primary key,
  reservation_id   uuid not null,
  user_id          uuid not null,
  reserved_micro   bigint not null,
  actual_micro     bigint not null,
  created_at       timestamptz not null default now(),
  acknowledged_at  timestamptz,
  acknowledgement  text
);
alter table public.spend_overruns enable row level security;
revoke all on public.spend_overruns from public, anon, authenticated;
grant select, insert, update on public.spend_overruns to service_role;

-- Manual actions (reconciliation, overrun acknowledgement), append-only by convention.
create table if not exists public.spend_audit (
  id             bigint generated always as identity primary key,
  ts             timestamptz not null default now(),
  action         text not null,
  reservation_id uuid,
  detail         jsonb not null default '{}'
);
alter table public.spend_audit enable row level security;
revoke all on public.spend_audit from public, anon, authenticated;
grant select, insert on public.spend_audit to service_role;

-- Ledger rows written by settlement point back at their reservation; a reservation can
-- produce at most one ledger row. Historical rows keep reservation_id null.
alter table public.model_spend
  add column if not exists reservation_id uuid unique,
  add column if not exists request_id     text;

-- Financial liability outlives the account. The original ledger cascaded on auth-user
-- deletion, so deleting an account erased its spend from every cap, the global ceiling
-- and the total budget (and an unresolved reservation of a deleted account could not be
-- reconciled into the ledger). Drop that foreign key: existing rows are kept exactly as
-- they are, new settlements and reconciliations need no auth row, and the caps keep
-- counting what was spent. user_id stays the account id it always was. (Rows already
-- removed by past cascades cannot be recovered by this migration.)
do $$
declare c text;
begin
  for c in
    select con.conname from pg_constraint con
     where con.conrelid = 'public.model_spend'::regclass and con.contype = 'f'
       and con.confrelid = 'auth.users'::regclass
  loop
    execute format('alter table public.model_spend drop constraint %I', c);
  end loop;
end $$;
grant select, insert on public.model_spend to service_role;

-- --- Scheduler claim ownership ----------------------------------------------------------
alter table public.digest_schedules add column if not exists claim_token uuid;
grant select, update on public.digest_schedules to service_role;
grant select, insert, update, delete on public.kv to service_role;
grant select on public.sponsored_accounts, public.sponsor_config to service_role;
grant select, insert, update on public.sponsor_invites, public.sponsored_accounts to service_role;
grant insert on public.events to service_role;

-- --- Spending checks ------------------------------------------------------------------------
-- One lock serializes every reservation, settlement and reconciliation, so per-account
-- caps and the shared global ceiling/total budget are checked against a stable total.
-- Beta scale makes a single lock cheap; it is held only for a few short statements.
create or replace function public.spend_lock() returns void
language sql security invoker set search_path = '' as $$
  select pg_catalog.pg_advisory_xact_lock(7243100001)
$$;

-- Why a new charge of p_new_micro may not be reserved right now, or null if it may.
-- Windows are UTC: the day starts 00:00 UTC, the month on the 1st 00:00 UTC. Ledger rows
-- count in the window of their timestamp (a settled attempt is stamped with the time it
-- was reserved). Outstanding reservations (reserved/ambiguous) count in EVERY window until
-- resolved, so no day or month rollover can hide an unresolved liability.
create or replace function public.spend_denial_reason(p_user_id uuid, p_new_micro bigint)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  c public.sponsor_config%rowtype;
  a public.sponsored_accounts%rowtype;
  v_day_start   timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_month_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  v_daily numeric; v_monthly numeric; v_new numeric;
  s record;
begin
  if p_user_id is null or p_new_micro is null or p_new_micro <= 0 then return 'invalid_request'; end if;
  v_new := p_new_micro::numeric / 1000000;

  select * into c from public.sponsor_config where id;
  if not found then return 'config_missing'; end if;
  if c.spending_paused then return 'spending_paused'; end if;
  if c.default_daily_cap_usd is null or c.default_daily_cap_usd < 0
     or c.default_monthly_cap_usd is null or c.default_monthly_cap_usd < 0
     or c.global_monthly_ceiling_usd is null or c.global_monthly_ceiling_usd <= 0
     or c.beta_budget_usd is null or c.beta_budget_usd <= 0
     or c.beta_budget_starts_at is null or c.beta_budget_starts_at > now() then
    return 'config_invalid';
  end if;
  if exists (select 1 from public.spend_overruns where acknowledged_at is null) then return 'overrun_review'; end if;

  select * into a from public.sponsored_accounts where user_id = p_user_id;
  if not found or not a.active or (a.ends_at is not null and a.ends_at <= now()) then return 'account_inactive'; end if;
  v_daily := coalesce(a.daily_cap_usd, c.default_daily_cap_usd);
  v_monthly := coalesce(a.monthly_cap_usd, c.default_monthly_cap_usd);
  if v_daily < 0 or v_monthly < 0 then return 'config_invalid'; end if;

  -- One statement, one snapshot.
  select
    (select coalesce(sum(usd), 0) from public.model_spend where user_id = p_user_id and ts >= v_day_start) as user_day,
    (select coalesce(sum(usd), 0) from public.model_spend where user_id = p_user_id and ts >= v_month_start) as user_month,
    (select coalesce(sum(usd), 0) from public.model_spend where ts >= v_month_start) as global_month,
    (select coalesce(sum(usd), 0) from public.model_spend where ts >= c.beta_budget_starts_at) as beta_total,
    (select coalesce(sum(reserved_micro), 0) from public.spend_reservations where user_id = p_user_id and state in ('reserved', 'ambiguous'))::numeric / 1000000 as user_out,
    (select coalesce(sum(reserved_micro), 0) from public.spend_reservations where state in ('reserved', 'ambiguous'))::numeric / 1000000 as all_out
  into s;

  if s.user_day + s.user_out + v_new > v_daily then return 'cap_day'; end if;
  if s.user_month + s.user_out + v_new > v_monthly then return 'cap_month'; end if;
  if s.global_month + s.all_out + v_new > c.global_monthly_ceiling_usd then return 'cap_global'; end if;
  if s.beta_total + s.all_out + v_new > c.beta_budget_usd then return 'budget_total'; end if;
  return null;
end;
$$;

-- Reserve the conservative maximum charge of ONE provider attempt before dispatch.
-- A request id is bound to (account, fingerprint): reusing it for the same request is a
-- duplicate and reusing it for a different request is a mismatch; neither dispatches.
-- A scheduler attempt must present the run's claim token: ownership is checked and the
-- lease renewed in this same transaction, so a worker that lost its claim cannot reserve
-- (and therefore cannot dispatch), and an admitted attempt keeps its claim fresh for
-- longer than the provider timeout. Lock order: the spend lock, then the schedule row.
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

-- Record the actual cost and release only the unused balance. Idempotent: the same
-- settlement again reports already_settled; a different one reports conflict and changes
-- nothing. Actual above the reservation is recorded in full and opens an overrun, which
-- stops new reservations until acknowledged.
create or replace function public.spend_settle(
  p_reservation_id uuid, p_actual_micro bigint, p_model text, p_input_tokens integer, p_output_tokens integer,
  p_cache_read_tokens integer, p_cache_write_tokens integer, p_provider_request_id text, p_provider_message_id text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.spend_reservations%rowtype;
begin
  if p_actual_micro is null or p_actual_micro < 0 then raise exception using errcode = '22023', message = 'actual cost must be a non-negative integer'; end if;
  perform public.spend_lock();
  select * into r from public.spend_reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.state in ('settled', 'reconciled') then
    return jsonb_build_object('status', case when r.actual_micro = p_actual_micro then 'already_settled' else 'conflict' end, 'state', r.state);
  end if;

  insert into public.model_spend (user_id, ts, model, purpose, input_tokens, cached_tokens, output_tokens, usd, cache_hit, reservation_id, request_id)
    values (r.user_id, r.created_at, p_model, r.purpose,
            coalesce(p_input_tokens, 0) + coalesce(p_cache_write_tokens, 0), coalesce(p_cache_read_tokens, 0), coalesce(p_output_tokens, 0),
            p_actual_micro::numeric / 1000000, false, r.id, r.request_id);
  update public.spend_reservations
     set state = 'settled', actual_micro = p_actual_micro, provider_request_id = coalesce(p_provider_request_id, provider_request_id),
         provider_message_id = p_provider_message_id, updated_at = now(), resolved_at = now()
   where id = r.id;
  if p_actual_micro > r.reserved_micro then
    insert into public.spend_overruns (reservation_id, user_id, reserved_micro, actual_micro) values (r.id, r.user_id, r.reserved_micro, p_actual_micro);
    return jsonb_build_object('status', 'overrun');
  end if;
  return jsonb_build_object('status', 'settled');
end;
$$;

-- Outcome unknown (timeout, lost response, ANY non-2xx response after dispatch, unpriceable
-- usage): keep the full reservation counted until an operator reconciles it. No provider
-- error status is treated as proof of zero charge.
create or replace function public.spend_mark_ambiguous(p_reservation_id uuid, p_reason text, p_provider_request_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.spend_reservations%rowtype;
begin
  perform public.spend_lock();
  select * into r from public.spend_reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.state <> 'reserved' then return jsonb_build_object('status', 'unchanged', 'state', r.state); end if;
  update public.spend_reservations set state = 'ambiguous', state_reason = left(p_reason, 200),
         provider_request_id = coalesce(p_provider_request_id, provider_request_id), updated_at = now() where id = r.id;
  return jsonb_build_object('status', 'ambiguous');
end;
$$;

-- Operator reconciliation of a reserved/ambiguous attempt against provider records.
-- Writes the determined cost (0 allowed) to the ledger and an audit row. Requires a note.
create or replace function public.spend_reconcile(p_reservation_id uuid, p_actual_micro bigint, p_note text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.spend_reservations%rowtype;
begin
  if p_note is null or length(trim(p_note)) < 8 then raise exception using errcode = '22023', message = 'reconciliation needs an explanatory note'; end if;
  if p_actual_micro is null or p_actual_micro < 0 then raise exception using errcode = '22023', message = 'actual cost must be a non-negative integer'; end if;
  perform public.spend_lock();
  select * into r from public.spend_reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.state not in ('reserved', 'ambiguous') then return jsonb_build_object('status', 'unchanged', 'state', r.state); end if;
  insert into public.model_spend (user_id, ts, model, purpose, usd, cache_hit, reservation_id, request_id)
    values (r.user_id, r.created_at, r.model, r.purpose, p_actual_micro::numeric / 1000000, false, r.id, r.request_id);
  update public.spend_reservations set state = 'reconciled', actual_micro = p_actual_micro, reconciliation_note = p_note,
         updated_at = now(), resolved_at = now() where id = r.id;
  insert into public.spend_audit (action, reservation_id, detail)
    values ('reconcile', r.id, jsonb_build_object('from_state', r.state, 'reserved_micro', r.reserved_micro, 'actual_micro', p_actual_micro, 'note', p_note));
  if p_actual_micro > r.reserved_micro then
    insert into public.spend_overruns (reservation_id, user_id, reserved_micro, actual_micro) values (r.id, r.user_id, r.reserved_micro, p_actual_micro);
  end if;
  return jsonb_build_object('status', 'reconciled');
end;
$$;

create or replace function public.spend_acknowledge_overrun(p_overrun_id bigint, p_note text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if p_note is null or length(trim(p_note)) < 8 then raise exception using errcode = '22023', message = 'acknowledgement needs an explanatory note'; end if;
  update public.spend_overruns set acknowledged_at = now(), acknowledgement = p_note where id = p_overrun_id and acknowledged_at is null;
  if not found then return jsonb_build_object('status', 'unchanged'); end if;
  insert into public.spend_audit (action, detail) values ('acknowledge_overrun', jsonb_build_object('overrun_id', p_overrun_id, 'note', p_note));
  return jsonb_build_object('status', 'acknowledged');
end;
$$;

-- Read-only preflight for the scheduler: would a minimal charge be allowed now? Not a
-- reservation; every provider attempt still reserves.
create or replace function public.spend_status(p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_reason text;
begin
  v_reason := public.spend_denial_reason(p_user_id, 1);
  return jsonb_build_object('allowed', v_reason is null, 'reason', v_reason);
end;
$$;

-- --- Scheduler claims: atomic acquisition and owner-guarded renewal/finish ---------------
create or replace function public.digest_claim(p_user_id uuid, p_stale_seconds integer)
returns uuid language sql security invoker set search_path = '' as $$
  update public.digest_schedules
     set claimed_at = now(), claim_token = gen_random_uuid(), updated_at = now()
   where user_id = p_user_id and enabled
     and (claimed_at is null or claimed_at < now() - make_interval(secs => greatest(p_stale_seconds, 60)))
  returning claim_token
$$;

create or replace function public.digest_claim_renew(p_user_id uuid, p_token uuid)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.digest_schedules set claimed_at = now(), updated_at = now() where user_id = p_user_id and claim_token = p_token;
  return found;
end;
$$;

create or replace function public.digest_claim_finish(p_user_id uuid, p_token uuid, p_finished boolean, p_result text)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  update public.digest_schedules
     set claimed_at = null, claim_token = null,
         last_run_at = case when p_finished then now() else last_run_at end,
         last_result = coalesce(left(p_result, 200), last_result), updated_at = now()
   where user_id = p_user_id and claim_token = p_token;
  return found;
end;
$$;

-- A scheduler storage write fenced by the claim: the claim row is locked, the token must
-- still match, and the write and the claim renewal commit together. A worker whose claim
-- was taken over gets false and writes nothing. Library papers are never written here.
create or replace function public.scheduler_kv_write(p_user_id uuid, p_token uuid, p_collection text, p_key text, p_value jsonb, p_delete boolean)
returns boolean language plpgsql security invoker set search_path = '' as $$
begin
  if p_collection = 'papers' then raise exception using errcode = '42501', message = 'the scheduler never writes library papers'; end if;
  perform 1 from public.digest_schedules where user_id = p_user_id and claim_token = p_token for update;
  if not found then return false; end if;
  if p_delete then
    delete from public.kv where user_id = p_user_id and collection = p_collection and key = p_key;
  else
    insert into public.kv (user_id, collection, key, value, updated_at) values (p_user_id, p_collection, p_key, p_value, now())
      on conflict (user_id, collection, key) do update set value = excluded.value, updated_at = now();
  end if;
  update public.digest_schedules set claimed_at = now(), updated_at = now() where user_id = p_user_id;
  return true;
end;
$$;

-- --- Invitations: explicit state contract --------------------------------------------------
alter table public.sponsor_invites add column if not exists revoked_at timestamptz;

-- Order of checks (first match wins):
--   invalid   no such code (says nothing else about codes)
--   already   caller has an active, unexpired sponsorship: nothing changes, no use consumed
--   revoked   caller has a sponsorship row that is inactive or past ends_at: never
--             reactivated by a code; reactivation is an operator decision
--   inactive  the code was revoked
--   expired   the code is past expires_at
--   exhausted the code has no uses left
--   paused    enrollment is paused, or no enrollment limit is configured (fail closed)
--   full      active sponsorships have reached enrollment_limit
--   enrolled  new sponsorship created with the code's cohort/caps/end; one use consumed
-- One enrollment lock serializes every redemption, so concurrent codes for one account,
-- the last use of a code, and the enrollment limit cannot be over-spent.
create or replace function public.redeem_sponsor_invite(p_code text, p_user_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_inv public.sponsor_invites%rowtype; v_acc public.sponsored_accounts%rowtype; c public.sponsor_config%rowtype; n integer;
begin
  if p_user_id is null then raise exception using errcode = '22023', message = 'a verified user id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(7243100002);
  select * into v_inv from public.sponsor_invites where code = p_code for update;
  if not found then return jsonb_build_object('status', 'invalid'); end if;
  select * into v_acc from public.sponsored_accounts where user_id = p_user_id for update;
  if found then
    if v_acc.active and (v_acc.ends_at is null or v_acc.ends_at > now()) then
      return jsonb_build_object('status', 'already', 'cohort', v_acc.cohort);
    end if;
    return jsonb_build_object('status', 'revoked');
  end if;
  if v_inv.revoked_at is not null then return jsonb_build_object('status', 'inactive'); end if;
  if v_inv.expires_at is not null and v_inv.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  if v_inv.uses >= v_inv.max_uses then return jsonb_build_object('status', 'exhausted'); end if;
  select * into c from public.sponsor_config where id;
  if not found or c.enrollment_paused or c.enrollment_limit is null then return jsonb_build_object('status', 'paused'); end if;
  select count(*) into n from public.sponsored_accounts where active and (ends_at is null or ends_at > now());
  if n >= c.enrollment_limit then return jsonb_build_object('status', 'full'); end if;
  insert into public.sponsored_accounts (user_id, active, cohort, daily_cap_usd, monthly_cap_usd, ends_at, note)
    values (p_user_id, true, v_inv.cohort, v_inv.daily_cap_usd, v_inv.monthly_cap_usd, v_inv.ends_at, 'invite ' || p_code);
  update public.sponsor_invites set uses = uses + 1 where code = p_code;
  return jsonb_build_object('status', 'enrolled', 'cohort', v_inv.cohort);
end;
$$;

-- --- Trusted shared extraction cache ------------------------------------------------------
-- The original evidence_cache was populated by the browser proxy from client-supplied keys,
-- so its rows carry no proof of which source text, prompt, schema or version produced them.
-- Those rows are preserved untouched and are no longer served. Shared cache hits come only
-- from this table, written only by the scheduled digest (service role) with server-owned
-- provenance. A separate table means a trusted write never collides with, or overwrites, a
-- legacy row that has the same (pmid, extraction_version, source_hash).
create table if not exists public.evidence_cache_trusted (
  pmid               text not null,
  extraction_version text not null,
  source_hash        text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  source_tier        text not null check (source_tier in ('full_text', 'abstract_only')),
  citation           jsonb,
  extraction         jsonb not null,
  model              text not null,
  provenance         jsonb not null check (provenance->>'writer' = 'digest-run' and provenance ? 'bundle_source_sha256'),
  created_by         uuid,
  created_at         timestamptz not null default now(),
  primary key (pmid, extraction_version, source_hash)
);
alter table public.evidence_cache_trusted enable row level security;
revoke all on public.evidence_cache_trusted from public, anon, authenticated;
grant select on public.evidence_cache_trusted to authenticated;
grant select, insert on public.evidence_cache_trusted to service_role;
drop policy if exists "evidence_cache_trusted_read_authenticated" on public.evidence_cache_trusted;
create policy "evidence_cache_trusted_read_authenticated" on public.evidence_cache_trusted
  for select to authenticated using (true);
grant select on public.evidence_cache to service_role;

-- --- Contract marker -------------------------------------------------------------------------
-- New edge functions check this before any redemption; it does not exist before the
-- migration, so a new function deployed first fails closed.
create or replace function public.spending_contract_version()
returns text language sql security invoker set search_path = '' as $$ select '2026-10-09.spending-v2'::text $$;

-- --- Execute privileges: service role only -------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.spend_lock()',
    'public.spend_denial_reason(uuid,bigint)',
    'public.spend_reserve(uuid,text,text,text,text,text,bigint,integer,integer,uuid)',
    'public.spend_settle(uuid,bigint,text,integer,integer,integer,integer,text,text)',
    'public.spend_mark_ambiguous(uuid,text,text)',
    'public.spend_reconcile(uuid,bigint,text)',
    'public.spend_acknowledge_overrun(bigint,text)',
    'public.spend_status(uuid)',
    'public.digest_claim(uuid,integer)',
    'public.digest_claim_renew(uuid,uuid)',
    'public.digest_claim_finish(uuid,uuid,boolean,text)',
    'public.scheduler_kv_write(uuid,uuid,text,text,jsonb,boolean)',
    'public.redeem_sponsor_invite(text,uuid)',
    'public.spending_contract_version()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
