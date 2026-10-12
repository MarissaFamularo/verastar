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
  check(!/spend_release|\.release\(/.test(spendingSrc) && !/spend_release/.test(mig.replace(/--[^\n]*/g, '')), 'no release path: post-dispatch liability is only settled or reconciled')
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

  return results
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runChecks()
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`)
  const failed = results.filter((r) => !r.ok).length
  console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
