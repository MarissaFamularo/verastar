// components/OnboardingQuiz.jsx — the first-run flow: "watch it build my profile in 60 seconds."
//
// Faithful port of design/Onboarding.dc.html onto the real pipeline:
// welcome → account (configured production only) → connect (access code first, or BYOK — the only place
// a brand-new user can enter a key) →
// INTERVIEW (a real conversation, one question at a time — ProfileInterview.jsx) →
// review (confirm the greeting, topics, PubMed searches, north stars, and rubric).
// A demo path on the welcome screen seeds DEMO_PROFILE so the app demos keyless.
//
// The interview is the ONLY path. Four fixed plain-language questions (pipeline/interview.js)
// plus at most two model follow-ups. The old three-box "quick start" intake was removed on
// 2026-09-18: it offered a fork on the first question, never produced PubMed queries, and its
// one advantage (working without per-turn model calls) is now true of the script itself.
//
// `preview` mode (App mounts this at ?firstrun=1): nothing persists — no key
// writes, no saveProfile, no profile READ — and drafting is a timed
// animation instead of paid calls, so the flow can be walked end-to-end for free.

import { useRef, useState } from 'react'
import { hasApiKey, hasModelAccess, setApiKey } from '../lib/anthropic.js'
import { isSponsored } from '../lib/sponsor.js'
import InviteCode from './InviteCode.jsx'
import { currentNpiMatch } from '../lib/npi.js'
import { supabaseConfigured } from '../lib/supabase.js'
import { EmailCodeStatus } from './GmailAliasNotice.jsx'
import { useEmailCodeSignIn } from '../lib/emailCode.js'
import { useOnboardStep } from '../lib/onboardingRoute.js'
import { getProfile, saveProfile } from '../lib/store.js'
import { DEMO_PROFILE, DEFAULT_RUBRIC, DEFAULT_SELECT_COUNT } from '../pipeline/onboard.js'
import { mergeInterviewProfile } from '../pipeline/interview.js'
import { normalizeScoreFloor } from '../pipeline/select.js'
import { normalizeTopics, normalizeSearchDays, normalizeTopicCap } from '../pipeline/topics.js'
import ProfileInterview from './ProfileInterview.jsx'
import { normalizeJournalPreferences } from '../pipeline/journals.js'
import { setupStartStep } from '../lib/accountGate.js'

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
const secondaryBtn = {
  ...primaryBtn,
  background: 'transparent',
  color: 'var(--color-fg-soft)',
  border: '1px solid rgba(255,255,255,.18)',
}

// The observatory mark — five-point outline chart star (never a four-point sparkle).
function ChartStar({ size = 44 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--color-gold)" strokeWidth="1.3" strokeLinejoin="round" aria-label="Verastar">
      <polygon points="12,3 14.47,9.6 21.51,9.91 15.99,14.3 17.88,21.09 12,17.2 6.12,21.09 8.01,14.3 2.49,9.91 9.53,9.6" />
    </svg>
  )
}

