// pipeline/primaryResult.js — keep the PRIMARY result, the analysis population, and the
// hypothesis tested attached to every result the prose channel sees.
//
// The writer (triage) only receives VERIFIED values, which is the integrity rule and stays.
// But when the primary endpoint's numbers did not verify, the writer saw only secondary,
// subgroup, or non-randomized analyses and built the headline from them (2026-10-11 dev set:
// HF-14 headlined as-treated and per-protocol benefit over a null intention-to-treat primary;
// PAD-12, PAD-15, HF-02, AS-04, AS-01, PAD-05, CAR-10 led with secondary or subgroup results).
//
// This module is deterministic and pure. It never verifies anything and never marks an
// unverified result as verified; it only LABELS results (from their own name and verbatim
// quote) and decides when a finding must not carry numbers or must be withheld:
//   - tagResult: population (ITT / modified ITT / per-protocol / as-treated), hypothesis
//     (noninferiority / superiority / equivalence), subgroup, primary/secondary role.
//   - findPrimary: which extracted rows report the primary endpoint, and whether any of
//     them verified.
//   - primaryScopeVerdict: a deterministic refute when a finding's numbers come only from
//     per-protocol / as-treated analyses while the randomized primary is unverified or not
//     cited. Uncertainty resolves to withholding, the same bias as check.js.

import { normalize, extractNumbers, extractNumbersWithIndex, numbersEqual } from './verify.js'

const has = (re, s) => re.test(s)

export function tagResult(quantity) {
  const name = String(quantity?.name || '')
  const quote = String(quantity?.source_quote || '')
  const both = `${name} ${quote}`
  const population = has(/\bas[- ]treated\b/i, both)
    ? 'as-treated'
    : has(/\bper[- ]protocol\b/i, both)
      ? 'per-protocol'
      : has(/\bmodified intention[- ]to[- ]treat\b|\bmITT\b/i, both)
        ? 'modified ITT'
        : has(/\bintention[- ]to[- ]treat\b|\bITT\b/, both)
          ? 'ITT'
          : null
  const hypothesis = has(/\bnon-?inferiority\b/i, both)
    ? 'noninferiority'
    : has(/\bsuperiority\b/i, both)
      ? 'superiority'
      : has(/\bequivalence\b/i, both)
        ? 'equivalence'
        : null
  // Subgroup / cohort split, judged from the NAME only (the quote often names the whole trial).
  const subgroup = has(/\bsubgroups?\b|\bsubset\b|\bstrat(?:um|a)\b|\bin patients (?:with|without)\b|\bamong (?:patients|participants|those|women|men)\b|\b[\w-]+[- ]access cohort\b|\b(?:bicuspid|tricuspid)\b|\bin (?:a)?symptomatic patients\b/i, name)
  const secondary = has(/\bsecondary\b/i, name)
  const primary = !secondary && has(/\b(?:co-?)?primary\b/i, name)
  return { population, hypothesis, subgroup, primary, secondary }
}

const NON_RANDOMIZED = new Set(['as-treated', 'per-protocol'])
// A per-protocol analysis is a legitimate (often co-primary) analysis of a NONINFERIORITY
// test, so it is only treated as "not the randomized comparison" outside that setting.
const nonRandomized = (t) => NON_RANDOMIZED.has(t?.population) && !(t.population === 'per-protocol' && t.hypothesis === 'noninferiority')

// Human-readable tags for the writer's prompt. Words only — no digits, so the number guard's
// allowed set is unaffected.
export function describeTags(tags, { isPrimary = false } = {}) {
  const out = []
  if (isPrimary) out.push('PRIMARY')
  if (tags?.population && nonRandomized(tags)) out.push(`analysis: ${tags.population}, NOT the randomized intention-to-treat comparison`)
  else if (tags?.population) out.push(`analysis: ${tags.population}`)
  if (tags?.hypothesis) out.push(`${tags.hypothesis} test`)
  if (tags?.subgroup) out.push('subgroup')
  if (tags?.secondary) out.push('secondary')
  return out.map((t) => `[${t}]`).join(' ')
}

