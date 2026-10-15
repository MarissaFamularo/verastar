// lib/betaAdmin.js — the beta admin dashboard's data access and plain-language metric
// definitions (docs/BETA_ADMIN_DASHBOARD.md).
//
// Authorization is server-side only: beta_admin_check() says whether the caller is on the
// private allowlist (used to show the Settings entry), and beta_admin_stats() refuses
// anyone else with 42501. Nothing here decides access; it only asks.
//
// The pure helpers turn the RPC's jsonb into rows the dashboard can render, including the
// "Not available" cases: a record kind that has never been written, or a range that ends
// before its first record, is reported as not available rather than as zero.

import { supabase, supabaseConfigured, currentUser } from './supabase.js'
import { SURVEY_QUESTIONS } from './betaSurvey.js'

export const DEFAULT_RANGE_DAYS = 30
export const MAX_RANGE_DAYS = 400

export async function checkBetaAdmin() {
  if (!supabaseConfigured || !currentUser()) return false
  try {
    const { data, error } = await supabase.rpc('beta_admin_check')
    return !error && data === true
  } catch {
    return false
  }
}

// Resolves { ok: true, stats } or { ok: false, reason: 'forbidden' | 'error' }.
export async function fetchBetaStats({ from, to }) {
  if (!supabaseConfigured || !currentUser()) return { ok: false, reason: 'forbidden' }
  try {
    const { data, error } = await supabase.rpc('beta_admin_stats', { p_from: from, p_to: to })
    if (error) return { ok: false, reason: error.code === '42501' ? 'forbidden' : 'error', message: error.message }
    return { ok: true, stats: data }
  } catch (err) {
    return { ok: false, reason: 'error', message: err?.message }
  }
}

// --- dates ---------------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0')
export const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

// Inclusive calendar dates, local time: the last DEFAULT_RANGE_DAYS days ending today.
export function defaultRange(now = new Date()) {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const from = new Date(to)
  from.setDate(from.getDate() - (DEFAULT_RANGE_DAYS - 1))
  return { fromDate: toDateInput(from), toDate: toDateInput(to) }
}

// Two YYYY-MM-DD inputs → the half-open ISO range [from midnight, day after `to` midnight),
// or { error } when the inputs are not a valid range of at most MAX_RANGE_DAYS days.
export function rangeFromInputs(fromDate, toDate) {
  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '')
    if (!m) return null
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return Number.isNaN(d.getTime()) ? null : d
  }
  const from = parse(fromDate)
  const to = parse(toDate)
  if (!from || !to) return { error: 'Enter both dates.' }
  if (to < from) return { error: 'The end date is before the start date.' }
  const end = new Date(to)
  end.setDate(end.getDate() + 1)
  const days = Math.round((end - from) / 86_400_000)
  if (days > MAX_RANGE_DAYS) return { error: `Choose a range of at most ${MAX_RANGE_DAYS} days.` }
  return { from: from.toISOString(), to: end.toISOString(), days }
}

// --- availability ----------------------------------------------------------------------------

const fmtDay = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().slice(0, 10)
}

// Is a record kind usable for this range? `first` is the earliest record of that kind ever.
export function availability(stats, source) {
  const first = stats?.first_seen?.[source]
  const to = stats?.range?.to
  if (!first) return { available: false, note: 'No records of this kind exist yet, so nothing can be counted. A zero here would be misleading.' }
  if (to && new Date(to) <= new Date(first)) return { available: false, note: `Records of this kind begin ${fmtDay(first)}, after this range.` }
  const from = stats?.range?.from
  if (from && new Date(from) < new Date(first)) return { available: true, note: `Records begin ${fmtDay(first)}; earlier days in this range have no data.` }
  return { available: true, note: '' }
}

const n = (v) => (typeof v === 'number' ? v : Number(v ?? 0))
const fmt = (v) => n(v).toLocaleString()

function row(label, value, definition, avail, extra = '') {
  return {
    label,
    value: avail.available ? fmt(value) : 'Not available',
    definition,
    note: [avail.note, extra].filter(Boolean).join(' '),
    available: avail.available,
  }
}

// --- the metric sections -------------------------------------------------------------------

