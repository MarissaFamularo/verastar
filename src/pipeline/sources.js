// pipeline/sources.js — data fetchers. Every endpoint here is CORS-open (sends
// Access-Control-Allow-Origin: *), so the browser calls them directly — no proxy, no
// backend. Contracts are locked in docs/FACTS.md; trust these shapes over any prior.
//
// Worst case is always a flag, never a throw that kills the pipeline: callers get a
// structured result with whatever could be fetched and a `tier` hint for verify.

import { getNcbiKey, getNcbiEmail } from '../lib/anthropic.js'

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
const IDCONV = 'https://www.ncbi.nlm.nih.gov/pmc/tools/idconv/api/v1/articles'
const CROSSREF = 'https://api.crossref.org/works'
const CTGOV = 'https://clinicaltrials.gov/api/v2/studies'

// The one CT.gov -> posted-outcome row the registry tier needs (docs/FACTS.md).
export const REGISTRY_OUTCOME_MAP = {
  NCT04881110: { measure: 'Peripheral Transcutaneous Oxygen Pressure', value: 11.2, ci_low: 8.0, ci_high: 14.5 },
}

// Append NCBI etiquette params to eutils calls: tool always, plus the optional email
// (their contact-before-block channel) and API key (raises 3 -> 10 req/s) when present.
function withKey(url) {
  let out = `${url}&tool=verastar`
  const email = getNcbiEmail()
  if (email) out += `&email=${encodeURIComponent(email)}`
  const key = getNcbiKey()
  if (key) out += `&api_key=${encodeURIComponent(key)}`
  return out
}

