// supabase/functions/digest-run/index.ts — the scheduled morning digest.
//
// Invoked by pg_cron every few minutes (docs/SPONSORED_ACCESS_DEPLOY.md). Each tick picks
// at most ONE due sponsored account and runs, or continues, its daily digest with the
// headless runner in src/pipeline/dailyDigest.js, bound to that account's rows under the
// service role. The runner persists after every paper and carries a phase marker, so a
// tick that runs out of budget hands the rest to the next tick.
//
// Due means: schedule enabled, the account is sponsored and active, the local hour matches
// (or a scheduler run is mid-flight), no run has completed today in the account's timezone,
// no other tick holds a fresh claim, the last digest was opened (docs: "a digest nobody
// opened is never replaced by another one nobody will open"), and today's spend is under
// the daily cap.
//
// Callable two ways: from cron with `x-cron-secret`, or by a signed-in sponsored user
// ("run mine now"), which ignores the hour and the opened gate but keeps the cap check.
//
// Secrets: ANTHROPIC_API_KEY, DIGEST_CRON_SECRET; SUPABASE_* injected by the platform.

import { createClient } from '@supabase/supabase-js'
import { DOMParser } from 'linkedom'
import { accountActive, capReached, effectiveCaps, costUsd, windows } from '../model/logic.js'
// The app's own modules, bundled by `npm run bundle:functions` into public/server/ and
// served by Netlify with the frontend. The edge runtime resolves remote modules when the
// function is deployed (a runtime dynamic import is "Module not found"), so this is a
// static import: a pipeline change reaches the scheduler by rebuilding the bundle,
// deploying main, and then redeploying this function.
import {
  configureServerClient,
  configureServerStore,
  makeSupabaseStore,
  configureEvidenceCacheServer,
  schedulerMayRun,
  runDailyDigest,
} from 'https://verastar.netlify.app/server/app.bundle.js'

// sources.js parses PMC and PubMed XML with the browser's DOMParser; linkedom provides the
// same surface (querySelector, cloneNode, textContent, getAttribute) on Deno.
;(globalThis as any).DOMParser = DOMParser

