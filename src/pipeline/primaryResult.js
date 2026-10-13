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
// unverified result as verified; it only LABELS results (from their own name, and from
// the verbatim quote for population and hypothesis) and decides when a finding must not
// carry numbers or must be withheld:
//   - tagResult: population (ITT / modified ITT / per-protocol / as-treated), hypothesis
//     (noninferiority / superiority / equivalence), subgroup, primary/secondary role.
//   - findPrimary: which extracted rows report the primary endpoint, and whether any of
//     them verified.
//   - primaryScopeVerdict: a deterministic refute when a finding's numbers come only from
//     per-protocol / as-treated analyses while the randomized primary is unverified or not
//     cited. Uncertainty resolves to withholding, the same bias as check.js.

import { normalize, extractNumbers, extractNumbersWithIndex, numbersEqual, retainNumberSyntax } from './verify.js'
import { locateQuote } from './evidenceContext.js'

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
  // "PAD vs no PAD" and "with X vs without X" are subgroup arms. "X vs no X" is also a
  // subgroup unless the assignment sentence names that absence as a randomized arm;
  // that exception needs the source, so it is applied in findPrimary, not here.
  const subgroup = has(/\bsubgroups?\b|\bsubset\b|\bstrat(?:um|a)\b|\bin patients (?:with|without)\b|\bamong (?:patients|participants|those|women|men)\b|\b[\w-]+[- ]access cohort\b|\b(?:bicuspid|tricuspid)\b|\bin (?:a)?symptomatic patients\b/i, name)
    || subgroupComparison(name)
  const secondary = has(/\bsecondary\b/i, name)
  const primary = !secondary && has(/\b(?:co-?)?primary\b/i, name)
  return { population, hypothesis, subgroup, primary, secondary }
}

const NON_RANDOMIZED = new Set(['as-treated', 'per-protocol'])
// A per-protocol analysis is a legitimate (often co-primary) analysis of a NONINFERIORITY
// test, so it is only treated as "not the randomized comparison" outside that setting.
const nonRandomized = (t) => NON_RANDOMIZED.has(t?.population) && !(t.population === 'per-protocol' && t.hypothesis === 'noninferiority')

// A comparison of a feature with its absence is not the randomized treatment comparison,
// unless the assignment sentence itself names that absence as an arm.
function absenceFeature(name) {
  const text = String(name || '')
  const vsNo = text.match(/\b([A-Za-z][\w-]*)\s+(?:versus|vs\.?)\s+no\s+\1\b/i)
  if (vsNo) return vsNo[1]
  const vsNon = text.match(/\b([A-Za-z][\w-]*)\s+(?:versus|vs\.?)\s+non-?\1\b/i)
  return vsNon ? vsNon[1] : ''
}

function subgroupComparison(name) {
  const text = String(name || '')
  if (absenceFeature(text)) return true
  if (/\bwith(?:out)?\s+[A-Za-z][\w-]*\s+(?:versus|vs\.?)\s+with(?:out)?\s+[A-Za-z]/i.test(text)) return true
  if (/\bwith\s*\/\s*without\b/i.test(text)) return true
  return false
}

function featurePattern(feature) {
  return String(feature || '').replace(/-/g, '[-\\s]')
}

// "or no beta-blocker", "or no treatment", and "or usual care without a beta-blocker"
// name the control arm. "PAD vs no PAD" stays a subgroup when the assignment names
// other treatments.
function randomizationNamesAbsence(source, feature) {
  if (!feature) return false
  const phrase = featurePattern(feature)
  const arm = new RegExp(
    String.raw`(?:\bor\b|\bversus\b|\bvs\.?\b|\bto\b)\s+(?:a\s+|an\s+|the\s+)?(?:no\s+${phrase}\b|non-?${phrase}\b|no\s+treatment\b|usual\s+care\s+without\s+(?:a\s+|an\s+|the\s+)?${phrase}\b)`,
    'i',
  )
  return String(source || '').split(/(?<=[.!?])\s+/).some((sentence) => (
    /\b(?:assigned|allocated|randomly)\b/i.test(sentence) && arm.test(sentence)
  ))
}

function subgroupBlocks(name, source) {
  const feature = absenceFeature(name)
  if (feature && randomizationNamesAbsence(source, feature)) {
    const stripped = String(name || '')
      .replace(/\b([A-Za-z][\w-]*)\s+(?:versus|vs\.?)\s+no\s+\1\b/ig, ' ')
      .replace(/\b([A-Za-z][\w-]*)\s+(?:versus|vs\.?)\s+non-?\1\b/ig, ' ')
    return subgroupComparison(stripped)
      || /\bsubgroups?\b|\bsubset\b|\bstrat(?:um|a)\b|\bin patients (?:with|without)\b|\bamong (?:patients|participants|those|women|men)\b|\b[\w-]+[- ]access cohort\b|\b(?:bicuspid|tricuspid)\b|\bin (?:a)?symptomatic patients\b/i.test(stripped)
  }
  const text = String(name || '')
  return subgroupComparison(text)
    || /\bsubgroups?\b|\bsubset\b|\bstrat(?:um|a)\b|\bin patients (?:with|without)\b|\bamong (?:patients|participants|those|women|men)\b|\b[\w-]+[- ]access cohort\b|\b(?:bicuspid|tricuspid)\b|\bin (?:a)?symptomatic patients\b/i.test(text)
}

const ARM_STOP = new Set([
  'the', 'and', 'with', 'from', 'that', 'were', 'was', 'for', 'patients', 'patient', 'either',
  'receive', 'received', 'receiving', 'undergo', 'undergoing', 'group', 'groups', 'arm', 'arms',
  'therapy', 'treatment', 'alone', 'plus', 'into', 'who', 'had', 'been', 'their', 'this', 'after',
  'before', 'daily', 'twice', 'dose', 'oral', 'strategy', 'assigned', 'allocated', 'randomized',
  'randomised', 'randomly', 'ratio', 'continue', 'continued', 'transition', 'including',
])

function armWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word.length >= 3 && !ARM_STOP.has(word))
}

function stemsOverlap(left, right) {
  if (left === right) return true
  if (left.length >= 4 && right.length >= 4 && left.slice(0, 4) === right.slice(0, 4)) return true
  return false
}

// The first "randomly assigned ... to A or B" clause. Null when the trial is not
// randomized here or the two treatment arms are not both written in that clause.
function randomizedArmWords(source) {
  const text = String(source || '')
  if (!/\brandom(?:ly|i[sz]ed)\b/i.test(text)) return null
  const match = text.match(/\brandom(?:ly|i[sz]ed)\s+(?:assigned|allocated)\b[^.]{0,320}?\bto\b\s+([^.]{0,260})/i)
  if (!match) return null
  const parts = match[1].split(/\s+(?:or|versus|vs\.?)\s+/i).map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const words = parts.slice(0, 2).flatMap(armWords)
  return words.length >= 2 ? words : null
}

function rowComparisonWords(name) {
  const match = String(name || '').match(/\b([^,;()]{2,80}?)\s+(?:versus|vs\.?)\s+([^,;()]{2,80})/i)
  if (!match) return null
  const words = [match[1], match[2]].flatMap(armWords)
  return words.length ? words : null
}

// When the trial states its randomized arms, a row comparison that shares none of
// those words is a different contrast (a subgroup or a component), not the primary.
function comparisonMissesRandomizedArms(name, source) {
  if (subgroupBlocks(name, source)) return true
  const arms = randomizedArmWords(source)
  const row = rowComparisonWords(name)
  if (!arms || !row) return false
  return !row.some((token) => arms.some((arm) => stemsOverlap(token, arm)))
}

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

