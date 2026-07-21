// components/LibraryPanel.jsx — the "Own Your Memory" Library surface: the flat-file vault.
//
// The pitch, made tangible: the app doesn't trap your work in the browser — every paper you save
// writes out as plain markdown into a folder you pick, openable in Finder. Once you've connected a
// folder, filing is automatic (SpineCheck's save + the Connections read write through on their own).
// The only button the browser forces on us is the initial folder pick — showDirectoryPicker must be
// triggered by a click for security. "Back-fill everything" is the on-camera magic + a catch-up for
// anything saved before the folder was connected. Styled to the observatory design.

import { useEffect, useState } from 'react'
import {
  isSupported,
  pickLibrary,
  getStoredHandle,
  ensurePermission,
  hasPermission,
  syncAllToLibrary,
  drainVault,
  getLastDrain,
  onDrainResult,
} from '../lib/library.js'
import { store } from '../lib/store.js'
import { isSignedIn } from '../lib/supabase.js'
import { loadConcepts } from '../pipeline/graph.js'

// The folder-map explainer — what lives in the vault. Static; mirrors the on-disk layout.
const FOLDER_MAP = [
  ['sources/', 'One note per saved paper, with its PDF when open-access.'],
  ['concepts/', 'Synthesized topic notes, each linking its sources.'],
  ['digests/', 'Dated snapshots of a scan.'],
  ['connections.md', 'The running Weekend Read ledger, newest first.'],
]

