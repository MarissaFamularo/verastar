// lib/library.js — the File System Access side-effect layer for the flat-file vault.
//
// This is deliberately THIN: it decides only WHERE bytes land (walk/create dirs, write files) and
// WHEN to write (guarded on a connected, permitted folder handle). WHAT the files say is decided
// once, purely, in libraryFormat.js — so nothing here constructs markdown.
//
// The whole layer degrades to a silent no-op when the API is unavailable or no folder is connected:
// every high-level hook returns quietly, so the app behaves exactly as before on an unsupported
// browser or before the user picks a folder. Nothing here can ever break a save.
//
// Persistence note: the picked FileSystemDirectoryHandle is structured-cloneable, so we stash it in
// the existing `profile` object store under the key 'libraryHandle' — NO schema/DB_VERSION bump.

import { store, getProfile } from './store.js'
import { resolveOaLink, oaPatch } from '../pipeline/openaccess.js'
import { computeDrain, stampVaultWritten, weekendKey } from './drain.js'
import {
  sourceSlug,
  conceptSlug,
  sourceNoteMd,
  conceptNoteMd,
  digestMd,
  connectionsEntryMd,
  readmeMd,
  removeWeekSection,
} from './libraryFormat.js'

const HANDLE_KEY = 'libraryHandle'
const CONNECTIONS_FILE = 'connections.md'

// --- capability + connection ---------------------------------------------------------------------

// Is the File System Access API present? (Chrome/Edge desktop.) Everything else no-ops.
export function isSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

// Prompt the user to choose their library folder (readwrite). Persists the handle so a later visit
// reconnects without re-picking. Returns the handle, or null if the user cancelled the picker.
export async function pickLibrary() {
  if (!isSupported()) return null
  try {
    const handle = await window.showDirectoryPicker({ id: 'verastar-library', mode: 'readwrite' })
    await store.put('profile', HANDLE_KEY, handle)
    return handle
  } catch (err) {
    if (err?.name === 'AbortError') return null // user closed the picker — not an error
    throw err
  }
}

// The persisted handle from a previous session (or undefined). A saved handle still needs
// ensurePermission before it can be written to — the browser may require a re-grant.
export function getStoredHandle() {
  return store.get('profile', HANDLE_KEY)
}

// Query, then (if needed) request readwrite permission on a handle. Returns whether it's granted.
// NOTE: requestPermission requires transient user activation — only call this from a click handler.
export async function ensurePermission(handle) {
  if (!handle) return false
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

// Query ONLY (never request) whether a handle already has readwrite permission. Safe to call on
// mount with no user gesture — browsers reset File System Access permission on a new session, so
// after a restart this returns false even though the handle is remembered. The UI uses that to show
// a one-click "Reconnect" (a gesture) instead of making the user re-pick the folder from scratch.
export async function hasPermission(handle) {
  if (!handle) return false
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted'
  } catch {
    return false
  }
}

// The connected + permitted root handle, or null. Every high-level write funnels through this so a
// disconnected/denied state is a uniform, quiet no-op.
async function activeRoot() {
  if (!isSupported()) return null
  const handle = await getStoredHandle()
  if (!handle) return null
  return (await ensurePermission(handle)) ? handle : null
}

// --- low-level file writing ----------------------------------------------------------------------

// Write `contents` (a string, Blob, or ArrayBuffer/TypedArray) to `path` under rootHandle, creating
// any intermediate directories. e.g. writeFileInDir(root, 'sources/x.md', '…').
export async function writeFileInDir(rootHandle, path, contents) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()
  let dir = rootHandle
  for (const name of segments) {
    dir = await dir.getDirectoryHandle(name, { create: true })
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(contents)
  await writable.close()
}

// Read a file's text from under rootHandle, or null if it doesn't exist (used to prepend to the
// connections ledger without clobbering earlier weeks).
async function readFileText(rootHandle, path) {
  const segments = path.split('/').filter(Boolean)
  const fileName = segments.pop()
  let dir = rootHandle
  try {
    for (const name of segments) dir = await dir.getDirectoryHandle(name)
    const fileHandle = await dir.getFileHandle(fileName)
    const file = await fileHandle.getFile()
    return await file.text()
  } catch {
    return null // not found — a first-ever write
  }
}

// --- vault-written stamps -------------------------------------------------------------------------

