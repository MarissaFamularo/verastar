// cards/index.js — the evidence index: everything the checker, inventory and renderer read
// about a source, built deterministically before any claim is looked at.
//
// Everything downstream binds to this index, never to raw text: sections and their
// availability, sentences, printed group / cohort labels, outcome definitions, design words,
// and every number with the ROLE and OWNER its local syntax gives it (a percent "in the X
// group" belongs to arm X; an estimate tuple belongs to the sentence's comparison; a number
// before "years" is a timepoint). A number whose role cannot be read from syntax gets no role
// and can never satisfy a claim element. Nothing here is paper-specific.

import { normalize, extractNumbersWithIndex, tokens, acronyms } from './text.js'

const SECTION_MAP = [
  [/^(background|introduction|importance|objectives?|purpose|aims?|context|rationale)$/, 'background'],
  [/^(methods?|design, setting, and participants|design|setting|participants|interventions?|main outcomes? and measures?|search methods|selection criteria|data collection and analysis|patients and methods|materials and methods|methods and results)$/, 'methods'],
  [/^(results?|findings|main results)$/, 'results'],
  [/^(conclusions?|interpretation|authors' conclusions|conclusions and relevance|discussion|funding|trial registration|registration)$/, 'conclusions'],
]
const LABEL_RE = /(?:^|\s)([a-z][a-z' ,]{2,45}?):\s/g

function sectionOf(label) {
  for (const [re, name] of SECTION_MAP) if (re.test(label)) return name
  return null
}

// Sections from abstract labels ("METHODS:"). Full text without labels is one 'body' section
// whose results are assumed present; an abstract with labels but no results/conclusions label
// has results unavailable (how state B arises).
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
  const text = norm.slice(section.start, section.end)
  for (const piece of text.split(SENTENCE_SPLIT)) {
    const start = norm.indexOf(piece, pos)
    if (start < 0) continue
    out.push({ section: section.name, start, end: start + piece.length, text: piece })
    pos = start + piece.length
  }
  return out
}

const MEASURES = [
  ['adjusted hazard ratio', 'aHR'], ['hazard ratio', 'HR'], ['ahr', 'aHR'], ['hr', 'HR'],
  ['adjusted odds ratio', 'aOR'], ['odds ratio', 'OR'], ['aor', 'aOR'], ['or', 'OR'],
  ['relative risk', 'RR'], ['risk ratio', 'RR'], ['rr', 'RR'], ['rate ratio', 'IRR'], ['irr', 'IRR'],
  ['mean difference', 'MD'], ['md', 'MD'], ['absolute risk difference', 'RD'], ['risk difference', 'RD'],
]
const MEASURE_ALT = MEASURES.map(([w]) => w.replace(/ /g, '\\s+')).join('|')
const NUM = String.raw`-?\d+(?:\.\d+)?`
// measure [abbr] [,:] [was|of|=] value  [;,( [ ] [95% (confidence interval|ci) [ci] [,:]] low (to|-) high ]  [;,) p op v]
const TUPLE_RE = new RegExp(String.raw`\b(${MEASURE_ALT})(?:\s*\[(?:a?hr|a?or|rr|ci)\])?\s*(?:,|:|was|of|=|,\s*was)?\s*(${NUM})\s*(?:(?:metres|meters|percentage points|mm ?hg|cm|mm|m)\b)?\s*(?:[;,(]\s*)?(\[)?\s*(?:(\d+)%\s*(?:confidence interval|ci|credible interval)(?:\s*\[ci\])?\s*[,:]?\s*)?(${NUM})\s*(?:to|-)\s*(${NUM})\s*\]?\)?(?:\s*[;,]?\s*p\s*([<=>])\s*(\d*\.?\d+))?`, 'g')
const UNIT_RE = new RegExp(String.raw`(${NUM})\s*(metres|meters|percentage points|mm ?hg)`, 'g')
const ARM_COUNT_RE = /(\d+) of (\d+) (?:patients|participants|people)? ?\((\d+(?:\.\d+)?)%\) (?:in|of) the ([a-z][a-z -]{1,40}?) (?:group|arm)\b/g
const ARM_PCT_RE = /(\d+(?:\.\d+)?)% (?:\([^)]*\) )?(?:in|of) the ([a-z][a-z -]{1,40}?) (?:group|arm)\b/g
const TIME_RE = /(?<![\d.])(\d+(?:\.\d+)?)(?:\s|-)(years?|months?|weeks?|days?)\b/g
const ENROLL_RE = /(?:enrolled|randomi[sz]ed|randomly assigned|included|analysed|analyzed)\s+(\d+)\s+(?:patients|participants|people|adults|women|men)|(\d+)\s+(?:patients|participants|people)[^.;]{0,80}?(?:were enrolled|underwent randomi[sz]ation|were randomly assigned|were randomised|were randomized|were included)/g
const P_RE = /\bp\s*([<=>])\s*(\d*\.\d+)/g
const CI_LABEL_RE = /(\d+)%\s*(?:ci|confidence interval|credible interval)\b/g

function pushRole(tokensList, start, role, extra = {}) {
  const t = tokensList.find((x) => x.start === start)
  if (t && !t.role) Object.assign(t, { role, ...extra })
}
function indexOfNum(text, value, from = 0) {
  const re = new RegExp(String.raw`(?<![\d.])${String(value).replace('.', '\\.')}(?![\d.])`, 'g')
  re.lastIndex = from
  const m = re.exec(text)
  return m ? m.index : -1
}

// Every number in a sentence with the role its syntax gives it. Roles: count, denominator,
// percent (owner arm), estimate / ci-low / ci-high / p (measure, interval label), timepoint
// (unit), enrollment, label (digit inside a cohort label), ci-label. Unassigned stays null.
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
    const tuple = { measure, value, low, high, label, p, unit, start, end: start + m[0].length }
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
  for (const m of text.matchAll(ARM_PCT_RE)) pushRole(nums, m.index, 'percent', { arm: m[2].trim() })
  for (const m of text.matchAll(CI_LABEL_RE)) pushRole(nums, m.index, 'ci-label')
  for (const m of text.matchAll(TIME_RE)) pushRole(nums, m.index, 'timepoint', { unit: m[2].replace(/s$/, '') })
  for (const m of text.matchAll(ENROLL_RE)) {
    const v = m[1] || m[2]
    pushRole(nums, indexOfNum(text, v, m.index), 'enrollment')
  }
  for (const m of text.matchAll(/\b(cohort|grade|stratum|phase|group)\s(\d+)\b/g)) pushRole(nums, m.index + m[1].length + 1, 'label')
  for (const m of text.matchAll(P_RE)) pushRole(nums, indexOfNum(text, m[2], m.index), 'p')
  for (const m of text.matchAll(UNIT_RE)) { const t = nums.find((x) => x.start === m.index); if (t) t.unit = m[2] }
  // percent pairs "x% vs y%" owned by the two arms mentioned earlier in the sentence, in order
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

const ARM_RE = /\b(?:in|of|to|for) the ([a-z][a-z-]*(?: [a-z-]+){0,3}?) (?:group|arm)\b/g
const NOT_ARM = new Set(['two', 'both', 'each', 'either', 'other', 'same', 'control', 'treatment', 'first', 'second', 'latter', 'former', 'study'])
const COHORT_RE = /\b(cohort \d+|[a-z-]+ trial|[a-z-]+ cohort|(?:pcb )?grade \d+|stratum [a-z0-9]+)\b/g
const NOT_COHORT_FIRST = new Set(['to', 'in', 'of', 'the', 'a', 'an', 'each', 'this', 'per', 'and', 'or', 'from', 'with', 'within', 'by', 'for', 'both', 'two', 'one', 'that', 'whole', 'entire', 'same', 'other', 'single', 'multicentre', 'multicenter', 'phase', 'controlled', 'randomised', 'randomized', 'clinical', 'pragmatic', 'international', 'observer-blinded', 'open-label'])
const NOT_COHORT = new Set(['this trial', 'the trial', 'randomized trial', 'randomised trial', 'clinical trial', 'controlled trial', 'present trial', 'current trial', 'phase trial', 'our trial', 'each trial', 'one trial', 'single trial', 'parallel-cohort trial', 'parallel cohort', 'matched cohort', 'retrospective cohort', 'prospective cohort', 'entire cohort', 'whole cohort', 'overall cohort', 'study cohort', 'full cohort', 'this cohort', 'each cohort', 'per cohort'])

function findLabels(norm) {
  const arms = new Set()
  for (const m of norm.matchAll(ARM_RE)) {
    const label = m[1].trim()
    if (!NOT_ARM.has(label.split(' ')[0]) && label.length > 2) arms.add(label)
  }
  const cohorts = new Set()
  for (const m of norm.matchAll(COHORT_RE)) {
    const label = m[1].trim()
    const first = label.split(' ')[0]
    if (!NOT_COHORT.has(label) && !NOT_COHORT_FIRST.has(first)) cohorts.add(label)
  }
  return { arms: [...arms], cohorts: [...cohorts] }
}

const DEF_RE = /\b(primary|co-primary|secondary|key secondary) (?:efficacy |safety |composite )?(?:outcomes?|end ?points?|outcome measures?)\s+(?:was|were|is|are|included|consisted of|comprised|defined as)\s+(.+)/

function findDefinitions(sentences) {
  const defs = []
  for (const s of sentences) {
    const m = DEF_RE.exec(s.text)
    if (!m) continue
    const rest = m[2].replace(/[.;]\s*$/, '')
    const componentText = [...rest.matchAll(/defined as ([^-()]+)|\(([^)]+)\)/g)].map((x) => x[1] || x[2]).join(' ')
    const componentTokens = new Set(tokens(componentText))
    const allTokens = tokens(rest)
    const headTokens = new Set(allTokens.filter((t) => !componentTokens.has(t)))
    for (const a of acronyms(rest)) if (a.length >= 3) headTokens.add(a)
    defs.push({ role: m[1].replace('key ', ''), sentence: s, text: rest, headTokens, componentTokens, allTokens: new Set(allTokens) })
  }
  return defs
}

function detectDesign(norm) {
  const randomized = /\brandomi[sz]ed\b|\brandomly assigned\b/.test(norm)
  const review = /\bsystematic review\b|\bmeta-analysis\b|\bwe included \d+ .{0,40}(trials|studies)\b|\bcochrane\b/.test(norm)
  const observational = !randomized && /\bretrospective\b|\bcohort study\b|\bpropensity\b|\bregistry\b|\bobservational\b|\breviewed\b/.test(norm)
  const matched = /\bpropensity\b|\bmatched\b/.test(norm)
  const openLabel = /\bopen-label\b|\bnon-blinded\b|\bunblinded\b/.test(norm)
  const parallel = /\bparallel/.test(norm)
  return { randomized, review, observational, matched, openLabel, parallel }
}

export function buildIndex(source) {
  const norm = normalize(source.text)
  const { sections, title, labeled } = splitSections(norm)
  const labels = findLabels(norm)
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
    return { ...base, nums, tuples }
  })
  const definitions = findDefinitions(sentences)
  const available = {
    results: !labeled || sections.some((s) => s.name === 'results' || s.name === 'conclusions'),
    methods: !labeled || sections.some((s) => s.name === 'methods' || s.name === 'body'),
  }
  return { norm, title, labeled, sections, sentences, labels, definitions, design: detectDesign(norm), available }
}

// Sentences whose [start,end) overlaps a located span.
export function sentencesInSpan(index, span) {
  return index.sentences.filter((s) => s.start < span.end && s.end > span.start)
}
