import { useEffect, useState } from 'react'
import { setApiKey, hasApiKey, clearApiKey, ping } from './lib/anthropic.js'
import { getProfile, store } from './lib/store.js'
import NorthStars from './components/NorthStars.jsx'
import OnboardingQuiz from './components/OnboardingQuiz.jsx'
import SpineCheck from './components/SpineCheck.jsx'
import KnowledgeBase from './components/KnowledgeBase.jsx'
import WeekendRead from './components/WeekendRead.jsx'
import ConstellationView from './components/ConstellationView.jsx'

// ── Observatory shell ──────────────────────────────────────────────────────
// The app is a dark, star-lit reading room. A fixed 88px icon rail on the left
// switches between five surfaces; each surface owns its own scroll area. The
// BYOK key + steering profile live in a Settings modal (opened from the rail or
// the digest's key chip). Faithful port of design/Verastar.dc.html — the engine
// (pipeline/, verifier) is untouched; this file is pure presentation + routing.

// Her product IA (the 4-tab simplification): Digest · Library · Star Map · Connections.
// Library folds the concept graph + the flat-file vault into one surface; Connections is
// the Weekend Read synthesis. The observatory visuals from the design ride on top.
const NAV = [
  ['digest', 'Digest'],
  ['library', 'Library'],
  ['starmap', 'Star Map'],
  ['connections', 'Connections'],
]

function NavIcon({ view }) {
  const p = { width: 21, height: 21, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }
  switch (view) {
    case 'digest':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8.5" />
          <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'library':
      // Bookmark/knowledge mark — the library of saved evidence + concepts.
      return (
        <svg {...p}>
          <path d="M5 4.5h11a2 2 0 0 1 2 2V20l-2.4-1.6L13 20l-2.6-1.6L8 20V6.5a2 2 0 0 0-2-2z" strokeLinejoin="round" />
        </svg>
      )
    case 'starmap':
      // Constellation of concept stars.
      return (
        <svg {...p}>
          <circle cx="6" cy="7" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="18" cy="6" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="15" cy="17" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="8" cy="15" r="1.6" fill="currentColor" stroke="none" />
          <path d="M6 7l9-1M15 6l0 11M15 17l-7-2M8 15L6 7" opacity=".5" />
        </svg>
      )
    case 'connections':
      // Quill — the written Weekend Read that threads the papers together.
      return (
        <svg {...p}>
          <path d="M4 20l3-9 8-6 3 3-6 8-8 4z" strokeLinejoin="round" />
          <path d="M14 5l3 3" />
        </svg>
      )
    default:
      return null
  }
}

