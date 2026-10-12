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
const NOUN = '(end\\s?-?points?|outcomes?|analys(?:is|es)|results?)'
const DECLARATION = (which) => new RegExp(`\\b${which}\\s+(?:efficacy\\s+|safety\\s+|effectiveness\\s+|composite\\s+)?${NOUN}\\s+(were|was|included|comprised|:)\\s+([^.]{4,500})`, 'i')
const PRIMARY_DECLARATION = DECLARATION('primary')
const SECONDARY_DECLARATION = DECLARATION('secondary')
const DECLARES_PRIMARY = new RegExp(`\\bprimary\\s+${ROLE}\\b`, 'i')
const DECLARES_SECONDARY = new RegExp(`\\bsecondary\\s+${ROLE}\\b`, 'i')
const LEADING_ROLE = /^(?:the\s+)?(?:incidence|rate|risk|odds|hazard|occurrence|proportion)\s+of\s+/i
const METHOD_START = /^(?:assessed|measured|evaluated|using|defined|compared)\b/i
const METHOD_CLAUSE = /\s*,?\s+(?:assessed|measured|evaluated|using|defined|compared|versus|vs\.?)\b[\s\S]*$/i
const COMPONENT_SPLIT = /\s*,\s*|\s+and\s*\/\s*or\s+|\s+or\s+|\s+and\s+/i
const QUALIFIER_BEFORE = '(?:central|branch|secondary|composite)'
// A follow-up time stays attached to the endpoint. "12 months" is not "1 year":
// only the printed number and unit are kept, and a different unit does not match.
const TIME_WORDS = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12', thirty: '30', sixty: '60', ninety: '90',
}
const TIME_NUM_SRC = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|sixty|ninety|\\d+'

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function abbreviationExpansions(text) {
  const map = new Map()
  const raw = String(text || '')
  // The words immediately before "(ABBREV)", stopping at punctuation, so a section
  // label earlier in the sentence is not part of the expansion.
  for (const match of raw.matchAll(/\(([A-Z][A-Z0-9]{1,10})\)/g)) {
    if (map.has(match[1])) continue
    const before = raw.slice(Math.max(0, match.index - 100), match.index)
    const words = before.match(/([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,6})\s*$/)
    const phrase = words?.[1]?.replace(/\s+/g, ' ').trim()
    if (phrase) map.set(match[1], phrase)
  }
  return map
}

function canonicalTime(num, unit) {
  const word = String(num || '').toLowerCase()
  const n = TIME_WORDS[word] || (/^\d+$/.test(word) ? String(Number(word)) : '')
  const u = String(unit || '').toLowerCase().replace(/s$/, '')
  if (!n || n === 'NaN' || !u) return ''
  return `${n}-${u}`
}

function timesIn(text) {
  const found = []
  const re = new RegExp(`\\b(${TIME_NUM_SRC})[-\\s]?((?:day|week|month|year)s?)\\b`, 'gi')
  for (const match of String(text || '').matchAll(re)) {
    const time = canonicalTime(match[1], match[2])
    if (time && !found.includes(time)) found.push(time)
  }
  return found
}

// A declared timepoint must be present, and a different timepoint must not be.
// No declared timepoint does not constrain the row (a paper can still say "two-year").
function timesAgree(declared, rowTimes) {
  if (!declared.length) return true
  if (!rowTimes.length) return false
  return rowTimes.every((time) => declared.includes(time))
}

function dedupeTimes(times) {
  const found = []
  for (const time of times) if (time && !found.includes(time)) found.push(time)
  return found
}

// Parenthetical abbreviations stay attached to the words they follow. Any other
// parenthesis is a qualifier ("stratified by…") and is not part of the endpoint.
function absorbParentheticals(text) {
  const markers = []
  const cleaned = String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(([^)]*)\)/g, (_, inner) => {
      const abbrev = String(inner).trim().match(/^([A-Z][A-Z0-9]{1,10})$/)
      if (!abbrev) return ' '
      const id = markers.length
      markers.push(abbrev[1])
      return ` §${id}§ `
    })
  return { cleaned: cleaned.replace(/\s+/g, ' ').trim(), markers }
}

const TIME_PHRASE = `(?:${TIME_NUM_SRC})[-\\s]?(?:day|week|month|year)s?`
const TRAILING_TIME = new RegExp(
  `\\s+(?:at|after|during|following|within|between|over|through|by)\\s+(?:${TIME_PHRASE}(?:\\s+(?:and|or)\\s+${TIME_PHRASE})*)(?:\\s+(?:after|following|from)\\s+[^,;]+)?\\s*$`,
  'i',
)
const LEADING_TIME = new RegExp(`^(?:${TIME_PHRASE}\\s+)+`, 'i')

// The shared timepoint sits on the whole endpoint ("…, or stroke at 30 days",
// "30-day death or stroke"). A time left between components is not one shared
// timepoint, so the declaration is not parsed.
function takeSharedTime(phrase) {
  let text = phrase
  const collected = []
  const trailing = text.match(TRAILING_TIME)
  if (trailing) {
    collected.push(...timesIn(trailing[0]))
    text = text.slice(0, trailing.index).trim()
  }
  const sameIntervals = text.match(/\s+at\s+the\s+same\s+intervals?\s*$/i)
  if (sameIntervals) text = text.slice(0, sameIntervals.index).trim()
  const leading = text.match(LEADING_TIME)
  if (leading) {
    collected.push(...timesIn(leading[0]))
    text = text.slice(leading[0].length).trim()
  }
  if (timesIn(text).length) return null
  return { text, times: dedupeTimes(collected) }
}

