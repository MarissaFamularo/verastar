-- Proves M1 (invite-attempt ledger) against a disposable database. The migration has
-- already been applied twice. This transaction rolls back.
\set ON_ERROR_STOP on
begin;

-- Backfill kept the recent attempt and not the two-hour-old one, once.
do $$ begin
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL: invite attempt backfill';
  end if;
  if exists (
    select 1 from public.invite_attempts
     where user_id = 'a0000000-0000-0000-0000-00000000000a'
       and ts < now() - interval '90 minutes'
  ) then
    raise exception 'FAIL: expired attempt was copied';
  end if;
end $$;

-- M1. Restoring the old delete policy still cannot drain the rate-limit ledger.
savepoint old_events_delete;
create policy "events_delete_own" on public.events for delete to authenticated
  using (user_id = (select auth.uid()));
grant delete on public.events to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
delete from public.events where user_id = 'a0000000-0000-0000-0000-00000000000a' and type = 'invite_attempt';
reset role;
do $$ begin
  if exists (
    select 1 from public.events
     where user_id = 'a0000000-0000-0000-0000-00000000000a' and type = 'invite_attempt'
  ) then
    raise exception 'FAIL: old delete policy did not remove events';
  end if;
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL: deleting events reset invite_attempts';
  end if;
end $$;
rollback to savepoint old_events_delete;

-- Client delete/update of events is denied, and re-granting does not reveal rows.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
do $$ begin
  begin
    delete from public.events where user_id = 'a0000000-0000-0000-0000-00000000000a';
    raise exception 'FAIL: events delete granted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.events set type = 'rewritten' where user_id = 'a0000000-0000-0000-0000-00000000000a';
    raise exception 'FAIL: events update granted';
  exception when insufficient_privilege then null;
  end;
end $$;
insert into public.events (user_id, type) values ('a0000000-0000-0000-0000-00000000000a', 'badge_reported');
do $$ begin
  if (select count(*) from public.events where type = 'badge_reported') <> 1 then
    raise exception 'FAIL: own telemetry insert/select';
  end if;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
do $$ begin
  if (select count(*) from public.events where type = 'badge_reported') <> 0 then
    raise exception 'FAIL: cross-account event read';
  end if;
end $$;
reset role;
grant delete, update on public.events to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
delete from public.events where user_id = 'a0000000-0000-0000-0000-00000000000a';
update public.events set type = 'rewritten' where user_id = 'a0000000-0000-0000-0000-00000000000a';
reset role;
do $$ begin
  if (select count(*) from public.events where user_id = 'a0000000-0000-0000-0000-00000000000a' and type = 'badge_reported') <> 1 then
    raise exception 'FAIL: re-granted events delete or update changed a row';
  end if;
end $$;

grant select, insert, delete on public.invite_attempts to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
delete from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    insert into public.invite_attempts (user_id) values ('a0000000-0000-0000-0000-00000000000a');
    raise exception 'FAIL: client inserted an invite attempt';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$ begin
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL: client delete changed invite_attempts';
  end if;
end $$;
set local role service_role;
insert into public.invite_attempts (user_id) values ('a0000000-0000-0000-0000-00000000000a');
reset role;
do $$ begin
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a') <> 2 then
    raise exception 'FAIL: service role could not record an attempt';
  end if;
end $$;

-- The admission function is service-only. Five calls in the hour are allowed; the
-- rest are denied and not stored. An old attempt no longer counts, and another user
-- does not share the budget.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
do $$ begin
  begin
    perform public.record_invite_attempt('a0000000-0000-0000-0000-00000000000b');
    raise exception 'FAIL: client recorded an invite attempt';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role service_role;
do $$
declare
  i int;
  decision text;
  allows int := 0;
begin
  for i in 1..8 loop
    decision := public.record_invite_attempt('a0000000-0000-0000-0000-00000000000b');
    if decision = 'allow' then
      allows := allows + 1;
    elsif decision is distinct from 'deny' then
      raise exception 'FAIL: invite decision %', decision;
    end if;
  end loop;
  if allows <> 5 then
    raise exception 'FAIL: sequential invite limit admitted %', allows;
  end if;
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000b') <> 5 then
    raise exception 'FAIL: denied invite attempt was stored';
  end if;
  if public.record_invite_attempt('a0000000-0000-0000-0000-00000000000d') is distinct from 'allow' then
    raise exception 'FAIL: another user shared the invite budget';
  end if;
end $$;
reset role;
update public.invite_attempts
   set ts = now() - interval '2 hours'
 where user_id = 'a0000000-0000-0000-0000-00000000000b';
set local role service_role;
do $$ begin
  if public.record_invite_attempt('a0000000-0000-0000-0000-00000000000b') is distinct from 'allow' then
    raise exception 'FAIL: attempts outside the hour still counted';
  end if;
end $$;
reset role;

rollback;