// Mark a record's note as landed on disk (see lib/drain.js — the drain is derived from these
// stamps, not a queue). Re-reads the live record so a background enrichment patch that raced the
// write is never clobbered. Quietly skips records that vanished meanwhile.
async function stampRecord(collection, key, nowIso) {
  try {
    const cur = await store.get(collection, key)
    if (cur) await store.put(collection, key, stampVaultWritten(cur, nowIso))
  } catch {
    /* an unstamped record just means one redundant rewrite on the next drain */
  }
}

// --- internal shared writers ---------------------------------------------------------------------

// The papers filed under a concept (mirrors deposit.js membership: conceptId match OR sourcePmids).
function membersOf(node, allPapers) {
  return (allPapers || []).filter(
    (p) => p.conceptId === node.id || (node.sourcePmids || []).includes(String(p.pmid)),
  )
}

// Recompute counts from the store and rewrite README.md. Called after every deposit so the cover
// page's live counts stay honest.
export async function refreshReadme(root) {
  const rootHandle = root || (await activeRoot())
  if (!rootHandle) return
  const [papers, nodes, profile] = await Promise.all([
    store.all('papers'),
    store.all('graphNodes'),
    getProfile(),
  ])
  const concepts = (nodes || []).filter((n) => n.kind === 'concept')
  const md = readmeMd({
    profileName: profile?.name,
    counts: { sources: (papers || []).length, concepts: concepts.length },
  })
  await writeFileInDir(rootHandle, 'README.md', md)
}

// Write/refresh one concept note (+ its member sources). Shared by the deposit hook and the sync.
async function writeConceptNote(rootHandle, node, allPapers) {
  const md = conceptNoteMd(node, membersOf(node, allPapers))
  await writeFileInDir(rootHandle, `concepts/${conceptSlug(node)}.md`, md)
}

// --- high-level hooks (each a no-op when no folder is connected) ----------------------------------

// Deposit one saved paper to the library: write its source note (which carries the open-access PDF
// LINK when we have one — bytes aren't fetchable cross-origin); refresh its concept note if filed;
// refresh README.
export async function depositPaperToLibrary(paper) {
  const root = await activeRoot()
  if (!root || !paper) return
  const slug = sourceSlug(paper)
  await writeFileInDir(root, `sources/${slug}.md`, sourceNoteMd(paper))

  if (paper.conceptId) {
    const node = await store.get('graphNodes', paper.conceptId)
    if (node) await writeConceptNote(root, node, await store.all('papers'))
  }

  await refreshReadme(root)
  await stampRecord('papers', paper.id, new Date().toISOString())
}

// Freeze a digest (a list of { title, citation, tier, finding }) to digests/<date>_digest.md.
export async function writeDigestToLibrary(date, entries) {
  const root = await activeRoot()
  if (!root) return
  await writeFileInDir(root, `digests/${date}_digest.md`, digestMd(date, entries))
}

// Prepend this week's Weekend Read to connections.md (newest-first). Builds the pmid→paper lookup
// from the store so each thread's converging papers resolve to a title + citation + link.
// Idempotent per week: an existing section for the same date is replaced, not stacked — so the
// vault drain and a same-day regenerate both refresh the entry instead of duplicating it. Stamps
// the weekend record afterwards so the drain knows this read has landed on disk.
export async function appendConnectionsToLibrary(date, weekend) {
  const root = await activeRoot()
  if (!root) return
  const papers = (await store.all('papers')) || []
  const lookup = new Map()
  for (const p of papers) lookup.set(String(p.pmid || p.id), { title: p.title, citation: p.citation })
  const entry = connectionsEntryMd(date, weekend, lookup)
  const existing = removeWeekSection((await readFileText(root, CONNECTIONS_FILE)) || '', date)
  const body = existing ? `${entry}\n${existing}` : entry
  await writeFileInDir(root, CONNECTIONS_FILE, body)
  await stampRecord('digests', `weekend:${date}`, new Date().toISOString())
}

