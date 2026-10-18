-- Isolated test DB only. The fixture and both Gmail migrations must already be applied.
\set ON_ERROR_STOP on

create or replace function pg_temp.assert_ok(v boolean, label text) returns void language plpgsql as $$
begin
  if not coalesce(v, false) then
    raise exception 'FAIL: %', label;
  end if;
end $$;

-- (a) anon has no path into schema private. The public wrapper still answers.
select pg_temp.assert_ok(
  (select p.prosecdef and 'search_path=""' = any(p.proconfig)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'gmail_alias_hint'),
  'public wrapper is security definer with an empty search path');
select pg_temp.assert_ok(not has_schema_privilege('anon', 'private', 'usage'), 'anon has no usage on schema private');
select pg_temp.assert_ok(has_schema_privilege('authenticated', 'private', 'usage'), 'authenticated keeps usage on schema private');
select pg_temp.assert_ok(not has_function_privilege('anon', 'private.gmail_alias_lookup(text)', 'execute'), 'anon cannot execute the private lookup');
select pg_temp.assert_ok(not has_function_privilege('anon', 'private.gmail_client_ip(json)', 'execute'), 'anon cannot execute the address helper');

insert into auth.users (email, created_at) values ('janedoe@gmail.com', now() - interval '2 days');

do $$
declare
  v jsonb;
begin
  execute 'set local role anon';
  v := public.gmail_alias_hint('jane.doe@gmail.com');
  begin
    perform private.gmail_alias_lookup('jane.doe@gmail.com');
    raise exception 'anon reached the private lookup';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform count(*) from private.gmail_alias_limits;
    raise exception 'anon read the private limit table';
  exception when insufficient_privilege then
    null;
  end;
  execute 'reset role';
  if v is distinct from jsonb_build_object('match', true, 'hint', 'j…@gmail.com') then
    raise exception 'FAIL: anon wrapper hint, got %', v;
  end if;
end $$;

-- (b) A dotted spelling still warns. The canonical spelling does not reveal an account.
select pg_temp.assert_ok(
  public.gmail_alias_hint('janedoe+notes@gmail.com') = jsonb_build_object('match', true, 'hint', 'j…@gmail.com'),
  'a plus tag on a canonical account still returns the one-character hint');
truncate private.gmail_alias_limits;
select pg_temp.assert_ok(
  public.gmail_alias_hint('janedoe@gmail.com') = jsonb_build_object('match', false),
  'the exact canonical address returns no hint');

-- Replace the canonical account with a dotted one. Probing the canonical form
-- must look like "no account".
delete from auth.users where email = 'janedoe@gmail.com';
insert into auth.users (email, created_at) values ('jane.doe@gmail.com', now() - interval '1 day');
truncate private.gmail_alias_limits;
select pg_temp.assert_ok(
  public.gmail_alias_hint('janedoe@gmail.com') = jsonb_build_object('match', false),
  'typing the canonical address does not reveal a dotted account');
truncate private.gmail_alias_limits;
select pg_temp.assert_ok(
  public.gmail_alias_hint('jane.doe+x@gmail.com') = jsonb_build_object('match', true, 'hint', 'j…@gmail.com'),
  'a tagged spelling of a dotted account still returns the one-character hint');
select pg_temp.assert_ok(
  position('jane.doe@gmail.com' in public.gmail_alias_hint('jane.doe+y@googlemail.com')::text) = 0,
  'the stored address is not in the response');

-- Those two tagged lookups spent the inbox. The third hint is the cap; the fourth is silent.
select pg_temp.assert_ok(
  public.gmail_alias_hint('j.anedoe@gmail.com') = jsonb_build_object('match', true, 'hint', 'j…@gmail.com'),
  'third inbox lookup in the hour still returns a hint');
select pg_temp.assert_ok(
  public.gmail_alias_hint('ja.nedoe@gmail.com') = jsonb_build_object('match', false),
  'fourth inbox lookup in the hour returns no hint');

-- Canonical probes of a dotted account burn the same inbox cap.
delete from auth.users;
insert into auth.users (email, created_at) values ('dotted.only@gmail.com', now() - interval '1 day');
truncate private.gmail_alias_limits;
select public.gmail_alias_hint('dottedonly@gmail.com');
select public.gmail_alias_hint('dottedonly@gmail.com');
select public.gmail_alias_hint('dottedonly@gmail.com');
select pg_temp.assert_ok(
  public.gmail_alias_hint('dotted.only+z@gmail.com') = jsonb_build_object('match', false),
  'canonical probes consume the inbox cap before a later variant can hint');

