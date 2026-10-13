-- M1: invite redemption attempts are a rate limit, not telemetry.
--
-- `events` is client-writable. Authenticated users could delete (and update) their own
-- rows, including type = 'invite_attempt', which reset the five-attempts-per-hour check
-- in redeem-invite. Counting those attempts in `events` is retired.
--
-- `invite_attempts` has no client policies and no client grants. The redeem-invite
-- function (service role) is the writer. Rows are not deleted when a user rewrites
-- `events`. Historical attempts from the last hour are copied once so a deploy does
-- not hand everyone a fresh budget.
--
-- Update and delete are also removed from `events`. The client only inserts and reads
-- its own telemetry; an update of type or ts was the same reset for any counter still
-- stored there (including npi_attempt). PROPOSED; not applied to any linked project.

create table if not exists public.invite_attempts (
  id      bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ts      timestamptz not null default now()
);

create index if not exists invite_attempts_user_ts_idx
  on public.invite_attempts (user_id, ts desc);

alter table public.invite_attempts enable row level security;
alter table public.invite_attempts force row level security;

revoke all on table public.invite_attempts from public, anon, authenticated, service_role;
grant select, insert on table public.invite_attempts to service_role;

do $$
declare seq text := pg_get_serial_sequence('public.invite_attempts', 'id');
begin
  if seq is not null then
    execute format('revoke all on sequence %s from public, anon, authenticated', seq);
    execute format('grant usage, select on sequence %s to service_role', seq);
  end if;
end $$;

insert into public.invite_attempts (user_id, ts)
select e.user_id, e.ts
  from public.events e
 where e.type = 'invite_attempt'
   and e.ts > now() - interval '1 hour'
   and not exists (
     select 1 from public.invite_attempts a
      where a.user_id = e.user_id and a.ts = e.ts
   );

drop policy if exists "events_delete_own" on public.events;
drop policy if exists "events_update_own" on public.events;

revoke update, delete, truncate on table public.events from public, anon, authenticated;
