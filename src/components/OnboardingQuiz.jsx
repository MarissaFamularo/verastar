// components/OnboardingQuiz.jsx — the first-run flow: "watch it build my profile in 60 seconds."
//
// Faithful port of design/Onboarding.dc.html onto the real pipeline. Five steps:
// welcome → connect (BYOK — the only place a brand-new user can enter a key) →
// intake (three questions) → drafting (constellation animation while one Claude
// call drafts the steering profile) → review (edit everything, then enter).
// A demo path on the welcome screen seeds DEMO_PROFILE so the app demos keyless.
//
// `preview` mode (App mounts this at ?firstrun=1): nothing persists — no key
// writes, no saveProfile — and drafting is a timed animation instead of a paid
// call, so the flow can be walked end-to-end for free.

import { useEffect, useState } from 'react'
import { hasApiKey, setApiKey, setNcbiKey, setNcbiEmail } from '../lib/anthropic.js'
import { supabaseConfigured, sendMagicLink } from '../lib/supabase.js'
import { saveProfile } from '../lib/store.js'
import { draftProfile, DEMO_PROFILE, DEFAULT_RUBRIC, DEFAULT_SELECT_COUNT } from '../pipeline/onboard.js'
import ChipGroup from './ChipGroup.jsx'
import RubricEditor from './RubricEditor.jsx'

const QUESTIONS = [
  {
    key: 'focus',
    label: 'Your specialty, and how the digest should address you',
    placeholder: "e.g. I'm a vascular surgeon — call me Dr. Famularo.",
  },
  {
    key: 'projects',
    label: "What you're actively working on",
    placeholder: 'e.g. Running a limb-preservation program; a utilization study on CLTI admissions.',
  },
  {
    key: 'priorities',
    label: 'What makes a paper worth your morning — and what to skip',
    placeholder: 'e.g. Practice-changing trials with hard endpoints. Skip preclinical work and editorials.',
  },
]

// Shared observatory styles for this flow.
const stepMark = { margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: '#6d7484' }
const stepTitle = { margin: '12px 0 0', fontFamily: 'var(--font-serif)', fontSize: 34, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)' }
const stepLede = { margin: '12px 0 0', fontSize: 15.5, lineHeight: 1.6, color: 'var(--color-fg-dim)', maxWidth: 520 }
const fieldLabel = { display: 'block', fontSize: 13, color: '#aab0be', fontWeight: 500 }
const inputStyle = {
  marginTop: 8,
  width: '100%',
  padding: '12px 15px',
  borderRadius: 11,
  border: '1px solid rgba(255,255,255,.1)',
  background: 'var(--surface-input)',
  color: 'var(--color-fg)',
  fontSize: 15,
  fontFamily: 'inherit',
  outline: 'none',
}
const primaryBtn = {
  padding: '12px 24px',
  border: 0,
  borderRadius: 11,
  background: 'var(--color-accent)',
  color: '#1c1206',
  fontSize: 15,
  fontWeight: 600,
  fontFamily: 'inherit',
}
const ghostLink = { border: 0, background: 'transparent', padding: 0, fontSize: 14, color: 'var(--color-fg-muted)', fontFamily: 'inherit' }

// The observatory mark — five-point outline chart star (never a four-point sparkle).
function ChartStar({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--color-gold)" strokeWidth="1.3" strokeLinejoin="round" aria-label="Verastar">
      <polygon points="12,3 14.47,9.6 21.51,9.91 15.99,14.3 17.88,21.09 12,17.2 6.12,21.09 8.01,14.3 2.49,9.91 9.53,9.6" />
    </svg>
  )
}

