-- H1 and H2 from the 2026-10-12 audit. Not applied to a linked project.
--
-- H1. project_teams_insert and project_teams_delete allowed any profile-level PI,
-- or any project lead, to attach or detach any project and any team. A PI could
-- link someone else's project to their own team. The replacement requires both
-- sides: admin or PI of that team, and lead or admin of that project. A global
-- admin still satisfies both.
--
-- H2. projects_update lets a collaborator update the row, including is_public,
-- lead_user_id, deleted_at, and lead_name_override. RLS cannot protect individual
-- columns. A BEFORE UPDATE trigger rejects changes to those four unless the
-- caller is the current lead or an admin. lead_name_override is what makes a
-- project claimable (claim_project requires it, and also requires deleted_at
-- to be null, which is already locked). anon and authenticated are the client
-- roles. service_role is allowed. A forged JWT role claim is not consulted.
--
-- claim_project stays security definer, so this trigger does not see the
-- client role during a claim. The function itself must decide that the caller
-- is allowed to take the lead. A claimable row is not that permission.
--
-- No-op when the shared PaperTrellis tables are not installed. Re-running
-- replaces the same policies and trigger.

begin;

do $migration$
declare
  pol record;
begin
  if to_regclass('public.projects') is null
     or to_regclass('public.project_teams') is null
     or to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_project_lead(uuid)') is null
     or to_regprocedure('public.is_team_admin_or_pi(uuid)') is null then
    raise notice 'project tables absent; skipping project link and column guards';
    return;
  end if;

  execute $fn$
    create or replace function public.guard_project_sensitive_columns()
    returns trigger
    language plpgsql
    set search_path = ''
    as $body$
    begin
      if new.is_public is not distinct from old.is_public
         and new.lead_user_id is not distinct from old.lead_user_id
         and new.deleted_at is not distinct from old.deleted_at
         and new.lead_name_override is not distinct from old.lead_name_override then
        return new;
      end if;
      -- Client sessions are anon and authenticated. service_role bypasses RLS
      -- but not this trigger, so it is named here and allowed. Any other role
      -- (the table owner, or the owner of a security-definer function) is the
      -- server path and is allowed too. claim_project is one of those functions
      -- and checks its own caller before it changes the lead.
      if current_user in ('anon', 'authenticated')
         and not (
           public.is_admin()
           or old.lead_user_id = (select auth.uid())
         ) then
        raise exception 'Only the project lead or an admin can change project visibility, lead, deletion, or who may claim it'
          using errcode = '42501';
      end if;
      return new;
    end;
    $body$;
  $fn$;

  execute 'revoke all on function public.guard_project_sensitive_columns() from public, anon';
  execute 'grant execute on function public.guard_project_sensitive_columns() to authenticated, service_role';

  -- Drop every insert and delete policy, including the open ones, so a second
  -- permissive policy cannot keep the old OR. Select policies stay.
  for pol in
    select p.polname
    from pg_catalog.pg_policy p
    where p.polrelid = 'public.project_teams'::regclass
      and p.polcmd in ('a', 'd')
  loop
    execute format('drop policy %I on public.project_teams', pol.polname);
  end loop;

  execute $pol$
    create policy project_teams_insert on public.project_teams
      for insert to authenticated
      with check (
        public.is_admin()
        or (
          public.is_team_admin_or_pi(team_id)
          and public.is_project_lead(project_id)
        )
      )
  $pol$;

  execute $pol$
    create policy project_teams_delete on public.project_teams
      for delete to authenticated
      using (
        public.is_admin()
        or (
          public.is_team_admin_or_pi(team_id)
          and public.is_project_lead(project_id)
        )
      )
  $pol$;

  execute 'drop trigger if exists projects_guard_sensitive_columns on public.projects';
  execute 'create trigger projects_guard_sensitive_columns before update on public.projects for each row execute function public.guard_project_sensitive_columns()';

  -- Replaces the previous claim_project. Claimability (a placeholder name, and
  -- not deleted) is checked apart from authorization (admin, or a member of a
  -- team already linked to the project). A collaborator who can edit the row
  -- is not authorized by that edit.
  execute $fn$
    create or replace function public.claim_project(p_project_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = ''
    as $body$
    declare
      v_override text;
      v_deleted timestamptz;
    begin
      if (select auth.uid()) is null then
        raise exception 'You must be signed in to claim a project'
          using errcode = '42501';
      end if;

      select lead_name_override, deleted_at
        into v_override, v_deleted
        from public.projects
       where id = p_project_id
       for update;

      if not found or v_deleted is not null or v_override is null then
        raise exception 'Project does not have a placeholder lead';
      end if;

      if not public.is_admin() and not exists (
        select 1
          from public.project_teams pt
          join public.team_members tm on tm.team_id = pt.team_id
         where pt.project_id = p_project_id
           and tm.user_id = (select auth.uid())
      ) then
        raise exception 'You must be a team member to claim this project'
          using errcode = '42501';
      end if;

      update public.projects
         set lead_user_id = (select auth.uid()),
             lead_name_override = null,
             updated_at = now()
       where id = p_project_id;

      if to_regclass('public.activity_log') is not null then
        insert into public.activity_log (project_id, user_id, action, metadata)
        values (
          p_project_id,
          (select auth.uid()),
          'edited',
          pg_catalog.jsonb_build_object('type', 'lead_claimed')
        );
      end if;
    end;
    $body$;
  $fn$;

  execute 'revoke all on function public.claim_project(uuid) from public, anon';
  execute 'grant execute on function public.claim_project(uuid) to authenticated, service_role';
end
$migration$;

commit;
