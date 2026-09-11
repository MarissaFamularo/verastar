"""Run only against a disposable PostgreSQL database containing the library migration.
Usage: PGHOST=<local socket> PGPORT=... PGUSER=... PGDATABASE=storage_test python3 ...
Two real connections block on the library lock and then preserve disjoint edits.
"""
import os
import subprocess
import time

PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@16/bin/psql')
OWNER = '11111111-1111-1111-1111-111111111111'
def sql(text):
    return subprocess.run([PSQL, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', text], check=True, text=True, capture_output=True).stdout.strip()
auth = f"set role authenticated; select set_config('request.jwt.claim.sub','{OWNER}',false);"
sql(f"insert into auth.users(id) values('{OWNER}') on conflict do nothing; insert into public.kv(user_id,collection,key,value) values('{OWNER}','papers','race','{{\"id\":\"race\",\"notes\":\"old\",\"finding\":\"old\"}}') on conflict do nothing;")
first = subprocess.Popen([PSQL, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', auth + f"begin; select public.mutate_library_paper('{OWNER}','race','patch','{{\"notes\":\"new note\"}}','{{\"notes\":\"old\"}}',array['notes']); select pg_sleep(0.5); commit;"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
time.sleep(0.12)
second = sql(auth + f"select public.mutate_library_paper('{OWNER}','race','patch','{{\"finding\":\"new evidence\"}}','{{\"finding\":\"old\"}}',array['finding']);")
output, error = first.communicate(timeout=5)
assert first.returncode == 0, error
assert 'new note' in second and 'new evidence' in second, second
# A delete wins before a waiting enrichment; the pending patch must report deleted.
first = subprocess.Popen([PSQL, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', auth + f"begin; select public.mutate_library_paper('{OWNER}','race','delete'); select pg_sleep(0.5); commit;"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
time.sleep(0.12)
second = sql(auth + f"select public.mutate_library_paper('{OWNER}','race','patch','{{\"finding\":\"too late\"}}','{{\"finding\":\"new evidence\"}}',array['finding']);")
output, error = first.communicate(timeout=5)
assert first.returncode == 0, error
assert 'deleted' in second, second
assert sql(f"select count(*) from public.kv where user_id='{OWNER}' and key='race'") == '0'
print('PASS: real concurrent note/evidence edits preserve both; delete prevents waiting enrichment.')
