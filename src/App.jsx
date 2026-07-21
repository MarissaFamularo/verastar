import { useEffect, useState } from 'react'
import { setApiKey, hasApiKey, clearApiKey, isKeyRemembered, ping } from './lib/anthropic.js'
import { getProfile, store, COLLECTIONS, initStore, idbStore } from './lib/store.js'
import { supabase, supabaseConfigured, currentUser, sendMagicLink, signOut } from './lib/supabase.js'
import { shouldOfferMigration, migrateLocalToAccount } from './lib/migrate.js'
import { loadDomains } from './lib/domains.js'
import DomainEditor from './components/DomainEditor.jsx'
import NorthStars from './components/NorthStars.jsx'
import OnboardingQuiz from './components/OnboardingQuiz.jsx'
import SpineCheck from './components/SpineCheck.jsx'
import KnowledgeBase from './components/KnowledgeBase.jsx'
import WeekendRead from './components/WeekendRead.jsx'
import ConstellationView from './components/ConstellationView.jsx'

// ── Observatory shell ──────────────────────────────────────────────────────
// The app is a dark, star-lit reading room. A fixed 88px icon rail on the left
// switches between five surfaces; each surface owns its own scroll area. The
// BYOK key + steering profile live in a Settings modal (opened from the avatar
// at the rail's foot or the digest's key chip). Faithful port of design/Verastar.dc.html — the engine
// (pipeline/, verifier) is untouched; this file is pure presentation + routing.

// Her product IA (the 4-tab simplification): Digest · Library · Star Map · Connections.
// Library folds the concept graph + the flat-file vault into one surface; Connections is
// the Weekend Read synthesis. The observatory visuals from the design ride on top.
const NAV = [
  ['digest', 'Today'],
  ['library', 'Library'],
  ['starmap', 'Star Map'],
  ['connections', 'Connections'],
]

