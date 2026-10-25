// Deterministic, offline drift check for the sponsored-spending and scheduler contract.
// Proposed for the Sunday machinery (docs/SPENDING_CONTRACT.md § Drift check); also run by
// vitest (src/lib/spendingContractCheck.test.js). Exit 0 = all checks pass.
//
//   node scripts/check-spending-contract.mjs
//
// What it guards (each a regression that once existed or would reopen unbounded spend):
//   1. digest-run imports the locally generated bundle, never a remote/pinned URL.
//   2. The committed bundle and manifest are exactly what the current source builds.
//   3. Every default model is priced by the shared table; nothing else is.
//   4. Only _shared/spending.js talks to the provider; no usage-callback accounting remains.
//   5. The proxy never writes the shared evidence cache.
//   6. Every function in the spending migration has EXECUTE revoked from client roles.
//   10. The 2026-10-14 server repairs: invite end date, scheduler fairness, OTP ticket burn,
//       distinct 402 wordings, verify_jwt pins, and the shared-cache column grants.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FN = 'supabase/functions'
const read = (p) => readFileSync(p, 'utf8')
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

export async function runChecks() {
  const results = []
  const check = (ok, label, detail = '') => results.push({ ok: !!ok, label, detail })

  // 1
  const entry = read(`${FN}/digest-run/index.ts`)
  check(/from '\.\/app\.bundle\.js'/.test(entry), 'digest-run imports ./app.bundle.js')
  check(!/import[^\n]*from\s+'https?:/.test(entry), 'digest-run has no remote module import')

  // 2
  const { bundleFunctions, BUNDLE_OUT } = await import('./bundle-functions.mjs')
  const { js, manifest: rebuilt } = await bundleFunctions({ write: false })
  const onDisk = read(BUNDLE_OUT)
  const manifest = (await import(`${pathToFileURL(`${FN}/digest-run/app.bundle.manifest.js`).href}?t=${Date.now()}`)).default
  check(onDisk === js, 'bundle on disk matches a fresh build of the current source', onDisk === js ? '' : 'run npm run bundle:functions')
  check(manifest.bundleSha256 === rebuilt.bundleSha256 && manifest.sourceSha256 === rebuilt.sourceSha256, 'manifest hashes match the fresh build')
  check(manifest.extractionVersion === rebuilt.extractionVersion && manifest.verificationVersion === rebuilt.verificationVersion, 'manifest versions match the source', `${manifest.extractionVersion} / ${manifest.verificationVersion}`)

  // 3
  const { SUPPORTED_MODELS } = await import('../supabase/functions/_shared/pricing.js')
  const defaults = [...new Set(Object.values(rebuilt.models))].sort()
  check(JSON.stringify(defaults) === JSON.stringify([...SUPPORTED_MODELS].sort()), 'priced models are exactly the default models', defaults.join(', '))

  // 4
  const sources = walk(FN).filter((p) => /\.(ts|js)$/.test(p) && !p.endsWith('app.bundle.js') && !p.endsWith('app.bundle.manifest.js'))
  const providerRefs = sources.filter((p) => /api\.anthropic\.com|['"]x-api-key['"]\s*:/.test(read(p)) && !p.endsWith('_shared/spending.js'))
  check(providerRefs.length === 0, 'only _shared/spending.js addresses the provider', providerRefs.join(', '))
  const code = (p) => read(p).replace(/^\s*\/\/[^\n]*/gm, '')
  const callbackRefs = sources.filter((p) => /onUsage|configureServerClient|configureServerStore|configureEvidenceCacheServer/.test(code(p)))
  check(callbackRefs.length === 0, 'no process-global binding or usage-callback accounting in functions', callbackRefs.join(', '))
  check(!/configureServer|configureEvidenceCacheServer/.test(read(`${FN}/digest-run/app.entry.js`).replace(/\/\/[^\n]*/g, '')), 'bundle entry exports no process-global setters')

  // 5
  const proxy = read(`${FN}/model/handler.js`) + read(`${FN}/model/index.ts`)
  check(!/evidence_cache'\)[\s\S]{0,80}\.(upsert|insert|update|delete)\(/.test(proxy), 'the proxy never writes evidence_cache')

  // 6
  const mig = read('supabase/migrations/20261009120000_beta_spending_safeguards.sql')
  const created = [...mig.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1])
  const revokeBlock = mig.slice(mig.indexOf('foreach f in array array['))
  const unrevoked = created.filter((f) => !revokeBlock.includes(`'${f}(`))
  check(created.length > 0 && unrevoked.length === 0, 'every new function is service-role only', unrevoked.join(', '))
  check(!/security definer/i.test(mig.replace(/--[^\n]*/g, '')), 'no SECURITY DEFINER function in the spending migration')

  // 7 (2026-10-09 review corrections)
  const spendingSrc = read(`${FN}/_shared/spending.js`)
  check(/resolveInputTokens\(/.test(spendingSrc) && /reservationCharge\(/.test(spendingSrc) && !/micro:\s*checked\.bound\.micro/.test(spendingSrc), 'a reservation is this request\'s counted input plus margin plus max_tokens, clamped under the context-window ceiling')
  check(/explicitUnbilledStatus/.test(spendingSrc) && /providerRequestNotSent/.test(spendingSrc) && /interrupted_response/.test(spendingSrc) && /RELEASED_STATUSES = new Set\(\['released', 'already_released'\]\)/.test(spendingSrc), 'only a definitive non-charge releases the hold; an interrupted 2xx, a timeout, or an unchanged release stays counted')
  check(/p_claim_token: r\.claimToken/.test(spendingSrc) && /claimToken: picked\.token/.test(read(`${FN}/digest-run/handler.js`)), 'scheduler reservations carry the run\'s claim token')
  const cacheReaders = [`${FN}/model/handler.js`, 'src/pipeline/evidenceCache.js'].filter((p) => /from\('evidence_cache'\)/.test(read(p)))
  check(cacheReaders.length === 0, 'shared cache reads use evidence_cache_trusted only', cacheReaders.join(', '))
  const marker = (mig.match(/select '([^']+)'::text \$\$;/) || [])[1]
  check(!!marker && read(`${FN}/redeem-invite/index.ts`).includes(`'${marker}'`), 'redeem-invite expects the migration\'s contract marker', marker)
  const { PRICES } = await import('../supabase/functions/_shared/pricing.js')
  check(Object.values(PRICES).every((p) => Number.isSafeInteger(p.contextWindowTokens) && p.contextWindowTokens > 0), 'every admitted model has a documented context-window bound')

  // 8 (2026-10-10 scheduler hold)
  const hold = read('supabase/migrations/20261010130000_scheduler_hold.sql')
  const holdCode = hold.replace(/--[^\n]*/g, '')
  const holdCreated = [...hold.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1])
  const holdRevokes = hold.slice(hold.indexOf('foreach f in array array['))
  const holdUnrevoked = holdCreated.filter((f) => !holdRevokes.includes(`'${f}(`))
  check(holdCreated.length === 4 && holdUnrevoked.length === 0, 'every function the hold migration creates or replaces is service-role only', holdUnrevoked.join(', '))
  check(!/security definer/i.test(holdCode), 'no SECURITY DEFINER function in the hold migration')
  const { CLAIM_STALE_SECONDS } = await import('../supabase/functions/_shared/timeouts.js')
  const leases = [...(hold + read('supabase/migrations/20261010120000_digest_write_guard.sql')).matchAll(/c_claim_lease constant integer := (\d+)/g)].map((m) => Number(m[1]))
  check(leases.length === 2 && leases.every((n) => n === CLAIM_STALE_SECONDS), 'the claim lease written into SQL equals CLAIM_STALE_SECONDS', leases.join(', '))
  check(/scheduler_hold_reason\(p_user_id\), public\.spend_denial_reason/.test(holdCode) && (holdCode.match(/v_reason := public\.scheduler_hold_reason\(p_user_id\);/g) || []).length === 1, 'the hold is checked in the preflight and at reservation')
  check(!/spend_reconcile|spend_settle|spend_mark_ambiguous|digest_claim\b|dispatch/.test(holdCode.slice(holdCode.indexOf('function public.scheduler_recover'), holdCode.indexOf('do $$'))), 'recovery reconciles nothing, settles nothing and claims nothing')
  const runner = read('src/pipeline/dailyDigest.js')
  const handlerSrc = read(`${FN}/digest-run/handler.js`)
  check(/run\.unresolved \?\?= r\.outcome/.test(handlerSrc) && /serverRunUnresolved\(\)/.test(runner) && /phase: 'held'/.test(runner), 'an unresolved attempt reaches the digest runner, which stops as held')
  check(/const finished = result\.phase === 'done' \|\| result\.phase === 'empty'/.test(handlerSrc), 'only a done or empty digest marks the day finished (a held run does not)')
  check(/'scheduler_held'/.test(read('supabase/ops/spending_health.sql')), 'the health query reports held accounts')

  // 9 (2026-10-12 request-sized holds). The daily cap is not in this migration.
  const release = read('supabase/migrations/20261012180000_spend_release.sql')
  const releaseCode = release.replace(/--[^\n]*/g, '')
  check(/create or replace function public\.spend_release\(/.test(releaseCode) && !/daily_cap/.test(releaseCode), 'spend_release exists and the release migration does not change the daily cap')
  check(!/security definer/i.test(releaseCode), 'no SECURITY DEFINER function in the release migration')
  const releaseCreated = [...release.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1])
  const releaseRevokes = release.slice(release.indexOf('foreach f in array array['))
  const releaseUnrevoked = releaseCreated.filter((f) => !releaseRevokes.includes(`'${f}(`))
  check(releaseCreated.length === 3 && releaseUnrevoked.length === 0, 'every function the release migration creates or replaces is service-role only', releaseUnrevoked.join(', '))
  check(/r\.state not in \('reserved', 'ambiguous', 'released'\)/.test(releaseCode) && !/r\.state = 'released' then\s+return jsonb_build_object\('status', 'unchanged'/.test(releaseCode), 'a released row can be settled and reconciled')

  // 10 (2026-10-14 beta audit, docs/BETA_TEST_PLAN.md § H). Each migration keeps the
  // service-role-only rule; the handlers use what the migrations add.
  const serviceRoleOnly = (file, expectCount) => {
    const sql = read(file)
    const made = [...sql.matchAll(/create or replace function (public\.[a-z_]+)\(/g)].map((m) => m[1])
    const block = sql.slice(sql.indexOf('foreach f in array array['))
    const missing = made.filter((f) => !block.includes(`'${f}(`))
    check(made.length === expectCount && missing.length === 0, `${file.split('/').pop()}: every function is service-role only`, missing.join(', ') || `${made.length} function(s)`)
    check(!/security definer/i.test(sql.replace(/--[^\n]*/g, '')), `${file.split('/').pop()}: no SECURITY DEFINER function`)
  }
  const inviteMig = 'supabase/migrations/20261014120000_invite_ends_at.sql'
  serviceRoleOnly(inviteMig, 1)
  const inviteCode = read(inviteMig).replace(/--[^\n]*/g, '')
  const endsAt = inviteCode.indexOf('v_inv.ends_at is not null and v_inv.ends_at <= now()')
  check(endsAt > 0 && endsAt < inviteCode.indexOf('insert into public.sponsored_accounts') && endsAt < inviteCode.indexOf('set uses = uses + 1'), 'redeem_sponsor_invite answers expired for an ended code before any insert or use count')
  check(/ends_at/.test(read(`${FN}/redeem-invite/index.ts`).match(/\.select\('([^']*)'\)\.eq\('code'/)?.[1] || ''), 'the redeem-invite preflight reads ends_at too')

  const attemptsMig = 'supabase/migrations/20261014121000_digest_attempts.sql'
  serviceRoleOnly(attemptsMig, 3)
  const attemptsCode = read(attemptsMig).replace(/--[^\n]*/g, '')
  const finishBody = attemptsCode.slice(attemptsCode.indexOf('function public.digest_claim_finish'), attemptsCode.indexOf('function public.digest_claim_release'))
  check(/last_attempt_at = now\(\)/.test(finishBody) && /attempts_today = case when attempt_day = public\.digest_local_day\(timezone\)/.test(finishBody) && !/case when p_finished then now\(\) else last_run_at end[\s\S]*last_attempt_at = case/.test(finishBody), 'digest_claim_finish stamps last_attempt_at and counts the attempt on every finish, finished or not')
  check(!/last_attempt_at|attempts_today|attempt_day/.test(attemptsCode.slice(attemptsCode.indexOf('function public.digest_claim_release'), attemptsCode.indexOf('do $$'))), 'digest_claim_release stamps nothing')
  check(!/grant (select|update)[^;]*(last_attempt_at|attempts_today|attempt_day)[^;]*to authenticated/.test(attemptsCode), 'the attempt columns are server-owned (no client grant)')
  const handlerNow = read(`${FN}/digest-run/handler.js`)
  check(/export const ATTEMPTS_PER_DAY = \d+/.test(handlerNow) && /attemptsToday\(row, now\) >= ATTEMPTS_PER_DAY/.test(handlerNow) && /!manual && attemptsToday/.test(handlerNow), 'cron skips an account at the per-day attempt cap (manual runs are not capped)')
  check(/rows = manual \? rows \|\| \[\] : orderByAttempt\(rows\)/.test(handlerNow) && /\.order\('last_attempt_at', \{ ascending: true, nullsFirst: true \}\)/.test(handlerNow), 'cron considers accounts least-recently-attempted first (never attempted first of all)')
  check(!/p_finished: false, p_result: null/.test(handlerNow) && (handlerNow.match(/rpc\('digest_claim_release'/g) || []).length === 2, 'a claim taken but not run is released through digest_claim_release, not finished')

  const otpMig = read('supabase/migrations/20261014122000_gmail_otp_failures.sql')
  check(/revoke all on function public\.gmail_alias_fail_verify\(uuid\) from public, anon, authenticated;/.test(otpMig) && /grant execute on function public\.gmail_alias_fail_verify\(uuid\) to service_role;/.test(otpMig) && /revoke all on function private\.gmail_alias_fail_verify\(uuid\) from public, anon, authenticated, service_role;/.test(otpMig), 'gmail_alias_fail_verify is service-role only through the public wrapper')
  check(/c_max_failures constant integer := 5/.test(otpMig) && /delete from private\.gmail_alias_permits where ticket = p_ticket/.test(otpMig), 'the fifth wrong code deletes the verify ticket')
  const otpHandler = read(`${FN}/gmail-canonical-otp/handler.js`)
  check(/export const MAX_VERIFY_FAILURES = 5/.test(otpHandler) && /deps\.failVerify\(verifyTicketValue\)/.test(otpHandler) && /rpc\('gmail_alias_fail_verify'/.test(read(`${FN}/gmail-canonical-otp/index.ts`)), 'every refused code is counted on the ticket')

  const spendingNow = read(`${FN}/_shared/spending.js`)
  check(/export function denialMessage\(reason\)/.test(spendingNow) && /reason === 'overrun_review'\) return refusal\(402, 'overrun_review', OVERRUN_MESSAGE/.test(spendingNow) && /reason === 'unresolved_liability'\) return refusal\(402, 'scheduler_held', HELD_MESSAGE/.test(spendingNow), 'paused, overrun review and held are distinct 402s, apart from the per-user cap')
  const { CAP_MESSAGE, PAUSE_MESSAGE, OVERRUN_MESSAGE, HELD_MESSAGE } = await import('../supabase/functions/_shared/spending.js')
  const wordings = [CAP_MESSAGE, PAUSE_MESSAGE, OVERRUN_MESSAGE, HELD_MESSAGE]
  check(new Set(wordings).size === 4 && wordings.every((m) => !/\$|\d|dollar|usd/i.test(m)), 'the four 402 sentences differ and carry no amount')
  check(/denialReason\(err\)/.test(read('src/lib/anthropic.js')) && /sponsoredRefusalMessage\(reason\)/.test(read('src/lib/anthropic.js')), 'the app words a 402 from its denial reason, not from server text')

  const toml = read('supabase/config.toml')
  const pin = (fn) => (toml.match(new RegExp(`\\[functions\\.${fn}\\][^\\[]*verify_jwt = (true|false)`)) || [])[1]
  check(pin('model') === 'false' && pin('digest-run') === 'false' && pin('redeem-invite') === 'false' && pin('match-npi') === 'false', 'config.toml pins verify_jwt = false for model, digest-run, redeem-invite and match-npi', ['model', 'digest-run', 'redeem-invite', 'match-npi'].map((f) => `${f}=${pin(f)}`).join(' '))
  check(pin('gmail-canonical-otp') === 'true', 'config.toml pins verify_jwt = true for gmail-canonical-otp')
  const sections = (toml.match(/^\[functions\.[^\]]+\]/gm) || []).length
  const maps = (toml.match(/import_map = "\.\/functions\/deno\.json"/g) || []).length
  check(sections >= 6 && maps === sections, 'every function deploys with the shared import map', `${maps} of ${sections} function sections`)

  const grants = read('supabase/migrations/20261014123000_evidence_cache_column_grants.sql').replace(/--[^\n]*/g, '')
  for (const table of ['evidence_cache_trusted', 'evidence_cache']) {
    const cols = (grants.match(new RegExp(`grant select \\(([^)]*)\\)\\s+on public\\.${table} to authenticated`)) || [])[1]
    check(new RegExp(`revoke select on public\\.${table} from authenticated`).test(grants) && !!cols && !/created_by/.test(cols) && /extraction/.test(cols), `${table}: authenticated reads named columns without created_by`, cols ? cols.replace(/\s+/g, ' ') : 'no column grant')
  }
  check(!/select\('\*'\)|select\(\)/.test(read('src/pipeline/evidenceCache.js')) && /\.select\('extraction, model, source_tier, provenance'\)/.test(read('src/pipeline/evidenceCache.js')), 'the app reads the trusted cache by named columns (a select * would now be refused)')

  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runChecks()
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
