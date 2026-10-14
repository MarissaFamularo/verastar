-- One-step sign-in for a different Gmail spelling of an existing account.
--
-- Not applied by the change that added this file. Apply it with the usual
-- migration path. Until then the client treats a missing prepare function as
-- "no match" and sends the code to the address that was typed.
--
-- public.gmail_alias_prepare uses the same hourly caps as public.gmail_alias_hint
-- (3 per normalized inbox, 8 per client address) and the same client-address
-- rule (cf-connecting-ip, otherwise the rightmost forwarding hop). A match
-- returns a one-character hint and an opaque ticket. The stored address is
-- written only into private.gmail_alias_permits. anon cannot read that table
-- and cannot execute the functions that return the address.
--
-- The edge function claims the ticket with the service role, sends the one-time
-- code to the stored address, and returns a second opaque ticket for verifying
-- the code. Neither response includes the stored address.

begin;

create table if not exists private.gmail_alias_permits (
  ticket     uuid primary key default pg_catalog.gen_random_uuid(),
  email      text not null,
  kind       text not null,
  expires_at timestamptz not null,
  constraint gmail_alias_permits_kind check (kind in ('send', 'verify'))
);

alter table private.gmail_alias_permits enable row level security;
revoke all on table private.gmail_alias_permits from public, anon, authenticated, service_role;

create or replace function private.gmail_alias_decide(p_email text, p_issue boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw text := lower(pg_catalog.btrim(p_email));
  v_canon text;
  v_headers json;
  v_ip text;
  v_email_bucket text;
  v_ip_bucket text;
  v_stored text;
  v_hint text;
  v_email_count bigint;
  v_ip_count bigint;
  v_ticket uuid;
begin
  v_canon := private.gmail_canonical(p_email);
  if v_canon is null then
    return pg_catalog.jsonb_build_object('match', false);
  end if;

  delete from private.gmail_alias_permits where expires_at <= pg_catalog.now();

  begin
    v_headers := nullif(pg_catalog.current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ip := private.gmail_client_ip(v_headers);

  v_email_bucket := 'email:' || v_canon;
  v_ip_bucket := 'ip:' || coalesce(v_ip, 'unknown');

  -- Same caps as the hint: three per normalized inbox per hour, eight per
  -- client address. Over either limit the answer matches "no account".
  v_email_count := private.gmail_alias_hit(v_email_bucket);
  v_ip_count := private.gmail_alias_hit(v_ip_bucket);
  if v_email_count > 3 or v_ip_count > 8 then
    return pg_catalog.jsonb_build_object('match', false);
  end if;

  -- Exact account first. Two accounts can share one Gmail inbox; signing in
  -- with one of those stored addresses must not be sent to the other.
  select u.email into v_stored
    from auth.users u
   where u.email is not null
     and u.deleted_at is null
     and lower(pg_catalog.btrim(u.email)) = v_raw
   limit 1;

  if v_stored is not null then
    return pg_catalog.jsonb_build_object('match', false);
  end if;

  v_stored := null;
  select u.email into v_stored
    from auth.users u
   where u.email is not null
     and u.deleted_at is null
     and split_part(lower(pg_catalog.btrim(u.email)), '@', 2) in ('gmail.com', 'googlemail.com')
     and private.gmail_canonical(u.email) = v_canon
   order by u.created_at asc
   limit 1;

  -- The canonical spelling of a dotted account stays silent. A ticket is only
  -- for a different spelling of an inbox whose exact address was not typed.
  if v_stored is null or v_raw = v_canon then
    return pg_catalog.jsonb_build_object('match', false);
  end if;

  v_hint := private.mask_email_hint(v_stored);
  if v_hint is null or v_hint !~ '^[^@[:space:]]…@(gmail|googlemail)\.com$' then
    return pg_catalog.jsonb_build_object('match', false);
  end if;

  if coalesce(p_issue, false) then
    insert into private.gmail_alias_permits (email, kind, expires_at)
    values (v_stored, 'send', pg_catalog.now() + interval '2 minutes')
    returning ticket into v_ticket;
    return pg_catalog.jsonb_build_object('match', true, 'hint', v_hint, 'ticket', v_ticket);
  end if;

  return pg_catalog.jsonb_build_object('match', true, 'hint', v_hint);
end;
$$;

revoke all on function private.gmail_alias_decide(text, boolean) from public, anon, authenticated, service_role;

create or replace function private.gmail_alias_lookup(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.gmail_alias_decide(p_email, false);
end;
$$;

revoke all on function private.gmail_alias_lookup(text) from public, anon;

create or replace function public.gmail_alias_prepare(p_email text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.gmail_alias_decide(p_email, true);
$$;

revoke all on function public.gmail_alias_prepare(text) from public;
grant execute on function public.gmail_alias_prepare(text) to anon, authenticated, service_role;

create or replace function private.gmail_alias_take_send(p_ticket uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  delete from private.gmail_alias_permits
   where ticket = p_ticket
     and kind = 'send'
     and expires_at > pg_catalog.now()
  returning email into v_email;
  return v_email;
end;
$$;

create or replace function private.gmail_alias_keep_verify(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket uuid;
begin
  if p_email is null or length(p_email) > 320 or position('@' in p_email) = 0 then
    return null;
  end if;
  insert into private.gmail_alias_permits (email, kind, expires_at)
  values (p_email, 'verify', pg_catalog.now() + interval '15 minutes')
  returning ticket into v_ticket;
  return v_ticket;
end;
$$;

create or replace function private.gmail_alias_read_verify(p_ticket uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select email into v_email
    from private.gmail_alias_permits
   where ticket = p_ticket
     and kind = 'verify'
     and expires_at > pg_catalog.now();
  return v_email;
end;
$$;

create or replace function private.gmail_alias_consume_verify(p_ticket uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.gmail_alias_permits
   where ticket = p_ticket
     and kind = 'verify';
end;
$$;

revoke all on function private.gmail_alias_take_send(uuid) from public, anon, authenticated, service_role;
revoke all on function private.gmail_alias_keep_verify(text) from public, anon, authenticated, service_role;
revoke all on function private.gmail_alias_read_verify(uuid) from public, anon, authenticated, service_role;
revoke all on function private.gmail_alias_consume_verify(uuid) from public, anon, authenticated, service_role;

create or replace function public.gmail_alias_take_send(p_ticket uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select private.gmail_alias_take_send(p_ticket);
$$;

create or replace function public.gmail_alias_keep_verify(p_email text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.gmail_alias_keep_verify(p_email);
$$;

create or replace function public.gmail_alias_read_verify(p_ticket uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select private.gmail_alias_read_verify(p_ticket);
$$;

create or replace function public.gmail_alias_consume_verify(p_ticket uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.gmail_alias_consume_verify(p_ticket);
$$;

revoke all on function public.gmail_alias_take_send(uuid) from public, anon, authenticated;
revoke all on function public.gmail_alias_keep_verify(text) from public, anon, authenticated;
revoke all on function public.gmail_alias_read_verify(uuid) from public, anon, authenticated;
revoke all on function public.gmail_alias_consume_verify(uuid) from public, anon, authenticated;

grant execute on function public.gmail_alias_take_send(uuid) to service_role;
grant execute on function public.gmail_alias_keep_verify(text) to service_role;
grant execute on function public.gmail_alias_read_verify(uuid) to service_role;
grant execute on function public.gmail_alias_consume_verify(uuid) to service_role;

commit;
