// components/BetaFeedback.jsx — the small "Beta" mark and the one straightforward way to tell
// us something. Feedback is stored as a `beta_feedback` event through the same durable,
// receipt-only-on-success path as badge reports (lib/feedback.js).

import { useEffect, useRef, useState } from 'react'
import { FEEDBACK_MAX, FEEDBACK_TYPE, buildFeedback, canReport, reportSender, submitReport } from '../lib/feedback.js'

export function BetaLabel() {
  return (
    <span
      title="Verastar is in an early beta. Values are checked against the source, but read the source before relying on one."
      style={{ display: 'inline-flex', alignItems: 'center', borderRadius: 999, border: '1px solid rgba(239,143,91,.4)', padding: '1px 8px', fontSize: 10.5, fontWeight: 600, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--color-accent)', fontFamily: 'var(--font-mono)' }}
    >
      Beta
    </span>
  )
}

// A text button that opens the feedback dialog. Hidden when there is nowhere durable to send
// feedback (signed out / no account service). `view` names the screen it was sent from.
export function FeedbackButton({ view = null, style, enabled = canReport() }) {
  const [open, setOpen] = useState(false)
  if (!enabled) return null
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="cursor-pointer" style={{ border: 0, background: 'transparent', padding: '4px 0', minHeight: 24, fontSize: 12.5, color: 'var(--color-accent)', fontFamily: 'inherit', ...style }}>
        Send feedback
      </button>
      {open && <FeedbackDialog view={view} onClose={() => setOpen(false)} />}
    </>
  )
}

// Exported for tests; `initialState` and `submit` are test seams.
export function FeedbackDialog({ view, onClose, initialState = 'idle', submit = submitReport }) {
  const [text, setText] = useState('')
  const [state, setState] = useState(initialState) // idle | sending | sent | failed
  const [error, setError] = useState('')
  // A new sender per distinct message; a retry of the same text reuses its report id.
  const sender = useRef(null)
  const sentText = useRef('')
  const field = useRef(null)

  useEffect(() => { field.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function handleSubmit(e) {
    e.preventDefault()
    if (state === 'sending' || !text.trim()) return
    if (!sender.current || sentText.current !== text) {
      const body = text
      sender.current = reportSender(FEEDBACK_TYPE, (reportId) => buildFeedback({ text: body, view, reportId }), { submit })
      sentText.current = text
    }
    setState('sending')
    setError('')
    const res = await sender.current.send()
    if (res.status === 'sent') setState('sent')
    else { setError(res.error); setState('failed') }
  }

  const btn = { padding: '9px 15px', borderRadius: 10, fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }
  return (
    <div onClick={onClose} className="vs-modal-overlay fixed inset-0 flex items-center justify-center" style={{ zIndex: 70, padding: 16, background: 'rgba(5,6,10,.62)', backdropFilter: 'blur(3px)' }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vs-feedback-title"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460, maxWidth: '100%', borderRadius: 16, border: '1px solid rgba(255,255,255,.08)', background: 'linear-gradient(180deg,#141821,#0d1017)', padding: '20px 22px' }}
      >
        <div className="flex items-center" style={{ gap: 10 }}>
          <h2 id="vs-feedback-title" style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 21, fontWeight: 500, color: 'var(--color-fg)' }}>Beta feedback</h2>
          <BetaLabel />
          <button type="button" onClick={onClose} aria-label="Close feedback" className="cursor-pointer" style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--color-fg-muted)', fontSize: 18, padding: '4px 6px', fontFamily: 'inherit' }}>✕</button>
        </div>
        {state === 'sent' ? (
          <>
            <p aria-live="polite" style={{ margin: '14px 0 0', padding: '10px 13px', borderRadius: 10, background: 'rgba(127,191,154,.1)', color: 'var(--color-verified-soft)', fontSize: 13.5, lineHeight: 1.5 }}>
              Received. Thank you.
            </p>
            <button type="button" onClick={onClose} className="cursor-pointer" style={{ ...btn, marginTop: 14, border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: 'var(--color-fg-soft)' }}>Done</button>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <p style={{ margin: '10px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
              What worked, what confused you, what was wrong. To flag one number, use “This badge is wrong?” beside it. Please don’t include patient information.
            </p>
            <label htmlFor="vs-feedback-text" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Your feedback</label>
            <textarea
              id="vs-feedback-text"
              ref={field}
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, FEEDBACK_MAX))}
              rows={5}
              disabled={state === 'sending'}
              style={{ marginTop: 12, width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 14, fontFamily: 'inherit', outline: 'none', resize: 'vertical' }}
            />
            {state === 'failed' && (
              <p role="alert" style={{ margin: '10px 0 0', padding: '9px 12px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
                Not sent. {error.replace(/^Not sent:\s*/, '')} Your text is still here; try again.
              </p>
            )}
            <div className="flex items-center" style={{ marginTop: 12, gap: 10 }}>
              <button type="submit" disabled={!text.trim() || state === 'sending'} className="cursor-pointer" style={{ ...btn, border: 0, background: 'var(--color-accent)', color: '#1c1206', opacity: !text.trim() || state === 'sending' ? 0.55 : 1 }}>
                {state === 'sending' ? 'Sending…' : state === 'failed' ? 'Retry' : 'Send'}
              </button>
              <button type="button" onClick={onClose} className="cursor-pointer" style={{ ...btn, fontWeight: 500, border: '1px solid rgba(255,255,255,.14)', background: 'transparent', color: 'var(--color-fg-soft)' }}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