// How long a caller making BACK-TO-BACK eutils calls should wait between them. The daily
// scan searches one query per topic, so what used to be a single request is now ten — well
// inside NCBI's 3 req/s unkeyed limit only if it paces itself. 350ms keeps a keyless run
// under 3/s with margin (the retry above is the safety net, not the plan); an API key raises
// the ceiling to 10/s, so 120ms is polite there. Etiquette is why this is a gap and not a
// parallel fan-out: eutils asks for sequential requests, not bursts.
export function searchPaceMs() {
  return getNcbiKey() ? 120 : 350
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

// Which date `days` counts back from. DO NOT change this to 'pdat' — it is deliberate, and
// it is what her hand-run morning routine has always done.
//
// For a daily driver, "new" means new TO PUBMED, not "carries a recent publication date".
// `edat` is the Entrez date: the day the record appeared in PubMed. `pdat` is the
// publication date the journal stamped on it. Those come apart constantly in her fields —
// ahead-of-print and delayed-indexing records land in PubMed today carrying last month's
// publication date. Under `pdat` with a 3-day window such a paper is invisible on the day it
// arrives AND on every subsequent day, because its publication date only ever gets older.
// It is never surfaced, by any run, ever. That is precisely the silent permanent miss the
// tight window and the seen-ledger exist to prevent, so the window counts from `edat`.
export const DEFAULT_DATETYPE = 'edat'

// Search PubMed, return an array of PMIDs (strings). `days` restricts to records that
// entered PubMed in that window (see DEFAULT_DATETYPE), sorted newest-first. `datetype` is
// an explicit option so a caller that genuinely wants publication dates has to say so.
export async function searchPubmed(term, { retmax = 20, days, datetype = DEFAULT_DATETYPE } = {}) {
  let url = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=date&retmax=${retmax}&term=${encodeURIComponent(term)}`
  if (days) url += `&reldate=${days}&datetype=${encodeURIComponent(datetype)}`
  const data = await getJson(withKey(url))
  return data?.esearchresult?.idlist ?? []
}

// A PubMed plain-text record is mostly NOT the abstract. It opens with a numbered citation
// line, then the title, then the author list, then an "Author information:" block of
// affiliations — and on a multi-centre paper that preamble runs past 1,300 characters
// before the first word of science. Everything downstream reads a fixed-size window off
// the FRONT of this text, so on those papers the window was the preamble: the digest's
// summaries and the adversarial gate that audits them were both being handed author
// addresses instead of results. Measured on two of her 2026-07-29 papers: the abstract
// body started at 1,378 and 811 chars, RESULTS at 2,101 and 2,007 — the 900-char window
// reached neither.
//
// So: keep the title, the abstract body and its keywords; drop the citation line, the
// authors, the affiliations, and the trailing copyright/DOI/PMID/comment blocks. Records
// are blank-line separated, which also makes this correct for a multi-PMID fetch.
const TRAILER_BLOCK =
  /^(©|copyright\b|doi:|pmid:|pmcid:|conflict of interest|declaration of|comment (in|on)\b|erratum (in|for)\b|update (in|of)\b|republished (in|from)\b|expression of concern\b|publisher:)/i
const AUTHOR_INFO_BLOCK = /^(author information:|collaborators:|corresponding author:|contributed equally)/i

// "Jahan S(1), Awad A(2), … Alraies MC(10)." — surname(s) then initials, optionally with
// affiliation markers. Requires a clear majority of comma-separated segments to fit that
// shape, so a title with commas and ordinary abstract prose can never trip it.
function isAuthorList(block) {
  const segments = block.split(/,\s*/).map((s) => s.trim()).filter(Boolean)
  if (segments.length < 2) return false
  const namelike = segments.filter((s) =>
    /^[A-ZÀ-Þ][\p{L}'’-]+(?:[ -][\p{L}'’-]+)*\s+[A-Z]{1,4}(?:\(\d+\))*\.?$/u.test(s),
  )
  return namelike.length >= Math.ceil(segments.length * 0.6)
}

export function cleanAbstractText(raw) {
  const text = String(raw ?? '')
  if (!text.trim()) return text
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)
  const drop = blocks.map(() => false)

  blocks.forEach((block, i) => {
    const flat = block.replace(/\s+/g, ' ').trim()
    // The citation line: "1. Ann Vasc Surg. 2026 Jul 27:S0890-… doi: …". Numbered, and
    // carrying a year or a DOI — a bare numbered line inside an abstract stays.
    if (/^\d+\.\s/.test(flat) && (/doi:/i.test(flat) || /\b(19|20)\d{2}\b/.test(flat))) drop[i] = true
    if (TRAILER_BLOCK.test(flat)) drop[i] = true
    if (AUTHOR_INFO_BLOCK.test(flat)) {
      drop[i] = true
      // The author list sits directly above its affiliations.
      const prev = i - 1
      if (prev >= 0 && !drop[prev] && isAuthorList(blocks[prev].replace(/\s+/g, ' ').trim())) drop[prev] = true
    } else if (isAuthorList(flat)) {
      drop[i] = true
    }
  })

  const kept = blocks.filter((_, i) => !drop[i]).join('\n\n')
  // An unfamiliar record shape must degrade to today's behaviour, never to an empty
  // source — `text` is also the verifier's grounding corpus, so over-stripping would
  // flag every number rather than merely summarize badly.
  if (kept.trim().length < 120 && text.trim().length >= 400) return text
  return kept || text
}

// Fetch abstract text for one or more PMIDs (plain text rettype=abstract), stripped of
// PubMed's citation/author/affiliation preamble — see cleanAbstractText.
export async function fetchAbstracts(pmids) {
  const ids = Array.isArray(pmids) ? pmids.join(',') : String(pmids)
  const url = withKey(`${EUTILS}/efetch.fcgi?db=pubmed&id=${ids}&rettype=abstract&retmode=text`)
  return cleanAbstractText(await getText(url))
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

// Resolve a user-pasted identifier — a bare PMID, a DOI (bare or doi.org URL), or a PubMed/PMC URL
// (or PMCID) — to a PMID string. Returns null if it can't be tied to a PubMed record. The "Add a
// paper" entry point uses this so the clinician can paste whatever they're looking at. Parsing is
// pure; PMCID/DOI resolution hits the network.
export async function resolvePmid(input) {
  const raw = (input || '').trim()
  if (!raw) return null
  // A bare PMID.
  if (/^\d+$/.test(raw)) return raw
  // A PubMed URL → /<digits>.
  const pubmed = raw.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i)
  if (pubmed) return pubmed[1]
  // A PMCID or PMC URL → convert via idconv (records carry both ids).
  const pmc = raw.match(/PMC\d+/i)
  if (pmc) {
    try {
      const data = await getJson(`${IDCONV}/?ids=${encodeURIComponent(pmc[0].toUpperCase())}&format=json`)
      return data?.records?.[0]?.pmid ?? null
    } catch {
      return null
    }
  }
  // A DOI (bare or inside a doi.org URL) → PubMed [AID] lookup.
  const doi = raw.match(/10\.\d{4,9}\/\S+/)
  if (doi) {
    try {
      return await doiToPmid(doi[0].replace(/[).,;]+$/, ''))
    } catch {
      return null
    }
  }
  return null
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
// where `posted` is the locked map row, used only as a fallback when live parsing yields
// nothing (network flake / no analyses). The live rows drive verified-registry.
export async function fetchRegistry(nct) {
  const fields = 'hasResults,resultsSection.outcomeMeasuresModule'
  const url = `${CTGOV}/${encodeURIComponent(nct)}?fields=${encodeURIComponent(fields)}`
  const data = await getJson(url)
  const hasResults = !!data?.hasResults
  const outcomeMeasures = data?.resultsSection?.outcomeMeasuresModule?.outcomeMeasures ?? []
  return { hasResults, outcomeMeasures, posted: REGISTRY_OUTCOME_MAP[nct] ?? null }
}

// Coerce a CT.gov string field ("11.2", "8.0", "-0.4") to a finite number, or null. CT.gov
// posts numbers as strings; non-numeric forms ("<0.001", "", null) collapse to null.
function toNum(x) {
  if (x == null) return null
  const n = typeof x === 'number' ? x : parseFloat(String(x))
  return Number.isFinite(n) ? n : null
}

// Parse the LIVE CT.gov v2 outcomeMeasures array into candidate registry rows the verifier
// can value+CI match against: { measure, value, ci_low, ci_high }. The between-group result
// (e.g. STARDUST's 11.2, 95% CI 8.0–14.5) lives in each measure's `analyses[]` as
// paramValue / ciLowerLimit / ciUpperLimit. One measure can post several analyses (a mean
// difference AND a risk ratio), so this fans out to one row per analysis. Rows whose
// paramValue is non-numeric are skipped. PURE and defensive: never throws on malformed
// input — returns [] so a bad payload degrades to the locked-map fallback, never a crash.
export function parseRegistryOutcomes(outcomeMeasures) {
  try {
    if (!Array.isArray(outcomeMeasures)) return []
    const rows = []
    for (const om of outcomeMeasures) {
      if (!om || typeof om !== 'object') continue
      const measure = typeof om.title === 'string' ? om.title : ''
      const analyses = Array.isArray(om.analyses) ? om.analyses : []
      for (const a of analyses) {
        if (!a || typeof a !== 'object') continue
        const value = toNum(a.paramValue)
        if (value == null) continue // non-numeric estimate — nothing to match
        rows.push({ measure, value, ci_low: toNum(a.ciLowerLimit), ci_high: toNum(a.ciUpperLimit) })
      }
    }
    return rows
  } catch {
    return []
  }
}