const BUDGET_MS = 100_000 // reading budget per tick; the rest resumes next tick
const CLAIM_STALE_MS = 15 * 60 * 1000

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Local wall-clock hour and calendar day for a timezone. Intl is available on Deno.
export function localClock(now: Date, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
    const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
    const hour = Number(get('hour')) % 24
    return { hour, day: `${get('year')}-${get('month')}-${get('day')}` }
  } catch {
    const hour = now.getUTCHours()
    return { hour, day: now.toISOString().slice(0, 10) }
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const cronSecret = Deno.env.get('DIGEST_CRON_SECRET')
  if (!anthropicKey || !supabaseUrl || !anonKey || !serviceKey) return json(500, { error: 'not configured' })

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  const now = new Date()

  // Who asked: cron, or a user running their own digest now.
  let targetUserId: string | null = null
  let manual = false
  if (cronSecret && req.headers.get('x-cron-secret') === cronSecret) {
    manual = false
  } else {
    const auth = req.headers.get('authorization') || ''
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } } })
    const { data } = await userClient.auth.getUser()
    if (!data?.user) return json(401, { error: 'unauthorized' })
    targetUserId = data.user.id
    manual = true
  }

  const { data: config } = await admin.from('sponsor_config').select('*').eq('id', true).maybeSingle()
  if (!config) return json(500, { error: 'sponsor config missing' })

  // Candidate rows.
  let q = admin.from('digest_schedules').select('*').eq('enabled', true)
  if (targetUserId) q = q.eq('user_id', targetUserId)
  const { data: rows } = await q
  const { data: accounts } = await admin.from('sponsored_accounts').select('*')
  const accountById = new Map((accounts || []).map((a: any) => [a.user_id, a]))

  let picked: any = null
  let reason = 'nothing due'
  for (const row of rows || []) {
    const account = accountById.get(row.user_id)
    if (!accountActive(account, now)) continue
    const { hour, day } = localClock(now, row.timezone)
    const ranToday = row.last_run_at && localClock(new Date(row.last_run_at), row.timezone).day === day
    const claimedFresh = row.claimed_at && now.getTime() - new Date(row.claimed_at).getTime() < CLAIM_STALE_MS
    if (claimedFresh && !manual) continue

    const { data: kv } = await admin.from('kv').select('value').eq('user_id', row.user_id).eq('collection', 'digests').eq('key', 'daily:latest').maybeSingle()
    const record = kv?.value || null
    const midFlight = record?.runBy === 'scheduler' && record?.server?.phase && record.server.phase !== 'done'
    // A digest from today, whoever ran it, is never replaced: the seen ledger already
    // retired its papers, so a rerun would discard what the reader may be reading. The
    // app enforces the same rule behind an explicit confirm; the server has no confirm.
    const hasPapers = Array.isArray(record?.results) && record.results.length > 0
    const savedToday = hasPapers && record?.savedAt && localClock(new Date(record.savedAt), row.timezone).day === day
    if (savedToday && !midFlight) { reason = "today's digest already exists"; continue }
    if (!manual) {
      if (ranToday && !midFlight) continue
      if (!midFlight && hour !== Number(row.hour_local)) continue
      if (!schedulerMayRun(record)) { reason = 'last digest unopened'; continue }
    }

    // Caps: same rule as the proxy, checked before any spend.
    const { dayStart, monthStart } = windows(now)
    const sum = async (since: string, uid: string | null) => {
      let s = admin.from('model_spend').select('usd').gte('ts', since)
      if (uid) s = s.eq('user_id', uid)
      const { data } = await s
      return (data || []).reduce((acc: number, r: any) => acc + Number(r.usd || 0), 0)
    }
    const [spentToday, spentMonth, spentGlobalMonth] = await Promise.all([sum(dayStart, row.user_id), sum(monthStart, row.user_id), sum(monthStart, null)])
    if (capReached({ spentToday, spentMonth, spentGlobalMonth }, effectiveCaps(account, config))) {
      reason = 'cap reached'
      await admin.from('digest_schedules').update({ last_result: 'skipped: cap reached', updated_at: now.toISOString() }).eq('user_id', row.user_id)
      continue
    }
    picked = { row, account }
    break
  }
  if (!picked) return json(200, { ran: false, reason })

  const userId = picked.row.user_id
  await admin.from('digest_schedules').update({ claimed_at: now.toISOString(), updated_at: now.toISOString() }).eq('user_id', userId)

  // Bind the app's modules to this account. Spend is recorded from the usage the client
  // module reports on every model response; the ledger is the same one the proxy writes.
  const pendingSpend: Promise<unknown>[] = []
  configureServerClient({
    apiKey: anthropicKey,
    onUsage: (model: string, usage: any) => {
      pendingSpend.push(admin.from('model_spend').insert({
        user_id: userId,
        model,
        purpose: 'scheduled-digest',
        input_tokens: Number(usage?.input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0),
        cached_tokens: Number(usage?.cache_read_input_tokens || 0),
        output_tokens: Number(usage?.output_tokens || 0),
        usd: costUsd(model, usage),
        cache_hit: false,
      }).then(() => undefined))
    },
  })
  configureServerStore(makeSupabaseStore({ client: admin, userId }))
  configureEvidenceCacheServer({ client: admin, userId })

  const log: string[] = []
  let result: any
  try {
    result = await runDailyDigest({ budgetMs: BUDGET_MS, log: (line: string) => log.push(line) })
  } catch (err) {
    result = { phase: 'error', note: (err as Error)?.message || String(err) }
  }
  await Promise.allSettled(pendingSpend)

  const finished = result.phase === 'done' || result.phase === 'empty'
  await admin.from('digest_schedules').update({
    claimed_at: finished || result.phase === 'error' ? null : now.toISOString(),
    last_run_at: finished ? now.toISOString() : picked.row.last_run_at,
    last_result: `${result.phase}: ${result.papers ?? 0} papers, read ${result.read ?? 0}${result.note ? `; ${result.note}` : ''}`.slice(0, 200),
    updated_at: now.toISOString(),
  }).eq('user_id', userId)
  await admin.from('events').insert({ user_id: userId, type: 'digest_scheduled_run', payload: { phase: result.phase, papers: result.papers ?? 0, read: result.read ?? 0, manual } })

  return json(200, { ran: true, user_id: userId, ...result, log })
})
