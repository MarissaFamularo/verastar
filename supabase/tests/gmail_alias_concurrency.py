"""Parallel calls against a disposable local database.

Twelve overlapping lookups for one inbox must return at most eight hints.
Twenty-four overlapping lookups from one client address, each for a different
inbox, must return at most twenty. Each call holds its transaction open so the
callers actually overlap; the bucket row lock is what serializes the count.

Run only via supabase/tests/run_gmail_alias_tests.sh.
"""
import os
import subprocess
import threading

PSQL = os.environ.get('PSQL', 'psql')


def sql(text):
    return subprocess.run(
        [PSQL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-c', text],
        check=True, text=True, capture_output=True,
    ).stdout.strip()


def call(email, hold=0.15):
    # One transaction as anon. The function locks the bucket row until commit,
    # and pg_sleep keeps that lock while the other callers are already waiting.
    statement = (
        "begin; set local role anon; "
        f"select public.gmail_alias_hint('{email}'); "
        f"select pg_sleep({hold}); commit;"
    )
    return subprocess.run(
        [PSQL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement],
        check=True, text=True, capture_output=True,
    ).stdout.strip().splitlines()[0]


def parallel(emails, hold=0.15):
    out = [None] * len(emails)
    errors = [None] * len(emails)
    gate = threading.Barrier(len(emails))

    def run(i, email):
        gate.wait()
        try:
            out[i] = call(email, hold)
        except subprocess.CalledProcessError as err:
            errors[i] = err.stderr or err.stdout or str(err)

    threads = [threading.Thread(target=run, args=(i, email)) for i, email in enumerate(emails)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    failed = [err for err in errors if err]
    if failed:
        raise AssertionError(failed[0])
    return out


def compact(row):
    return row.replace(' ', '')


def hints(rows):
    return [row for row in rows if '"match":true' in compact(row)]


def misses(rows):
    return [row for row in rows if '"match":false' in compact(row)]


passed = []


def check(cond, label, detail=''):
    assert cond, 'FAIL: ' + label + ('\n' + detail if detail else '')
    passed.append(label)
    print('ok:', label)


sql("insert into auth.users (email, created_at) values ('famularomarissa@gmail.com', now() - interval '2 days')")

inbox = parallel(['famularo.marissa@gmail.com'] * 12)
check(len(hints(inbox)) == 8, 'one inbox: exactly 8 of 12 overlapping lookups return a hint', '\n'.join(inbox))
check(len(misses(inbox)) == 4, 'one inbox: the other 4 return match false', '\n'.join(inbox))
check(all('f…@gmail.com' in row for row in hints(inbox)), 'one inbox: every hint is the one-character mask')
check(all('hint' not in row for row in misses(inbox)), 'one inbox: a limited lookup carries no hint')
check('famularomarissa@gmail.com' not in '\n'.join(inbox), 'one inbox: the stored address is not in the response')

sql('truncate private.gmail_alias_limits')
stored = ','.join(f"('u{i:02d}@gmail.com', now() - interval '1 day')" for i in range(24))
sql(f'insert into auth.users (email, created_at) values {stored}')
clients = parallel([f'u.{i:02d}@gmail.com' for i in range(24)])
check(len(hints(clients)) == 20, 'one client address: exactly 20 of 24 overlapping lookups return a hint', '\n'.join(clients))
check(len(misses(clients)) == 4, 'one client address: the other 4 return match false', '\n'.join(clients))
check(all('u…@gmail.com' in row for row in hints(clients)), 'one client address: every hint is the one-character mask')

print(f'PASS: {len(passed)} gmail alias concurrency checks')
