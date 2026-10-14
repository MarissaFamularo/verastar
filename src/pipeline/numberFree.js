// pipeline/numberFree.js — repair a prose sentence to its number-free form WITHOUT
// leaving the stubs the old token strip left behind.
//
// The number guard (triage.js) must remove every gated digit from finding_plain,
// design_caution, and relevance, and from a finding that failed the guard. The old strip
// deleted the digits only, so the unit and preposition around them survived: "cut day
// operative mortality", "reduced the year risk", "at days.", "aneurysms in the to cm range",
// "ranging from about six to weeks" (2026-10-11 dev set: AAA-06, AAA-12, AAA-13, AAA-14,
// AAA-04, CAR-04, CAR-13, PAD-05, PAD-10, and others).
//
// This repair removes whole number PHRASES (the number plus its unit, range partner,
// hyphenated adjective, and leading preposition), then whole clauses that still carry a
// gated number, and returns '' when the sentence cannot be repaired. It never adds a number
// and never lets a gated digit through: the result is re-checked with the same nomenclature
// rule the guard uses (a digit glued to a letter — TcPO2, SF-36, COVID-19 — is a name, not a
// statistic). The caller treats '' as "no usable sentence" and falls back.

import { normalize, extractNumbers, extractNumbersWithIndex, numbersEqual } from './verify.js'

// A gated numeric token: not glued to a letter (or letter-dash), optional sign.
const NUM = String.raw`(?<![a-z0-9.])(?<![a-z][-‐–—−])[-−+]?(?:\d+(?:[.,·]\d+)*|\.\d+)`
const DASH = '[-‐‑–—−]'
const RANGE = String.raw`${NUM}(?:\s*(?:%\s*)?(?:to|and|${DASH})\s*${NUM})?`
const UNIT = String.raw`(?:%|percent(?:age points?)?|hours?|days?|weeks?|months?|years?|minutes?|seconds?|cm|mm|m|km|kg|mg|g|ml|mL|l|mmHg|points?|patients?|participants?|subjects?|people|persons|centers?|centres?|sites?|trials?|studies|events?|deaths?|times)`
const WORD_NUM = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|a few)'
const APPROX = String.raw`(?:(?:about|approximately|roughly|nearly|almost|around|over|under|up to|more than|less than|fewer than|at least|at most|only)\s+)?`
const PREP = '(?:at|over|for|within|after|before|by|of|to|through|in|during|from|between|with|among|across|on|beyond|until|than)'

const ESTIMATE = String.raw`(?:(?:adjusted|unadjusted|pooled|absolute|relative|mean|median|standardi[sz]ed)\s+)?(?:hazard ratio|odds ratio|risk ratio|relative risk|rate ratio|win ratio|risk difference|risk reduction|risk increase|mean difference|difference|reduction|increase|HR|OR|RR|IRR|ARR|RRR|NNT)`

