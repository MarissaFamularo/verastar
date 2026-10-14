// lib/feedback.js — beta reports that must actually arrive: "This badge is wrong?" on an
// evidence value, and free-text beta feedback.
//
// Unlike logEvent (telemetry: fire-and-forget, failures swallowed), a report is a promise
// to the reader. submitReport awaits the insert and resolves only once the server returns
// the stored row's id; any failure throws so the UI can keep a retry path open and never
// shows a receipt for a report that was not stored. Reports go into the existing `events`
// table (RLS: insert/select own rows), so no schema change is needed.
//
// Each report carries a client reportId that stays the same across retries of one report,
// so a retry after an ambiguous failure (stored, but the reply was lost) can be de-duplicated
// when reports are reviewed. Payloads carry ids, versions, tiers and a short quote at most —
// never source text, never patient information.

import { awaitWithin } from './deadline.js'
import { supabase, supabaseConfigured, currentUser, isSignedIn } from './supabase.js'
import { fmtNum } from './format.js'
import { evidenceVerdict } from './evidenceVersion.js'

export const BADGE_REPORT_TYPE = 'badge_reported'
export const FEEDBACK_TYPE = 'beta_feedback'
export const REPORT_SURFACES = ['digest', 'library']
export const FEEDBACK_MAX = 2000
export const REPORT_TIMEOUT_MS = 10000

export function canReport() {
  return Boolean(supabaseConfigured && isSignedIn())
}

export function newReportId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  } catch { /* fall through */ }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

const clip = (v, n) => (v == null ? null : String(v).slice(0, n))

// Everything needed to investigate a badge report later: which paper, which value as shown,
// the verdict and the verifier/extraction versions that produced it, the source it was
// checked against, and where the reader was. Pure.
export function buildBadgeReport({ surface, pmid, quantity = {}, verdict, extractionVersion = null, sourceTier = null, sourceHash = null, reportId, now = new Date() }) {
  if (!REPORT_SURFACES.includes(surface)) throw new Error(`Unknown report surface: ${surface}`)
  if (!pmid) throw new Error('A badge report needs the paper id.')
  const v = evidenceVerdict(verdict || quantity.verdict)
  return {
    reportId,
    surface,
    pmid: String(pmid),
    name: clip(quantity.name, 200),
    value: fmtNum(quantity),
    quantity: {
      quantity_type: clip(quantity.quantity_type, 40),
      value: quantity.value ?? null,
      first_value: quantity.first_value ?? null,
      second_value: quantity.second_value ?? null,
      range_low: quantity.range_low ?? null,
      range_high: quantity.range_high ?? null,
      ci_low: quantity.ci_low ?? null,
      ci_high: quantity.ci_high ?? null,
      p_value: quantity.p_value ?? null,
      unit: clip(quantity.unit, 40),
      location_hint: clip(quantity.location_hint, 120),
    },
    tier: v.tier || null,
    originalTier: v.originalTier || null,
    relationshipStatus: v.relationshipStatus || null,
    endpointValidated: v.endpointValidated ?? null,
    verificationVersion: v.verificationVersion || null,
    extractionVersion: extractionVersion || null,
    sourceTier: sourceTier || v.sourceTier || null,
    sourceHash: sourceHash || null,
    quote: String(quantity.source_quote || '').slice(0, 300),
    reportedAt: now.toISOString(),
  }
}

// The identity of the evidence a badge report is about: paper, surface, the value as shown,
// its quote, the verdict and verifier version, the extraction version and the source hash.
// When any of these change the report control starts over (fresh report id, no receipt
// carried across). Pure; a stable string.
export function badgeReportIdentity({ surface, pmid, quantity = {}, verdict, extractionVersion = null, sourceTier = null, sourceHash = null } = {}) {
  const v = evidenceVerdict(verdict || quantity?.verdict)
  const q = quantity || {}
  return JSON.stringify([
    surface || null, pmid == null ? null : String(pmid),
    q.name ?? null, q.quantity_type ?? null, q.value ?? null, q.first_value ?? null, q.second_value ?? null,
    q.range_low ?? null, q.range_high ?? null, q.ci_low ?? null, q.ci_high ?? null, q.p_value ?? null, q.unit ?? null,
    q.source_quote ?? null,
    v.tier || null, v.relationshipStatus || null, v.verificationVersion || null,
    extractionVersion || null, sourceTier || v.sourceTier || null, sourceHash || null,
  ])
}

// Free-text beta feedback. Pure; throws on an empty message.
export function buildFeedback({ text, view = null, reportId, now = new Date() }) {
  const body = String(text || '').trim()
  if (!body) throw new Error('Write a few words first.')
  return { reportId, text: body.slice(0, FEEDBACK_MAX), view: clip(view, 40), reportedAt: now.toISOString() }
}

// Durable write. Resolves { id } only after the server confirms the stored row; throws
// otherwise. `client`/`user` are injectable for tests.
export async function submitReport(type, payload, { client = supabase, user = currentUser(), configured = supabaseConfigured, timeoutMs = REPORT_TIMEOUT_MS } = {}) {
  if (!configured || !client) throw new Error('Reports need the Verastar account service, which is not configured here.')
  if (!user?.id) throw new Error('Sign in to send reports.')
  let data
  let error
  try {
    const raced = await awaitWithin(client.from('events').insert({ user_id: user.id, type, payload }).select('id').single(), timeoutMs)
    if (raced.timeout) throw new Error('the server did not answer in time')
    ;({ data, error } = raced.value)
  } catch (err) {
    throw new Error(`Not sent: ${err?.message || 'network error'}`)
  }
  if (error) throw new Error(`Not sent: ${error.message || 'the server refused it'}`)
  if (data?.id == null) throw new Error('Not sent: the server did not confirm the report.')
  return { id: data.id }
}

// One report's lifecycle: a fixed reportId across retries, at most one insert in flight,
// and no second insert once the server has confirmed one. `build(reportId)` makes the
// payload (called per attempt so a retry carries the same id). Resolves
// { status: 'sent', id } or { status: 'failed', error } — never throws.
export function reportSender(type, build, { submit = submitReport, reportId = newReportId() } = {}) {
  let receipt = null
  let inflight = null
  return {
    reportId,
    get receipt() { return receipt },
    send() {
      if (receipt) return Promise.resolve({ status: 'sent', id: receipt.id })
      if (inflight) return inflight
      inflight = (async () => {
        try {
          const res = await submit(type, build(reportId))
          receipt = res
          return { status: 'sent', id: res.id }
        } catch (err) {
          return { status: 'failed', error: err?.message || String(err) }
        } finally {
          inflight = null
        }
      })()
      return inflight
    },
  }
}