// Where a row's PRIMARY label comes from, strongest first. Extraction order is NOT one of
// them: the extraction prompt asks for the primary first, but nothing checks that it did,
// and a paper whose extracted rows are all secondary still has a row zero (REV2, gap 1).
const PRIMARY_WORD = /\b(?:co-?)?primary\b/i
const PRIMARY_IN_QUOTE = /\bprimary\s+(?:efficacy\s+|safety\s+|effectiveness\s+|composite\s+)?(?:end\s?-?points?|outcomes?|analysis|composite)\b/i
const PRIMARY_BASES = [
  ['name', (q) => PRIMARY_WORD.test(String(q?.name || ''))],
  ['quote', (q) => PRIMARY_IN_QUOTE.test(String(q?.source_quote || ''))],
  ['location', (q) => PRIMARY_WORD.test(String(q?.location_hint || ''))],
]

// The full text the verifier saw. Abstracts name the primary outcome in Methods and print
// the number in Results, so the row's own quote often never contains the word "primary".
export function verificationCorpus(result) {
  const doc = result?.sourceDoc
  if (typeof doc === 'string') return doc
  if (!doc || typeof doc !== 'object') return ''
  return [doc.text, doc.tables].filter(Boolean).join('\n')
}

const ROLE = '(?:efficacy\\s+|safety\\s+|effectiveness\\s+|composite\\s+)?(?:end\\s?-?points?|outcomes?|analys(?:is|es)|results?)'
const DECLARES_PRIMARY = new RegExp(`\\bprimary\\s+${ROLE}\\b`, 'i')
const DECLARES_SECONDARY = new RegExp(`\\bsecondary\\s+${ROLE}\\b`, 'i')
const PRIMARY_CLAUSE = new RegExp(`\\bprimary\\s+${ROLE}\\s+(?:were|was|included|comprised|:)\\s+([^.]{4,500})`, 'i')
const SECONDARY_CLAUSE = new RegExp(`\\bsecondary\\s+${ROLE}\\s+(?:were|was|included|comprised|:)\\s+([^.]{4,500})`, 'i')
const LEADING_ROLE = /^(?:the\s+)?(?:incidence|rate|risk|odds|hazard|occurrence|proportion)\s+of\s+/i
const TRAILING_CLAUSE = /\s+(?:at|after|during|following|within|between|compared|versus|vs\.?|assessed|measured|evaluated|using|defined)\s+/i
const QUALIFIER_BEFORE = '(?:central|branch|secondary|composite)'

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function abbreviationExpansions(text) {
  const map = new Map()
  const raw = String(text || '')
  for (const match of raw.matchAll(/\b([A-Za-z][^()]{2,80}?)\s*\(([A-Z][A-Z0-9]{1,10})\)/g)) {
    const phrase = match[1].replace(/\s+/g, ' ').trim()
    if (phrase && !map.has(match[2])) map.set(match[2], phrase)
  }
  return map
}

function outcomeNeedles(clause, expansions) {
  if (!clause) return []
  return clause.split(/,| and | or /i).flatMap((part) => {
    let phrase = part.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
    phrase = phrase.replace(/^(?:and|or)\s+/i, '')
    if (/^(?:assessed|measured|evaluated|using|defined|compared)\b/i.test(phrase)) return []
    const abbrevs = [...part.matchAll(/\(([A-Z][A-Z0-9]{1,10})\)/g)].map((m) => m[1])
    phrase = phrase.replace(LEADING_ROLE, '').split(TRAILING_CLAUSE)[0].replace(/^(?:the|a|an)\s+/i, '').trim()
    if (phrase.length < 3 && !abbrevs.length) return []
    return [{ phrase, abbrevs, expansions }]
  })
}

