// components/Day30Survey.jsx — the day-30 beta survey prompt on the digest screen.
//
// Renders nothing until the server says this account is past day 30 and has neither
// answered nor skipped (lib/betaSurvey.js day30SurveyDue); any failure there also renders
// nothing. Collapsed, it is one card with "Answer now" and "Not now" (hides it for this
// visit only, records nothing). Opened, it is the BetaSurvey form with the day-30 questions
// and a "Not now" in place of Skip: unlike signup, the day-30 wave cannot be skipped (the
// server refuses it), so the card comes back on every visit until the account answers. `autoOpen` (the digest email's ?survey=day30 link) opens
// it straight away. After an answer it thanks the reader and offers the existing free-text
// "Send feedback" box; the survey itself collects option codes only.

import { useEffect, useState } from 'react'
import BetaSurvey from './BetaSurvey.jsx'
import { FeedbackButton } from './BetaFeedback.jsx'
import { DAY30_INTRO, DAY30_QUESTIONS, day30SurveyDue } from '../lib/betaSurvey.js'

const card = { margin: '26px 0 0', borderRadius: 14, border: '1px solid rgba(239,143,91,.35)', background: 'rgba(239,143,91,.07)', padding: '16px 18px' }
const markStyle = { margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-accent)' }
const body = { margin: '6px 0 0', fontSize: 14, lineHeight: 1.55, color: 'var(--color-fg-soft)' }
const primary = { borderRadius: 9, border: 0, background: 'var(--color-accent)', color: '#1c1206', padding: '8px 14px', fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit' }
const ghost = { border: 0, background: 'transparent', padding: '8px 4px', fontSize: 13.5, color: 'var(--color-fg-muted)', fontFamily: 'inherit' }

// phase: 'checking' | 'hidden' | 'offer' | 'open' | 'thanks'
export default function Day30Survey({ autoOpen = false, isDue = day30SurveyDue }) {
  const [phase, setPhase] = useState('checking')

  useEffect(() => {
    let live = true
    Promise.resolve()
      .then(() => isDue())
      .catch(() => false)
      .then((due) => { if (live) setPhase(due ? (autoOpen ? 'open' : 'offer') : 'hidden') })
    return () => { live = false }
    // Checked once per mount (one visit); a changed prop must not re-ask mid-visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (phase === 'checking' || phase === 'hidden') return null

  if (phase === 'offer') {
    return (
      <section aria-label="Day-30 survey" style={card}>
        <p style={markStyle}>Beta · one month in</p>
        <p style={body}>You’ve had Verastar for about a month. As a beta tester, please answer five quick questions on how it’s going. It takes about a minute, and this will stay here until it’s done.</p>
        <div className="flex flex-wrap items-center" style={{ marginTop: 10, gap: 10 }}>
          <button type="button" onClick={() => setPhase('open')} className="cursor-pointer" style={primary}>Answer now</button>
          <button type="button" onClick={() => setPhase('hidden')} className="cursor-pointer" style={ghost}>Not now</button>
        </div>
      </section>
    )
  }

  if (phase === 'thanks') {
    return (
      <section aria-label="Day-30 survey" style={card}>
        <p style={markStyle}>Thank you</p>
        <p style={body}>Your answers are in. Anything the questions missed is welcome too.</p>
        <div style={{ marginTop: 6 }}><FeedbackButton view="day30-survey" style={{ fontSize: 13.5 }} /></div>
      </section>
    )
  }

  return (
    <section aria-label="Day-30 survey" style={{ ...card, padding: '20px 22px 22px' }}>
      <BetaSurvey
        wave="day30"
        questions={DAY30_QUESTIONS}
        intro={DAY30_INTRO}
        mark="BETA · DAY 30"
        heading="How’s it going?"
        skipLabel="Not now"
        onLater={() => setPhase('hidden')}
        onDone={(status) => setPhase(status === 'completed' ? 'thanks' : 'hidden')}
      />
    </section>
  )
}
