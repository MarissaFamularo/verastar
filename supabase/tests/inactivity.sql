begin;
create function pg_temp.ok(v boolean,label text) returns void language plpgsql as $$begin if v is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label; end$$;
insert into auth.users(id) values('f1000000-0000-0000-0000-000000000001');
insert into public.digest_schedules(user_id,unopened_streak) values('f1000000-0000-0000-0000-000000000001',2);
insert into public.kv(user_id,collection,key,value) values('f1000000-0000-0000-0000-000000000001','digests','daily:latest',
 '{"kind":"daily","runBy":"scheduler","ranAt":"2026-11-04T10:00:00.000Z","server":{"phase":"done"},"openedAt":null,"results":[{}]}');
create temp table inactivity_ctx(token uuid,version jsonb);
insert into inactivity_ctx values(public.digest_claim('f1000000-0000-0000-0000-000000000001',240),
 '{"kind":"daily","runBy":"scheduler","ranAt":"2026-11-04T10:00:00.000Z","savedAt":null,"phase":"done","finishedAt":null,"openedAt":null,"papers":1}');
select pg_temp.ok(not public.digest_inactivity_update('f1000000-0000-0000-0000-000000000001',gen_random_uuid(),2,null,null,null,(select version from inactivity_ctx),3,'2026-11-04T10:00:00Z',false,false),'lost owner cannot change inactivity');
select pg_temp.ok(public.digest_inactivity_update('f1000000-0000-0000-0000-000000000001',(select token from inactivity_ctx),2,null,null,null,(select version from inactivity_ctx),3,'2026-11-04T10:00:00Z',false,false),'owner stamps count and identity together');
select pg_temp.ok((select unopened_streak=3 and inactivity_counted_at='2026-11-04T10:00:00Z' and attempts_today=0 and claim_token is not null from public.digest_schedules where user_id='f1000000-0000-0000-0000-000000000001'),'checkpoint update does not spend or release a running claim');
select pg_temp.ok(not public.digest_inactivity_update('f1000000-0000-0000-0000-000000000001',(select token from inactivity_ctx),2,null,null,null,(select version from inactivity_ctx),3,'2026-11-04T10:00:00Z',false,false),'replayed snapshot cannot count twice');
do $$ begin
 begin
 perform public.digest_inactivity_update('f1000000-0000-0000-0000-000000000001',(select token from inactivity_ctx),3,'2026-11-04T10:00:00Z',null,null,(select version from inactivity_ctx),4,'2026-11-04T10:00:00Z',false,false);
 raise exception 'duplicate increment accepted';
 exception when raise_exception then if sqlerrm='duplicate increment accepted' then raise; end if; end;
end $$;
update public.kv set value=jsonb_set(value,'{openedAt}',to_jsonb(now()::text)) where user_id='f1000000-0000-0000-0000-000000000001' and collection='digests';
select pg_temp.ok(not public.digest_inactivity_update('f1000000-0000-0000-0000-000000000001',(select token from inactivity_ctx),3,'2026-11-04T10:00:00Z',null,null,(select version from inactivity_ctx),3,'2026-11-04T10:00:00Z',false,false),'a concurrent browser open invalidates the write');
-- The existing digest guard correctly preserves a browser-open stamp on the same
-- scan. Replace the test fixture rather than pretending a reader can un-open it.
delete from public.kv where user_id='f1000000-0000-0000-0000-000000000001' and collection='digests';
insert into public.kv(user_id,collection,key,value) values('f1000000-0000-0000-0000-000000000001','digests','daily:latest',
 '{"kind":"daily","runBy":"scheduler","ranAt":"2026-11-04T10:00:00.000Z","server":{"phase":"done"},"openedAt":null,"results":[{}]}');
update public.digest_schedules set engaged_at=now() where user_id='f1000000-0000-0000-0000-000000000001';
select pg_temp.ok(not public.digest_inactivity_update('f1000000-0000-0000-0000-000000000001',(select token from inactivity_ctx),3,'2026-11-04T10:00:00Z',null,null,(select version from inactivity_ctx),3,'2026-11-04T10:00:00Z',false,false),'a concurrent Settings save/resume invalidates the write');
update public.digest_schedules set engaged_at=null,unopened_streak=6,inactivity_counted_at=null where user_id='f1000000-0000-0000-0000-000000000001';
select pg_temp.ok(public.digest_inactivity_update('f1000000-0000-0000-0000-000000000001',(select token from inactivity_ctx),6,null,null,null,(select version from inactivity_ctx),7,'2026-11-04T10:00:00Z',true,false),'seventh distinct missed digest pauses atomically');
select pg_temp.ok((select unopened_streak=7 and paused_at=now() and claim_token is null and claimed_at is null from public.digest_schedules where user_id='f1000000-0000-0000-0000-000000000001'),'pause persists actual count and releases claim');
select pg_temp.ok(not has_column_privilege('authenticated','public.digest_schedules','inactivity_counted_at','update'),'client cannot rewrite checkpoint');
select pg_temp.ok(not has_function_privilege('authenticated','public.digest_inactivity_update(uuid,uuid,integer,timestamptz,timestamptz,timestamptz,jsonb,integer,timestamptz,boolean,boolean)','execute'),'client cannot invoke inactivity update');
select pg_temp.ok(not has_function_privilege('anon','public.digest_inactivity_update(uuid,uuid,integer,timestamptz,timestamptz,timestamptz,jsonb,integer,timestamptz,boolean,boolean)','execute'),'anon cannot invoke inactivity update');
rollback;
