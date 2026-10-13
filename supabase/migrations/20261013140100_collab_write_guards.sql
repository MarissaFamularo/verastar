-- M2 and M3: client writes on the shared PaperTrellis tables.
--
-- Applied only when those tables are already installed. A Verastar-only database
-- skips this file's body. Re-running replaces the same policies and triggers.
-- PROPOSED; not applied to any linked project.
--
-- M2. notifications_insert was WITH CHECK (true), so any signed-in user could
-- write a notification for anyone and forge actor_id. A client insert now requires
-- actor_id = auth.uid() and a real relationship: a shared project the sender can
-- access whose recipient is the lead, a collaborator, or a team member, or a shared
-- team when there is no project. service_role and security-definer functions
-- (join-request fan-out) bypass RLS and remain the server path.
--
-- M3. activity_log inserts must be the caller's own row on a project they can
-- access. Comment, task, and manuscript author columns are bound to auth.uid() on
-- insert and cannot be reassigned on update. Bot-proposal updates are limited to
-- the project lead, an admin, or service_role.

create or replace function public.enforce_row_author()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  column_name text := tg_argv[0];
  new_author uuid := (pg_catalog.to_jsonb(new) ->> column_name)::uuid;
  old_author uuid;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and new_author is distinct from auth.uid() then
      raise exception 'author column % must be auth.uid()', column_name
        using errcode = '42501';
    end if;
  else
    old_author := (pg_catalog.to_jsonb(old) ->> column_name)::uuid;
    if new_author is distinct from old_author then
      raise exception 'author column % cannot be reassigned', column_name
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_row_author() from public, anon, authenticated;
grant execute on function public.enforce_row_author() to authenticated, service_role;

