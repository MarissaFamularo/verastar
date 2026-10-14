-- Tighten the Gmail alias hint after the security audit.
--
-- Not applied by the change that added this file. Apply it with the usual
-- migration path. Until then the client still treats a missing or failing
-- function as "no match" and sends the code.
--
-- (a) public.gmail_alias_hint runs as its owner, with an empty search path,
-- and calls the private lookup. anon no longer needs USAGE on schema private,
-- and can no longer execute that lookup directly. authenticated keeps USAGE:
-- other private functions on the shared database are granted to signed-in users.
--
-- (b) A hint is returned only when the typed address is a different spelling
-- from the canonical inbox (dots and +tags removed). Typing the canonical
-- address returns the same { match: false } as no account, so a probe of
-- famularomarissa@gmail.com does not reveal famularo.marissa@gmail.com.
-- The hint stays one character, an ellipsis, and the stored domain.
-- The hourly caps drop from 8 per inbox and 20 per client address to 3 and 8.
-- A canonical probe still consumes the inbox cap.
--
-- (c) The per-client cap does not trust the first X-Forwarded-For value. On
-- hosted Supabase the edge sets cf-connecting-ip to the address that connected
-- to it, and a request that arrives with that header already set is refused
-- before SQL sees it. When that header is absent, the rightmost X-Forwarded-For
-- hop is the one the trusted proxy appended; the leftmost hop is caller
-- controlled. x-real-ip is ignored.

begin;

create or replace function private.gmail_client_ip(p_headers json)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_cf text;
  v_xff text;
  v_hop text;
begin
  if p_headers is null then
    return null;
  end if;

  -- Single address. A comma would mean a caller-built chain, which this header
  -- is not: the edge sets one connecting address.
  v_cf := nullif(btrim(p_headers ->> 'cf-connecting-ip'), '');
  if v_cf is not null and position(',' in v_cf) = 0 then
    begin
      perform v_cf::inet;
      return v_cf;
    exception when others then
      null;
    end;
  end if;

  -- Rightmost hop. '^.*,' consumes every earlier hop, including a spoofed one.
  v_xff := p_headers ->> 'x-forwarded-for';
  if v_xff is null or btrim(v_xff) = '' then
    return null;
  end if;
  v_hop := nullif(btrim(regexp_replace(v_xff, '^.*,', '')), '');
  if v_hop is null then
    return null;
  end if;
  begin
    perform v_hop::inet;
    return v_hop;
  exception when others then
    return null;
  end;
end;
$$;

revoke all on function private.gmail_client_ip(json) from public, anon, authenticated;

create or replace function private.gmail_alias_lookup(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_raw text := lower(btrim(p_email));
  v_canon text;
  v_headers json;
  v_ip text;
  v_email_bucket text;
  v_ip_bucket text;
  v_stored text;
  v_hint text;
  v_email_count bigint;
  v_ip_count bigint;
begin
  v_canon := private.gmail_canonical(p_email);
  if v_canon is null then
    return jsonb_build_object('match', false);
  end if;

  begin
    v_headers := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    v_headers := null;
  end;
  v_ip := private.gmail_client_ip(v_headers);

  v_email_bucket := 'email:' || v_canon;
  v_ip_bucket := 'ip:' || coalesce(v_ip, 'unknown');

  -- Email first, then the client address, every time. The hit function locks
  -- its row until this transaction commits, so a burst cannot all read a count
  -- of one. Three lookups per normalized inbox per hour, eight per client
  -- address. Over either limit the answer is the same shape as "no account".
  v_email_count := private.gmail_alias_hit(v_email_bucket);
  v_ip_count := private.gmail_alias_hit(v_ip_bucket);
  if v_email_count > 3 or v_ip_count > 8 then
    return jsonb_build_object('match', false);
  end if;

  select u.email into v_stored
    from auth.users u
   where u.email is not null
     and u.deleted_at is null
     and split_part(lower(btrim(u.email)), '@', 2) in ('gmail.com', 'googlemail.com')
     and private.gmail_canonical(u.email) = v_canon
     and lower(btrim(u.email)) <> v_raw
   order by u.created_at asc
   limit 1;

  -- Typing the canonical address must not confirm that a dotted or tagged
  -- account exists. A hint is only for a spelling that still needs correcting.
  if v_stored is null or v_raw = v_canon then
    return jsonb_build_object('match', false);
  end if;

  v_hint := private.mask_email_hint(v_stored);
  if v_hint is null or v_hint !~ '^[^@[:space:]]…@(gmail|googlemail)\.com$' then
    return jsonb_build_object('match', false);
  end if;

  return jsonb_build_object('match', true, 'hint', v_hint);
end;
$$;

revoke all on function private.gmail_alias_lookup(text) from public, anon;

-- The wrapper is the only anon entry point. It runs as the owner, so the
-- caller never resolves a private name. The call stays schema-qualified
-- because the search path is empty.
create or replace function public.gmail_alias_hint(p_email text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.gmail_alias_lookup(p_email);
$$;

revoke all on function public.gmail_alias_hint(text) from public;
grant execute on function public.gmail_alias_hint(text) to anon, authenticated, service_role;

revoke usage on schema private from anon;

commit;
