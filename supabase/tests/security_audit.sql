-- Proves M1–M3 against a disposable database. The hardening migrations have already
-- been applied twice. This transaction rolls back.
\set ON_ERROR_STOP on
begin;

-- Backfill kept the recent attempt and not the two-hour-old one, once.
do $$ begin
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL: invite attempt backfill';
  end if;
  if exists (
    select 1 from public.invite_attempts
     where user_id = 'a0000000-0000-0000-0000-00000000000a'
       and ts < now() - interval '90 minutes'
  ) then
    raise exception 'FAIL: expired attempt was copied';
  end if;
end $$;

-- M1. Restoring the old delete policy still cannot drain the rate-limit ledger.
savepoint old_events_delete;
create policy "events_delete_own" on public.events for delete to authenticated
  using (user_id = (select auth.uid()));
grant delete on public.events to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
delete from public.events where user_id = 'a0000000-0000-0000-0000-00000000000a' and type = 'invite_attempt';
reset role;
do $$ begin
  if exists (
    select 1 from public.events
     where user_id = 'a0000000-0000-0000-0000-00000000000a' and type = 'invite_attempt'
  ) then
    raise exception 'FAIL: old delete policy did not remove events';
  end if;
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL: deleting events reset invite_attempts';
  end if;
end $$;
rollback to savepoint old_events_delete;

-- Client delete/update of events is denied, and re-granting does not reveal rows.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
do $$ begin
  begin
    delete from public.events where user_id = 'a0000000-0000-0000-0000-00000000000a';
    raise exception 'FAIL: events delete granted';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.events set type = 'rewritten' where user_id = 'a0000000-0000-0000-0000-00000000000a';
    raise exception 'FAIL: events update granted';
  exception when insufficient_privilege then null;
  end;
end $$;
insert into public.events (user_id, type) values ('a0000000-0000-0000-0000-00000000000a', 'badge_reported');
do $$ begin
  if (select count(*) from public.events where type = 'badge_reported') <> 1 then
    raise exception 'FAIL: own telemetry insert/select';
  end if;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
do $$ begin
  if (select count(*) from public.events where type = 'badge_reported') <> 0 then
    raise exception 'FAIL: cross-account event read';
  end if;
end $$;
reset role;
grant delete, update on public.events to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
delete from public.events where user_id = 'a0000000-0000-0000-0000-00000000000a';
update public.events set type = 'rewritten' where user_id = 'a0000000-0000-0000-0000-00000000000a';
reset role;
do $$ begin
  if (select count(*) from public.events where user_id = 'a0000000-0000-0000-0000-00000000000a' and type = 'badge_reported') <> 1 then
    raise exception 'FAIL: re-granted events delete or update changed a row';
  end if;
end $$;

grant select, insert, delete on public.invite_attempts to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
delete from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a';
do $$ begin
  begin
    insert into public.invite_attempts (user_id) values ('a0000000-0000-0000-0000-00000000000a');
    raise exception 'FAIL: client inserted an invite attempt';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$ begin
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a') <> 1 then
    raise exception 'FAIL: client delete changed invite_attempts';
  end if;
end $$;
set local role service_role;
insert into public.invite_attempts (user_id) values ('a0000000-0000-0000-0000-00000000000a');
reset role;
do $$ begin
  if (select count(*) from public.invite_attempts where user_id = 'a0000000-0000-0000-0000-00000000000a') <> 2 then
    raise exception 'FAIL: service role could not record an attempt';
  end if;
end $$;

-- M2. Sender is auth.uid(), and the recipient shares the project or a team.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
insert into public.notifications (user_id, actor_id, type, message, project_id) values
  ('a0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000b', 'task_assigned', 'for the lead', 'b0000000-0000-0000-0000-000000000001');
do $$ begin
  begin
    insert into public.notifications (user_id, actor_id, type, message, project_id) values
      ('a0000000-0000-0000-0000-00000000000d', 'a0000000-0000-0000-0000-00000000000b', 'task_assigned', 'stranger', 'b0000000-0000-0000-0000-000000000001');
    raise exception 'FAIL: notified a user outside the project';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.notifications (user_id, actor_id, type, message, project_id) values
      ('a0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000d', 'task_assigned', 'spoofed', 'b0000000-0000-0000-0000-000000000001');
    raise exception 'FAIL: forged notification actor';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
insert into public.notifications (user_id, actor_id, type, message) values
  ('a0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', 'join_request_approved', 'same team');
do $$ begin
  update public.notifications set read = true
   where user_id = 'a0000000-0000-0000-0000-00000000000a' and type = 'task_assigned';
  if not found then raise exception 'FAIL: recipient could not mark read'; end if;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000d', true);
do $$ begin
  begin
    insert into public.notifications (user_id, actor_id, type, message) values
      ('a0000000-0000-0000-0000-00000000000a', 'a0000000-0000-0000-0000-00000000000d', 'join_request_approved', 'no team');
    raise exception 'FAIL: stranger team notification';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
insert into public.notifications (user_id, actor_id, type, message) values
  ('a0000000-0000-0000-0000-00000000000d', null, 'join_request_approved', 'server');
reset role;

-- M3. Activity rows require project access and the caller's id.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
insert into public.activity_log (project_id, user_id, action) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b', 'comment_added');
do $$ begin
  begin
    insert into public.activity_log (project_id, user_id, action) values
      ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'edited');
    raise exception 'FAIL: activity forged another author';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.activity_log set action = 'edited'
     where user_id = 'a0000000-0000-0000-0000-00000000000b';
    raise exception 'FAIL: activity log updated';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000d', true);
