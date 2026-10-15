\set ON_ERROR_STOP on
begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$begin if not coalesce(v,false) then raise exception 'FAIL: %',label; end if; raise notice 'ok: %',label; end$$;
insert into auth.users(id) select ('d0000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid from generate_series(1,5)i;
insert into private.beta_admins(user_id) values('d0000000-0000-0000-0000-000000000001');
select set_config('request.jwt.claim.sub','d0000000-0000-0000-0000-000000000001',true);
insert into public.sponsored_accounts(user_id,cohort,created_at) values
('d0000000-0000-0000-0000-000000000002','beta',now()-interval '20 days'),
('d0000000-0000-0000-0000-000000000003','beta',now()-interval '20 days'),
('d0000000-0000-0000-0000-000000000004','smoke-qa-20261015',now()-interval '20 days');
insert into private.beta_test_exclusions(user_id,starts_at,ends_at,reason) values
('d0000000-0000-0000-0000-000000000003',now()-interval '2 days',now()-interval '1 day','test');
insert into public.events(user_id,type,ts)
select ('d0000000-0000-0000-0000-'||lpad(u::text,12,'0'))::uuid,t,now()-age::interval
from (values
(2,'paper_share_clicked','3 days'),(2,'paper_share_clicked','3 days'),
(3,'paper_share_clicked','1 day'), -- exclusion end is inclusive for real use
(3,'paper_share_clicked','2 days'), -- exclusion start: omitted
(4,'paper_share_clicked','3 days'), -- smoke cohort
(5,'paper_share_clicked','3 days'), -- no beta enrollment
(2,'paper_share_clicked','21 days'), -- before enrollment
(2,'paper_shared','3 days'), -- legacy outcome
(2,'paper_share_clicked','4 days'), -- before selected range
(2,'paper_share_clicked','0 days') -- exclusive range end
) v(u,t,age);
create temp table result as select public.beta_release_stats(now()-interval '3 days',now()) j;
select pg_temp.ok((j->'shares'->>'clicks')::int=3,'three clicks: repeated clicks counted, range and test exclusions honored') from result;
select pg_temp.ok((j->'shares'->>'users')::int=2,'two unique authenticated beta sharers') from result;
select pg_temp.ok((j->'earliest_retained'->>'paper_share_clicked')::timestamptz=now()-interval '4 days','coverage excludes smoke, non-beta and pre-enrollment events') from result;
select pg_temp.ok((public.beta_release_stats(now()-interval '10 days',now()-interval '9 days')->'shares'->>'clicks')::int=0,'empty range is zero in RPC');
-- Existing events RLS binds attribution to auth.uid(), even for the new event type.
set local role authenticated;
do $$begin
 begin
 insert into public.events(user_id,type) values('d0000000-0000-0000-0000-000000000002','paper_share_clicked');
 raise exception 'spoofed attribution accepted';
 exception when insufficient_privilege then null;
 end;
 insert into public.events(user_id,type) values(auth.uid(),'paper_share_clicked');
end$$;
reset role;
rollback;