-- Eight client addresses per hour, counted on the trusted connecting address.
delete from auth.users;
insert into auth.users (email, created_at)
select 'ipuser' || g.n || '@gmail.com', now() - interval '1 day'
from generate_series(1, 9) as g(n);
truncate private.gmail_alias_limits;
select set_config('request.headers', '{"cf-connecting-ip":"192.0.2.10","x-forwarded-for":"203.0.113.9, 198.51.100.20","x-real-ip":"198.51.100.8"}', false);
create temp table ip_results (result jsonb);
insert into ip_results (result)
select public.gmail_alias_hint('ip.user' || g.n || '@gmail.com')
from generate_series(1, 9) as g(n);
select pg_temp.assert_ok((select count(*) = 8 from ip_results where result ->> 'match' = 'true'), 'eight of nine lookups from one connecting address return a hint');
select pg_temp.assert_ok((select count(*) = 1 from ip_results where result ->> 'match' = 'false'), 'the ninth lookup from that address returns no hint');
select pg_temp.assert_ok((select hits = 9 from private.gmail_alias_limits where bucket = 'ip:192.0.2.10'), 'the bucket is the cf-connecting-ip, not the forged forwarding hop');
select pg_temp.assert_ok(not exists (select 1 from private.gmail_alias_limits where bucket like 'ip:203.0.113.9%'), 'the forged first forwarding hop is not a bucket');
select pg_temp.assert_ok(not exists (select 1 from private.gmail_alias_limits where bucket = 'ip:198.51.100.8'), 'x-real-ip is not the client bucket when cf-connecting-ip is present');

-- (c) Address selection, including the path the lookup writes into the cap.
select pg_temp.assert_ok(private.gmail_client_ip('{"cf-connecting-ip":"192.0.2.10","x-forwarded-for":"203.0.113.9, 198.51.100.20"}'::json) = '192.0.2.10', 'cf-connecting-ip wins over forwarding hops');
select pg_temp.assert_ok(private.gmail_client_ip('{"x-forwarded-for":"203.0.113.9, 198.51.100.20"}'::json) = '198.51.100.20', 'without cf-connecting-ip the rightmost hop is used');
select pg_temp.assert_ok(private.gmail_client_ip('{"x-forwarded-for":"203.0.113.9"}'::json) = '203.0.113.9', 'a single forwarding hop is that hop');
select pg_temp.assert_ok(private.gmail_client_ip('{"x-forwarded-for":"203.0.113.9, 198.51.100.7, 192.0.2.44"}'::json) = '192.0.2.44', 'three hops keep only the last');
select pg_temp.assert_ok(private.gmail_client_ip('{"x-forwarded-for":"203.0.113.9, 2001:db8::1"}'::json) = '2001:db8::1', 'an IPv6 rightmost hop is kept');
select pg_temp.assert_ok(private.gmail_client_ip('{"cf-connecting-ip":"not-an-ip","x-forwarded-for":"203.0.113.9, 198.51.100.20"}'::json) = '198.51.100.20', 'a non-address cf-connecting-ip falls through to the rightmost hop');
select pg_temp.assert_ok(private.gmail_client_ip('{"x-real-ip":"198.51.100.8","x-forwarded-for":"203.0.113.9, 192.0.2.10"}'::json) = '192.0.2.10', 'x-real-ip does not override the rightmost hop');
select pg_temp.assert_ok(private.gmail_client_ip('{"x-real-ip":"198.51.100.8"}'::json) is null, 'x-real-ip alone is not a client address');
select pg_temp.assert_ok(private.gmail_client_ip('{}'::json) is null, 'no forwarding header means no client address');

truncate private.gmail_alias_limits;
select set_config('request.headers', '{"x-forwarded-for":"203.0.113.9, 198.51.100.20","x-real-ip":"198.51.100.8"}', false);
select public.gmail_alias_hint('ip.user1@gmail.com');
select pg_temp.assert_ok(
  exists (select 1 from private.gmail_alias_limits where bucket = 'ip:198.51.100.20'),
  'the lookup records the rightmost hop when cf-connecting-ip is absent');
select pg_temp.assert_ok(
  not exists (select 1 from private.gmail_alias_limits where bucket = 'ip:203.0.113.9'),
  'the lookup does not record the first forwarding hop');

-- A different spelling issues an opaque ticket and does not return the stored address.
delete from auth.users;
insert into auth.users (email, created_at) values ('jane.doe@gmail.com', now() - interval '1 day');
truncate private.gmail_alias_limits;
truncate private.gmail_alias_permits;
select set_config('request.headers', '{"cf-connecting-ip":"192.0.2.40"}', false);
select pg_temp.assert_ok(
  public.gmail_alias_prepare('jane.doe@gmail.com') = jsonb_build_object('match', false),
  'prepare stays silent for the exact stored address');