// The drafting constellation — pulsing stars linked by faint lines, straight from the mockup.
function DraftingConstellation() {
  const stars = [
    { left: 110, top: 40, size: 16, color: 'var(--color-accent-bright)', glow: 'rgba(239,143,91,.7)', delay: 0 },
    { left: 40, top: 90, size: 11, color: 'var(--color-gold)', glow: 'rgba(233,196,106,.6)', delay: 0.3 },
    { left: 180, top: 80, size: 10, color: 'var(--color-registry)', glow: 'rgba(143,189,230,.6)', delay: 0.6 },
    { left: 150, top: 24, size: 8, color: 'var(--color-verified)', glow: 'rgba(127,191,154,.6)', delay: 0.9 },
    { left: 90, top: 112, size: 7, color: 'var(--color-fg-soft)', glow: 'transparent', delay: 1.2 },
  ]
  return (
    <div className="relative" style={{ height: 130, margin: '0 auto', width: 220 }}>
      <svg viewBox="0 0 220 130" className="absolute" style={{ inset: 0, width: '100%', height: '100%' }}>
        <line x1="40" y1="90" x2="110" y2="40" stroke="rgba(239,143,91,.4)" strokeWidth="1" />
        <line x1="110" y1="40" x2="180" y2="80" stroke="rgba(239,143,91,.4)" strokeWidth="1" />
        <line x1="110" y1="40" x2="150" y2="24" stroke="rgba(233,196,106,.35)" strokeWidth="1" />
        <line x1="40" y1="90" x2="90" y2="112" stroke="rgba(255,255,255,.15)" strokeWidth="1" />
      </svg>
      {stars.map((s) => (
        <span
          key={`${s.left}-${s.top}`}
          className="absolute"
          style={{
            left: s.left,
            top: s.top,
            transform: 'translate(-50%,-50%)',
            width: s.size,
            height: s.size,
            borderRadius: '50%',
            background: s.color,
            boxShadow: s.glow === 'transparent' ? 'none' : `0 0 ${s.size + 2}px 3px ${s.glow}`,
            animation: `vs-pulse 1.8s ease-in-out ${s.delay}s infinite`,
          }}
        />
      ))}
    </div>
  )
}

