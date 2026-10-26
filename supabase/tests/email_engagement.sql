\set ON_ERROR_STOP on
-- 20261026150000_digest_engagement.sql (Settings saves stamp engaged_at) and
-- 20261026151000_beta_email_engagement_metrics.sql (email clicks are use; unsubscribes shown).
begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'FAIL: %',label; end if; raise notice 'ok: %',label; end$$;
insert into auth.users(id) select ('e0000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid from generate_series(1,6)i;
insert into private.beta_admins(user_id) values('e0000000-0000-0000-0000-000000000001');

-- --- engaged_at: the reader's own Settings writes stamp it; nothing else does ------------
insert into public.digest_schedules(user_id,enabled,hour_local,timezone) values
('e0000000-0000-0000-0000-000000000002',true,6,'America/New_York'),
('e0000000-0000-0000-0000-000000000003',true,6,'America/New_York');
select pg_temp.ok(engaged_at is null,'a service-role insert does not stamp engagement') from public.digest_schedules where user_id='e0000000-0000-0000-0000-000000000002';
-- Service role (no auth.uid()): the unsubscribe link and digest-run never count as the reader.
update public.digest_schedules set email_digest=false where user_id='e0000000-0000-0000-0000-000000000002';
select pg_temp.ok(engaged_at is null,'a service-role update (unsubscribe) is not engagement') from public.digest_schedules where user_id='e0000000-0000-0000-0000-000000000002';
-- digest-click writes engaged_at itself as service role, and that value stands.
update public.digest_schedules set engaged_at='2026-10-20T12:00:00Z' where user_id='e0000000-0000-0000-0000-000000000003';
select pg_temp.ok(engaged_at='2026-10-20T12:00:00Z','the service role may set engaged_at (digest-click, digest-resume)') from public.digest_schedules where user_id='e0000000-0000-0000-0000-000000000003';

select set_config('request.jwt.claim.sub','e0000000-0000-0000-0000-000000000002',true);
set local role authenticated;
-- Settings: the client upsert, exactly as src/lib/digestSchedule.js sends it.
insert into public.digest_schedules(user_id,enabled,hour_local,timezone,email_digest)
values('e0000000-0000-0000-0000-000000000002',true,7,'America/New_York',true)
on conflict(user_id) do update set enabled=excluded.enabled,hour_local=excluded.hour_local,timezone=excluded.timezone,email_digest=excluded.email_digest;
select pg_temp.ok(engaged_at=now(),'a Settings save stamps engaged_at from the database clock') from public.digest_schedules where user_id='e0000000-0000-0000-0000-000000000002';
select pg_temp.ok(engaged_at is not null,'the reader can read engaged_at') from public.digest_schedules where user_id='e0000000-0000-0000-0000-000000000002';
-- The reader cannot write engaged_at directly (no column grant).
do $$begin
 begin
 update public.digest_schedules set engaged_at='2030-01-01' where user_id=auth.uid();
 raise exception 'direct engaged_at write accepted';
 exception when insufficient_privilege then null;
 end;
end$$;
-- Nor touch another reader's row: RLS hides it, so the update matches nothing.
update public.digest_schedules set hour_local=9 where user_id='e0000000-0000-0000-0000-000000000003';
reset role;
select pg_temp.ok(engaged_at='2026-10-20T12:00:00Z' and hour_local=6,'another reader''s row is untouched') from public.digest_schedules where user_id='e0000000-0000-0000-0000-000000000003';

-- --- dashboard: email clicks are use; unsubscribes and resumes are shown -------------------
select set_config('request.jwt.claim.sub','e0000000-0000-0000-0000-000000000001',true);
insert into public.sponsored_accounts(user_id,cohort,created_at) values
('e0000000-0000-0000-0000-000000000002','beta',now()-interval '20 days'),
('e0000000-0000-0000-0000-000000000003','beta',now()-interval '20 days'),
('e0000000-0000-0000-0000-000000000004','smoke-qa-20261015',now()-interval '20 days'),
('e0000000-0000-0000-0000-000000000005','beta',now()-interval '20 days');
insert into public.events(user_id,type,payload,ts)
select ('e0000000-0000-0000-0000-'||lpad(u::text,12,'0'))::uuid,t,'{}'::jsonb,now()-age::interval
from (values
-- user 2 only ever reads the email: clicks on two different days
(2,'digest_link_clicked','1 day'),(2,'digest_link_clicked','1 day'),(2,'digest_link_clicked','2 days'),
-- user 3 opens the app once and unsubscribes
(3,'digest_opened','1 day'),(3,'digest_email_unsubscribed','1 day'),
-- user 5 presses the resume button
(5,'digest_resume_clicked','1 day'),
-- smoke cohort: excluded everywhere
(4,'digest_link_clicked','1 day'),(4,'digest_link_clicked','2 days'),(4,'digest_email_unsubscribed','1 day'),
-- outside the selected range
(2,'digest_link_clicked','5 days')
) v(u,t,age);
-- What the unsubscribe link does to user 3's row (user 2's Settings save above turned theirs back on).
update public.digest_schedules set email_digest=false where user_id='e0000000-0000-0000-0000-000000000003';
create temp table result as select public.beta_release_stats(now()-interval '3 days',now()) j;
select pg_temp.ok((j->'adoption'->>'returned')::int=1,'an email-only reader with clicks on two days is a returned user') from result;
select pg_temp.ok((j->'adoption'->>'active72')::int=2,'email clicks count as use in the last 72 hours') from result;
select pg_temp.ok((j->'email'->>'clicks')::int=3,'three clicks in range, repeats counted, smoke excluded') from result;
select pg_temp.ok((j->'email'->>'clickers')::int=1,'one reader clicked') from result;
select pg_temp.ok((j->'email'->>'unsubscribes')::int=1,'one unsubscribe, smoke excluded') from result;
select pg_temp.ok((j->'email'->>'resumes')::int=1,'one resume') from result;
select pg_temp.ok((j->'email'->>'email_off_now')::int=1,'one enrolled account has the email off now') from result;
select pg_temp.ok((j->'earliest_retained'->>'digest_link_clicked')::timestamptz=now()-interval '5 days','click coverage starts at the oldest real click') from result;
select pg_temp.ok((j->'earliest_retained'->>'digest_email_unsubscribed') is not null,'unsubscribe coverage is reported') from result;
select pg_temp.ok((j->'shares') is not null and (j->'earliest_retained'->>'paper_share_clicked') is null,'share metrics still present') from result;
select pg_temp.ok(not (j->'email' ? 'earliest_click'),'internal coverage keys are not leaked in the email block') from result;
-- Still admin-only.
select set_config('request.jwt.claim.sub','e0000000-0000-0000-0000-000000000002',true);
set local role authenticated;
do $$begin
 begin
 perform public.beta_release_stats(now()-interval '3 days',now());
 raise exception 'non-admin aggregate access accepted';
 exception when insufficient_privilege then null;
 end;
end$$;
reset role;
rollback;
