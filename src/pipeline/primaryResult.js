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
const DECLARATION = (which) => new RegExp(`\\b${which}\\s+(?:efficacy\\s+|safety\\s+|effectiveness\\s+|composite\\s+)?${NOUN}\\s+(were|was|included|comprised|:)\\s+([^.]{4,500})`, 'i')
const PRIMARY_DECLARATION = DECLARATION('primary')
const SECONDARY_DECLARATION = DECLARATION('secondary')
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
const QUALIFIER_PHRASE = /^(?:requiring|related(?:\s+to)?|due(?:\s+to)?|associated(?:\s+with)?|stratified(?:\s+by)?|caused(?:\s+by)?|secondary(?:\s+to)?|adjudicated|confirmed|excluding|including|limited(?:\s+to)?|restricted(?:\s+to)?)\b/i
const STOP_WORDS = new Set(['only', 'the', 'a', 'an', 'of', 'by', 'with', 'from', 'to', 'for', 'and', 'or'])

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
// abbreviation, a one-word qualifier folded into its component, or — anything
// else — an extra outcome kept as its own component. A time mixed with other
// words, or a decoration with no content, is unparsed.
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
      const qualifierPhrase = words.length === 1 || QUALIFIER_PHRASE.test(inner.replace(/§\d+§/g, ' '))
      if (windows) {
        markers.push({ kind: 'window', value: windows })
        replacement = ` §${markers.length - 1}§ `
      } else if (timesIn(inner.replace(/§\d+§/g, ' ')).length || words.length === 0) {
        return { text: current, markers, uncertain: true }
      } else if (qualifierPhrase) {
        markers.push({ kind: 'qualifier', value: words })
        replacement = ` §${markers.length - 1}§ `
      } else {
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

function qualifierSplit(text) {
  const match = String(text || '').match(new RegExp(`^(.*?)(?:\\s+)(${QUALIFIER_PHRASE.source.slice(1)})`, 'i'))
  if (!match || !match[1].trim()) return null
  const end = match[1].length
  return { head: match[1].trim(), qualifier: text.slice(end).trim() }
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
  if (part && QUALIFIER_PHRASE.test(part) && !timesIn(part).length) {
    return { qualifierOnly: true, qualifiers: [...new Set([...qualifiers, ...contentWords(part)])].sort() }
  }
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
  const bound = qualifierSplit(part)
  if (bound) {
    qualifiers.push(...contentWords(bound.qualifier))
    part = bound.head
  }
  part = part.replace(/^(?:the|a|an)\s+/i, '').replace(/\s+/g, ' ').trim()
  if (timesIn(part).length || /§\d+§|[()[\]]/.test(part)) return null
  // "from" is a stop word, so a leftover anchor intro has to be rejected on the
  // raw text. "after" and "following" are relation words as well.
  if (LOOSE_ANCHOR.test(part) || contentWords(part).some((word) => RELATION_WORD.test(word))) return null
  if (!part && !abbrevs.length && !qualifiers.length) return undefined
  if ((inherited || []).length && own.length && !sameWindowSet(inherited, own)) return null
  const windows = dedupeWindows(own.length ? own : inherited)
  if (/^[A-Z][A-Z0-9]{1,10}$/.test(part) && !abbrevs.includes(part)) abbrevs.push(part)
  const headWords = wordBag(part)
  if (!headWords.length && !abbrevs.length && !qualifiers.length) return undefined
  if (headWords.length && headWords.every((word) => word.length < 3) && !abbrevs.length) return null
  return { headWords, qualifiers: [...new Set(qualifiers)].sort(), abbrevs, windows, head: part }
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
function matchesDeclared(row, primaryItems, secondaryItems) {
  const name = String(row?.quantity?.name || '')
  if (secondaryItems.some((item) => itemHits(name, item))) return false
  return primaryItems.some((item) => itemHits(name, item))
}

// The paper's primary result, as an EXPLICIT state — never null:
//   { state: 'identified', name, verified, indexes, basis }  the row's endpoint equals
//       the declared primary (each component, with its qualifiers and window), or — only when the source
//       declares neither a primary nor a secondary — the row's name or location hint
//       says primary. It is not secondary, a subgroup, or a per-protocol / as-treated
//       analysis (per-protocol noninferiority is allowed). verified: any primary row
//       passes the call site's verified predicate.
//   { state: 'unknown', name: null, verified: false, indexes: [] }  results were extracted
//       but none is the primary — the declaration does not parse, no row equals it, or
//       the source names a primary the app cannot bind. The main finding is then
//       WITHHELD by triage(): it cannot be weighed against a primary the app cannot name.
//   { state: 'unspecified', ... }  the source text was supplied and it never declares a
//       primary or a secondary endpoint (a meta-analysis that pools named outcomes, for
//       example). Verified results may be summarized; none of them is called the primary.
//   { state: 'no-results', name: null, verified: false, indexes: [] }  nothing was extracted
//       (narrative review, methods paper, extraction error). There is no result to headline;
//       the finding is number-free by construction (empty verified set) and model-checked.
// rows: runPaper rows [{ quantity, verdict }]. isVerified: the call site's own predicate.
// sourceText: the abstract or full text, when the caller has it. Omitted, an unlabelled
// row is still unknown — position never promotes a row (REV2). Identification against a
// declaration succeeds only when the row's endpoint equals the declared one:
// an order-independent set of (component, qualifiers of that component, window)
// tuples. A window is its relation, duration, and anchor event, and the anchor
// has to be the same event or both absent. An abbreviation is a synonym for the
// single component it follows. A parenthetical or bracket that is not a window
// or that abbreviation stays on that component, or becomes another component
// when it is a separate outcome. A token that fits none of those slots —
// component, qualifier of that component, window relation, duration, anchor, or
// abbreviation — leaves the declaration or the row unidentified. Quote text is
// never an identification path.
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
  const source = String(sourceText || '')
  // A declared primary is the only definition that counts. Name, location, and
  // quote labels are not consulted, and a declaration that does not parse is
  // unidentified rather than a reason to trust those labels.
  if (source && (DECLARES_PRIMARY.test(source) || DECLARES_SECONDARY.test(source))) {
    const expansions = abbreviationExpansions(source)
    const primaryParsed = parseDeclaration(source.match(PRIMARY_DECLARATION), expansions)
    const secondaryParsed = parseDeclaration(source.match(SECONDARY_DECLARATION), expansions)
    if (primaryParsed.uncertain || secondaryParsed.uncertain || !primaryParsed.endpoints.length) return none('unknown')
    const indexes = list.flatMap((row, i) => (eligible(row) && matchesDeclared(row, primaryParsed.endpoints, secondaryParsed.endpoints) ? [i] : []))
    if (indexes.length) return identified(indexes, 'source')
    return none('unknown')
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