function IconRail({ view, setView, onSettings, initials }) {
  return (
    <aside
      className="flex flex-col items-center border-r"
      style={{
        width: 88,
        flex: '0 0 auto',
        padding: '26px 0 22px',
        borderColor: 'var(--hairline)',
        background: 'rgba(255,255,255,.012)',
        zIndex: 5,
      }}
    >
      <div style={{ marginBottom: 34, fontSize: 22, color: 'var(--color-gold)', textShadow: '0 0 14px rgba(233,196,106,.55)' }}>
        ✦
      </div>
      <nav className="flex flex-col items-center w-full" style={{ gap: 6 }}>
        {NAV.map(([id, label]) => {
          const active = view === id
          return (
            <button
              key={id}
              onClick={() => setView(id)}
              className="flex flex-col items-center cursor-pointer"
              style={{
                width: 64,
                padding: '11px 0 8px',
                border: 0,
                borderRadius: 13,
                gap: 6,
                fontFamily: 'inherit',
                background: active ? 'rgba(239,143,91,.13)' : 'transparent',
                color: active ? 'var(--color-accent-bright)' : 'var(--color-fg-muted)',
              }}
            >
              <NavIcon view={id} />
              <span style={{ fontSize: 10.5, fontWeight: 500 }}>{label}</span>
            </button>
          )
        })}
      </nav>
      <div className="flex flex-col items-center" style={{ marginTop: 'auto', gap: 16 }}>
        <button
          onClick={onSettings}
          className="flex flex-col items-center cursor-pointer"
          style={{ width: 64, padding: '10px 0 8px', border: 0, borderRadius: 13, background: 'transparent', color: 'var(--color-fg-muted)', gap: 6, fontFamily: 'inherit' }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M18 6l-1.7 1.7M7.7 16.3 6 18M18 18l-1.7-1.7M7.7 7.7 6 6" />
          </svg>
          <span style={{ fontSize: 10.5, fontWeight: 500 }}>Settings</span>
        </button>
        <span
          className="flex items-center justify-center"
          style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg,#3a4150,#8a94a8)', fontSize: 12.5, fontWeight: 600, color: '#0d0f14' }}
        >
          {initials}
        </span>
      </div>
    </aside>
  )
}

function SettingsModal({ onClose, saved, onSave, onClear, onPing, status, reply, error }) {
  const [keyInput, setKeyInput] = useState('')
  return (
    <div
      onClick={onClose}
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 60, padding: 32, background: 'rgba(5,6,10,.62)', backdropFilter: 'blur(3px)' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 580,
          maxWidth: '100%',
          maxHeight: '86vh',
          overflowY: 'auto',
          borderRadius: 20,
          border: '1px solid rgba(255,255,255,.08)',
          background: 'linear-gradient(180deg,#141821,#0d1017)',
          boxShadow: '0 40px 120px -20px rgba(0,0,0,.85)',
        }}
      >
        <div className="flex items-center justify-between" style={{ padding: '26px 30px 4px' }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 24, fontWeight: 500, color: 'var(--color-fg)' }}>Settings</h2>
          <button onClick={onClose} className="cursor-pointer" style={{ border: 0, background: 'transparent', color: 'var(--color-fg-muted)', fontSize: 19, lineHeight: 1, fontFamily: 'inherit' }}>
            ✕
          </button>
        </div>

        <div style={{ padding: '18px 30px 30px' }}>
          <p style={{ margin: '0 0 14px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Connection</p>
          <label style={{ display: 'block', fontSize: 13, color: '#aab0be', fontWeight: 500 }}>Anthropic API key</label>

          {saved ? (
            <>
              <div className="flex items-center" style={{ marginTop: 8, gap: 10, padding: '10px 13px', borderRadius: 10, background: 'var(--surface-1)', border: '1px solid rgba(255,255,255,.08)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-verified)', boxShadow: '0 0 7px var(--color-verified)' }} />
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-fg-soft)', fontSize: 13, letterSpacing: '.05em' }}>sk-ant-••••••••••••••••</span>
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-verified-soft)', fontWeight: 600 }}>Active</span>
              </div>
              <div className="flex" style={{ marginTop: 10, gap: 9 }}>
                <button onClick={onPing} disabled={status === 'pinging'} className="cursor-pointer" style={{ padding: '9px 15px', border: 0, borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                  {status === 'pinging' ? 'Testing…' : 'Test connection'}
                </button>
                <button onClick={onClear} className="cursor-pointer" style={{ padding: '9px 15px', border: '1px solid rgba(255,255,255,.14)', borderRadius: 10, background: 'transparent', color: 'var(--color-fg-soft)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' }}>
                  Clear key
                </button>
              </div>
              {status === 'ok' && (
                <div style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(127,191,154,.1)', color: 'var(--color-verified-soft)', fontSize: 13, lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 600 }}>Anthropic replied “{reply}”</span> — browser-direct call works.
                </div>
              )}
              {status === 'error' && (
                <div style={{ marginTop: 12, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
                  <span style={{ fontWeight: 600 }}>Call failed:</span> {error}
                </div>
              )}
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (keyInput.trim()) onSave(keyInput)
              }}
              className="flex"
              style={{ marginTop: 8, gap: 9 }}
            >
              <input
                type="password"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="sk-ant-…"
                autoComplete="off"
                style={{ flex: 1, padding: '10px 13px', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 14, fontFamily: 'inherit', outline: 'none' }}
              />
              <button type="submit" className="cursor-pointer" style={{ padding: '9px 18px', border: 0, borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                Save
              </button>
            </form>
          )}
          <p style={{ margin: '14px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
            Your key lives only in this browser tab — never sent to our servers, never written to disk, and cleared when you close the tab.
          </p>

          <div style={{ height: 1, background: 'var(--hairline)', margin: '26px 0' }} />

          <p style={{ margin: '0 0 4px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Steering profile</p>
          <NorthStars />
        </div>
      </div>
    </div>
  )
}

// Right rail on the Digest surface: key status, weekly counts, active projects,
// and the Weekend Read teaser. Counts derive from real saved papers.
function DigestRail({ saved, onSettings, counts, projects, onConnections }) {
  return (
    <aside style={{ width: 308, flex: '0 0 auto', padding: '34px 28px', overflowY: 'auto', background: 'rgba(255,255,255,.01)' }}>
      <div
        onClick={onSettings}
        className="flex items-center cursor-pointer"
        style={{ gap: 9, padding: '10px 13px', borderRadius: 11, marginBottom: 34, background: saved ? 'rgba(127,191,154,.08)' : 'rgba(230,184,119,.10)' }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: saved ? 'var(--color-verified)' : 'var(--color-abstract)', boxShadow: `0 0 7px ${saved ? 'var(--color-verified)' : 'var(--color-abstract)'}` }} />
        <span style={{ fontSize: 12.5, color: saved ? 'var(--color-verified-soft)' : 'var(--color-abstract)', fontWeight: 500 }}>{saved ? 'API key active' : 'Add your API key'}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--color-fg-faint)', fontSize: 13 }}>⚙</span>
      </div>

      <p style={{ margin: '0 0 14px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>This week</p>
      <div className="flex" style={{ gap: 26, marginBottom: 34 }}>
        {[[counts.verified, 'verified'], [counts.saved, 'saved'], [counts.flagged, 'flagged']].map(([n, label]) => (
          <div key={label}>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 36, color: 'var(--color-fg)', lineHeight: 1 }}>{n}</div>
            <div style={{ fontSize: 12, color: 'var(--color-fg-muted)', marginTop: 4 }}>{label}</div>
          </div>
        ))}
      </div>

      {projects.length > 0 && (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Active projects</p>
          <div className="flex flex-col" style={{ gap: 9, marginBottom: 34 }}>
            {projects.map((p) => (
              <span key={p} className="inline-flex items-center" style={{ gap: 9, fontSize: 14, color: 'var(--color-fg-soft)' }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#8a94a8' }} />
                {p}
              </span>
            ))}
          </div>
        </>
      )}

      <div style={{ height: 1, background: 'var(--hairline)', marginBottom: 26 }} />
      <div onClick={onConnections} className="cursor-pointer" style={{ padding: 20, borderRadius: 15, background: 'linear-gradient(160deg,rgba(239,143,91,.12),rgba(239,143,91,.03))' }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-bright)" strokeWidth="1.8">
            <path d="M4 20l3-9 8-6 3 3-6 8-8 4z" strokeLinejoin="round" />
          </svg>
          <p style={{ margin: 0, fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 16, color: '#f0d3c2' }}>Connections</p>
        </div>
        <p style={{ margin: '10px 0 0', fontSize: 13, lineHeight: 1.55, color: 'var(--color-fg-dim)' }}>
          Your saved papers thread through this week's work. A synthesis you judge, ready to read.
        </p>
        <p style={{ margin: '13px 0 0', fontSize: 13, color: 'var(--color-accent)', fontWeight: 500 }}>Preview the threads ↗</p>
      </div>
    </aside>
  )
}

export default function App() {
  const [saved, setSaved] = useState(hasApiKey())
  const [status, setStatus] = useState('idle')
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const [onboarded, setOnboarded] = useState(null)
  const [view, setView] = useState('digest')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [profile, setProfile] = useState(null)
  const [counts, setCounts] = useState({ verified: 0, saved: 0, flagged: 0 })

  useEffect(() => {
    getProfile().then((p) => {
      setOnboarded(!!p?.onboarded)
      setProfile(p || null)
    })
  }, [])

  // Derive weekly counts from real saved papers (defensive on shape).
  useEffect(() => {
    if (onboarded !== true) return
    store.all('papers').then((papers = []) => {
      setCounts({
        verified: papers.filter((p) => p?.verified || p?.tier).length,
        saved: papers.length,
        flagged: papers.filter((p) => p?.flagged).length,
      })
    }).catch(() => {})
  }, [onboarded, view])

  function handleSave(k) {
    setApiKey(k)
    setSaved(true)
    setStatus('idle')
    setReply('')
    setError('')
  }
  function handleClear() {
    clearApiKey()
    setSaved(false)
    setStatus('idle')
    setReply('')
    setError('')
  }
  async function handlePing() {
    setStatus('pinging')
    setError('')
    setReply('')
    try {
      setReply(await ping())
      setStatus('ok')
    } catch (err) {
      setError(err?.message || String(err))
      setStatus('error')
    }
  }

  if (onboarded === null) return null // profile still loading

  if (onboarded === false) {
    // First run: the onboarding quiz on the dark canvas. Restyled in its own pass.
    return (
      <div style={{ minHeight: '100vh', background: 'linear-gradient(165deg,#0f1218,#08090d)' }}>
        <div className="mx-auto" style={{ maxWidth: 680, padding: '48px 24px' }}>
          <header style={{ marginBottom: 8 }}>
            <h1 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 34, fontWeight: 500, color: 'var(--color-fg)' }}>Verastar</h1>
            <p style={{ margin: '8px 0 0', color: 'var(--color-fg-dim)' }}>A verifiable evidence digest for clinicians. Verified, never fabricated.</p>
          </header>
          <OnboardingQuiz onDone={() => { setOnboarded(true); getProfile().then((p) => setProfile(p || null)) }} />
        </div>
      </div>
    )
  }

  const name = profile?.name || 'Doctor'
  const stars = profile?.northStars || []
  const projects = profile?.projects || []
  const initials = name.replace(/^Dr\.?\s*/i, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'MF'
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div className="flex overflow-hidden" style={{ height: '100vh', width: '100%', background: 'linear-gradient(165deg,#0f1218,#08090d)' }}>
      <IconRail view={view} setView={setView} onSettings={() => setSettingsOpen(true)} initials={initials} />

      {view === 'digest' && (
        <div className="flex" style={{ flex: 1, minWidth: 0 }}>
          <main className="relative" style={{ flex: 1, minWidth: 0, overflowY: 'auto', borderRight: '1px solid var(--hairline)' }}>
            <div className="vs-stars absolute" style={{ top: 0, left: 0, right: 0, height: 340 }} />
            <div className="relative" style={{ maxWidth: 820, padding: '46px 56px 64px' }}>
              <div className="flex items-start justify-between" style={{ gap: 24 }}>
                <div>
                  <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>{today}</p>
                  <h1 style={{ margin: '9px 0 0', fontFamily: 'var(--font-serif)', fontSize: 37, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)', lineHeight: 1.08 }}>
                    Good morning, {name}.
                  </h1>
                </div>
              </div>
              {stars.length > 0 && (
                <div className="flex items-center" style={{ margin: '26px 0 0', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Steering by</span>
                  {stars.map((s) => (
                    <span key={s} className="inline-flex items-center" style={{ gap: 7, padding: '6px 13px', borderRadius: 999, background: 'rgba(233,196,106,.11)', color: 'var(--color-gold-soft)', fontSize: 13, fontWeight: 500 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-gold)', boxShadow: '0 0 8px var(--color-gold)' }} />
                      {s}
                    </span>
                  ))}
                  <span onClick={() => setSettingsOpen(true)} className="cursor-pointer" style={{ fontSize: 13, color: 'var(--color-accent)' }}>Tune profile</span>
                </div>
              )}
              <div style={{ marginTop: 34 }}>
                <SpineCheck key={saved ? 'keyed' : 'nokey'} />
              </div>
            </div>
          </main>
          <DigestRail saved={saved} counts={counts} projects={projects} onSettings={() => setSettingsOpen(true)} onConnections={() => setView('connections')} />
        </div>
      )}

      {view !== 'digest' && (
        <main style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          {view === 'library' && <KnowledgeBase key="library" />}
          {view === 'starmap' && <ConstellationView key="starmap" />}
          {view === 'connections' && <WeekendRead key="connections" />}
        </main>
      )}

      {settingsOpen && (
        <SettingsModal
          onClose={() => { setSettingsOpen(false); setStatus('idle') }}
          saved={saved}
          onSave={handleSave}
          onClear={handleClear}
          onPing={handlePing}
          status={status}
          reply={reply}
          error={error}
        />
      )}
    </div>
  )
}
