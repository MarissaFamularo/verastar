// components/LibraryPanel.jsx — the "Own Your Memory" surface: connect a real folder on disk and
// watch Verastar write your evidence out as plain markdown you own.
//
// The pitch, made tangible: the app doesn't trap your work in IndexedDB — it writes source notes,
// synthesized concepts, digests, and the Weekend Read ledger straight into a folder you pick, which
// you can open in Finder. "Sync everything now" is the on-camera magic: a live list of files
// scrolling by as they land on disk.

import { useEffect, useState } from 'react'
import { store } from '../lib/store.js'
import {
  isSupported,
  pickLibrary,
  getStoredHandle,
  ensurePermission,
  syncAllToLibrary,
} from '../lib/library.js'

export default function LibraryPanel() {
  const [handle, setHandle] = useState(null) // connected FileSystemDirectoryHandle
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [log, setLog] = useState([]) // running list of files written this session
  const [progress, setProgress] = useState(null) // { done, total }
  const [counts, setCounts] = useState({ sources: 0, concepts: 0 })
  const [error, setError] = useState('')
  const supported = isSupported()

  // Reconnect a previously-picked folder (permission may need a re-grant on some sessions), and load
  // the live counts either way so the panel reads honestly before the first sync.
  useEffect(() => {
    ;(async () => {
      const [papers, nodes] = await Promise.all([store.all('papers'), store.all('graphNodes')])
      setCounts({
        sources: (papers || []).length,
        concepts: (nodes || []).filter((n) => n.kind === 'concept').length,
      })
      if (supported) {
        const stored = await getStoredHandle()
        if (stored && (await ensurePermission(stored))) setHandle(stored)
      }
      setLoading(false)
    })()
  }, [supported])

  async function handleConnect() {
    setError('')
    try {
      const picked = await pickLibrary()
      if (picked) setHandle(picked)
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

  if (loading) {
    return <p className="mt-8 text-sm text-slate-500 dark:text-slate-400">Loading…</p>
  }

  // Unsupported browser: honest note, no dead buttons.
  if (!supported) {
    return (
      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-medium">Your library folder</h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          Writing your evidence to a folder on disk needs the File System Access API, available in
          <span className="font-medium"> Chrome</span> or <span className="font-medium">Edge</span> on
          desktop. Open Verastar there to own your memory as real files.
        </p>
      </section>
    )
  }

  return (
    <section className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">Own your memory</h2>
          <p className="mt-1 max-w-xl text-sm text-slate-600 dark:text-slate-400">
            Verastar writes your saved papers, synthesized concepts, and Weekend Read straight into a
            folder you pick — plain markdown you own, openable in Finder. The app only ever touches
            that one folder.
          </p>
        </div>
        {handle && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {handle.name}
          </span>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>}

      {!handle ? (
        // Not connected: the hero call-to-action.
        <div className="mt-6 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center dark:border-slate-700 dark:bg-slate-950/40">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Files write straight to a folder you pick and appear in Finder. Nothing leaves your machine.
          </p>
          <button
            onClick={handleConnect}
            className="mt-4 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            Choose your library folder
          </button>
        </div>
      ) : (
        // Connected: counts + the sync action + the live write log.
        <div className="mt-6">
          <div className="flex flex-wrap items-center gap-6 text-sm">
            <div>
              <span className="text-2xl font-semibold tabular-nums">{counts.sources}</span>{' '}
              <span className="text-slate-500 dark:text-slate-400">
                source{counts.sources === 1 ? '' : 's'}
              </span>
            </div>
            <div>
              <span className="text-2xl font-semibold tabular-nums">{counts.concepts}</span>{' '}
              <span className="text-slate-500 dark:text-slate-400">
                concept{counts.concepts === 1 ? '' : 's'}
              </span>
            </div>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="ml-auto rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Sync everything now'}
            </button>
          </div>

          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            New saves and weekend reads write here automatically. Use “Sync everything now” to back-fill
            the whole library at once.
          </p>

          {(syncing || log.length > 0) && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/40">
              {progress && progress.total > 0 && (
                <p className="mb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                  {progress.done} / {progress.total} files written
                </p>
              )}
              <ol className="max-h-64 space-y-0.5 overflow-y-auto pr-1 font-mono text-xs text-slate-600 dark:text-slate-400">
                {log.map((label, i) => (
                  <li key={i} className="text-emerald-700 dark:text-emerald-400">
                    ✓ {label}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
