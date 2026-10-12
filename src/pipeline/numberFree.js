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

const hasGated = (s) => new RegExp(NUM, 'i').test(String(s || ''))

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
