// pipeline/numberBinding.js — deterministic CLAIM BINDING for every number in a finding.
//
// The production number guard (numberFree.js numbersGrounded) proves each DIGIT is one the
// verifier admitted for the paper. It never asked WHICH result a number belongs to, so a
// sentence could attach a verified hazard ratio to the other endpoint, reverse the
// comparator, rename the analysis or borrow another result's confidence interval and
// still pass (docs/evidence/2026-10-17/verifier/numeric-guard: four of six probes). This
// module binds each number-bearing segment of the finding to ONE verified row and refuses
// the sentence when the segment contradicts that row's own name and quote on:
//   - the OUTCOME: the segment names an outcome that belongs to a different verified row
//     and that the bound row's name and quote never print;
//   - the COMPARATOR ORDER: "X versus Y" in the segment where the row prints "Y versus X";
//   - the ANALYSIS: the segment names an analysis population or model (per-protocol,
//     weighted, ...) while the row names a different one from the same family;
//   - the INTERVAL: an estimate's bracketed interval must come from the same row as the
//     estimate (no row prints the estimate with that interval -> refused).
// Deterministic, pure, fail-closed on what it can see and fail-OPEN on what it cannot
// (a segment with no distinguishing term is left to the model checker, which judges the
// same binding against the complete source). It never adds a claim, never changes text.
import { normalize, extractNumbersWithIndex, numbersEqual } from './verify.js'
import { nomenclatureExempt, CI_LEVEL_RE } from './numberFree.js'