export default function OnboardingQuiz({ onDone, preview = false }) {
  const [step, setStep] = useState('welcome') // welcome | signin | connect | intake | drafting | review
  const [keyInput, setKeyInput] = useState('')
  const [ncbiInput, setNcbiInput] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [answers, setAnswers] = useState({})
  const [draft, setDraft] = useState(null) // { name, northStars, projects, rubric:{criteria,selectCount} }
  const [error, setError] = useState('')
  // Returning-user sign-in from the welcome screen (accounts configured only).
  const [signinEmail, setSigninEmail] = useState('')
  const [signinState, setSigninState] = useState('idle') // idle | sending | sent | error
  const [signinError, setSigninError] = useState('')
  const keySet = hasApiKey()
  const answered = QUESTIONS.some((q) => (answers[q.key] || '').trim())

  // Drafting runs as an effect so the animation frame mounts before the call starts.
  useEffect(() => {
    if (step !== 'drafting') return
    let alive = true
    if (preview) {
      // Preview: the animation without the spend — land on review with the demo draft.
      const t = setTimeout(() => {
        if (!alive) return
        setDraft({ ...DEMO_PROFILE, rubric: { ...DEMO_PROFILE.rubric } })
        setStep('review')
      }, 2600)
      return () => { alive = false; clearTimeout(t) }
    }
    const labeled = Object.fromEntries(QUESTIONS.map((q) => [q.label, answers[q.key] || '']))
    draftProfile({ answers: labeled })
      .then((profile) => {
        if (!alive) return
        setDraft({ name: profile.name, ...profile })
        setStep('review')
      })
      .catch((err) => {
        if (!alive) return
        setError(err?.message || String(err))
        setStep('intake')
      })
    return () => { alive = false }
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  function connectContinue(e) {
    e.preventDefault()
    if (!preview) {
      if (keyInput.trim()) setApiKey(keyInput)
      if (emailInput.trim()) setNcbiEmail(emailInput)
      if (ncbiInput.trim()) setNcbiKey(ncbiInput)
      if (!hasApiKey()) return // key required to interview; the demo path is on the welcome screen
    }
    setError('')
    setStep('intake')
  }

  // Send the returning-user magic link. Finishing sign-in is the emailed link's job:
  // opening it lands a session, App reboots onto the cloud profile, and this flow
  // never resumes — so there's nothing to persist or call back here.
  async function sendSigninLink(e) {
    e.preventDefault()
    if (!signinEmail.trim()) return
    setSigninState('sending')
    setSigninError('')
    try {
      await sendMagicLink(signinEmail.trim())
      setSigninState('sent')
    } catch (err) {
      setSigninError(err?.message || String(err))
      setSigninState('error')
    }
  }

  function useDemo() {
    // The demo flag is stamped here (not in pipeline/onboard.js) so the app can
    // label demo mode honestly — pipeline stays untouched.
    const demoProfile = { ...DEMO_PROFILE, demo: true }
    if (preview) { onDone?.(demoProfile); return }
    saveProfile(demoProfile).then(() => onDone?.(demoProfile))
  }

  async function save() {
    const profile = {
      name: (draft.name || 'Doctor').trim(),
      northStars: draft.northStars || [],
      projects: draft.projects || [],
      rubric: {
        criteria: (draft.rubric?.criteria || DEFAULT_RUBRIC).trim(),
        selectCount: draft.rubric?.selectCount || DEFAULT_SELECT_COUNT,
      },
      onboarded: true,
    }
    if (!preview) await saveProfile(profile)
    onDone?.(profile)
  }

  // Draft edit helpers.
  const setField = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const addTo = (field) => (v) => setDraft((d) => ((d[field] || []).includes(v) ? d : { ...d, [field]: [...(d[field] || []), v] }))
  const removeFrom = (field) => (v) => setDraft((d) => ({ ...d, [field]: (d[field] || []).filter((x) => x !== v) }))

  // ===== WELCOME =====
  if (step === 'welcome') {
    return (
      <div style={{ textAlign: 'center' }}>
        <div className="inline-flex" style={{ animation: 'vs-glow 4s ease-in-out infinite' }}>
          <ChartStar />
        </div>
        <h1 className="vs-onboard-title" style={{ margin: '18px 0 0', fontFamily: 'var(--font-serif)', fontSize: 52, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)' }}>Verastar</h1>
        <p style={{ margin: '16px 0 0', fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 21, lineHeight: 1.5, color: 'var(--color-fg-soft)' }}>
          A verified evidence digest, keeping you current<br />on the latest literature in your field.
        </p>
        <div className="flex flex-col items-center" style={{ marginTop: 36, gap: 16 }}>
          <button
            onClick={() => setStep('connect')}
            className="cursor-pointer"
            style={{ ...primaryBtn, padding: '14px 30px', borderRadius: 12, boxShadow: '0 10px 34px -10px rgba(239,143,91,.75)' }}
          >
            Set up my digest →
          </button>
          <button onClick={useDemo} className="cursor-pointer" style={ghostLink}>
            Explore with a demo profile
          </button>
          <p style={{ margin: '-6px 0 0', fontSize: 12, color: 'var(--color-fg-faint)' }}>
            A sample profile, no key needed — in demo mode nothing leaves this browser.
          </p>
          {/* Returning users skip setup entirely — their library lives in their account.
              Hidden in ?firstrun=1 preview: sending a link is a real action, and preview saves nothing. */}
          {supabaseConfigured && !preview && (
            <button onClick={() => setStep('signin')} className="cursor-pointer" style={{ ...ghostLink, marginTop: 6, color: 'var(--color-fg-soft)' }}>
              Have an account? <span style={{ color: 'var(--color-accent)' }}>Sign in</span>
            </button>
          )}
        </div>
      </div>
    )
  }

  // ===== SIGN IN (returning user on a new device) =====
  if (step === 'signin') {
    return (
      <div>
        <p style={stepMark}>SIGN IN</p>
        <h2 className="vs-step-title" style={stepTitle}>Welcome back.</h2>
        <p style={stepLede}>
          Your library lives in your account. Enter the email you signed up with and we&rsquo;ll
          send a one-time sign-in link — open it on this device and your library follows you here.
          No password, ever.
        </p>
        {signinState === 'sent' ? (
          <div style={{ marginTop: 24, padding: '12px 15px', borderRadius: 11, background: 'rgba(127,191,154,.1)', color: 'var(--color-verified-soft)', fontSize: 14, lineHeight: 1.55, maxWidth: 520 }}>
            <span style={{ fontWeight: 600 }}>Link sent to {signinEmail.trim()}</span> — open it on this
            device to finish signing in.
          </div>
        ) : (
          <form onSubmit={sendSigninLink} style={{ marginTop: 24, maxWidth: 520 }}>
            <label style={fieldLabel}>Account email</label>
            <input
              type="email"
              value={signinEmail}
              onChange={(e) => setSigninEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
              style={inputStyle}
            />
            {signinState === 'error' && (
              <div style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 600 }}>Couldn&rsquo;t send the link:</span> {signinError}
              </div>
            )}
            <div className="flex items-center" style={{ marginTop: 20, gap: 18 }}>
              <button type="submit" disabled={signinState === 'sending'} className="cursor-pointer" style={{ ...primaryBtn, opacity: signinState === 'sending' ? 0.6 : 1 }}>
                {signinState === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
              </button>
              <button type="button" onClick={() => { setStep('welcome'); setSigninState('idle'); setSigninError('') }} className="cursor-pointer" style={ghostLink}>
                ← Back
              </button>
            </div>
          </form>
        )}
        {signinState === 'sent' && (
          <button onClick={() => { setStep('welcome'); setSigninState('idle') }} className="cursor-pointer" style={{ ...ghostLink, marginTop: 18 }}>
            ← Back
          </button>
        )}
      </div>
    )
  }

  // ===== CONNECT =====
  if (step === 'connect') {
    return (
      <div>
        <p style={stepMark}>01 / 03 · CONNECT</p>
        <h2 className="vs-step-title" style={stepTitle}>Bring your own key.</h2>
        <p style={{ ...stepLede, maxWidth: 500 }}>
          Verastar runs on your Anthropic key — you paste it in, and the app uses it to do the
          work. No shared model bill, no lock-in.
        </p>

        <form onSubmit={connectContinue}>
          <div style={{ marginTop: 28 }}>
            <label style={fieldLabel}>Anthropic API key</label>
            {keySet && !keyInput ? (
              <div className="flex items-center" style={{ marginTop: 8, gap: 10, padding: '11px 14px', borderRadius: 11, background: 'var(--surface-1)', border: '1px solid rgba(255,255,255,.08)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-verified)', boxShadow: '0 0 7px var(--color-verified)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-fg-soft)', fontSize: 13, letterSpacing: '.05em' }}>sk-ant-••••••••••••••••</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-verified-soft)', fontWeight: 600 }}>Active</span>
              </div>
            ) : (
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-ant-…"
                autoComplete="off"
                style={inputStyle}
              />
            )}
            <label style={{ ...fieldLabel, marginTop: 18 }}>
              NCBI email <span style={{ color: 'var(--color-fg-faint)', fontWeight: 400 }}>· optional</span>
            </label>
            <input
              type="email"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              placeholder="you@institution.edu — polite identification to NCBI"
              autoComplete="off"
              style={inputStyle}
            />
            <label style={{ ...fieldLabel, marginTop: 14 }}>
              NCBI API key <span style={{ color: 'var(--color-fg-faint)', fontWeight: 400 }}>· optional</span>
            </label>
            <input
              value={ncbiInput}
              onChange={(e) => setNcbiInput(e.target.value)}
              placeholder="Raises PubMed rate limit 3 → 10 req/s"
              autoComplete="off"
              style={inputStyle}
            />
            <p style={{ margin: '14px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
              Your key lives only in this browser tab — never sent to our servers, never written
              to disk, and cleared when you close the tab.
            </p>
          </div>

          <div className="flex items-center" style={{ marginTop: 30, gap: 18 }}>
            <button type="submit" disabled={!preview && !keySet && !keyInput.trim()} className="cursor-pointer" style={{ ...primaryBtn, opacity: !preview && !keySet && !keyInput.trim() ? 0.5 : 1 }}>
              Continue →
            </button>
            <button type="button" onClick={() => setStep('welcome')} className="cursor-pointer" style={ghostLink}>
              Back
            </button>
          </div>
        </form>
      </div>
    )
  }

  // ===== INTAKE =====
  if (step === 'intake') {
    return (
      <div>
        <p style={stepMark}>02 / 03 · INTERVIEW</p>
        <h2 className="vs-step-title" style={stepTitle}>Three questions.</h2>
        <p style={stepLede}>
          Answer in your own words — Claude drafts your north stars, projects, and ranking
          rubric from these. You review and edit everything before it's saved.
        </p>

        <div className="flex flex-col" style={{ marginTop: 26, gap: 20 }}>
          {QUESTIONS.map((q) => (
            <div key={q.key}>
              <label style={{ display: 'block', fontSize: 14, color: 'var(--color-fg-soft)', fontWeight: 500 }}>{q.label}</label>
              <textarea
                value={answers[q.key] || ''}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                rows={2}
                placeholder={q.placeholder}
                style={{ ...inputStyle, resize: 'vertical', padding: '11px 14px', fontSize: 14.5, lineHeight: 1.55 }}
              />
            </div>
          ))}
        </div>

        {error && (
          <div style={{ marginTop: 18, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ fontWeight: 600 }}>Drafting failed:</span> {error}
          </div>
        )}

        <div className="flex items-center" style={{ marginTop: 28, gap: 18 }}>
          <button
            onClick={() => { setError(''); setStep('drafting') }}
            disabled={!answered || (!preview && !keySet)}
            className="cursor-pointer"
            style={{ ...primaryBtn, opacity: !answered || (!preview && !keySet) ? 0.5 : 1 }}
          >
            ✶ Draft my profile
          </button>
          <button onClick={() => setStep('connect')} className="cursor-pointer" style={ghostLink}>
            Back
          </button>
        </div>
      </div>
    )
  }

  // ===== DRAFTING =====
  if (step === 'drafting') {
    return (
      <div style={{ textAlign: 'center', padding: '40px 0' }}>
        <DraftingConstellation />
        <p style={{ margin: '24px 0 0', fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 22, color: 'var(--color-fg)' }}>
          Charting your north stars…
        </p>
        <p style={{ margin: '10px 0 0', fontSize: 14.5, color: 'var(--color-fg-dim)' }}>
          Reading your answers and drafting concepts, projects, and a ranking rubric.
        </p>
      </div>
    )
  }

  // ===== REVIEW =====
  return (
    <div>
      <p style={stepMark}>03 / 03 · REVIEW</p>
      <h2 className="vs-step-title" style={stepTitle}>Your steering profile.</h2>
      <p style={stepLede}>
        Drafted from your answers — edit anything, then enter. You can always tune it later
        from Settings.
      </p>

      <div className="flex flex-col" style={{ marginTop: 24, gap: 22 }}>
        <div>
          <label style={fieldLabel}>Digest greeting</label>
          <input
            value={draft?.name || ''}
            onChange={(e) => setField({ name: e.target.value })}
            style={{ ...inputStyle, padding: '11px 14px' }}
          />
        </div>

        <ChipGroup
          label="North stars"
          hint="Concepts you steer by (used as search terms)"
          items={draft?.northStars || []}
          onAdd={addTo('northStars')}
          onRemove={removeFrom('northStars')}
          placeholder="e.g. CLTI outcomes"
          accent="sky"
        />
        <ChipGroup
          label="Active Work"
          hint="What the relevance line speaks to"
          items={draft?.projects || []}
          onAdd={addTo('projects')}
          onRemove={removeFrom('projects')}
          placeholder="e.g. Limb Preservation Program"
        />

        <RubricEditor
          criteria={draft?.rubric?.criteria ?? DEFAULT_RUBRIC}
          selectCount={draft?.rubric?.selectCount ?? DEFAULT_SELECT_COUNT}
          onChange={(rubric) => setField({ rubric })}
        />
      </div>

      <div className="flex items-center" style={{ marginTop: 28, gap: 18 }}>
        <button
          onClick={save}
          className="cursor-pointer"
          style={{ ...primaryBtn, padding: '13px 26px', borderRadius: 12, boxShadow: '0 10px 34px -12px rgba(239,143,91,.7)' }}
        >
          Enter Verastar →
        </button>
        <button onClick={() => setStep('intake')} className="cursor-pointer" style={ghostLink}>
          Back to questions
        </button>
      </div>
    </div>
  )
}
