-- Proves the H1/H2 migration closed the project_teams and projects holes and
-- left the legitimate paths working. Disposable database only.
\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.ok(v boolean, label text) returns void
language plpgsql as $$
begin
  if not coalesce(v, false) then
    raise exception 'FAIL: %', label;
  end if;
end $$;

-- H1 shape: one insert policy and one delete policy, both requiring the team
-- side and the project side. The old get_user_role() = 'pi' OR is gone.
-- The select policy is untouched.
select pg_temp.ok(
  (select count(*) = 1 from pg_policy
    where polrelid = 'public.project_teams'::regclass and polcmd = 'a')
  and (select count(*) = 1 from pg_policy
    where polrelid = 'public.project_teams'::regclass and polcmd = 'd')
  and (select count(*) = 1 from pg_policy
    where polrelid = 'public.project_teams'::regclass and polname = 'project_teams_select_scoped'),
  'one insert policy, one delete policy, select policy kept');

select pg_temp.ok(
  (select pg_get_expr(polwithcheck, polrelid) like '%is_team_admin_or_pi%'
       and pg_get_expr(polwithcheck, polrelid) like '%is_project_lead%'
       and pg_get_expr(polwithcheck, polrelid) not like '%get_user_role%'
   from pg_policy
   where polrelid = 'public.project_teams'::regclass and polname = 'project_teams_insert')
  and (select pg_get_expr(polqual, polrelid) like '%is_team_admin_or_pi%'
          and pg_get_expr(polqual, polrelid) like '%is_project_lead%'
          and pg_get_expr(polqual, polrelid) not like '%get_user_role%'
   from pg_policy
   where polrelid = 'public.project_teams'::regclass and polname = 'project_teams_delete'),
  'link policies require team admin or PI and project lead');

select pg_temp.ok(
  (select count(*) = 1 from pg_trigger
    where tgname = 'projects_guard_sensitive_columns' and not tgisinternal)
  and (select pg_get_triggerdef(oid) like 'CREATE TRIGGER projects_guard_sensitive_columns BEFORE UPDATE%'
       from pg_trigger where tgname = 'projects_guard_sensitive_columns' and not tgisinternal)
  and (select not prosecdef from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'guard_project_sensitive_columns'),
  'sensitive columns have one invoker before-update trigger');

select pg_temp.ok(
  (select pg_get_expr(polqual, polrelid) like '%project_collaborators%'
   from pg_policy where polrelid = 'public.projects'::regclass and polname = 'projects_update'),
  'collaborators can still update a project row');

-- Preconditions the old policy trusted.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
select pg_temp.ok(public.get_user_role() = 'pi' and public.is_team_admin_or_pi('c1000000-0000-0000-0000-000000000001') and not public.is_project_lead('b1000000-0000-0000-0000-000000000002'), 'other PI is a team PI and not the project lead');
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000007', true);
select pg_temp.ok(public.get_user_role() = 'pi' and not public.is_team_admin_or_pi('c1000000-0000-0000-0000-000000000002') and public.is_project_lead('b1000000-0000-0000-0000-000000000004'), 'global PI is only a trainee on the target team');
reset role;

-- H1 inserts.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
do $$ begin
  insert into public.project_teams (project_id, team_id)
  values ('b1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000001');
  raise exception 'FAIL: team PI linked a project they do not lead';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000003', true);
do $$ begin
  insert into public.project_teams (project_id, team_id)
  values ('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000003');
  raise exception 'FAIL: project lead who is only a trainee linked the team';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000007', true);
do $$ begin
  insert into public.project_teams (project_id, team_id)
  values ('b1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000002');
  raise exception 'FAIL: global PI linked a team they do not administer';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000006', true);
do $$ begin
  insert into public.project_teams (project_id, team_id)
  values ('b1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000001');
  raise exception 'FAIL: team admin linked a team they do not administer';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000004', true);
