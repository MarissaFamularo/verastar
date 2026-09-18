// components/ProfileInterview.jsx — the interview, one question at a time.
//
// This is the conversational step that replaced the three-box intake. The rules it obeys are
// hers, from briefing-prompt.md: ask focused questions, adapt to the answers, propose
// concrete options when she's vague, cap at ~6 turns, and "don't ask me to fill out a giant
// form. Talk to me." So: ONE question on screen, one textarea, and a transcript above it she
// can read back. The model picks the next question from the whole transcript (pipeline/
// interview.js); this file is only the conversation surface and the two escape hatches —
// skip a question, or stop early and draft from what's there.
//
// Free paths, both scripted rather than paid: `preview` (?firstrun=1) walks the whole
// interview with the fixed question list and lands on a sample draft, and ANY failed turn
// falls back to the same list instead of dead-ending the only route into the app.

import { useEffect, useRef, useState } from 'react'
import {
  nextQuestion,
  draftProfileFromInterview,
  normalizeInterviewDraft,
  fallbackQuestion,
  outOfTurns,
  answeredTurns,
  OPENING_QUESTION,
  SCRIPTED_QUESTIONS,
  questionMeta,
} from '../pipeline/interview.js'
import { DEMO_PROFILE } from '../pipeline/onboard.js'

// The sample draft the preview lands on — shaped like a real one (her documented OR-based
// query style) so the review screen and the query validator can both be walked for free.
// Every query here was counted against live PubMed over a 3-day window and returns papers;
// the OR-joined forms are used deliberately, because juxtaposed concepts are ANDed by PubMed
// and a five-concept juxtaposition returns ~zero on a three-day scan.
const PREVIEW_TOPICS = [
  { label: 'Aortic Disease', query: 'aortic aneurysm OR aortic dissection OR TEVAR OR EVAR' },
  { label: 'Carotid Stenosis', query: 'carotid stenosis OR carotid endarterectomy OR carotid artery stenting' },
  { label: 'Limb Preservation / CLTI', query: 'peripheral artery disease OR limb ischemia OR diabetic foot OR wound healing amputation' },
  { label: 'Venous Disease', query: 'deep vein thrombosis OR venous insufficiency OR pelvic venous disease' },
  { label: 'AI / ML in Medicine', query: 'machine learning OR artificial intelligence OR deep learning clinical medicine surgery' },
  { label: 'LLMs in Healthcare', query: 'large language model healthcare clinical OR ChatGPT clinical OR GPT-4 medical' },
  { label: 'Surgical Education', query: 'surgical education OR surgical residency training OR surgical simulation OR operative competency assessment' },
]

const primaryBtn = {
  padding: '11px 22px',
  border: 0,
  borderRadius: 11,
  background: 'var(--color-accent)',
  color: '#1c1206',
  fontSize: 14.5,
  fontWeight: 600,
  fontFamily: 'inherit',
}
const ghostLink = { border: 0, background: 'transparent', padding: 0, fontSize: 13.5, color: 'var(--color-fg-muted)', fontFamily: 'inherit' }
const answerBox = {
  marginTop: 12,
  width: '100%',
  resize: 'vertical',
  borderRadius: 11,
  border: '1px solid rgba(255,255,255,.1)',
  background: 'var(--surface-input)',
  padding: '11px 14px',
  fontSize: 14.5,
  lineHeight: 1.55,
  color: 'var(--color-fg)',
  fontFamily: 'inherit',
  outline: 'none',
}

// One answered exchange, as it reads back in the transcript.
function Exchange({ question, answer }) {
  return (
    <li style={{ paddingLeft: 12, borderLeft: '1px solid rgba(255,255,255,.09)' }}>
      <p style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 14.5, fontStyle: 'italic', color: 'var(--color-fg-soft)', lineHeight: 1.5 }}>
        {question}
      </p>
      <p style={{ margin: '5px 0 0', fontSize: 13.5, lineHeight: 1.5, color: answer ? 'var(--color-fg-dim)' : 'var(--color-fg-faint)' }}>
        {answer || 'skipped'}
      </p>
    </li>
  )
}

