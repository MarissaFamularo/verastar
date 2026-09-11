-- Isolated test DB only: fixture roles/auth/kv must be provided by the runner.
\set ON_ERROR_STOP on
begin;
insert into auth.users(id) values ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222') on conflict do nothing;
create or replace function pg_temp.assert_ok(v boolean, label text) returns void language plpgsql as $$ begin if not coalesce(v,false) then raise exception 'FAIL: %',label; end if; end $$;
set local role anon;
do $$ begin
  begin perform public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','create','{"id":"1"}'); raise exception 'anonymous unexpectedly allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111',true);
do $$ begin
  begin perform public.mutate_library_paper('22222222-2222-2222-2222-222222222222','1','create','{"id":"1"}'); raise exception 'wrong owner unexpectedly allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
insert into public.kv(user_id,collection,key,value) values ('11111111-1111-1111-1111-111111111111','papers','1','{"id":"1","notes":"old","finding":"old","tags":["a"],"favorite":true}');
set local role authenticated;
do $$ begin
  begin update public.kv set value='{"id":"1","notes":"old browser"}' where collection='papers' and key='1'; raise exception 'direct old-client write unexpectedly allowed'; exception when insufficient_privilege then null; end;
end $$;
select public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','patch','{"notes":"new"}','{"notes":"old"}',array['notes']);
select public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','provenance','{"project":{"id":"proj","title":"Project"}}');
select public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','patch','{"finding":"fresh"}','{"finding":"old"}',array['finding']);
select pg_temp.assert_ok((select value @> '{"notes":"new","finding":"fresh","tags":["a"],"favorite":true,"trellisProjects":[{"id":"proj"}]}' from public.kv where key='1'),'interleaved independent fields preserved');
select pg_temp.assert_ok(public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','patch','{"notes":"second"}','{"notes":"old"}',array['notes'])->>'status'='conflict','same-field conflict');
select pg_temp.assert_ok(public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','patch','{"notes":"new"}','{"notes":"old"}',array['notes'])->>'status'='linked','exact duplicate patch retry');
select public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','provenance','{"project":{"id":"proj","title":"Project"}}');
select pg_temp.assert_ok((select jsonb_array_length(value->'trellisProjects')=1 from public.kv where key='1'),'duplicate provenance');
select public.import_library_batch('11111111-1111-1111-1111-111111111111','[{"user_id":"11111111-1111-1111-1111-111111111111","collection":"papers","key":"1","value":{"id":"1","notes":"stale local"}}]');
select pg_temp.assert_ok((select value->>'notes'='new' from public.kv where key='1'),'migration preserves existing cloud');
select public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','delete');
select pg_temp.assert_ok(public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','patch','{"finding":"late"}','{"finding":"fresh"}',array['finding'])->>'status'='deleted','delete blocks enrichment');
select pg_temp.assert_ok(public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','provenance','{"paper":{"id":"1"},"project":{"id":"other"}}')->>'status'='deleted','delete blocks bridge resurrection');
select pg_temp.assert_ok(public.import_library_batch('11111111-1111-1111-1111-111111111111','[{"user_id":"11111111-1111-1111-1111-111111111111","collection":"papers","key":"1","value":{"id":"1"}}]')=0,'delete blocks resumed migration');
select pg_temp.assert_ok(public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','restore','{"id":"1","notes":"explicit new save"}')->>'status'='added','explicit user save restores');
select pg_temp.assert_ok(public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','patch','{"finding":"late stale"}','{"finding":"fresh"}',array['finding'])->>'status'='deleted','restored paper rejects prior incarnation enrichment');
select public.mutate_library_paper('11111111-1111-1111-1111-111111111111','','clear');
select pg_temp.assert_ok(public.mutate_library_paper('11111111-1111-1111-1111-111111111111','1','create','{"id":"1"}')->>'status'='deleted','clear blocks stale create');
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222',true);
select pg_temp.assert_ok((select count(*)=0 from public.kv),'cross-account read denied');
select pg_temp.assert_ok(public.mutate_library_paper('22222222-2222-2222-2222-222222222222','1','create','{"id":"1","notes":"Bob"}')->>'status'='added','other owner independent');
rollback;