// Where a row's PRIMARY label comes from when the source never declares one.
// Extraction order is NOT one of them: the extraction prompt asks for the primary
// first, but nothing checks that it did, and a paper whose extracted rows are all
// secondary still has a row zero (REV2, gap 1). The source quote is not a label.
// A quote can name the primary beside a different result ("stroke alone… the
// primary end point was death or stroke"). The row's own endpoint is its name.
const PRIMARY_WORD = /\b(?:co-?)?primary\b/i
const LABEL_BASES = [
  ['name', (q) => PRIMARY_WORD.test(String(q?.name || ''))],
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
// A decimal point ("1.5") is part of the clause. A sentence period is not.
const CLAUSE_BODY = '(?:[^.]|\\.(?=\\d))'
const DECLARATION = (which) => new RegExp(`\\b${which}\\s+(?:efficacy\\s+|safety\\s+|effectiveness\\s+|composite\\s+)?${NOUN}\\s+(?:of\\s+(?:the|this|a|an)\\s+${CLAUSE_BODY}{3,60}?\\s+)?(were|was|included|comprised|:)\\s+(${CLAUSE_BODY}{4,500})`, 'i')
const PRIMARY_DECLARATION = DECLARATION('primary')
const DECLARES_PRIMARY = new RegExp(`\\bprimary\\s+${ROLE}\\b`, 'i')
const DECLARES_SECONDARY = new RegExp(`\\bsecondary\\s+${ROLE}\\b`, 'i')
const LEADING_ROLE = /^(?:the\s+)?(?:incidence|rate|risk|odds|hazard|occurrence|proportion)\s+of\s+/i
const METHOD_START = /^(?:assessed|measured|evaluated|using|defined|compared)\b/i
const METHOD_CLAUSE = /\s*,?\s+(?:assessed|measured|evaluated|using|defined|compared|versus|vs\.?)\b[\s\S]*$/i
const COMPONENT_SPLIT = /\s*,\s*|\s+and\s*\/\s*or\s+|\s+or\s+|\s+and\s+/i
// A follow-up time stays attached to the endpoint. "12 months" is not "1 year":
// only the printed number and unit are kept, and a different unit does not match.
const TIME_WORDS = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', eleven: '11', twelve: '12', thirty: '30', sixty: '60', ninety: '90',
}
const TIME_NUM_SRC = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirty|sixty|ninety|\\d+'
const TIME_PHRASE = `(?:${TIME_NUM_SRC})[-\\s]?(?:day|week|month|year)s?`

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
  // "MACE (cardiovascular death, myocardial infarction, or stroke)" defines the
  // abbreviation. A bare MACE is not expanded unless the source does this.
  for (const match of raw.matchAll(/\b([A-Z][A-Z0-9]{1,10})\s*[([]\s*((?:defined as\s+)?[A-Za-z][^)\]]{8,240}?)\s*[\])]/g)) {
    // MI (leading to hospitalization) is a qualifier, not a definition of MI.
    // CV, MI, HF, and ACS already expand from the closed list. MACE does not.
    if (map.has(match[1]) || /^(?:MI|CV|HF|ACS|MALE|RAO|HR|OR|RR|CI)$/.test(match[1]) || /\d/.test(match[2])) continue
    const phrase = match[2].replace(/^(?:defined as|i\.e\.|that is)\s+/i, '').replace(/\s+/g, ' ').trim()
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

// A window is (relation, duration, anchor). "within" is not "at". A bare "30-day"
// prefix is relation "at" and anchor none. The anchor is the event after
// after/following/from ("randomization", "the index procedure"). An absent anchor
// is not the same event as a named one. A declaration with no windows at all does
// not constrain a row window; a single untimed component beside a timed one does.
const WINDOW_REL = 'at|after|during|following|within|between|over|through|by'
const ANCHOR_INTRO = 'after|following|from'
// An anchor is the event words after after/following/from. It stops before the
// next outcome ("or" / "and"), so "after surgery or stroke" is not one event.
const ANCHOR_WORD = "(?!(?:or|and|versus|vs)\\b)[A-Za-z][A-Za-z'-]*"
const ANCHOR_PHRASE = `${ANCHOR_WORD}(?:\\s+${ANCHOR_WORD}){0,5}`
const TIME_LIST = `${TIME_PHRASE}(?:\\s+(?:and|or)\\s+${TIME_PHRASE})*`
const LEADING_TIME = new RegExp(`^(?:(?:${TIME_PHRASE})\\s+)+`, 'i')
const RELATION_WORD = /^(?:at|after|during|following|within|between|over|through)$/i
const PHRASE_FINAL_ANCHOR = new RegExp(`^(.*)\\s+(?:${ANCHOR_INTRO})\\s+(${ANCHOR_PHRASE})\\s*$`, 'i')
const LOOSE_ANCHOR = new RegExp(`\\b(?:${ANCHOR_INTRO})\\b`, 'i')
const LEADING_RELATION = new RegExp(`^(${WINDOW_REL})\\s+(${TIME_LIST})(?:\\s+(${ANCHOR_INTRO})\\s+${ANCHOR_PHRASE})?\\s+`, 'i')
// Articles and "only" drop out. Connector words do not: "with", "to", and "from"
// are not discarded, so an unfamiliar phrase cannot disappear before the
// vocabulary check.
const STOP_WORDS = new Set(['only', 'the', 'a', 'an', 'of', 'by', 'for'])

function canonicalRelation(relation) {
  return String(relation || 'at').trim().toLowerCase() || 'at'
}

function dedupeWindows(windows) {
  const found = []
  const seen = new Set()
  for (const window of windows || []) {
    if (!window?.time) continue
    const relation = canonicalRelation(window.relation)
    const anchor = String(window.anchor || '')
    const key = `${relation}|${window.time}|${anchor}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ relation, time: window.time, anchor })
  }
  return found
}

function windowsFrom(relation, timeText, anchor = '') {
  const rel = canonicalRelation(relation)
  const event = String(anchor || '')
  return dedupeWindows(timesIn(timeText).map((time) => ({ relation: rel, time, anchor: event })))
}

function sameWindow(left, right) {
  return left.relation === right.relation && left.time === right.time && (left.anchor || '') === (right.anchor || '')
}

function windowsAgree(declared, row, untimedEndpoint = false) {
  const left = declared || []
  const right = row || []
  // A wholly untimed declaration does not constrain a row window. Once any
  // component carries a window, a component with no window matches only a
  // component with no window — an absent anchor or duration is not a wildcard.
  if (!left.length) return untimedEndpoint || right.length === 0
  if (!right.length) return false
  return right.every((window) => left.some((item) => sameWindow(item, window)))
}

function sameWindowSet(left, right) {
  const a = dedupeWindows(left)
  const b = dedupeWindows(right)
  return a.length === b.length && windowsAgree(a, b)
}

function contentWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/§\d+§/g, ' ')
    .split(/[^a-z0-9'-]+/)
    .filter((word) => word && !STOP_WORDS.has(word))
}

function wordBag(text) {
  return [...new Set(contentWords(text))].sort()
}

// A comma/or piece is one component only when its content words are exactly one
// outcome from this list, plus qualifier phrases from the list below. Anything
// else ("leading to", "resulting in", "due to", "causing", "with") is unparsed.
// The matcher does not split a piece into a guessed outcome and a leftover.
const OUTCOME_PHRASES = [
  'death',
  'stroke',
  'myocardial infarction',
  'major bleeding',
  'major amputation',
  'wound healing',
  'major adverse limb events',
  'amputation-free survival',
  'retinal artery occlusion',
]
const OUTCOME_ALIASES = [
  ['MI', 'myocardial infarction'],
  ['MALE', 'major adverse limb events'],
  ['RAO', 'retinal artery occlusion'],
]
const QUALIFIER_PHRASES = [
  'requiring hospitalization',
  'cardiovascular',
  'ipsilateral',
]

function phraseWords(phrase) {
  return contentWords(phrase)
}

const OUTCOME_TERMS = OUTCOME_PHRASES.map((phrase) => ({ words: phraseWords(phrase), canonical: wordBag(phrase) }))
const ALIAS_TERMS = OUTCOME_ALIASES.map(([alias, phrase]) => ({ words: [alias.toLowerCase()], canonical: wordBag(phrase) }))
const TERMS = [...OUTCOME_TERMS, ...ALIAS_TERMS].sort((a, b) => b.words.length - a.words.length)
const QUALIFIER_TERMS = QUALIFIER_PHRASES.map((phrase) => phraseWords(phrase)).sort((a, b) => b.length - a.length)

function sameWords(left, right) {
  return left.length === right.length && left.every((word, index) => word === right[index])
}

function coversPhrases(words, phrases) {
  if (!words.length) return true
  for (const phrase of phrases) {
    if (phrase.length > words.length || !sameWords(words.slice(0, phrase.length), phrase)) continue
    if (coversPhrases(words.slice(phrase.length), phrases)) return true
  }
  return false
}

// One successful reading. Two different ways to assign the same words is a guess.
function recognizeHead(words) {
  if (!words.length) return null
  const found = []
  for (const term of TERMS) {
    for (let start = 0; start + term.words.length <= words.length; start++) {
      if (!sameWords(words.slice(start, start + term.words.length), term.words)) continue
      const before = words.slice(0, start)
      const after = words.slice(start + term.words.length)
      if (!coversPhrases(before, QUALIFIER_TERMS) || !coversPhrases(after, QUALIFIER_TERMS)) continue
      found.push({ headWords: term.canonical, qualifiers: [...before, ...after].sort() })
    }
  }
  if (!found.length) return null
  const key = (item) => `${item.headWords.join('\0')}\0${item.qualifiers.join('\0')}`
  if (new Set(found.map(key)).size !== 1) return null
  return found[0]
}

function absorbAnchor(text, windows, markers) {
  const tail = String(text || '').match(PHRASE_FINAL_ANCHOR)
  if (!tail) return { text, windows, ok: true }
  const anchor = anchorOf(tail[2])
  const rest = tail[1].replace(/[,\s]+$/g, '').trim()
  // No window on this phrase yet: the anchor belongs to a component window that
  // has not been split off, or there is no duration and the component parser
  // will reject the leftover intro. Do not drop the event.
  if (!windows.length) return { text, windows, ok: true }
  if (!anchor || windows.some((window) => window.anchor) || hasWindow(rest, markers)) return { ok: false }
  return { text: rest, windows: windows.map((window) => ({ ...window, anchor })), ok: true }
}

// A parenthetical or bracket is never discarded. It is a time window, a pure
// abbreviation, a recognized qualifier phrase, or a piece that is re-read as a
// component. That piece survives only when it is a recognized outcome. A time
// mixed with other words, or a decoration with no content, is unparsed.
function anchorOf(phrase) {
  const words = contentWords(phrase)
  if (!words.length || timesIn(phrase).length) return null
  return words.join(' ')
}

// A window phrase is a relation, a duration, and an optional anchor event.
// Every token has to land in one of those slots. A bare duration is relation "at".
function parseWindowPhrase(text) {
  const raw = String(text || '').replace(/§\d+§/g, ' ').replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const match = raw.match(new RegExp(
    `^(?:(${WINDOW_REL})\\s+)?(${TIME_LIST})(?:\\s+(${ANCHOR_INTRO})\\s+(${ANCHOR_PHRASE}))?$`,
    'i',
  ))
  if (!match || !timesIn(match[2]).length) return null
  let anchor = ''
  if (match[3]) {
    anchor = anchorOf(match[4] || '')
    if (!anchor) return null
  }
  const windows = windowsFrom(match[1] || 'at', match[2], anchor)
  return windows.length ? windows : null
}

function decorationWindows(inner) {
  return parseWindowPhrase(inner)
}

function decorate(text) {
  const markers = []
  let current = String(text || '')
  for (let step = 0; step < 20; step++) {
    const match = /\(([^()[\]]*)\)|\[([^()[\]]*)\]/.exec(current)
    if (!match) break
    const inner = String(match[1] ?? match[2] ?? '').replace(/\s+/g, ' ').trim()
    const abbrev = inner.match(/^([A-Z][A-Z0-9]{1,10})$/)
    let replacement = ' '
    if (abbrev) {
      markers.push({ kind: 'abbrev', value: abbrev[1] })
      replacement = ` §${markers.length - 1}§ `
    } else {
      const windows = decorationWindows(inner)
      const words = contentWords(inner)
      if (windows) {
        markers.push({ kind: 'window', value: windows })
        replacement = ` §${markers.length - 1}§ `
      } else if (timesIn(inner.replace(/§\d+§/g, ' ')).length || words.length === 0) {
        return { text: current, markers, uncertain: true }
      } else if (coversPhrases(words, QUALIFIER_TERMS)) {
        markers.push({ kind: 'qualifier', value: words })
        replacement = ` §${markers.length - 1}§ `
      } else {
        // Re-read as its own piece. It survives only when that piece is a
        // recognized outcome; an unfamiliar phrase does not become one.
        markers.push({ kind: 'extra', value: inner })
        replacement = ` §${markers.length - 1}§ `
      }
    }
    current = `${current.slice(0, match.index)}${replacement}${current.slice(match.index + match[0].length)}`
  }
  if (/[()[\]]/.test(current)) return { text: current, markers, uncertain: true }
  return { text: current.replace(/\s+/g, ' ').trim(), markers, uncertain: false }
}

function hasWindow(text, markers) {
  if (timesIn(text).length) return true
  for (const match of String(text || '').matchAll(/§(\d+)§/g)) {
    if (markers[Number(match[1])]?.kind === 'window') return true
  }
  return false
}

function trailingWindow(text) {
  const match = String(text || '').match(new RegExp(
    `\\s+(${WINDOW_REL})\\s+(${TIME_LIST})(?:\\s+(${ANCHOR_INTRO})\\s+${ANCHOR_PHRASE})?\\s*$`,
    'i',
  ))
  if (!match) return null
  const windows = parseWindowPhrase(text.slice(match.index))
  if (!windows) return null
  return { index: match.index, windows }
}

// A window is shared by every component only when one leading or trailing window
// covers the whole phrase. A window left on a component stays on that component.
function peelSharedWindow(text, markers) {
  const accept = (rest, windows) => {
    const cleaned = String(rest || '').replace(/^[,\s]+|[,\s]+$/g, '').trim()
    if (!windows.length || hasWindow(cleaned, markers)) return null
    return { text: cleaned, windows: dedupeWindows(windows) }
  }
  const trailing = trailingWindow(text)
  if (trailing) {
    const peeled = accept(text.slice(0, trailing.index), trailing.windows)
    if (peeled) return absorbOrKeep(peeled.text, peeled.windows, markers)
  }
  const marker = text.match(/\s*§(\d+)§\s*$/)
  if (marker && markers[Number(marker[1])]?.kind === 'window') {
    const peeled = accept(text.slice(0, marker.index), markers[Number(marker[1])].value)
    if (peeled) return absorbOrKeep(peeled.text, peeled.windows, markers)
  }
  const leading = text.match(LEADING_TIME)
  if (leading) {
    const rest = text.slice(leading[0].length)
    // "1-year death after randomization or stroke": the anchor sits on death,
    // so the leading duration is not a window shared by the later outcome.
    const anchorStaysOnComponent = LOOSE_ANCHOR.test(rest) && !PHRASE_FINAL_ANCHOR.test(rest)
    if (!anchorStaysOnComponent) {
      const peeled = accept(rest, windowsFrom('at', leading[0], ''))
      if (peeled) return absorbOrKeep(peeled.text, peeled.windows, markers)
    }
  }
  const leadingRelation = text.match(LEADING_RELATION)
  if (leadingRelation) {
    const windows = parseWindowPhrase(leadingRelation[0].trim())
    if (windows) {
      const peeled = accept(text.slice(leadingRelation[0].length), windows)
      if (peeled) return absorbOrKeep(peeled.text, peeled.windows, markers)
    }
  }
  return absorbOrKeep(text, [], markers)
}

function absorbOrKeep(text, windows, markers) {
  const absorbed = absorbAnchor(text, windows, markers)
  if (!absorbed.ok) return null
  return { text: absorbed.text, windows: dedupeWindows(absorbed.windows) }
}

function finishBody(text) {
  return String(text || '')
    .replace(/^(?:(?:a|an|the)\s+)?composite\s+of\s+/i, '')
    .replace(LEADING_ROLE, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// A method clause is kept only when it is nothing but a window ("assessed at 30
// days"). Any other word in that clause is not a component, qualifier, window,
// or abbreviation, so the declaration is unparsed.
function readMethod(clause) {
  const method = String(clause || '').match(METHOD_CLAUSE)
  if (!method) return { text: clause, windows: [], ok: true }
  let rest = method[0].replace(/^\s*,?\s*(?:assessed|measured|evaluated|using|defined|compared)\b\s*/i, '')
  rest = rest.replace(/^(?:by|with|using)\s+/i, '').trim()
  const body = clause.slice(0, method.index).replace(/[,\s]+$/g, '').trim()
  if (!rest) return { text: body, windows: [], ok: true }
  const windows = parseWindowPhrase(rest)
  if (!windows) return { ok: false }
  return { text: body, windows, ok: true }
}

// Time windows are kept before a method clause is removed. A method-clause
// window and a different window inside the endpoint cannot both be read, so
// that clause is unparsed.
function analyzeClause(clause) {
  const decorated = decorate(clause)
  if (decorated.uncertain) return null
  let text = decorated.text.replace(/\s+/g, ' ').trim()
  const method = readMethod(text)
  if (!method.ok) return null
  if (method.windows.length && hasWindow(method.text, decorated.markers)) return null
  text = method.text.replace(/^(?:the|a|an)\s+/i, '').trim()
  const peeled = peelSharedWindow(text, decorated.markers)
  if (!peeled) return null
  if (method.windows.length && peeled.windows.length && !sameWindowSet(method.windows, peeled.windows)) return null
  text = finishBody(peeled.text)
  if (!text) return null
  return { text, windows: dedupeWindows([...peeled.windows, ...method.windows]), markers: decorated.markers }
}

function parsePiece(raw, markers, inherited) {
  const abbrevs = []
  const qualifiers = []
  const own = []
  let part = String(raw || '').replace(/§(\d+)§/g, (_, n) => {
    const marker = markers[Number(n)]
    if (!marker || marker.kind === 'extra') return ' '
    if (marker.kind === 'abbrev') abbrevs.push(marker.value)
    else if (marker.kind === 'qualifier') qualifiers.push(...marker.value)
    else if (marker.kind === 'window') own.push(...marker.value)
    return ' '
  })
  part = part.replace(/^(?:and\/or|and|or)\s+/i, '').replace(/\s+(?:and\/or|and|or)$/i, '')
  part = part.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+/g, ' ').trim()
  if (!part && !abbrevs.length && !qualifiers.length) return undefined
  if (METHOD_START.test(part)) return null
  const trailing = trailingWindow(part)
  if (trailing) {
    own.push(...trailing.windows)
    part = part.slice(0, trailing.index).trim()
  }
  const leading = part.match(LEADING_TIME)
  if (leading) {
    if (own.length) return null
    own.push(...windowsFrom('at', leading[0], ''))
    part = part.slice(leading[0].length).trim()
  }
  const leadingRelation = part.match(LEADING_RELATION)
  if (leadingRelation) {
    if (own.length) return null
    const windows = parseWindowPhrase(leadingRelation[0].trim())
    if (!windows) return null
    own.push(...windows)
    part = part.slice(leadingRelation[0].length).trim()
  }
  const absorbed = absorbAnchor(part, own, markers)
  if (!absorbed.ok) return null
  part = absorbed.text
  own.splice(0, own.length, ...absorbed.windows)
  part = part.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+/g, ' ').trim()
  if (timesIn(part).length || /§\d+§|[()[\]]/.test(part)) return null
  // A leftover anchor intro was not placed in a window.
  if (LOOSE_ANCHOR.test(part) || contentWords(part).some((word) => RELATION_WORD.test(word))) return null
  if ((inherited || []).length && own.length && !sameWindowSet(inherited, own)) return null
  const windows = dedupeWindows(own.length ? own : inherited)
  if (/^[A-Z][A-Z0-9]{1,10}$/.test(part) && !abbrevs.includes(part)) abbrevs.push(part)
  const words = contentWords(part)
  const markerQualifiers = [...qualifiers]
  if (markerQualifiers.length && !coversPhrases(markerQualifiers, QUALIFIER_TERMS)) return null
  const recognized = recognizeHead(words)
  if (recognized) {
    return {
      headWords: recognized.headWords,
      qualifiers: [...new Set([...markerQualifiers, ...recognized.qualifiers])].sort(),
      abbrevs,
      windows,
      head: part,
    }
  }
  // A comma piece that is only a recognized qualifier binds to the previous
  // outcome. It does not become an outcome of its own.
  if (!abbrevs.length && !windows.length && words.length && coversPhrases(words, QUALIFIER_TERMS)) {
    return { qualifierOnly: true, qualifiers: [...new Set([...markerQualifiers, ...words])].sort() }
  }
  if (!words.length && !abbrevs.length && coversPhrases(markerQualifiers, QUALIFIER_TERMS) && markerQualifiers.length && !windows.length) {
    return { qualifierOnly: true, qualifiers: [...new Set(markerQualifiers)].sort() }
  }
  return null
}

function segmentComponents(raw, markers, inherited) {
  const extras = []
  const hostText = String(raw || '').replace(/§(\d+)§/g, (whole, n) => {
    const marker = markers[Number(n)]
    if (marker?.kind === 'extra') {
      extras.push(marker.value)
      return ' '
    }
    return whole
  })
  const host = parsePiece(hostText, markers, inherited)
  if (host === null) return null
  const windows = host?.windows?.length ? host.windows : inherited
  const components = []
  if (host) components.push(host)
  for (const extra of extras) {
    const nested = componentsFromText(extra, markers, windows)
    if (!nested) return null
    components.push(...nested)
  }
  return components
}

function componentsFromText(text, markers, inherited) {
  const components = []
  for (const raw of String(text || '').split(COMPONENT_SPLIT)) {
    const parsed = segmentComponents(raw, markers, inherited)
    if (!parsed) return null
    for (const part of parsed) {
      if (part.qualifierOnly) {
        const host = components[components.length - 1]
        if (!host || host.qualifierOnly) return null
        host.qualifiers = [...new Set([...(host.qualifiers || []), ...part.qualifiers])].sort()
        continue
      }
      components.push(part)
    }
  }
  return components.length ? components : null
}

// Singular "the end point was …" and any "composite of …" are one endpoint:
// commas, "or", "and", and "and/or" are components of that endpoint. A window
// shared by the phrase structure belongs to each of them. Plural "outcomes were
// A, B, and C" is a list of endpoints. Plural mixed with "or" / "and/or" / an
// embedded composite has no single reading, so it is not parsed.
function parseDeclaration(match, expansions) {
  if (!match) return { endpoints: [], uncertain: false }
  const noun = match[1].toLowerCase().replace(/[\s-]/g, '')
  const verb = match[2].toLowerCase()
  const nounPlural = noun.endsWith('s')
  if ((verb === 'were' && !nounPlural) || (verb === 'was' && nounPlural)) return { endpoints: [], uncertain: true }
  const plural = verb === 'were' || (nounPlural && verb !== 'was')
  const prepared = analyzeClause(match[3])
  if (!prepared) return { endpoints: [], uncertain: true }
  const compositeOf = /\bcomposite\s+of\b/i.test(match[3])
  const hasOr = /\band\s*\/\s*or\b|\bor\b/i.test(prepared.text)
  if (plural && !compositeOf && hasOr) return { endpoints: [], uncertain: true }
  if (plural && compositeOf && !/^(?:(?:a|an|the)\s+)?composite\s+of\b/i.test(match[3].trim())) {
    return { endpoints: [], uncertain: true }
  }
  if (!plural || compositeOf) {
    const components = componentsFromText(prepared.text, prepared.markers, prepared.windows)
    if (!components) return { endpoints: [], uncertain: true }
    return { endpoints: [{ components, expansions }], uncertain: false }
  }
  const endpoints = []
  for (const piece of prepared.text.split(/\s*,\s*/)) {
    const components = componentsFromText(piece, prepared.markers, prepared.windows)
    if (!components) return { endpoints: [], uncertain: true }
    endpoints.push({ components, expansions })
  }
  return endpoints.length ? { endpoints, uncertain: false } : { endpoints: [], uncertain: true }
}

function abbrevList(component) {
  const abbrevs = [...(component.abbrevs || [])]
  if (/^[A-Z][A-Z0-9]{1,10}$/.test(component.head || '') && !abbrevs.includes(component.head)) abbrevs.push(component.head)
  return abbrevs
}

function expansionBag(abbrev, expansions) {
  const phrase = expansions?.get(abbrev)
  if (!phrase) return null
  return wordBag(phrase)
}

function listsEqual(left, right) {
  return left.length === right.length && left.every((word, index) => word === right[index])
}

// A qualifier written beside its outcome ("cardiovascular death") and the same
// qualifier in a parenthetical ("death (cardiovascular only)") are one tuple.
// Words do not move onto a different outcome.
function alignedTuple(row, declared) {
  const qual = new Set([...(row.qualifiers || []), ...(declared.qualifiers || [])])
  const head = (component) => (component.headWords || []).filter((word) => !qual.has(word)).sort()
  const quals = (component) => {
    const set = new Set(component.qualifiers || [])
    for (const word of component.headWords || []) if (qual.has(word)) set.add(word)
    return [...set].sort()
  }
  return { rowHead: head(row), declaredHead: head(declared), rowQual: quals(row), declaredQual: quals(declared) }
}

function pureToken(headWords, component) {
  if (headWords.length !== 1) return null
  const abbrevs = abbrevList(component)
  const upper = headWords[0].toUpperCase()
  if (abbrevs.includes(upper)) return upper
  if (/^[A-Z][A-Z0-9]{1,10}$/.test(component.head || '') && component.head.toLowerCase() === headWords[0]) return component.head
  return null
}

function componentEquals(rowComponent, declared, expansions, untimedEndpoint = false) {
  if (!windowsAgree(declared.windows, rowComponent.windows, untimedEndpoint)) return false
  const aligned = alignedTuple(rowComponent, declared)
  if (listsEqual(aligned.rowHead, aligned.declaredHead) && listsEqual(aligned.rowQual, aligned.declaredQual)) return true
  if (!listsEqual(aligned.rowQual, aligned.declaredQual)) return false
  const rowPure = pureToken(aligned.rowHead, rowComponent)
  const declaredPure = pureToken(aligned.declaredHead, declared)
  if (rowPure && abbrevList(declared).includes(rowPure)) return true
  if (declaredPure && abbrevList(rowComponent).includes(declaredPure)) return true
  const rowExpansion = rowPure ? expansionBag(rowPure, expansions) : null
  if (rowExpansion && listsEqual(rowExpansion, aligned.declaredHead)) return true
  const declaredExpansion = declaredPure ? expansionBag(declaredPure, expansions) : null
  if (declaredExpansion && listsEqual(declaredExpansion, aligned.rowHead)) return true
  return false
}

// The row's component set has to be the declared set. Each component carries
// its qualifiers and its own window. A strict subset and a strict superset are
// different endpoints. A parenthesis or bracket on the row is part of that
// structure; a statistic tail is not an outcome.
function rowEndpoint(name) {
  let text = String(name || '')
  text = text.replace(/^(?:the\s+)?(?:co-?)?primary\s+(?:efficacy\s+|safety\s+|effectiveness\s+|composite\s+)?(?:end\s?-?points?|outcomes?|analysis|composite)\s*[:\-—]?\s*/i, '')
  text = text.replace(/,\s+[^,]*\b(?:versus|vs\.?|compared(?:\s+with|\s+to)?)\b[\s\S]*$/i, '')
  text = text.replace(/,?\s*\((?:hazard ratio|odds ratio|risk ratio|HR|OR|RR)\)\s*$/i, '')
  const core = analyzeClause(text)
  if (!core) return null
  const components = componentsFromText(core.text, core.markers, core.windows)
  if (!components) return null
  return { components }
}

function sameComponentSet(rowComponents, item) {
  if (rowComponents.length !== item.components.length) return false
  const untimedEndpoint = item.components.every((component) => !(component.windows || []).length)
  const used = new Set()
  for (const rowComponent of rowComponents) {
    const index = item.components.findIndex((component, i) => !used.has(i) && componentEquals(rowComponent, component, item.expansions, untimedEndpoint))
    if (index < 0) return false
    used.add(index)
  }
  return true
}

function itemHits(name, item) {
  const row = rowEndpoint(name)
  if (!row || !item.components.length) return false
  return sameComponentSet(row.components, item)
}

// The row's own endpoint name has to equal the declared endpoint. A shared quote
// that mentions the primary beside some other result does not make that other
// result primary, and neither does the word "primary" in the name or location.
// Equality is a set of (component, qualifiers, window) tuples. A qualifier stays
// on the component it was written on. A window is relation, duration, and anchor
// event; a named anchor is not the same as a missing or different one.
// A secondary endpoint that happens to use the same components does not veto a
// row that already equals the primary. A secondary-only row is not the primary.
function matchesDeclared(row, primaryItems) {
  const name = String(row?.quantity?.name || '')
  return primaryItems.some((item) => itemHits(name, item))
}

// Words the closed outcome list does not know still match when the row prints
// the same phrase as the declaration. Case, whitespace, and non-semantic
// punctuation are the only normalization. Comparison operators, signs,
// decimals, slashes, and ranges stay, so "<10%" is not ">10%" and "1.5" is
// not "15". Role labels, a statistic label (hazard ratio, odds ratio, and the
// same family), an arm comparison ("A vs B"), and a leading "composite of"
// are structural wrappers. CV, MI, HF, and ACS expand to the phrase they
// already stand for. MACE expands only when this source defines it.
// MALE / RAO stay on the closed outcome list. A leading "adjudicated" is
// list-level ascertainment and drops only when the rest is still a list.
// Qualifiers, components, populations, time windows, and arm labels stay in
// the phrase, so a different one does not match.
const SURFACE_ALIAS = new Map([
  ['cv', 'cardiovascular'],
  ['hf', 'heart failure'],
  ['mi', 'myocardial infarction'],
  ['acs', 'acute coronary syndrome'],
  ['male', 'major adverse limb events'],
  ['rao', 'retinal artery occlusion'],
])
const STAT_LABEL = /\b(?:hazard|odds|risk|rate)\s+ratios?\b|\brelative\s+risk\b|\bmean\s+difference\b|\brisk\s+difference\b|\babsolute\s+(?:risk\s+)?(?:difference|reduction)\b|\babsolute\s+difference\b/gi
const RESIDUE_STOP = new Set([
  'efficacy', 'safety', 'effectiveness', 'composite', 'outcome', 'outcomes', 'endpoint', 'endpoints',
  'end', 'point', 'points', 'analysis', 'incidence', 'rate', 'rates', 'event', 'events', 'result', 'results',
  'primary', 'co',
])
const CONTENT_STOP = new Set([
  'the', 'a', 'an', 'of', 'in', 'to', 'for', 'with', 'by', 'on', 'per', 'and', 'or', 'was', 'were', 'is', 'are',
  'from', 'within', 'at', 'after', 'during', 'following', 'between', 'over', 'through',
  'difference', 'incidence', 'rate', 'rates', 'risk', 'occurrence', 'composite', 'change', 'measured',
  'assessed', 'defined', 'occurring', 'compared', 'versus', 'vs', 'overall', 'total', 'number', 'proportion',
  'mean', 'median', 'patients', 'patient', 'group', 'groups', 'study', 'trial', 'primary', 'secondary',
  'endpoint', 'end', 'point', 'outcome', 'outcomes', 'event', 'events', 'analysis', 'similar', 'occurred',
  'higher', 'lower', 'significantly', 'estimated', 'reduced', 'increased', 'did', 'not', 'differ',
  'receiving', 'assigned', 'undergoing', 'due', 'up', 'than', 'into',
  'confidence', 'interval', 'ci', 'percentage', 'points', 'percent', 'adjusted',
  'ratio', 'ratios', 'follow',
])
const HEAD_WORDS = new Set(['death', 'stroke', 'infarction', 'bleeding', 'amputation', 'hospitalization', 'healing'])
const QUALIFIER_TOKEN = new Set([
  'any', 'cause', 'causes', 'cardiovascular', 'disabling', 'ischemic', 'ischaemic', 'unplanned',
  'ipsilateral', 'new', 'major', 'fatal', 'all',
])
const OPTIONAL_TOKEN = new Set(['treatment', 'hospital', 'procedure', 'therapy', 'randomisation', 'randomization', 'index'])
const PRIMARY_ROLE = /\b(?:composite\s+)?primary(?:[-\s](?:efficacy|safety))?[-\s](?:end\s?-?points?|outcomes?|events?|composite)|\bprimary[-\s]outcome\s+event|\brate of the primary\b|\bprimary endpoint rate\b|\bprimary events\b/i
const SECONDARY_ROLE = /\bsecondary\s+(?:efficacy\s+|safety\s+|effectiveness\s+|composite\s+)?(?:end\s?-?points?|outcomes?|events?)\b/i
const RESULT_CUE = /\d|%|\b(?:occurred|incidence|rate|rates|similar|differ|higher|lower|reduced|increased)\b/i
const OUTCOME_MENTION = /\bprimary\s+(?:efficacy\s+|safety\s+|effectiveness\s+|composite\s+)?(?:end\s?-?points?|outcomes?)\b/i
const OBJECTIVES_MENTION = /\bprimary\s+(?:objectives?|aims?)\b/i
const MEASURE_DECL = /\bprimary\s+(?:efficacy\s+|safety\s+|effectiveness\s+|composite\s+)?(?:end\s?-?points?|outcomes?)\s+measures?\s+(?:were|was|included|comprised|:|is|are)\s+([^.]{4,500})/gi
const CHANGED_DECL = /\bprimary\s+outcome\s+measures?\s+were\s+changed\s+to\s+([^.]{4,500})/gi
const APPOSITIVE_DECL = /([^.]{4,240}),\s+the\s+primary\s+(?:efficacy\s+|safety\s+|effectiveness\s+|composite\s+)?(?:end\s?-?points?|outcomes?)\s*,\s+(?:was|were)\b/gi
const MAIN_DECL = /\bMAIN\s+OUTCOME\s+MEASURES?:\s*([^.]{4,500})/gi
const COMPOSITE_ASIDE = /\bprimary\s+(?:end\s?-?points?|outcomes?),\s+((?:a\s+)?composite\s+of\s+[^.]{4,400}?)(?:,\s+(?:using|assessed|defined|measured|analyzed|analysed|in\s+patients)\b)/gi

function dropDeclaredExpansions(text, expansions) {
  let s = String(text || '')
  s = s.replace(/\s*[([]\s*(?:defined as|i\.e\.|ie|that is|also known as)\b[^)\]]{0,400}[)\]]/gi, ' ')
  s = s.replace(/\s*[([]\s*[A-Z][A-Z0-9]{1,10}\s*[)\]]/g, ' ')
  s = s.replace(/\b([A-Z][A-Z0-9]{1,10})\s*[([]\s*[^)\]]{8,300}[)\]]/g, (whole, abbrev) => (
    expansions?.has(abbrev) ? abbrev : whole
  ))
  return s
}

function stripComparison(text) {
  let s = String(text || '').replace(STAT_LABEL, ' ')
  const vsAt = s.search(/\b(?:versus|vs\.?|compared(?:\s+with|\s+to)?)\b/i)
  if (vsAt < 0) return s
  const head = s.slice(0, vsAt)
  const comma = head.lastIndexOf(',')
  return comma >= 0 ? head.slice(0, comma) : head.replace(/(?:^|[\s,(])[A-Za-z0-9-]+\s+$/i, ' ')
}

function endpointSurface(text, expansions, { dropExpansions = false } = {}) {
  let s = dropExpansions ? dropDeclaredExpansions(text, expansions) : String(text || '')
  s = s.replace(/^(?:the\s+)?(?:co-?)?primary\s+(?:efficacy\s+|safety\s+|effectiveness\s+|composite\s+)?(?:end\s?-?points?|outcomes?|analysis|composite)\s*[:\-—]?\s*/i, '')
  s = stripComparison(s)
  s = s.replace(/,?\s*\((?:hazard ratio|odds ratio|risk ratio|HR|OR|RR)\)\s*$/i, '')
  s = s.replace(/^(?:(?:a|an|the)\s+)?composite\s+of\s+/i, '')
  s = retainNumberSyntax(normalize(s), { gap: ' ' })
  const words = []
  for (const word of s.split(' ')) {
    if (!word) continue
    if (word === 'mace' && expansions?.has('MACE')) {
      words.push(...endpointSurface(expansions.get('MACE'), null).split(' ').filter(Boolean))
      continue
    }
    const expanded = SURFACE_ALIAS.get(word)
    if (expanded) words.push(...expanded.split(' '))
    else words.push(word)
  }
  s = words.join(' ')
  if (/^adjudicated\b/.test(s) && /\b(?:or|and)\b/.test(s)) s = s.replace(/^(?:adjudicated\s+)+/, '').trim()
  return s
}

function sameEndpointSurface(rowName, declaredClause, expansions) {
  const row = endpointSurface(rowName, expansions)
  const declared = endpointSurface(declaredClause, expansions, { dropExpansions: true })
  return Boolean(row) && row === declared
}

function isGenericEndpointName(name, expansions) {
  const words = endpointSurface(name, expansions).split(' ').filter((word) => word && !RESIDUE_STOP.has(word))
  return words.length === 0
}

function contentTokens(text, expansions) {
  const stripped = String(text || '')
    .replace(/\btime\s+of\s+(?:the\s+)?(?:randomisation|randomization|index(?:\s+\w+)?|procedure|treatment|surgery)\b/gi, ' ')
  return endpointSurface(stripped, expansions, { dropExpansions: true })
    .split(' ')
    .filter((word) => word && !CONTENT_STOP.has(word) && !/^(?:day|days|week|weeks|month|months|year|years)$/.test(word) && !/[\d<>≤≥±%]/.test(word))
}

// Analysis scaffolding left after a statistic label and the arm comparison are
// removed. These words do not name an endpoint, so a sentence made only of them
// can continue the results sentence that does.
const STAT_RESIDUE = new Set([
  'hazard', 'odds', 'relative', 'absolute', 'percent', 'percentage', 'point', 'points',
  'confidence', 'interval', 'adjusted', 'unadjusted', 'covariate', 'prespecified',
  'cox', 'model', 'analysis', 'estimated', 'kaplan', 'meier', 'cumulative',
  'annualized', 'annualised', 'difference', 'risk', 'rate', 'rates', 'proportional',
  'hazards', 'assumption', 'noninferiority', 'non', 'inferiority', 'superiority', 'p',
])

function explicitRelations(text) {
  const found = new Set()
  const re = new RegExp(`\\b(within|at)\\s+(?:(?:${TIME_NUM_SRC})[-\\s]?(?:day|week|month|year)s?)`, 'gi')
  for (const match of String(text || '').matchAll(re)) found.add(match[1].toLowerCase())
  return found
}

function stripFollowUp(text) {
  // A decimal year ("2.7 years") has to be consumed whole. The span below stops
  // at a period, so it would leave ".7 years" and read a 7-year endpoint.
  const duration = String.raw`\d+(?:\.\d+)?\s*(?:day|week|month|year)s?`
  return String(text || '')
    .replace(new RegExp(String.raw`\b(?:over|after|during)\s+(?:a\s+)?median(?:\s+\([^)]*\)|\s+follow-up)?\s+of\s+${duration}`, 'gi'), ' ')
    .replace(new RegExp(String.raw`\bmedian(?:\s+follow-up|\s+duration|\s+of)?\s+(?:follow-up\s+)?of\s+${duration}`, 'gi'), ' ')
    .replace(new RegExp(String.raw`\bfollow-up\s+of\s+${duration}`, 'gi'), ' ')
    .replace(/\b(?:over|after|during)\s+(?:a\s+)?median(?:\s+\([^)]*\)|\s+follow-up)?\s+of\s+[^.;]{0,48}/gi, ' ')
    .replace(/\bmedian(?:\s+follow-up|\s+duration|\s+of)?\s+(?:follow-up\s+)?of\s+[^.;]{0,48}/gi, ' ')
    .replace(/\bfollow-up\s+of\s+[^.;]{0,40}/gi, ' ')
}

function endpointTimes(text) {
  return timesIn(stripFollowUp(text))
}

const ANCHOR_EVENT = 'randomi[sz]ation|surgery|discharge|procedure|enroll?ment'

function canonicalAnchor(word) {
  const text = String(word || '').toLowerCase()
  if (text === 'randomisation') return 'randomization'
  if (text === 'enrolment') return 'enrollment'
  return text
}

// A timepoint is the duration plus the event it is counted from. "30 days
// after surgery" is not "30 days after randomization", and a bare "30 days"
// is not a timepoint that was declared with an anchor.
function timedAnchors(text) {
  const found = []
  const seen = new Set()
  const re = new RegExp(
    String.raw`\b(?:within|at|after|during|following\s+)?(${TIME_NUM_SRC})[-\s]?((?:day|week|month|year)s?)(?:\s+(?:after|following|from)\s+(?:the\s+|an?\s+)?(?:index\s+)?(${ANCHOR_EVENT}))?`,
    'gi',
  )
  for (const match of stripFollowUp(text).matchAll(re)) {
    const time = canonicalTime(match[1], match[2])
    if (!time) continue
    const anchor = match[3] ? canonicalAnchor(match[3]) : ''
    const key = `${time}|${anchor}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ time, anchor })
  }
  return found
}

