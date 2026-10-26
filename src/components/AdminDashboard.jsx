// components/AdminDashboard.jsx — aggregate beta metrics for allowlisted admins
// (docs/BETA_ADMIN_DASHBOARD.md). Mounted in Settings only after beta_admin_check() said
// yes; the data itself comes from beta_admin_stats(), which refuses anyone else, so this
// screen shows nothing a non-admin could not already see. Metrics are counts only: no names,
// no emails, no individual survey answers. The Feedback section is the exception: it lists
// what beta users wrote in "Send feedback", with their sign-in email, so it can be answered.

import { useEffect, useRef, useState } from 'react'
import { defaultRange, fetchBetaFeedback, fetchBetaStats, metricSections, rangeFromInputs, surveyDistributions } from '../lib/betaAdmin.js'

const eyebrow = { margin: 0, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }
const inputStyle = { padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 13, fontFamily: 'inherit', outline: 'none' }
const panel = { marginTop: 14, borderRadius: 10, border: '1px solid rgba(255,255,255,.08)', background: 'var(--surface-1)', padding: '12px 13px' }

export default function AdminDashboard({ active = true }) {
  const [{ fromDate, toDate }, setDates] = useState(() => defaultRange())
  const [state, setState] = useState({ phase: 'idle' })
  const [feedback, setFeedback] = useState({ phase: 'idle' })
  const loadedOnce = useRef(false)

  async function load(f = fromDate, t = toDate) {
    if (state.phase === 'loading') return // one request at a time; the button stays focusable
    const range = rangeFromInputs(f, t)
    if (range.error) {
      setState({ phase: 'invalid', message: range.error })
      return
    }
    setState({ phase: 'loading' })
    fetchBetaFeedback().then((r) => setFeedback(r.ok ? { phase: 'ready', data: r.feedback } : { phase: 'error' }))
    const result = await fetchBetaStats(range)
    if (result.ok) setState({ phase: 'ready', stats: result.stats, days: range.days })
    else setState({ phase: result.reason === 'forbidden' ? 'forbidden' : 'error', message: result.message })
  }

  // Load once, the first time the section is shown; later loads are explicit.
  useEffect(() => {
    if (!active || loadedOnce.current) return
    loadedOnce.current = true
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const sections = state.phase === 'ready' ? metricSections(state.stats) : []
  const distributions = state.phase === 'ready' ? surveyDistributions(state.stats) : []

  return (
    <div>
      <p style={{ margin: 0, color: 'var(--color-fg-muted)' }}>People, API usage, and service health.</p>
      <details style={{ marginTop: 12 }}><summary>Survey and diagnostic date range</summary>
      <form onSubmit={(e) => { e.preventDefault(); load() }} className="flex items-end flex-wrap" style={{ marginTop: 14, gap: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--color-fg-soft)' }}>
          From
          <input type="date" aria-label="From date" value={fromDate} onChange={(e) => setDates((d) => ({ ...d, fromDate: e.target.value }))} style={{ ...inputStyle, display: 'block', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--color-fg-soft)' }}>
          To
          <input type="date" aria-label="To date" value={toDate} onChange={(e) => setDates((d) => ({ ...d, toDate: e.target.value }))} style={{ ...inputStyle, display: 'block', marginTop: 4 }} />
        </label>
        {/* Not `disabled` while loading: a disabled button loses keyboard focus to the page body,
            which breaks the settings dialog's Tab trap. Re-entry is refused in load() instead. */}
        <button type="submit" aria-busy={state.phase === 'loading'} className="cursor-pointer" style={{ padding: '9px 15px', border: 0, borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: state.phase === 'loading' ? 0.5 : 1 }}>
          {state.phase === 'loading' ? 'Loading…' : 'Update'}
        </button>
      </form>
      <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--color-fg-faint)' }}>Inclusive calendar dates in your local time zone; the default is the last 30 days. Main cards use the fixed windows shown.</p>
      </details>

      {state.phase === 'invalid' && <p role="alert" style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13 }}>{state.message}</p>}
      {state.phase === 'forbidden' && (
        <p role="alert" style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13 }}>
          This account is not on the beta admin list. The server refused the request.
        </p>
      )}
      {state.phase === 'error' && (
        <p role="alert" style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13 }}>
          The metrics could not be loaded{state.message ? ` (${state.message})` : ''}. Try again.
        </p>
      )}

      {state.phase === 'ready' && (
        <>
          <p style={{ margin: '14px 0 0', fontSize: 12, color: 'var(--color-fg-muted)' }}>
            {state.days} day{state.days === 1 ? '' : 's'} · computed {new Date(state.stats.generated_at).toLocaleString()}
          </p>
          <ReleaseOverview stats={state.stats} />
          <FeedbackInbox feedback={feedback} />
          <details style={panel}><summary>Technical diagnostics and metric definitions</summary>
          <p>Diagnostics include test accounts. Usage events are client-reported; deleted or missing events cannot prove inactivity.</p>
          {sections.filter(s => s.title !== 'Signup survey').map((section) => (
            <section key={section.title} style={panel} aria-label={section.title}>
              <p style={eyebrow}>{section.title}</p>
              {section.caveat && <p style={{ margin: '6px 0 0', fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-fg-muted)' }}>{section.caveat}</p>}
              <dl style={{ margin: '10px 0 0', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '10px 16px', alignItems: 'start' }}>
                {section.rows.map((r) => (
                  <div key={r.label} style={{ display: 'contents' }}>
                    <dt style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: 'var(--color-fg-soft)', fontWeight: 500 }}>{r.label}</div>
                      <div style={{ marginTop: 2, fontSize: 11.5, lineHeight: 1.45, color: 'var(--color-fg-faint)' }}>{r.definition}{r.note ? ` ${r.note}` : ''}</div>
                    </dt>
                    <dd style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 15, textAlign: 'right', color: r.available ? 'var(--color-fg)' : 'var(--color-abstract)', whiteSpace: 'nowrap' }}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}

          </details>
          <section style={panel} aria-label="Survey answers">
            <h3>Signup survey</h3>
            <p>{state.stats.survey?.completed ?? 0} completed · {state.stats.survey?.skipped ?? 0} skipped in the selected range. Known test responses excluded. Self-reported answers, not measured impact.</p>
            <p style={eyebrow}>Survey answers (completed surveys in range)</p>
            {distributions.map((d) => (
              <div key={d.key} style={{ marginTop: 12 }}>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--color-fg-soft)', fontWeight: 500 }}>{d.prompt}</p>
                <table style={{ marginTop: 6, width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <tbody>
                    {d.rows.map((r) => (
                      <tr key={r.code}>
                        <td style={{ padding: '3px 0', color: 'var(--color-fg-dim)' }}>{r.label}</td>
                        <td style={{ padding: '3px 0', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--color-fg)' }}>{r.count.toLocaleString()}</td>
                        <td style={{ padding: '3px 0 3px 10px', textAlign: 'right', width: 48, color: 'var(--color-fg-faint)' }}>{d.total ? `${Math.round((100 * r.count) / d.total)}%` : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  )
}

const money = value => value == null ? 'Unknown' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(value)
function Cards({ rows }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14, marginTop: 16 }}>{rows.map(([title, value, note]) => <section key={title} style={{ ...panel, marginTop: 0, padding: 18 }}><p style={eyebrow}>{title}</p><p style={{ fontSize: 32, fontFamily: 'var(--font-serif)', margin: '10px 0' }}>{value ?? 'Unknown'}</p><p style={{ fontSize: 12, color: 'var(--color-fg-muted)', margin: 0 }}>{note}</p></section>)}</div>
}
export function ReleaseOverview({ stats }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer) }, [])
  const a = stats.adoption || {}, s = stats.spend || {}, h = stats.health || {}
  const checks = (h.checks || []).map(c => {
    const age = now - Date.parse(c.checked_at)
    return { ...c, state: c.state === 'failed' ? 'failed' : ['heartbeat', 'schedule'].includes(c.name) && (!Number.isFinite(age) || age < 0 || age > 900000) ? 'stale' : c.state }
  })
  const failed = checks.some(c => c.state === 'failed') || h.mail_failed
  const healthy = ['heartbeat', 'schedule'].every(name => checks.some(c => c.name === name && c.state === 'ok')) && !failed
  const status = failed ? 'Needs attention' : healthy ? 'Monitor active · schedule on track' : 'Status unknown or stale'
  const color = failed ? '#f0a9a4' : healthy ? 'var(--color-verified-soft)' : 'var(--color-accent)'
  return <>
    <section aria-label="Service health" style={{ ...panel, borderColor: color, padding: 20 }}>
      <p style={eyebrow}>Service health</p><h3 style={{ color, fontSize: 26, margin: '8px 0' }}>{status}</h3>
      <p style={{ margin: 0 }}> {failed ? 'Sustained failures, overdue work, or alert delivery need investigation.' : healthy ? 'The monitor checked expected work successfully. No digest is overdue beyond its two-hour grace period.' : 'The monitor or expected-work check is missing or stale. Last observed failures remain visible.'}</p>
      <p style={{ fontSize: 12, color: 'var(--color-fg-muted)' }}>{checks.map(c => `${['signup', 'digest'].includes(c.name) ? c.name + ' outcome' : c.name}: ${c.state === 'unknown' && ['signup', 'digest'].includes(c.name) ? 'untested / no successful observation' : c.state}${['signup', 'digest'].includes(c.name) && c.checked_at ? ' (last observed ' + new Date(c.checked_at).toLocaleString() + ')' : ''}`).join(' · ') || 'Monitoring has not reported yet.'}</p>
      <p style={{ fontSize: 12 }}>{h.mail_failed ? 'Alert delivery failed; operator follow-up required.' : h.alerts_enabled ? 'Incident delivery configured; pending messages: ' + (h.pending_emails || 0) : 'Email alerts disabled pending recipient and mail configuration review.'}</p>
    </section>
    <Cards rows={[
      ['Real beta signups', a.signups, 'Enrolled accounts; known test enrollments excluded.'],
      ['Used in last 72 hours', a.active72, a.complete72 ? 'Unique people opening a digest, clicking a link in a digest email, or interacting with papers.' : 'Observed people; the 72-hour recording window is not complete yet.'],
      ['Returned users', a.returned, 'Meaningful use, in the app or by clicking a link in a digest email, on two or more UTC dates, in retained history.'],
      ['Email unsubscribes', stats.email?.unsubscribes, `In the selected range, by the link in the email. ${stats.email?.email_off_now ?? 'Unknown'} enrolled accounts have the email off now (link or Settings).`],
      ['Week 1 retention', a.eligible ? `${Math.round(100 * a.retained / a.eligible)}%` : 'Not ready', a.eligible ? `${a.retained} / ${a.eligible} eligible people returned during days 7–13.` : 'Insufficient history: no fully observed 14-day enrollment cohorts.'],
    ]} />
    <h3 style={{ marginBottom: 0 }}>API dollar usage</h3>
    <Cards rows={[
      ['Today · UTC', money(s.today), 'Recorded sponsor usage at API prices.'],
      ['This month · UTC', money(s.month), 'Includes test spending, paid failures and retries across sponsor pathways.'],
      ['Cost / completed digest', s.completed ? money(s.month / s.completed) : 'Not available', `${s.completed ?? 0} completed digests this month; see coverage below.`],
      ['Unresolved liability', money(s.outstanding), 'Reservations only. Not added to recorded usage.'],
    ]} />
    <details style={panel}><summary>Coverage and definitions</summary>
      <p>Adoption excludes automatic generation, app launches, permission checks, and known test enrollments. Meaningful use includes a click on any link in a digest or pause email (recorded by the click-through link), since the digest is read by email too. Multiple actions count once per person; returned users need two UTC dates. Events are observational and may be incomplete.</p>
      <p>Week 1 retention: all real enrollments after observation began, at least 14 days old; numerator is people with meaningful use in days 7–13 after enrollment. Non-users stay in the denominator. Observation began {a.coverage_since ? new Date(a.coverage_since).toLocaleString() : 'at an unknown time'}. Active access now: {a.access_now ?? 'unknown'} (permission only).</p>
      <p>Average is this month's total sponsor API usage divided by completed scheduled digest-days plus completed non-append browser digests for sponsored accounts. This is an operational blended cost, not exact per-job attribution; it includes other sponsor-paid features, failures, retries, and test work. Completion telemetry can be incomplete. BYOK costs are device-local and excluded. Recorded usage is estimated from token prices or operator reconciliation, not a provider invoice.</p>
      <p>Monitor and expected-work checks expire after 15 minutes. Signup and digest outcomes are last-observed evidence, not continuous capability tests. Expected work follows the configured local daily hour, active access, and unopened-digest gate; a single slot overdue by two hours is actionable. No weekly scheduler configuration exists in this release. It does not probe authentication email delivery, browser-only failures, or provider availability. An absent monitor cannot email about its own outage; the dashboard reports unknown/stale.</p>
      <p>Provider credit balance, grant consumption versus cash charge: unavailable. {s.released_unknown ?? 0} released attempts have no settled charge; this does not prove zero provider billing. Earliest spend record: {s.first_record || 'none'}.</p>
    </details>
  </>
}

// What beta users wrote in "Send feedback", newest first, and how many "this badge is
// wrong" reports came in. Messages from known test accounts are labelled, not hidden.
export function FeedbackInbox({ feedback }) {
  if (feedback.phase === 'error') {
    return <section aria-label="Feedback" style={panel}><h3 style={{ margin: 0 }}>Feedback</h3><p style={{ fontSize: 13, color: 'var(--color-fg-muted)' }}>Feedback could not be loaded. Use Update to try again.</p></section>
  }
  if (feedback.phase !== 'ready') return null
  const { messages = [], wrong_total: wrong = 0, wrong_7d: wrong7 = 0 } = feedback.data || {}
  return <>
    <h3 style={{ marginBottom: 0 }}>Feedback</h3>
    <Cards rows={[
      ['Feedback messages', messages.length, 'Sent from Send feedback, all time.'],
      ['“This is wrong” reports', wrong, `${wrong7} in the last 7 days. Readers flagging a verified number as wrong.`],
    ]} />
    <section aria-label="Feedback" style={panel}>
      {messages.length === 0
        ? <p style={{ margin: 0, fontSize: 13, color: 'var(--color-fg-muted)' }}>No feedback yet.</p>
        : messages.map((m, i) => (
          <article key={`${m.at}-${i}`} style={{ padding: '12px 0', borderTop: i ? '1px solid rgba(255,255,255,.08)' : 0 }}>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--color-fg-muted)' }}>
              {new Date(m.at).toLocaleString()} · {m.email ? <a href={`mailto:${m.email}`} style={{ color: 'var(--color-accent)' }}>{m.email}</a> : 'unknown sender'}{m.test ? ' · your test account' : ''}
            </p>
            <p style={{ margin: '6px 0 0', fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap', color: 'var(--color-fg-soft)' }}>{m.text}</p>
          </article>
        ))}
    </section>
  </>
}