do $$ begin
  insert into public.project_teams (project_id, team_id)
  values ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000003');
  raise exception 'FAIL: collaborator linked a team';
exception when insufficient_privilege then null;
end $$;

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);
insert into public.project_teams (project_id, team_id)
values ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000003');

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000006', true);
insert into public.project_teams (project_id, team_id)
values ('b1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000002');

select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000005', true);
insert into public.project_teams (project_id, team_id)
values ('b1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000001');
reset role;

select pg_temp.ok(
  (select count(*) = 3 from public.project_teams
    where (project_id, team_id) in (
      ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000003'),
      ('b1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000002'),
      ('b1000000-0000-0000-0000-000000000004', 'c1000000-0000-0000-0000-000000000001')
    )),
  'lead-and-team-PI, team-admin-and-lead, and global admin can link');

-- H1 deletes. A matching DELETE policy filters instead of raising.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
delete from public.project_teams
 where project_id = 'b1000000-0000-0000-0000-000000000002'
   and team_id = 'c1000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000003', true);
delete from public.project_teams
 where project_id = 'b1000000-0000-0000-0000-000000000002'
   and team_id = 'c1000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.ok(
  (select count(*) = 1 from public.project_teams
    where project_id = 'b1000000-0000-0000-0000-000000000002'
      and team_id = 'c1000000-0000-0000-0000-000000000001'),
  'neither a team PI nor a non-admin lead can unlink the project');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000005', true);
delete from public.project_teams
 where project_id = 'b1000000-0000-0000-0000-000000000002'
   and team_id = 'c1000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);
delete from public.project_teams
 where project_id = 'b1000000-0000-0000-0000-000000000001'
   and team_id = 'c1000000-0000-0000-0000-000000000001';
insert into public.project_teams (project_id, team_id)
values ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001');
reset role;
select pg_temp.ok(
  (select count(*) = 0 from public.project_teams
    where project_id = 'b1000000-0000-0000-0000-000000000002'
      and team_id = 'c1000000-0000-0000-0000-000000000001')
  and (select count(*) = 1 from public.project_teams
    where project_id = 'b1000000-0000-0000-0000-000000000001'
      and team_id = 'c1000000-0000-0000-0000-000000000001'),
  'an admin can unlink, and the project lead who is team PI can unlink and link again');

set local role anon;
do $$ begin
  insert into public.project_teams (project_id, team_id)
  values ('b1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000002');
  raise exception 'FAIL: anonymous link';
exception when insufficient_privilege then null;
end $$;
reset role;

-- The bypass: a team member who can edit the project writes the placeholder
-- flag, claims the lead, then changes visibility and deletion.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000004', true);
do $$ begin
  update public.projects
     set lead_name_override = 'Claim me'
   where id = 'b1000000-0000-0000-0000-000000000001';
  if not found then raise exception 'FAIL: claim bypass did not see the project'; end if;
  raise exception 'FAIL: collaborator made the project claimable';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform public.claim_project('b1000000-0000-0000-0000-000000000001');
  raise exception 'FAIL: collaborator claimed the lead';
exception
  when insufficient_privilege then null;
  when raise_exception then
    if sqlerrm <> 'Project does not have a placeholder lead' then raise; end if;
end $$;
do $$ begin
  update public.projects
     set is_public = true,
         deleted_at = timestamptz '2026-10-13 04:00:00+00'
   where id = 'b1000000-0000-0000-0000-000000000001';
  if not found then raise exception 'FAIL: claim bypass did not see the project'; end if;
  raise exception 'FAIL: collaborator changed visibility and deletion after the claim attempt';
exception when insufficient_privilege then null;
end $$;
reset role;
select pg_temp.ok(
  (select lead_user_id = 'a1000000-0000-0000-0000-000000000001'
      and lead_name_override is null
      and not is_public
      and deleted_at is null
      and title = 'Led by team PI'
   from public.projects where id = 'b1000000-0000-0000-0000-000000000001'),
  'writing the placeholder, claiming, and editing visibility or deletion all failed');

