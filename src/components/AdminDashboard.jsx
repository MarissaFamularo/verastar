// components/AdminDashboard.jsx — aggregate beta metrics for allowlisted admins
// (docs/BETA_ADMIN_DASHBOARD.md). Mounted in Settings only after beta_admin_check() said
// yes; the data itself comes from beta_admin_stats(), which refuses anyone else, so this
// screen shows nothing a non-admin could not already see. Counts only: no names, no emails,
// no individual survey answers.

import { useEffect, useRef, useState } from 'react'
import { defaultRange, fetchBetaStats, metricSections, rangeFromInputs, surveyDistributions } from '../lib/betaAdmin.js'

const eyebrow = { margin: 0, fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }
const inputStyle = { padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 13, fontFamily: 'inherit', outline: 'none' }
const panel = { marginTop: 14, borderRadius: 10, border: '1px solid rgba(255,255,255,.08)', background: 'var(--surface-1)', padding: '12px 13px' }

export default function AdminDashboard({ active = true }) {
  const [{ fromDate, toDate }, setDates] = useState(() => defaultRange())
  const [state, setState] = useState({ phase: 'idle' })
  const loadedOnce = useRef(false)

  async function load(f = fromDate, t = toDate) {
    const range = rangeFromInputs(f, t)
    if (range.error) {
      setState({ phase: 'invalid', message: range.error })
      return
    }
    setState({ phase: 'loading' })
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
      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
        Aggregate counts for the beta, computed on the server from records that already exist. Every figure carries its definition; “Not available” means the record kind does not cover the range, never zero activity.
      </p>

      <form onSubmit={(e) => { e.preventDefault(); load() }} className="flex items-end flex-wrap" style={{ marginTop: 14, gap: 10 }}>
        <label style={{ fontSize: 12, color: 'var(--color-fg-soft)' }}>
          From
          <input type="date" aria-label="From date" value={fromDate} onChange={(e) => setDates((d) => ({ ...d, fromDate: e.target.value }))} style={{ ...inputStyle, display: 'block', marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--color-fg-soft)' }}>
          To
          <input type="date" aria-label="To date" value={toDate} onChange={(e) => setDates((d) => ({ ...d, toDate: e.target.value }))} style={{ ...inputStyle, display: 'block', marginTop: 4 }} />
        </label>
        <button type="submit" disabled={state.phase === 'loading'} className="cursor-pointer" style={{ padding: '9px 15px', border: 0, borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: state.phase === 'loading' ? 0.5 : 1 }}>
          {state.phase === 'loading' ? 'Loading…' : 'Update'}
        </button>
      </form>
      <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--color-fg-faint)' }}>Inclusive calendar dates in your local time zone; the default is the last 30 days.</p>

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
          {sections.map((section) => (
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

          <section style={panel} aria-label="Survey answers">
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