const PATTERNS = [
  // an effect-estimate phrase whose value is gated: "with a hazard ratio of 0.80", "HR 1.37",
  // "an absolute risk reduction of 17 percent" — the whole phrase, never a bare label
  // (only when the phrase is an add-on — clause-initial or after "with"/"and" — so a verb's
  // object is never cut out: "produced an absolute risk reduction of 17 percent" keeps its
  // object and loses only "of 17 percent" below)
  [new RegExp(String.raw`(?:^\s*|\s*\b(?:with|and)\s+)(?:(?:an?|the)\s+)?${ESTIMATE}\s*(?:of|was|=|:|,)?\s*${APPROX}${RANGE}\s*${UNIT}?(?![a-z0-9])`, 'gi'), ''],
  // decades: "1990s", "mid-1990s", "the 1980s and 1990s" → "earlier-era"
  [new RegExp(String.raw`\b(?:(?:mid|early|late)${DASH})?(?<!\d)\d{4}s(?:\s*(?:to|and|${DASH})\s*(?:(?:mid|early|late)${DASH})?\d{4}s)?(?![a-z])`, 'gi'), 'earlier-era'],
  // "in the 3.0 to 5.4 cm range" / "within the 30-60% range"
  [new RegExp(String.raw`\s*\b(?:in|within)\s+the\s+${APPROX}${RANGE}\s*${UNIT}?\s*range\b`, 'gi'), ''],
  // "ranging from about six to 12 weeks", "between 6 and 12 months", "from 2 to 5 years"
  [new RegExp(String.raw`\s*\b(?:ranging\s+)?(?:from|between)\s+${APPROX}(?:${NUM}|${WORD_NUM})\s*(?:%\s*)?(?:to|and|${DASH})\s*${NUM}\s*${UNIT}?(?![a-z0-9])`, 'gi'), ''],
  // hyphenated adjectives: "30-day", "5-year", "2-to-3-year", "8-fold", "12-month"
  [new RegExp(String.raw`${RANGE}${DASH}(?:to${DASH}${NUM}${DASH})?(?:hours?|day|week|month|year|minute|fold|point|item|mm|cm|percent)s?${DASH}?\s*`, 'gi'), ''],
  // prepositional number phrases: "at 30 days", "over 2 years", "by 25%", "of 1,200 patients"
  [new RegExp(String.raw`\s*\b${PREP}\s+${APPROX}${RANGE}\s*${UNIT}?(?![a-z0-9])`, 'gi'), ''],
  // bare number + unit: "25% fewer", "1,200 patients"
  [new RegExp(String.raw`${APPROX}${RANGE}\s*${UNIT}(?![a-z0-9])\s*`, 'gi'), ''],
]

// The ONE nomenclature rule, shared with the guard in triage.js so the two layers can never
// disagree. A numeric token is exempt (a name, not a statistic) only when the character
// directly before it is a letter AND the glue is not a statistic label: "TcPO2", "CD34",
// "P2Y12", "COVID-19", "SF-36" and "HbA1c" stay whole, but "HR0.84", "OR0.5", "RR1.4",
// "x2" and "n12" are statistics the writer glued to their label (2026-10-14 beta audit).
// Tokens are read on the verifier's normalized text (NFKC, dashes unified), so full-width
// and circled digits and vulgar fractions are seen as the digits they fold to.
const STAT_GLUE = new Set(['hr', 'ahr', 'or', 'aor', 'rr', 'arr', 'irr', 'md', 'smd', 'nnt', 'nnh', 'ci', 'sd', 'se', 'n', 'p', 'x', 'r', 'i'])
const isLetter = (ch) => ch != null && /[a-z]/i.test(ch)
export function nomenclatureExempt(norm, token) {
  if (!isLetter(norm[token.start - 1])) return false
  let i = token.start
  while (i > 0 && isLetter(norm[i - 1])) i -= 1
  const glue = norm.slice(i, token.start)
  if (!STAT_GLUE.has(glue)) return true
  // "P2Y12": the digit is followed by more letters, so it is inside a name.
  return isLetter(norm[token.end])
}

// Unicode decimal digits that NFKC leaves alone (Arabic-Indic, Devanagari, ...) are not
// ASCII digits, so the tokenizer cannot see them. Treat any of them as a gated number.
const FOREIGN_DIGIT = /\p{Nd}/u
export function gatedTokens(text) {
  const norm = normalize(text || '')
  return extractNumbersWithIndex(norm).filter((t) => !nomenclatureExempt(norm, t))
}
export function hasGatedNumber(text) {
  const norm = normalize(text || '')
  if (FOREIGN_DIGIT.test(norm.replace(/[0-9]/g, ''))) return true
  return gatedTokens(text).length > 0
}

const hasGated = (s) => hasGatedNumber(s)

// Words a repaired clause must not end on (a dangling stub means the clause lost its object).
const DANGLING = /\b(?:to|from|of|at|the|a|an|and|or|about|than|by|over|in|for|with|between|ranging|approximately|roughly|nearly|versus|vs)\s*[.]?$/i
const LEAD_PARTICIPLE = /^(?:limiting|suggesting|indicating|supporting|making|leaving|reflecting|highlighting|ranging|including|raising|underscoring|showing|meaning|reducing|increasing)\b/i
const LEAD_CONJ = /^(?:and|but|so|yet|while|whereas|although|though|which|thus|hence)\s+/i

