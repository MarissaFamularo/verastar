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
-- team when there is no project. Join-request approval and rejection notices are
-- not a shared-team write: the applicant is not a member yet, and the client
-- callers omit actor_id. Those decisions go through decide_join_request, which
-- checks the caller is an admin or PI of that team (or a global admin) and that
-- the request is still pending, then writes the notice itself. Direct inserts of
-- join_request_approved or join_request_rejected stay denied. service_role and
-- security-definer functions (including join-request fan-out) bypass RLS.
--
-- M3. activity_log inserts must be the caller's own row on a project they can
-- access. Comment, task, and manuscript author columns are bound to auth.uid() on
-- insert. Comment and task authors cannot be reassigned. Manuscript uploaded_by
-- stays put on a direct update; save_manuscript_revision may set it to auth.uid()
-- for a caller who can access the project, and only while that function holds a
-- one-row permit the client cannot write. Bot-proposal updates are limited to the
-- project lead, an admin, or service_role.

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
      p_project_id uuid,
      p_type text
    ) returns boolean
    language sql
    stable
    security definer
    set search_path = ''
    as $body$
      select p_actor_id = (select auth.uid())
         and (select auth.uid()) is not null
         and p_type is distinct from 'join_request_approved'
         and p_type is distinct from 'join_request_rejected'
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

  execute 'drop policy if exists notifications_insert on public.notifications';
  execute 'drop function if exists public.notification_sender_allowed(uuid, uuid, uuid)';
  execute 'revoke all on function public.notification_sender_allowed(uuid, uuid, uuid, text) from public, anon';
  execute 'grant execute on function public.notification_sender_allowed(uuid, uuid, uuid, text) to authenticated, service_role';

  execute $pol$
    create policy notifications_insert on public.notifications
      for insert to authenticated
      with check (public.notification_sender_allowed(user_id, actor_id, project_id, type))
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
    execute 'create schema if not exists verastar_private';
    execute 'revoke all on schema verastar_private from public, anon, authenticated';
    execute $tbl$
      create table if not exists verastar_private.manuscript_uploader_permit (
        project_id uuid primary key,
        user_id uuid not null,
        revision_id uuid not null
      )
    $tbl$;
    execute 'revoke all on table verastar_private.manuscript_uploader_permit from public, anon, authenticated, service_role';
    execute 'alter table verastar_private.manuscript_uploader_permit enable row level security';
    execute $fn$
      create or replace function public.enforce_manuscript_uploaded_by()
      returns trigger
      language plpgsql
      security definer
      set search_path = ''
      as $body$
      declare
        new_author uuid := new.uploaded_by;
        old_author uuid;
      begin
        if tg_op = 'INSERT' then
          if auth.uid() is not null and new_author is distinct from auth.uid() then
            raise exception 'author column uploaded_by must be auth.uid()'
              using errcode = '42501';
          end if;
          return new;
        end if;

        old_author := old.uploaded_by;
        if new_author is not distinct from old_author then
          return new;
        end if;

        if auth.uid() is null
           or new_author is distinct from auth.uid()
           or (
             public.is_admin() is not true
             and public.is_project_member(new.project_id) is not true
             and public.can_see_project(new.project_id) is not true
           ) then
          raise exception 'author column uploaded_by cannot be reassigned'
            using errcode = '42501';
        end if;

        delete from verastar_private.manuscript_uploader_permit
         where project_id = new.project_id
           and user_id = (select auth.uid())
           and revision_id is not distinct from new.current_revision_id;
        if not found then
          raise exception 'author column uploaded_by cannot be reassigned'
            using errcode = '42501';
        end if;
        return new;
      end;
      $body$;
    $fn$;
    execute 'revoke all on function public.enforce_manuscript_uploaded_by() from public, anon';
    execute 'grant execute on function public.enforce_manuscript_uploaded_by() to authenticated, service_role';
    execute 'drop trigger if exists project_manuscripts_author on public.project_manuscripts';
    execute 'create trigger project_manuscripts_author before insert or update on public.project_manuscripts for each row execute function public.enforce_manuscript_uploaded_by()';

    if to_regclass('public.project_manuscript_revisions') is not null then
      execute $fn$
        create or replace function public.save_manuscript_revision(
          p_project_id uuid,
          p_expected_revision uuid,
          p_revision_id uuid,
          p_content text,
          p_file_name text,
          p_reference_map jsonb
        ) returns jsonb
        language plpgsql
        security definer
        set search_path = ''
        as $body$
        declare
          v_current uuid;
          v_uploader uuid;
          v_had_manuscript boolean;
          v_prior public.project_manuscript_revisions%ROWTYPE;
          v_result jsonb;
        begin
          if auth.uid() is null
             or (public.can_see_project(p_project_id)
                 or public.is_project_member(p_project_id)
                 or public.is_admin()) is not true then
            raise exception 'Project access required' using errcode = '42501';
          end if;
          perform 1 from public.projects where id = p_project_id for update;
          if not found then
            raise exception 'Project not found' using errcode = '42501';
          end if;
          if p_revision_id is null
             or p_content is null
             or pg_catalog.jsonb_typeof(p_reference_map) is distinct from 'array' then
            raise exception 'Invalid manuscript revision';
          end if;
          select * into v_prior
            from public.project_manuscript_revisions
           where id = p_revision_id;
          if found then
            if v_prior.project_id is distinct from p_project_id
               or v_prior.content is distinct from p_content
               or v_prior.file_name is distinct from p_file_name
               or v_prior.reference_map is distinct from p_reference_map then
              raise exception 'Revision receipt does not match saved content'
                using errcode = 'PT409';
            end if;
            return pg_catalog.jsonb_build_object(
              'current_revision_id', v_prior.id,
              'project_id', v_prior.project_id,
              'file_name', v_prior.file_name,
              'uploaded_at', v_prior.created_at,
              'reference_map', v_prior.reference_map
            );
          end if;
          select current_revision_id, uploaded_by
            into v_current, v_uploader
            from public.project_manuscripts
           where project_id = p_project_id;
          v_had_manuscript := found;
          if v_current is distinct from p_expected_revision then
            raise exception 'Manuscript changed; reload the current revision'
              using errcode = 'PT409';
          end if;
          insert into public.project_manuscript_revisions (
            id, project_id, parent_revision_id, content, file_name, reference_map, created_by
          ) values (
            p_revision_id, p_project_id, v_current, p_content, p_file_name,
            p_reference_map, auth.uid()
          );
          if v_had_manuscript and v_uploader is distinct from auth.uid() then
            insert into verastar_private.manuscript_uploader_permit (
              project_id, user_id, revision_id
            ) values (
              p_project_id, auth.uid(), p_revision_id
            )
            on conflict (project_id) do update
              set user_id = excluded.user_id,
                  revision_id = excluded.revision_id;
          end if;
          insert into public.project_manuscripts (
            project_id, content, file_name, reference_map, uploaded_by, uploaded_at, current_revision_id
          ) values (
            p_project_id, p_content, p_file_name, p_reference_map, auth.uid(),
            pg_catalog.now(), p_revision_id
          )
          on conflict (project_id) do update set
            content = excluded.content,
            file_name = excluded.file_name,
            reference_map = excluded.reference_map,
            uploaded_by = excluded.uploaded_by,
            uploaded_at = excluded.uploaded_at,
            current_revision_id = excluded.current_revision_id;
          delete from verastar_private.manuscript_uploader_permit
           where project_id = p_project_id;
          select pg_catalog.jsonb_build_object(
            'id', id,
            'project_id', project_id,
            'current_revision_id', current_revision_id,
            'file_name', file_name,
            'uploaded_at', uploaded_at,
            'reference_map', reference_map
          ) into v_result
          from public.project_manuscripts
          where project_id = p_project_id;
          return v_result;
        end;
        $body$;
      $fn$;
      execute 'revoke all on function public.save_manuscript_revision(uuid, uuid, uuid, text, text, jsonb) from public, anon';
      execute 'grant execute on function public.save_manuscript_revision(uuid, uuid, uuid, text, text, jsonb) to authenticated, service_role';
    end if;
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

  if to_regclass('public.team_join_requests') is not null
     and to_regclass('public.teams') is not null
     and to_regprocedure('public.is_team_admin_or_pi(uuid)') is not null
     and exists (
       select 1 from pg_attribute
        where attrelid = 'public.team_members'::regclass
          and attname = 'role' and not attisdropped
     )
     and exists (
       select 1 from pg_attribute
        where attrelid = 'public.notifications'::regclass
          and attname = 'metadata' and not attisdropped
     ) then
    execute $fn$
      create or replace function public.decide_join_request(
        p_request_id uuid,
        p_decision text
      ) returns jsonb
      language plpgsql
      security definer
      set search_path = ''
      as $body$
      declare
        v_team_id uuid;
        v_user_id uuid;
        v_status text;
        v_team_name text;
        v_message text;
        v_type text;
      begin
        if p_request_id is null
           or (select auth.uid()) is null
           or (
             p_decision is distinct from 'approved'
             and p_decision is distinct from 'rejected'
           ) then
          raise exception 'Join request decision denied' using errcode = '42501';
        end if;

        select r.team_id, r.user_id, r.status, t.name
          into v_team_id, v_user_id, v_status, v_team_name
          from public.team_join_requests r
          join public.teams t on t.id = r.team_id
         where r.id = p_request_id
         for update of r;
        if not found then
          raise exception 'Join request decision denied' using errcode = '42501';
        end if;
        if public.is_team_admin_or_pi(v_team_id) is not true
           and public.is_admin() is not true then
          raise exception 'Join request decision denied' using errcode = '42501';
        end if;
        if v_status is distinct from 'pending' then
          raise exception 'Join request is not pending' using errcode = 'PT409';
        end if;

        update public.team_join_requests
           set status = p_decision,
               reviewed_by = (select auth.uid()),
               reviewed_at = pg_catalog.now()
         where id = p_request_id;

        if p_decision = 'approved' then
          insert into public.team_members (team_id, user_id, role)
          values (v_team_id, v_user_id, 'trainee'::public.team_role)
          on conflict (team_id, user_id) do nothing;
          v_type := 'join_request_approved';
          v_message := 'Your request to join ' || v_team_name || ' was approved!';
        else
          v_type := 'join_request_rejected';
          v_message := 'Your request to join ' || v_team_name || ' was rejected.';
        end if;

        insert into public.notifications (user_id, actor_id, type, message, metadata)
        values (
          v_user_id,
          (select auth.uid()),
          v_type,
          v_message,
          pg_catalog.jsonb_build_object('team_id', v_team_id, 'request_id', p_request_id)
        );

        return pg_catalog.jsonb_build_object(
          'request_id', p_request_id,
          'team_id', v_team_id,
          'user_id', v_user_id,
          'status', p_decision
        );
      end;
      $body$;
    $fn$;
    execute 'revoke all on function public.decide_join_request(uuid, text) from public, anon';
    execute 'grant execute on function public.decide_join_request(uuid, text) to authenticated, service_role';
  end if;
end $$;