export default function FileToDisk({ embedded = false }) {
  const [handle, setHandle] = useState(null) // connected + permitted FileSystemDirectoryHandle
  const [remembered, setRemembered] = useState(null) // a stored handle that needs a re-grant click
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [log, setLog] = useState([]) // running list of files written this session
  const [progress, setProgress] = useState(null) // { done, total }
  const [error, setError] = useState('')
  const [counts, setCounts] = useState({ sources: 0, concepts: 0 })
  // The most recent vault drain (this session) — the quiet "Caught up N notes" line.
  // The drain itself runs from App boot / window focus / the Reconnect click below.
  const [drained, setDrained] = useState(getLastDrain)
  const supported = isSupported()

  useEffect(() => onDrainResult(setDrained), [])

  // On mount, decide which of three states we're in. Browsers reset File System Access permission on
  // a new session, so after a restart the folder is REMEMBERED but not permitted — we can't silently
  // re-grant (requestPermission needs a click), so we surface a one-click "Reconnect" instead of the
  // first-time hero. We only query permission here (gesture-free); requesting waits for the click.
  useEffect(() => {
    ;(async () => {
      if (supported) {
        const stored = await getStoredHandle()
        if (stored) {
          if (await hasPermission(stored)) setHandle(stored) // still granted (same session)
          else setRemembered(stored) // remembered from a past session — needs a reconnect tap
        }
      }
      setLoading(false)
    })()
  }, [supported])

  // Real counts for the header — sources = saved papers, concepts = graph concept nodes.
  useEffect(() => {
    Promise.all([store.all('papers'), loadConcepts()])
      .then(([papers = [], concepts = []]) => setCounts({ sources: papers.length, concepts: concepts.length }))
      .catch(() => {})
  }, [])

  async function handleConnect() {
    setError('')
    try {
      const picked = await pickLibrary()
      if (picked) {
        setHandle(picked)
        setRemembered(null)
      }
    } catch (err) {
      setError(err?.message || String(err))
    }
  }

  // Re-grant permission on the folder we already remember — one click, no re-pick. This runs from a
  // user gesture, so requestPermission is allowed. If it's denied (or the folder moved/was deleted),
  // keep the reconnect state and let them retry or pick a different folder.
  async function handleReconnect() {
    setError('')
    try {
      if (await ensurePermission(remembered)) {
        setHandle(remembered)
        setRemembered(null)
        // Same folder, permission back — catch up anything saved since it disconnected
        // (phone saves, or desktop saves from before the reconnect). Quiet, idempotent.
        drainVault().catch(() => {})
      } else {
        setError('Permission wasn’t granted — click Reconnect and choose Allow to resume filing here.')
      }
    } catch (err) {
      setError(err?.message || String(err))
    }
  }

  async function handleSync() {
    setSyncing(true)
    setError('')
    setLog([])
    setProgress({ done: 0, total: 0 })
    try {
      await syncAllToLibrary((done, total, label) => {
        setProgress({ done, total })
        setLog((prev) => [...prev, label])
      })
    } catch (err) {
      setError(err?.message || String(err))
    }
    setSyncing(false)
  }

  const accentGreen = { border: 0, borderRadius: 11, background: 'var(--color-verified)', color: '#0c1710', fontSize: 14, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer', boxShadow: '0 6px 22px -8px rgba(127,191,154,.7)' }

  // The connected-folder chip, shown next to whichever heading is in play.
  const folderChip = handle && (
    <span className="inline-flex items-center" style={{ gap: 8, padding: '6px 13px', borderRadius: 999, background: 'rgba(127,191,154,.1)', color: 'var(--color-verified-soft)', fontSize: 12.5, fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-verified)', boxShadow: '0 0 7px var(--color-verified)' }} />
      {handle.name}
    </span>
  )

  const body = (
    <>
      {embedded ? (
        // Folded into the Library surface below the concepts — a section, not a page.
        <div className="flex items-center justify-between" style={{ gap: 16 }}>
          <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Own your memory · files on disk</p>
          {folderChip}
        </div>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 12, letterSpacing: '.15em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>Own your memory</p>
          <div className="flex items-end justify-between" style={{ gap: 20, marginTop: 9 }}>
            <h1 style={{ margin: 0, fontFamily: 'var(--font-serif)', fontSize: 34, fontWeight: 500, letterSpacing: '-.01em', color: 'var(--color-fg)' }}>Library</h1>
            {folderChip}
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 15, color: 'var(--color-fg-dim)', maxWidth: 640, lineHeight: 1.6 }}>
            Verastar writes your saved papers, synthesized concepts, and Weekend Read straight into a folder you pick —
            plain markdown you own, openable in Finder. The app only ever touches that one folder.{' '}
            {isSignedIn()
              ? 'Your account keeps the library in sync on every device — this folder is your own copy, in files any agent can read.'
              : 'Nothing leaves your machine.'}
          </p>
        </>
      )}

      {!supported ? (
        // Phones can't write the folder (File System Access is desktop-only) — and that's the
        // design, not a limitation to apologize for: the computer is the librarian.
        <p style={{ margin: '26px 0 0', fontSize: 13.5, lineHeight: 1.6, color: 'var(--color-fg-muted)', maxWidth: 560 }}>
          {isSignedIn()
            ? 'Your computer is the librarian here. Papers you save on this phone go straight to your account — and the next time Verastar opens on your computer (Chrome or Edge), it files them into your folder on disk automatically.'
            : 'Filing to a folder on disk is your computer’s job — open Verastar in Chrome or Edge on a desktop to connect a folder there. Papers saved on this phone stay in this browser.'}
        </p>
      ) : loading ? null : (
        <>
          {/* counts + connect / sync */}
          <div className="flex items-center flex-wrap" style={{ marginTop: 28, gap: 30, padding: '22px 26px', borderRadius: 16, background: 'var(--surface-1)' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-serif)', fontSize: 34, color: 'var(--color-fg)', lineHeight: 1 }}>{counts.sources}</div>
              <div style={{ fontSize: 12.5, color: 'var(--color-fg-muted)', marginTop: 4 }}>sources</div>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-serif)', fontSize: 34, color: 'var(--color-fg)', lineHeight: 1 }}>{counts.concepts}</div>
              <div style={{ fontSize: 12.5, color: 'var(--color-fg-muted)', marginTop: 4 }}>concepts</div>
            </div>
            <div style={{ marginLeft: 'auto' }}>
              {handle ? (
                <button onClick={handleSync} disabled={syncing} style={{ ...accentGreen, padding: '11px 20px', opacity: syncing ? 0.6 : 1 }}>
                  {syncing ? 'Writing…' : 'Sync everything now'}
                </button>
              ) : remembered ? (
                <button onClick={handleReconnect} style={{ ...accentGreen, padding: '11px 20px' }}>Reconnect “{remembered.name}”</button>
              ) : (
                <button onClick={handleConnect} style={{ ...accentGreen, padding: '11px 20px' }}>Choose a folder</button>
              )}
            </div>
          </div>
          <p style={{ margin: '12px 2px 0', fontSize: 12.5, lineHeight: 1.55, color: 'var(--color-fg-muted)' }}>
            {handle
              ? 'New saves and weekend reads write here automatically. Use “Sync everything now” to back-fill the whole library at once.'
              : remembered
                ? `Your library folder “${remembered.name}” is remembered — browsers drop folder access on restart. Reconnect to resume filing; your files on disk are untouched.`
                : 'Pick a folder once. Every paper you save then writes there automatically — plain markdown you own.'}
          </p>

          {drained && (drained.written > 0 || drained.weekends > 0) && (
            <p style={{ margin: '10px 2px 0', fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--color-verified-soft)' }}>
              ✓ Caught up{' '}
              {drained.written > 0 && `${drained.written} note${drained.written === 1 ? '' : 's'}`}
              {drained.written > 0 && drained.weekends > 0 && ' and '}
              {drained.weekends > 0 && 'your weekend read'}
              {' '}from your phone.
            </p>
          )}
          {error && <p style={{ margin: '10px 2px 0', fontSize: 13, color: 'var(--color-domain-vascular)' }}>{error}</p>}
          {remembered && (
            <button onClick={handleConnect} className="cursor-pointer" style={{ margin: '8px 2px 0', display: 'block', fontSize: 12, color: 'var(--color-fg-muted)', background: 'transparent', border: 0 }}>or choose a different folder</button>
          )}

          {/* live write log */}
          {(syncing || log.length > 0) && (
            <div style={{ marginTop: 20, borderRadius: 16, background: 'rgba(255,255,255,.02)', border: '1px solid var(--hairline)', overflow: 'hidden' }}>
              <div className="flex items-center" style={{ gap: 10, padding: '13px 18px', borderBottom: '1px solid var(--hairline)' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-verified)', boxShadow: '0 0 7px var(--color-verified)' }} />
                <span style={{ fontSize: 12.5, color: 'var(--color-verified-soft)', fontWeight: 500, fontFamily: 'var(--font-mono)' }}>
                  {progress && progress.total > 0 ? `${progress.done} / ${progress.total} files written` : 'Writing…'}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-fg-faint)', fontFamily: 'var(--font-mono)' }}>just now</span>
              </div>
              <ol className="overflow-y-auto" style={{ margin: 0, padding: '14px 18px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 200, fontFamily: 'var(--font-mono)', fontSize: 12.5, color: '#8fbfa2', lineHeight: 1.5 }}>
                {log.map((label, i) => (
                  <li key={i}>✓ {label}</li>
                ))}
              </ol>
            </div>
          )}

          {/* folder map */}
          <p style={{ margin: '32px 0 12px', fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--color-fg-faint)', fontWeight: 600 }}>What lives in your folder</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, borderRadius: 14, overflow: 'hidden', background: 'rgba(255,255,255,.02)', border: '1px solid var(--hairline)' }}>
            {FOLDER_MAP.map(([name, desc], i) => (
              <div key={name} className="flex" style={{ alignItems: 'baseline', gap: 16, padding: '13px 18px', borderTop: i === 0 ? 'none' : '1px solid var(--hairline-soft)' }}>
                <span style={{ flex: '0 0 168px', fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--color-gold-soft)' }}>{name}</span>
                <span style={{ fontSize: 13.5, color: 'var(--color-fg-dim)', lineHeight: 1.5 }}>{desc}</span>
              </div>
            ))}
          </div>
          <p style={{ margin: '16px 2px 0', fontSize: 12.5, lineHeight: 1.6, color: 'var(--color-fg-muted)' }}>
            Plain markdown files you own. Point any editor, notebook, or tool at this folder later — nothing here is locked inside an app.
          </p>
        </>
      )}
    </>
  )

  // Standalone (its own surface) gets the page frame; embedded drops into the Library page.
  return embedded ? body : <div style={{ maxWidth: 860, padding: '46px 56px 64px' }}>{body}</div>
}