function componentsFromText(text, markers) {
  const components = []
  for (const raw of String(text || '').split(COMPONENT_SPLIT)) {
    const abbrevs = []
    let part = raw.replace(/§(\d+)§/g, (_, n) => {
      const abbrev = markers[Number(n)]
      if (abbrev) abbrevs.push(abbrev)
      return ' '
    })
    part = part.replace(/^(?:and\/or|and|or)\s+/i, '').replace(/\s+(?:and\/or|and|or)$/i, '')
    part = part.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+/g, ' ').trim()
    if (!part && abbrevs.length) {
      components.push({ text: abbrevs[0], abbrevs })
      continue
    }
    if (!part || METHOD_START.test(part)) continue
    if (part.length < 3 && !/^[A-Z][A-Z0-9]{1,10}$/.test(part)) return null
    if (/§\d+§/.test(part)) return null
    components.push({ text: part, abbrevs })
  }
  return components.length ? components : null
}

function prepareClause(clause) {
  const absorbed = absorbParentheticals(clause)
  let text = absorbed.cleaned.replace(METHOD_CLAUSE, '').trim()
  const timed = takeSharedTime(text)
  if (!timed) return null
  text = timed.text
    .replace(/^(?:(?:a|an|the)\s+)?composite\s+of\s+/i, '')
    .replace(LEADING_ROLE, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return { text, times: timed.times, markers: absorbed.markers }
}

// Singular "the end point was …" and any "composite of …" are one endpoint:
// commas, "or", "and", and "and/or" are components of that endpoint, and the
// timepoint belongs to all of them. Plural "outcomes were A, B, and C" is a
// list of endpoints. Plural mixed with "or" / "and/or" / an embedded composite
// has no single reading, so it is not parsed.
function parseDeclaration(match, expansions) {
  if (!match) return { endpoints: [], uncertain: false }
  const noun = match[1].toLowerCase().replace(/[\s-]/g, '')
  const verb = match[2].toLowerCase()
  const nounPlural = noun.endsWith('s')
  if ((verb === 'were' && !nounPlural) || (verb === 'was' && nounPlural)) return { endpoints: [], uncertain: true }
  const plural = verb === 'were' || (nounPlural && verb !== 'was')
  const prepared = prepareClause(match[3])
  if (!prepared) return { endpoints: [], uncertain: true }
  const compositeOf = /\bcomposite\s+of\b/i.test(match[3])
  const hasOr = /\band\s*\/\s*or\b|\bor\b/i.test(prepared.text)
  if (plural && !compositeOf && hasOr) return { endpoints: [], uncertain: true }
  if (plural && compositeOf && !/^(?:(?:a|an|the)\s+)?composite\s+of\b/i.test(match[3].trim())) {
    return { endpoints: [], uncertain: true }
  }
  if (!plural || compositeOf) {
    const components = componentsFromText(prepared.text, prepared.markers)
    if (!components) return { endpoints: [], uncertain: true }
    return { endpoints: [{ components, times: prepared.times, expansions }], uncertain: false }
  }
  const endpoints = []
  for (const piece of prepared.text.split(/\s*,\s*/)) {
    const components = componentsFromText(piece, prepared.markers)
    if (!components) return { endpoints: [], uncertain: true }
    endpoints.push({ components, times: prepared.times, expansions })
  }
  return endpoints.length ? { endpoints, uncertain: false } : { endpoints: [], uncertain: true }
}

function phraseHit(raw, phrase) {
  const text = normalize(raw)
  const needle = normalize(phrase)
  if (!needle || needle.length < 3) return false
  if (needle.length <= 5) return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`).test(text)
  const qualified = new RegExp(`(?:^|[^a-z0-9])(${QUALIFIER_BEFORE}\\s+)?${escapeRegExp(needle)}(?:$|[^a-z0-9])`).exec(text)
  return !!qualified && !qualified[1]
}

function abbrevHit(name, abbrev, expansions) {
  if (new RegExp(`\\b${escapeRegExp(abbrev)}\\b`).test(String(name || ''))) return true
  const expanded = expansions.get(abbrev)
  return !!(expanded && phraseHit(name, expanded))
}

function componentHit(name, component, expansions) {
  if (phraseHit(name, component.text)) return true
  const abbrevs = [...component.abbrevs]
  if (/^[A-Z][A-Z0-9]{1,10}$/.test(component.text) && !abbrevs.includes(component.text)) abbrevs.push(component.text)
  return abbrevs.some((abbrev) => abbrevHit(name, abbrev, expansions))
}

function itemHits(name, item) {
  if (!timesAgree(item.times, timesIn(name))) return false
  if (!item.components.length) return false
  return item.components.every((component) => componentHit(name, component, item.expansions))
}

// The row's own endpoint name has to be the declared endpoint. A shared quote that
// mentions the primary beside some other result does not make that other result primary.
function matchesDeclared(row, primaryItems, secondaryItems) {
  const name = String(row?.quantity?.name || '')
  if (secondaryItems.some((item) => itemHits(name, item))) return false
  return primaryItems.some((item) => itemHits(name, item))
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
// row is still unknown — position never promotes a row (REV2). One declared endpoint
// matches only a name that carries every component and the shared timepoint. An
// abbreviation is a synonym for the single component it follows. A parse that is
// not one of those shapes is unidentified. The source quote is not a second copy
// of the endpoint name.
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
  const primaryParsed = parseDeclaration(source.match(PRIMARY_DECLARATION), expansions)
  const secondaryParsed = parseDeclaration(source.match(SECONDARY_DECLARATION), expansions)
  if (primaryParsed.uncertain || secondaryParsed.uncertain) return none('unknown')
  if (primaryParsed.endpoints.length) {
    const indexes = list.flatMap((row, i) => (eligible(row) && matchesDeclared(row, primaryParsed.endpoints, secondaryParsed.endpoints) ? [i] : []))
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
