-- Release a reservation when the provider attempt ended in an error or a timeout.
-- PROPOSED; not applied to any linked project. The daily cap is not changed.
--
-- A reservation is a hold for one attempt, sized to that attempt. When the attempt
-- returns priceable usage, spend_settle records the actual cost and the unused hold
-- drops out of the cap. When the attempt errors, times out, or never returns a body,
-- there is no usage to settle, and leaving the hold in place is what blocked a later
-- cheap call. spend_release drops that hold. It writes no ledger charge.
--
-- A 2xx response that cannot be priced is still ambiguous: the provider returned a
-- message and may have billed it. spend_release refuses those rows (state is not
-- 'reserved' once they have been marked ambiguous, and it also refuses anything that
-- is not 'reserved').
--
-- 'released' is not outstanding, so it does not count toward a cap and it does not
-- hold a scheduled run. The advisory lock is the same one spend_reserve takes, so a
-- release and a concurrent reserve cannot both pass the cap.
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

-- Same body as 20261009120000, plus the released guard: a released hold is not a charge.
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
  if r.state = 'released' then
    return jsonb_build_object('status', 'unchanged', 'state', r.state);
  end if;
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

-- Drop the hold for an attempt that ended in an error or a timeout. Idempotent.
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

do $$
declare f text;
begin
  foreach f in array array[
    'public.spend_release(uuid,text,text)',
    'public.spend_settle(uuid,bigint,text,integer,integer,integer,integer,text,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
