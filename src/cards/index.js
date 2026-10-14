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

import { normalize, extractNumbersWithIndex, tokens, wholeAcronym } from './text.js'

const SECTION_MAP = [
  [/^(background|introduction|importance|objectives?|purpose|aims?|context|rationale)$/, 'background'],
  [/^(methods?|design, setting, and participants|design|setting|participants|interventions?|main outcomes? and measures?|search methods|selection criteria|data collection and analysis|patients and methods|materials and methods|methods and results)$/, 'methods'],
  [/^(results?|findings|main results)$/, 'results'],
  [/^(conclusions?|interpretation|authors' conclusions|conclusions and relevance|discussion|funding|trial registration|registration)$/, 'conclusions'],
]
// Abstract labels ("METHODS:") on the raw text, or full-text headings ("RESULTS", "Discussion")
// that PMC extraction glues to the next word. Sections are cut on the RAW text and normalized
// segment by segment so offsets stay consistent.
const LABEL_RE = /(?:^|\s)([A-Z][A-Za-z' ,]{2,45}?):\s/g
// ALL-CAPS headings anywhere, or Title-case headings glued to the next capitalized word
// ("ResultsPatients") — a Title-case heading followed by a space could be an ordinary word.
const HEADING_RE = /(?:^|[^A-Za-z])(INTRODUCTION|BACKGROUND|METHODS|RESULTS|DISCUSSION|CONCLUSIONS?|(?:Introduction|Background|Methods|Results|Discussion|Conclusions?)(?=[A-Z][a-z]))(?=[A-Z]|\s|$)/g
const sectionOf = (label) => (SECTION_MAP.find(([re]) => re.test(label.toLowerCase().trim())) || [])[1] || null

// PMC glue: "appendix).In the" and "Primary OutcomeIn the" get a space.
const HEADING_WORDS = '(?:Outcomes?|Design|Population|Populations|Results|Methods|Discussion|Analysis|Analyses|Procedures|Patients|Participants|Treatments?|Follow-up|Introduction|Characteristics|Events|Summary|Materials?|Selection|Randomization|Randomisation|Oversight|Assessments?|Measures?|Limitations|Conclusions?|Background|Setting|Interventions?|Endpoints?|Statistics|Safety|Efficacy|Enrollment|Enrolment|Overview)'
const unglue = (raw) => raw.replace(/([.!?])(?=[A-Z(])/g, '$1 ').replace(new RegExp(`\\b(${HEADING_WORDS})([A-Z][a-z]+)`, 'g'), '$1 $2')

function splitSections(raw) {
  // abstract labels count only when they structure the text: at least two of them, one of
  // which is a results or conclusions label
  let marks = [...raw.matchAll(LABEL_RE)].map((m) => ({ name: sectionOf(m[1]), start: m.index + m[0].length, labelStart: m.index })).filter((m) => m.name)
  const structured = marks.length >= 2 && marks.some((m) => m.name === 'results' || m.name === 'conclusions') || (marks.length >= 1 && raw.length < 6000)
  if (!structured) {
    marks = [...raw.matchAll(HEADING_RE)].map((m) => ({ name: sectionOf(m[1]) || 'conclusions', start: m.index + m[0].length, labelStart: m.index + m[0].indexOf(m[1]) })).filter((m) => m.name)
  }
  const segments = []
  if (!marks.length) segments.push({ name: 'body', raw })
  else {
    if (marks[0].labelStart > 0) segments.push({ name: 'title', raw: raw.slice(0, marks[0].labelStart) })
    marks.forEach((mk, i) => segments.push({ name: mk.name, raw: raw.slice(mk.start, i + 1 < marks.length ? marks[i + 1].labelStart : raw.length) }))
  }
  // normalize per segment; join with a space so offsets are consistent in `norm`
  let norm = ''
  const sections = []
  let title = ''
  for (const seg of segments) {
    const n = normalize(unglue(seg.raw))
    if (!n) continue
    if (seg.name === 'title') { title = n; }
    const start = norm.length ? norm.length + 1 : 0
    norm = norm ? `${norm} ${n}` : n
    if (seg.name !== 'title') sections.push({ name: seg.name, start, end: start + n.length })
  }
  return { norm, sections, title, labeled: structured }
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
const TUPLE_RE = new RegExp(String.raw`\b(${MEASURE_ALT})(?:\s*\[(?:a?hr|a?or|rr|ci)\])?(?:\s+(?:in|for) the [a-z -]{2,40}? group(?: as compared with the [a-z -]{2,40}? group)?)?\s*(?:,|:|was|of|=|,\s*was)?\s*(${NUM})\s*(?:(?:metres|meters|percentage points|mm ?hg|cm|mm|m)\b)?\s*(?:[;,(]\s*)?(\[)?\s*(?:(\d+(?:\.\d+)?)%\s*(?:confidence interval|ci|credible interval)(?:\s*\[ci\])?\s*[,:]?\s*)?(${NUM})\s*(?:to|-)\s*(${NUM})\s*\]?\)?(?:\s*[;,]?\s*p\s*([<=>])\s*(\d*\.?\d+))?`, 'g')
const UNIT_RE = new RegExp(String.raw`(${NUM})\s*(metres|meters|percentage points|mm ?hg)`, 'g')
// a bracketed quantity with its own interval but no measure word is a difference in that unit
const UNIT_TUPLE_RE = new RegExp(String.raw`\((${NUM}) (metres|meters|percentage points|mm ?hg|cm|mm)\s*;\s*(\d+(?:\.\d+)?)% (?:ci|confidence interval)\s*,?\s*(${NUM}) (?:to|-) (${NUM})`, 'g')
// "302 of 709 patients (42.6%) in the surgical group" and "108 (63%) of 172 patients in the vein bypass group"
const ARM_COUNT_RE = /(\d+) of (\d+) (?:patients|participants|people)? ?\((\d+(?:\.\d+)?)%\) (?:in|of) the ([a-z][a-z -]{1,40}?) (?:group|arm)\b/g
const ARM_COUNT_RE_2 = /(\d+) \((\d+(?:\.\d+)?)%\) of (\d+) (?:patients|participants|people) (?:in|of) the ([a-z][a-z -]{1,40}?) (?:group|arm)\b/g
const ARM_PCT_RE = /(\d+(?:\.\d+)?)% (?:\([^)]*\) )?(?:in|of) the ([a-z][a-z -]{1,40}?) (?:group|arm)\b/g
const PCT_CI_RE = /(\d+(?:\.\d+)?)% \((\d+(?:\.\d+)?)% (?:confidence interval|ci)(?: \[ci\])?,? (-?\d+(?:\.\d+)?) (?:to|-) (-?\d+(?:\.\d+)?)\)/g
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
  for (const m of text.matchAll(UNIT_TUPLE_RE)) {
    if (tuples.some((t) => t.start <= m.index && m.index < t.end)) continue
    const tuple = { measure: 'MD', value: parseFloat(m[1]), low: parseFloat(m[4]), high: parseFloat(m[5]), label: `${m[3]}% CI`, p: null, unit: m[2].replace('meters', 'metres'), start: m.index, end: m.index + m[0].length, owner: null }
    tuples.push(tuple)
    pushRole(nums, indexOfNum(text, m[1], m.index), 'estimate', { measure: 'MD', tuple })
    pushRole(nums, indexOfNum(text, m[4], m.index + m[0].indexOf(m[4], 4)), 'ci-low', { tuple })
    pushRole(nums, indexOfNum(text, m[5], m.index + m[0].lastIndexOf(m[5])), 'ci-high', { tuple })
  }
  for (const m of text.matchAll(ARM_COUNT_RE)) {
    const arm = m[4].trim().replace(/-/g, ' ')
    pushRole(nums, m.index, 'count', { arm })
    pushRole(nums, indexOfNum(text, m[2], m.index + m[1].length), 'denominator', { arm })
    pushRole(nums, indexOfNum(text, m[3], m.index + m[0].indexOf('(')), 'percent', { arm })
  }
  for (const m of text.matchAll(ARM_COUNT_RE_2)) {
    const arm = m[4].trim().replace(/-/g, ' ')
    pushRole(nums, m.index, 'count', { arm })
    pushRole(nums, indexOfNum(text, m[2], m.index + m[1].length), 'percent', { arm })
    pushRole(nums, indexOfNum(text, m[3], m.index + m[0].indexOf(') of')), 'denominator', { arm })
  }
  for (const m of text.matchAll(ARM_PCT_RE)) pushRole(nums, m.index, 'percent', { arm: m[2].trim().replace(/-/g, ' ') })
  for (const m of text.matchAll(PCT_CI_RE)) {
    pushRole(nums, indexOfNum(text, m[3], m.index + m[1].length), 'ci-low', { of: parseFloat(m[1]) })
    pushRole(nums, indexOfNum(text, m[4], m.index + m[0].lastIndexOf(m[4])), 'ci-high', { of: parseFloat(m[1]) })
  }
  for (const m of text.matchAll(CI_LABEL_RE)) pushRole(nums, m.index, 'ci-label')
  for (const m of text.matchAll(TIME_RE)) pushRole(nums, m.index, 'timepoint', { unit: m[2].replace(/s$/, ''), sense: timeSense(text.slice(0, m.index)) })
  for (const m of text.matchAll(ENROLL_RE)) pushRole(nums, indexOfNum(text, m[1] || m[2], m.index), 'enrollment')
  for (const m of text.matchAll(/\b(cohort|grade|stratum|phase|group)\s(\d+)\b/g)) pushRole(nums, m.index + m[1].length + 1, 'label')
  for (const m of text.matchAll(P_RE)) pushRole(nums, indexOfNum(text, m[2], m.index), 'p')
  for (const m of text.matchAll(UNIT_RE)) { const t = nums.find((x) => x.start === m.index); if (t) t.unit = m[2] }
  const pair = /(\d+(?:\.\d+)?)% (?:vs\.?|versus) (\d+(?:\.\d+)?)%/.exec(text)
  if (pair) {
    const armsBefore = sentence.armsMentioned.filter((a) => a.pos < pair.index)
    if (armsBefore.length === 1 && sentence.allArms?.length === 2) armsBefore.push({ label: sentence.allArms.find((a) => a !== armsBefore[0].label), pos: pair.index })
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
// Arms named without "group": the two sides of "X vs Y" / "X versus Y", the subject of
// "X was associated with", the object of "compared with/to X", and "those/patients taking X".
const ARTICLE = /^(?:the|a|an|those|patients|participants|people) (?:taking |receiving |treated with |undergoing |assigned to |randomised to |randomized to )?/
const PAIR_RE = /\b([a-z][a-z/-]*(?: [a-z/-]+){0,3}) (?:vs\.?|versus) ([a-z][a-z/-]*(?: [a-z/-]+){0,3})(?=[ ,.;:)(]|$)/g
const SUBJECT_RE = /(?:^|[.;:] |, )(?:the |patients with |participants with )?([a-z][a-z/-]*(?: [a-z/-]+){0,2}?) (?:was|were) (?:also )?(?:independently |significantly )?associated with\b/g
const COMPARED_RE = /\bcompared (?:with|to) (?:the |those taking |those receiving |patients taking |participants taking |patients receiving )?([a-z][a-z/-]*(?: [a-z/-]+){0,2}?)(?=[ ,.;:)(]|$)/g
const TAKING_RE = /\b(?:participants|patients|those|people) (?:taking|receiving|treated with|randomi[sz]ed to|assigned to|undergoing) ([a-z][a-z/-]*(?: [a-z/-]+){0,2}?)(?=[ ,.;:)(]|$)/g
const NOT_ARM_WORD = new Set(['it', 'this', 'that', 'these', 'those', 'which', 'there', 'results', 'result', 'use', 'data', 'rates', 'risk', 'differences', 'outcomes', 'outcome', 'analysis', 'analyses', 'treatment', 'therapy', 'surgery', 'strategy', 'cohort', 'group', 'trial', 'study', 'patients', 'women', 'men', 'age', 'sex', 'diabetes', 'any', 'all', 'both', 'each', 'other', 'before', 'after', 'baseline', 'follow-up', 'aged', 'prior', 'adults'])
const STOPLIKE = /^(?:the|a|an|of|in|and|or|with|for|to|at|by|on|from|than|as|is|was|were|be|been|no|not|per)$/
const INNER_PREP = /^(?:after|before|with|without|following|undergoing|receiving|of|for|between|in|on|at|and|or|than|to|among)$/
// side: the candidate's position relative to the comparison word. On the left of "vs" the arm
// is the last segment ("and safety of apixaban" → apixaban); on the right it is the first
// ("rivaroxaban for venous thromboembolism" → rivaroxaban).
function cleanArm(raw, side = 'right') {
  let words = raw.trim().replace(/-/g, ' ').replace(ARTICLE, '').split(' ').filter(Boolean)
  while (words.length && INNER_PREP.test(words[0])) words.shift()
  const idx = words.map((w, i) => (INNER_PREP.test(w) ? i : -1)).filter((i) => i >= 0)
  if (idx.length) words = side === 'left' ? words.slice(idx[idx.length - 1] + 1) : words.slice(0, idx[0])
  let l = words.join(' ').replace(/ (?:group|arm|strategy|therapy|treatment|runoff|first)$/, '')
  l = l.replace(/^(?:either |an? |the |initial |sole |only )/, '').trim()
  words = l.split(' ')
  if (!l || words.length > 4 || words.some((w) => STOPLIKE.test(w)) || NOT_ARM_WORD.has(l) || /\d/.test(l) || l.length < 3) return null
  return l
}
function findLabels(norm, abbr) {
  const arms = new Set(), cohorts = new Set()
  for (const m of norm.matchAll(ARM_RE)) { const l = m[1].trim().replace(/-/g, ' '); if (!NOT_ARM.has(l.split(' ')[0]) && l.length > 2) arms.add(l) }
  let grouped = arms.size >= 2
  for (const m of norm.matchAll(COHORT_RE)) { const l = m[1].trim(); if (!NOT_COHORT_FIRST.has(l.split(' ')[0])) cohorts.add(l) }
  if (!grouped) {
    const count = new Map()
    const add = (raw, side) => { const l = cleanArm(raw, side); if (l) count.set(l, (count.get(l) || 0) + 1) }
    for (const m of norm.matchAll(PAIR_RE)) { add(m[1], 'left'); add(m[2], 'right') }
    for (const m of norm.matchAll(SUBJECT_RE)) add(m[1])
    for (const m of norm.matchAll(COMPARED_RE)) add(m[1])
    for (const m of norm.matchAll(TAKING_RE)) add(m[1])
    const pairSides = new Set([...norm.matchAll(PAIR_RE)].flatMap((m) => [cleanArm(m[1], 'left'), cleanArm(m[2], 'right')]).filter(Boolean))
    for (const [l, n] of count) if (n >= 2 || pairSides.has(l)) arms.add(l)
    // a candidate that spells out a defined abbreviation is that abbreviation ("carotid artery
    // stenting (CAS)" → cas); junk with a preposition inside is dropped
    for (const l of [...arms]) {
      if (/\b(?:after|before|with|without|following|versus|vs)\b/.test(l)) { arms.delete(l); continue }
      for (const [ab, words] of abbr) if (words.length >= 2 && words.every((w) => tokens(l).includes(w))) { arms.delete(l); arms.add(ab) }
    }
    for (const l of [...arms]) for (const o of arms) if (o !== l && o.startsWith(l + ' ')) arms.delete(o)
    if (arms.size >= 2) grouped = false
  }
  return { arms: [...arms], cohorts: [...cohorts], grouped }
}
// "retinal artery occlusion (rao)" → rao: [retinal, artery, occlusion]; only when initials match.
function abbrevBySubsequence(words, ab) {
  if (ab.length > words.length * 2) return false
  let i = 0
  for (const w of words) {
    if (w[0] !== ab[i]) return false
    i++
    for (let j = 1; i < ab.length; i++) { j = w.indexOf(ab[i], j); if (j < 0) break; j++ }
  }
  return i === ab.length
}
function findAbbreviations(norm) {
  const map = new Map()
  for (const m of norm.matchAll(/([a-z][a-z-]+(?: [a-z][a-z-]+){0,5}) \(([a-z]{2,6})\)/g)) {
    const words = m[1].split(' ')
    let hit = null
    for (let n = Math.min(words.length, 6); n >= 2 && !hit; n--) {
      const tail = words.slice(-n)
      if (tail.map((w) => w[0]).join('') === m[2] || tail.flatMap((w) => w.split('-').map((x) => x[0])).join('') === m[2]) hit = tail
    }
    // "carotid endarterectomy (cea)": every word contributes its initial, in order, and the
    // remaining letters come from inside the word that contributed the previous initial
    for (let n = 2; n <= Math.min(words.length, 6) && !hit; n++) { const tail = words.slice(-n); if (abbrevBySubsequence(tail, m[2])) hit = tail }
    if (hit) map.set(m[2], tokens(hit.join(' ')))
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
    // a results sentence that mentions the primary outcome is not its definition
    if (/^(?:analy[sz]ed|assessed|measured|evaluated|compared|similar|significantly|lower|higher|not )/.test(rest) || /^\d/.test(rest) || s.nums.some((n) => ['percent', 'estimate', 'count'].includes(n.role))) continue
    let core = rest, components = ''
    let d = /^(.*?)\s-\s(?:which (?:was|were|is) )?defined as\s+(.*?)\s-\s(.*)$/.exec(rest)
    if (d) { core = `${d[1]} ${d[3]}`; components = d[2] }
    else if ((d = /^(.*?)\s*,?\s*(?:which (?:was|were|is) )?defined as\s+(.*)$/.exec(rest))) { core = d[1]; components = d[2] }
    else components = [...rest.matchAll(/\(([^)]+)\)/g)].map((x) => x[1]).join(' ')
    // several primaries in one sentence ("ICD and QoL"; "wound healing, major amputation, …")
    // are separate endpoints. A comma that opens a clause ("…, assessed from …", "…, or …")
    // is not a list separator. A core with "or" (or "/") is one composite.
    const coreNoParen = core.replace(/\//g, ' or ').replace(/\s*\((?![a-z]{2,6}\))[^)]*\)/g, '')
    let rawParts = coreNoParen.split(/,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.trim()).filter(Boolean)
    const clauseStart = /^(?:or\b|assessed|measured|defined|evaluated|analy[sz]ed|which|that|as\b|at\b|from\b|during|within|after|up to)/
    // a trailing ", assessed by …" clause (and whatever it drags along) is not a list item
    const tail = rawParts.findIndex((x, i) => i > 0 && /^(?:assessed|measured|evaluated|analy[sz]ed|determined|recorded|defined)\b/.test(x))
    if (tail > 0) rawParts = rawParts.slice(0, tail)
    const isList = rawParts.length > 1 && rawParts.every((x) => !clauseStart.test(x) && tokens(x).length)
    const listParts = isList ? rawParts : [coreNoParen]
    for (const part of listParts) {
      const trim = (x) => x.replace(/\s*\([^)]*\)/g, '').replace(/\btime to (?:first )?/g, '').replace(/^(?:the )?(?:incidence|rate|occurrence|proportion|number) of (?:the )?/, '').replace(/,?\s+(?:at|within|after|during|through|measured|assessed|evaluated|analy[sz]ed|determined|recorded)\b.*$/, '')
      // "A or B through day 44, then C to 4 years": a sequential composite; every period's event
      // is a disjunct in its own right, so naming only the late component is not the endpoint
      const SPLIT = /\s+or\s+|,?\s+(?:and )?then\s+|,?\s+followed by\s+/
      // a disjunct carries its own whole-phrase acronym ("major adverse limb event" → male): the
      // claim may name that part by its acronym, which covers the part and nothing beyond it
      const disjunctSet = (x) => {
        const set = new Set(expand(tokens(trim(x)), abbr))
        const a = wholeAcronym(trim(x).replace(/^(?:an? |the )?composite (?:end ?point |outcome )?of (?:an? |the )?/, ''))
        if (a && set.size) { set.acronym = a; set.add(a) }
        return set
      }
      const coreDisjuncts = part.split(SPLIT).map(disjunctSet).filter((x) => x.size)
      if (!coreDisjuncts.length) continue
      const coreClean = part.split(SPLIT).map(trim).filter((x) => tokens(x).length).join(' or ')
      const coreTokens = new Set(coreDisjuncts.flatMap((d) => [...d]))
      // the endpoint's own acronym: the whole-core initials, or an abbreviation printed in this
      // sentence whose expansion covers the whole core ("(male)"). Initials of a part of the
      // core never name the endpoint.
      const defAcronyms = new Set()
      const whole = wholeAcronym(coreClean)
      if (whole) defAcronyms.add(whole)
      const coreWords = [...coreTokens].filter((t) => t !== 'composite' && !/^\d/.test(t))
      for (const [ab, words] of abbr) if (s.text.includes(`(${ab})`) && coreWords.length && coreWords.every((t) => t === ab || words.includes(t))) defAcronyms.add(ab)
      for (const a of defAcronyms) coreTokens.add(a)
      const componentDisjuncts = components.replace(/\//g, ' or ').split(/\s+or\s+|,\s*|\s+and\s+/).map(disjunctSet).filter((x) => x.size)
      const componentTokens = new Set(expand(tokens(components), abbr))
      defs.push({ role: m[1].replace('key ', ''), sentence: s, text: rest, core: coreClean, coreTokens, acronyms: defAcronyms, coreIsDisjunction: coreDisjuncts.length >= 2, coreDisjuncts, componentTokens, componentDisjuncts, allTokens: new Set([...coreTokens, ...componentTokens]) })
    }
  }
  return defs
}

// ---- outcome phrases and tuple ownership ------------------------------------------------
const STAT = new Set(['significant', 'statistically', 'possible', 'indication', 'improvement', 'hazard', 'ratio', 'confidence', 'interval', 'ci', 'adjusted', 'odds', 'relative', 'absolute', 'difference', 'mean', 'median', 'significantly', 'significant', 'higher', 'lower', 'increased', 'reduced', 'greater', 'better', 'worse', 'associated', 'compared', 'incidence', 'likelihood', 'probability', 'annual', 'cumulative', 'crude', 'unadjusted', 'estimated', 'overall'])
const PHRASE_PATTERNS = [
  // "higher risk of major amputation (" / "odds of experiencing headache compared"
  /(?:risks?|odds|rates?|incidence|hazard|likelihood|probability|chances?) of (?:experiencing |developing |having |a |an |the )?([a-z][a-z0-9 /-]{2,80}?)(?=\s*(?:\(|,|;|:|\bcompared\b|\bthan\b|\bin the\b|\bat \d|\bwas\b|\bwere\b|\bafter\b|\bwithin\b|\bby\b|$))/g,
  // "associated with a better amputation-free survival,"
  /(?:associated with|led to|resulted in) (?:an? )?(?:significantly )?(?:better|worse|higher|lower|greater|reduced|improved|increased|similar|more|fewer|less)? ?([a-z][a-z0-9 /-]{2,60}?)(?=\s*(?:,|;|\(|\bthan\b|\bin the\b|\bcompared\b|\bwhich\b|\bat \d|$))/g,
  // sentence subject: "[in cohort 1, ..., ] major amputation or death occurred" / "the 4-year rate of the primary outcome was"
  /(?:^|,\s*)(?:an? |the |no |\d+ )?(?:\d+-year rate of |\d+-year incidence of |rate of |incidence of )?(?:an? |the )?([a-z][a-z0-9 /-]{2,80}?) (?:occurred|was|were|did not differ|developed|happened)\b/g,
  // "had a higher icd compared with" / "showed improved wound healing ("
  /\b(?:had|showed|achieved|experienced|demonstrated) (?:an? |significantly )?(?:significantly )?(?:higher|lower|greater|better|worse|reduced|increased|improved|more|fewer|less)? ?(?:rates? of |odds of |risk of |incidence of )?([a-z][a-z0-9 /-]{2,60}?)(?=\s*(?:compared|than|\(|,|;|in the|at \d|$))/g,
  // "a 28% reduction in major bleeding risk ("
  /\b(?:reduction|increase|decrease|improvement) in (?:the )?(?:risk of |rate of |odds of )?([a-z][a-z0-9 /-]{2,50}?)(?: risk| rate| odds)?(?=\s*(?:\(|,|;|compared|$))/g,
  // an outcome named right before its own bracketed estimate: "icd (md 20.0" / "and mortality (6.41%"
  /(?:^|[,;(]\s*|\b(?:and|or|of|in|for|on)\s+)(?:the )?([a-z][a-z/-]*(?: [a-z/-]+){0,4}?) \((?=(?:a?hr|a?or|rr|md|rd|\d))/g,
]
function outcomePhrases(sentence, abbr) {
  const text = sentence.text
  const armWords = new Set(sentence.armsMentioned.flatMap((a) => tokens(a.label)))
  const out = []
  for (const re of PHRASE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[1].replace(/^(?:an? |the )/, '').replace(/^(?:both )?(?:in terms of |terms of |and |or |the |of |in |for |on )+/, '').replace(/\//g, ' or ').trim()
      if (/\b(?:occurred|was|were|had|group|groups|patients|participants)\b/.test(raw) && re === PHRASE_PATTERNS[PHRASE_PATTERNS.length - 1]) continue
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
  const { norm, sections, title, labeled } = splitSections(String(source.text || ''))
  const abbr = findAbbreviations(norm)
  const labels = findLabels(norm, abbr)
  const sentences = sections.flatMap((sec) => splitSentences(norm, sec)).map((s, i) => {
    const armsMentioned = []
    for (const label of labels.arms) {
      const body = label.split(' ').map((w) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('[-\\s]')
      const re = new RegExp(labels.grouped ? `\\b${body} (?:group|arm)\\b` : `\\b${body}\\b`, 'g')
      for (const m of s.text.matchAll(re)) {
        const before = s.text.slice(Math.max(0, m.index - 40), m.index)
        armsMentioned.push({ label, pos: m.index, reference: /(?:compared (?:with|to)|than|versus|vs\.?) (?:the |those taking |those receiving |patients taking )?$/.test(before) })
      }
    }
    armsMentioned.sort((a, b) => a.pos - b.pos)
    const cohortsMentioned = labels.cohorts.filter((c) => s.text.includes(c)).sort((a, b) => s.text.indexOf(a) - s.text.indexOf(b))
    const base = { ...s, i, armsMentioned, cohortsMentioned, allArms: labels.arms }
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
  // an arm that is only ever mentioned alongside one cohort/trial label identifies it
  // (judged on results sentences, where a trial label is a fact of reporting, not on the design
  // sentence that names every arm of every trial)
  const cohortByArm = new Map()
  const resultsSentences = sentences.filter((s) => s.section === 'results' || s.section === 'body')
  for (const arm of labels.arms) {
    const seen = new Set(resultsSentences.filter((s) => s.armsMentioned.some((m) => m.label === arm)).flatMap((s) => s.cohortsMentioned))
    if (seen.size === 1) cohortByArm.set(arm, [...seen][0])
  }
  return { norm, title, labeled, sections, sentences, labels, abbr, definitions, cohortByArm, design: detectDesign(norm), available }
}

export function sentencesInSpan(index, span) {
  return index.sentences.filter((s) => s.start < span.end && s.end > span.start)
}
export { expand }
