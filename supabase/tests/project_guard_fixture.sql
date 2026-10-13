-- Disposable stand-in for the shared PaperTrellis tables, with the project_teams
-- policies found on 2026-10-13. The hardening migration is applied AFTER this
-- file and must replace those policies. Never run against a linked project.
-- Requires supabase/tests/spending_fixture.sql first (roles, auth.uid).

insert into auth.users (id) values
  ('a1000000-0000-0000-0000-000000000001'),
  ('a1000000-0000-0000-0000-000000000002'),
  ('a1000000-0000-0000-0000-000000000003'),
  ('a1000000-0000-0000-0000-000000000004'),
  ('a1000000-0000-0000-0000-000000000005'),
  ('a1000000-0000-0000-0000-000000000006'),
  ('a1000000-0000-0000-0000-000000000007'),
  ('a1000000-0000-0000-0000-000000000008');

do $$ begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum ('admin', 'pi', 'trainee', 'viewer');
  end if;
  if not exists (select 1 from pg_type where typname = 'team_role') then
    create type public.team_role as enum ('admin', 'pi', 'trainee', 'viewer');
  end if;
end $$;

create table public.profiles (
  id uuid primary key references auth.users (id),
  role public.user_role not null default 'trainee'
);
create table public.projects (
  id uuid primary key,
  title text not null,
  lead_user_id uuid not null references auth.users (id),
  is_public boolean not null default false,
  deleted_at timestamptz,
  lead_name_override text
);
create table public.project_collaborators (
  project_id uuid not null references public.projects (id),
  user_id uuid not null references auth.users (id),
  primary key (project_id, user_id)
);
create table public.teams (
  id uuid primary key,
  name text not null,
  created_by uuid not null references auth.users (id)
);
create table public.team_members (
  team_id uuid not null references public.teams (id),
  user_id uuid not null references auth.users (id),
  role public.team_role not null default 'trainee',
  primary key (team_id, user_id)
);
create table public.project_teams (
  project_id uuid not null references public.projects (id),
  team_id uuid not null references public.teams (id),
  added_at timestamptz not null default now(),
  primary key (project_id, team_id)
);

insert into public.profiles (id, role) values
  ('a1000000-0000-0000-0000-000000000001', 'pi'),
  ('a1000000-0000-0000-0000-000000000002', 'pi'),
  ('a1000000-0000-0000-0000-000000000003', 'trainee'),
  ('a1000000-0000-0000-0000-000000000004', 'trainee'),
  ('a1000000-0000-0000-0000-000000000005', 'admin'),
  ('a1000000-0000-0000-0000-000000000006', 'trainee'),
  ('a1000000-0000-0000-0000-000000000007', 'pi'),
  ('a1000000-0000-0000-0000-000000000008', 'pi');

insert into public.projects (id, title, lead_user_id, lead_name_override) values
  ('b1000000-0000-0000-0000-000000000001', 'Led by team PI', 'a1000000-0000-0000-0000-000000000001', null),
  ('b1000000-0000-0000-0000-000000000002', 'Led by trainee', 'a1000000-0000-0000-0000-000000000003', null),
  ('b1000000-0000-0000-0000-000000000003', 'Led by team admin', 'a1000000-0000-0000-0000-000000000006', null),
  ('b1000000-0000-0000-0000-000000000004', 'Led by global PI', 'a1000000-0000-0000-0000-000000000007', null),
  ('b1000000-0000-0000-0000-000000000005', 'Placeholder', 'a1000000-0000-0000-0000-000000000008', 'Placeholder PI');

insert into public.project_collaborators (project_id, user_id) values
  ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000004'),
  ('b1000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000002');

insert into public.teams (id, name, created_by) values
  ('c1000000-0000-0000-0000-000000000001', 'Lab', 'a1000000-0000-0000-0000-000000000001'),
  ('c1000000-0000-0000-0000-000000000002', 'Other lab', 'a1000000-0000-0000-0000-000000000006'),
  ('c1000000-0000-0000-0000-000000000003', 'Second lab', 'a1000000-0000-0000-0000-000000000001');