function anchorConflict(rowText, declared) {
  const declaredWindows = timedAnchors(declared)
  const rowWindows = timedAnchors(rowText)
  if (!rowWindows.length || !declaredWindows.length) return false
  const namesAnchor = new RegExp(String.raw`\b(?:after|following|from)\s+(?:the\s+|an?\s+)?(?:index\s+)?(?:${ANCHOR_EVENT})\b`, 'i')
  for (const row of rowWindows) {
    const sameTime = declaredWindows.filter((item) => item.time === row.time)
    if (!sameTime.length) continue
    if (sameTime.some((item) => item.anchor === row.anchor)) continue
    // "The 4-year primary end point" names the declared endpoint and does not
    // restate its anchor. A clinical timepoint that drops or changes the
    // anchor is a different result.
    if (!row.anchor && !namesAnchor.test(rowText) && PRIMARY_ROLE.test(rowText)) continue
    return true
  }
  return false
}

function timeConflict(declared, sentence) {
  const left = endpointTimes(declared)
  const right = endpointTimes(sentence)
  if (!right.length) return false
  if (!left.length) return true
  const ls = [...left].sort()
  const rs = [...right].sort()
  if (ls.length !== rs.length || ls.some((time, index) => time !== rs[index])) return true
  const declaredRelations = explicitRelations(declared)
  const sentenceRelations = explicitRelations(sentence)
  if (declaredRelations.size && sentenceRelations.size) {
    for (const relation of sentenceRelations) if (!declaredRelations.has(relation)) return true
  }
  return false
}