do $$
begin
  if to_regclass('public.notifications') is null
     or to_regprocedure('public.is_admin()') is null
     or to_regprocedure('public.is_project_member(uuid)') is null
     or to_regprocedure('public.can_see_project(uuid)') is null
     or to_regclass('public.projects') is null
     or to_regclass('public.project_collaborators') is null
     or to_regclass('public.project_teams') is null
     or to_regclass('public.team_members') is null then
    raise notice 'collab tables absent; skipping notification and activity guards';
    return;
  end if;

  execute $fn$
    create or replace function public.notification_sender_allowed(
      p_user_id uuid,
      p_actor_id uuid,
      p_project_id uuid
    ) returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $body$
      select p_actor_id = (select auth.uid())
         and (select auth.uid()) is not null
         and (
           (
             p_project_id is not null
             and (
               public.is_admin()
               or public.is_project_member(p_project_id)
               or public.can_see_project(p_project_id)
             )
             and (
               p_user_id = (select auth.uid())
               or exists (
                 select 1 from public.projects
                  where id = p_project_id
                    and lead_user_id = p_user_id
                    and deleted_at is null
               )
               or exists (
                 select 1 from public.project_collaborators
                  where project_id = p_project_id and user_id = p_user_id
               )
               or exists (
                 select 1 from public.project_teams pt
                 join public.team_members tm on tm.team_id = pt.team_id
                  where pt.project_id = p_project_id and tm.user_id = p_user_id
               )
             )
           )
           or (
             p_project_id is null
             and exists (
               select 1 from public.team_members sender
               join public.team_members recipient
                 on recipient.team_id = sender.team_id
                and recipient.user_id = p_user_id
               where sender.user_id = (select auth.uid())
             )
           )
         );
    $body$;
  $fn$;

  execute 'revoke all on function public.notification_sender_allowed(uuid, uuid, uuid) from public, anon';
  execute 'grant execute on function public.notification_sender_allowed(uuid, uuid, uuid) to authenticated, service_role';

  execute 'drop policy if exists notifications_insert on public.notifications';
  execute $pol$
    create policy notifications_insert on public.notifications
      for insert to authenticated
      with check (public.notification_sender_allowed(user_id, actor_id, project_id))
  $pol$;
  execute 'revoke insert, update, delete, truncate on table public.notifications from anon';

  if to_regclass('public.activity_log') is not null then
    execute 'drop policy if exists activity_log_insert on public.activity_log';
    execute $pol$
      create policy activity_log_insert on public.activity_log
        for insert to authenticated
        with check (
          user_id = (select auth.uid())
          and (
            public.is_admin()
            or public.is_project_member(project_id)
            or public.can_see_project(project_id)
          )
        )
    $pol$;
    execute 'revoke update, delete, truncate on table public.activity_log from anon, authenticated';
  end if;

  if to_regclass('public.project_comments') is not null then
    execute 'drop policy if exists comments_insert on public.project_comments';
    execute 'drop policy if exists project_comments_insert on public.project_comments';
    execute 'drop policy if exists comments_update on public.project_comments';
    execute 'drop policy if exists project_comments_update on public.project_comments';
    execute $pol$
      create policy comments_insert on public.project_comments
        for insert to authenticated
        with check (
          user_id = (select auth.uid())
          and (public.is_admin() or public.is_project_member(project_id))
        )
    $pol$;
    execute $pol$
      create policy project_comments_insert on public.project_comments
        for insert to authenticated
        with check (
          user_id = (select auth.uid())
          and (public.can_see_project(project_id) or public.is_admin())
        )
    $pol$;
    execute $pol$
      create policy comments_update on public.project_comments
        for update to authenticated
        using ((user_id = (select auth.uid())) or public.is_admin())
        with check ((user_id = (select auth.uid())) or public.is_admin())
    $pol$;
    execute $pol$
      create policy project_comments_update on public.project_comments
        for update to authenticated
        using ((user_id = (select auth.uid())) or public.is_admin())
        with check ((user_id = (select auth.uid())) or public.is_admin())
    $pol$;
    execute 'drop trigger if exists project_comments_author on public.project_comments';
    execute 'create trigger project_comments_author before insert or update on public.project_comments for each row execute function public.enforce_row_author(''user_id'')';
  end if;

  if to_regclass('public.project_tasks') is not null
     and to_regprocedure('public.is_project_lead(uuid)') is not null then
    execute 'drop policy if exists tasks_insert on public.project_tasks';
    execute 'drop policy if exists project_tasks_insert on public.project_tasks';
    execute $pol$
      create policy tasks_insert on public.project_tasks
        for insert to authenticated
        with check (
          created_by = (select auth.uid())
          and (
            public.is_admin()
            or public.is_project_lead(project_id)
            or public.is_project_member(project_id)
          )
        )
    $pol$;
    execute $pol$
      create policy project_tasks_insert on public.project_tasks
        for insert to authenticated
        with check (
          created_by = (select auth.uid())
          and (public.can_see_project(project_id) or public.is_admin())
        )
    $pol$;
    execute 'drop trigger if exists project_tasks_author on public.project_tasks';
    execute 'create trigger project_tasks_author before insert or update on public.project_tasks for each row execute function public.enforce_row_author(''created_by'')';
  end if;

  if to_regclass('public.project_manuscripts') is not null then
    execute 'drop policy if exists project_manuscripts_insert on public.project_manuscripts';
    execute $pol$
      create policy project_manuscripts_insert on public.project_manuscripts
        for insert to authenticated
        with check (
          uploaded_by = (select auth.uid())
          and (
            public.can_see_project(project_id)
            or public.is_project_member(project_id)
            or public.is_admin()
          )
        )
    $pol$;
    execute 'drop trigger if exists project_manuscripts_author on public.project_manuscripts';
    execute 'create trigger project_manuscripts_author before insert or update on public.project_manuscripts for each row execute function public.enforce_row_author(''uploaded_by'')';
  end if;

  if to_regclass('public.project_bot_proposals') is not null
     and to_regprocedure('public.is_project_lead(uuid)') is not null then
    execute 'drop policy if exists bot_proposals_update on public.project_bot_proposals';
    execute $pol$
      create policy bot_proposals_update on public.project_bot_proposals
        for update to authenticated
        using (public.is_project_lead(project_id) or public.is_admin())
        with check (public.is_project_lead(project_id) or public.is_admin())
    $pol$;
    execute 'grant update on table public.project_bot_proposals to authenticated';
    execute 'revoke update on table public.project_bot_proposals from anon';
  end if;
end $$;
