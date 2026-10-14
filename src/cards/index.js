// cards/index.js — the evidence index: everything the checker, inventory and renderer read
// about a source, built deterministically before any claim is looked at.
//
// Everything downstream binds to this index, never to raw text: sections and their
// availability, sentences, printed group / cohort labels, abbreviations, outcome definitions
// (core endpoint, components, disjuncts), outcome phrases with the estimate tuple each one
// owns, design words, and every number with the ROLE and OWNER its local syntax gives it (a
// percent "in the X group" belongs to arm X; a timepoint carries its unit and its sense —
// median follow-up, minimum follow-up, fixed horizon, duration; an interval carries its
// confidence level or the fact that it is an unlabeled bracket). A number whose role cannot
// be read from syntax gets no role and can never satisfy a claim element. Nothing here is
// paper-specific.

import { normalize, extractNumbersWithIndex, tokens, acronyms } from './text.js'

const SECTION_MAP = [
  [/^(background|introduction|importance|objectives?|purpose|aims?|context|rationale)$/, 'background'],
  [/^(methods?|design, setting, and participants|design|setting|participants|interventions?|main outcomes? and measures?|search methods|selection criteria|data collection and analysis|patients and methods|materials and methods|methods and results)$/, 'methods'],
  [/^(results?|findings|main results)$/, 'results'],
  [/^(conclusions?|interpretation|authors' conclusions|conclusions and relevance|discussion|funding|trial registration|registration)$/, 'conclusions'],
]
const LABEL_RE = /(?:^|\s)([a-z][a-z' ,]{2,45}?):\s/g
const sectionOf = (label) => (SECTION_MAP.find(([re]) => re.test(label)) || [])[1] || null

function splitSections(norm) {
  const marks = []
  for (const m of norm.matchAll(LABEL_RE)) {
    const name = sectionOf(m[1].trim())
    if (name) marks.push({ name, start: m.index + m[0].length, labelStart: m.index })
  }
  if (!marks.length) return { sections: [{ name: 'body', start: 0, end: norm.length }], title: '', labeled: false }
  const title = norm.slice(0, marks[0].labelStart).trim()
  const sections = marks.map((mk, i) => ({ name: mk.name, start: mk.start, end: i + 1 < marks.length ? marks[i + 1].labelStart : norm.length }))
  return { sections, title, labeled: true }
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[a-z(\d"'])/g
function splitSentences(norm, section) {
  const out = []
  let pos = section.start
  for (const piece of norm.slice(section.start, section.end).split(SENTENCE_SPLIT)) {
    const start = norm.indexOf(piece, pos)
    if (start < 0) continue
    out.push({ section: section.name, start, end: start + piece.length, text: piece })
    pos = start + piece.length
  }
  return out
}

// ---- numbers with roles ----------------------------------------------------------------
const MEASURES = [
  ['adjusted hazard ratio', 'aHR'], ['hazard ratio', 'HR'], ['ahr', 'aHR'], ['hr', 'HR'],
  ['adjusted odds ratio', 'aOR'], ['odds ratio', 'OR'], ['aor', 'aOR'], ['or', 'OR'],
  ['relative risk', 'RR'], ['risk ratio', 'RR'], ['rr', 'RR'], ['rate ratio', 'IRR'], ['irr', 'IRR'],
  ['mean difference', 'MD'], ['md', 'MD'], ['absolute risk difference', 'RD'], ['risk difference', 'RD'],
]
const MEASURE_ALT = MEASURES.map(([w]) => w.replace(/ /g, '\\s+')).join('|')
const NUM = String.raw`-?\d+(?:\.\d+)?`
const TUPLE_RE = new RegExp(String.raw`\b(${MEASURE_ALT})(?:\s*\[(?:a?hr|a?or|rr|ci)\])?\s*(?:,|:|was|of|=|,\s*was)?\s*(${NUM})\s*(?:(?:metres|meters|percentage points|mm ?hg|cm|mm|m)\b)?\s*(?:[;,(]\s*)?(\[)?\s*(?:(\d+(?:\.\d+)?)%\s*(?:confidence interval|ci|credible interval)(?:\s*\[ci\])?\s*[,:]?\s*)?(${NUM})\s*(?:to|-)\s*(${NUM})\s*\]?\)?(?:\s*[;,]?\s*p\s*([<=>])\s*(\d*\.?\d+))?`, 'g')
const UNIT_RE = new RegExp(String.raw`(${NUM})\s*(metres|meters|percentage points|mm ?hg)`, 'g')
// "302 of 709 patients (42.6%) in the surgical group" and "108 (63%) of 172 patients in the vein bypass group"
const ARM_COUNT_RE = /(\d+) of (\d+) (?:patients|participants|people)? ?\((\d+(?:\.\d+)?)%\) (?:in|of) the ([a-z][a-z -]{1,40}?) (?:group|arm)\b/g
const ARM_COUNT_RE_2 = /(\d+) \((\d+(?:\.\d+)?)%\) of (\d+) (?:patients|participants|people) (?:in|of) the ([a-z][a-z -]{1,40}?) (?:group|arm)\b/g
const ARM_PCT_RE = /(\d+(?:\.\d+)?)% (?:\([^)]*\) )?(?:in|of) the ([a-z][a-z -]{1,40}?) (?:group|arm)\b/g
const TIME_RE = /(?<![\d.])(\d+(?:\.\d+)?)(?:\s|-)(years?|months?|weeks?|days?)\b/g
const ENROLL_RE = /(?:enrolled|randomi[sz]ed|randomly assigned|included|analysed|analyzed)\s+(\d+)\s+(?:patients|participants|people|adults|women|men)|(\d+)\s+(?:patients|participants|people).{0,220}?(?:were enrolled|underwent randomi[sz]ation|were randomly assigned|were randomised|were randomized|were included)/g
const P_RE = /\bp\s*([<=>])\s*(\d*\.\d+)/g
const CI_LABEL_RE = /(\d+(?:\.\d+)?)%\s*(?:ci|confidence interval|credible interval)\b/g

// The sense of a timepoint, from the words before it.
function timeSense(before) {
  const b = before.slice(-60)
  if (/\b(?:median|mean) (?:follow-up |duration )?(?:of |was )?$/.test(b) || /\bmedian (?:follow-up )?(?:of )?$/.test(b)) return 'median-follow-up'
  if (/\b(?:minimum|at least|a minimum of)\s*(?:of )?$/.test(b)) return 'minimum-follow-up'
  if (/\b(?:for|lasting|over|duration of|ranged from|from|to)\s*$/.test(b)) return 'duration'
  if (/\b(?:at|by|within|after|through)\s*$/.test(b)) return 'fixed'
  return 'fixed'
}

function pushRole(list, start, role, extra = {}) {
  const t = list.find((x) => x.start === start)
  if (t && !t.role) Object.assign(t, { role, ...extra })
}
function indexOfNum(text, value, from = 0) {
  const re = new RegExp(String.raw`(?<![\d.])${String(value).replace('.', '\\.')}(?![\d.])`, 'g')
  re.lastIndex = from
  const m = re.exec(text)
  return m ? m.index : -1
}

function roleNumbers(sentence) {
  const text = sentence.text
  const nums = extractNumbersWithIndex(text).map((t) => ({ ...t, role: null }))
  const tuples = []
  for (const m of text.matchAll(TUPLE_RE)) {
    const measure = MEASURES.find(([w]) => w === m[1].replace(/\s+/g, ' '))?.[1]
    const value = parseFloat(m[2])
    const bracket = !!m[3] && !m[4]
    const label = m[4] ? `${m[4]}% CI` : bracket ? 'printed-bracket' : null
    const low = parseFloat(m[5]); const high = parseFloat(m[6])
    const p = m[8] != null ? { op: m[7], value: parseFloat(m[8]) } : null
    const unit = (new RegExp(String.raw`${m[2]}\s*(metres|meters|percentage points|mm ?hg)`).exec(text) || [])[1] || null
    const start = m.index
    const tuple = { measure, value, low, high, label, p, unit, start, end: start + m[0].length, owner: null }
    tuples.push(tuple)
    pushRole(nums, indexOfNum(text, m[2], start), 'estimate', { measure, tuple })
    pushRole(nums, indexOfNum(text, m[5], start + m[0].indexOf(m[5], m[2].length)), 'ci-low', { tuple })
    pushRole(nums, indexOfNum(text, m[6], start + m[0].lastIndexOf(m[6])), 'ci-high', { tuple })
    if (p) pushRole(nums, indexOfNum(text, m[8], start + m[0].lastIndexOf(m[8])), 'p', { tuple })
  }
  for (const m of text.matchAll(ARM_COUNT_RE)) {
    const arm = m[4].trim()
    pushRole(nums, m.index, 'count', { arm })
    pushRole(nums, indexOfNum(text, m[2], m.index + m[1].length), 'denominator', { arm })
    pushRole(nums, indexOfNum(text, m[3], m.index + m[0].indexOf('(')), 'percent', { arm })
  }
  for (const m of text.matchAll(ARM_COUNT_RE_2)) {
    const arm = m[4].trim()
    pushRole(nums, m.index, 'count', { arm })
    pushRole(nums, indexOfNum(text, m[2], m.index + m[1].length), 'percent', { arm })
    pushRole(nums, indexOfNum(text, m[3], m.index + m[0].indexOf(') of')), 'denominator', { arm })
  }
  for (const m of text.matchAll(ARM_PCT_RE)) pushRole(nums, m.index, 'percent', { arm: m[2].trim() })
  for (const m of text.matchAll(CI_LABEL_RE)) pushRole(nums, m.index, 'ci-label')
  for (const m of text.matchAll(TIME_RE)) pushRole(nums, m.index, 'timepoint', { unit: m[2].replace(/s$/, ''), sense: timeSense(text.slice(0, m.index)) })
  for (const m of text.matchAll(ENROLL_RE)) pushRole(nums, indexOfNum(text, m[1] || m[2], m.index), 'enrollment')
  for (const m of text.matchAll(/\b(cohort|grade|stratum|phase|group)\s(\d+)\b/g)) pushRole(nums, m.index + m[1].length + 1, 'label')
  for (const m of text.matchAll(P_RE)) pushRole(nums, indexOfNum(text, m[2], m.index), 'p')
  for (const m of text.matchAll(UNIT_RE)) { const t = nums.find((x) => x.start === m.index); if (t) t.unit = m[2] }
  const pair = /(\d+(?:\.\d+)?)% (?:vs\.?|versus) (\d+(?:\.\d+)?)%/.exec(text)
  if (pair) {
    const armsBefore = sentence.armsMentioned.filter((a) => a.pos < pair.index)
    if (armsBefore.length >= 2) {
      pushRole(nums, pair.index, 'percent', { arm: armsBefore[0].label, ownerBasis: 'vs-order' })
      pushRole(nums, indexOfNum(text, pair[2], pair.index + pair[1].length), 'percent', { arm: armsBefore[1].label, ownerBasis: 'vs-order' })
    }
  }
  return { nums, tuples }
}

// ---- labels and abbreviations ------------------------------------------------------------
const ARM_RE = /\b(?:in|of|to|for|between) the ([a-z][a-z-]*(?: [a-z-]+){0,3}?) (?:group|arm)\b/g
const NOT_ARM = new Set(['two', 'both', 'each', 'either', 'other', 'same', 'control', 'treatment', 'first', 'second', 'latter', 'former', 'study'])
const COHORT_RE = /\b(cohort \d+|[a-z-]+ trial|[a-z-]+ cohort|(?:pcb )?grade \d+|stratum [a-z0-9]+)\b/g
const NOT_COHORT_FIRST = new Set(['to', 'in', 'of', 'the', 'a', 'an', 'each', 'this', 'per', 'and', 'or', 'from', 'with', 'within', 'by', 'for', 'both', 'two', 'one', 'that', 'whole', 'entire', 'same', 'other', 'single', 'multicentre', 'multicenter', 'phase', 'controlled', 'randomised', 'randomized', 'clinical', 'pragmatic', 'international', 'observer-blinded', 'open-label', 'parallel-cohort', 'matched', 'retrospective', 'prospective', 'study', 'present', 'current', 'our', 'blinded', 'label'])
function findLabels(norm) {
  const arms = new Set(), cohorts = new Set()
  for (const m of norm.matchAll(ARM_RE)) { const l = m[1].trim(); if (!NOT_ARM.has(l.split(' ')[0]) && l.length > 2) arms.add(l) }
  for (const m of norm.matchAll(COHORT_RE)) { const l = m[1].trim(); if (!NOT_COHORT_FIRST.has(l.split(' ')[0])) cohorts.add(l) }
  return { arms: [...arms], cohorts: [...cohorts] }
}
// "retinal artery occlusion (rao)" → rao: [retinal, artery, occlusion]; only when initials match.
function findAbbreviations(norm) {
  const map = new Map()
  for (const m of norm.matchAll(/([a-z][a-z-]+(?: [a-z][a-z-]+){0,5}) \(([a-z]{2,6})\)/g)) {
    const words = m[1].split(' ')
    for (let n = Math.min(words.length, 6); n >= 2; n--) {
      const tail = words.slice(-n)
      if (tail.map((w) => w[0]).join('') === m[2] || tail.flatMap((w) => w.split('-').map((x) => x[0])).join('') === m[2]) { map.set(m[2], tokens(tail.join(' '))); break }
    }
  }
  return map
}
// Expand abbreviations inside a token list.
const expand = (toks, abbr) => toks.flatMap((t) => (abbr.get(t) ? [t, ...abbr.get(t)] : [t]))

// ---- outcome definitions ---------------------------------------------------------------
const DEF_RE = /\b(primary|co-primary|secondary|key secondary) (?:efficacy |safety |composite )?(?:outcomes?|end ?points?|outcome measures?)\s+(?:was|were|is|are|included|consisted of|comprised|defined as)\s+(.+)/
function findDefinitions(sentences, abbr) {
  const defs = []
  for (const s of sentences) {
    const m = DEF_RE.exec(s.text)
    if (!m) continue
    const rest = m[2].replace(/[.;]\s*$/, '')
    let core = rest, components = ''
    let d = /^(.*?)\s-\s(?:which (?:was|were|is) )?defined as\s+(.*?)\s-\s(.*)$/.exec(rest)
    if (d) { core = `${d[1]} ${d[3]}`; components = d[2] }
    else if ((d = /^(.*?)\s*,?\s*(?:which (?:was|were|is) )?defined as\s+(.*)$/.exec(rest))) { core = d[1]; components = d[2] }
    else components = [...rest.matchAll(/\(([^)]+)\)/g)].map((x) => x[1]).join(' ')
    const coreClean = core.replace(/\s*\([^)]*\)/g, '')
    const coreTokens = new Set(expand(tokens(coreClean), abbr))
    for (const a of acronyms(coreClean)) coreTokens.add(a)
    const coreDisjuncts = coreClean.split(/\s+or\s+/).map((x) => new Set(expand(tokens(x), abbr))).filter((x) => x.size)
    const componentDisjuncts = components.split(/\s+or\s+|,\s*|\s+and\s+/).map((x) => new Set(expand(tokens(x), abbr))).filter((x) => x.size)
    const componentTokens = new Set(expand(tokens(components), abbr))
    defs.push({ role: m[1].replace('key ', ''), sentence: s, text: rest, core: coreClean, coreTokens, coreDisjuncts, componentTokens, componentDisjuncts, allTokens: new Set([...coreTokens, ...componentTokens]) })
  }
  return defs
}

// ---- outcome phrases and tuple ownership ------------------------------------------------
const STAT = new Set(['hazard', 'ratio', 'confidence', 'interval', 'ci', 'adjusted', 'odds', 'relative', 'absolute', 'difference', 'mean', 'median', 'significantly', 'significant', 'higher', 'lower', 'increased', 'reduced', 'greater', 'better', 'worse', 'associated', 'compared', 'incidence', 'likelihood', 'probability', 'annual', 'cumulative', 'crude', 'unadjusted', 'estimated', 'overall'])
const PHRASE_PATTERNS = [
  // "higher risk of major amputation (" / "odds of experiencing headache compared"
  /(?:risks?|odds|rates?|incidence|hazard|likelihood|probability|chances?) of (?:experiencing |developing |having |a |an |the )?([a-z][a-z0-9 /-]{2,80}?)(?=\s*(?:\(|,|;|:|\bcompared\b|\bthan\b|\bin the\b|\bat \d|\bwas\b|\bwere\b|\bafter\b|\bwithin\b|\bby\b|$))/g,
  // "associated with a better amputation-free survival,"
  /(?:associated with|led to|resulted in) (?:an? )?(?:significantly )?(?:better|worse|higher|lower|greater|reduced|improved|increased|similar|more|fewer|less)? ?([a-z][a-z0-9 /-]{2,60}?)(?=\s*(?:,|;|\(|\bthan\b|\bin the\b|\bcompared\b|\bwhich\b|\bat \d|$))/g,
  // sentence subject: "[in cohort 1, ..., ] major amputation or death occurred" / "the 4-year rate of the primary outcome was"
  /(?:^|,\s*)(?:an? |the )?(?:\d+-year rate of |\d+-year incidence of |rate of |incidence of )?(?:an? |the )?([a-z][a-z0-9 /-]{2,80}?) (?:occurred|was|were|did not differ|developed|happened)\b/g,
]
function outcomePhrases(sentence, abbr) {
  const text = sentence.text
  const armWords = new Set(sentence.armsMentioned.flatMap((a) => tokens(a.label)))
  const out = []
  for (const re of PHRASE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[1].replace(/^(?:an? |the )/, '').trim()
      const toks = expand(tokens(raw), abbr).filter((t) => !STAT.has(t) && !armWords.has(t) && !/^\d/.test(t))
      const refersPrimary = /\bprimary[- ](?:outcome|end ?point)/.test(raw)
      const refersSecondary = /\bsecondary[- ](?:outcome|end ?point)/.test(raw)
      if (!toks.length && !refersPrimary && !refersSecondary) continue
      const start = m.index + m[0].indexOf(m[1])
      out.push({ text: raw, start, end: start + raw.length, refersPrimary, refersSecondary, tokens: new Set(toks), disjuncts: raw.split(/\s+or\s+/).map((x) => new Set(expand(tokens(x), abbr).filter((t) => !STAT.has(t)))).filter((x) => x.size) })
    }
  }
  if (/\bdied\b/.test(text)) { const i = text.search(/\bdied\b/); out.push({ text: 'death', start: i, end: i + 4, tokens: new Set(['death']), disjuncts: [new Set(['death'])] }) }
  out.sort((a, b) => a.start - b.start)
  // each tuple is owned by the nearest outcome phrase that precedes it
  for (const t of sentence.tuples) {
    const before = out.filter((p) => p.end <= t.start)
    t.owner = before.length ? before[before.length - 1] : null
  }
  return out
}

function detectDesign(norm) {
  const randomized = /\brandomi[sz]ed\b|\brandomly assigned\b/.test(norm)
  const review = /\bsystematic review\b|\bmeta-analysis\b|\bwe included \d+ .{0,40}(trials|studies)\b|\bcochrane\b/.test(norm)
  const observational = !randomized && /\bretrospective\b|\bcohort study\b|\bpropensity\b|\bregistry\b|\bobservational\b|\breviewed\b/.test(norm)
  return { randomized, review, observational, matched: /\bpropensity\b|\bmatched\b/.test(norm), openLabel: /\bopen-label\b|\bnon-blinded\b|\bunblinded\b/.test(norm), parallel: /\bparallel/.test(norm) }
}

export function buildIndex(source) {
  const norm = normalize(source.text)
  const { sections, title, labeled } = splitSections(norm)
  const labels = findLabels(norm)
  const abbr = findAbbreviations(norm)
  const sentences = sections.flatMap((sec) => splitSentences(norm, sec)).map((s, i) => {
    const armsMentioned = []
    for (const label of labels.arms) {
      const re = new RegExp(`\\b${label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')} (?:group|arm)\\b`, 'g')
      for (const m of s.text.matchAll(re)) armsMentioned.push({ label, pos: m.index })
    }
    armsMentioned.sort((a, b) => a.pos - b.pos)
    const cohortsMentioned = labels.cohorts.filter((c) => s.text.includes(c))
    const base = { ...s, i, armsMentioned, cohortsMentioned }
    const { nums, tuples } = roleNumbers(base)
    const withTuples = { ...base, nums, tuples }
    const phrases = outcomePhrases(withTuples, abbr)
    return { ...withTuples, phrases }
  })
  const definitions = findDefinitions(sentences, abbr)
  const available = {
    results: !labeled || sections.some((s) => s.name === 'results' || s.name === 'conclusions'),
    methods: !labeled || sections.some((s) => s.name === 'methods' || s.name === 'body'),
  }
  return { norm, title, labeled, sections, sentences, labels, abbr, definitions, design: detectDesign(norm), available }
}

export function sentencesInSpan(index, span) {
  return index.sentences.filter((s) => s.start < span.end && s.end > span.start)
}
export { expand }