function populationPhrase(text) {
  const match = String(text || '').match(/\bin\s+patients\s+(?:with|without)\s+[a-z0-9-]+(?:\s+[a-z0-9-]+){0,3}|\bin\s+(?:women|men)\b|\bin\s+the\s+[a-z0-9-]+(?:\s+[a-z0-9-]+){0,3}\s+(?:group|arm)\b/i)
  return match ? normalize(match[0]) : ''
}

function stripArmTails(text) {
  return String(text || '').replace(/\b(?:in|with|receiving)\s+the\s+[a-z0-9-]+(?:\s+[a-z0-9-]+){0,4}\s+(?:group|arm)\b/gi, ' ')
}

function tokensCover(declared, sentence, expansions) {
  const need = contentTokens(declared, expansions)
  const have = contentTokens(stripArmTails(sentence), expansions)
  if (!need.length || timeConflict(declared, sentence)) return false
  const needed = new Set(need)
  const present = new Set(have)
  if (!need.every((word) => present.has(word) || OPTIONAL_TOKEN.has(word))) return false
  for (const word of have) {
    if ((HEAD_WORDS.has(word) || QUALIFIER_TOKEN.has(word)) && !needed.has(word)) return false
  }
  return [...needed].filter((word) => QUALIFIER_TOKEN.has(word)).every((word) => present.has(word))
}

