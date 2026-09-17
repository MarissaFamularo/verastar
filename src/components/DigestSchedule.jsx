// components/DigestSchedule.jsx — the Settings block for a sponsored reader's morning
// digest: on or off, the hour, and a "run now". Renders nothing for anyone who cannot
// schedule (signed out, or not sponsored), so BYOK settings are unchanged.

import { useEffect, useState } from 'react'
import { canSchedule, getDigestSchedule, setDigestSchedule, runScheduledDigestNow, browserTimezone, hourLabel, DEFAULT_HOUR } from '../lib/digestSchedule.js'

export default function DigestSchedule() {
  const [row, setRow] = useState(null)
  const [state, setState] = useState('loading') // loading | idle | saving | running | error
  const [error, setError] = useState('')
  const [runNote, setRunNote] = useState('')
  const enabled = canSchedule()

  useEffect(() => {
    if (!enabled) return
    getDigestSchedule()
      .then((r) => { setRow(r); setState('idle') })
      .catch((err) => { setError(err.message); setState('error') })
  }, [enabled])

  if (!enabled) return null

  async function save(patch) {
    setState('saving')
    setError('')
    try {
      const next = await setDigestSchedule({
        enabled: patch.enabled ?? row?.enabled ?? true,
        hour: patch.hour ?? row?.hour_local ?? DEFAULT_HOUR,
        timezone: browserTimezone(),
      })
      setRow((cur) => ({ ...(cur || {}), enabled: next.enabled, hour_local: next.hour_local, timezone: next.timezone }))
      setState('idle')
    } catch (err) {
      setError(err.message)
      setState('error')
    }
  }

  async function runNow() {
    setState('running')
    setError('')
    setRunNote('')
    try {
      const out = await runScheduledDigestNow()
      setRunNote(out?.ran
        ? (out.phase === 'done' ? 'Your digest is ready. Open the Digest tab.' : out.phase === 'reading' ? 'Reading in progress; it will finish in the background over the next few minutes.' : out.note || 'Nothing new to read.')
        : out?.reason === "today's digest already exists" ? 'Today\u2019s digest is already here. The next run is tomorrow morning.' : 'Nothing ran.')
      setState('idle')
    } catch (err) {
      setError(err.message)
      setState('error')
    }
  }

  const on = row?.enabled ?? false
  const hour = row?.hour_local ?? DEFAULT_HOUR
  return (
    <div style={{ marginTop: 12, borderRadius: 10, border: '1px solid rgba(255,255,255,.08)', background: 'var(--surface-1)', padding: '10px 13px' }}>
      <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--color-fg-soft)' }}>Morning digest, ready when you wake up</p>
      <p style={{ margin: '3px 0 8px', fontSize: 11.5, color: 'var(--color-fg-faint)', lineHeight: 1.5 }}>
        Verastar can run your digest for you each morning. It waits until you have opened the last one, so nothing piles up unread.
      </p>
      <div className="flex flex-wrap items-center" style={{ gap: 10 }}>
        <label className="flex items-center cursor-pointer" style={{ gap: 6, fontSize: 12.5, color: 'var(--color-fg-soft)' }}>
          <input type="checkbox" checked={on} disabled={state !== 'idle'} onChange={(e) => save({ enabled: e.target.checked })} />
          Run automatically
        </label>
        <label className="flex items-center" style={{ gap: 6, fontSize: 12.5, color: 'var(--color-fg-soft)' }}>
          at
          <select value={hour} disabled={state !== 'idle' || !on} onChange={(e) => save({ hour: Number(e.target.value) })} style={{ borderRadius: 8, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', padding: '4px 8px', fontSize: 12.5, fontFamily: 'inherit' }}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <span style={{ color: 'var(--color-fg-faint)' }}>{browserTimezone()}</span>
        </label>
        <button type="button" onClick={runNow} disabled={state !== 'idle'} className="cursor-pointer" style={{ marginLeft: 'auto', padding: '6px 10px', border: '1px solid rgba(255,255,255,.14)', borderRadius: 8, background: 'transparent', color: 'var(--color-fg-soft)', fontSize: 11.5, fontFamily: 'inherit', opacity: state !== 'idle' ? 0.5 : 1 }}>
          {state === 'running' ? 'Running…' : 'Run now'}
        </button>
      </div>
      {row?.last_run_at && <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--color-fg-faint)' }}>Last run {new Date(row.last_run_at).toLocaleString()}.</p>}
      {runNote && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-verified-soft)' }}>{runNote}</p>}
      {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-domain-vascular)' }}>{error}</p>}
    </div>
  )
}
