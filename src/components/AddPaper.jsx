// components/AddPaper.jsx — add a paper to the Library from OUTSIDE the digest. Paste a PMID, DOI,
// or PubMed/PMC link for something you're reading, and it goes through the EXACT same pipeline a
// digest paper does: fetch source → Claude extracts → the deterministic verifier gates every number
// → file under a concept → save to the Library (and to disk if a folder is connected). Same trust
// gate, just pointed at a paper you chose — never a shortcut around the verifier.
//
// Scope: anything with a PubMed record (PMID / DOI / PubMed or PMC URL). A non-indexed PDF/preprint
// has nothing structured to verify against — that's the separate, deferred "manual PDF-drop" path.

import { useState } from 'react'
import { hasApiKey } from '../lib/anthropic.js'
import { getProfile, store } from '../lib/store.js'
import { runPaper } from '../pipeline/pipeline.js'
import { resolvePmid } from '../pipeline/sources.js'
import { triage } from '../pipeline/triage.js'
import { savePaper } from '../pipeline/save.js'
import { fmtNum } from '../lib/format.js'

const STAGE_LABEL = {
  resolving: 'Finding the paper…',
  fetching: 'Fetching source…',
  extracting: 'Extracting (Claude)…',
  verifying: 'Verifying…',
  saving: 'Saving…',
}

export default function AddPaper({ onAdded }) {
  const [input, setInput] = useState('')
  const [stage, setStage] = useState('') // '' | resolving | fetching | extracting | verifying | saving
  const [error, setError] = useState('')
  const [done, setDone] = useState('') // success summary line
  const keySet = hasApiKey()
  const busy = stage !== ''

  async function handleAdd(e) {
    e?.preventDefault()
    if (busy || !input.trim()) return
    setError('')
    setDone('')

    setStage('resolving')
    let pmid
    try {
      pmid = await resolvePmid(input)
    } catch {
      pmid = null
    }
    if (!pmid) {
      setStage('')
      setError('Couldn’t find that paper. Paste a PMID, a DOI, or a PubMed / PMC link.')
      return
    }

    // Already saved? Don't spend an extraction re-adding it.
    const existing = await store.get('papers', pmid)
    if (existing) {
      setStage('')
      setDone(`Already in your Library: “${existing.title || `PMID ${pmid}`}”.`)
      setInput('')
      return
    }

    // Same pipeline as a digest paper: fetch → extract → verify.
    const paper = { id: pmid, pmid, pmcid: null, nct: null, title: null }
    const res = await runPaper(paper, {
      onStage: (_id, s) => setStage(s === 'done' || s === 'error' ? 'saving' : s),
    })

    // Prose channel: one cheap triage call writes the tier + finding + relevance for this one paper.
    // Never blocks the save — a triage failure just means an empty take (still verified numbers).
    let take = {}
    try {
      const profile = await getProfile()
      const rankings = await triage({
        northStars: profile?.northStars ?? [],
        projects: profile?.projects ?? [],
        rubric: profile?.rubric?.criteria ?? '',
        candidates: [
          {
            id: pmid,
            title: res.paper.title || res.citation?.title || `PMID ${pmid}`,
            design: res.design,
            summary: res.sourceDoc?.text || '',
            verified: res.error
              ? []
              : res.rows
                  .filter((r) => !r.verdict.flagged)
                  .map((r) => ({ name: r.quantity.name, value: fmtNum(r.quantity) })),
          },
        ],
      })
      take = rankings.find((r) => String(r.id) === String(pmid)) || {}
    } catch (err) {
      console.warn('Triage failed (paper still saved):', err.message)
    }

    setStage('saving')
    const title = res.citation?.title || res.paper.title || `PMID ${pmid}`
    let record
    try {
      record = await savePaper(res, take, { title })
    } catch (err) {
      setStage('')
      setError(`Couldn’t save: ${err.message}`)
      return
    }

    // Honest one-line result: what the verifier actually proved.
    const verified = res.error ? 0 : res.rows.filter((r) => !r.verdict.flagged).length
    const flagged = res.error ? 0 : res.rows.filter((r) => r.verdict.flagged).length
    const bits = []
    if (verified) bits.push(`${verified} value${verified === 1 ? '' : 's'} verified`)
    if (flagged) bits.push(`${flagged} flagged`)
    if (res.error) bits.push('citation saved (source unavailable)')
    if (!bits.length) bits.push('no numeric claims to verify')
    setDone(`Added “${record.title}” — ${bits.join(', ')}.`)
    setInput('')
    setStage('')
    onAdded?.()
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-4 dark:border-slate-800 dark:bg-slate-950/40">
      <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Add a paper</h3>
      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
        Reading something outside the digest? Paste a PMID, DOI, or PubMed / PMC link — it runs through
        the same verifier and lands in your Library.
      </p>

      <form onSubmit={handleAdd} className="mt-3 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. 39993822, 10.1136/bmj-2024-079013, or a pubmed.ncbi.nlm.nih.gov link"
          disabled={!keySet || busy}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950"
        />
        <button
          type="submit"
          disabled={!keySet || busy || !input.trim()}
          className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>

      {!keySet && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          Set your API key above to add a paper — extraction runs on your key.
        </p>
      )}
      {busy && (
        <p className="mt-2 text-xs text-indigo-600 dark:text-indigo-300">{STAGE_LABEL[stage] || 'Working…'}</p>
      )}
      {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
      {done && <p className="mt-2 text-xs font-medium text-emerald-700 dark:text-emerald-400">{done}</p>}
    </div>
  )
}