export default function ProfileInterview({
  preview = false,
  selectCount,
  scoreFloor,
  onDraft,
  onCancel,
  cancelLabel = 'Back',
}) {
  // [{ question, answer }] — answered turns only. The question on screen is `question`.
  const [transcript, setTranscript] = useState([])
  const [question, setQuestion] = useState(OPENING_QUESTION)
  const [ack, setAck] = useState('')
  const [answer, setAnswer] = useState('')
  const [phase, setPhase] = useState('asking') // asking | thinking | drafting
  const [error, setError] = useState('')
  // Guards the async turns against a late setState after unmount. The flag is re-armed in
  // the effect BODY, not just cleared in the cleanup: StrictMode mounts, unmounts and
  // remounts in dev, and a ref initialized once stays false forever after that first
  // cleanup — which froze the interview on "Thinking about what to ask next…".
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const asked = transcript.length + (question ? 1 : 0)
  // Scripted questions carry a hint and an example answer; a model follow-up has neither
  // and is labelled as a follow-up instead of being numbered against the fixed four.
  const meta = questionMeta(question)

  // Drafting is the one paid call in this step. On failure the transcript stays on screen —
  // retyping six answers because a call timed out would be the worst possible failure here.
  function draftFrom(rows) {
    setPhase('drafting')
    setError('')
    if (preview) {
      const t = setTimeout(() => {
        if (!alive.current) return
        onDraft?.(
          normalizeInterviewDraft(
            { ...DEMO_PROFILE, rubric: DEMO_PROFILE.rubric.criteria, topics: PREVIEW_TOPICS },
            { selectCount, scoreFloor },
          ),
        )
      }, 2400)
      return () => clearTimeout(t)
    }
    draftProfileFromInterview({ transcript: rows, selectCount, scoreFloor })
      .then((draft) => {
        if (!alive.current) return
        onDraft?.(draft)
      })
      .catch((err) => {
        if (!alive.current) return
        setError(err?.message || String(err))
        // Every answer is already in the transcript, so there is nothing left to ask: the
        // only useful control is "try again". Returning to 'asking' here left an empty box
        // with a disabled Send and no way forward.
        setPhase('failed')
      })
  }

  // Advance the interview: record this answer, then either ask the next question or draft.
  // Every question needs an answer. There is deliberately no "skip" and no "that's enough"
  // (removed 2026-09-18): a digest drafted from half an interview is a bad first digest, and
  // a bad first digest is the one a new clinician judges the product by.
  function advance(text) {
    const rows = [...transcript, { question, answer: (text || '').trim() }]
    setTranscript(rows)
    setAnswer('')
    setAck('')
    if (outOfTurns(rows)) {
      draftFrom(rows)
      return
    }
    setPhase('thinking')
    if (preview) {
      const next = fallbackQuestion(rows)
      setTimeout(() => {
        if (!alive.current) return
        if (!next) { draftFrom(rows); return }
        setQuestion(next)
        setPhase('asking')
      }, 650)
      return
    }
    nextQuestion({ transcript: rows })
      .then((turn) => {
        if (!alive.current) return
        if (turn.done || !turn.question) { draftFrom(rows); return }
        setAck(turn.ack || '')
        setQuestion(turn.question)
        setPhase('asking')
      })
      .catch(() => {
        if (!alive.current) return
        // nextQuestion already degrades internally; this is the belt-and-braces path.
        const next = fallbackQuestion(rows)
        if (!next) { draftFrom(rows); return }
        setQuestion(next)
        setPhase('asking')
      })
  }

  if (phase === 'drafting') {
    return (
      <div style={{ padding: '30px 0' }}>
        <p style={{ margin: 0, fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 21, color: 'var(--color-fg)' }}>
          Writing your search plan…
        </p>
        <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--color-fg-dim)', maxWidth: 520 }}>
          Turning {answeredTurns(transcript)} answer{answeredTurns(transcript) === 1 ? '' : 's'} into
          PubMed queries, north stars, and a ranking rubric. You'll see all of it before anything is saved.
        </p>
      </div>
    )
  }

  return (
    <div>
      {transcript.length > 0 && (
        <ul style={{ margin: '0 0 22px', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {transcript.map((t, i) => (
            <Exchange key={i} question={t.question} answer={t.answer} />
          ))}
        </ul>
      )}

      <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 11.5, letterSpacing: '.12em', color: 'var(--color-fg-faint)', display: phase === 'failed' ? 'none' : undefined }}>
        {meta.scripted
          ? `QUESTION ${Math.min(asked, SCRIPTED_QUESTIONS.length)} OF ${SCRIPTED_QUESTIONS.length}`
          : 'ONE QUICK FOLLOW-UP'}
      </p>

      {ack && (
        <p style={{ margin: '10px 0 0', fontSize: 13.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>{ack}</p>
      )}

      {phase === 'failed' ? (
        <p style={{ margin: '10px 0 0', fontFamily: 'var(--font-serif)', fontSize: 20, lineHeight: 1.45, color: 'var(--color-fg)', maxWidth: 560 }}>
          I have your answers. I just couldn&rsquo;t finish setting things up.
        </p>
      ) : phase === 'thinking' ? (
        <p style={{ margin: '12px 0 0', fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 19, color: 'var(--color-fg-soft)' }}>
          Thinking about what to ask next…
        </p>
      ) : (
        <>
          <p style={{ margin: '10px 0 0', fontFamily: 'var(--font-serif)', fontSize: 22, lineHeight: 1.45, color: 'var(--color-fg)', maxWidth: 560 }}>
            {question}
          </p>
          {meta.hint && (
            <p style={{ margin: '8px 0 0', fontSize: 14.5, lineHeight: 1.6, color: 'var(--color-fg-dim)', maxWidth: 560 }}>{meta.hint}</p>
          )}
          <textarea
            key={question}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, shift+Enter is a newline — this is a conversation, not a form.
              if (e.key === 'Enter' && !e.shiftKey && answer.trim()) {
                e.preventDefault()
                advance(answer)
              }
            }}
            rows={meta.short ? 1 : 3}
            placeholder={meta.placeholder || 'Answer in your own words — a sentence or two is plenty.'}
            autoFocus
            style={answerBox}
          />
        </>
      )}

      {error && (
        <div style={{ marginTop: 14, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
          <span style={{ fontWeight: 600 }}>Something went wrong:</span> {error} Your answers are
          saved on this screen.
        </div>
      )}

      <div className="flex flex-wrap items-center" style={{ marginTop: 22, gap: 18 }}>
        {phase === 'failed' ? (
          <button onClick={() => draftFrom(transcript)} className="cursor-pointer" style={primaryBtn}>
            Try again →
          </button>
        ) : (
          <button
            onClick={() => advance(answer)}
            disabled={phase !== 'asking' || !answer.trim()}
            className="cursor-pointer"
            style={{ ...primaryBtn, opacity: phase !== 'asking' || !answer.trim() ? 0.5 : 1 }}
          >
            Send →
          </button>
        )}
        {onCancel && (
          <button onClick={onCancel} disabled={phase === 'thinking'} className="cursor-pointer" style={ghostLink}>
            {cancelLabel}
          </button>
        )}
      </div>
    </div>
  )
}
