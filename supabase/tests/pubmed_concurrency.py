"""Disposable localhost DB only. Independent service-role sessions race for one probe."""
import concurrent.futures
import os
import subprocess

assert os.environ.get('PGHOST') in ('127.0.0.1', 'localhost', '::1'), 'local DB required'
assert os.environ.get('PGDATABASE', '').startswith('verastar_outage'), 'disposable DB required'
PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@16/bin/psql')

def sql(statement):
    return subprocess.run([PSQL, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', statement],
                          check=True, capture_output=True, text=True).stdout.strip()

def claim(_):
    return sql("begin; set local role service_role; select public.pubmed_search_claim(); select pg_sleep(0.05); commit;").strip()

sql("update private.pubmed_circuit set token=null,lease_until=null,next_probe_at=now()-interval '1 second',failures=0")
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
    results = list(pool.map(claim, range(12)))
winners = [t for t in results if t]
assert len(winners) == 1, results
print('PASS: 12 concurrent sessions admit exactly one PubMed search')
# An outage's retry gate survives every contender and every new connection.
sql(f"select public.pubmed_search_finish('{winners[0]}','unavailable',0)")
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
    assert all(not t for t in pool.map(claim, range(12)))
print('PASS: 12 concurrent sessions dispatch no searches during cooldown')
