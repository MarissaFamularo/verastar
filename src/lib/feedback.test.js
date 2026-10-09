import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { buildBadgeReport, buildFeedback, submitReport, reportSender, BADGE_REPORT_TYPE, FEEDBACK_TYPE, FEEDBACK_MAX } from './feedback.js'
import { VERIFICATION_VERSION, CURRENT_EXTRACTION_VERSION } from './evidenceVersion.js'
import ReportBadgeButton from '../components/ReportBadgeButton.jsx'
import { BetaLabel, FeedbackButton, FeedbackDialog } from '../components/BetaFeedback.jsx'

// A fake supabase client: `.from('events').insert(row).select('id').single()`.
function fakeClient(result) {
  const inserted = []
  const client = {
    inserted,
    from(table) {
      return {
        insert(row) {
          inserted.push({ table, row })
          return { select: () => ({ single: async () => (typeof result === 'function' ? result(row) : result) }) }
        },
      }
    },
  }
  return client
}
const user = { id: 'user-1' }

const quantity = {
  name: 'Stroke or death at 4 years', quantity_type: 'proportion', value: 7.2, unit: '%',
  source_quote: 'x'.repeat(400), location_hint: 'Results',
}
const verdict = { tier: 'verified-proportion', verificationVersion: VERIFICATION_VERSION, flagged: false, relationshipValidated: true, endpointValidated: false, relationshipStatus: 'proportion-validated', sourceTier: 'full_text' }

describe('buildBadgeReport — enough provenance to investigate', () => {
  it('records paper, value, verdict, versions, source and surface', () => {
    const r = buildBadgeReport({ surface: 'library', pmid: 123, quantity, verdict, extractionVersion: CURRENT_EXTRACTION_VERSION, sourceTier: 'full_text', sourceHash: 'abc', reportId: 'r1', now: new Date('2026-10-09T12:00:00Z') })
    expect(r).toMatchObject({
      reportId: 'r1', surface: 'library', pmid: '123', name: quantity.name, value: '7.2%',
      tier: 'verified-proportion', relationshipStatus: 'proportion-validated', endpointValidated: false,
      verificationVersion: VERIFICATION_VERSION, extractionVersion: CURRENT_EXTRACTION_VERSION,
      sourceTier: 'full_text', sourceHash: 'abc', reportedAt: '2026-10-09T12:00:00.000Z',
    })
    expect(r.quantity).toMatchObject({ value: 7.2, unit: '%', quantity_type: 'proportion', location_hint: 'Results' })
    expect(r.quote).toHaveLength(300)
  })
  it('reports a stale verdict as legacy instead of inheriting the current guarantee', () => {
    const r = buildBadgeReport({ surface: 'digest', pmid: '1', quantity, verdict: { tier: 'verified-full-text', verificationVersion: 'old' }, reportId: 'r' })
    expect(r.tier).toBe('legacy-unchecked')
    expect(r.originalTier).toBe('verified-full-text')
  })
  it('refuses an unknown surface or a missing paper', () => {
    expect(() => buildBadgeReport({ surface: 'elsewhere', pmid: '1', quantity, verdict })).toThrow()
    expect(() => buildBadgeReport({ surface: 'digest', pmid: null, quantity, verdict })).toThrow()
  })
})

describe('buildFeedback', () => {
  it('trims, caps and refuses empty text', () => {
    expect(() => buildFeedback({ text: '   ' })).toThrow()
    const f = buildFeedback({ text: ` ${'a'.repeat(FEEDBACK_MAX + 50)} `, view: 'digest', reportId: 'r' })
    expect(f.text).toHaveLength(FEEDBACK_MAX)
    expect(f.view).toBe('digest')
  })
})

