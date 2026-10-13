-- Disposable stand-in for the shared PaperTrellis tables, with the policies the
-- 2026-10-13 audit found. The hardening migration is applied AFTER this file and
-- must replace the open write policies. Never run against a linked project.
-- Requires supabase/tests/spending_fixture.sql and the events migration first.

insert into auth.users (id) values
  ('a0000000-0000-0000-0000-00000000000a'),
  ('a0000000-0000-0000-0000-00000000000b'),
  ('a0000000-0000-0000-0000-00000000000c'),
  ('a0000000-0000-0000-0000-00000000000d'),
  ('a0000000-0000-0000-0000-00000000000e')
on conflict do nothing;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'pi', 'trainee', 'viewer');
  end if;
  if not exists (select 1 from pg_type where typname = 'activity_action') then
    create type public.activity_action as enum (
      'created', 'stage_change', 'edited', 'visibility_changed',
      'abstract_status_changed', 'comment_added', 'task_created', 'task_completed', 'deadline_set'
    );
  end if;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id),
  role public.user_role not null default 'trainee'
);
create table if not exists public.projects (
  id uuid primary key,
  lead_user_id uuid references auth.users(id),
  deleted_at timestamptz,
  is_public boolean not null default false
);
create table if not exists public.project_collaborators (
  project_id uuid references public.projects(id),
  user_id uuid references auth.users(id),
  primary key (project_id, user_id)
);
create table if not exists public.teams (
  id uuid primary key,
  name text not null
);
create table if not exists public.team_members (
  team_id uuid references public.teams(id),
  user_id uuid references auth.users(id),
  primary key (team_id, user_id)
);
create table if not exists public.project_teams (
  project_id uuid references public.projects(id),
  team_id uuid references public.teams(id),
  primary key (project_id, team_id)
);
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  type text not null,
  project_id uuid references public.projects(id),
  actor_id uuid references auth.users(id),
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  user_id uuid not null references auth.users(id),
  action public.activity_action not null,
  created_at timestamptz not null default now()
);
create table if not exists public.project_comments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  user_id uuid not null references auth.users(id),
  body text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  description text not null,
  assigned_to uuid not null references auth.users(id),
  created_by uuid not null references auth.users(id),
  completed boolean not null default false
);
create table if not exists public.project_manuscripts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  content text not null default '',
  uploaded_by uuid references auth.users(id)
);
create table if not exists public.project_bot_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id),
  created_by uuid not null references auth.users(id),
  kind text not null,
  payload jsonb not null,
  status text not null default 'pending',
  reviewed_by uuid references auth.users(id),
  review_note text
);

insert into public.profiles (id, role) values
  ('a0000000-0000-0000-0000-00000000000a', 'pi'),
  ('a0000000-0000-0000-0000-00000000000b', 'trainee'),
  ('a0000000-0000-0000-0000-00000000000c', 'trainee'),
  ('a0000000-0000-0000-0000-00000000000d', 'trainee'),
  ('a0000000-0000-0000-0000-00000000000e', 'admin');
insert into public.projects (id, lead_user_id) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a');
insert into public.project_collaborators (project_id, user_id) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b');
insert into public.teams (id, name) values ('c0000000-0000-0000-0000-000000000001', 'lab');
insert into public.team_members (team_id, user_id) values
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a'),
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b'),
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000c');
insert into public.project_teams (project_id, team_id) values
  ('b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001');

-- One recent attempt (must be copied) and one expired attempt (must not).
insert into public.events (user_id, type, ts) values
  ('a0000000-0000-0000-0000-00000000000a', 'invite_attempt', now()),
  ('a0000000-0000-0000-0000-00000000000a', 'invite_attempt', now() - interval '2 hours');

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;
create or replace function public.is_project_lead(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.projects where id = p_project_id and lead_user_id = (select auth.uid()));
$$;
create or replace function public.is_project_member(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.projects where id = p_project_id and lead_user_id = (select auth.uid())
    union
    select 1 from public.project_collaborators where project_id = p_project_id and user_id = (select auth.uid())
  );
$$;
create or replace function public.can_see_project(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_teams pt
    join public.team_members tm on tm.team_id = pt.team_id
    where pt.project_id = p_project_id and tm.user_id = (select auth.uid())
  );
$$;

alter table public.notifications enable row level security;
alter table public.activity_log enable row level security;
alter table public.project_comments enable row level security;
alter table public.project_tasks enable row level security;
alter table public.project_manuscripts enable row level security;
alter table public.project_bot_proposals enable row level security;

-- The open writes the migration has to close.
create policy notifications_insert on public.notifications for insert to authenticated with check (true);
create policy notifications_select on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid());

create policy activity_log_insert on public.activity_log for insert to authenticated with check (true);
create policy activity_log_select_member on public.activity_log for select to authenticated using (is_project_member(project_id));
create policy activity_log_select_admin on public.activity_log for select to authenticated using (is_admin());

create policy comments_insert on public.project_comments for insert to authenticated with check (is_admin() or is_project_member(project_id));
create policy project_comments_insert on public.project_comments for insert to authenticated with check (can_see_project(project_id) or is_admin());
create policy comments_select on public.project_comments for select to authenticated using (is_admin() or is_project_member(project_id));
create policy project_comments_select on public.project_comments for select to authenticated using (can_see_project(project_id) or is_admin());
create policy comments_update on public.project_comments for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy project_comments_update on public.project_comments for update to authenticated using ((user_id = auth.uid()) or is_admin());

create policy tasks_insert on public.project_tasks for insert to authenticated with check (is_admin() or is_project_lead(project_id) or is_project_member(project_id));
create policy project_tasks_insert on public.project_tasks for insert to authenticated with check (can_see_project(project_id) or is_admin());
create policy tasks_select on public.project_tasks for select to authenticated using (is_admin() or is_project_member(project_id));
create policy project_tasks_select on public.project_tasks for select to authenticated using (can_see_project(project_id) or is_admin());
create policy tasks_update on public.project_tasks for update to authenticated
  using (is_admin() or is_project_lead(project_id) or created_by = auth.uid() or assigned_to = auth.uid())
  with check (is_admin() or is_project_lead(project_id) or created_by = auth.uid() or assigned_to = auth.uid());
create policy project_tasks_update on public.project_tasks for update to authenticated
  using (can_see_project(project_id) or is_admin())
  with check (can_see_project(project_id) or is_admin());

create policy project_manuscripts_insert on public.project_manuscripts for insert to authenticated
  with check (can_see_project(project_id) or is_project_member(project_id) or is_admin());
create policy project_manuscripts_select on public.project_manuscripts for select to authenticated
  using (can_see_project(project_id) or is_project_member(project_id) or is_admin());
create policy project_manuscripts_update on public.project_manuscripts for update to authenticated
  using (can_see_project(project_id) or is_project_member(project_id) or is_admin())
  with check (can_see_project(project_id) or is_project_member(project_id) or is_admin());

create policy bot_proposals_insert on public.project_bot_proposals for insert to authenticated
  with check (created_by = (select auth.uid()) and (can_see_project(project_id) or is_project_member(project_id) or is_admin()));
create policy bot_proposals_select on public.project_bot_proposals for select to authenticated
  using (can_see_project(project_id) or is_project_member(project_id) or is_admin());
create policy bot_proposals_update on public.project_bot_proposals for update to authenticated
  using (can_see_project(project_id) or is_project_member(project_id) or is_admin())
  with check (reviewed_by = (select auth.uid()));
