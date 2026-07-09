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
import {
  sourceSlug,
  conceptSlug,
  sourceNoteMd,
  conceptNoteMd,
  digestMd,
  connectionsEntryMd,
  readmeMd,
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
export async function ensurePermission(handle) {
  if (!handle) return false
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted'
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

// Deposit one saved paper to the library: write its source note; try to fetch + file its PDF (a
// CORS/network failure NEVER blocks the note); refresh its concept note if filed; refresh README.
export async function depositPaperToLibrary(paper) {
  const root = await activeRoot()
  if (!root || !paper) return
  const slug = sourceSlug(paper)
  await writeFileInDir(root, `sources/${slug}.md`, sourceNoteMd(paper))

  // The PDF is a bonus, not a guarantee: PMC often blocks cross-origin fetches. Isolate it so the
  // note is already safely on disk regardless of whether the bytes come down.
  if (paper.pdfUrl) {
    try {
      const resp = await fetch(paper.pdfUrl)
      if (resp.ok) {
        const blob = await resp.blob()
        await writeFileInDir(root, `sources/${slug}.pdf`, blob)
      }
    } catch (err) {
      console.warn('Library: PDF fetch failed (note still written):', err?.message || err)
    }
  }

  if (paper.conceptId) {
    const node = await store.get('graphNodes', paper.conceptId)
    if (node) await writeConceptNote(root, node, await store.all('papers'))
  }

  await refreshReadme(root)
}

// Freeze a digest (a list of { title, citation, tier, finding }) to digests/<date>_digest.md.
export async function writeDigestToLibrary(date, entries) {
  const root = await activeRoot()
  if (!root) return
  await writeFileInDir(root, `digests/${date}_digest.md`, digestMd(date, entries))
}

// Prepend this week's Weekend Read to connections.md (newest-first). Builds the pmid→paper lookup
// from the store so each thread's converging papers resolve to a title + citation + link.
export async function appendConnectionsToLibrary(date, weekend) {
  const root = await activeRoot()
  if (!root) return
  const papers = (await store.all('papers')) || []
  const lookup = new Map()
  for (const p of papers) lookup.set(String(p.pmid || p.id), { title: p.title, citation: p.citation })
  const entry = connectionsEntryMd(date, weekend, lookup)
  const existing = (await readFileText(root, CONNECTIONS_FILE)) || ''
  const body = existing ? `${entry}\n${existing}` : entry
  await writeFileInDir(root, CONNECTIONS_FILE, body)
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

  // Count total files up front: README + each source note (+ its optional PDF is best-effort and
  // not counted) + each concept note + one snapshot digest when there are papers.
  const total = 1 + allPapers.length + concepts.length + (allPapers.length ? 1 : 0)
  let done = 0
  const step = (label) => onProgress?.(++done, total, label)

  for (const paper of allPapers) {
    const slug = sourceSlug(paper)
    await writeFileInDir(root, `sources/${slug}.md`, sourceNoteMd(paper))
    if (paper.pdfUrl) {
      try {
        const resp = await fetch(paper.pdfUrl)
        if (resp.ok) await writeFileInDir(root, `sources/${slug}.pdf`, await resp.blob())
      } catch {
        // best-effort PDF — the note is what matters
      }
    }
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