function roleFamily(text) {
  if (/\bsafety\b/i.test(text)) return 'safety'
  if (/\befficacy\b/i.test(text)) return 'efficacy'
  return ''
}

function sameRoleFamily(sentence, declarationSentence) {
  const sentenceRole = roleFamily(sentence)
  const declaredRole = roleFamily(declarationSentence)
  if (sentenceRole === 'safety' && declaredRole !== 'safety') return false
  if (sentenceRole === 'efficacy' && declaredRole === 'safety') return false
  return true
}

const SENTENCE_BOUNDARY = /(?<!\d)[.!?](?:\s+(?=[A-Z])|(?=[A-Z]))/g

function sentenceSpans(text) {
  const spans = []
  let from = 0
  SENTENCE_BOUNDARY.lastIndex = 0
  let mark
  while ((mark = SENTENCE_BOUNDARY.exec(text))) {
    spans.push({ start: from, end: mark.index + 1 })
    from = mark.index + mark[0].length
  }
  if (from < text.length) spans.push({ start: from, end: text.length })
  return spans.length ? spans : [{ start: 0, end: text.length }]
}

function clauseBounds(text, start, end) {
  const spans = sentenceSpans(text)
  const first = spans.find((span) => start >= span.start && start < span.end) || spans[0]
  const last = spans.find((span) => end > span.start && end <= span.end) || spans[spans.length - 1]
  const from = Math.min(first.start, last.start)
  const to = Math.max(first.end, last.end)
  return { start: from, end: to, text: text.slice(from, to).replace(/\s+/g, ' ').trim() }
}

function previousClause(text, start) {
  const spans = sentenceSpans(text)
  const index = spans.findIndex((span) => start >= span.start && start < span.end)
  if (index <= 0) return null
  const span = spans[index - 1]
  return { start: span.start, end: span.end, text: text.slice(span.start, span.end).replace(/\s+/g, ' ').trim() }
}

function quoteSpansConflict(clause, declared, expansions) {
  const parts = clause.split(/;\s*/)
  if (parts.length < 2) return false
  const need = new Set(contentTokens(declared, expansions))
  return parts.some((part) => contentTokens(part, expansions).some((word) => HEAD_WORDS.has(word) && !need.has(word)))
}

function statCue(sentence) {
  return /\b(?:hazard|odds|risk|rate)\s+ratios?\b|\bdifference\b|\bpercentage points\b|\bcredible interval\b|\bconfidence interval\b|\bp\s*[=<]/i.test(sentence)
}

function fragmentTokens(sentence, expansions) {
  let s = String(sentence || '')
  s = s.replace(STAT_LABEL, ' ')
  s = s.replace(/\b(?:in|with|for|between)\s+the\s+[a-z0-9-]+(?:\s+[a-z0-9-]+){0,4}\s+(?:group|arm|strategy|cohort)\b/gi, ' ')
  s = s.replace(/\b(?:as\s+)?compared\s+(?:with|to)\s+(?:the\s+)?[a-z0-9-]+(?:\s+[a-z0-9-]+){0,4}\s+(?:group|arm|strategy|cohort)\b/gi, ' ')
  return contentTokens(s, expansions)
}

function continuationOk(sentence, declared, expansions) {
  if (!RESULT_CUE.test(sentence)) return false
  if (!statCue(sentence)) return false
  if (SECONDARY_ROLE.test(sentence) && !PRIMARY_ROLE.test(sentence)) return false
  if (timeConflict(declared, sentence)) return false
  if (anchorConflict(sentence, declared)) return false
  if (structureConflict(sentence, declared)) return false
  if (unitsConflict(sentence, declared, expansions)) return false
  const residue = fragmentTokens(sentence, expansions)
  if (residue.some((word) => HEAD_WORDS.has(word) || QUALIFIER_TOKEN.has(word))) return tokensCover(declared, sentence, expansions)
  return residue.every((word) => STAT_RESIDUE.has(word))
}

function statGlue(sentence, expansions) {
  if (!RESULT_CUE.test(sentence)) return false
  if (SECONDARY_ROLE.test(sentence) && !PRIMARY_ROLE.test(sentence)) return false
  const stripped = String(sentence || '').replace(/\bp\s*[=<>]\s*[\d.]+/gi, ' ').replace(STAT_LABEL, ' ')
  return contentTokens(stripped, expansions).length === 0
}