// Pure: the dashboard sections for one stats payload. Every row carries its own definition.
export function metricSections(stats) {
  if (!stats) return []
  const users = stats.users || {}
  const s = stats.scheduled || {}
  const b = stats.browser || {}
  const o = stats.opened || {}
  const p = stats.papers || {}
  const sv = stats.survey || {}
  const acc = availability(stats, 'sponsored_accounts')
  const sch = availability(stats, 'digest_scheduled_run')
  const br = availability(stats, 'digest_run')
  const op = availability(stats, 'digest_opened')
  const ev = availability(stats, 'evidence_cache_trusted')
  const su = availability(stats, 'beta_survey_responses')
  const always = { available: true, note: '' }
  const generatedTotal = n(s.summaries) + n(b.summaries)

  return [
    {
      title: 'Beta users',
      caveat: 'A beta user is an account that redeemed a beta code. Registering says nothing about activity; see the digest sections for use.',
      rows: [
        row('New beta users in range', users.new_in_range, 'Accounts whose beta code was redeemed inside the date range.', acc),
        row('Total beta users', users.total, 'Every account that has ever redeemed a beta code, regardless of the range or whether access is still active.', always),
        row('Active beta access now', users.active, 'Accounts whose sponsored access is switched on and has not reached its end date, as of now (not range-dependent).', always),
      ],
    },
    {
      title: 'Digest requests',
      caveat: 'Counts come from the events ledger, which the owning user can edit under the existing row-level security, so they are "as recorded". A scheduled digest runs across several short ticks; a request is counted once per user per UTC day, not once per tick.',
      rows: [
        row('Unique users who requested a digest', stats.requesters, 'Distinct accounts that pressed "run now" on the scheduled digest or ran a digest in the browser during the range. Cron-only runs are not requests and are not counted here.', sch.available || br.available ? always : sch),
        row('Unique users with any scheduled run', s.users_any, 'Distinct accounts the scheduler ran for during the range, whether by cron or by request.', sch),
        row('Scheduled digest-days attempted', s.user_days, 'Distinct (user, UTC day) pairs with at least one scheduler tick. One digest-day is one digest the service tried to produce.', sch),
        row('Generated', s.generated, 'Digest-days whose last tick finished with papers ranked and saved (phase "done"). Generated means written to the account, not delivered or opened.', sch),
        row('Empty results', s.empty, 'Digest-days whose last tick finished with nothing to show: profile not onboarded, nothing new in the window, or nothing cleared the bar.', sch),
        row('Failed', s.failed, 'Digest-days whose last tick ended in error, was held for an unresolved paid attempt, or hit a cap.', sch),
        row('Unfinished', s.unfinished, 'Digest-days whose last recorded tick was still reading or ranking at the end of the range.', sch),
        row('Run ticks', s.ticks, 'Every scheduler tick that claimed the account and ran, including continuation ticks of the same digest. Not a request count.', sch),
        row('Manual ticks', s.manual_ticks, 'Ticks started by the user pressing "run now" rather than by cron.', sch),
        row('Failure ticks', s.failure_ticks, 'Ticks that ended in error, held, or capped, whether or not a later tick recovered.', sch),
        row('Retry ticks', s.retry_ticks, 'Ticks that ran after a failure tick on the same user-day. These are retries, counted separately from requests.', sch),
      ],
    },
    {
      title: 'Browser digest runs',
      caveat: 'Runs made in the browser on the user’s own key or through the sponsored proxy. Demo (showcase) runs are excluded.',
      rows: [
        row('Browser runs', b.runs, 'Completed in-browser digest runs in the range.', br),
        row('Unique users with browser runs', b.users, 'Distinct accounts behind those runs.', br),
        row('Runs with papers', b.generated, 'Browser runs that ended with at least one paper in the digest.', br),
        row('Runs with no papers and no errors', b.empty, 'Browser runs that finished with nothing to show.', br),
        row('Runs with at least one paper error', b.with_errors, 'Browser runs in which one or more papers failed to process. The run may still have shown papers.', br),
      ],
    },
    {
      title: 'Paper summaries',
      caveat: 'A summary is a paper that ended up in a finished digest. The same paper can be summarized for several users and on several days, so this is not a unique-paper count.',
      rows: [
        row('Summaries generated (scheduled + browser)', generatedTotal, 'Papers in finished scheduled digests plus papers in completed browser runs, excluding "add more" runs so a digest is not counted twice.', sch.available || br.available ? always : sch, sch.available && br.available ? '' : 'One of the two sources has no records for this range.'),
        row('Summaries from scheduled digests', s.summaries, 'Papers in digest-days that finished "done", summed over the range.', sch),
        row('Summaries from browser runs', b.summaries, 'Papers in completed browser runs, excluding "add more" runs.', br),
        row('Scheduler extractions cached', p.extractions, 'First-time extractions the scheduler wrote to the shared evidence cache in the range. A paper already in the cache is reused, not recounted.', ev),
        row('Unique papers extracted (PMIDs)', p.unique_pmids, 'Distinct PMIDs among those cached extractions. This is the only unique-paper figure available; it covers scheduled runs only.', ev),
      ],
    },
    {
      title: 'Digests opened',
      caveat: 'Verastar does not record delivery (no email or push). "Opened" is the user opening the digest screen with results present, recorded by the browser.',
      rows: [
        row('Digest opens', o.events, 'Times a digest with results was opened for the first time after it was produced.', op),
        row('Unique users who opened a digest', o.users, 'Distinct accounts behind those opens.', op),
      ],
    },
    {
      title: 'Verifier rejections',
      caveat: 'Not available. Verifier verdicts and prose-check reasons are stored only inside each user’s latest digest record and saved papers, not as dated events, so they cannot be counted by range without reading user content. Adding that instrumentation is a separate change to the digest pipeline.',
      rows: [
        row('Rejection and failure reasons', null, 'Per-reason counts of verifier refusals in the range.', { available: false, note: 'Not instrumented server-side.' }),
      ],
    },
    {
      title: 'Signup survey',
      caveat: 'Self-reported choices from the optional one-minute survey after beta-code redemption. Counts only; no individual responses. These answers describe habits and confidence as reported, not knowledge or product impact.',
      rows: [
        row('Surveys completed', sv.completed, 'Accounts that answered all four questions in the range.', su),
        row('Surveys skipped', sv.skipped, 'Accounts that chose to skip in the range. A skip is final; the survey is not shown again.', su),
        row('Completed, all time', sv.completed_all_time, 'Every completed signup survey, regardless of the range.', su),
      ],
    },
  ]
}

// Pure: answer distributions for the completed surveys, one table per question, in the
// question’s own option order, with zero for options nobody chose.
export function surveyDistributions(stats) {
  const sv = stats?.survey || {}
  return SURVEY_QUESTIONS.map((q) => {
    const counts = sv[q.key] || {}
    const rows = q.options.map(([code, label]) => ({ code, label, count: n(counts[code]) }))
    const total = rows.reduce((t, r) => t + r.count, 0)
    return { key: q.key, prompt: q.prompt, total, rows }
  })
}