describe('submitReport — success only on a confirmed durable write', () => {
  it('resolves the stored id', async () => {
    const client = fakeClient({ data: { id: 42 }, error: null })
    await expect(submitReport(BADGE_REPORT_TYPE, { a: 1 }, { client, user, configured: true })).resolves.toEqual({ id: 42 })
    expect(client.inserted[0]).toEqual({ table: 'events', row: { user_id: 'user-1', type: 'badge_reported', payload: { a: 1 } } })
  })
  it('throws on a server error, a network throw, or an unconfirmed insert', async () => {
    await expect(submitReport('t', {}, { client: fakeClient({ data: null, error: { message: 'RLS' } }), user, configured: true })).rejects.toThrow(/RLS/)
    await expect(submitReport('t', {}, { client: fakeClient(() => { throw new Error('offline') }), user, configured: true })).rejects.toThrow(/offline/)
    await expect(submitReport('t', {}, { client: fakeClient({ data: null, error: null }), user, configured: true })).rejects.toThrow(/did not confirm/)
  })
  it('throws when signed out or unconfigured, writing nothing', async () => {
    const client = fakeClient({ data: { id: 1 }, error: null })
    await expect(submitReport('t', {}, { client, user: null, configured: true })).rejects.toThrow(/Sign in/)
    await expect(submitReport('t', {}, { client, user, configured: false })).rejects.toThrow()
    expect(client.inserted).toHaveLength(0)
  })
})

describe('reportSender — failure keeps a retry path; retries keep the report id', () => {
  it('fails, then succeeds on retry with the same report id, then never re-inserts', async () => {
    const ids = []
    let fail = true
    const submit = vi.fn(async (type, payload) => {
      ids.push(payload.reportId)
      if (fail) throw new Error('Not sent: offline')
      return { id: 7 }
    })
    const s = reportSender(FEEDBACK_TYPE, (reportId) => ({ reportId }), { submit, reportId: 'fixed' })
    expect(await s.send()).toEqual({ status: 'failed', error: 'Not sent: offline' })
    expect(s.receipt).toBe(null)
    fail = false
    expect(await s.send()).toEqual({ status: 'sent', id: 7 })
    expect(await s.send()).toEqual({ status: 'sent', id: 7 })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(ids).toEqual(['fixed', 'fixed'])
  })
  it('double taps while sending share one insert', async () => {
    let release
    const submit = vi.fn(() => new Promise((r) => { release = () => r({ id: 1 }) }))
    const s = reportSender('t', (id) => ({ id }), { submit })
    const a = s.send()
    const b = s.send()
    release()
    expect(await a).toEqual(await b)
    expect(submit).toHaveBeenCalledTimes(1)
  })
  it('a payload that cannot be built is a failure, not a receipt', async () => {
    const s = reportSender('t', () => { throw new Error('Write a few words first.') }, { submit: vi.fn() })
    expect(await s.send()).toEqual({ status: 'failed', error: 'Write a few words first.' })
  })
})

describe('report and feedback controls — truthful states', () => {
  const report = { surface: 'digest', pmid: '1', quantity, verdict }
  const html = (el) => renderToStaticMarkup(el)
  it('the badge report control is absent with nowhere durable to send it', () => {
    expect(html(React.createElement(ReportBadgeButton, { report, enabled: false }))).toBe('')
    expect(html(React.createElement(ReportBadgeButton, { report: { ...report, pmid: null }, enabled: true }))).toBe('')
  })
  it('idle offers the report; failed offers Retry and no thank-you; sent thanks', () => {
    expect(html(React.createElement(ReportBadgeButton, { report, enabled: true }))).toContain('This badge is wrong?')
    const failed = html(React.createElement(ReportBadgeButton, { report, enabled: true, initialState: 'failed' }))
    expect(failed).toContain('Report not sent')
    expect(failed).toContain('>Retry<')
    expect(failed).not.toContain('Thank you')
    expect(html(React.createElement(ReportBadgeButton, { report, enabled: true, initialState: 'sent' }))).toContain('Reported.')
  })
  it('Beta label and feedback entry render; the dialog shows a retry path on failure', () => {
    expect(html(React.createElement(BetaLabel))).toContain('Beta')
    expect(html(React.createElement(FeedbackButton, { enabled: true }))).toContain('Send feedback')
    expect(html(React.createElement(FeedbackButton, { enabled: false }))).toBe('')
    const failed = html(React.createElement(FeedbackDialog, { onClose: () => {}, initialState: 'failed' }))
    expect(failed).toContain('role="dialog"')
    expect(failed).toContain('Not sent.')
    expect(failed).toContain('>Retry<')
    expect(failed).not.toContain('Received')
  })
})
