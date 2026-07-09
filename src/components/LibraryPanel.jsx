// components/LibraryPanel.jsx — the "File to Disk" block, embedded at the top of the Library.
//
// The pitch, made tangible: the app doesn't trap your work in the browser — every paper you save
// writes out as plain markdown into a folder you pick, openable in Finder. Once you've connected a
// folder, filing is automatic (SpineCheck's save + the Connections read write through on their own).
// The only button the browser forces on us is the initial folder pick — showDirectoryPicker must be
// triggered by a click for security. "Back-fill everything" is the on-camera magic + a catch-up for
// anything saved before the folder was connected.

import { useEffect, useState } from 'react'
import {
  isSupported,
  pickLibrary,
  getStoredHandle,
  ensurePermission,
  hasPermission,
  syncAllToLibrary,
} from '../lib/library.js'

export default function FileToDisk() {
  const [handle, setHandle] = useState(null) // connected + permitted FileSystemDirectoryHandle
  const [remembered, setRemembered] = useState(null) // a stored handle that needs a re-grant click
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [log, setLog] = useState([]) // running list of files written this session
  const [progress, setProgress] = useState(null) // { done, total }
  const [error, setError] = useState('')
  const supported = isSupported()

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

  if (loading) return null

  // Unsupported browser: one honest muted line, no dead buttons.
  if (!supported) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
        Filing your Library to a folder on disk needs Chrome or Edge on desktop.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/40">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">File to Disk</h3>
          <p className="mt-0.5 max-w-xl text-xs text-slate-600 dark:text-slate-400">
            {handle
              ? 'Every paper you save writes here automatically as plain markdown you own — openable in Finder. Nothing leaves your machine.'
              : remembered
                ? `Your library folder “${remembered.name}” is remembered. Browsers drop folder access on restart — reconnect to resume filing. Your files on disk are untouched.`
                : 'Pick a folder and every paper you save writes there automatically as plain markdown you own — openable in Finder. Nothing leaves your machine.'}
          </p>
        </div>
        {handle ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Filing to {handle.name}
          </span>
        ) : remembered ? (
          <button
            onClick={handleReconnect}
            className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            Reconnect “{remembered.name}”
          </button>
        ) : (
          <button
            onClick={handleConnect}
            className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            Choose a folder
          </button>
        )}
      </div>

      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      {remembered && (
        <button
          onClick={handleConnect}
          className="mt-2 text-[11px] font-medium text-slate-500 hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
        >
          or choose a different folder
        </button>
      )}

      {handle && (
        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            {syncing ? 'Writing…' : 'Back-fill everything'}
          </button>
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            Writes your whole Library to disk at once — useful for anything saved before you connected.
          </span>
        </div>
      )}

      {(syncing || log.length > 0) && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white/70 p-3 dark:border-slate-800 dark:bg-slate-900/40">
          {progress && progress.total > 0 && (
            <p className="mb-2 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              {progress.done} / {progress.total} files written
            </p>
          )}
          <ol className="max-h-48 space-y-0.5 overflow-y-auto pr-1 font-mono text-[11px]">
            {log.map((label, i) => (
              <li key={i} className="text-emerald-700 dark:text-emerald-400">
                ✓ {label}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