function repairPhrase(text) {
  let s = text
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep)
  return s
}

function tidy(s) {
  return s
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+([,.;:)\]])/g, '$1')
    .replace(/([,;:])\s*(?=[,;.])/g, '')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .replace(/\ba (?=[aeiou])/gi, (m) => (m[0] === 'A' ? 'An ' : 'an '))
    .replace(/\ban (?=[b-df-hj-np-tv-z])/gi, (m) => (m[0] === 'A' ? 'A ' : 'a '))
    .trim()
}

export function repairNumberFree(text) {
  const original = String(text ?? '').trim()
  if (!original) return ''
  if (!hasGated(original)) return original
  const endPunct = /[.!?]$/.test(original) ? original.slice(-1) : ''
  let s = endPunct ? original.slice(0, -1) : original

  // 1. Parentheticals and brackets that carry a gated number go whole: "(n = 412)".
  s = s.replace(/\s*[([][^()[\]]*[)\]]/g, (m) => (hasGated(m) ? '' : m))

  // 2. Clause by clause: repair number phrases; drop a clause that still carries a gated
  //    number or now dangles.
  const parts = s.split(/(,\s+|;\s+|\s+[—–]\s+)/)
  const clauses = []
  for (let i = 0; i < parts.length; i += 2) clauses.push({ text: parts[i], sep: parts[i + 1] || '' })
  const kept = []
  for (const c of clauses) {
    if (!hasGated(c.text)) {
      kept.push(c)
      continue
    }
    const repaired = tidy(repairPhrase(c.text))
    if (repaired && !hasGated(repaired) && !DANGLING.test(repaired)) kept.push({ ...c, text: repaired })
    else kept.push({ ...c, text: '', dropped: true })
  }
  // Rejoin the survivors with their original separators. When the LEADING clause was
  // dropped, the next survivor leads, minus its conjunction ("so", "and", ...).
  const survivors = kept.filter((c) => !c.dropped && c.text.trim())
  let out = ''
  survivors.forEach((c, idx) => {
    let t = c.text.trim()
    if (idx === 0) {
      if (kept[0] !== c) t = t.replace(LEAD_CONJ, '')
      out = t.charAt(0).toUpperCase() + t.slice(1)
      return
    }
    const prev = survivors[idx - 1]
    const adjacent = kept.indexOf(c) === kept.indexOf(prev) + 1
    out += (adjacent ? prev.sep : '') || ', '
    out += t
  })
  out = tidy(out)
  // A participle left leading ("Limiting comparison.") lost its subject with the clause.
  const leadLost = survivors.length && kept[0] !== survivors[0] && LEAD_PARTICIPLE.test(out)
  if (!out || hasGated(out) || DANGLING.test(out) || leadLost || out.split(/\s+/).length < 2) return ''
  return out + (endPunct || '.')
}

// --- The number guard (moved from triage.js, 2026-10-14) -------------------------

// Every number a finding is allowed to carry: the numeric tokens of the paper's verified
// value strings (fmtNum output — the exact strings the fact channel renders). Tokenized
// with the verifier's own normalize/extractNumbers so "0·84", "8 %", and CI en-dashes
// read identically here and there.
export function allowedNumbers(verified) {
  const out = []
  for (const v of verified || []) {
    const value = normalize(String(v?.value ?? '')).replace(CI_LEVEL_RE, ' ')
    for (const n of extractNumbers(value)) out.push(n)
  }
  return out
}

// An interval's printed level ("99% CI", "95% credible interval") is a label fmtNum renders
// beside a verified interval, not a verified value: it never joins the allowed set, and a
// finding may carry it only directly in front of the same label, when one of the paper's
// verified value strings prints that level (2026-10-11 fix 4).
export const CI_LEVEL_RE = /(?<![\d.])(\d{2}(?:\.\d+)?)\s*%\s*(?=(?:CI|credible interval)\b)/gi
const CI_LEVEL_AHEAD = /^\s*%\s*(?:CI|credible interval)\b/i
export function allowedCiLevels(verified) {
  const out = []
  for (const v of verified || []) {
    for (const m of normalize(String(v?.value ?? '')).matchAll(CI_LEVEL_RE)) out.push(Number(m[1]))
  }
  return out
}

