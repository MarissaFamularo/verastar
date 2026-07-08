// pipeline/sources.js — data fetchers. Every endpoint here is CORS-open (sends
// Access-Control-Allow-Origin: *), so the browser calls them directly — no proxy, no
// backend. Contracts are locked in docs/FACTS.md; trust these shapes over any prior.
//
// Worst case is always a flag, never a throw that kills the pipeline: callers get a
// structured result with whatever could be fetched and a `tier` hint for verify.

import { getNcbiKey } from '../lib/anthropic.js'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const IDCONV = 'https://www.ncbi.nlm.nih.gov/pmc/tools/idconv/api/v1/articles'
const CROSSREF = 'https://api.crossref.org/works'
const CTGOV = 'https://clinicaltrials.gov/api/v2/studies'

// The one CT.gov -> posted-outcome row the registry tier needs (docs/FACTS.md).
export const REGISTRY_OUTCOME_MAP = {
  NCT04881110: { measure: 'Peripheral Transcutaneous Oxygen Pressure', value: 11.2, ci_low: 8.0, ci_high: 14.5 },
}

// Append the optional free NCBI key (raises eutils 3 -> 10 req/s) when present.
function withKey(url) {
  const key = getNcbiKey()
  return key ? `${url}&api_key=${encodeURIComponent(key)}` : url
}

// Retry with backoff. NCBI eutils rate-limits at 3 req/s without an API key, and a burst
// of scan requests occasionally trips it (400/429/5xx) — a short retry clears it.
async function withRetry(fn, { attempts = 3, delayMs = 500 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)))
    }
  }
  throw lastErr
}

async function getText(url) {
  return withRetry(async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return res.text()
  })
}

async function getJson(url) {
  return withRetry(async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return res.json()
  })
}

// --- PubMed ------------------------------------------------------------------