-- A claimable project is still not enough. This editor is not on a linked team.
insert into public.project_collaborators (project_id, user_id)
values ('b1000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000007');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000007', true);
do $$ begin
  perform public.claim_project('b1000000-0000-0000-0000-000000000005');
  raise exception 'FAIL: outsider claimed a placeholder';
exception when insufficient_privilege then null;
end $$;
reset role;
select pg_temp.ok(
  (select lead_user_id = 'a1000000-0000-0000-0000-000000000008'
      and lead_name_override = 'Placeholder PI'
   from public.projects where id = 'b1000000-0000-0000-0000-000000000005'),
  'a claimable project stays with its placeholder when the caller is not a team member or admin');

-- A lead may open a claim. A team member may then take it.
insert into public.project_teams (project_id, team_id)
values ('b1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000003', true);
update public.projects
   set lead_name_override = 'Open seat'
 where id = 'b1000000-0000-0000-0000-000000000002';
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
select public.claim_project('b1000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.ok(
  (select lead_user_id = 'a1000000-0000-0000-0000-000000000002'
      and lead_name_override is null
   from public.projects where id = 'b1000000-0000-0000-0000-000000000002')
  and (select count(*) = 1 from public.activity_log
       where project_id = 'b1000000-0000-0000-0000-000000000002'
         and user_id = 'a1000000-0000-0000-0000-000000000002'
         and metadata->>'type' = 'lead_claimed'),
  'a lead can open a claim and a linked team member can take it');

-- H2. Collaborator edits the title, including a no-op write of the locked columns.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000004', true);
update public.projects
   set title = 'Collaborator title',
       is_public = is_public,
       lead_user_id = lead_user_id,
       deleted_at = deleted_at,
       lead_name_override = lead_name_override
 where id = 'b1000000-0000-0000-0000-000000000001';
do $$ begin
  update public.projects
     set title = 'Should not stick', is_public = true
   where id = 'b1000000-0000-0000-0000-000000000001';
  if not found then raise exception 'FAIL: collaborator update did not see the project'; end if;
  raise exception 'FAIL: collaborator changed is_public';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  update public.projects
     set lead_user_id = 'a1000000-0000-0000-0000-000000000004'
   where id = 'b1000000-0000-0000-0000-000000000001';
  if not found then raise exception 'FAIL: collaborator update did not see the project'; end if;
  raise exception 'FAIL: collaborator changed lead_user_id';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  update public.projects
     set deleted_at = timestamptz '2026-10-13 00:00:00+00'
   where id = 'b1000000-0000-0000-0000-000000000001';
  if not found then raise exception 'FAIL: collaborator update did not see the project'; end if;
  raise exception 'FAIL: collaborator changed deleted_at';
exception when insufficient_privilege then null;
end $$;
select set_config('request.jwt.claim.role', 'service_role', true);
do $$ begin
  update public.projects
     set is_public = true
   where id = 'b1000000-0000-0000-0000-000000000001';
  if not found then raise exception 'FAIL: collaborator update did not see the project'; end if;
  raise exception 'FAIL: forged service_role claim changed is_public';
exception when insufficient_privilege then null;
end $$;
reset role;

select pg_temp.ok(
  (select title = 'Collaborator title' and not is_public and deleted_at is null
      and lead_user_id = 'a1000000-0000-0000-0000-000000000001'
      and lead_name_override is null
   from public.projects where id = 'b1000000-0000-0000-0000-000000000001'),
  'collaborator title edit stuck; visibility, lead, deletion, and the placeholder did not');

-- A team admin who is only a collaborator is not the admin the trigger means.
insert into public.project_collaborators (project_id, user_id)
values ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000006');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000006', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $$ begin
  update public.projects set is_public = true
   where id = 'b1000000-0000-0000-0000-000000000001';
  if not found then raise exception 'FAIL: team admin update did not see the project'; end if;
  raise exception 'FAIL: team admin collaborator changed is_public';