function subclauseContaining(sentence, quote) {
  const parts = String(sentence || '').split(/;\s*/)
  const opening = String(quote || '').replace(/\s+/g, ' ').trim().split(';')[0].slice(0, 40)
  if (!opening) return sentence
  const hit = parts.find((part) => part.replace(/\s+/g, ' ').includes(opening))
  return hit || sentence
}

function roleWindow(sentence) {
  const match = String(sentence || '').match(/(?:[\w-]+\s+){0,5}(?:composite\s+)?primary(?:[-\s]\w+){0,6}(?:\s+(?:at|within|after)\s+[^,;]{0,32})?/i)
  return match ? match[0] : ''
}

const COMPONENT_NOUN = new Set(['revascularization', 'reintervention'])
const HARD_QUALIFIER = new Set([
  'cardiovascular', 'disabling', 'ischemic', 'ischaemic', 'unplanned', 'ipsilateral', 'fatal', 'new',
])

function asHead(word) {
  if (HEAD_WORDS.has(word)) return word
  if (COMPONENT_NOUN.has(word)) return word
  for (const head of HEAD_WORDS) if (word.includes(head)) return head
  return ''
}

function termCovers(term, rowSurface, expansions) {
  const words = endpointSurface(term, expansions).split(' ').filter((word) => word.length >= 5 && !/[\d<>≤≥±%]/.test(word))
  return words.length >= 2 && words.every((word) => rowSurface.includes(word))
}

// A parenthesis that lists the events making up a component, not a qualifier
// such as "(leading to hospitalization)" or "(cardiovascular only)".
function isComponentDefinition(inside) {
  const text = String(inside || '').trim()
  if (/^(?:leading to|requiring|resulting in|due to|causing|associated with|related to)\b/i.test(text)) return false
  if (/\bdefined as\b/i.test(text)) return true
  if (!/\bor\b/i.test(text)) return false
  return /\b(?:death|stroke|infarction|bleeding|amputation|hospitali[sz]ation|rehospitali[sz]ation|healing|revascularization|reintervention)\b/i.test(text)
}

function termBeforeParen(before) {
  const match = String(before || '').match(/([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*){0,5})\s*$/)
  if (!match) return ''
  const stop = new Set(['of', 'or', 'and', 'was', 'were', 'a', 'an', 'the', 'composite', 'to', 'endpoint', 'end', 'point', 'outcome'])
  const kept = []
  for (const word of match[1].split(/\s+/).reverse()) {
    if (stop.has(word.toLowerCase())) break
    kept.unshift(word)
  }
  return kept.join(' ')
}

// "MALE, defined as amputation..." and "worsening heart failure (hospitalization
// or an urgent visit)" let a row that names the term stand for those nouns.
function inheritedNouns(rowText, declared, expansions) {
  const rowSurface = endpointSurface(rowText, expansions)
  const extras = []
  const re = /([a-z][^.;]{3,90}?)\s*(?:-\s*)?(?:which was\s+)?defined as\s+([^.;]{3,260})/gi
  for (const match of String(declared || '').toLowerCase().matchAll(re)) {
    if (!termCovers(match[1], rowSurface, expansions)) continue
    extras.push(match[2])
  }
  const raw = String(declared || '')
  for (const match of raw.matchAll(/\(([^)]{8,300})\)/g)) {
    if (!isComponentDefinition(match[1])) continue
    const term = termBeforeParen(raw.slice(Math.max(0, match.index - 90), match.index))
    if (!termCovers(term, rowSurface, expansions)) continue
    extras.push(match[1])
  }
  return extras
}

function withoutComponentDefinitions(text) {
  // Drop the parenthesis first. A "defined as" span does not stop at ")", so it
  // would otherwise eat the rest of the composite ("or cardiovascular death").
  return String(text || '')
    .replace(/\(([^)]{8,300})\)/g, (whole, inside) => (isComponentDefinition(inside) ? ' ' : whole))
    .replace(/(?:which was\s+)?defined as\s+[^.;]{0,300}/gi, ' ')
}

function sliceLabels(text) {
  const found = []
  if (/\bperi-?procedural\b/i.test(text)) found.push('periprocedural')
  if (/\bperi-?operative\b/i.test(text)) found.push('perioperative')
  if (/\bpost-?procedural\b/i.test(text)) found.push('postprocedural')
  if (/\bin-hospital\b/i.test(text)) found.push('in-hospital')
  return found
}

// A row or a sentence that names a different duration, or only the periprocedural
// slice of an endpoint whose horizon is longer, is not that endpoint.
function windowConflict(rowText, declared) {
  const declaredTimes = endpointTimes(declared)
  const rowTimes = endpointTimes(rowText)
  if (rowTimes.length && !declaredTimes.length) return true
  if (rowTimes.some((time) => !declaredTimes.includes(time))) return true
  const rowSlices = sliceLabels(rowText)
  const declaredSlices = sliceLabels(declared)
  if (rowSlices.some((label) => !declaredSlices.includes(label))) return true
  if (rowSlices.length && declaredTimes.length && !rowTimes.length) return true
  const declaredRelations = explicitRelations(declared)
  const rowRelations = explicitRelations(rowText)
  if (declaredRelations.size && rowRelations.size) {
    for (const relation of rowRelations) if (!declaredRelations.has(relation)) return true
  }
  return false
}

// "cardiovascular death" and "cardiovascular hospitalization" are different
// units. The qualifier stays on the noun it was written on; pooling every
// qualifier and every noun would let it move.
function qualifierUnits(text, expansions) {
  // Split while the commas are still commas. The surface normalizer turns them
  // into spaces, and a qualifier would then stick to whichever noun follows.
  const prepared = stripComparison(withoutComponentDefinitions(text))
  const parts = String(prepared).split(/\s*,\s*(?:or\s+|and\s+)?|\s+\band\s*\/\s*or\s+|\s+\bor\b\s+|\s+\band\b\s+/i)
  const units = []
  for (const part of parts) {
    const words = endpointSurface(part, expansions, { dropExpansions: true }).split(' ').filter(Boolean)
    const heads = [...new Set(words.map(asHead).filter(Boolean))]
    const quals = words.filter((word) => HARD_QUALIFIER.has(word)).sort()
    for (const head of heads) units.push(`${quals.join('+')}|${head}`)
  }
  return units.sort()
}

function unitsConflict(name, declared, expansions) {
  const left = qualifierUnits(declared, expansions)
  const right = qualifierUnits(name, expansions)
  if (!left.length || !right.length || left.length !== right.length) return false
  return left.some((unit, index) => unit !== right[index])
}

// A recognized anchor is the event a duration is counted from. Anything else
// after after/from/since is not "no anchor" and is not a match.
const RECOGNIZED_ANCHOR = /^(?:(?:the|a|an)\s+)?(?:(?:index|time\s+of)\s+)?(?:randomi[sz]ation|surgery|discharge|procedure|enroll?ment)$/i

function canonicalAnchorPhrase(phrase) {
  const text = String(phrase || '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!RECOGNIZED_ANCHOR.test(text)) return null
  if (/randomi[sz]ation/.test(text)) return 'randomization'
  if (/surgery/.test(text)) return 'surgery'
  if (/discharge/.test(text)) return 'discharge'
  if (/procedure/.test(text)) return 'procedure'
  if (/enroll?ment/.test(text)) return 'enrollment'
  return null
}

function unrecognizedTimeAnchor(text) {
  const stripped = stripFollowUp(text)
  const re = new RegExp(
    String.raw`\b(?:${TIME_PHRASE})\s+(?:after|following|from|since)\s+((?:(?:the|a|an)\s+)?(?:(?:index|time\s+of)\s+)?[a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,4})`,
    'gi',
  )
  for (const match of stripped.matchAll(re)) {
    const phrase = match[1].split(/\b(?:was|were|occurred|reported|and|or|to)\b/i)[0].trim()
    if (!canonicalAnchorPhrase(phrase)) return true
  }
  return false
}

const BOUND_HEADS = [
  ['myocardial infarction', 'infarction'],
  ['rehospitalization', 'hospitalization'],
  ['rehospitalisation', 'hospitalization'],
  ['hospitalisation', 'hospitalization'],
  ['hospitalization', 'hospitalization'],
  ['infarction', 'infarction'],
  ['amputation', 'amputation'],
  ['bleeding', 'bleeding'],
  ['healing', 'healing'],
  ['stroke', 'stroke'],
  ['death', 'death'],
]
const BOUND_HARD = new Set(['cardiovascular', 'disabling', 'ischemic', 'ischaemic', 'unplanned', 'ipsilateral', 'fatal', 'new'])
const BOUND_SOFT = new Set(['any', 'cause', 'causes', 'all', 'major'])
const BOUND_STOP = new Set(['the', 'a', 'an', 'of', 'from', 'to', 'by', 'for', 'with', 'in', 'on', 'and', 'or', 'only', 'time'])
const ANCHOR_TOKEN = '(?:(?:the|a|an)\\s+)?(?:(?:index|time\\s+of)\\s+)?(?:randomi[sz]ation|surgery|discharge|procedure|enroll?ment)'
const WINDOW_TAIL = new RegExp(
  String.raw`(?:\s+from\s+(${ANCHOR_TOKEN})\s+to)?\s+(?:(within|at|after|during|following)\s+)?(${TIME_PHRASE})(?:\s+(after|following|from|since)\s+(${ANCHOR_TOKEN}))?\s*$`,
  'i',
)

function oneBoundTime(token) {
  const match = String(token || '').match(new RegExp(`^(${TIME_NUM_SRC})[-\\s]?((?:day|week|month|year)s?)$`, 'i'))
  if (!match) return ''
  return canonicalTime(match[1], match[2])
}

function windowFromTail(match) {
  if (!match) return null
  const time = oneBoundTime(match[3])
  if (!time) return undefined
  let anchor = ''
  if (match[4]) {
    anchor = canonicalAnchorPhrase(match[5] || '')
    if (!anchor) return undefined
  }
  let fromAnchor = ''
  if (match[1]) {
    fromAnchor = canonicalAnchorPhrase(match[1])
    if (!fromAnchor) return undefined
  }
  const relation = fromAnchor ? 'to' : canonicalRelation(match[2] || 'at')
  return { relation, time, anchor, fromAnchor }
}

function endpointPhrase(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim()
  s = withoutComponentDefinitions(s)
  s = s.replace(/\s*\((?:hazard ratio|odds ratio|risk ratio|hr|or|rr)\b[^)]*\)/gi, ' ')
  const verb = s.search(/\b(?:occurred|was|were|reported)\b/i)
  if (verb > 0) s = s.slice(0, verb).trim()
  s = s.replace(/^[a-z][a-z\s]{1,24}:\s*/i, '')
  s = s.replace(/^(?:the\s+)?(?:estimated\s+)?(?:\d+(?:\.\d+)?[-\s]?(?:day|week|month|year)s?\s+)?(?:rate|risk|incidence|occurrence)\s+of\s+/i, '')
  s = s.replace(/^(?:(?:a|an|the)\s+)?composite\s+of\s+/i, '')
  s = s.replace(/^(?:the|a|an)\s+/i, '')
  s = s.replace(/[.,;:]\s*$/g, '').trim()
  if (!/\b(?:death|stroke|infarction|bleeding|amputation|hospitali[sz]ation|rehospitali[sz]ation|healing)\b/i.test(s)) return ''
  return s
}

