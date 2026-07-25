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
  fetchAbstracts,
  fetchRegistry,
  parseRegistryOutcomes,
  REGISTRY_OUTCOME_MAP,
  fetchCitation,
  fetchCitations,
  pmidToPmcid,
  searchPubmed,
  searchPaceMs,
} from './sources.js'
import { extractQuantities } from './extract.js'
import { verify, normalize, extractNumbers, numbersEqual } from './verify.js'
import {
  profileTopics,
  normalizeSearchDays,
  normalizeTopicCap,
  overfetchFor,
  mergeTopicResults,
  attachTopics,
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
//     ids: esearch returns bare ids and is free, so we ask for `overfetchFor(cap)` and throw
//     most of them away.
//   - ONE metadata call, over the SURVIVORS. The esummary fetch happens after the skip and
//     the cap, so filtering earlier makes the batched call smaller, not bigger.
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
  const windowDays = normalizeSearchDays(days)
  const cap = normalizeTopicCap(perTopic)
  const retmax = overfetchFor(cap)
  const gap = Number.isFinite(Number(paceMs)) ? Number(paceMs) : searchPaceMs()

  const results = []
  for (let i = 0; i < plan.length; i++) {
    if (i > 0 && gap > 0) await sleep(gap)
    const topic = plan[i]
    try {
      const pmids = await searchPubmed(topic.query, { retmax, days: windowDays })
      // retmax rides along so the merge can tell "40 papers exist" from "at least 40 do".
      results.push({ label: topic.label, pmids, retmax })
    } catch (err) {
      console.warn(`PubMed search failed for topic "${topic.label}":`, err.message)
      results.push({ label: topic.label, error: err.message })
    }
  }

  const { pmids, topicsByPmid, counts, failed, skipped } = mergeTopicResults(results, { cap, skipIds })
  if (!pmids.length) return { candidates: [], counts, failed, skipped, days: windowDays }

  const cites = await fetchCitations(pmids)
  const candidates = attachTopics(
    cites.map((c) => ({
      id: c.pmid,
      pmid: c.pmid,
      pmcid: null,
      nct: null,
      title: c.title,
      journal: c.journal,
      year: c.year,
      author: c.author,
      pubtypes: c.pubtypes,
    })),
    topicsByPmid,
  )
  return { candidates, counts, failed, skipped, days: windowDays }
}

// Run the full pipeline on one paper. Returns:
//   { paper, design, source: {tier, hasBody}, rows: [{ quantity, verdict }], error? }
export async function runPaper(paper, { onStage } = {}) {
  const notify = (stage) => onStage?.(paper.id, stage)
  // Fetch citation independently of the source so a failed source fetch still leaves us
  // the citation (title, link) to show — a graceful degrade, not a bare error.
  const citation = await fetchCitation(paper.pmid).catch(() => ({
    pmid: paper.pmid,
    url: `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`,
    verified: false,
  }))

  try {
    notify('fetching')
    const source = await fetchSource(paper)

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
    // The model sees prose + flattened tables so it can cite table values.
    const sourceText = source.tables ? `${source.text}\n\nTABLES:\n${source.tables}` : source.text
    const extracted = await extractQuantities({ studyId: paper.id, sourceText })

    notify('verifying')
    const rows = extracted.quantities.map((quantity) => ({
      quantity,
      verdict: verify(quantity, { text: source.text, tables: source.tables }, {
        sourceTier: source.tier,
        registry,
      }),
    }))

    notify('done')
    return {
      paper,
      citation,
      design: extracted.design,
      source: { tier: source.tier, hasBody: source.hasBody, pmcid: source.pmcid || null },
      sourceDoc: { text: source.text, tables: source.tables }, // kept for corrupt-reverify
      rows,
    }
  } catch (err) {
    notify('error')
    return { paper, citation, design: null, source: null, rows: [], error: err.message }
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
