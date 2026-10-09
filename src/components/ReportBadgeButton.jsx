// components/ReportBadgeButton.jsx — "This badge is wrong?" on an evidence value, shared by
// the digest and the Library. The field channel for the one failure the product cannot
// survive: a green badge on a wrong value.
//
// The receipt is truthful: "Reported" appears only after the server confirms the stored
// report (lib/feedback.js). A failure says so and offers Retry, which re-sends the same
// report id. Signed out there is nowhere durable to send it, so the control is absent.
//
// Lifecycle follows the evidence, not the mounted component: rows are keyed by position, so
// the same instance can be handed a different value (or the same value under a new
// verifier/extraction version or source). The state is bound to badgeReportIdentity; a new
// identity shows a fresh control with a new report id, and a late reply for the previous
// identity can never change what the current one shows.

import { useState } from 'react'
import { BADGE_REPORT_TYPE, badgeReportIdentity, buildBadgeReport, canReport, reportSender, submitReport } from '../lib/feedback.js'

// `report` is the buildBadgeReport input minus reportId: { surface, pmid, quantity, verdict,
// extractionVersion, sourceTier, sourceHash }. `initialState` and `submit` are test seams.
export default function ReportBadgeButton({ report, style, initialState = 'idle', enabled = canReport(), submit = submitReport }) {
  const identity = badgeReportIdentity(report || {})
  // { identity, sender, status: 'sending' | 'sent' | 'failed', error }
  const [life, setLife] = useState(null)
  if (!enabled || !report?.pmid) return null
  const active = life?.identity === identity ? life : null
  const state = active?.status || initialState // idle | sending | sent | failed
  const error = active?.error || ''

  async function send() {
    if (state === 'sending' || state === 'sent') return
    // Same identity (a retry) keeps its sender and report id; a new identity gets a new one,
    // built from the props of THIS render.
    const snapshot = report
    const sender = active?.sender || reportSender(BADGE_REPORT_TYPE, (reportId) => buildBadgeReport({ ...snapshot, reportId }), { submit })
    setLife({ identity, sender, status: 'sending', error: '' })
    const res = await sender.send()
    setLife((cur) => (cur?.sender === sender
      ? { ...cur, status: res.status === 'sent' ? 'sent' : 'failed', error: res.status === 'sent' ? '' : res.error }
      : cur))
  }

  const base = { fontSize: 11, background: 'transparent', border: 0, padding: '4px 0', fontFamily: 'inherit', minHeight: 24 }
  return (
    <span aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', ...style }}>
      {state === 'sent' ? (
        <span style={{ ...base, color: 'var(--color-verified-soft)' }}>Reported. Thank you, we will check it against the paper.</span>
      ) : state === 'failed' ? (
        <>
          <span role="alert" style={{ ...base, color: 'var(--color-domain-vascular)' }}>Report not sent{error ? ` (${error.replace(/^Not sent:\s*/, '')})` : ''}.</span>
          <button type="button" onClick={send} className="cursor-pointer" style={{ ...base, color: 'var(--color-accent)', textDecoration: 'underline' }}>
            Retry
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={state === 'sending'}
          title="Tell us this value does not match the paper"
          className="cursor-pointer"
          style={{ ...base, color: 'var(--color-fg-faint)', opacity: state === 'sending' ? 0.6 : 1 }}
        >
          {state === 'sending' ? 'Sending report…' : 'This badge is wrong?'}
        </button>
      )}
    </span>
  )
}