function phraseHit(raw, phrase) {
  const text = normalize(raw)
  const needle = normalize(phrase)
  if (!needle || needle.length < 3) return false
  if (needle.length <= 5) return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`).test(text)
  const qualified = new RegExp(`(?:^|[^a-z0-9])(${QUALIFIER_BEFORE}\\s+)?${escapeRegExp(needle)}(?:$|[^a-z0-9])`).exec(text)
  return !!qualified && !qualified[1]
}

function textHits(raw, needle) {
  const abbrevs = [...needle.abbrevs]
  if (/^[A-Z][A-Z0-9]{1,10}$/.test(needle.phrase) && !abbrevs.includes(needle.phrase)) abbrevs.push(needle.phrase)
  if (abbrevs.some((abbrev) => new RegExp(`\\b${escapeRegExp(abbrev)}\\b`).test(String(raw || '')))) return true
  const phrases = [needle.phrase]
  for (const abbrev of abbrevs) {
    const expanded = needle.expansions.get(abbrev)
    if (expanded) phrases.push(expanded)
  }
  return phrases.some((phrase) => phraseHit(raw, phrase))
}

function matchesDeclared(row, primaryNeedles, secondaryNeedles) {
  const name = String(row?.quantity?.name || '')
  const quote = String(row?.quantity?.source_quote || '')
  const hits = (needles, text) => needles.some((needle) => textHits(text, needle))
  if (hits(secondaryNeedles, name)) return false
  if (hits(primaryNeedles, name)) return true
  if (hits(secondaryNeedles, quote)) return false
  return hits(primaryNeedles, quote)
}

// The paper's primary result, as an EXPLICIT state — never null:
//   { state: 'identified', name, verified, indexes, basis }  a row is labelled primary (by its
//       name, else its verbatim quote, else its location hint) and is not secondary, a
//       subgroup, or a per-protocol / as-treated analysis (per-protocol noninferiority is
//       allowed). verified: any primary row passes the call site's verified predicate.
//   { state: 'unknown', name: null, verified: false, indexes: [] }  results were extracted
//       but none is labelled primary — e.g. only secondary results, or the source names a
//       primary outcome and no extracted row matches it. The main finding is then WITHHELD
//       by triage(): it cannot be weighed against a primary the app cannot name.
//   { state: 'unspecified', ... }  the source text was supplied and it never declares a
//       primary or a secondary endpoint (a meta-analysis that pools named outcomes, for
//       example). Verified results may be summarized; none of them is called the primary.
//   { state: 'no-results', name: null, verified: false, indexes: [] }  nothing was extracted
//       (narrative review, methods paper, extraction error). There is no result to headline;
//       the finding is number-free by construction (empty verified set) and model-checked.
// rows: runPaper rows [{ quantity, verdict }]. isVerified: the call site's own predicate.
// sourceText: the abstract or full text, when the caller has it. Omitted, an unlabelled
// row is still unknown — position never promotes a row (REV2).
export function findPrimary(rows, isVerified = (row) => !row?.verdict?.flagged, sourceText = '') {
  const list = Array.isArray(rows) ? rows : []
  const none = (state) => ({ state, name: null, verified: false, indexes: [], basis: null })
  if (!list.length) return none('no-results')
  const eligible = (row) => {
    const t = tagResult(row?.quantity)
    return !nonRandomized(t) && !t.subgroup && !t.secondary
  }
  const identified = (indexes, basis) => ({
    state: 'identified',
    name: String(list[indexes[0]]?.quantity?.name || ''),
    verified: indexes.some((i) => isVerified(list[i])),
    indexes,
    basis,
  })
  for (const [basis, test] of PRIMARY_BASES) {
    const indexes = list.flatMap((row, i) => (eligible(row) && test(row?.quantity) ? [i] : []))
    if (indexes.length) return identified(indexes, basis)
  }
  const source = String(sourceText || '')
  if (!source) return none('unknown')
  const expansions = abbreviationExpansions(source)
  const primaryNeedles = outcomeNeedles(source.match(PRIMARY_CLAUSE)?.[1], expansions)
  const secondaryNeedles = outcomeNeedles(source.match(SECONDARY_CLAUSE)?.[1], expansions)
  if (primaryNeedles.length) {
    const indexes = list.flatMap((row, i) => (eligible(row) && matchesDeclared(row, primaryNeedles, secondaryNeedles) ? [i] : []))
    if (indexes.length) return identified(indexes, 'source')
    return none('unknown')
  }
  // A declared secondary endpoint with no declared primary means the primary is missing.
  if (DECLARES_PRIMARY.test(source) || DECLARES_SECONDARY.test(source)) return none('unknown')
  if (list.some((row) => {
    const tags = tagResult(row?.quantity)
    return tags.secondary || tags.subgroup || nonRandomized(tags)
  })) return none('unknown')
  const indexes = list.flatMap((row, i) => (eligible(row) ? [i] : []))
  if (!indexes.length) return none('unknown')
  return {
    state: 'unspecified',
    name: null,
    verified: indexes.some((i) => isVerified(list[i])),
    indexes,
    basis: 'no-declared-primary',
  }
}

export const PRIMARY_UNKNOWN_REASON =
  "Withheld: the app could not identify this study's primary result among the extracted results, so a main finding cannot be weighed against it. Read the paper's primary result before repeating a takeaway."

// Which verified entries ({ value }) a finding's numeric tokens point at.
export function citedEntries(finding, verified) {
  const tokens = extractNumbersWithIndex(normalize(finding || '')).map((t) => t.value)
  if (!tokens.length) return []
  return (verified || []).filter((v) => {
    const nums = extractNumbers(normalize(String(v?.value ?? '')))
    return nums.some((n) => tokens.some((t) => numbersEqual(n, t)))
  })
}

// True when the paper's primary result is UNVERIFIED and the finding carries numbers from
// the verified set anyway. Every such number belongs to a non-primary result (secondary,
// subgroup, per-protocol, as-treated): the primary did not verify, so none of its numbers
// is in the set. A number-led sentence then headlines that result as if it were the
// study's answer (2026-10-11 dev set: HF-14 as-treated/per-protocol HRs over a null ITT
// primary; AS-04 transfemoral-cohort HR; HF-02 CV death; PAD-12 all-cause death; PAD-15
// mortality; PAD-05 headache; AS-01 composite). The guard falls back to the number-free
// sentence, which must describe the primary in words. Timepoints alone are not "numbers
// from the verified set" here. Stricter, never looser: nothing becomes renderable.
export function headlinesNonPrimary({ finding, verified, primary }) {
  if (!primary || primary.verified) return false
  return citedEntries(finding, verified).length > 0
}

// Deterministic prose verdict, or null when the model checker should decide.
// verified: [{ name, value, quote }]; primary: findPrimary() result or null.
const NAMES_NON_RANDOMIZED = /\bas[- ]treated\b|\bper[- ]protocol\b/i
const NAMES_RANDOMIZED = /\bintention[- ]to[- ]treat\b|\bITT\b|\brandomi[sz]ed comparison\b|\bprimary analysis\b/i
const NONINFERIORITY = /\bnon-?inferior/i

export function primaryScopeVerdict({ finding, verified, primary }) {
  const cited = citedEntries(finding, verified)
  if (!cited.length) {
    // A number-free finding that NAMES only per-protocol / as-treated analyses (and never the
    // randomized intention-to-treat comparison) while the primary is unverified is the same
    // failure in words (HF-14 after its numbers are removed). Noninferiority claims are
    // exempt: a per-protocol analysis is standard there.
    const text = String(finding || '')
    if (primary && !primary.verified && NAMES_NON_RANDOMIZED.test(text) && !NAMES_RANDOMIZED.test(text) && !NONINFERIORITY.test(text)) {
      return {
        verdict: 'refuted',
        reason: 'This summary describes only per-protocol or as-treated analyses, not the randomized (intention-to-treat) primary result, which the app could not verify. Read the primary result before repeating a takeaway.',
        deterministic: true,
      }
    }
    return null
  }
  const tags = cited.map((v) => tagResult({ name: v.name, source_quote: v.quote }))
  if (!tags.every(nonRandomized)) return null
  const kinds = [...new Set(tags.map((t) => t.population))].join(' and ')
  return {
    verdict: 'refuted',
    reason: `This summary is built only on ${kinds} results, which are not the randomized comparison${
      primary && !primary.verified ? ', and the primary (randomized) result was not verified by the app' : ''
    }. Read the primary result before repeating a takeaway.`,
    deterministic: true,
  }
}
