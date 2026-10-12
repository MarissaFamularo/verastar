-- Gmail inbox alias check for email-code sign-in.
--
-- famularo.marissa@gmail.com and famularomarissa@gmail.com reach the same inbox
-- but create two auth users. This function tells the sign-in screen when a
-- different existing account normalizes to the address being typed.
--
-- It returns only { match: boolean, hint?: text }. The hint is the first
-- character of the stored address, an ellipsis, and the stored domain
-- (f…@gmail.com). It does not merge accounts and it does not return the address,
-- the user id, or a list of users.
--
-- Not applied by the change that added this file. Apply it with the usual
-- migration path when you are ready for the warning to go live. Until then the
-- client treats a missing function as "no match" and still sends the code.
--
-- The hourly caps are one row per bucket. INSERT ... ON CONFLICT DO UPDATE
-- locks that row, so concurrent calls serialize and the returned count is the
-- count after this call. A plain insert-then-count let every overlapping
-- transaction see only its own row and all of them returned a hint.

begin;

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to anon, authenticated, service_role;

-- One row per normalized inbox and one per client address. hits is the number
-- of lookups in the open hour that started at window_start.
create table if not exists private.gmail_alias_limits (
  bucket       text primary key,
  window_start timestamptz not null,
  hits         integer not null
);

alter table private.gmail_alias_limits enable row level security;
revoke all on table private.gmail_alias_limits from public, anon, authenticated;

-- Locks the bucket row. Concurrent callers for the same bucket wait, then
-- increment the count the previous caller committed. The returned hits value
-- already includes this call.
create or replace function private.gmail_alias_hit(p_bucket text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_hits integer;
begin
  insert into private.gmail_alias_limits as lim (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update
  set hits = case
        when lim.window_start <= now() - interval '1 hour' then 1
        else lim.hits + 1
      end,
      window_start = case
        when lim.window_start <= now() - interval '1 hour' then now()
        else lim.window_start
      end
  returning hits into v_hits;
  return v_hits;
end;
$$;

-- Dots and +tags are insignificant. googlemail.com is the same inbox as gmail.com.
-- Anything else, including a second @, returns null and is not looked up.
create or replace function private.gmail_canonical(p_email text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := lower(btrim(p_email));
  v_local text;
  v_domain text;
begin
  if v is null or length(v) > 320 or position('@' in v) = 0 then
    return null;
  end if;
  v_local := split_part(v, '@', 1);
  v_domain := split_part(v, '@', 2);
  if v_local = '' or v_domain = '' or position('@' in v_domain) > 0 then
    return null;
  end if;
  if v_domain not in ('gmail.com', 'googlemail.com') then
    return null;
  end if;
  v_local := split_part(v_local, '+', 1);
  v_local := replace(v_local, '.', '');
  if v_local = '' then
    return null;
  end if;
  return v_local || '@gmail.com';
end;
$$;

create or replace function private.mask_email_hint(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then null
    else left(split_part(lower(btrim(p_email)), '@', 1), 1)
      || '…@'
      || split_part(lower(btrim(p_email)), '@', 2)
  end
$$;

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
    v_ip := nullif(btrim(split_part(coalesce(v_headers ->> 'x-forwarded-for', v_headers ->> 'x-real-ip', ''), ',', 1)), '');
  exception when others then
    v_ip := null;
  end;

  v_email_bucket := 'email:' || v_canon;
  v_ip_bucket := 'ip:' || coalesce(v_ip, 'unknown');

  -- Email first, then the client address, every time. The hit function locks
  -- its row until this transaction commits, so a burst cannot all read a count
  -- of one. Eight lookups per normalized inbox per hour, twenty per client
  -- address. Over either limit the answer is the same shape as "no account".
  v_email_count := private.gmail_alias_hit(v_email_bucket);
  v_ip_count := private.gmail_alias_hit(v_ip_bucket);
  if v_email_count > 8 or v_ip_count > 20 then
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

  if v_stored is null then
    return jsonb_build_object('match', false);
  end if;

  v_hint := private.mask_email_hint(v_stored);
  if v_hint is null or v_hint !~ '^[^@[:space:]]…@(gmail|googlemail)\.com$' then
    return jsonb_build_object('match', false);
  end if;

  return jsonb_build_object('match', true, 'hint', v_hint);
end;
$$;

-- Exposed wrapper is invoker. The lookup that reads auth.users stays in private.
create or replace function public.gmail_alias_hint(p_email text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.gmail_alias_lookup(p_email);
$$;

revoke all on function private.gmail_canonical(text) from public, anon, authenticated;
revoke all on function private.mask_email_hint(text) from public, anon, authenticated;
revoke all on function private.gmail_alias_hit(text) from public, anon, authenticated;
revoke all on function private.gmail_alias_lookup(text) from public;
grant execute on function private.gmail_alias_lookup(text) to anon, authenticated, service_role;

revoke all on function public.gmail_alias_hint(text) from public;
grant execute on function public.gmail_alias_hint(text) to anon, authenticated, service_role;

commit;
