// Runtime validation of the spending contract on a LOCAL Supabase stack, with synthetic
// identities, synthetic data and a fake provider. Never touches a linked or hosted project,
// never fetches PubMed/PMC/CT.gov, never calls Anthropic.
//
//   node scripts/local-stack-spending-test.mjs
//
// PREREQUISITES (none were available where this was written, 2026-10-09; NOT YET EXECUTED):
//   - a container runtime the Supabase CLI can use (Docker Desktop, or a compatible engine);
//   - the Supabase CLI (2.104.0 here) and `psql` on PATH;
//   - on macOS, functions reach the fake provider at host.docker.internal.
//
// Guardrails:
//   - The stack runs from a throwaway OS temp workdir holding COPIES of supabase/migrations
//     and supabase/functions and a fresh `supabase init` config, with no .temp/project-ref,
//     so no command can resolve to the linked project. Every DB command passes --local.
//   - Refuses to continue unless `supabase status` reports API and DB URLs on loopback.
//   - Functions get ANTHROPIC_API_KEY=sk-fake-local and a provider override that
//     resolveProviderUrl() honors only on a local stack with a fake key and an http
//     loopback/docker-host target.
//
// Phase A — the cutover's first step, against the PRE-migration schema (the five earlier
// migrations only): the new functions must fail closed. model: 503, not retryable, zero
// provider requests. digest-run: 503 before claiming, zero provider requests. redeem-invite:
// "paused" because the contract marker is absent.
//
// Phase B — after `supabase migration up --local` applies the spending migration:
//   - grants through PostgREST (anon/authenticated cannot reserve or read the ledger);
//   - proxy: one settled call at the exact price, a 429 whose hold is released and is
//     not retryable, a cap denial with no dispatch, legacy cache miss vs trusted hit;
//   - scheduler, through the BUNDLED runner and PostgREST: a fresh foreign claim blocks the
//     tick with zero dispatches; a reservation with a wrong token is denied claim_lost; then
//     a real tick on the synthetic rank-phase digest makes exactly two paid attempts (triage
//     on Sonnet 5.5, prose check on Haiku 4.5) to the fake provider, both settled at the
//     exact micro-dollar price with ledger rows, persists the finished digest through the
//     claim fence, and releases its claim;
//   - redeem-invite: enrollment paused by default.
import { spawn, execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { profileFixture, rankPhaseDigest, fakeProviderReply, EXPECTED, PAPER_ID } from '../supabase/tests/fixtures/scheduledRankFixture.mjs'

const SPENDING_MIGRATION = '20261009120000_beta_spending_safeguards.sql'
// Migrations dated after the spending migration are held back with it and applied after it, in
// order: `supabase migration up` refuses a migration older than one already applied, and the
// scheduler-hold migration replaces functions the spending migration creates.
const AFTER_SPENDING = ['20261010120000_digest_write_guard.sql', '20261010130000_scheduler_hold.sql', '20261012180000_spend_release.sql']
let WORK = null // created only after the prerequisites pass
const sb = (...args) => execFileSync('supabase', [...args, '--workdir', WORK], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
const isLocal = (u) => { try { return ['127.0.0.1', 'localhost'].includes(new URL(u).hostname) } catch { return false } }
const results = []
const check = (ok, label, detail = '') => { results.push({ ok, label }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) process.exitCode = 1 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- prerequisites ---------------------------------------------------------------------------
for (const [bin, args] of [['supabase', ['--version']], ['psql', ['--version']], ['docker', ['info']]]) {
  try { execFileSync(bin, args, { stdio: 'ignore' }) } catch {
    console.error(`PREREQUISITE MISSING: \`${bin} ${args.join(' ')}\` failed. Nothing was started.`)
    process.exit(2)
  }
}

// --- workdir: pre-migration schema first -------------------------------------------------------
WORK = mkdtempSync(join(tmpdir(), 'verastar-local-stack-'))
mkdirSync(`${WORK}/supabase/migrations`, { recursive: true })
execFileSync('supabase', ['init', '--workdir', WORK], { stdio: 'inherit' })
for (const f of readdirSync('supabase/migrations')) {
  if (f !== SPENDING_MIGRATION && !AFTER_SPENDING.includes(f)) cpSync(`supabase/migrations/${f}`, `${WORK}/supabase/migrations/${f}`)
}
cpSync('supabase/functions', `${WORK}/supabase/functions`, { recursive: true })
if (existsSync(`${WORK}/supabase/.temp/project-ref`)) throw new Error('Refusing: the throwaway workdir is linked to a project.')

sb('start')
const status = JSON.parse(sb('status', '-o', 'json'))
const API = status.API_URL
const DB = status.DB_URL
if (!isLocal(API) || !isLocal(DB)) throw new Error(`Refusing: stack is not local (${API}, ${DB})`)
sb('db', 'reset', '--local')
const psql = (sql) => execFileSync('psql', [DB, '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim()

// --- fake provider ------------------------------------------------------------------------------
let mode = 'ok'
const received = []
const provider = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    // Counting is free. Answer it and do not treat it as a paid attempt.
    if (String(req.url).endsWith('/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ input_tokens: 400 }))
    }
    const request = JSON.parse(body)
    received.push(request)
    if (mode === '429') {
      res.writeHead(429, { 'content-type': 'application/json', 'request-id': 'req_fake_429' })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fake' } }))
    }
    const reply = request.output_config ? fakeProviderReply(request, received.length) : {
      status: 200,
      body: { id: `msg_fake_${received.length}`, type: 'message', role: 'assistant', model: request.model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1234, output_tokens: 56 } },
    }
    res.writeHead(reply.status, { 'content-type': 'application/json', 'request-id': `req_fake_${received.length}` })
    res.end(JSON.stringify(reply.body))
  })
})
await new Promise((r) => provider.listen(0, '127.0.0.1', r))

// --- functions ---------------------------------------------------------------------------------
const cron = randomUUID()
writeFileSync(`${WORK}/functions.env`, [
  'ANTHROPIC_API_KEY=sk-fake-local',
  `VERASTAR_TEST_PROVIDER_URL=http://host.docker.internal:${provider.address().port}/v1/messages`,
  `DIGEST_CRON_SECRET=${cron}`,
].join('\n'))
// Keep the CLI's import-map resolution inside the disposable project. An absolute
// path outside the caller's cwd is rewritten into an invalid traversal by the CLI.
const serve = spawn('supabase', ['functions', 'serve', '--env-file', 'functions.env', '--import-map', 'supabase/functions/deno.json', '--no-verify-jwt'], { cwd: WORK, stdio: 'inherit' })
const fn = (name, path = '') => `${API}/functions/v1/${name}${path}`
async function ready(name) {
  for (let i = 0; i < 60; i++) {
    if (serve.exitCode !== null) throw new Error(`Functions server exited before readiness (${serve.exitCode}).`)
    try { if ((await fetch(fn(name), { method: 'OPTIONS' })).status === 200) return true } catch { /* not up yet */ }
    await sleep(2000)
  }
  return false
}
const headers = (jwt) => ({ 'content-type': 'application/json', authorization: `Bearer ${jwt}`, apikey: status.ANON_KEY })
const body = { model: 'claude-haiku-4-5-20251001', max_tokens: 64, messages: [{ role: 'user', content: 'local stack' }] }

try {
  for (const name of ['model', 'digest-run', 'redeem-invite']) check(await ready(name), `${name} is serving`)

  // --- synthetic identities and the pre-migration fixture (TEST amounts) ------------------------
  const users = {}
  for (const name of ['alice', 'bob']) {
    const email = `${name}-${process.pid}@example.test`
    const password = randomUUID()
    const created = await (await fetch(`${API}/auth/v1/admin/users`, { method: 'POST', headers: { ...headers(status.SERVICE_ROLE_KEY), apikey: status.SERVICE_ROLE_KEY }, body: JSON.stringify({ email, password, email_confirm: true }) })).json()
    const session = await (await fetch(`${API}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: status.ANON_KEY }, body: JSON.stringify({ email, password }) })).json()
    users[name] = { id: created.id, jwt: session.access_token }
  }
  const A = users.alice.id
  const json = (v) => JSON.stringify(v).replaceAll("'", "''")
  psql(`insert into public.sponsor_config (id, default_daily_cap_usd, default_monthly_cap_usd, global_monthly_ceiling_usd) values (true, 10, 50, 100);
        insert into public.sponsored_accounts (user_id, active) values ('${A}', true);
        insert into public.digest_schedules (user_id, hour_local, timezone) values ('${A}', 0, 'UTC');
        insert into public.kv (user_id, collection, key, value) values
          ('${A}', 'profile', 'me', '${json(profileFixture())}'),
          ('${A}', 'digests', 'daily:latest', '${json(rankPhaseDigest())}');
        insert into public.sponsor_invites (code, cohort, max_uses) values ('LOCAL-1', 'local', 5);`)

  // ============================== Phase A: new functions, old schema ==============================
  const pre = await fetch(fn('model', '/v1/messages'), { method: 'POST', headers: headers(users.alice.jwt), body: JSON.stringify(body) })
  check(pre.status === 503 && pre.headers.get('x-should-retry') === 'false' && received.length === 0, 'pre-migration: model refuses (503, not retryable), zero provider requests', String(pre.status))
  const preRun = await fetch(fn('digest-run'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': cron } })
  check(preRun.status === 503 && received.length === 0, 'pre-migration: digest-run refuses before any paid attempt', String(preRun.status))
  check(psql(`select coalesce(claimed_at::text, 'none') from public.digest_schedules where user_id = '${A}'`) === 'none', 'pre-migration: digest-run did not claim the account')
  const preRedeem = await fetch(fn('redeem-invite'), { method: 'POST', headers: headers(users.bob.jwt), body: JSON.stringify({ code: 'LOCAL-1' }) })
  check(preRedeem.status === 503 && (await preRedeem.json()).status === 'paused', 'pre-migration: redeem-invite refuses as paused (no contract marker)')
  check(psql(`select count(*) from public.sponsored_accounts where user_id = '${users.bob.id}'`) === '0', 'pre-migration: nobody was enrolled')

  // ============================== Phase B: apply the spending migration ==============================
  cpSync(`supabase/migrations/${SPENDING_MIGRATION}`, `${WORK}/supabase/migrations/${SPENDING_MIGRATION}`)
  for (const f of AFTER_SPENDING) cpSync(`supabase/migrations/${f}`, `${WORK}/supabase/migrations/${f}`)
  sb('migration', 'up', '--local')
  check(psql(`select spending_paused and enrollment_paused and beta_budget_usd is null from public.sponsor_config`) === 't', 'migration lands paused with the budget unset')
  const paused = await fetch(fn('model', '/v1/messages'), { method: 'POST', headers: headers(users.alice.jwt), body: JSON.stringify(body) })
  check(paused.status === 402 && received.length === 0, 'post-migration, unconfigured: still refused, zero provider requests')
  psql(`update public.sponsor_config set spending_paused = false, beta_budget_usd = 100, beta_budget_starts_at = now() - interval '1 minute'`)

  // --- grants through PostgREST ----------------------------------------------------------------
  for (const [who, jwt] of [['anon', status.ANON_KEY], ['authenticated', users.bob.jwt]]) {
    const r = await fetch(`${API}/rest/v1/rpc/spend_reserve`, { method: 'POST', headers: headers(jwt), body: JSON.stringify({ p_user_id: users.bob.id, p_request_id: 'forged-0001', p_fingerprint: 'a'.repeat(64), p_model: 'claude-sonnet-5-5', p_purpose: 'x', p_source: 'proxy', p_reserve_micro: 1, p_max_input_tokens: 1, p_max_output_tokens: 1 }) })
    check([401, 403, 404].includes(r.status), `${who} cannot call spend_reserve through PostgREST`, String(r.status))
    const l = await fetch(`${API}/rest/v1/model_spend?select=usd`, { headers: headers(jwt) })
    check(l.status >= 400 || (await l.json()).length === 0, `${who} cannot read the ledger`)
  }

  // --- proxy ---------------------------------------------------------------------------------
  let base = received.length
  const ok = await fetch(fn('model', '/v1/messages'), { method: 'POST', headers: { ...headers(users.alice.jwt), 'x-verastar-request-id': 'local-0000001' }, body: JSON.stringify(body) })
  check(ok.status === 200 && received.length === base + 1, 'proxy dispatched once', String(ok.status))
  check(psql(`select state || ':' || actual_micro from public.spend_reservations where request_id = 'local-0000001'`) === 'settled:1514', 'proxy settled through PostgREST at the exact price (1234 x $1 + 56 x $5 per MTok)')
  check(psql(`select count(*) from public.model_spend where reservation_id = (select id from public.spend_reservations where request_id = 'local-0000001')`) === '1', 'one ledger row')
  mode = '429'
  base = received.length
  const err = await fetch(fn('model', '/v1/messages'), { method: 'POST', headers: { ...headers(users.alice.jwt), 'x-verastar-request-id': 'local-0000002' }, body: JSON.stringify(body) })
  check(err.status === 429 && err.headers.get('x-should-retry') === 'false' && /x-should-retry/i.test(err.headers.get('access-control-expose-headers') || ''), 'a provider 429 is passed through as not retryable, and the header is exposed to browsers')
  check(received.length === base + 1 && psql(`select state || ':' || actual_micro from public.spend_reservations where request_id = 'local-0000002'`) === 'released:0', 'one dispatch, the error hold is released')
  mode = 'ok'
  psql(`update public.sponsored_accounts set daily_cap_usd = 0.0001 where user_id = '${A}'`)
  base = received.length
  const capped = await fetch(fn('model', '/v1/messages'), { method: 'POST', headers: headers(users.alice.jwt), body: JSON.stringify(body) })
  check(capped.status === 402 && received.length === base, 'cap denial: 402, no provider request')
  psql(`update public.sponsored_accounts set daily_cap_usd = null where user_id = '${A}';
        select public.spend_reconcile((select id from public.spend_reservations where request_id = 'local-0000002'), 0, 'local test fixture: fake provider 429');`)
  check(psql(`select state from public.spend_reservations where request_id = 'local-0000002'`) === 'released', 'reconciling a released hold changes nothing')
  check(psql(`select count(*) from public.model_spend where request_id = 'local-0000002'`) === '0', 'a released hold has no ledger charge')
  const hash = 'f'.repeat(64)
  psql(`insert into public.evidence_cache (pmid, extraction_version, source_hash, source_tier, extraction, model) values ('L1', 'v-local', '${hash}', 'full_text', '{"legacy":true}', 'm')`)
  const legacy = await fetch(fn('model', '/v1/messages'), { method: 'POST', headers: { ...headers(users.alice.jwt), 'x-verastar-cache': `L1|v-local|${hash}|full_text` }, body: JSON.stringify(body) })
  check(legacy.headers.get('x-verastar-cache') === 'miss', 'a legacy cache row is a miss')
  psql(`insert into public.evidence_cache_trusted (pmid, extraction_version, source_hash, source_tier, extraction, model, provenance) values ('L1', 'v-local', '${hash}', 'full_text', '{"trusted":true}', 'm', '{"writer":"digest-run","bundle_source_sha256":"${'b'.repeat(64)}"}')`)
  const trusted = await fetch(fn('model', '/v1/messages'), { method: 'POST', headers: { ...headers(users.alice.jwt), 'x-verastar-cache': `L1|v-local|${hash}|full_text` }, body: JSON.stringify(body) })
  check(trusted.headers.get('x-verastar-cache') === 'hit', 'a trusted cache row is a hit')

  // --- scheduler through the bundled runner and PostgREST --------------------------------------
  psql(`update public.digest_schedules set claimed_at = now(), claim_token = gen_random_uuid() where user_id = '${A}'`)
  base = received.length
  const blocked = await (await fetch(fn('digest-run'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': cron } })).json()
  check(blocked.ran === false && blocked.reason === 'already running' && received.length === base, 'a fresh foreign claim blocks the tick: zero dispatches', JSON.stringify(blocked))
  const wrongToken = await fetch(`${API}/rest/v1/rpc/spend_reserve`, { method: 'POST', headers: { ...headers(status.SERVICE_ROLE_KEY), apikey: status.SERVICE_ROLE_KEY }, body: JSON.stringify({ p_user_id: A, p_request_id: 'local-sched-forged', p_fingerprint: 'd'.repeat(64), p_model: 'claude-sonnet-5-5', p_purpose: 'scheduled-digest', p_source: 'scheduler', p_reserve_micro: 1, p_max_input_tokens: 1, p_max_output_tokens: 1, p_claim_token: randomUUID() }) })
  check((await wrongToken.json())?.reason === 'claim_lost', 'PostgREST uuid mapping: a scheduler reservation with a wrong token is denied claim_lost')
  psql(`update public.digest_schedules set claimed_at = null, claim_token = null where user_id = '${A}'`)

  base = received.length
  const before = Number(psql(`select count(*) from public.spend_reservations where source = 'scheduler' and user_id = '${A}'`))
  const run = await fetch(fn('digest-run'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-cron-secret': cron } })
  const out = await run.json()
  check(run.status === 200 && out.ran === true && out.phase === 'done' && out.papers === 1 && out.claimLost === false, 'the bundled runner finished the synthetic rank-phase digest', JSON.stringify(out).slice(0, 300))
  const paid = received.slice(base)
  check(paid.length === 2 && paid[0].model === EXPECTED.triage.model && paid[1].model === EXPECTED.check.model, 'exactly two paid attempts reached the fake provider: triage (Sonnet 5.5), then the prose check (Haiku 4.5)', paid.map((b) => b.model).join(', '))
  const rows = psql(`select state || ':' || actual_micro || ':' || (reserved_micro >= actual_micro) from public.spend_reservations where source = 'scheduler' and user_id = '${A}' order by created_at`).split('\n').slice(before)
  check(rows.join(',') === `settled:${EXPECTED.triage.micro}:true,settled:${EXPECTED.check.micro}:true`, 'both scheduled attempts settled through PostgREST at the exact price, within their reservations', rows.join(','))
  check(psql(`select count(*) from public.model_spend m join public.spend_reservations r on r.id = m.reservation_id where r.source = 'scheduler' and r.user_id = '${A}'`) === String(before + 2), 'two ledger rows linked to the scheduled reservations')
  check(psql(`select value->'server'->>'phase' || ':' || (value->'triaged'->'${PAPER_ID}'->>'score') from public.kv where user_id = '${A}' and collection = 'digests' and key = 'daily:latest'`) === 'done:90', 'the finished digest was persisted through the claim fence')
  check(psql(`select coalesce(claim_token::text, 'none') || ':' || (last_run_at is not null) from public.digest_schedules where user_id = '${A}'`) === 'none:true', 'the run released its claim and recorded completion')

  // --- redeem-invite after migration ---------------------------------------------------------------
  const red = await (await fetch(fn('redeem-invite'), { method: 'POST', headers: headers(users.bob.jwt), body: JSON.stringify({ code: 'LOCAL-1' }) })).json()
  check(red.status === 'paused', 'post-migration: enrollment paused by default', JSON.stringify(red))
} finally {
  serve.kill('SIGTERM')
  provider.close()
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed. Stack left running; stop it with: supabase stop --workdir ${WORK}`)
}
