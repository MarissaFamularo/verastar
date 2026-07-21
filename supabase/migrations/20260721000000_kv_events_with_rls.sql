-- Verastar backend schema — the whole of it.
--
-- One generic `kv` table mirrors the app's store.js interface (collections of
-- keyed JSON values) so the cloud impl is a drop-in behind the same five methods;
-- `events` is the append-only telemetry / learning-loop table. Row-level security
-- scoped to auth.uid() is the security boundary — the client ships only the
-- publishable anon key. To run your own instance: create a free Supabase project,
-- apply this file (SQL editor or `supabase db push`), and set VITE_SUPABASE_URL +
-- VITE_SUPABASE_ANON_KEY (see .env.example).

-- one generic table mirrors store.js exactly → the swap is a drop-in
create table kv (
  user_id    uuid not null references auth.users(id) on delete cascade,
  collection text not null,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, collection, key)
);

-- telemetry / learning loop / study instrument (append-only)
create table events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  ts         timestamptz not null default now(),
  type       text not null,
  payload    jsonb not null default '{}'
);

alter table kv enable row level security;
alter table events enable row level security;

create policy "kv_select_own" on kv for select to authenticated using (user_id = (select auth.uid()));
create policy "kv_insert_own" on kv for insert to authenticated with check (user_id = (select auth.uid()));
create policy "kv_update_own" on kv for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "kv_delete_own" on kv for delete to authenticated using (user_id = (select auth.uid()));

create policy "events_select_own" on events for select to authenticated using (user_id = (select auth.uid()));
create policy "events_insert_own" on events for insert to authenticated with check (user_id = (select auth.uid()));
create policy "events_update_own" on events for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "events_delete_own" on events for delete to authenticated using (user_id = (select auth.uid()));