const TIME_UNIT_AHEAD = /^\s*-?\s*(?:hours?|days?|weeks?|months?|years?)\b/
const CI_LEVEL_AHEAD = /^\s*%\s*(?:ci|credible interval)\b/i
const INTERVAL_AHEAD = /^(?:[^\d()]{0,40}?)\(\s*(?:\d{2}(?:\.\d+)?\s*%\s*)?(?:ci|confidence interval|credible interval|interval|cri)?\s*[,:=]?\s*(-?\d+(?:\.\d+)?)\s*(?:-|to|,)\s*(-?\d+(?:\.\d+)?)/i

const STOP = new Set(['the', 'and', 'or', 'of', 'in', 'at', 'to', 'for', 'with', 'from', 'after', 'per', 'versus', 'vs', 'than', 'was', 'were', 'is', 'are', 'had', 'has',
  'rate', 'rates', 'risk', 'risks', 'outcome', 'outcomes', 'event', 'events', 'primary', 'secondary', 'composite', 'overall', 'total', 'all', 'cause', 'major', 'minor', 'any',
  'patients', 'patient', 'group', 'groups', 'analysis', 'analyses', 'follow', 'up', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'one', 'two', 'three',
  'hazard', 'odds', 'ratio', 'ratios', 'relative', 'mean', 'median', 'difference', 'change', 'baseline', 'estimate', 'adjusted', 'unadjusted', 'pooled', 'model', 'cox',
  'end', 'point', 'points', 'endpoint', 'endpoints', 'clinical', 'significant', 'significantly', 'versus', 'between', 'among', 'during', 'within', 'first', 'second', 'time',
  'early', 'late', 'long', 'term', 'short', 'free', 'survival', 'treatment', 'therapy', 'arm', 'arms', 'control', 'sensitivity', 'intention', 'treat', 'protocol', 'treated'])

const ANALYSIS_FAMILIES = {
  population: {
    'intention-to-treat': /\bintention[- ]to[- ]treat\b|(?<![a-z])itt(?![a-z])/,
    'modified intention-to-treat': /\bmodified intention[- ]to[- ]treat\b|(?<![a-z])mitt(?![a-z])/,
    'per-protocol': /\bper[- ]protocol\b/,
    'as-treated': /\bas[- ]treated\b/,
  },
  model: {
    weighted: /\binverse[- ]probability\b|(?<![a-z])iptw(?![a-z])|\bpropensity\b|\bweighted\b/,
    conventional: /\bconventional\b|\bunweighted\b|\bmultivariable\b|\bmultivariate\b|\bunadjusted\b/,
    'fine-gray': /\bfine[- ]gray\b|\bsubdistribution\b|\bcompeting[- ]risk\b/,
    'restricted mean': /\brestricted mean\b|(?<![a-z])rmst(?![a-z])/,
    'kaplan-meier': /\bkaplan[- ]meier\b|\blog[- ]rank\b/,
  },
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const hasWord = (text, word) => new RegExp(`(?<![a-z0-9])${escapeRe(word)}(?![a-z0-9])`).test(text)
const contentWords = (s) => [...new Set(normalize(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))]

// The outcome part of a row's name: before the first comma, minus a leading role prefix.
function outcomePart(name) {
  return String(name || '').split(',')[0].replace(/^(?:the\s+)?(?:co-?)?primary\s+(?:efficacy\s+|safety\s+|composite\s+)?(?:end\s?-?points?|outcomes?|analysis)\s*[:\-—]?\s*/i, '')
}

const VS = /(?<![a-z0-9])((?:[a-z0-9][a-z0-9'-]*\s+){0,4}[a-z0-9][a-z0-9'-]*)\s+(?:versus|vs\.?)\s+((?:[a-z0-9][a-z0-9'-]*\s*){1,5})/g
const VS_STOP = new Set(['of', 'in', 'with', 'and', 'or', 'for', 'to', 'at', 'was', 'were', 'is', 'are', 'had', 'reduced', 'increased', 'improved', 'analysis', 'group', 'groups', 'arm', 'arms', 'compared'])
function comparatorPairs(text) {
  const out = []
  for (const m of normalize(text).matchAll(VS)) {
    const left = m[1].split(/\s+/).filter((w) => !VS_STOP.has(w))
    const right = m[2].trim().split(/\s+/).filter((w) => !VS_STOP.has(w))
    if (left.length && right.length) out.push({ left, right })
  }
  return out
}
// Only words that distinguish one side from the other decide the order ("treatment A"
// versus "treatment B" share "treatment"; "a" and "b" decide).
const distinct = (pair) => ({ left: pair.left.filter((w) => !pair.right.includes(w)), right: pair.right.filter((w) => !pair.left.includes(w)) })
const subset = (a, b) => a.length > 0 && a.every((w) => b.includes(w))

export function verifiedRowFacts(verified) {
  return (verified || []).map((v, index) => {
    const value = normalize(String(v?.value ?? '')).replace(CI_LEVEL_RE, ' ')
    return {
      index,
      name: String(v?.name || ''),
      value: String(v?.value ?? ''),
      quote: String(v?.quote || ''),
      nums: extractNumbersWithIndex(value).map((t) => t.value),
      own: normalize(`${v?.name || ''} ${v?.quote || ''}`),
      outcomeWords: contentWords(outcomePart(v?.name)),
    }
  })
}

// Bind every gated number in `finding` to a verified row and list the contradictions.
// Returns { ok, bindings: [{ number, start, end, interval, rowIndex, candidates, segment, violations }], violations }
export function bindFindingNumbers(finding, verified) {
  const norm = normalize(finding || '')
  const rows = verifiedRowFacts(verified)
  const tokens = extractNumbersWithIndex(norm).filter((t) => !nomenclatureExempt(norm, t))
  const bindings = []
  const violations = []
  let cursor = 0
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    const after = norm.slice(t.end)
    // Timepoints and interval levels are not estimates and bind to nothing.
    if (TIME_UNIT_AHEAD.test(after) || CI_LEVEL_AHEAD.test(after)) { i += 1; continue }
    // An estimate followed by its bracketed interval: all three numbers form one group.
    const group = [t.value]
    let groupEnd = t.end
    let interval = null
    const m = INTERVAL_AHEAD.exec(after)
    if (m) {
      const lo = Number(m[1])
      const hi = Number(m[2])
      const nextTwo = tokens.slice(i + 1, i + 3)
      if (nextTwo.length === 2 && numbersEqual(nextTwo[0].value, lo) && numbersEqual(nextTwo[1].value, hi)) {
        interval = [lo, hi]
        group.push(lo, hi)
        groupEnd = nextTwo[1].end
        i += 2
      }
    }
    const candidates = rows.filter((r) => group.every((n) => r.nums.some((x) => numbersEqual(x, n))))
    const segment = norm.slice(cursor, groupEnd)
    const binding = { number: t.value, start: t.start, end: groupEnd, interval, rowIndex: null, candidates: candidates.map((r) => r.index), segment, violations: [] }
    const anyRowHasNumber = rows.some((r) => r.nums.some((x) => numbersEqual(x, t.value)))
    if (interval && !candidates.length && anyRowHasNumber) {
      binding.violations.push({ kind: 'interval-borrowed', reason: `No verified result prints ${t.value} with interval ${interval[0]}–${interval[1]}.` })
    }
    if (candidates.length === 1) {
      const row = candidates[0]
      binding.rowIndex = row.index
      // Outcome swap, high precision: the segment prints ANOTHER row's complete outcome
      // phrase, this row never prints any word of it, and the segment prints none of this
      // row's own outcome words. A composite that names its components, or a segment that
      // mentions both outcomes, is left to the model checker.
      const ownOutcomeInSegment = row.outcomeWords.some((w) => hasWord(segment, w))
      if (!ownOutcomeInSegment) {
        for (const other of rows) {
          if (other.index === row.index || !other.outcomeWords.length) continue
          const allPresent = other.outcomeWords.every((w) => hasWord(segment, w))
          const noneOwn = other.outcomeWords.every((w) => !hasWord(row.own, w))
          if (allPresent && noneOwn) binding.violations.push({ kind: 'outcome-mismatch', reason: `"${other.outcomeWords.join(' ')}" names the result "${other.name}", not "${row.name}".` })
        }
      }
      // Comparator order, high precision: every distinguishing word of the row's own
      // "A versus B" sits on the opposite side in the sentence, and the same order appears
      // nowhere in the segment.
      const pairs = comparatorPairs(segment)
      if (pairs.length) {
        const rowPairs = comparatorPairs(row.own).map(distinct).filter((rp) => rp.left.length && rp.right.length)
        for (const raw of pairs) {
          const p = distinct(raw)
          if (!p.left.length || !p.right.length) continue
          const same = rowPairs.some((rp) => subset(rp.left, p.left) && subset(rp.right, p.right))
          const reversed = rowPairs.some((rp) => subset(rp.left, p.right) && subset(rp.right, p.left))
          if (reversed && !same) binding.violations.push({ kind: 'comparator-reversed', reason: `"${raw.left.join(' ')} versus ${raw.right.join(' ')}" reverses the order the result prints.` })
        }
      }
      // Analysis family: the segment names exactly ONE analysis of a family, the row names
      // at least one of that family, and the segment's is not among them. Two analyses in
      // one segment (a contrast) are left to the model checker.
      for (const [family, terms] of Object.entries(ANALYSIS_FAMILIES)) {
        const inSegment = Object.entries(terms).filter(([, re]) => re.test(segment)).map(([k]) => k)
        if (inSegment.length !== 1) continue
        const inRow = Object.entries(terms).filter(([, re]) => re.test(row.own)).map(([k]) => k)
        if (!inRow.length || inRow.includes(inSegment[0])) continue
        binding.violations.push({ kind: 'analysis-mismatch', reason: `The sentence names the ${family} "${inSegment[0]}" but the result reports "${inRow.join(', ')}".` })
      }
    }
    bindings.push(binding)
    violations.push(...binding.violations.map((v) => ({ ...v, number: t.value })))
    cursor = groupEnd
    i += 1
  }
  return { ok: violations.length === 0, bindings, violations }
}
