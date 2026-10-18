-- Beta feedback inbox for admins, plus an email notice when new feedback arrives.
--
-- Feedback ("Send feedback") and "This badge is wrong?" reports are already stored as
-- `beta_feedback` and `badge_reported` events. Until now nothing showed them to anyone.
--
-- 1. beta_admin_feedback(): for allowlisted admins only (same check as beta_admin_check),
--    the feedback messages with sender email, and counts of wrong-badge reports.
--    Retries of one report share a client reportId and are counted once.
-- 2. A new `feedback` kind in the existing alert outbox. Inserting a beta_feedback event
--    queues one notice unless one is already waiting, so a burst of messages sends one
--    email. The beta-monitor function sends it with no feedback text, sender or account
--    in the mail; the messages stay behind the admin sign-in.

create or replace function public.beta_admin_feedback()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.beta_admins where user_id = auth.uid()) then
    raise exception 'beta admin access required' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', f.ts, 'email', f.email, 'text', f.body, 'view', f.view, 'test', f.test)
             order by f.ts desc)
        from (
          select distinct on (coalesce(e.payload->>'reportId', e.id::text))
                 e.ts, u.email, left(e.payload->>'text', 2000) as body, e.payload->>'view' as view,
                 private.beta_is_test(e.user_id, e.ts) as test
            from public.events e
            left join auth.users u on u.id = e.user_id
           where e.type = 'beta_feedback'
           order by coalesce(e.payload->>'reportId', e.id::text), e.ts
        ) f
    ), '[]'::jsonb),
    'wrong_total', (select count(distinct coalesce(payload->>'reportId', id::text))
                      from public.events where type = 'badge_reported'),
    'wrong_7d', (select count(distinct coalesce(payload->>'reportId', id::text))
                   from public.events where type = 'badge_reported' and ts > now() - interval '7 days')
  );
end;
$$;

revoke all on function public.beta_admin_feedback() from public, anon;
grant execute on function public.beta_admin_feedback() to authenticated;

alter table private.beta_alert_outbox drop constraint if exists beta_alert_outbox_kind_check;
alter table private.beta_alert_outbox
  add constraint beta_alert_outbox_kind_check check (kind in ('incident', 'recovery', 'feedback'));

create or replace function private.beta_feedback_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from private.beta_alert_outbox
                  where kind = 'feedback' and sent_at is null and attempts = 0) then
    insert into private.beta_alert_outbox (check_name, incident_at, kind)
    values ('feedback', new.ts, 'feedback')
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.beta_feedback_notice() from public, anon, authenticated;

drop trigger if exists beta_feedback_notice on public.events;
create trigger beta_feedback_notice
  after insert on public.events
  for each row when (new.type = 'beta_feedback')
  execute function private.beta_feedback_notice();