do $$ begin
  begin
    insert into public.activity_log (project_id, user_id, action) values
      ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000d', 'edited');
    raise exception 'FAIL: stranger wrote activity';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000c', true);
insert into public.activity_log (project_id, user_id, action) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000c', 'edited');

-- Authors on comments, tasks, and manuscripts.
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
insert into public.project_comments (project_id, user_id, body) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b', 'note');
do $$ begin
  begin
    insert into public.project_comments (project_id, user_id, body) values
      ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000a', 'stolen');
    raise exception 'FAIL: comment forged author';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.project_comments set user_id = 'a0000000-0000-0000-0000-00000000000a'
     where user_id = 'a0000000-0000-0000-0000-00000000000b';
    raise exception 'FAIL: comment author reassigned';
  exception when insufficient_privilege then null;
  end;
  update public.project_comments set body = 'revised'
   where user_id = 'a0000000-0000-0000-0000-00000000000b';
  if not found then raise exception 'FAIL: author could not edit own comment'; end if;
end $$;
insert into public.project_tasks (project_id, description, assigned_to, created_by) values
  ('b0000000-0000-0000-0000-000000000001', 'read', 'a0000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000b');
do $$ begin
  begin
    insert into public.project_tasks (project_id, description, assigned_to, created_by) values
      ('b0000000-0000-0000-0000-000000000001', 'forged', 'a0000000-0000-0000-0000-00000000000c', 'a0000000-0000-0000-0000-00000000000a');
    raise exception 'FAIL: task forged created_by';
  exception when insufficient_privilege then null;
  end;
end $$;
insert into public.project_manuscripts (project_id, content, uploaded_by) values
  ('b0000000-0000-0000-0000-000000000001', 'draft', 'a0000000-0000-0000-0000-00000000000b');
do $$ begin
  begin
    insert into public.project_manuscripts (project_id, content, uploaded_by) values
      ('b0000000-0000-0000-0000-000000000001', 'stolen', 'a0000000-0000-0000-0000-00000000000a');
    raise exception 'FAIL: manuscript forged uploaded_by';
  exception when insufficient_privilege then null;
  end;
  update public.project_manuscripts set content = 'draft 2'
   where uploaded_by = 'a0000000-0000-0000-0000-00000000000b';
  if not found then raise exception 'FAIL: member could not update manuscript'; end if;
  begin
    update public.project_manuscripts set uploaded_by = 'a0000000-0000-0000-0000-00000000000a'
     where uploaded_by = 'a0000000-0000-0000-0000-00000000000b';
    raise exception 'FAIL: manuscript author reassigned';
  exception when insufficient_privilege then null;
  end;
end $$;

select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000c', true);
insert into public.project_comments (project_id, user_id, body) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000c', 'from the team');
do $$ begin
  update public.project_tasks set completed = true
   where assigned_to = 'a0000000-0000-0000-0000-00000000000c';
  if not found then raise exception 'FAIL: assignee could not complete task'; end if;
  begin
    update public.project_tasks set created_by = 'a0000000-0000-0000-0000-00000000000c'
     where assigned_to = 'a0000000-0000-0000-0000-00000000000c';
    raise exception 'FAIL: assignee reassigned task author';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Bot proposals: a member may file one; only the lead, an admin, or service role may update it.
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
insert into public.project_bot_proposals (project_id, created_by, kind, payload) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000000b', 'stage', '{"to":"writing"}');
do $$ begin
  update public.project_bot_proposals set status = 'accepted', reviewed_by = 'a0000000-0000-0000-0000-00000000000b';
  if found then raise exception 'FAIL: collaborator updated a bot proposal'; end if;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
do $$ begin
  update public.project_bot_proposals
     set status = 'accepted', reviewed_by = 'a0000000-0000-0000-0000-00000000000a'
   where created_by = 'a0000000-0000-0000-0000-00000000000b';
  if not found then raise exception 'FAIL: lead could not review bot proposal'; end if;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000e', true);
do $$ begin
  update public.project_bot_proposals
     set status = 'rejected', reviewed_by = 'a0000000-0000-0000-0000-00000000000e'
   where created_by = 'a0000000-0000-0000-0000-00000000000b';
  if not found then raise exception 'FAIL: admin could not review bot proposal'; end if;
end $$;
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;
do $$ begin
  update public.project_bot_proposals set review_note = 'server'
   where created_by = 'a0000000-0000-0000-0000-00000000000b';
  if not found then raise exception 'FAIL: service role could not update bot proposal'; end if;
end $$;
reset role;

do $$ begin
  if (select count(*) from public.notifications where message = 'stranger') <> 0 then
    raise exception 'FAIL: stranger notification stored';
  end if;
  if (select count(*) from public.notifications where message = 'server' and actor_id is null) <> 1 then
    raise exception 'FAIL: server notification missing';
  end if;
  if (select status from public.project_bot_proposals) <> 'rejected' then
    raise exception 'FAIL: proposal status';
  end if;
  if (select created_by from public.project_tasks) <> 'a0000000-0000-0000-0000-00000000000b' then
    raise exception 'FAIL: task author changed';
  end if;
  if (select uploaded_by from public.project_manuscripts) <> 'a0000000-0000-0000-0000-00000000000b' then
    raise exception 'FAIL: manuscript author changed';
  end if;
end $$;

rollback;