export default function OnboardingQuiz({ onDone, preview = false, account = null }) {
  const [step, goStep, backStep, substep, goSubstep, inviteCode, rememberConnect, npiDraft, codeNotice] = useOnboardStep() // welcome | signin | connect | interview | review
  const [keyInput, setKeyInput] = useState('')
  const [demoError, setDemoError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const savingRef = useRef(false)
  const [draft, setDraft] = useState(null) // { name, northStars, projects, topics, search, rubric:{criteria,selectCount,scoreFloor} }
  // Account creation/sign-in from the welcome screen (accounts configured only).
  const signin = useEmailCodeSignIn()
  const keySet = hasApiKey()
  // A sponsored account needs no key; the connect step says so and lets them through.
  const [sponsorVersion, setSponsorVersion] = useState(0)
  void sponsorVersion // re-render after an invite code enrolls mid-onboarding
  const sponsored = isSponsored()
  // With an account, the access code is the path; the personal key opens only on request.
  const [keyOpen, setKeyOpen] = useState(false)
  // NPI is a history substep of #connect, shared with InviteCode. A separate flag
  // stayed true after Back/Forward remounted the code form and hid these controls.
  const betaNpi = step === 'connect' && substep === 'npi'

  function connectContinue(e) {
    e.preventDefault()
    if (!preview) {
      if (keyInput.trim()) setApiKey(keyInput)
      if (!hasModelAccess()) return // key or sponsorship required to interview; the demo path is on the welcome screen
    }
    goStep('interview')
  }

  function leaveSignin() {
    signin.reset()
    backStep()
  }

  function useDemo() {
    // The demo flag is stamped here (not in pipeline/onboard.js) so the app can
    // label demo mode honestly — pipeline stays untouched.
    const demoProfile = { ...DEMO_PROFILE, demo: true }
    if (preview) { onDone?.(demoProfile); return }
    // Signed in, saveProfile writes the ACCOUNT's profile: a demo profile there would skip
    // the invite, NPI and interview steps. The sample is a signed-out path only.
    if (account) return
    setDemoError('')
    saveProfile(demoProfile).then(() => onDone?.(demoProfile)).catch((err) => {
      setDemoError(`Couldn\u2019t open the sample: ${err?.message || err}`)
    })
  }

  // Write the reviewed draft. Two properties matter here and both are deliberate:
  //
  //   - It PATCHES the existing profile record (mergeInterviewProfile) instead of replacing
  //     it. Re-running onboarding is expected — she will want to rebuild her search plan now
  //     that the interview writes queries — and a replace would drop keys this screen never
  //     shows. Her library is in other collections (`papers`, `digests`, `graphNodes`,
  //     `graphEdges`, `seen`) and nothing in this flow writes or clears any of them.
  //   - In preview it neither writes NOR reads. ?firstrun=1 persists nothing, full stop.
  async function save() {
    const npiMatch = preview ? null : currentNpiMatch()
    const fields = {
      name: (draft.name || (npiMatch ? `${npiMatch.firstName} ${npiMatch.lastName}` : 'Doctor')).trim(),
      northStars: draft.northStars || [],
      projects: draft.projects || [],
      journalPreferences: normalizeJournalPreferences(draft.journalPreferences),
      topics: normalizeTopics(draft.topics),
      search: {
        days: normalizeSearchDays(draft.search?.days),
        perTopic: normalizeTopicCap(draft.search?.perTopic),
      },
      rubric: {
        criteria: (draft.rubric?.criteria || DEFAULT_RUBRIC).trim(),
        selectCount: draft.rubric?.selectCount || DEFAULT_SELECT_COUNT,
        scoreFloor: normalizeScoreFloor(draft.rubric?.scoreFloor),
      },
    }
    if (preview) {
      onDone?.(mergeInterviewProfile(null, fields))
      return
    }
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    try {
      const profile = mergeInterviewProfile(await getProfile(), fields)
      await saveProfile(profile)
      onDone?.(profile)
    } catch (err) {
      setSaveError(`Couldn\u2019t save your profile: ${err?.message || err}. Your answers are still here; try again.`)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // Draft edit helpers.
  const setField = (patch) => setDraft((d) => ({ ...d, ...patch }))

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
            onClick={() => goStep(setupStartStep({ configured: supabaseConfigured, account, preview }))}
            className="cursor-pointer"
            style={{ ...primaryBtn, padding: '14px 30px', borderRadius: 12, boxShadow: '0 10px 34px -10px rgba(239,143,91,.75)' }}
          >
            Set up my digest →
          </button>
          {!account && (
            <>
              <button onClick={useDemo} className="cursor-pointer" style={ghostLink}>
                Explore a populated sample digest
              </button>
              <p style={{ margin: '-6px 0 0', fontSize: 12, color: 'var(--color-fg-faint)' }}>
                Look through sample papers from the published literature. Nothing is saved to your library.
              </p>
              {demoError && <p role="alert" style={{ margin: 0, fontSize: 13, color: '#f0a9a4' }}>{demoError}</p>}
            </>
          )}
          {/* Returning users can sign in directly. New users reach the same screen from
              the primary setup button, so a real library is never silently local-only. */}
          {supabaseConfigured && !preview && (
            <button onClick={() => goStep('signin')} className="cursor-pointer" style={{ ...ghostLink, marginTop: 6, color: 'var(--color-fg-soft)' }}>
              Have an account? <span style={{ color: 'var(--color-accent)' }}>Sign in</span>
            </button>
          )}
        </div>
      </div>
    )
  }

  // ===== ACCOUNT (new or returning user) =====
  if (step === 'signin') {
    return (
      <div>
        <p style={stepMark}>ACCOUNT</p>
        <h2 className="vs-step-title" style={stepTitle}>Create your account or sign in.</h2>
        <p style={stepLede}>
          Enter your email and we&rsquo;ll send a one-time code. New here? This creates your
          account. Returning? This opens your library. No password, ever.
        </p>
        {signin.sendState === 'sent' ? (
          <div style={{ maxWidth: 520 }}>
            <div style={{ marginTop: 24 }}>
              <EmailCodeStatus
                email={signin.email.trim()}
                aliasNote={signin.aliasNote}
                busy={signin.resending}
                onSeparate={signin.sendSeparate}
              />
            </div>
            <form onSubmit={signin.verify} style={{ marginTop: 14 }}>
              <label htmlFor="email-code" style={fieldLabel}>6-digit code</label>
              <div className="flex" style={{ gap: 10, marginTop: 8 }}>
                <input
                  id="email-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={signin.code}
                  onChange={(e) => signin.setCode(e.target.value)}
                  placeholder="123456"
                  aria-invalid={signin.verifyState === 'error'}
                  autoFocus
                  style={{ ...inputStyle, marginTop: 0, flex: 1, width: 'auto', letterSpacing: '.14em' }}
                />
                <button type="submit" disabled={signin.verifyBusy} className="cursor-pointer" style={{ ...primaryBtn, opacity: signin.verifyBusy ? 0.6 : 1 }}>
                  {signin.verifyBusy ? 'Checking…' : 'Continue'}
                </button>
              </div>
            </form>
            {signin.verifyState === 'error' && (
              <div role="alert" style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
                {signin.verifyError}
              </div>
            )}
            {signin.resendNote && (
              <p role="status" style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--color-verified-soft)' }}>{signin.resendNote}</p>
            )}
            <div className="flex items-center" style={{ marginTop: 18, gap: 18 }}>
              <button type="button" onClick={signin.resend} disabled={signin.resending} className="cursor-pointer" style={{ ...ghostLink, color: 'var(--color-accent)' }}>
                {signin.resending ? 'Sending…' : 'Send a new code'}
              </button>
              <button type="button" onClick={leaveSignin} className="cursor-pointer" style={ghostLink}>
                ← Back
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={signin.send} style={{ marginTop: 24, maxWidth: 520 }}>
            <label htmlFor="account-email" style={fieldLabel}>Account email</label>
            <input
              id="account-email"
              type="email"
              value={signin.email}
              onChange={(e) => signin.setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              autoFocus
              style={inputStyle}
            />
            {signin.sendState === 'error' && (
              <div role="alert" style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
                <span style={{ fontWeight: 600 }}>Couldn&rsquo;t send the code:</span> {signin.sendError}
              </div>
            )}
            <div className="flex items-center" style={{ marginTop: 20, gap: 18 }}>
                <button type="submit" disabled={signin.sendBusy} className="cursor-pointer" style={{ ...primaryBtn, opacity: signin.sendBusy ? 0.6 : 1 }}>
                  {signin.sendBusy ? 'Sending…' : 'Email me a code'}
                </button>
              <button type="button" onClick={leaveSignin} className="cursor-pointer" style={ghostLink}>
                ← Back
              </button>
            </div>
          </form>
        )}
      </div>
    )
  }

  // ===== CONNECT =====
  // The access code leads: it is the easy path, and most invited clinicians have one.
  // Bringing a key is the fallback, with plain-language help one click away. NCBI
  // credentials are optional tuning and live in Settings only.
  if (step === 'connect') {
    const canUseCode = !sponsored && (preview || account)
    const blocked = !preview && !sponsored && !keySet && !keyInput.trim()
    // The beta code's own Continue is the primary action. A second disabled
    // Continue, for a key the person has not opened, only looked like a dead end.
    const keyPathOpen = !sponsored && (!canUseCode || keySet || keyOpen)
    const showStepContinue = sponsored || preview || keyPathOpen || Boolean(keyInput.trim())
    const keyAlongsideCode = canUseCode && !sponsored && keyPathOpen
    return (
      <div>
        <div hidden={betaNpi}>
        <p style={stepMark}>01 / 03 · CONNECT</p>
        <h2 className="vs-step-title" style={stepTitle}>{sponsored ? 'You are all set.' : 'Connect Verastar.'}</h2>
        <p style={{ ...stepLede, maxWidth: 500 }}>
          {sponsored
            ? 'This account has sponsored access: Verastar does the reading for you, no key needed. You can still add your own Anthropic key later in Settings.'
            : canUseCode
              ? 'Verastar uses Claude, an AI model, to read and score papers for you. Enter your beta invitation code for sponsored access, or use your own Anthropic key.'
              : 'Verastar uses Claude, an AI model, to read and score papers for you. It runs on your own Anthropic key.'}
        </p>

        </div>
        {canUseCode && (
          <div style={{ marginTop: betaNpi ? 0 : 28 }}>
            <InviteCode
              npiOpen={betaNpi}
              onNpiStep={(open, options) => goSubstep(open ? 'npi' : null, options)}
              code={inviteCode}
              onCodeChange={(next) => rememberConnect({ inviteCode: next })}
              npiDraft={npiDraft}
              onNpiDraft={(next) => rememberConnect({ npiDraft: next })}
              codeNotice={codeNotice}
              lead
              preview={preview}
              onEnrolled={() => setSponsorVersion((v) => v + 1)}
            />
          </div>
        )}

        <form hidden={betaNpi} onSubmit={connectContinue}>
          {!sponsored && canUseCode && !keySet && !keyOpen && (
            <button type="button" onClick={() => setKeyOpen(true)} aria-expanded={false} className="cursor-pointer" style={{ ...ghostLink, marginTop: 22, fontSize: 13.5 }}>
              No code? <span style={{ color: 'var(--color-fg-soft)' }}>Use your own Anthropic key instead</span>
            </button>
          )}
          {!sponsored && (!canUseCode || keySet || keyOpen) && (
            <div style={{ marginTop: canUseCode ? 26 : 28 }}>
              {canUseCode && (
                <p style={{ margin: '0 0 14px', fontSize: 13.5, color: 'var(--color-fg-muted)' }}>No code? Use your own Anthropic key.</p>
              )}
              <label htmlFor="anthropic-api-key" style={fieldLabel}>Anthropic API key</label>
              {keySet && !keyInput ? (
                <div className="flex items-center" style={{ marginTop: 8, gap: 10, padding: '11px 14px', borderRadius: 11, background: 'var(--surface-1)', border: '1px solid rgba(255,255,255,.08)' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-verified)', boxShadow: '0 0 7px var(--color-verified)' }} />
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-fg-soft)', fontSize: 13, letterSpacing: '.05em' }}>sk-ant-••••••••••••••••</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-verified-soft)', fontWeight: 600 }}>Active</span>
                </div>
              ) : (
                <input
                  id="anthropic-api-key"
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="sk-ant-…"
                  autoComplete="off"
                  aria-describedby={blocked ? 'connect-continue-help' : undefined}
                  style={inputStyle}
                />
              )}
              <div className="flex flex-wrap" style={{ marginTop: 10, gap: '6px 20px', fontSize: 13.5 }}>
                <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-accent)' }}>
                  Get an API key ↗
                </a>
                <a href="/api-key-guide.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-fg-soft)' }}>
                  What&rsquo;s an API key? Cost, safety, and setup ↗
                </a>
              </div>
              <p style={{ margin: '14px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
                Your key stays in this browser tab. It is never sent to our servers and is cleared
                when you close the tab.
              </p>
            </div>
          )}

          <div className="flex items-center" style={{ marginTop: 30, gap: 18 }}>
            {showStepContinue && (
              <button type="submit" disabled={blocked} aria-describedby={blocked ? 'connect-continue-help' : undefined} className="cursor-pointer" style={{ ...(keyAlongsideCode ? secondaryBtn : primaryBtn), opacity: blocked ? 0.5 : 1 }}>
                {keyAlongsideCode ? 'Continue with API key' : 'Continue →'}
              </button>
            )}
            <button type="button" onClick={backStep} className="cursor-pointer" style={ghostLink}>
              Back
            </button>
          </div>
          {blocked && showStepContinue && (
            <p id="connect-continue-help" style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--color-fg-muted)' }}>
              Paste your Anthropic API key to continue.
            </p>
          )}
          {!showStepContinue && (
            <p id="connect-continue-help" style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.5, color: 'var(--color-fg-muted)' }}>
              Enter your beta code above to continue.
            </p>
          )}
        </form>
      </div>
    )
  }

  // ===== INTERVIEW =====
  // One path, one line of intro. The mechanics (searches, rubric) and the storage note are
  // deliberately absent here: a new clinician needs the question, not the machinery.
  if (step === 'interview') {
    return (
      <div>
        <p style={stepMark}>02 / 03 · INTERVIEW</p>
        <h2 className="vs-step-title" style={stepTitle}>Let&rsquo;s talk.</h2>
        <p style={stepLede}>A few quick questions so I know what to watch for you.</p>
        <div style={{ marginTop: 26 }}>
          <ProfileInterview
            preview={preview}
            onDraft={(drafted) => {
              setDraft(drafted)
              goStep('review')
            }}
            onCancel={backStep}
          />
        </div>
      </div>
    )
  }

  // ===== REVIEW =====
  // A confirmation, not a settings page. Topics stay editable as chips. The PubMed
  // searches, north stars, and ranking rubric are shown here too — collapsible — because
  // the interview promised she would see them before anything is saved. Journal lists and
  // the search window stay in the profile panel (NorthStars.jsx) for later tuning.
  const topics = draft?.topics || []
  return (
    <div>
      <p style={stepMark}>03 / 03 · REVIEW</p>
      <h2 className="vs-step-title" style={stepTitle}>Here&rsquo;s what I&rsquo;ll watch for you.</h2>
      <p style={stepLede}>
        Each morning I&rsquo;ll look for new papers in these areas and bring you the best few.
        Remove anything that doesn&rsquo;t belong. You can fine-tune everything later in the app.
      </p>

      <div style={{ marginTop: 26 }}>
        <label htmlFor="digest-name" style={fieldLabel}>I&rsquo;ll call you</label>
        <input
          id="digest-name"
          value={draft?.name || ''}
          onChange={(e) => setField({ name: e.target.value })}
          placeholder="Dr. Lastname"
          style={{ ...inputStyle, padding: '11px 14px', maxWidth: 320 }}
        />
      </div>

      <div style={{ marginTop: 24 }}>
        <p style={{ ...fieldLabel, margin: 0 }}>Your topics</p>
        {topics.length ? (
          <ul className="flex flex-wrap" style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', gap: 8 }}>
            {topics.map((t) => (
              <li key={t.label} className="flex items-center" style={{ gap: 8, padding: '8px 10px 8px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,.12)', background: 'var(--surface-1)', fontSize: 14.5, color: 'var(--color-fg)' }}>
                {t.label}
                <button
                  onClick={() => setField({ topics: topics.filter((x) => x !== t) })}
                  aria-label={`Remove ${t.label}`}
                  className="cursor-pointer"
                  style={{ border: 0, background: 'transparent', padding: '0 4px', fontSize: 15, lineHeight: 1, color: 'var(--color-fg-muted)', fontFamily: 'inherit' }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ margin: '10px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--color-fg-dim)', maxWidth: 520 }}>
            No topics yet. Start the interview over and tell me a bit more about what you see and do.
          </p>
        )}
      </div>

      <details open style={{ marginTop: 28 }}>
        <summary className="cursor-pointer" style={{ fontSize: 13, letterSpacing: '.06em', color: '#aab0be', fontWeight: 600 }}>
          PubMed searches, north stars, and ranking
        </summary>
        <div style={{ marginTop: 16 }}>
          <h3 style={{ ...fieldLabel, margin: 0 }}>PubMed searches</h3>
          {topics.length ? (
            <ul style={{ margin: '10px 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {topics.map((t) => (
                <li key={t.label}>
                  <span style={{ fontSize: 14.5, color: 'var(--color-fg)' }}>{t.label}</span>
                  {t.query && (
                    <span style={{ display: 'block', marginTop: 3, fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: 1.45, color: 'var(--color-fg-dim)' }}>{t.query}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--color-fg-dim)' }}>No searches yet.</p>
          )}
          <h3 style={{ ...fieldLabel, margin: '18px 0 0' }}>North stars</h3>
          {(draft?.northStars || []).length ? (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--color-fg)', fontSize: 14.5, lineHeight: 1.55 }}>
              {draft.northStars.map((star) => <li key={star}>{star}</li>)}
            </ul>
          ) : (
            <p style={{ margin: '8px 0 0', fontSize: 14, color: 'var(--color-fg-dim)' }}>None yet. You can add these later in the app.</p>
          )}
          <h3 style={{ ...fieldLabel, margin: '18px 0 0' }}>Ranking rubric</h3>
          <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: 1.6, color: 'var(--color-fg-dim)', whiteSpace: 'pre-wrap', maxWidth: 520 }}>
            {draft?.rubric?.criteria || DEFAULT_RUBRIC}
          </p>
        </div>
      </details>

      <div className="flex items-center" style={{ marginTop: 32, gap: 18 }}>
        <button
          onClick={save}
          disabled={!topics.length || saving}
          className="cursor-pointer"
          style={{ ...primaryBtn, padding: '13px 26px', borderRadius: 12, boxShadow: '0 10px 34px -12px rgba(239,143,91,.7)', opacity: topics.length ? 1 : 0.5 }}
        >
          Enter Verastar →
        </button>
        <button onClick={() => goStep('interview', { replace: true })} className="cursor-pointer" style={ghostLink}>
          Start the interview over
        </button>
      </div>
      {saveError && (
        <p role="alert" style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.5, color: '#f0a9a4', maxWidth: 520 }}>{saveError}</p>
      )}
    </div>
  )
}