// Timepoints (2026-10-04). A result's value strings never carry its timepoint — "67.3%
// versus 50%" — so "no clear benefit at 12 months" lost its 12 even when the 12-month
// result itself verified. A finding may also carry a number used AS A TIMEPOINT (number
// then a time unit: "at 12 months", "12-month") when that same number-and-unit is printed
// in the quote of one of the paper's VERIFIED rows. Narrow on both sides: the token must
// sit before a time unit in the finding, and the quote must print it before a time unit,
// so a timepoint can never launder a statistic and a statistic never launders a timepoint.
// Whether it is the RIGHT timepoint for the claim is a prose judgment — the check pass
// (pipeline/check.js) covers it, not this guard.
const TIME_UNIT = '(hours?|days?|weeks?|months?|years?)\\b'
const QUOTE_TIMEPOINT = new RegExp(`(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*-?\\s*${TIME_UNIT}`, 'g')
const FOLLOWED_BY_UNIT = new RegExp(`^\\s*-?\\s*${TIME_UNIT}`)
const unitStem = (u) => String(u || '').toLowerCase().replace(/s$/, '')

// [{ value, unit }]: the number AND its unit, so "12 months" in a quote can back "at 12
// months" but never "at 12 days" (2026-10-14 beta audit: the unit was not compared).
export function allowedTimepoints(verified) {
  const out = []
  for (const v of verified || []) {
    for (const m of normalize(String(v?.quote ?? '')).matchAll(QUOTE_TIMEPOINT)) out.push({ value: Number(m[1]), unit: unitStem(m[2]) })
  }
  return out
}

// Nomenclature exemption, shared by the check and the strip so the two layers can never
// disagree: a numeric token whose character DIRECTLY before it is a letter is part of a
// name (TcPO2, CD34, P2Y12, COVID-19, SF-36 — the token there starts at the dash), not a
// statistic. A statistic in prose is always delimited from letters by a space, comparator,
// or punctuation ("8%", "HR 0.84", "n=84"), so nothing delimited ever slips this gate —
// "type 2 diabetes", "30-day", and "8-fold" all stay gated (conservatively: they fall
// back unless verified).
// The exemption itself lives in numberFree.js (nomenclatureExempt) so the guard and the
// repair can never disagree; it also refuses a statistic glued to its label ("HR0.84").

// True when EVERY gated numeric token in `text` equals some allowed number (verifier
// representation-equality: 8 == 8.0, 0.84 == .84 — never rounding). Boundary-safe by
// construction: extractNumbersWithIndex tokenizes "2008" as 2008, so a verified 8 can
// never launder a year, and 0.84 never satisfies 0.8. A digit the tokenizer cannot read
// (a non-ASCII decimal digit) is never grounded.
export function numbersGrounded(text, allowed, timepoints = [], ciLevels = []) {
  const norm = normalize(text || '')
  if (hasGatedNumber(text) && !extractNumbersWithIndex(norm).length) return false
  const timepointOk = (t) => {
    const m = FOLLOWED_BY_UNIT.exec(norm.slice(t.end))
    if (!m) return false
    const unit = unitStem(m[1])
    return timepoints.some((a) => (typeof a === 'object' ? numbersEqual(a.value, t.value) && a.unit === unit : numbersEqual(a, t.value)))
  }
  return extractNumbersWithIndex(norm).every(
    (t) =>
      nomenclatureExempt(norm, t) ||
      allowed.some((a) => numbersEqual(a, t.value)) ||
      timepointOk(t) ||
      (CI_LEVEL_AHEAD.test(norm.slice(t.end)) && ciLevels.some((a) => numbersEqual(a, t.value)))
  )
}

