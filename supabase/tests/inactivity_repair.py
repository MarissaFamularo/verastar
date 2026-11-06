"""Exercise the reviewed repair and same-digest races in a disposable local DB."""
import concurrent.futures
import os
from pathlib import Path
import subprocess

assert os.environ.get('PGHOST') in ('127.0.0.1', 'localhost', '::1'), 'local DB required'
assert os.environ.get('PGDATABASE', '').startswith('verastar_'), 'disposable DB required'
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@16/bin/psql')
REPAIR = Path('supabase/repairs/reset_inactivity_20261106.sql').read_text()


def sql(statement, success=True):
    result = subprocess.run([PSQL, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1'],
                            input=statement, capture_output=True, text=True)
    if success:
        assert result.returncode == 0, result.stderr
    else:
        assert result.returncode != 0, 'unsafe repair unexpectedly accepted'
    return result.stdout.strip(), result.stderr


FIXTURE = """
begin isolation level serializable;
create temp table cohort as select n,
 ('f2000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid id from generate_series(1,45) n;
insert into auth.users(id) select id from cohort;
insert into public.digest_schedules(user_id,enabled,email_digest,unopened_streak,paused_at)
select id,n<>45,n<>25,case when n<=29 then 6 when n<=32 then 3 else 0 end,
 case when n<=13 then '2026-11-02T11:00Z'::timestamptz
      when n<=20 or n between 25 and 29 then '2026-11-05T11:00Z'::timestamptz end from cohort;
insert into public.events(user_id,ts,type,payload)
select id,'2026-11-02T11:00Z','digest_paused','{"streak":7}' from cohort where n<=24;
insert into public.events(user_id,ts,type,payload)
select id,'2026-11-05T11:00Z','digest_paused','{"streak":7}' from cohort where n between 25 and 29;
insert into public.kv(user_id,collection,key,value)
select id,'digests','daily:latest','{"kind":"daily","ranAt":"2026-11-04T10:00:00Z","results":[{}]}' from cohort;
create temp table original as select * from public.digest_schedules;
select set_config('verastar.inactivity_repair_manifest',jsonb_build_object(
 'cutoff','2026-11-03T05:00:00Z','total_count',45,'protected_count',24,'eligible_count',21,'resume_count',5,'nonzero_count',8,
 'protected_ids',(select jsonb_agg(id order by id) from cohort where n<=24),
 'eligible_ids',(select jsonb_agg(id order by id) from cohort where n>24),
 'resume_ids',(select jsonb_agg(id order by id) from cohort where n between 25 and 29),
 'preferences',(select jsonb_object_agg(user_id::text,jsonb_build_object('enabled',enabled,'email_digest',email_digest)) from public.digest_schedules),
 'pause_times',(select jsonb_object_agg(s.user_id::text,s.paused_at) from public.digest_schedules s join cohort c on c.id=s.user_id where n between 25 and 29)
)::text,true);
"""
ASSERT = """
do $$begin
 if exists(select 1 from public.digest_schedules s join cohort c on c.id=s.user_id
   join original o on o.user_id=s.user_id where c.n<=24 and to_jsonb(s)<>to_jsonb(o)) then raise exception 'protected row changed'; end if;
 if exists(select 1 from public.digest_schedules s join cohort c on c.id=s.user_id
   where c.n>24 and (unopened_streak<>0 or paused_at is not null or inactivity_counted_at is distinct from '2026-11-04T10:00Z'::timestamptz)) then raise exception 'eligible reset failed'; end if;
 if exists(select 1 from public.digest_schedules s join original o using(user_id)
   where (to_jsonb(s)-array['unopened_streak','inactivity_counted_at','paused_at','updated_at']) <>
         (to_jsonb(o)-array['unopened_streak','inactivity_counted_at','paused_at','updated_at'])) then raise exception 'unrelated state changed'; end if;
end$$;
rollback;
"""
sql(FIXTURE + REPAIR + ASSERT)
print('PASS: repair resets 8 counters, resumes 5, baselines 21; all 24 protected rows and opt-outs untouched')
for mutation, expected in [
    ("update public.digest_schedules set email_digest=false where user_id=(select id from cohort where n=26);", 'preferences changed'),
    ("insert into public.events(user_id,ts,type) select id,'2026-11-02T12:00Z','digest_pause_emailed' from cohort where n=30;", 'protected cohort changed'),
    ("update public.digest_schedules set paused_at='2026-11-05T12:00Z' where user_id=(select id from cohort where n=30);", 'current pause set changed'),
    ("update public.digest_schedules set claim_token=gen_random_uuid(),claimed_at=now() where user_id=(select id from cohort where n=30);", 'active/stale claim'),
    ("delete from public.events where user_id=(select id from cohort where n=25);", 'resume origin'),
]:
    _, err = sql(FIXTURE + mutation + REPAIR, success=False)
    assert expected in err, err
    print('PASS: repair rolls back on ' + expected)

USER = 'f3000000-0000-0000-0000-000000000001'
VERSION = '''{"kind":"daily","runBy":"scheduler","ranAt":"2026-11-04T10:00:00Z","savedAt":null,"phase":"done","finishedAt":null,"openedAt":null,"papers":1}'''
try:
    sql(f"insert into auth.users(id) values('{USER}'); insert into public.digest_schedules(user_id,unopened_streak) values('{USER}',2); insert into public.kv(user_id,collection,key,value) values('{USER}','digests','daily:latest','{{\"kind\":\"daily\",\"runBy\":\"scheduler\",\"ranAt\":\"2026-11-04T10:00:00Z\",\"server\":{{\"phase\":\"done\"}},\"results\":[{{}}]}}');")
    token, _ = sql(f"select public.digest_claim('{USER}',240)")

    def contender(_):
        return sql(f"begin; set local role service_role; select public.digest_inactivity_update('{USER}','{token}',2,null,null,null,'{VERSION}',3,'2026-11-04T10:00Z',false,false); select pg_sleep(0.03); commit;")[0]

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(contender, range(8)))
    assert results.count('t') == 1 and results.count('f') == 7, results
    result, _ = sql(f"select unopened_streak=3 and inactivity_counted_at='2026-11-04T10:00Z' from public.digest_schedules where user_id='{USER}'")
    assert result == 't'
    print('PASS: 8 concurrent service-role sessions count one digest exactly once')
finally:
    sql(f"delete from auth.users where id='{USER}'")
