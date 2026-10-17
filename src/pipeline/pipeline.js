// pipeline/pipeline.js — the orchestrator that wires the spine together:
//   sources (fetch)  ->  extract (LLM, untrusted)  ->  verify (deterministic gate)
//
// This is also the spine-day TEST ORACLE (docs/VERIFICATION_SPEC.md#test-oracle). It runs
// the REAL pipeline on the demo corpus — cached source docs would be fine, cached results
// never are. The three conditions that must hold:
//   - BASIL-3  HR 0.84            -> verified-full-text
//   - STARDUST TcPO2 diff 11.2    -> verified-registry (matches CT.gov)
//   - a corrupted value (HR 0.94) -> flagged, never charted

import {
  fetchPmcFullText,
  assembleExtractionSource,
  fetchAbstracts,
  fetchRegistry,
  parseRegistryOutcomes,
  REGISTRY_OUTCOME_MAP,
  fetchCitation,
  fetchCitations,
  fetchAbstractsByPmid,
  pmidToPmcid,
  searchPubmed,
  searchPaceMs,
} from './sources.js'
import { compilePubmedQuery, fitsTopic } from './pubmedQuery.js'
import { extractQuantities, dropUnprovenLabels } from './extract.js'
import { MODELS } from '../lib/anthropic.js'
import { sha256Hex, cacheKeyHeader, lookupCachedExtraction, storeCachedExtraction } from './evidenceCache.js'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'
import { citationIndicatesRetraction } from './retractions.js'
import { verify, normalize, extractNumbers, numbersEqual } from './verify.js'
import { selectEvidenceWindow } from './evidenceWindow.js'
import { HANDOFF_VERSION } from './resultHandoff.js'
import {
  profileTopics,
  normalizeSearchDays,
  normalizeTopicCap,
  overfetchFor,
  mergeTopicResultsForScoring,
  attachTopics,
  mappedNorthStars,
} from './topics.js'

// Public identifiers only — the app re-verifies every value live (docs/FACTS.md).
export const DEMO_PAPERS = [
  {
    id: 'BASIL-3',
    title: 'BASIL-3 (BMJ 2024) — CLTI, endovascular vs surgery',
    pmid: '39993822',
    pmcid: 'PMC11848676',
    nct: null,
    expect: 'verified-full-text',
    headline: 'HR 0.84 (97.5% CI 0.61–1.16, P=0.22)',
  },
  {
    id: 'STARDUST',
    title: 'STARDUST (JAMA Netw Open 2024) — PAD',
    pmid: '38470420',
    pmcid: 'PMC10933706',
    nct: 'NCT04881110',
    expect: 'verified-registry',
    headline: 'TcPO2 diff 11.2 mmHg (95% CI 8.0–14.5, P<0.001)',
  },
  {
    id: 'ACST-2',
    title: 'ACST-2 (Lancet 2021) — carotid CAS vs CEA',
    pmid: '34469763',
    pmcid: 'PMC8473558',
    nct: null,
    expect: 'verified-full-text',
    headline: 'RR 1.16 (95% CI 0.86–1.57, p=0.33)',
  },
]

