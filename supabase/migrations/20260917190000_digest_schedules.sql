-- Scheduled morning digests for sponsored accounts.
-- Spec: docs/SPONSORED_ACCESS_SPEC.md § Scheduled runs. The `digest-run` edge function is
-- invoked by pg_cron (see docs/SPONSORED_ACCESS_DEPLOY.md) and picks one due account per
-- tick. A user edits only their own row; claim and result columns are server-owned.
begin;

create table if not exists public.digest_schedules (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  enabled       boolean not null default true,
  hour_local    integer not null default 6 check (hour_local between 0 and 23),
  timezone      text not null default 'America/New_York',
  -- Server-owned. `claimed_at` is set when a tick takes the row; `last_run_at` when a
  -- run completes for a local day; `last_result` is a short status for the ops query.
  claimed_at    timestamptz,
  last_run_at   timestamptz,
  last_result   text,
  updated_at    timestamptz not null default now()
);
alter table public.digest_schedules enable row level security;
revoke all on public.digest_schedules from public, anon, authenticated;
grant select (user_id, enabled, hour_local, timezone, last_run_at, last_result) on public.digest_schedules to authenticated;
grant insert (user_id, enabled, hour_local, timezone) on public.digest_schedules to authenticated;
-- user_id is included because a client upsert's ON CONFLICT DO UPDATE sets every sent
-- column; the own-row policy still forbids changing it to another account's id.
grant update (user_id, enabled, hour_local, timezone) on public.digest_schedules to authenticated;
create policy "digest_schedules_select_own" on public.digest_schedules
  for select to authenticated using (user_id = (select auth.uid()));
create policy "digest_schedules_insert_own" on public.digest_schedules
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "digest_schedules_update_own" on public.digest_schedules
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

commit;
