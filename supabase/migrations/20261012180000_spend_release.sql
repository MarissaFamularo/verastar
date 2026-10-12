-- Release a reservation only when the provider definitively did not charge, and keep
-- a released row open for a later confirmed charge.
-- PROPOSED; not applied to any linked project. The daily cap is not changed.
--
-- spend_release drops a hold that was never sent, or that came back as an explicit
-- non-2xx. It writes no ledger charge. 'released' is not outstanding, so it does not
-- count toward a cap and it does not hold a scheduled run. The advisory lock is the
-- same one spend_reserve takes.
--
-- A later console check can still find a charge. spend_settle and spend_reconcile
-- record that cost on a reserved, ambiguous, or released row, idempotently, under the
-- same lock. A settled or reconciled row is not written twice.
begin;

do $$
declare c text;
begin
  select con.conname into c
    from pg_constraint con
   where con.conrelid = 'public.spend_reservations'::regclass
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%state%'
     and pg_get_constraintdef(con.oid) like '%reserved%';
  if c is not null then
    execute format('alter table public.spend_reservations drop constraint %I', c);
  end if;
end $$;

alter table public.spend_reservations add constraint spend_reservations_state_check
  check (state in ('reserved', 'ambiguous', 'settled', 'reconciled', 'released'));

-- Same body as 20261009120000. A released row is not terminal: a confirmed charge
-- still settles it. Settled and reconciled rows stay idempotent.
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

-- Drop the hold when the caller has determined the provider did not charge. Idempotent.
-- actual_micro 0 is "no settled charge", not a claim that the provider billed zero;
-- the audit row records why the hold was dropped. No model_spend row is written.
create or replace function public.spend_release(p_reservation_id uuid, p_reason text, p_provider_request_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.spend_reservations%rowtype;
begin
  perform public.spend_lock();
  select * into r from public.spend_reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.state = 'released' then return jsonb_build_object('status', 'already_released', 'state', r.state); end if;
  if r.state <> 'reserved' then return jsonb_build_object('status', 'unchanged', 'state', r.state); end if;
  update public.spend_reservations
     set state = 'released', actual_micro = 0, state_reason = left(coalesce(p_reason, 'released'), 200),
         provider_request_id = coalesce(p_provider_request_id, provider_request_id),
         updated_at = now(), resolved_at = now()
   where id = r.id;
  insert into public.spend_audit (action, reservation_id, detail)
    values ('release', r.id, jsonb_build_object('reason', left(coalesce(p_reason, ''), 200), 'reserved_micro', r.reserved_micro));
  return jsonb_build_object('status', 'released');
end;
$$;

-- A confirmed charge on a reserved, ambiguous, or released row. One ledger row.
-- The same amount on an already settled or reconciled row is already_reconciled.
-- A different amount conflicts and writes nothing.
create or replace function public.spend_reconcile(p_reservation_id uuid, p_actual_micro bigint, p_note text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.spend_reservations%rowtype;
begin
  if p_note is null or length(trim(p_note)) < 8 then raise exception using errcode = '22023', message = 'reconciliation needs an explanatory note'; end if;
  if p_actual_micro is null or p_actual_micro < 0 then raise exception using errcode = '22023', message = 'actual cost must be a non-negative integer'; end if;
  perform public.spend_lock();
  select * into r from public.spend_reservations where id = p_reservation_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if r.state in ('settled', 'reconciled') then
    return jsonb_build_object('status', case when r.actual_micro = p_actual_micro then 'already_reconciled' else 'conflict' end, 'state', r.state);
  end if;
  if r.state not in ('reserved', 'ambiguous', 'released') then
    return jsonb_build_object('status', 'unchanged', 'state', r.state);
  end if;
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

do $$
declare f text;
begin
  foreach f in array array[
    'public.spend_release(uuid,text,text)',
    'public.spend_settle(uuid,bigint,text,integer,integer,integer,integer,text,text)',
    'public.spend_reconcile(uuid,bigint,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