select pg_temp.assert_ok(
  (select count(*) = 0 from private.gmail_alias_permits),
  'a silent prepare does not store an address');
truncate private.gmail_alias_limits;
select pg_temp.assert_ok(
  not (public.gmail_alias_prepare('janedoe@gmail.com') ? 'email')
    and public.gmail_alias_prepare('janedoe@gmail.com') = jsonb_build_object('match', false),
  'prepare does not reveal a dotted account from its canonical spelling');
truncate private.gmail_alias_limits;
truncate private.gmail_alias_permits;
select pg_temp.assert_ok(
  (public.gmail_alias_prepare('jane.doe+notes@gmail.com') ->> 'hint') = 'j…@gmail.com',
  'first different spelling returns the masked hint');
select pg_temp.assert_ok(
  (public.gmail_alias_prepare('jane.doe+tag@gmail.com') ->> 'hint') = 'j…@gmail.com',
  'second different spelling returns the masked hint');
select pg_temp.assert_ok(
  (public.gmail_alias_prepare('j.ane.doe@gmail.com') ->> 'hint') = 'j…@gmail.com',
  'third prepare in the hour still returns the masked hint');
select pg_temp.assert_ok(
  public.gmail_alias_prepare('ja.ne.doe@gmail.com') = jsonb_build_object('match', false),
  'fourth prepare hits the same inbox cap as the hint');

truncate private.gmail_alias_limits;
truncate private.gmail_alias_permits;
create temp table prepare_once as
select public.gmail_alias_prepare('jane.doe+x@gmail.com') as prepared;
select pg_temp.assert_ok(
  (select prepared ->> 'hint' = 'j…@gmail.com' and prepared ? 'ticket' and not (prepared ? 'email') from prepare_once),
  'a different spelling returns a hint and a ticket, not an address');
select pg_temp.assert_ok(
  position('jane.doe@gmail.com' in (select prepared::text from prepare_once)) = 0,
  'the stored address is not in the prepare response');
select pg_temp.assert_ok(
  public.gmail_alias_take_send((select (prepared ->> 'ticket')::uuid from prepare_once)) = 'jane.doe@gmail.com',
  'the service-role claim returns the stored address once');
select pg_temp.assert_ok(
  public.gmail_alias_take_send((select (prepared ->> 'ticket')::uuid from prepare_once)) is null,
  'a send ticket cannot be claimed twice');

select pg_temp.assert_ok(
  not has_function_privilege('anon', 'public.gmail_alias_take_send(uuid)', 'execute'),
  'anon cannot claim a send ticket');
select pg_temp.assert_ok(
  not has_function_privilege('authenticated', 'public.gmail_alias_take_send(uuid)', 'execute'),
  'authenticated cannot claim a send ticket');
select pg_temp.assert_ok(
  has_function_privilege('service_role', 'public.gmail_alias_take_send(uuid)', 'execute'),
  'service role can claim a send ticket');
select pg_temp.assert_ok(
  not has_function_privilege('anon', 'private.gmail_alias_decide(text, boolean)', 'execute'),
  'anon cannot execute the private decide function');
select pg_temp.assert_ok(
  not has_table_privilege('anon', 'private.gmail_alias_permits', 'select'),
  'anon cannot read alias permits');
select pg_temp.assert_ok(
  has_function_privilege('anon', 'public.gmail_alias_prepare(text)', 'execute'),
  'anon can prepare a sign-in');

do $$
declare
  v_ticket uuid := public.gmail_alias_keep_verify('jane.doe@gmail.com');
begin
  if public.gmail_alias_read_verify(v_ticket) is distinct from 'jane.doe@gmail.com' then
    raise exception 'FAIL: verify ticket did not resolve to the stored address';
  end if;
  perform public.gmail_alias_consume_verify(v_ticket);
  if public.gmail_alias_read_verify(v_ticket) is not null then
    raise exception 'FAIL: verify ticket survived consume';
  end if;
  execute 'set local role anon';
  begin
    perform public.gmail_alias_read_verify(v_ticket);
    raise exception 'anon read a verify ticket';
  exception when insufficient_privilege then
    null;
  end;
  execute 'reset role';
end $$;

-- Exact address wins when another spelling of the same inbox already has an account.
delete from auth.users;
insert into auth.users (email, created_at) values
  ('jane.doe@gmail.com', now() - interval '2 days'),
  ('jane.doe+notes@gmail.com', now() - interval '1 day');