insert into public.team_members (team_id, user_id, role) values
  ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'pi'),
  ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', 'pi'),
  ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'trainee'),
  ('c1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000003', 'trainee'),
  ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000004', 'trainee'),
  ('c1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000006', 'admin'),
  ('c1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000007', 'trainee'),
  ('c1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000001', 'pi');

insert into public.project_teams (project_id, team_id) values
  ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001'),
  ('b1000000-0000-0000-0000-000000000005', 'c1000000-0000-0000-0000-000000000001');

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;
create or replace function public.get_user_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = (select auth.uid());
$$;
create or replace function public.is_project_lead(p_project_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.projects
    where id = p_project_id and lead_user_id = (select auth.uid())
  );
$$;
create or replace function public.is_team_admin_or_pi(p_team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id
      and user_id = (select auth.uid())
      and role in ('admin', 'pi')
  );
$$;
create or replace function public.is_team_member(p_team_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id and user_id = (select auth.uid())
  );
$$;

-- Production claim path: a team member takes a placeholder lead. The column
-- guard must allow this security-definer update.
create or replace function public.claim_project(p_project_id uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  if not exists (
    select 1 from public.projects
    where id = p_project_id
      and lead_name_override is not null
      and deleted_at is null
  ) then
    raise exception 'Project does not have a placeholder lead';
  end if;
  if not public.is_admin() and not exists (
    select 1 from public.project_teams pt
    join public.team_members tm on tm.team_id = pt.team_id
    where pt.project_id = p_project_id
      and tm.user_id = (select auth.uid())
  ) then
    raise exception 'You must be a team member to claim this project';
  end if;
  update public.projects
     set lead_user_id = (select auth.uid()),
         lead_name_override = null
   where id = p_project_id;
end;
$$;
revoke all on function public.claim_project(uuid) from public, anon;
grant execute on function public.claim_project(uuid) to authenticated;

alter table public.projects enable row level security;
alter table public.project_teams enable row level security;
alter table public.project_collaborators enable row level security;

-- The projects update policy reads this table as the caller, so the caller
-- must be able to see their own collaborator row.
create policy collab_select_scoped on public.project_collaborators
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- The open writes the migration has to close.
create policy project_teams_insert on public.project_teams
  for insert to authenticated
  with check (
    public.is_admin()
    or public.get_user_role() = 'pi'::public.user_role
    or public.is_project_lead(project_id)
  );
create policy project_teams_delete on public.project_teams
  for delete to authenticated
  using (
    public.is_admin()
    or public.get_user_role() = 'pi'::public.user_role
    or public.is_project_lead(project_id)
  );
create policy project_teams_select_scoped on public.project_teams
  for select to authenticated
  using (public.is_team_member(team_id) or public.is_admin());

create policy projects_select_team on public.projects
  for select to authenticated
  using (
    public.is_admin()
    or lead_user_id = (select auth.uid())
    or exists (
      select 1 from public.project_collaborators c
      where c.project_id = projects.id and c.user_id = (select auth.uid())
    )
    or exists (
      select 1 from public.project_teams pt
      join public.team_members tm on tm.team_id = pt.team_id
      where pt.project_id = projects.id and tm.user_id = (select auth.uid())
    )
  );
create policy projects_update on public.projects
  for update to authenticated
  using (
    public.is_admin()
    or lead_user_id = (select auth.uid())
    or exists (
      select 1 from public.project_collaborators c
      where c.project_id = projects.id and c.user_id = (select auth.uid())
    )
  )
  with check (
    public.is_admin()
    or lead_user_id = (select auth.uid())
    or exists (
      select 1 from public.project_collaborators c
      where c.project_id = projects.id and c.user_id = (select auth.uid())
    )
  );