// Search PubMed, return an array of PMIDs (strings). `days` restricts to recently
// published papers (reldate on publication date), sorted newest-first.
export async function searchPubmed(term, { retmax = 20, days } = {}) {
  let url = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=date&retmax=${retmax}&term=${encodeURIComponent(term)}`
  if (days) url += `&reldate=${days}&datetype=pdat`
  const data = await getJson(withKey(url))
  return data?.esearchresult?.idlist ?? []
}

// Fetch abstract text for one or more PMIDs (plain text rettype=abstract).
export async function fetchAbstracts(pmids) {
  const ids = Array.isArray(pmids) ? pmids.join(',') : String(pmids)
  const url = withKey(`${EUTILS}/efetch.fcgi?db=pubmed&id=${ids}&rettype=abstract&retmode=text`)
  return getText(url)
}

// Fetch citation metadata for a PMID via esummary. The mere fact that PubMed returns a
// record IS the "citation is real, not hallucinated" check — the single most common AI
// digest failure. Returns { author, year, journal, pmid, url, doi, verified }.
export async function fetchCitation(pmid) {
  const url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
  try {
    const data = await getJson(
      withKey(`${EUTILS}/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`),
    )
    const rec = data?.result?.[String(pmid)]
    if (!rec || rec.error || !rec.title) {
      return { pmid, url, verified: false }
    }
    const authors = rec.authors || []
    const first = authors[0]?.name || ''
    const author = authors.length > 1 ? `${first} et al.` : first
    const year = (rec.pubdate || '').split(' ')[0] || ''
    const journal = rec.source || rec.fulljournalname || ''
    const doiMatch = (rec.elocationid || '').match(/10\.\S+/)
    return { pmid, url, author, year, journal, title: rec.title || '', doi: doiMatch ? doiMatch[0] : null, verified: true }
  } catch {
    // Network hiccup — we can't confirm the citation, so we don't claim it's verified.
    return { pmid, url, verified: false }
  }
}

// Batched citation metadata for many PMIDs in ONE esummary call — the cheap fuel for the
// selection funnel (title · journal · year · publication types) before any LLM extraction.
// Returns [{ pmid, title, journal, year, author, pubtypes, url }] in the requested order,
// skipping ids PubMed couldn't resolve. Never throws past an empty array.
export async function fetchCitations(pmids) {
  const ids = (Array.isArray(pmids) ? pmids : [pmids]).map(String)
  if (!ids.length) return []
  try {
    const data = await getJson(
      withKey(`${EUTILS}/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`),
    )
    const result = data?.result || {}
    return ids
      .map((pmid) => {
        const rec = result[pmid]
        if (!rec || rec.error || !rec.title) return null
        const authors = rec.authors || []
        const first = authors[0]?.name || ''
        const author = authors.length > 1 ? `${first} et al.` : first
        return {
          pmid,
          url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
          title: rec.title || '',
          journal: rec.source || rec.fulljournalname || '',
          year: (rec.pubdate || '').split(' ')[0] || '',
          author,
          pubtypes: Array.isArray(rec.pubtype) ? rec.pubtype : [],
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

// PMID -> PMCID via idconv. Returns e.g. "PMC11848676" or null (not in OA).
export async function pmidToPmcid(pmid) {
  const url = `${IDCONV}/?ids=${encodeURIComponent(pmid)}&format=json`
  const data = await getJson(url)
  const rec = data?.records?.[0]
  return rec?.pmcid ?? null
}

// --- PMC full text -----------------------------------------------------------

// Strip an XML/HTML node to plain text.
function nodeText(node) {
  return (node?.textContent || '').replace(/\s+/g, ' ').trim()
}

// Flatten a JATS <table-wrap> WITH cell separators. textContent alone concatenates
// adjacent cells ("...1·0%)0·77"), which merges neighbouring numbers and makes the
// verifier false-flag values at cell boundaries. Joining cells with " | " and rows with
// newlines keeps every number boundary-delimited. Falls back to raw text if there are no
// rows to walk.
function flattenTable(tableWrap) {
  const rows = Array.from(tableWrap.querySelectorAll('tr'))
  if (rows.length === 0) return nodeText(tableWrap)
  const label = nodeText(tableWrap.querySelector('label, caption'))
  const body = rows
    .map((tr) =>
      Array.from(tr.querySelectorAll('th, td'))
        .map(nodeText)
        .filter(Boolean)
        .join(' | '),
    )
    .filter(Boolean)
    .join('\n')
  return label ? `${label}\n${body}` : body
}

// Fetch and parse a PMC OA full-text record. Returns:
//   { hasBody, text, tables, tier }
// where `text` is body prose (table content removed), `tables` is flattened <table-wrap>
// cell text, and `tier` is 'full_text' when a <body> exists, else 'abstract_only'.
// No <body> => not in the OA subset => the caller should fall back to the abstract.
export async function fetchPmcFullText(pmcid) {
  const numeric = String(pmcid).replace(/^PMC/i, '')
  const url = withKey(`${EUTILS}/efetch.fcgi?db=pmc&id=${numeric}&rettype=xml&retmode=xml`)
  const xml = await getText(url)
  const doc = new DOMParser().parseFromString(xml, 'text/xml')

  const body = doc.querySelector('body')
  if (!body) {
    return { hasBody: false, text: '', tables: '', tier: 'abstract_only' }
  }

  // Flatten every table (with cell separators) before we strip them out of the prose.
  const tableNodes = Array.from(body.querySelectorAll('table-wrap'))
  const tables = tableNodes.map(flattenTable).join('\n\n')

  // Prose = body with table-wraps removed, so verify's table/prose corpora stay clean.
  const clone = body.cloneNode(true)
  clone.querySelectorAll('table-wrap').forEach((n) => n.remove())
  const text = nodeText(clone)

  return { hasBody: true, text, tables, tier: 'full_text' }
}

// --- Live swing: DOI -> PMID, with CrossRef fallback -------------------------

// Resolve a DOI to a PMID via PubMed's [AID] field. null if not in PubMed.
export async function doiToPmid(doi) {
  const url = withKey(`${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&term=${encodeURIComponent(doi)}[AID]`)
  const data = await getJson(url)
  return data?.esearchresult?.idlist?.[0] ?? null
}

// CrossRef fallback for a DOI not in PubMed: metadata + abstract (JATS). Abstract-only
// tier. Strips JATS tags from the abstract if present.
export async function fetchCrossref(doi) {
  const data = await getJson(`${CROSSREF}/${encodeURIComponent(doi)}`)
  const msg = data?.message ?? {}
  const rawAbstract = msg.abstract || ''
  const abstract = rawAbstract.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return {
    title: Array.isArray(msg.title) ? msg.title[0] : msg.title || '',
    abstract,
    doi,
    tier: 'abstract_only',
  }
}

// --- ClinicalTrials.gov ------------------------------------------------------

// Fetch a trial's results outcome data. Returns { hasResults, outcomeMeasures, posted }
// where `posted` is the locked map row when we know it (drives verified-registry).
export async function fetchRegistry(nct) {
  const fields = 'hasResults,resultsSection.outcomeMeasuresModule'
  const url = `${CTGOV}/${encodeURIComponent(nct)}?fields=${encodeURIComponent(fields)}`
  const data = await getJson(url)
  const hasResults = !!data?.hasResults
  const outcomeMeasures = data?.resultsSection?.outcomeMeasuresModule?.outcomeMeasures ?? []
  return { hasResults, outcomeMeasures, posted: REGISTRY_OUTCOME_MAP[nct] ?? null }
}

// Convenience: the registry-posted numeric value for a trial, or null.
export function registryValue(nct) {
  return REGISTRY_OUTCOME_MAP[nct]?.value ?? null
}