// The demo backfill / bulletproof filming path: write EVERY saved paper, every concept note, a
// snapshot digest of the current library, and a fresh README. `onProgress(done, total, label)`
// fires per file so the UI can render the running list of writes. No-op if no folder is connected.
export async function syncAllToLibrary(onProgress) {
  const root = await activeRoot()
  if (!root) return { written: 0 }

  const [papers, nodes] = await Promise.all([store.all('papers'), store.all('graphNodes')])
  const allPapers = papers || []
  const concepts = (nodes || []).filter((n) => n.kind === 'concept')

  // Count total files up front: README + each source note + each concept note + one snapshot digest
  // when there are papers.
  const total = 1 + allPapers.length + concepts.length + (allPapers.length ? 1 : 0)
  let done = 0
  const step = (label) => onProgress?.(++done, total, label)

  for (const paper of allPapers) {
    // Backfill an open-access LINK for papers saved before this existed (Unpaywall; null when
    // there's no DOI or no OA copy). Persist it so the KB badge benefits too, not just the note.
    let p = paper
    if (!p.pdfUrl && !p.oaUrl && p.citation?.doi) {
      const patch = oaPatch(await resolveOaLink(p.citation.doi))
      if (patch) {
        p = { ...p, ...patch }
        await store.put('papers', p.id, p)
      }
    }
    const slug = sourceSlug(p)
    await writeFileInDir(root, `sources/${slug}.md`, sourceNoteMd(p))
    await stampRecord('papers', p.id, new Date().toISOString())
    step(`sources/${slug}.md`)
  }

  for (const node of concepts) {
    await writeConceptNote(root, node, allPapers)
    step(`concepts/${conceptSlug(node)}.md`)
  }

  if (allPapers.length) {
    const date = new Date().toISOString().slice(0, 10)
    const entries = allPapers.map((p) => ({
      title: p.title,
      citation: p.citation,
      tier: p.tier,
      finding: p.finding,
    }))
    await writeFileInDir(root, `digests/${date}_digest.md`, digestMd(date, entries))
    step(`digests/${date}_digest.md`)
  }

  await refreshReadme(root)
  step('README.md')

  return { written: done }
}

// --- the vault drain ------------------------------------------------------------------------------

// Catch the folder up with everything saved away from this desktop (the phone, or a session with
// the folder disconnected). Which records need writing is pure, tested logic (lib/drain.js) over
// the vaultWrittenAt stamps; this function is only the disk side-effect. Permission is QUERIED,
// never requested — no gesture, no prompt: a remembered-but-not-regranted folder simply waits for
// the Reconnect click in File to Disk, which calls this again. Idempotent (each write stamps its
// record), so a second open — or boot + focus firing together — writes nothing new.

let _lastDrain = null // { written, weekends, at } of the most recent non-empty drain this session
const _drainListeners = new Set()

export function getLastDrain() {
  return _lastDrain
}

// Subscribe File to Disk's quiet "Caught up N notes" line. Returns an unsubscribe.
export function onDrainResult(fn) {
  _drainListeners.add(fn)
  return () => _drainListeners.delete(fn)
}

let _draining = null // concurrent triggers (boot + window focus) share one run

export function drainVault() {
  if (_draining) return _draining
  _draining = (async () => {
    if (!isSupported()) return { written: 0 }
    const handle = await getStoredHandle()
    if (!handle || !(await hasPermission(handle))) return { written: 0 }

    const [papers, digests, nodes] = await Promise.all([
      store.all('papers'),
      store.all('digests'),
      store.all('graphNodes'),
    ])
    const drain = computeDrain({ papers, digests })
    if (!drain.papers.length && !drain.weekends.length) return { written: 0 }

    let written = 0
    for (const p of drain.papers) {
      const slug = sourceSlug(p)
      await writeFileInDir(handle, `sources/${slug}.md`, sourceNoteMd(p))
      await stampRecord('papers', p.id, new Date().toISOString())
      written++
    }
    for (const id of drain.conceptIds) {
      const node = (nodes || []).find((n) => n.id === id)
      if (node) await writeConceptNote(handle, node, papers)
    }
    // Oldest first, so the newest-first ledger ends up in order. appendConnectionsToLibrary
    // replaces-then-prepends and stamps the record itself.
    for (const w of drain.weekends) {
      await appendConnectionsToLibrary(weekendKey(w).slice('weekend:'.length), w.read)
    }
    if (written) await refreshReadme(handle)

    _lastDrain = { written, weekends: drain.weekends.length, at: new Date().toISOString() }
    for (const fn of _drainListeners) fn(_lastDrain)
    return _lastDrain
  })().finally(() => {
    _draining = null
  })
  return _draining
}
