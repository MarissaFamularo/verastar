"""Real-connection concurrency tests for reservations, scheduler claims and invitations.

Run ONLY against a disposable database that has the fixture and migrations applied
(supabase/tests/run_spending_tests.sh does this). Each scenario launches many separate
psql processes at once; each holds its transaction open briefly after the RPC so the
callers genuinely overlap. All amounts are TEST FIXTURES.
"""
import os
import subprocess
import threading
import time
import uuid

PSQL = os.environ.get('PSQL', '/opt/homebrew/opt/postgresql@16/bin/psql')


def sql(text):
    return subprocess.run([PSQL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-c', text], check=True, text=True, capture_output=True).stdout.strip()


def service(stmt, hold=0.2):
    # One transaction as the service role: run the statement, keep the transaction (and any
    # lock it took) open for `hold` seconds, commit.
    return sql(f"begin; set local role service_role; {stmt}; select pg_sleep({hold}); commit;").splitlines()[0]


def parallel(statements, hold=0.2):
    out = [None] * len(statements)
    gate = threading.Barrier(len(statements))

    def run(i, s):
        gate.wait()
        out[i] = service(s, hold)

    threads = [threading.Thread(target=run, args=(i, s)) for i, s in enumerate(statements)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return out


def users(n):
    ids = [str(uuid.uuid4()) for _ in range(n)]
    sql('insert into auth.users(id) values ' + ','.join(f"('{u}')" for u in ids))
    return ids


def reserve(u, rid, micro, fp='a' * 64):
    return f"select public.spend_reserve('{u}','{rid}','{fp}','claude-sonnet-5-5','t','proxy',{micro},1,1)->>'status'"


def reset_spending():
    sql("""truncate public.spend_reservations, public.spend_overruns, public.spend_audit;
           delete from public.model_spend;
           delete from public.sponsor_config;
           insert into public.sponsor_config (id, default_daily_cap_usd, default_monthly_cap_usd, global_monthly_ceiling_usd,
             spending_paused, beta_budget_usd, beta_budget_starts_at, enrollment_paused, enrollment_limit)
           values (true, 3.0, 25.0, 1000.0, false, 5000.0, now() - interval '1 day', false, 1000);""")


passed = []


def check(cond, label):
    assert cond, 'FAIL: ' + label
    passed.append(label)
    print('ok:', label)


# 1. Twenty simultaneous reservations for one account against a 3.00 daily cap.
reset_spending()
[a] = users(1)
sql(f"insert into public.sponsored_accounts(user_id, active) values ('{a}', true)")
res = parallel([reserve(a, f'same-acct-{i:03d}', 300_000) for i in range(20)])
check(res.count('reserved') == 10 and res.count('denied') == 10, 'same account: exactly 10 of 20 x $0.30 fit a $3.00 daily cap')
check(sql(f"select sum(reserved_micro) from public.spend_reservations where user_id='{a}'") == '3000000', 'same account: reserved total equals the cap, never above')

# 2. Twenty accounts at once against a shared 1.00 global ceiling.
reset_spending()
sql("update public.sponsor_config set global_monthly_ceiling_usd = 1.0")
many = users(20)
sql('insert into public.sponsored_accounts(user_id, active) values ' + ','.join(f"('{u}', true)" for u in many))
res = parallel([reserve(u, f'cross-acct-{i:03d}', 100_000) for i, u in enumerate(many)])
check(res.count('reserved') == 10, 'different accounts: exactly 10 of 20 x $0.10 fit a $1.00 global ceiling')

# 3. The total beta budget is shared the same way.
reset_spending()
sql("update public.sponsor_config set beta_budget_usd = 0.5")
res = parallel([reserve(u, f'budget-{i:03d}', 100_000) for i, u in enumerate(many)])
check(res.count('reserved') == 5, 'different accounts: exactly 5 of 20 x $0.10 fit a $0.50 total budget')

# 4. One request id sent ten times at once dispatches once.
reset_spending()
res = parallel([reserve(a, 'dup-request-0001', 1000) for _ in range(10)])
check(res.count('reserved') == 1 and res.count('duplicate') == 9, 'concurrent duplicate request id: one reservation, nine duplicates')
res = parallel([reserve(a, 'dup-request-0002', 1000, fp=f'{i:x}' * 64) for i in range(1, 6)])
check(res.count('reserved') == 1 and res.count('mismatch') == 4, 'concurrent reused id with different bodies: one reservation, four mismatches')

# 5. Concurrent settlement of one reservation records one ledger row.
rid = sql("select id from public.spend_reservations where request_id='dup-request-0001'")
res = parallel([f"select public.spend_settle('{rid}', 700, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status'" for _ in range(6)])
check(res.count('settled') == 1 and res.count('already_settled') == 5, 'concurrent duplicate settlement: settled once')
check(sql(f"select count(*) from public.model_spend where reservation_id='{rid}'") == '1', 'exactly one ledger row for the reservation')

# 6. Ten scheduler ticks claim one account at once.
sql(f"insert into public.digest_schedules(user_id) values ('{a}') on conflict do nothing")
res = parallel([f"select coalesce(public.digest_claim('{a}', 240)::text, 'none')" for _ in range(10)])
check(sum(1 for r in res if r != 'none') == 1, 'concurrent claims: exactly one owner token')

# 7. A stale owner's in-flight fenced write beats a takeover; the takeover then sees a fresh claim.
token = [r for r in res if r != 'none'][0]
sql(f"update public.digest_schedules set claimed_at = now() - interval '10 minutes' where user_id='{a}'")
writer = subprocess.Popen([PSQL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-c',
                           f"begin; set local role service_role; select public.scheduler_kv_write('{a}','{token}','digests','daily:latest','{{\"v\":1}}',false); select pg_sleep(0.5); commit;"],
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
time.sleep(0.15)
taken = service(f"select coalesce(public.digest_claim('{a}', 240)::text, 'none')", hold=0)
out, err = writer.communicate(timeout=10)
check(writer.returncode == 0 and out.splitlines()[0] == 't', 'owner write committed')
check(taken == 'none', 'takeover waited for the fenced write and then saw a fresh claim')

# 8. The last use of a code, redeemed by ten accounts at once.
reset_spending()
sql("insert into public.sponsor_invites(code, cohort, max_uses) values ('RACE-LAST', 'race', 1), ('RACE-A', 'race', 50), ('RACE-B', 'race', 50), ('RACE-CAP', 'race', 50)")
fresh = users(10)
res = parallel([f"select public.redeem_sponsor_invite('RACE-LAST','{u}')->>'status'" for u in fresh])
check(res.count('enrolled') == 1 and res.count('exhausted') == 9, 'last use: exactly one enrollment')

# 9. One account redeems two different codes at once, five times over.
[solo] = users(1)
res = parallel([f"select public.redeem_sponsor_invite('{c}','{solo}')->>'status'" for c in ['RACE-A', 'RACE-B'] * 5])
check(res.count('enrolled') == 1 and res.count('already') == 9, 'one account, two codes concurrently: enrolled once')
check(sql("select sum(uses) from public.sponsor_invites where code in ('RACE-A','RACE-B')") == '1', 'one use consumed in total')

# 10. Enrollment limit under concurrency.
active = int(sql("select count(*) from public.sponsored_accounts where active and (ends_at is null or ends_at > now())"))
sql(f"update public.sponsor_config set enrollment_limit = {active + 3}")
more = users(10)
res = parallel([f"select public.redeem_sponsor_invite('RACE-CAP','{u}')->>'status'" for u in more])
check(res.count('enrolled') == 3 and res.count('full') == 7, 'enrollment limit: exactly 3 of 10 concurrent new accounts')

# 11. A scheduler reservation racing a takeover of a stale claim, ten rounds. Each round
# either admits the attempt (which renews the lease, so every takeover fails) or loses to
# exactly one takeover (and the attempt reserves nothing). Never both, never neither.
reset_spending()
[w] = users(1)
sql(f"insert into public.sponsored_accounts(user_id, active) values ('{w}', true); insert into public.digest_schedules(user_id) values ('{w}')")
outcomes = set()
for rnd in range(10):
    token = service(f"select public.digest_claim('{w}', 240)", hold=0)
    sql(f"update public.digest_schedules set claimed_at = now() - interval '10 minutes' where user_id='{w}'")
    stmts = [f"select public.spend_reserve('{w}','race-{rnd}-res',repeat('d',64),'claude-sonnet-5-5','t','scheduler',1000,1,1,'{token}')->>'status'"]
    # Odd rounds give the attempt a head start so both serializations are exercised.
    delay = 'do $$ begin perform pg_sleep(0.05); end $$; ' if rnd % 2 else ''
    stmts += [f"{delay}select coalesce(public.digest_claim('{w}', 240)::text, 'none')" for _ in range(5)]
    res = parallel(stmts)
    admitted = res[0] == 'reserved'
    takeovers = sum(1 for r in res[1:] if r != 'none')
    check((admitted and takeovers == 0) or (not admitted and takeovers == 1), f'round {rnd}: attempt admitted XOR one takeover ({res[0]}, {takeovers})')
    outcomes.add(admitted)
    # An admitted attempt settles, as a live worker's would. (Left 'reserved' it would hold the
    # account, and every later round would be refused: 20261010130000_scheduler_hold.sql.)
    if admitted:
        rid = sql(f"select id from public.spend_reservations where user_id='{w}' and request_id='race-{rnd}-res'")
        service(f"select public.spend_settle('{rid}', 1, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status'", hold=0)
    # Release whichever claim is current for the next round.
    sql(f"update public.digest_schedules set claimed_at = null, claim_token = null where user_id='{w}'")

check(outcomes == {True, False}, 'both orderings occurred across rounds')

# 12. Cron and manual claim the same account at once, then each tries to spend with what it got.
[m] = users(1)
sql(f"insert into public.sponsored_accounts(user_id, active) values ('{m}', true); insert into public.digest_schedules(user_id) values ('{m}')")
tokens = parallel([f"select coalesce(public.digest_claim('{m}', 240)::text, 'none')" for _ in range(2)])
spend = parallel([
    f"select public.spend_reserve('{m}','overlap-{i}',repeat('d',64),'claude-sonnet-5-5','t','scheduler',1000,1,1,{('null' if t == 'none' else repr(t))}::uuid)->>'status'"
    for i, t in enumerate(tokens)
])
check(sum(1 for t in tokens if t != 'none') == 1 and spend.count('reserved') == 1, 'cron/manual overlap: one claim, one admitted attempt')

# ---- Scheduler hold and recovery (20261010130000_scheduler_hold.sql) --------------------------------


def sched_reserve(u, rid, token):
    return f"select coalesce(r->>'reason', r->>'status') from (select public.spend_reserve('{u}','{rid}',repeat('d',64),'claude-sonnet-5-5','t','scheduler',1000,1,1,'{token}') as r) x"


def recover(u, action='resume'):
    return f"select coalesce(r->>'reason', r->>'status') from (select public.scheduler_recover('{u}','{action}','concurrency test recovery') as r) x"


def held(u):
    return service(f"select coalesce(public.scheduler_hold_reason('{u}'), 'free')", hold=0)


def held_account(reconciled=True):
    """A sponsored, scheduled account whose one scheduler attempt ended ambiguous (and, by default, was reconciled). No claim is left."""
    [u] = users(1)
    sql(f"insert into public.sponsored_accounts(user_id, active) values ('{u}', true); insert into public.digest_schedules(user_id) values ('{u}')")
    token = service(f"select public.digest_claim('{u}', 240)", hold=0)
    assert service(sched_reserve(u, 'held-first-0001', token), hold=0) == 'reserved'
    rid = sql(f"select id from public.spend_reservations where user_id='{u}' and request_id='held-first-0001'")
    service(f"select public.spend_mark_ambiguous('{rid}', 'timeout', null)->>'status'", hold=0)
    service(f"select public.digest_claim_finish('{u}', '{token}', false, 'held')", hold=0)
    if reconciled:
        service(f"select public.spend_reconcile('{rid}', 1000, 'concurrency test: reconciled')->>'status'", hold=0)
    return u, rid


# 13. Six operators recover one held account at once: one recovery, one audit row.
reset_spending()
u, _ = held_account()
res = parallel([recover(u) for _ in range(6)])
check(res.count('recovered') == 1 and res.count('not_held') == 5, 'concurrent recoveries: exactly one recovers, the rest find nothing held')
check(sql(f"select count(*) from public.spend_audit where action='scheduler_recover' and detail->>'user_id'='{u}'") == '1', 'exactly one recovery audit row')

# 14. Recovery racing claim acquisition, ten rounds. Either a tick claims first (recovery is then
# refused as run_in_progress, the account stays held, and that tick's attempt is refused), or the
# recovery lands first (then exactly one tick claims and its attempt is admitted). A paid attempt
# is admitted if and only if a recovery succeeded. Never without one.
orders = set()
for rnd in range(10):
    u, _ = held_account()
    delay = 'do $$ begin perform pg_sleep(0.05); end $$; '
    stmts = [(delay if rnd % 2 else '') + recover(u) for _ in range(2)]
    stmts += [('' if rnd % 2 else delay) + f"select coalesce(public.digest_claim('{u}', 240)::text, 'none')" for _ in range(4)]
    res = parallel(stmts)
    recovered = res[:2].count('recovered')
    tokens = [r for r in res[2:] if r != 'none']
    check(recovered <= 1 and len(tokens) == 1, f'recover/claim round {rnd}: at most one recovery, exactly one claim ({res[:2]}, {len(tokens)} claim)')
    attempt = service(sched_reserve(u, f'after-race-{rnd}', tokens[0]), hold=0)
    if recovered:
        # The losing recovery finds nothing held, or (if the tick claimed in between) a run in progress.
        other = [r for r in res[:2] if r != 'recovered']
        check(len(other) == 1 and other[0] in ('not_held', 'run_in_progress') and attempt == 'reserved' and held(u) == 'unresolved_liability', f'round {rnd}: recovery first ({other[0] if other else "?"} for the other), then the claiming tick is admitted (its in-flight attempt now counts)')
    else:
        check(set(res[:2]) == {'run_in_progress'} and attempt == 'unresolved_liability' and held(u) == 'unresolved_liability', f'round {rnd}: claim first, recovery refused, and the claim alone cannot spend')
    orders.add(bool(recovered))
check(orders == {True, False}, 'recover/claim: both orderings occurred across rounds')

# 15. Recovery racing the reconciliation it depends on, ten rounds. If the recovery runs first it
# is refused (unresolved) and the later reconciliation leaves the account held. If the
# reconciliation runs first the recovery releases it. The account is free only when a recovery
# succeeded, and a successful recovery never leaves anything unresolved or unreleased.
orders = set()
for rnd in range(10):
    u, rid = held_account(reconciled=False)
    delay = 'do $$ begin perform pg_sleep(0.05); end $$; '
    res = parallel([
        (delay if rnd % 2 else '') + recover(u),
        ('' if rnd % 2 else delay) + f"select public.spend_reconcile('{rid}', 1000, 'concurrency test: reconciled')->>'status'",
    ])
    state = sql(f"select state || ':' || (recovered_at is not null)::text from public.spend_reservations where id='{rid}'")
    ok = (res == ['recovered', 'reconciled'] and held(u) == 'free' and state == 'reconciled:true') or \
         (res == ['unresolved_liability', 'reconciled'] and held(u) == 'unresolved_liability' and state == 'reconciled:false')
    check(ok, f'recover/reconcile round {rnd}: {res[0]}, account {held(u)}, reservation {state}')
    orders.add(res[0])
check(orders == {'recovered', 'unresolved_liability'}, 'recover/reconcile: both orderings occurred across rounds')

# 16. A reconciliation made inside a transaction that was opened BEFORE the recovery. Its
# resolved_at is that old transaction's start time, earlier than the acknowledgement, so a rule
# that compared the two timestamps would call the account free. The stamp on the reservation
# does not: a NEW unresolved attempt reconciled this way still holds the account.
u, _ = held_account()
old_session = subprocess.Popen([PSQL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-c',
                                f"begin; set local role service_role; select now(); select pg_sleep(1.2); "
                                f"select public.spend_reconcile((select id from public.spend_reservations where user_id='{u}' and request_id='held-late-0002'), 1000, 'concurrency test: reconciled in an old session')->>'status'; commit;"],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
time.sleep(0.3)
check(service(recover(u), hold=0) == 'recovered' and held(u) == 'free', 'old-session case: the account is recovered while another session sits open')
token = service(f"select public.digest_claim('{u}', 240)", hold=0)
check(service(sched_reserve(u, 'held-late-0002', token), hold=0) == 'reserved', 'old-session case: the released run makes a new attempt')
late = sql(f"select id from public.spend_reservations where user_id='{u}' and request_id='held-late-0002'")
service(f"select public.spend_mark_ambiguous('{late}', 'timeout', null)->>'status'", hold=0)
service(f"select public.digest_claim_finish('{u}', '{token}', false, 'held')", hold=0)
out, err = old_session.communicate(timeout=15)
check(old_session.returncode == 0 and out.splitlines()[-1] == 'reconciled', 'old-session case: the open session reconciles the NEW attempt')
check(sql(f"select (r.resolved_at < s.recovery_ack_at)::text from public.spend_reservations r, public.digest_schedules s where r.id='{late}' and s.user_id='{u}'") == 'true', 'old-session case: its resolved_at really is earlier than the acknowledgement')
check(held(u) == 'unresolved_liability', 'old-session case: the account is HELD (a timestamp comparison would have released it)')

# 17. Concurrent settlement and reconciliation of a released hold each write one charge.
reset_spending()
[rel] = users(1)
sql(f"insert into public.sponsored_accounts(user_id, active) values ('{rel}', true)")
check(service(reserve(rel, 'released-settle', 50_000), hold=0) == 'reserved', 'released-settle reserved')
settle_id = sql("select id from public.spend_reservations where request_id='released-settle'")
check(service(f"select public.spend_release('{settle_id}', 'not_sent', null)->>'status'", hold=0) == 'released', 'released-settle released')
res = parallel([f"select public.spend_settle('{settle_id}', 1234, 'claude-sonnet-5-5', 1, 1, 0, 0, null, null)->>'status'" for _ in range(6)])
check(res.count('settled') == 1 and res.count('already_settled') == 5, 'concurrent settlement of a released row: one charge')
check(sql(f"select count(*) || ':' || (sum(usd) * 1000000)::bigint from public.model_spend where reservation_id='{settle_id}'") == '1:1234', 'one ledger row at the confirmed amount')
check(service(reserve(rel, 'released-recon', 50_000), hold=0) == 'reserved', 'released-recon reserved')
recon_id = sql("select id from public.spend_reservations where request_id='released-recon'")
check(service(f"select public.spend_release('{recon_id}', 'not_sent', null)->>'status'", hold=0) == 'released', 'released-recon released')
res = parallel([f"select public.spend_reconcile('{recon_id}', 800, 'concurrency test: charge confirmed after release')->>'status'" for _ in range(6)])
check(res.count('reconciled') == 1 and res.count('already_reconciled') == 5, 'concurrent reconciliation of a released row: one charge')
check(sql(f"select count(*) || ':' || (sum(usd) * 1000000)::bigint from public.model_spend where reservation_id='{recon_id}'") == '1:800', 'one reconciled ledger row')

# 18. Overlapping invite attempts for one user admit exactly the hourly limit.
[inv] = users(1)
res = parallel([f"select public.record_invite_attempt('{inv}')" for _ in range(20)])
check(res.count('allow') == 5 and res.count('deny') == 15, 'invite limit: exactly 5 of 20 overlapping attempts are admitted')
check(sql(f"select count(*) from public.invite_attempts where user_id='{inv}'") == '5', 'invite limit: denied attempts are not recorded')

print(f'PASS: spending_concurrency.py ({len(passed)} checks)')
