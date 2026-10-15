"""Disposable localhost DB only. Parallel NPI retries and mixed invite/NPI last-slot race."""
import os, subprocess, concurrent.futures, json
assert os.environ.get('PGHOST') in ('localhost','127.0.0.1','::1')
assert os.environ.get('PGDATABASE') == 'verastar_beta_admin_test'
PSQL='/opt/homebrew/opt/postgresql@16/bin/psql'
def sql(q):
    return subprocess.check_output([PSQL,'-XAt','-v','ON_ERROR_STOP=1','-c',q],text=True).strip()
def user(i): return f'd0000000-0000-0000-0000-{i:012d}'
ids=','.join(f"('{user(i)}',now(),'{{\"npi_match\":{{\"version\":1,\"npi\":\"1234567893\",\"physician\":true}}}}')" for i in range(1,5))
sql(f"insert into auth.users(id,email_confirmed_at,raw_app_meta_data) values {ids}; insert into public.sponsor_config(id,default_daily_cap_usd,default_monthly_cap_usd,global_monthly_ceiling_usd,enrollment_limit,enrollment_paused,npi_enrollment_enabled) values(true,1,5,30,1,false,true);")
try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        result=list(pool.map(lambda _: json.loads(sql(f"select public.enroll_npi_beta('{user(1)}')"))['status'],range(12)))
    assert result.count('enrolled')==1 and result.count('already')==11,result
    assert sql('select count(*) from public.sponsored_accounts')=='1'
    sql("update public.sponsor_config set enrollment_limit=2; insert into public.sponsor_invites(code,cohort,max_uses) values('CONCURRENCY','test',1)")
    calls=[f"select public.enroll_npi_beta('{user(2)}')",f"select public.redeem_sponsor_invite('CONCURRENCY','{user(3)}')"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        result=list(pool.map(lambda q:json.loads(sql(q))['status'],calls))
    assert sorted(result)==['enrolled','full'],result
    assert sql('select count(*) from public.sponsored_accounts')=='2'
    assert sql('select default_daily_cap_usd from public.sponsor_config')=='1.0000'
    print('PASS: 12 parallel retries produce one enrollment; mixed invite/NPI paths share the last-slot lock; caps unchanged.')
finally:
    sql("delete from public.sponsored_accounts; delete from public.sponsor_invites; delete from public.sponsor_config; delete from auth.users where id::text like 'd0000000-%'")
