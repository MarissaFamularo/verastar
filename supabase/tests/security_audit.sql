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
  ('a0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', 'lab_note', 'same team');
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

-- Join decisions. A trainee, the applicant, and a direct notice insert cannot decide.
-- The PI approves one pending request; a global admin rejects the other. The
-- applicant who is rejected never becomes a team member.
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
do $$ begin
  begin
    perform public.decide_join_request('e0000000-0000-0000-0000-00000000000d', 'rejected');
    raise exception 'FAIL: trainee decided a join request';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000d', true);
do $$ begin
  begin
    perform public.decide_join_request('e0000000-0000-0000-0000-00000000000d', 'approved');
    raise exception 'FAIL: applicant decided their own join request';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
do $$ begin
  begin
    insert into public.notifications (user_id, actor_id, type, message) values
      ('a0000000-0000-0000-0000-00000000000d', 'a0000000-0000-0000-0000-00000000000a', 'join_request_rejected', 'forged rejection');
    raise exception 'FAIL: direct rejection notice to a non-member';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.notifications (user_id, actor_id, type, message) values
      ('a0000000-0000-0000-0000-00000000000b', 'a0000000-0000-0000-0000-00000000000a', 'join_request_approved', 'forged approval');
    raise exception 'FAIL: direct approval notice inside the team';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_join_request('e0000000-0000-0000-0000-000000000099', 'approved');
    raise exception 'FAIL: decided a missing join request';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_join_request('e0000000-0000-0000-0000-00000000000f', 'yes');
    raise exception 'FAIL: decided with a forged status';
  exception when insufficient_privilege then null;
  end;
  perform public.decide_join_request('e0000000-0000-0000-0000-00000000000f', 'approved');
  begin
    perform public.decide_join_request('e0000000-0000-0000-0000-00000000000f', 'rejected');
    raise exception 'FAIL: decided an already approved request';
  exception when sqlstate 'PT409' then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000e', true);
do $$ begin
  begin
    insert into public.notifications (user_id, actor_id, type, message) values
      ('a0000000-0000-0000-0000-00000000000d', 'a0000000-0000-0000-0000-00000000000e', 'join_request_rejected', 'admin forged rejection');
    raise exception 'FAIL: admin inserted a rejection notice directly';
  exception when insufficient_privilege then null;
  end;
  perform public.decide_join_request('e0000000-0000-0000-0000-00000000000d', 'rejected');
end $$;
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
  begin
    insert into verastar_private.manuscript_uploader_permit (project_id, user_id, revision_id)
    values (
      'b0000000-0000-0000-0000-000000000001',
      'a0000000-0000-0000-0000-00000000000b',
      'd0000000-0000-0000-0000-0000000000b1'
    );
    raise exception 'FAIL: client wrote an uploader permit';
  exception when insufficient_privilege then null;
  end;
end $$;
-- Two authorized uploaders. Bob's revision keeps uploaded_by; Alice's moves it to her.
do $$ begin
  perform public.save_manuscript_revision(
    'b0000000-0000-0000-0000-000000000001',
    null,
    'd0000000-0000-0000-0000-0000000000b1',
    'rev bob',
    'bob.txt',
    '[]'::jsonb
  );
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000a', true);
do $$ begin
  perform public.save_manuscript_revision(
    'b0000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-0000000000b1',
    'd0000000-0000-0000-0000-0000000000a1',
    'rev alice',
    'alice.txt',
    '[]'::jsonb
  );
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000b', true);
do $$ begin
  begin
    update public.project_manuscripts
       set uploaded_by = 'a0000000-0000-0000-0000-00000000000b'
     where project_id = 'b0000000-0000-0000-0000-000000000001';
    raise exception 'FAIL: second uploader reassigned outside the revision path';
  exception when insufficient_privilege then null;
  end;
  perform set_config('verastar.manuscript_revision', 'on', true);
  begin
    update public.project_manuscripts
       set uploaded_by = 'a0000000-0000-0000-0000-00000000000b'
     where project_id = 'b0000000-0000-0000-0000-000000000001';
    raise exception 'FAIL: session flag reassigned uploaded_by';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000000d', true);
do $$ begin
  begin
    perform public.save_manuscript_revision(
      'b0000000-0000-0000-0000-000000000001',
      'd0000000-0000-0000-0000-0000000000a1',
      'd0000000-0000-0000-0000-0000000000d1',
      'stolen',
      'dave.txt',
      '[]'::jsonb
    );
    raise exception 'FAIL: stranger saved a manuscript revision';
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
  if (select uploaded_by from public.project_manuscripts) <> 'a0000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL: second uploader did not become uploaded_by';
  end if;
  if (select current_revision_id from public.project_manuscripts) <> 'd0000000-0000-0000-0000-0000000000a1' then
    raise exception 'FAIL: current revision';
  end if;
  if (select created_by from public.project_manuscript_revisions where id = 'd0000000-0000-0000-0000-0000000000b1')
     <> 'a0000000-0000-0000-0000-00000000000b' then
    raise exception 'FAIL: first revision author';
  end if;
  if (select created_by from public.project_manuscript_revisions where id = 'd0000000-0000-0000-0000-0000000000a1')
     <> 'a0000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL: second revision author';
  end if;
  if (select count(*) from verastar_private.manuscript_uploader_permit) <> 0 then
    raise exception 'FAIL: uploader permit left behind';
  end if;
  if (select status from public.team_join_requests where id = 'e0000000-0000-0000-0000-00000000000f') <> 'approved'
     or (select reviewed_by from public.team_join_requests where id = 'e0000000-0000-0000-0000-00000000000f')
        <> 'a0000000-0000-0000-0000-00000000000a' then
    raise exception 'FAIL: approval did not record the PI';
  end if;
  if (select status from public.team_join_requests where id = 'e0000000-0000-0000-0000-00000000000d') <> 'rejected'
     or (select reviewed_by from public.team_join_requests where id = 'e0000000-0000-0000-0000-00000000000d')
        <> 'a0000000-0000-0000-0000-00000000000e' then
    raise exception 'FAIL: rejection did not record the admin';
  end if;
  if not exists (
    select 1 from public.team_members
     where user_id = 'a0000000-0000-0000-0000-00000000000f' and role = 'trainee'
  ) or exists (
    select 1 from public.team_members where user_id = 'a0000000-0000-0000-0000-00000000000d'
  ) then
    raise exception 'FAIL: approval membership';
  end if;
  if (
    select count(*) from public.notifications
     where user_id = 'a0000000-0000-0000-0000-00000000000f'
       and actor_id = 'a0000000-0000-0000-0000-00000000000a'
       and type = 'join_request_approved'
       and project_id is null
       and message = 'Your request to join lab was approved!'
       and metadata->>'request_id' = 'e0000000-0000-0000-0000-00000000000f'
  ) <> 1 then
    raise exception 'FAIL: approval notice';
  end if;
  if (
    select count(*) from public.notifications
     where user_id = 'a0000000-0000-0000-0000-00000000000d'
       and actor_id = 'a0000000-0000-0000-0000-00000000000e'
       and type = 'join_request_rejected'
       and project_id is null
       and message = 'Your request to join lab was rejected.'
       and metadata->>'request_id' = 'e0000000-0000-0000-0000-00000000000d'
  ) <> 1 then
    raise exception 'FAIL: rejection notice';
  end if;
  if (select count(*) from public.notifications where message like 'forged%' or message = 'admin forged rejection') <> 0 then
    raise exception 'FAIL: forged join notice stored';
  end if;
end $$;

rollback;