truncate private.gmail_alias_limits;
truncate private.gmail_alias_permits;
select set_config('request.headers', '{"cf-connecting-ip":"192.0.2.41"}', false);
select pg_temp.assert_ok(
  public.gmail_alias_prepare('jane.doe+notes@gmail.com') = jsonb_build_object('match', false),
  'prepare stays silent for an exact address even when an older alias account exists');
select pg_temp.assert_ok(
  public.gmail_alias_prepare('jane.doe@gmail.com') = jsonb_build_object('match', false),
  'prepare stays silent for the older exact address when a tagged account also exists');
select pg_temp.assert_ok(
  (select count(*) = 0 from private.gmail_alias_permits),
  'an exact address does not store the other account');
select pg_temp.assert_ok(
  public.gmail_alias_hint('jane.doe+notes@gmail.com') = jsonb_build_object('match', false),
  'the hint stays silent for an exact address when another alias exists');
truncate private.gmail_alias_limits;
truncate private.gmail_alias_permits;
create temp table prepare_third as
select public.gmail_alias_prepare('j.ane.doe@gmail.com') as prepared;
select pg_temp.assert_ok(
  (select prepared ->> 'hint' = 'j…@gmail.com' and prepared ? 'ticket' and not (prepared ? 'email') from prepare_third),
  'a third spelling still matches an existing account');
select pg_temp.assert_ok(
  public.gmail_alias_take_send((select (prepared ->> 'ticket')::uuid from prepare_third)) = 'jane.doe@gmail.com',
  'a third spelling is sent to the oldest account, not the tagged one');

-- (h) A verify ticket burns after five wrong codes (20261014122000_gmail_otp_failures.sql).
truncate private.gmail_alias_permits;
create temp table verify_ticket as select public.gmail_alias_keep_verify('jane.doe@gmail.com') as t;
select pg_temp.assert_ok((select public.gmail_alias_read_verify(t) = 'jane.doe@gmail.com' from verify_ticket), 'a fresh verify ticket reads back');
select pg_temp.assert_ok((select public.gmail_alias_fail_verify(t) = 4 from verify_ticket), 'first miss: four attempts left');
select pg_temp.assert_ok((select public.gmail_alias_fail_verify(t) = 3 from verify_ticket), 'second miss: three left');
select pg_temp.assert_ok((select public.gmail_alias_fail_verify(t) = 2 from verify_ticket), 'third miss: two left');
select pg_temp.assert_ok((select public.gmail_alias_fail_verify(t) = 1 from verify_ticket), 'fourth miss: one left');
select pg_temp.assert_ok((select public.gmail_alias_read_verify(t) = 'jane.doe@gmail.com' from verify_ticket), 'the ticket still reads back before the fifth miss');
select pg_temp.assert_ok((select public.gmail_alias_fail_verify(t) = 0 from verify_ticket), 'fifth miss burns the ticket');
select pg_temp.assert_ok((select public.gmail_alias_read_verify(t) is null from verify_ticket), 'a burned ticket no longer reads back');
select pg_temp.assert_ok((select count(*) = 0 from private.gmail_alias_permits), 'the burned ticket row is gone');
select pg_temp.assert_ok((select public.gmail_alias_fail_verify(t) = 0 from verify_ticket), 'a burned or unknown ticket reports zero, not an error');
select pg_temp.assert_ok(public.gmail_alias_fail_verify(gen_random_uuid()) = 0, 'an unknown ticket reports zero');
-- An expired ticket cannot be failed into existence either, and a send ticket is not a verify ticket.
insert into private.gmail_alias_permits (email, kind, expires_at) values ('jane.doe@gmail.com', 'send', now() + interval '2 minutes');
select pg_temp.assert_ok((select public.gmail_alias_fail_verify(ticket) = 0 from private.gmail_alias_permits), 'a send ticket has no verify counter');
select pg_temp.assert_ok((select failures = 0 from private.gmail_alias_permits), 'and is left untouched');
select pg_temp.assert_ok(not has_function_privilege('anon', 'public.gmail_alias_fail_verify(uuid)', 'execute'), 'anon cannot burn tickets');
select pg_temp.assert_ok(not has_function_privilege('authenticated', 'public.gmail_alias_fail_verify(uuid)', 'execute'), 'authenticated cannot burn tickets');
select pg_temp.assert_ok(has_function_privilege('service_role', 'public.gmail_alias_fail_verify(uuid)', 'execute'), 'the edge function (service role) can');
select pg_temp.assert_ok(not has_function_privilege('service_role', 'private.gmail_alias_fail_verify(uuid)', 'execute'), 'the private body is reachable only through the wrapper');

-- Leave a clean slate for the concurrency test that follows.
delete from auth.users;
truncate private.gmail_alias_limits;
truncate private.gmail_alias_permits;
select set_config('request.headers', '', false);