function NavIcon({ view }) {
  const p = { width: 21, height: 21, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }
  switch (view) {
    case 'digest':
      // Rocket — today's launch into the fresh literature.
      return (
        <svg {...p} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 13a8 8 0 0 1 7 7 6 6 0 0 0 3-5 9 9 0 0 0 6-8 3 3 0 0 0-3-3 9 9 0 0 0-8 6 6 6 0 0 0-5 3" />
          <path d="M7 14a6 6 0 0 0-3 6 6 6 0 0 0 6-3" />
          <circle cx="15" cy="9" r="1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'library':
      // Star atlas — an open book with a star above the spine.
      return (
        <svg {...p} strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 19.5a9 9 0 0 1 9 0 9 9 0 0 1 9 0" />
          <path d="M3 7a9 9 0 0 1 9 0 9 9 0 0 1 9 0" />
          <path d="M3 7v12.5M12 7v12.5M21 7v12.5" />
          <circle cx="12" cy="2.6" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'starmap':
      // The constellation asterism (logo option C).
      return (
        <svg {...p}>
          <path d="M5 18 L11 8 L17 13 L20.5 4.5" opacity=".5" />
          <circle cx="5" cy="18" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="11" cy="8" r="2.2" fill="currentColor" stroke="none" />
          <circle cx="17" cy="13" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="20.5" cy="4.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'connections':
      // Orbit — a star with a companion (logo option E).
      return (
        <svg {...p}>
          <ellipse cx="12" cy="12" rx="10" ry="4.2" opacity=".55" transform="rotate(-24 12 12)" strokeWidth="1.4" />
          <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
          <circle cx="21.1" cy="7.9" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      )
    default:
      return null
  }
}

function IconRail({ view, setView, onSettings, initials }) {
  return (
    <aside
      className="vs-rail flex flex-col items-center border-r"
      style={{
        width: 88,
        flex: '0 0 auto',
        padding: '26px 0 22px',
        borderColor: 'var(--hairline)',
        background: 'rgba(255,255,255,.012)',
        zIndex: 5,
      }}
    >
      {/* Five-point chart star — the observatory mark, star-atlas style (not a four-point AI sparkle). */}
      <div className="vs-rail-logo" style={{ marginBottom: 34, color: 'var(--color-gold)', filter: 'drop-shadow(0 0 7px rgba(233,196,106,.55))' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-label="Verastar">
          <polygon points="12,3 14.47,9.6 21.51,9.91 15.99,14.3 17.88,21.09 12,17.2 6.12,21.09 8.01,14.3 2.49,9.91 9.53,9.6" />
        </svg>
      </div>
      <nav className="vs-rail-nav flex flex-col items-center w-full" style={{ gap: 6 }}>
        {NAV.map(([id, label]) => {
          const active = view === id
          return (
            <button
              key={id}
              onClick={() => setView(id)}
              className="vs-rail-btn flex flex-col items-center cursor-pointer"
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
      <div className="vs-rail-foot flex flex-col items-center" style={{ marginTop: 'auto' }}>
        {/* The avatar doubles as the Settings entry point — no separate rail item. */}
        <button
          onClick={onSettings}
          title="Settings"
          aria-label="Settings"
          className="flex items-center justify-center cursor-pointer"
          style={{ width: 36, height: 36, padding: 0, border: 0, borderRadius: '50%', background: 'linear-gradient(135deg,#3a4150,#8a94a8)', fontSize: 12.5, fontWeight: 600, color: '#0d0f14', fontFamily: 'inherit' }}
        >
          {initials}
        </button>
      </div>
    </aside>
  )
}

// Account & sync — magic-link sign-in (no passwords, consistent with the
// no-credential ethos). Renders nothing when Supabase env isn't configured, so a
// cloned repo without keys keeps the original local-only app. The consent line is
// required groundwork for the adoption study: one sentence, visible, honest.
function AccountSection({ account }) {
  const [email, setEmail] = useState('')
  const [sendState, setSendState] = useState('idle') // idle | sending | sent | error
  const [sendError, setSendError] = useState('')
  if (!supabaseConfigured) return null

  async function send(e) {
    e.preventDefault()
    if (!email.trim()) return
    setSendState('sending')
    setSendError('')
    try {
      await sendMagicLink(email.trim())
      setSendState('sent')
    } catch (err) {
      setSendError(err?.message || String(err))
      setSendState('error')
    }
  }

  return (
    <>
      <div style={{ height: 1, background: 'var(--hairline)', margin: '26px 0' }} />
      <p style={{ margin: '0 0 14px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Account &amp; sync</p>
      {account ? (
        <>
          <div className="flex items-center" style={{ gap: 10, padding: '10px 13px', borderRadius: 10, background: 'var(--surface-1)', border: '1px solid rgba(255,255,255,.08)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-verified)', boxShadow: '0 0 7px var(--color-verified)' }} />
            <span style={{ color: 'var(--color-fg-soft)', fontSize: 13 }}>{account.email}</span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-verified-soft)', fontWeight: 600 }}>Signed in</span>
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
            Your library lives in your account so it works on every device — and you always hold
            your own copy on disk, in plain files any agent can read. Your API key and your disk
            folder stay on this device, never in your account.
          </p>
          <button
            onClick={async () => { await signOut(); window.location.reload() }}
            className="cursor-pointer"
            style={{ marginTop: 12, padding: '9px 15px', border: '1px solid rgba(255,255,255,.14)', borderRadius: 10, background: 'transparent', color: 'var(--color-fg-soft)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' }}
          >
            Sign out
          </button>
        </>
      ) : (
        <>
          <p style={{ margin: '0 0 12px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
            Sign in and your library follows you — we keep it so it works on every device, and you
            always hold your own copy on disk, in plain files any agent can read. Your API key
            stays on this device, never in your account.
          </p>
          {sendState === 'sent' ? (
            <div style={{ padding: '10px 13px', borderRadius: 10, background: 'rgba(127,191,154,.1)', color: 'var(--color-verified-soft)', fontSize: 13, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600 }}>Link sent to {email.trim()}</span> — open it on this device to finish signing in.
            </div>
          ) : (
            <form onSubmit={send} className="flex" style={{ gap: 9 }}>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                style={{ flex: 1, padding: '10px 13px', borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', color: 'var(--color-fg)', fontSize: 14, fontFamily: 'inherit', outline: 'none' }}
              />
              <button type="submit" disabled={sendState === 'sending'} className="cursor-pointer" style={{ padding: '9px 15px', border: 0, borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', fontSize: 13, fontWeight: 600, fontFamily: 'inherit', opacity: sendState === 'sending' ? 0.6 : 1 }}>
                {sendState === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
              </button>
            </form>
          )}
          {sendState === 'error' && (
            <div style={{ marginTop: 10, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
              <span style={{ fontWeight: 600 }}>Couldn't send the link:</span> {sendError}
            </div>
          )}
          <p style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--color-fg-faint)' }}>
            Signing in stores your literature library and usage events on our servers —
            never patient data, and never sold. You always hold your own flat-file copy
            on disk. Usage data may be analyzed, in aggregate, for research.
          </p>
        </>
      )}
    </>
  )
}

function SettingsModal({ onClose, saved, remembered, onSave, onClear, onPing, onStartOver, status, reply, error, account }) {
  const [keyInput, setKeyInput] = useState('')
  const [remember, setRemember] = useState(false)
  // Start over is two-step: the button reveals a confirm block with the erase choice.
  const [confirmReset, setConfirmReset] = useState(false)
  const [eraseAll, setEraseAll] = useState(false)
  return (
    <div
      onClick={onClose}
      className="vs-modal-overlay fixed inset-0 flex items-center justify-center"
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
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-verified-soft)', fontWeight: 600 }}>{remembered ? 'Active · remembered' : 'Active'}</span>
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
                if (keyInput.trim()) onSave(keyInput, remember)
              }}
              style={{ marginTop: 8 }}
            >
              <div className="flex" style={{ gap: 9 }}>
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
              </div>
              <label className="flex items-center cursor-pointer" style={{ gap: 8, marginTop: 10, fontSize: 13, color: 'var(--color-fg-soft)' }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ accentColor: 'var(--color-accent)' }} />
                Remember on this device
              </label>
            </form>
          )}
          <p style={{ margin: '14px 0 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
            {saved && remembered
              ? 'Your key is remembered in this browser’s local storage on this device — never sent to our servers. Clear it any time.'
              : 'Your key lives only in this browser tab — never sent to our servers, never written to disk, and cleared when you close the tab. Check “Remember on this device” to keep it across restarts.'}
          </p>

          <AccountSection account={account} />

          <div style={{ height: 1, background: 'var(--hairline)', margin: '26px 0' }} />

          <p style={{ margin: '0 0 4px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Steering profile</p>
          <NorthStars />

          <div style={{ height: 1, background: 'var(--hairline)', margin: '26px 0' }} />

          <p style={{ margin: '0 0 14px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Library grouping</p>
          <DomainEditor />

          <div style={{ height: 1, background: 'var(--hairline)', margin: '26px 0' }} />

          <p style={{ margin: '0 0 4px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Start over</p>
          {!confirmReset ? (
            <>
              <p style={{ margin: '10px 0 12px', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
                Redo setup from the welcome screen. Your library, star map, and API key stay unless you choose to erase them.
              </p>
              <button onClick={() => setConfirmReset(true)} className="cursor-pointer" style={{ padding: '9px 15px', border: '1px solid rgba(224,96,90,.4)', borderRadius: 10, background: 'transparent', color: '#f0a9a4', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' }}>
                Start over…
              </button>
            </>
          ) : (
            <div style={{ marginTop: 10, padding: '14px 16px', borderRadius: 12, border: '1px solid rgba(224,96,90,.3)', background: 'rgba(224,96,90,.06)' }}>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--color-fg-soft)' }}>
                This clears your steering profile and returns you to the welcome screen.
              </p>
              <label className="flex items-start cursor-pointer" style={{ gap: 8, marginTop: 12, fontSize: 13, lineHeight: 1.5, color: 'var(--color-fg-soft)' }}>
                <input type="checkbox" checked={eraseAll} onChange={(e) => setEraseAll(e.target.checked)} style={{ marginTop: 3, accentColor: '#e0605a' }} />
                <span>
                  {account
                    ? 'Also erase your library everywhere — saved papers, star map, and digests come out of your account (all devices), and the API key out of this browser. Files already written to your disk folder are never touched.'
                    : 'Also erase everything in this browser — saved papers, star map, digests, and the API key. Files already written to your disk folder are never touched.'}
                </span>
              </label>
              <div className="flex" style={{ marginTop: 14, gap: 9 }}>
                <button onClick={() => onStartOver(eraseAll)} className="cursor-pointer" style={{ padding: '9px 15px', border: 0, borderRadius: 10, background: '#e0605a', color: '#1c0908', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>
                  {eraseAll ? 'Erase & start over' : 'Start over'}
                </button>
                <button onClick={() => { setConfirmReset(false); setEraseAll(false) }} className="cursor-pointer" style={{ padding: '9px 15px', border: '1px solid rgba(255,255,255,.14)', borderRadius: 10, background: 'transparent', color: 'var(--color-fg-soft)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// First signed-in boot, empty cloud, local library present: offer to carry it in.
// One decision, two honest buttons — after a move the app reloads onto cloud data.
function MigrationOffer({ account, paperCount, onDecline }) {
  const [state, setState] = useState('idle') // idle | moving | error
  const [error, setError] = useState('')

  async function move() {
    setState('moving')
    setError('')
    try {
      await migrateLocalToAccount({ client: supabase, userId: currentUser().id })
      window.location.reload()
    } catch (err) {
      setError(err?.message || String(err))
      setState('error')
    }
  }

  return (
    <div className="relative flex items-center justify-center" style={{ minHeight: '100vh', padding: '56px 32px', background: 'radial-gradient(120% 80% at 50% -10%,#1a2138,#0b0e18 55%,#08090d)' }}>
      <div className="vs-stars-deep absolute" style={{ inset: 0 }} />
      <div className="relative" style={{ width: 560, maxWidth: '100%' }}>
        <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12, letterSpacing: '.14em', color: '#6d7484' }}>SIGNED IN · {account.email}</p>
        <h1 style={{ margin: '14px 0 0', fontFamily: 'var(--font-serif)', fontSize: 34, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)' }}>
          Move this library into your account?
        </h1>
        <p style={{ margin: '14px 0 0', fontSize: 15.5, lineHeight: 1.6, color: 'var(--color-fg-dim)' }}>
          This browser holds {paperCount === 1 ? 'a saved paper' : `${paperCount} saved papers`} plus your star map and profile.
          Your account is empty — move the library in once, and it works on every device you sign in on.
          Files already written to your disk folder stay where they are.
        </p>
        {state === 'error' && (
          <div style={{ marginTop: 16, padding: '10px 13px', borderRadius: 10, background: 'rgba(224,96,90,.12)', color: '#f0a9a4', fontSize: 13, lineHeight: 1.5 }}>
            <span style={{ fontWeight: 600 }}>Move failed:</span> {error} — nothing was lost; your library is still in this browser.
          </div>
        )}
        <div className="flex items-center" style={{ marginTop: 28, gap: 18 }}>
          <button
            onClick={move}
            disabled={state === 'moving'}
            className="cursor-pointer"
            style={{ padding: '13px 26px', border: 0, borderRadius: 12, background: 'var(--color-accent)', color: '#1c1206', fontSize: 15, fontWeight: 600, fontFamily: 'inherit', boxShadow: '0 10px 34px -12px rgba(239,143,91,.7)', opacity: state === 'moving' ? 0.6 : 1 }}
          >
            {state === 'moving' ? 'Moving…' : 'Move my library in'}
          </button>
          <button onClick={onDecline} disabled={state === 'moving'} className="cursor-pointer" style={{ border: 0, background: 'transparent', padding: 0, fontSize: 14, color: 'var(--color-fg-muted)', fontFamily: 'inherit' }}>
            Start fresh instead
          </button>
        </div>
      </div>
    </div>
  )
}

// Right rail on the Digest surface: key status, weekly counts, active projects,
// and the Weekend Read teaser. Counts derive from real saved papers.
function DigestRail({ saved, onSettings, counts, projects, onConnections, demo }) {
  return (
    <aside className="vs-digest-rail" style={{ width: 308, flex: '0 0 auto', padding: '34px 28px', overflowY: 'auto', background: 'rgba(255,255,255,.01)' }}>
      <div
        onClick={onSettings}
        className="flex items-center cursor-pointer"
        style={{ gap: 9, padding: '10px 13px', borderRadius: 11, marginBottom: demo ? 12 : 34, background: saved ? 'rgba(127,191,154,.08)' : 'rgba(230,184,119,.10)' }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: saved ? 'var(--color-verified)' : 'var(--color-abstract)', boxShadow: `0 0 7px ${saved ? 'var(--color-verified)' : 'var(--color-abstract)'}` }} />
        <span style={{ fontSize: 12.5, color: saved ? 'var(--color-verified-soft)' : 'var(--color-abstract)', fontWeight: 500 }}>{saved ? 'API key active' : 'Add your API key'}</span>
        <span style={{ marginLeft: 'auto', color: 'var(--color-fg-faint)', fontSize: 13 }}>⚙</span>
      </div>
      {demo && (
        <p style={{ margin: '0 0 34px', padding: '8px 13px', borderRadius: 10, background: 'rgba(143,189,230,.08)', fontSize: 12, lineHeight: 1.5, color: 'var(--color-registry)' }}>
          Demo profile — sample data. In demo mode nothing leaves this browser.
        </p>
      )}

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
          <p style={{ margin: '0 0 12px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Active Work</p>
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
  const [remembered, setRemembered] = useState(isKeyRemembered())
  const [status, setStatus] = useState('idle')
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const [onboarded, setOnboarded] = useState(null)
  // ?firstrun=1 previews the onboarding flow without touching the saved profile or key.
  const [firstrunPreview, setFirstrunPreview] = useState(() => new URLSearchParams(window.location.search).has('firstrun'))
  const [view, setView] = useState('digest')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [starsOpen, setStarsOpen] = useState(false) // north-star chips: collapsed by default
  const [profile, setProfile] = useState(null)
  const [counts, setCounts] = useState({ verified: 0, saved: 0, flagged: 0 })

  const [bootError, setBootError] = useState('')
  const [account, setAccount] = useState(null) // { email } when signed in
  // First signed-in boot with a local library and an empty cloud → the one-time
  // "move this library into your account" offer. { paperCount } while showing.
  const [migrationOffer, setMigrationOffer] = useState(null)

  useEffect(() => {
    // initStore() resolves auth and picks the backend (cloud vs IndexedDB) — it must
    // finish before the first read. Domains hydrate before any view mounts so sync
    // color/label lookups are ready.
    initStore().then(async (user) => {
      setAccount(user ? { email: user.email } : null)
      const [p] = await Promise.all([getProfile(), loadDomains()])
      if (user && !p?.onboarded) {
        // Cloud has no profile yet — check whether this browser holds a library to
        // carry in. Cloud wins when it has anything; local import is offered only
        // into an empty account.
        const [localProfile, localPapers, cloudPapers] = await Promise.all([
          idbStore.get('profile', 'me'),
          idbStore.all('papers'),
          store.all('papers'),
        ])
        if (
          shouldOfferMigration({
            localPapersCount: (localPapers || []).length,
            localProfile,
            cloudProfile: p,
            cloudPapersCount: (cloudPapers || []).length,
          })
        ) {
          setMigrationOffer({ paperCount: (localPapers || []).length })
        }
      }
      setOnboarded(!!p?.onboarded)
      setProfile(p || null)
    }).catch((err) => setBootError(err?.message || String(err)))
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

  function handleSave(k, remember) {
    setApiKey(k, { remember })
    setSaved(true)
    setRemembered(remember)
    setStatus('idle')
    setReply('')
    setError('')
  }
  function handleClear() {
    clearApiKey()
    setSaved(false)
    setRemembered(false)
    setStatus('idle')
    setReply('')
    setError('')
  }
  // Start over: drop the steering profile so the welcome screen returns. eraseAll
  // additionally clears every browser-side collection + the key, then reloads for a
  // clean boot (module caches like domains hydrate from empty). Files on disk are
  // never touched — the vault only ever writes, and only on save/sync.
  async function handleStartOver(eraseAll) {
    if (eraseAll) {
      await Promise.all(COLLECTIONS.map((c) => store.clear(c)))
      clearApiKey()
      window.location.reload()
      return
    }
    await store.delete('profile', 'me')
    setSettingsOpen(false)
    setProfile(null)
    setView('digest')
    setOnboarded(false)
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

  if (bootError) {
    // Storage failed to open (usually another tab holding an older schema) — say so
    // instead of a silent black screen.
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '100vh', padding: 32, background: 'linear-gradient(165deg,#0f1218,#08090d)' }}>
        <div style={{ maxWidth: 440, textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 26, fontWeight: 500, color: 'var(--color-fg)' }}>Verastar can't reach its storage</h1>
          <p style={{ margin: '12px 0 0', fontSize: 14.5, lineHeight: 1.6, color: 'var(--color-fg-dim)' }}>{bootError}</p>
          <button
            onClick={() => window.location.reload()}
            className="cursor-pointer"
            style={{ marginTop: 22, padding: '11px 22px', border: 0, borderRadius: 11, background: 'var(--color-accent)', color: '#1c1206', fontSize: 14, fontWeight: 600, fontFamily: 'inherit' }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }

  if (onboarded === null) return null // profile still loading

  if (migrationOffer && account) {
    return <MigrationOffer account={account} paperCount={migrationOffer.paperCount} onDecline={() => setMigrationOffer(null)} />
  }

  if (onboarded === false || firstrunPreview) {
    // First run: the five-step onboarding flow on the night-sky canvas (design/Onboarding.dc.html).
    const exitPreview = () => {
      window.history.replaceState(null, '', window.location.pathname)
      setFirstrunPreview(false)
    }
    return (
      <div className="vs-onboard-canvas relative flex items-center justify-center" style={{ minHeight: '100vh', overflowY: 'auto', padding: '56px 32px', background: 'radial-gradient(120% 80% at 50% -10%,#1a2138,#0b0e18 55%,#08090d)' }}>
        <div className="vs-stars-deep absolute" style={{ inset: 0 }} />
        <div className="absolute" style={{ top: -120, left: '50%', transform: 'translateX(-50%)', width: 680, height: 420, pointerEvents: 'none', background: 'radial-gradient(closest-side,rgba(239,143,91,.16),rgba(233,196,106,.06),transparent)', filter: 'blur(8px)' }} />
        {firstrunPreview && onboarded !== false && (
          <button onClick={exitPreview} className="fixed cursor-pointer" style={{ top: 16, right: 20, zIndex: 10, padding: '7px 13px', border: '1px solid rgba(255,255,255,.14)', borderRadius: 999, background: 'rgba(8,9,13,.6)', color: 'var(--color-fg-muted)', fontSize: 12, fontFamily: 'var(--font-mono)', letterSpacing: '.06em' }}>
            preview · nothing saves · exit ✕
          </button>
        )}
        <div className="relative" style={{ width: 600, maxWidth: '100%' }}>
          <OnboardingQuiz
            preview={firstrunPreview && onboarded !== false}
            onDone={() => {
              if (firstrunPreview) exitPreview()
              setSaved(hasApiKey())
              setOnboarded(true)
              getProfile().then((p) => setProfile(p || null))
            }}
          />
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
    <div className="vs-shell flex overflow-hidden" style={{ height: '100vh', width: '100%', background: 'linear-gradient(165deg,#0f1218,#08090d)' }}>
      <IconRail view={view} setView={setView} onSettings={() => setSettingsOpen(true)} initials={initials} />

      {view === 'digest' && (
        <div className="vs-digest flex" style={{ flex: 1, minWidth: 0 }}>
          <main className="vs-digest-main relative" style={{ flex: 1, minWidth: 0, overflowY: 'auto', borderRight: '1px solid var(--hairline)' }}>
            <div className="vs-stars absolute" style={{ top: 0, left: 0, right: 0, height: 340 }} />
            <div className="vs-page-pad relative" style={{ maxWidth: 820, padding: '46px 56px 64px' }}>
              <div className="flex items-start justify-between" style={{ gap: 24 }}>
                <div>
                  <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>{today}</p>
                  <h1 className="vs-hero-h1" style={{ margin: '9px 0 0', fontFamily: 'var(--font-serif)', fontSize: 37, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)', lineHeight: 1.08 }}>
                    Good morning, {name}.
                  </h1>
                </div>
              </div>
              {stars.length > 0 && (
                <div className="flex items-center" style={{ margin: '26px 0 0', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Steering by</span>
                  {/* Collapsed by default — the chip list gets tall as north stars grow (esp. on phones). */}
                  {starsOpen ? (
                    <>
                      {stars.map((s) => (
                        <span key={s} className="inline-flex items-center" style={{ gap: 7, padding: '6px 13px', borderRadius: 999, background: 'rgba(233,196,106,.11)', color: 'var(--color-gold-soft)', fontSize: 13, fontWeight: 500 }}>
                          <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-gold)', boxShadow: '0 0 8px var(--color-gold)' }} />
                          {s}
                        </span>
                      ))}
                      <button onClick={() => setStarsOpen(false)} className="cursor-pointer" style={{ border: 0, background: 'transparent', padding: 0, fontSize: 13, color: 'var(--color-fg-muted)', fontFamily: 'inherit' }}>
                        Hide
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setStarsOpen(true)}
                      className="inline-flex items-center cursor-pointer"
                      title="Show your north stars"
                      style={{ gap: 7, padding: '6px 13px', border: 0, borderRadius: 999, background: 'rgba(233,196,106,.11)', color: 'var(--color-gold-soft)', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' }}
                    >
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-gold)', boxShadow: '0 0 8px var(--color-gold)' }} />
                      {stars.length} north star{stars.length === 1 ? '' : 's'}
                    </button>
                  )}
                  <span onClick={() => setSettingsOpen(true)} className="cursor-pointer" style={{ fontSize: 13, color: 'var(--color-accent)' }}>Tune profile</span>
                </div>
              )}
              <div style={{ marginTop: 34 }}>
                <SpineCheck key={saved ? 'keyed' : 'nokey'} />
              </div>
            </div>
          </main>
          <DigestRail saved={saved} counts={counts} projects={projects} demo={!!profile?.demo && !account} onSettings={() => setSettingsOpen(true)} onConnections={() => setView('connections')} />
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
          remembered={remembered}
          onSave={handleSave}
          onClear={handleClear}
          onPing={handlePing}
          onStartOver={handleStartOver}
          status={status}
          reply={reply}
          error={error}
          account={account}
        />
      )}
    </div>
  )
}
