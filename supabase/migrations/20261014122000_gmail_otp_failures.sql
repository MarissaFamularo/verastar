-- Gmail alias verify tickets burn after five wrong codes. PROPOSED; applied only to
-- disposable local databases until the authorized release.
--
-- A verify ticket (private.gmail_alias_permits, kind 'verify') lived for 15 minutes and
-- answered any number of code checks in that window: the gmail-canonical-otp function
-- would relay every guess to auth.verifyOtp for the stored address (beta audit 2026-10-14,
-- docs/BETA_TEST_PLAN.md § H). Supabase Auth has its own OTP limits, but the ticket is the
-- thing the caller holds, so it carries the counter.
--
-- gmail_alias_fail_verify(ticket) is called by the edge function after a code was refused.
-- It increments the ticket's failures and deletes the ticket at the fifth failure, returning
-- the attempts that remain (0 = burned). A burned or unknown ticket returns null from
-- gmail_alias_read_verify as before, so the next check is refused before any Auth call.
-- Same shape as the other ticket functions: the private body is executable by nobody, the
-- public wrapper is service-role only. Rollback: drop both functions; the column may stay.
begin;

alter table private.gmail_alias_permits
  add column if not exists failures integer not null default 0;

create or replace function private.gmail_alias_fail_verify(p_ticket uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_failures constant integer := 5;
  v_failures integer;
begin
  update private.gmail_alias_permits
     set failures = failures + 1
   where ticket = p_ticket
     and kind = 'verify'
     and expires_at > pg_catalog.now()
  returning failures into v_failures;
  if v_failures is null then
    return 0;
  end if;
  if v_failures >= c_max_failures then
    delete from private.gmail_alias_permits where ticket = p_ticket;
    return 0;
  end if;
  return c_max_failures - v_failures;
end;
$$;

revoke all on function private.gmail_alias_fail_verify(uuid) from public, anon, authenticated, service_role;

create or replace function public.gmail_alias_fail_verify(p_ticket uuid)
returns integer
language sql
security definer
set search_path = ''
as $$
  select private.gmail_alias_fail_verify(p_ticket);
$$;

revoke all on function public.gmail_alias_fail_verify(uuid) from public, anon, authenticated;
grant execute on function public.gmail_alias_fail_verify(uuid) to service_role;

commit;