// Fetch the best available source for a paper. Prefers PMC OA full text (resolving the
// PMCID live when not supplied), and falls back to the ABSTRACT for the large majority of
// papers that aren't open-access. Verifying against the abstract is the point: it lets the
// digest cover all of today's literature, not just the OA subset — the DOI/PMID link is
// the reader's path to the full text. Never throws past the flag.
export async function fetchSource(paper) {
  let pmcid = paper.pmcid
  if (!pmcid && paper.pmid) {
    try {
      pmcid = await pmidToPmcid(paper.pmid)
    } catch {
      /* no OA mapping — abstract it is */
    }
  }
  if (pmcid) {
    try {
      const full = await fetchPmcFullText(pmcid)
      if (full.hasBody) return { ...full, pmcid }
    } catch (err) {
      console.warn(`PMC full text failed for ${paper.id}:`, err.message)
    }
  }
  const abstract = await fetchAbstracts(paper.pmid)
  // pmcid may still be set (OA record with no parseable body) — keep it for the PDF link.
  return { hasBody: false, text: abstract, tables: '', tier: 'abstract_only', pmcid: pmcid || null }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Wide candidate search for the selection funnel — now ONE PubMed query PER TOPIC, each
// capped on its own take, over a window short enough that "today's papers" means it
// (see topics.js for why the old one-OR-query-over-90-days shape was three broken promises).
//
// Four properties this function is responsible for:
//   - SEQUENTIAL, paced. N searches where there used to be one; eutils asks for sequential
//     requests inside its rate limit, so we wait `searchPaceMs()` between calls rather than
//     firing them in parallel and hoping the retry catches the 429.
//   - PARTIAL FAILURE IS NOT TOTAL FAILURE. One topic's query blowing up must not cost her
//     the other nine topics' digest — the error is captured per topic and reported back in
//     `failed`, never thrown and never swallowed.
//   - THE CAP COUNTS UNSEEN PAPERS. `skipIds` (her seen-ledger ∪ her library) is applied
//     per topic BEFORE the cap, so each topic yields ten papers she has never been offered
//     rather than ten search hits that might be mostly repeats. That's why we over-fetch
//     ids: esearch returns bare ids and is free, so we ask for `overfetchFor(cap, days)` —
//     which scales with the window, since a wider one is proportionally more repeats — and
//     throw most of them away.
//   - BOUNDED PRE-SCORE POOL. PubMed retmax bounds each topic, the seen filter removes free
//     repeats first, then citation metadata and abstracts are scored before the topic cap.
//     Relevance—not newest-N—therefore decides which papers survive into the funnel.
//
// Returns { candidates, counts, failed, skipped, days }: the honest account of what was
// searched, what the cap held back, and how much was dropped as already-seen — which is
// what lets the empty state tell "a quiet field" apart from "you're up to date".
export async function searchCandidates({
  topics,
  northStars = [],
  perTopic,
  days,
  paceMs,
  skipIds,
} = {}) {
  const plan = profileTopics({ topics, northStars })
  // Resolve stored mappings against the live north-star list before any candidate reaches
  // a scorer. A deleted star becomes explicitly unmapped rather than remaining active as
  // stale profile text.
  const steeringPlan = plan.map((topic) => ({ ...topic, northStars: mappedNorthStars(topic, northStars) }))
  const windowDays = normalizeSearchDays(days)
  const cap = normalizeTopicCap(perTopic)
  const retmax = overfetchFor(cap, windowDays)
  const gap = Number.isFinite(Number(paceMs)) ? Number(paceMs) : searchPaceMs()

  const searched = []
  for (let i = 0; i < plan.length; i++) {
    if (i > 0 && gap > 0) await sleep(gap)
    const topic = plan[i]
    try {
      // Compiled [tiab] phrases, not the raw OR string. Untagged text is what let PubMed
      // split concepts and explode MeSH into other specialties.
      const pmids = await searchPubmed(compilePubmedQuery(topic.query), { retmax, days: windowDays })
      searched.push({ label: topic.label, query: topic.query, pmids, retmax })
    } catch (err) {
      console.warn(`PubMed search failed for topic "${topic.label}":`, err.message)
      searched.push({ label: topic.label, error: err.message })
    }
  }

  const union = []
  const seenPmid = new Set()
  for (const row of searched) {
    for (const id of row.pmids || []) {
      const pmid = String(id)
      if (!pmid || seenPmid.has(pmid)) continue
      seenPmid.add(pmid)
      union.push(pmid)
    }
  }
  // Titles and abstracts are the relevance gate. A missing abstract is not evidence against
  // a specific term: the paper stays and scoring decides. A broad title-only word can still
  // be rejected from the title alone.
  const cites = union.length ? await fetchCitations(union) : []
  const abstracts = union.length ? await fetchAbstractsByPmid(union).catch(() => ({})) : {}
  const citeById = new Map(cites.map((cite) => [String(cite.pmid), cite]))

  const results = searched.map((row) => {
    if (row.error) return { label: row.label, error: row.error }
    const kept = []
    for (const id of row.pmids || []) {
      const cite = citeById.get(String(id))
      // Retracted Publication is authoritative and available before any scoring. Withdrawn
      // papers never enter the funnel, and neither do hits that are not about this topic.
      if (!cite || citationIndicatesRetraction(cite)) continue
      if (!fitsTopic({
        title: cite.title,
        abstract: abstracts?.[cite.pmid] || '',
        query: row.query,
        label: row.label,
      })) continue
      kept.push(String(id))
    }
    // `fetched` is the raw esearch page, so a full page of mostly off-topic hits still
    // reports that PubMed had more. `pmids` is what relevance kept.
    return { label: row.label, pmids: kept, retmax: row.retmax, fetched: (row.pmids || []).length }
  })

  const { pmids, topicsByPmid, counts, failed, skipped } = mergeTopicResultsForScoring(results, { skipIds })
  if (!pmids.length) return { candidates: [], counts, failed, skipped, days: windowDays, cap }

  const candidates = attachTopics(
    pmids.map((id) => citeById.get(String(id))).filter(Boolean).map((c) => {
      const abstract = abstracts?.[c.pmid] || ''
      return {
        id: c.pmid,
        pmid: c.pmid,
        pmcid: null,
        nct: null,
        title: c.title,
        journal: c.journal,
        year: c.year,
        author: c.author,
        pubtypes: c.pubtypes,
        ...(abstract ? { abstract } : {}),
      }
    }),
    topicsByPmid,
    steeringPlan,
  )
  return { candidates, counts, failed, skipped, days: windowDays, cap }
}

// Run the full pipeline on one paper. Returns:
//   { paper, design, source: {tier, hasBody}, rows: [{ quantity, verdict }], error? }
//
// Options:
//   onStage    progress callback (id, stage)
//   userText   { text, hash, fileName } — the reader supplied the source (an uploaded PDF).
//              Replaces the PMC/abstract fetch; verdicts land on the user-text tier.
//   cacheOnly  never call the model: use a cached extraction or return an error result.
//              Used by library seeding so a new account costs nothing to populate.
export async function runPaper(paper, { onStage, userText = null, cacheOnly = false } = {}) {
  const notify = (stage) => onStage?.(paper.id, stage)
  // Fetch citation independently of the source so a failed source fetch still leaves us
  // the citation (title, link) to show — a graceful degrade, not a bare error.
  const citation = await fetchCitation(paper.pmid).catch(() => ({
    pmid: paper.pmid,
    url: `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`,
    verified: false,
  }))

  // Covers stale/restored candidate pools whose status changed after the original scan.
  // The caller treats an error result as excluded from triage and the completed digest.
  if (citationIndicatesRetraction(citation)) {
    notify('error')
    return {
      paper,
      citation,
      design: null,
      source: null,
      rows: [],
      error: 'Retracted publication — excluded from digest.',
      retracted: true,
    }
  }

  try {
    notify('fetching')
    const source = userText?.text
      ? { hasBody: true, text: userText.text, tables: '', tier: 'user_text', pmcid: null }
      : await fetchSource(paper)

    // Registry outcomes (drive verified-registry). Parse the LIVE CT.gov posted analyses
    // into value+CI rows; fall back to the locked map only when parsing yields nothing
    // (network flake / no analyses). verify() upgrades a quantity that triple-matches ANY row.
    let registry = null
    if (paper.nct) {
      try {
        const reg = await fetchRegistry(paper.nct)
        const parsed = parseRegistryOutcomes(reg.outcomeMeasures)
        registry = parsed.length ? parsed : reg.posted ? [reg.posted] : null
      } catch (err) {
        console.warn(`CT.gov failed for ${paper.nct}:`, err.message)
        const fallback = REGISTRY_OUTCOME_MAP[paper.nct]
        registry = fallback ? [fallback] : null
      }
    }

    notify('extracting')
    // One shared assembly (sources.js): publisher abstract (when available) + body prose +
    // flattened tables. The model, the verifier and the stored sourceDoc all use exactly this
    // corpus. `source.text` stays body-only for the ranking evidence window below.
    const assembled = assembleExtractionSource(source)
    const sourceText = assembled.modelText
    // The cache is keyed by the exact text the model would read. A hit replays that
    // proposal; verification below runs on it regardless, in this session.
    const sourceHash = await sha256Hex(sourceText)
    const cacheKey = cacheKeyHeader({ pmid: paper.pmid, hash: sourceHash, tier: source.tier })
    let extracted = null
    let cache = 'none'
    const cached = await lookupCachedExtraction({ pmid: paper.pmid, hash: sourceHash })
    if (cached?.extraction) {
      extracted = cached.extraction
      cache = 'hit'
    } else if (cacheOnly) {
      throw new Error('Not in the shared evidence cache yet.')
    } else {
      extracted = await extractQuantities({ studyId: paper.id, sourceText, cacheKey })
      cache = 'miss'
      // Browser: a no-op (the sponsored proxy stored it). Server: write it for the next reader.
      await storeCachedExtraction({ pmid: paper.pmid, hash: sourceHash, tier: source.tier, extraction: extracted, model: MODELS.extraction, citation })
    }

    notify('verifying')
    const rows = extracted.quantities.map(dropUnprovenLabels).map((quantity) => ({
      quantity,
      verdict: verify(quantity, { text: assembled.corpusText, tables: assembled.tables }, {
        sourceTier: source.tier,
        registry,
      }),
    }))

    notify('done')
    return {
      paper,
      citation,
      design: extracted.design,
      extractionVersion: CURRENT_EXTRACTION_VERSION,
      source: {
        tier: source.tier,
        hasBody: source.hasBody,
        pmcid: source.pmcid || null,
        hash: sourceHash,
        ...(userText ? { userSupplied: true, fileName: userText.fileName || null, fileHash: userText.hash || null } : {}),
      },
      // Same corpus the model read and the verifier checked (abstract block + body, tables
      // separate), kept for corrupt-reverify, rechecks and the source viewer.
      sourceDoc: { text: assembled.corpusText, tables: assembled.tables },
      sourceCoverage: assembled.coverage,
      // The bounded ranking/prose-check window, chosen from the source's structure. Ranking
      // input only — sourceDoc above stays the complete verification corpus.
      evidenceWindow: selectEvidenceWindow(source),
      // The complete section tree and abstract parts, so the summary path can build its
      // complete evidence passages (evidencePassages.js) without a refetch.
      evidenceSource: {
        tier: source.tier,
        abstractParts: Array.isArray(source.abstractParts) ? source.abstractParts : [],
        abstract: source.abstract || '',
        sections: Array.isArray(source.sections) ? source.sections : [],
      },
      rows,
      resultContract: HANDOFF_VERSION,
      resultContexts: Array.isArray(extracted.result_contexts) ? extracted.result_contexts : [],
      cache,
    }
  } catch (err) {
    notify('error')
    return { paper, citation, design: null, source: null, rows: [], error: err.message, errorObject: err }
  }
}

// The corrupted-value oracle case. Takes a real, verified row from a run and mutates the
// value by a digit, then re-verifies to prove the gate flags it. Returns null if the run
// has no clean verified row to corrupt.
export function corruptAndReverify(paperResult, sourceForReverify) {
  const clean = paperResult.rows.find((r) => !r.verdict.flagged && r.quantity.value != null)
  if (!clean) return null
  // The corrupted value must not collide with ANY real number in the quote (or the row's
  // own CI/p fields) — a blind +0.1 routinely lands on a CI bound (0.7 -> 0.8 inside
  // "0.7 (95% CI 0.5-0.8)"), which re-verifies green and defeats the whole demonstration.
  const quoteNums = extractNumbers(normalize(clean.quantity.source_quote || ''))
  const taken = [clean.quantity.ci_low, clean.quantity.ci_high, clean.quantity.p_value, ...quoteNums]
    .filter((n) => n != null)
  let corruptedValue = Number((clean.quantity.value * 1.7 + 0.13).toFixed(6)) // fallback, never expected
  for (let k = 1; k <= 50; k++) {
    const candidate = Number((clean.quantity.value + 0.1 * k).toFixed(6))
    if (!taken.some((n) => numbersEqual(n, candidate))) {
      corruptedValue = candidate
      break
    }
  }
  const corrupted = { ...clean.quantity, value: corruptedValue }
  return {
    quantity: corrupted,
    original: clean.quantity.value,
    verdict: verify(corrupted, sourceForReverify, { sourceTier: paperResult.source.tier }),
  }
}