exception when insufficient_privilege then null;
end $$;

-- Lead and global admin can change the locked columns. The lead is also a
-- collaborator so the existing update policy's WITH CHECK still matches after
-- lead_user_id moves; the trigger is what stops the former lead.
reset role;
insert into public.project_collaborators (project_id, user_id)
values ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000001', true);
update public.projects
   set is_public = true,
       deleted_at = timestamptz '2026-10-13 00:00:00+00'
 where id = 'b1000000-0000-0000-0000-000000000001';
update public.projects
   set is_public = false,
       deleted_at = null,
       lead_user_id = 'a1000000-0000-0000-0000-000000000004'
 where id = 'b1000000-0000-0000-0000-000000000001';
do $$ begin
  update public.projects set is_public = true
   where id = 'b1000000-0000-0000-0000-000000000001';
  if not found then raise exception 'FAIL: former lead update did not see the project'; end if;
  raise exception 'FAIL: former lead changed is_public';
exception when insufficient_privilege then null;
end $$;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000004', true);
update public.projects
   set is_public = true, title = 'New lead title'
 where id = 'b1000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000005', true);
update public.projects
   set is_public = true,
       deleted_at = timestamptz '2026-10-13 01:00:00+00',
       lead_user_id = 'a1000000-0000-0000-0000-000000000005',
       lead_name_override = 'Opened by admin'
 where id = 'b1000000-0000-0000-0000-000000000002';
reset role;

select pg_temp.ok(
  (select is_public and title = 'New lead title'
      and lead_user_id = 'a1000000-0000-0000-0000-000000000004'
      and deleted_at is null
   from public.projects where id = 'b1000000-0000-0000-0000-000000000001')
  and (select is_public and deleted_at = timestamptz '2026-10-13 01:00:00+00'
          and lead_user_id = 'a1000000-0000-0000-0000-000000000005'
          and lead_name_override = 'Opened by admin'
   from public.projects where id = 'b1000000-0000-0000-0000-000000000002'),
  'the current lead and a global admin can change visibility, lead, deletion, and the placeholder');

-- Direct client change of a placeholder lead is rejected. claim_project is not.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000002', true);
do $$ begin
  update public.projects
     set lead_user_id = 'a1000000-0000-0000-0000-000000000002',
         lead_name_override = null
   where id = 'b1000000-0000-0000-0000-000000000005';
  if not found then raise exception 'FAIL: direct claim did not see the project'; end if;
  raise exception 'FAIL: team member directly claimed the lead';
exception when insufficient_privilege then null;
end $$;
select public.claim_project('b1000000-0000-0000-0000-000000000005');
reset role;
select pg_temp.ok(
  (select lead_user_id = 'a1000000-0000-0000-0000-000000000002' and lead_name_override is null
   from public.projects where id = 'b1000000-0000-0000-0000-000000000005'),
  'claim_project can still move a placeholder lead');

-- service_role is not the lead and is not an admin profile. The trigger allows it.
set local role service_role;
select set_config('request.jwt.claim.sub', 'a1000000-0000-0000-0000-000000000004', true);
update public.projects
   set is_public = true,
       deleted_at = timestamptz '2026-10-13 02:00:00+00',
       lead_user_id = 'a1000000-0000-0000-0000-000000000004',
       lead_name_override = 'Opened by service'
 where id = 'b1000000-0000-0000-0000-000000000003';
reset role;
select pg_temp.ok(
  (select is_public and deleted_at = timestamptz '2026-10-13 02:00:00+00'
      and lead_user_id = 'a1000000-0000-0000-0000-000000000004'
      and lead_name_override = 'Opened by service'
   from public.projects where id = 'b1000000-0000-0000-0000-000000000003'),
  'service_role can change visibility, lead, deletion, and the placeholder');

rollback;