function splitBoundPieces(text) {
  return String(text || '')
    .split(/\s*,\s*(?:or\s+|and\s+)?|\s+\band\s*\/\s*or\s+|\s+\bor\b\s+|\s+\band\b\s+/i)
    .map((part) => part.replace(/^(?:and\/or|and|or)\s+/i, '').replace(/\s+(?:and\/or|and|or)$/i, '').trim())
    .filter(Boolean)
}

function boundWords(part) {
  return String(part || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(Boolean)
}

function readBoundPiece(part, inherited) {
  let text = String(part || '').replace(/\s+/g, ' ').trim()
  let own = null
  const tail = text.match(WINDOW_TAIL)
  if (tail && oneBoundTime(tail[3])) {
    const parsed = windowFromTail(tail)
    if (parsed === undefined) return null
    if (parsed) {
      const rest = text.slice(0, tail.index).trim()
      if (timesIn(rest).length) return null
      own = parsed
      text = rest
    }
  }
  const leading = text.match(new RegExp(String.raw`^(${TIME_PHRASE})\s+`, 'i'))
  if (leading) {
    if (own) return null
    const time = oneBoundTime(leading[1])
    if (!time) return null
    own = { relation: 'at', time, anchor: '', fromAnchor: '' }
    text = text.slice(leading[0].length).trim()
  }
  const window = own || inherited || null
  const words = boundWords(text)
  const quals = []
  let head = ''
  for (let index = 0; index < words.length;) {
    const pair = words.slice(index, index + 2).join(' ')
    const phrase = BOUND_HEADS.find(([label]) => label === pair || label === words[index])
    if (phrase && (phrase[0] === pair || phrase[0] === words[index])) {
      if (head) return null
      head = phrase[1]
      index += phrase[0] === pair ? 2 : 1
      continue
    }
    const word = words[index]
    if (BOUND_HARD.has(word)) quals.push(word === 'ischaemic' ? 'ischemic' : word)
    else if (BOUND_SOFT.has(word)) quals.push(word === 'causes' ? 'cause' : word)
    else if (!BOUND_STOP.has(word)) quals.push(word)
    index += 1
  }
  if (!head) return null
  const keyWindow = window || { relation: '', time: '', anchor: '', fromAnchor: '' }
  return {
    head,
    quals: [...new Set(quals)].sort(),
    window: keyWindow,
  }
}

// Oxford-comma lists are split so each qualifier and each window binds to its
// own noun. The composite is the unordered set of those complete units: written
// order may change, and a qualifier or a window may not move to another noun.
// A piece with two heads, no head, or an unrecognized anchor does not parse.
function boundComponents(text) {
  const phrase = endpointPhrase(text)
  if (!phrase) return { status: 'absent', components: [] }
  if (unrecognizedTimeAnchor(phrase)) return { status: 'uncertain', components: [] }
  let body = phrase
  let shared = null
  const peeled = phrase.match(WINDOW_TAIL)
  if (peeled && oneBoundTime(peeled[3])) {
    const rest = phrase.slice(0, peeled.index).replace(/[,\s]+$/g, '').trim()
    if (rest && !timesIn(rest).length) {
      const parsed = windowFromTail(peeled)
      if (parsed === undefined) return { status: 'uncertain', components: [] }
      if (parsed) {
        shared = parsed
        body = rest
      }
    }
  }
  const components = []
  for (const part of splitBoundPieces(body)) {
    const component = readBoundPiece(part, shared)
    if (!component) return { status: 'uncertain', components: [] }
    components.push(component)
  }
  return components.length ? { status: 'ok', components } : { status: 'uncertain', components: [] }
}

function boundKey(component) {
  const window = component.window || {}
  return [
    component.quals.join('+'),
    component.head,
    window.relation || '',
    window.time || '',
    window.anchor || '',
    window.fromAnchor || '',
  ].join('|')
}

function windowStated(component) {
  return Boolean(component?.window?.time)
}

function windowsCompatible(row, declared) {
  if (!windowStated(row)) return true
  if (!windowStated(declared)) return false
  return boundKey({ ...row, quals: [], head: '' }) === boundKey({ ...declared, quals: [], head: '' })
}

// Order is not part of the unit. "death or stroke" is "stroke or death" when
// each qualifier and each window, including its anchor, stays on the same noun.
function sameBoundComponents(left, right) {
  if (left.length !== right.length) return false
  const used = new Set()
  for (const item of left) {
    const index = right.findIndex((other, i) => (
      !used.has(i)
      && item.head === other.head
      && item.quals.join('+') === other.quals.join('+')
      && windowsCompatible(item, other)
    ))
    if (index < 0) return false
    used.add(index)
  }
  return true
}

// The quote names outcomes. Those outcomes have to be the declared components,
// each qualifier and each window still on its own noun. A list that does not
// parse is not that endpoint.
function structureConflict(text, declared) {
  if (unrecognizedTimeAnchor(text) || unrecognizedTimeAnchor(declared)) return true
  const row = boundComponents(text)
  if (row.status === 'absent') return false
  if (row.status !== 'ok') return true
  const declaredParts = boundComponents(declared)
  if (declaredParts.status !== 'ok') return true
  return !sameBoundComponents(row.components, declaredParts.components)
}

// A component of a composite names some of the declared outcomes and not the rest.
// A harder qualifier the declaration does not use (ischemic, disabling, cardiovascular)
// is a different endpoint, and so is the same qualifier written on a different
// component. "all-cause" and "any cause" are the same unrestricted death.
// A name with no outcome word ("primary end point", "hazard ratio") does not fail here.
function componentConflict(name, declared, expansions) {
  if (unitsConflict(name, declared, expansions)) return true
  const declaredTokens = contentTokens(declared, expansions)
  // Inherited definition nouns are scored on their own. Concatenating them onto a
  // name that says "A vs B" lets the arm strip discard everything after "versus".
  const rowTokens = contentTokens(name, expansions)
  const inheritedTokens = inheritedNouns(name, declared, expansions).flatMap((piece) => contentTokens(piece, expansions))
  const declaredHeads = [...new Set(declaredTokens.map(asHead).filter(Boolean))]
  const rowHeads = [...new Set([...rowTokens, ...inheritedTokens].map(asHead).filter(Boolean))]
  if (rowHeads.length && declaredHeads.length >= 2) {
    if (rowHeads.some((word) => !declaredHeads.includes(word))) return true
    if (declaredHeads.some((word) => !rowHeads.includes(word))) return true
  }
  const declaredQuals = contentTokens(withoutComponentDefinitions(declared), expansions)
    .filter((word) => HARD_QUALIFIER.has(word))
  // Qualifiers count only on the row's own name. A "new graft" inside an inherited
  // definition is not an extra qualifier the row claimed.
  const rowQuals = rowTokens.filter((word) => HARD_QUALIFIER.has(word))
  if (!rowHeads.length) return false
  if (rowQuals.some((word) => !declaredQuals.includes(word))) return true
  if (declaredQuals.some((word) => !rowQuals.includes(word))) return true
  return false
}

function reportsDeclared(clause, declared, declarationSentence, expansions) {
  if (!clause || !sameRoleFamily(clause, declarationSentence)) return null
  if (SECONDARY_ROLE.test(clause) && !PRIMARY_ROLE.test(clause)) return null
  if (windowConflict(clause, declared)) return null
  if (anchorConflict(clause, declared)) return null
  if (structureConflict(clause, declared)) return null
  if (unitsConflict(clause, declared, expansions)) return null
  const population = populationPhrase(declared)
  if (population && populationPhrase(clause) !== population) return null
  if (PRIMARY_ROLE.test(clause) && RESULT_CUE.test(clause) && !timeConflict(declared, roleWindow(clause) || clause)) {
    const clinical = contentTokens(clause, expansions).some((word) => HEAD_WORDS.has(word) || QUALIFIER_TOKEN.has(word))
    if (!clinical || tokensCover(declared, clause, expansions)) return 'role'
  }
  if (tokensCover(declared, clause, expansions) && RESULT_CUE.test(clause)) return 'content'
  return null
}

function cleanDeclaredClause(clause) {
  return String(clause || '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:the|a|an)\s+/i, '')
    .split(/,\s+with\b(?=[^.]*\bsecondary\b)/i)[0]
    .replace(/,?\s+as secondary outcomes?.*$/i, '')
    .replace(/[;,:]\s*$/, '')
    .trim()
}

function earliest(source, regex, group, { noun = null, verb = null } = {}) {
  regex.lastIndex = 0
  let best = null
  for (const match of source.matchAll(regex)) {
    const clause = cleanDeclaredClause(match[group])
    if (clause.length < 4) continue
    if (!best || match.index < best.index) {
      best = {
        index: match.index,
        clause,
        end: match.index + match[0].length,
        noun: noun ? match[noun] : 'outcome',
        verb: verb ? match[verb] : 'was',
      }
    }
  }
  return best
}

function extractDeclaration(source) {
  const candidates = [
    earliest(source, CHANGED_DECL, 1),
    earliest(source, MEASURE_DECL, 1),
    earliest(source, APPOSITIVE_DECL, 1),
    earliest(source, COMPOSITE_ASIDE, 1),
    earliest(source, new RegExp(PRIMARY_DECLARATION.source, 'gi'), 3, { noun: 1, verb: 2 }),
  ].filter(Boolean)
  candidates.sort((a, b) => a.index - b.index)
  const chosen = candidates[0] || null
  if (chosen) {
    const sentence = clauseBounds(source, chosen.index, chosen.end).text
    return { kind: 'outcome', clause: chosen.clause, sentence, noun: chosen.noun, verb: chosen.verb }
  }
  const main = earliest(source, MAIN_DECL, 1)
  // A MAIN OUTCOME MEASURES list of several endpoints is not one declared primary.
  // One outcome, or an explicit composite, still is. "30 day mortality, with ... as
  // secondary outcomes" has already been cut down to the single outcome.
  if (main && !OUTCOME_MENTION.test(source) && !mainClauseIsList(main.clause)) {
    return { kind: 'outcome', clause: main.clause, sentence: clauseBounds(source, main.index, main.end).text, noun: main.noun, verb: main.verb }
  }
  if (OBJECTIVES_MENTION.test(source) && !OUTCOME_MENTION.test(source)) return { kind: 'objectives', clause: '', sentence: '' }
  if (OUTCOME_MENTION.test(source) || DECLARES_PRIMARY.test(source)) return { kind: 'unrecognized', clause: '', sentence: '' }
  if (DECLARES_SECONDARY.test(source)) return { kind: 'secondary-only', clause: '', sentence: '' }
  return { kind: 'none', clause: '', sentence: '' }
}

function mainClauseIsList(clause) {
  if (/\bcomposite\b/i.test(clause)) return false
  const parts = String(clause || '').split(/\s*,\s*|\s+\band\b\s+/i).map((part) => part.trim()).filter((part) => /[a-z]/i.test(part))
  return parts.length >= 2
}

function nameContradicts(name, declaredClause, parsed, expansions, source = '') {
  if (subgroupBlocks(name, source)) return true
  if (!declaredClause || isGenericEndpointName(name, expansions)) return false
  if (sameEndpointSurface(name, declaredClause, expansions)) return false
  const rowParsed = parseDeclaration(['endpoint', 'outcome', 'was', name], expansions)
  if (!parsed?.uncertain && parsed?.endpoints?.length && !rowParsed.uncertain && rowParsed.endpoints.length) {
    if (!parsed.endpoints.some((item) => itemHits(name, item))) return true
  }
  if (componentConflict(name, declaredClause, expansions)) return true
  if (windowConflict(name, declaredClause)) return true
  const declaredPopulation = populationPhrase(declaredClause)
  const rowPopulation = populationPhrase(name)
  if (declaredPopulation && rowPopulation && declaredPopulation !== rowPopulation) return true
  if (!declaredPopulation && rowPopulation) return true
  return false
}

const SUBGROUP_SLICE = /\bsubgroups?\b|\bsubset\b|\bstrat(?:um|a)\b|\bin patients (?:with|without)\b/i

// "<10%" and ">10%" share every clinical word once the operator is dropped.
// When both the declaration and the quote print a comparison, those tokens
// have to be the same. A result percentage with no operator is not compared.
function operatorTokens(text, expansions) {
  return endpointSurface(text, expansions, { dropExpansions: true })
    .split(' ')
    .filter((word) => /[<>≤≥±]/.test(word))
}

function thresholdConflict(quote, declared, expansions) {
  const left = operatorTokens(declared, expansions)
  const right = operatorTokens(quote, expansions)
  if (!left.length || !right.length) return false
  if (left.length !== right.length) return true
  const ordered = [...right].sort()
  return [...left].sort().some((token, index) => token !== ordered[index])
}

// A different outcome, a subgroup, or a secondary result does not become the
// primary by sharing a sentence with it. A bare percentage or a hazard ratio
// does not name another finding.
// A quote that leaves out a declared time or slice is not, by itself, the
// report of that outcome. The surrounding sentence may still be.
function quoteOmitsDeclaredWindow(quote, declared) {
  if (windowConflict(quote, declared)) return true
  if (endpointTimes(declared).length !== endpointTimes(quote).length) return endpointTimes(declared).length > 0
  if (sliceLabels(declared).length !== sliceLabels(quote).length) return sliceLabels(declared).length > 0
  return false
}

function quoteIsDifferentResult(quote, declared, expansions) {
  const flat = String(quote || '').replace(/\s+/g, ' ').trim()
  if (SUBGROUP_SLICE.test(flat) && !SUBGROUP_SLICE.test(declared)) return true
  if (SECONDARY_ROLE.test(flat) && !PRIMARY_ROLE.test(flat)) return true
  if (thresholdConflict(flat, declared, expansions)) return true
  if (anchorConflict(flat, declared)) return true
  if (structureConflict(flat, declared)) return true
  if (unitsConflict(flat, declared, expansions)) return true
  const declaredTokens = contentTokens(declared, expansions)
  const declaredHeads = new Set(declaredTokens.map(asHead).filter(Boolean))
  const declaredQuals = new Set(
    contentTokens(withoutComponentDefinitions(declared), expansions).filter((word) => HARD_QUALIFIER.has(word)),
  )
  const quoteTokens = contentTokens(flat, expansions)
  if (quoteTokens.map(asHead).filter(Boolean).some((word) => !declaredHeads.has(word))) return true
  if (quoteTokens.some((word) => HARD_QUALIFIER.has(word) && !declaredQuals.has(word))) return true
  return false
}

function evidenceBinding(row, source, declared, parsed, expansions) {
  const quote = String(row?.quantity?.source_quote || '').trim()
  if (!quote || !declared.clause) return null
  if (quote.length > Math.max(700, source.length * 0.85)) return null
  const located = locateQuote(source, quote)
  if (!located) return null
  const clause = clauseBounds(source, located.start, located.end)
  const subclause = subclauseContaining(clause.text, quote)
  if (quoteSpansConflict(subclause, declared.clause, expansions)) return null
  if (nameContradicts(String(row?.quantity?.name || ''), declared.clause, parsed, expansions, source)) return null
  const flat = quote.replace(/\s+/g, ' ').trim()
  // The quote has to be the declared outcome, not another result that merely
  // shares the sentence or the passage. Arm wording inside a results sentence
  // ("among patients assigned to") is not itself a subgroup.
  if (quoteIsDifferentResult(flat, declared.clause, expansions)) return null
  const onQuote = reportsDeclared(flat, declared.clause, declared.sentence, expansions)
  if (onQuote && !quoteOmitsDeclaredWindow(flat, declared.clause)) {
    return { kind: onQuote, key: onQuote === 'role' ? 'role' : `content:${clause.start}` }
  }
  const direct = reportsDeclared(subclause, declared.clause, declared.sentence, expansions)
  if (direct) return { kind: direct, key: direct === 'role' ? 'role' : `content:${clause.start}` }
  if (continuationOk(subclause, declared.clause, expansions)) {
    const parts = clause.text.split(/;\s*/)
    const opening = String(quote).replace(/\s+/g, ' ').trim().split(';')[0].slice(0, 40)
    const partIndex = parts.findIndex((part) => part.replace(/\s+/g, ' ').includes(opening))
    let blocked = false
    for (let earlierIndex = partIndex - 1; earlierIndex >= 0; earlierIndex--) {
      const earlier = reportsDeclared(parts[earlierIndex], declared.clause, declared.sentence, expansions)
      if (earlier) return { kind: 'continuation', key: earlier === 'role' ? 'role' : `content:${clause.start}` }
      const bridge = parts[earlierIndex]
      if (!statGlue(bridge, expansions) && !continuationOk(bridge, declared.clause, expansions)) {
        blocked = true
        break
      }
    }
    if (blocked) return null
    const previous = previousClause(source, clause.start)
    if (previous) {
      const previousKind = reportsDeclared(previous.text, declared.clause, declared.sentence, expansions)
      if (previousKind) return { kind: 'continuation', key: previousKind === 'role' ? 'role' : `content:${previous.start}` }
    }
  }
  return null
}

// The paper's primary result, as an EXPLICIT state — never null:
//   { state: 'identified', name, verified, indexes, basis, reason: null }
//       the row's endpoint equals the declared primary, or its source quote
//       reports that outcome itself (name or composite, timepoint, and arms).
//       Sitting in a sentence or passage that mentions the primary is not
//       enough. A statistic fragment may continue the results sentence that
//       does report it. A generic "primary (efficacy) composite outcome"
//       name matches only through that quote. It is not secondary, a subgroup,
//       or a per-protocol / as-treated analysis (per-protocol noninferiority is
//       allowed). A component of that composite, a different time window, and a
//       subgroup comparison (X vs no X, with versus without) are not those rows.
//       X vs no X stays when the assignment sentence names no X, no treatment,
//       or usual care without X as an arm. A component's definition does not
//       reject a row that names the composite at that defined term.
//       verified: any of the rows that remain passes the call site's predicate,
//       never a verified component that was excluded.
//   { state: 'unknown', ..., reason }  results were extracted but none is the
//       primary. reason says which check failed. triage() withholds the finding
//       and the card carries that reason.
//   { state: 'unspecified', ... }  the source never states an outcome, including
//       a paper whose only "primary" line is an objective or aim. Verified
//       results may be summarized; none of them is called the primary.
//   { state: 'no-results', ... }  nothing was extracted.
// Qualifiers, components, populations, time windows, and arm labels stay put.
// Two quote candidates that are not the same results sentence stay unknown.
// The word "primary" inside a quote is not itself a label.
export function findPrimary(rows, isVerified = (row) => !row?.verdict?.flagged, sourceText = '') {
  const list = Array.isArray(rows) ? rows : []
  const none = (state, reason = null) => ({ state, name: null, verified: false, indexes: [], basis: null, reason })
  if (!list.length) return none('no-results')
  const eligible = (row) => {
    const tags = tagResult(row?.quantity)
    const name = row?.quantity?.name
    return !nonRandomized(tags) && !subgroupBlocks(name, source) && !tags.secondary
      && !comparisonMissesRandomizedArms(name, source)
  }
  const identified = (indexes, basis) => ({
    state: 'identified',
    name: String(list[indexes[0]]?.quantity?.name || ''),
    verified: indexes.some((i) => isVerified(list[i])),
    indexes,
    basis,
    reason: null,
  })
  const source = String(sourceText || '')
  const declared = source ? extractDeclaration(source) : { kind: 'none', clause: '', sentence: '' }
  if (declared.kind === 'objectives') {
    const indexes = list.flatMap((row, i) => (eligible(row) ? [i] : []))
    return {
      state: 'unspecified',
      name: null,
      verified: indexes.some((i) => isVerified(list[i])),
      indexes,
      basis: 'no-declared-primary',
      reason: null,
    }
  }
  if (declared.kind === 'outcome' || declared.kind === 'unrecognized' || declared.kind === 'secondary-only') {
    const expansions = abbreviationExpansions(source)
    const primaryParsed = declared.clause
      ? parseDeclaration(['', declared.noun || 'outcome', declared.verb || 'was', declared.clause], expansions)
      : { endpoints: [], uncertain: true }
    const nameIndexes = declared.clause ? list.flatMap((row, i) => {
      const name = String(row?.quantity?.name || '')
      const tags = tagResult(row?.quantity)
      if (isGenericEndpointName(name, expansions)) return []
      if (sameEndpointSurface(name, declared.clause, expansions)) {
        if (nonRandomized(tags) || subgroupBlocks(name, source) || comparisonMissesRandomizedArms(name, source)) return []
        return [i]
      }
      if (!eligible(row) || primaryParsed.uncertain || !primaryParsed.endpoints.length) return []
      return matchesDeclared(row, primaryParsed.endpoints) ? [i] : []
    }) : []
    if (nameIndexes.length) return identified(nameIndexes, 'source')
    if (!declared.clause) {
      return none('unknown', declared.kind === 'secondary-only'
        ? PRIMARY_UNBOUND_REASON
        : PRIMARY_UNRECOGNIZED_REASON)
    }
    const bound = []
    list.forEach((row, index) => {
      if (!eligible(row)) return
      const hit = evidenceBinding(row, source, declared, primaryParsed, expansions)
      if (hit) bound.push({ index, ...hit })
    })
    const contentKeys = new Set(bound.filter((hit) => hit.key.startsWith('content')).map((hit) => hit.key))
    if (contentKeys.size > 1 && !bound.some((hit) => hit.key === 'role')) {
      return none('unknown', PRIMARY_AMBIGUOUS_REASON)
    }
    if (bound.length) return identified(bound.map((hit) => hit.index), 'evidence')
    return none('unknown', PRIMARY_UNBOUND_REASON)
  }
  for (const [basis, test] of LABEL_BASES) {
    const indexes = list.flatMap((row, i) => (eligible(row) && test(row?.quantity) ? [i] : []))
    if (indexes.length) return identified(indexes, basis)
  }
  if (!source) return none('unknown')
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
    reason: null,
  }
}

export const PRIMARY_UNBOUND_REASON =
  "The paper states a primary outcome, but no extracted result's quote is bound to that outcome or to the results sentence that reports it."
export const PRIMARY_AMBIGUOUS_REASON =
  'More than one extracted result could be the primary, so none was selected.'
export const PRIMARY_UNRECOGNIZED_REASON =
  'The paper mentions a primary result, but the outcome sentence was not one of the forms the app can read.'

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
