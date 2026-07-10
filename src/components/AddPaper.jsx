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
    <div style={{ borderRadius: 14, border: '1px solid var(--hairline)', background: 'var(--surface-1)', padding: 18 }}>
      <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--color-fg-soft)' }}>Add a paper</h3>
      <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--color-fg-muted)', lineHeight: 1.5 }}>
        Reading something outside the digest? Paste a PMID, DOI, or PubMed / PMC link — it runs through
        the same verifier and lands in your Library.
      </p>

      <form onSubmit={handleAdd} className="flex" style={{ marginTop: 12, gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. 39993822, 10.1136/bmj-2024-079013, or a pubmed.ncbi.nlm.nih.gov link"
          disabled={!keySet || busy}
          className="min-w-0 flex-1"
          style={{ borderRadius: 10, border: '1px solid rgba(255,255,255,.1)', background: 'var(--surface-input)', padding: '10px 13px', fontSize: 14, color: 'var(--color-fg)', fontFamily: 'inherit', outline: 'none', opacity: !keySet || busy ? 0.5 : 1 }}
        />
        <button
          type="submit"
          disabled={!keySet || busy || !input.trim()}
          className="shrink-0 cursor-pointer"
          style={{ borderRadius: 10, background: 'var(--color-accent)', color: '#1c1206', padding: '9px 18px', fontSize: 14, fontWeight: 600, border: 0, fontFamily: 'inherit', opacity: !keySet || busy || !input.trim() ? 0.5 : 1 }}
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </form>

      {!keySet && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-abstract)' }}>Set your API key in Settings to add a paper — extraction runs on your key.</p>
      )}
      {busy && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-accent)' }}>{STAGE_LABEL[stage] || 'Working…'}</p>}
      {error && <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--color-domain-vascular)' }}>{error}</p>}
      {done && <p style={{ margin: '8px 0 0', fontSize: 12, fontWeight: 500, color: 'var(--color-verified-soft)' }}>{done}</p>}
    </div>
  )
}
