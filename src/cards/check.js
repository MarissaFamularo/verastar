// cards/check.js — the claim checker. One claim in, one ClaimResult out.
//
// Every non-null field of a claim is an assertion. Each is BOUND to the evidence index — the
// located sentence, the labels it prints, the outcome definitions it links to, and the roles
// and owners the index gave its numbers — or it is unbound / contradicted. A number that is
// printed but owned by the other arm, another outcome, another cohort or another timepoint
// does not bind. Direction is derived from the bound tuple, never copied from the claim, and
// is dropped when the estimate fails (a withheld claim carries no direction of its own).
//
// Deterministic and paper-agnostic: no ids, titles or expected answers appear here.

import { normalize, numbersEqual, tokenSet, overlap, acronyms } from './text.js'
import { sentencesInSpan } from './index.js'
import { locateQuote } from '../pipeline/evidenceContext.js'
import { REASONS as R } from '../acceptance/schema.js'

const RESULT_KINDS = new Set(['effect', 'no-clear-difference', 'rate', 'count', 'author-statement', 'certainty'])
const RATIO = new Set(['HR', 'aHR', 'OR', 'aOR', 'RR', 'IRR'])
const DIFF = new Set(['MD', 'RD'])
const NULL_WORDS = /\bno (?:statistically )?significant difference\b|\bdid not differ\b|\bnot (?:significantly )?differ\b|\bsimilar\b|\bno (?:clear |meaningful )?difference\b|\bnot reach(?:ed)? (?:statistical )?significance\b/
const EQUIV_WORDS = /\bequivalen(?:t|ce)\b|\bnon-?inferior/
const SCOPE_WORDS = /\babstract\b|\breported\b|\bavailable\b|\bin this (?:text|paper|report|cohort|study)\b|\bin the (?:text|paper|report|cohort|study)\b|\bnot (?:separated|given|stated|provided)\b/
const OVERSCOPE = /\bnothing\b|\bnever\b|\bnot at all\b|\bno .* whatsoever\b|\bentirely\b/

const el = (elements, key, status) => { elements[key] = status }

function labelsIn(text, labels) {
  const n = normalize(text)
  return labels.filter((l) => new RegExp(`\\b${l.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(n))
}
// Which printed arm label a claim's arm text means: token overlap with the label words.
function armFor(text, arms) {
  const t = tokenSet(text)
  return arms.find((a) => overlap(tokenSet(a), t).length > 0) || null
}
function claimTimepoints(tp) {
  return tp ? [...normalize(tp).matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1])) : []
}

export function checkClaim(claim, index, options = {}) {
  const elements = {}
  const reasons = []
  const result = { id: claim.id, eligibility: 'fail', elements, linkage: 'none', reasons, bound: {} }
  const fail = (code) => { if (!reasons.includes(code)) reasons.push(code) }

  // ---- design-based claims without a quote: scope, never location ----------------------
  if (!claim.evidence && claim.basis === 'design') {
    const text = `${claim.text || ''} ${claim.outcome || ''}`
    if (OVERSCOPE.test(normalize(text)) || !SCOPE_WORDS.test(normalize(text))) {
      fail(R.ABSENCE_OVERSCOPED)
      return result
    }
    if (claim.kind === 'absence' && claim.outcome) {
      // Contradicted if a results sentence reports a numbered value for that outcome.
      const want = tokenSet(claim.outcome)
      const reported = index.sentences.some((s) => s.section === 'results' && s.nums.some((n) => n.role) && overlap(want, tokenSet(s.text)).length >= 2)
      if (reported) { fail(R.OUTCOME_UNBOUND); return result }
    }
    el(elements, 'role', claim.role === 'design' ? 'bound' : 'not-asserted')
    result.eligibility = 'pass-qualitative'
    return result
  }

  // ---- locate ---------------------------------------------------------------------------
  const span = claim.evidence ? locateQuote(index.norm, normalize(claim.evidence.quote)) : null
  if (!span) {
    if (RESULT_KINDS.has(claim.kind) && !index.available.results) {
      fail(R.SECTION_UNAVAILABLE)
      if (claim.attribution) fail(R.ATTRIBUTION_NOT_SUBSTITUTE)
      result.eligibility = 'excluded'
    } else {
      fail(R.QUOTE_NOT_LOCATED)
      if (claim.attribution) fail(R.ATTRIBUTION_NOT_SUBSTITUTE)
    }
    return result
  }
  const focal = sentencesInSpan(index, span)
  const focalText = focal.map((s) => s.text).join(' ')
  const focalNorm = normalize(focalText)
  const focalTokens = tokenSet(focalText)
  const nums = focal.flatMap((s) => s.nums)
  const tuples = focal.flatMap((s) => s.tuples)
  const armsMentioned = focal.flatMap((s) => s.armsMentioned)
  const inResults = focal.some((s) => s.section === 'results' || s.section === 'conclusions' || s.section === 'body')
  if (RESULT_KINDS.has(claim.kind) && !inResults && claim.kind !== 'author-statement') {
    // A result claim anchored in Methods/Background is not a result.
    if (!index.available.results) { fail(R.SECTION_UNAVAILABLE); if (claim.attribution) fail(R.ATTRIBUTION_NOT_SUBSTITUTE); result.eligibility = 'excluded'; return result }
  }

  // ---- population -----------------------------------------------------------------------
  const cohortLabels = index.labels.cohorts
  const resultClaim = ['effect', 'no-clear-difference', 'rate', 'count'].includes(claim.kind)
  if (claim.population) {
    const inClaim = labelsIn(claim.population, cohortLabels)
    const inFocal = labelsIn(focalText, cohortLabels)
    // Cohort structure constrains RESULT claims; a design/population claim describes the
    // whole study and binds on overlap with the Methods sentence it cites.
    if (inFocal.length && resultClaim) {
      if (inClaim.some((l) => inFocal.includes(l))) el(elements, 'population', 'bound')
      else if (!inClaim.length && cohortLabels.length >= 2) { el(elements, 'population', 'contradicted'); fail(R.POPULATION_OVERGENERALIZED) }
      else { el(elements, 'population', 'contradicted'); fail(R.POPULATION_UNBOUND) }
    } else if (inClaim.length && cohortLabels.length && resultClaim) {
      // Claim names a cohort the sentence does not: the sentence may still be about it only
      // when it is the Methods definition of that cohort.
      const defines = focal.some((s) => s.section === 'methods' && inClaim.some((l) => s.text.includes(l)))
      if (defines) el(elements, 'population', 'bound')
      else { el(elements, 'population', 'unbound'); fail(R.POPULATION_UNBOUND) }
    } else {
      // No cohort structure asserted: bind on overlap with the sentence or the Methods population.
      const want = tokenSet(claim.population)
      const methods = index.sentences.filter((s) => s.section === 'methods' || s.section === 'background' || s.section === 'body')
      const ok = overlap(want, focalTokens).length >= 1 || methods.some((s) => overlap(want, tokenSet(s.text)).length >= 2)
      if (ok) el(elements, 'population', 'bound'); else { el(elements, 'population', 'unbound'); fail(R.POPULATION_UNBOUND) }
      // A subgroup sentence described as the whole population.
      if (ok && claim.role !== 'subgroup' && inFocal.length === 0) {
        const subgroupWords = /\b(?:in the|among) (?:the )?([a-z-]+ (?:cohort|subgroup|stratum))\b/.exec(focalNorm)
        if (subgroupWords && !normalize(claim.population).includes(subgroupWords[1])) { el(elements, 'population', 'contradicted'); fail(R.POPULATION_OVERGENERALIZED); fail(R.SUBGROUP_AS_WHOLE) }
      }
    }
  } else el(elements, 'population', 'not-asserted')

  // ---- comparator -----------------------------------------------------------------------
  let armA = null, armB = null, posA = -1, posB = -1
  if (claim.comparator) {
    armA = armFor(claim.comparator.a, index.labels.arms)
    armB = armFor(claim.comparator.b, index.labels.arms)
    posA = armsMentioned.find((m) => m.label === armA)?.pos ?? -1
    posB = armsMentioned.find((m) => m.label === armB)?.pos ?? -1
    if (armA && armB && armA !== armB && posA >= 0 && posB >= 0) el(elements, 'comparator', 'bound')
    else {
      // Arms named without "group": accept both arm words present in the focal sentence.
      const aTok = overlap(tokenSet(claim.comparator.a), focalTokens).length > 0
      const bTok = overlap(tokenSet(claim.comparator.b), focalTokens).length > 0
      if (aTok && bTok && !armA && !armB) el(elements, 'comparator', 'bound')
      else { el(elements, 'comparator', 'unbound'); fail(R.COMPARATOR_UNBOUND) }
    }
  } else el(elements, 'comparator', 'not-asserted')

  // ---- outcome --------------------------------------------------------------------------
  const refersPrimary = /\bprimary[- ](?:outcome|end ?point)\b/.test(focalNorm)
  const refersSecondary = /\bsecondary[- ](?:outcome|end ?point)\b/.test(focalNorm)
  const primaryDefs = index.definitions.filter((d) => d.role === 'primary' || d.role === 'co-primary')
  let outcomeDef = null
  if (claim.outcome) {
    const want = tokenSet(claim.outcome)
    for (const a of acronyms(claim.outcome)) want.add(a)
    const isDefinitionSentence = focal.some((s) => index.definitions.some((d) => d.sentence.i === s.i))
    if (isDefinitionSentence) {
      const def = index.definitions.find((d) => focal.some((s) => s.i === d.sentence.i))
      if (overlap(want, def.allTokens).length >= 1 || overlap(want, def.headTokens).length >= 1) { el(elements, 'outcome', 'bound'); result.linkage = 'same-sentence'; outcomeDef = def }
      else { el(elements, 'outcome', 'unbound'); fail(R.OUTCOME_UNBOUND) }
    } else if ((refersPrimary || refersSecondary) && index.definitions.length) {
      const defs = refersPrimary ? primaryDefs : index.definitions.filter((d) => d.role === 'secondary')
      const def = defs[0]
      if (def && overlap(want, def.headTokens).length >= 1) { el(elements, 'outcome', 'bound'); result.linkage = 'definition-linked'; outcomeDef = def }
      else if (def && overlap(want, def.componentTokens).length >= 1) { el(elements, 'outcome', 'contradicted'); fail(R.OUTCOME_SUBSTITUTED) }
      else if (overlap(want, focalTokens).length >= 1 && !/\b(primary|secondary)\b/.test(normalize(claim.outcome))) { el(elements, 'outcome', 'bound'); result.linkage = 'same-sentence' }
      else { el(elements, 'outcome', 'unbound'); fail(R.OUTCOME_UNBOUND) }
    } else {
      const same = overlap(want, focalTokens)
      // The sentence's own outcome phrase: what precedes "occurred / was / were / rate of".
      const phraseMatch = /^(.{3,140}?)\s(?:occurred|was|were|rates? of|incidence of|died)\b/.exec(focalNorm)
      const phrase = phraseMatch ? phraseMatch[1].replace(/^.*?,\s*/, '') : ''
      const disjuncts = phrase.includes(' or ') ? phrase.split(/\s+or\s+/).map((d) => tokenSet(d)) : []
      const oneSideOnly = disjuncts.length >= 2 && disjuncts.filter((d) => overlap(want, d).length > 0).length === 1 && overlap(want, tokenSet(phrase)).length < Math.min(2, [...tokenSet(phrase)].length)
      if (oneSideOnly && !/\b(composite|or)\b/.test(normalize(claim.outcome))) {
        // A composite stated as "A or B" claimed as A alone (or B alone).
        el(elements, 'outcome', 'contradicted'); fail(R.OUTCOME_SUBSTITUTED)
      } else if (same.length >= 1) {
        el(elements, 'outcome', 'bound'); result.linkage = 'same-sentence'
      } else {
        // Previous sentence in the same section (adjacent linkage, explicit adjacency only).
        const prev = index.sentences[focal[0].i - 1]
        const prevOk = prev && prev.section === focal[0].section && overlap(want, tokenSet(prev.text)).length >= 1 && !prev.tuples.length
        const prevPrimary = prev && prev.section === focal[0].section && /\bprimary[- ](?:outcome|end ?point)\b/.test(prev.text) && primaryDefs[0] && overlap(want, primaryDefs[0].headTokens).length >= 1
        if (prevOk || prevPrimary) { el(elements, 'outcome', 'bound'); result.linkage = 'adjacent-sentence'; if (prevPrimary) outcomeDef = primaryDefs[0] }
        else {
          const def = index.definitions.find((d) => overlap(want, d.componentTokens).length >= 1)
          if (def && overlap(want, def.headTokens).length === 0 && (refersPrimary || focal.some((s) => s.tuples.length))) { el(elements, 'outcome', 'contradicted'); fail(R.OUTCOME_SUBSTITUTED) }
          else { el(elements, 'outcome', 'unbound'); fail(R.OUTCOME_UNBOUND) }
        }
      }
    }
  } else el(elements, 'outcome', 'not-asserted')

  // ---- timepoint ------------------------------------------------------------------------
  if (claim.timepoint) {
    const want = claimTimepoints(claim.timepoint)
    const here = nums.filter((n) => n.role === 'timepoint')
    const elsewhere = index.sentences.flatMap((s) => s.nums).filter((n) => n.role === 'timepoint')
    if (want.length && want.every((w) => here.some((n) => numbersEqual(n.value, w)))) el(elements, 'timepoint', 'bound')
    else if (want.some((w) => elsewhere.some((n) => numbersEqual(n.value, w)))) { el(elements, 'timepoint', 'contradicted'); fail(R.TIMEPOINT_MISMATCH) }
    else if (!want.length && overlap(tokenSet(claim.timepoint), focalTokens).length) el(elements, 'timepoint', 'bound')
    else { el(elements, 'timepoint', 'unbound'); fail(R.TIMEPOINT_UNBOUND) }
  } else el(elements, 'timepoint', 'not-asserted')

  // ---- estimate and arm values ---------------------------------------------------------
  let tuple = null
  let estimateOk = null // null = none asserted
  const simulate = (options.simulateEstimateFailure || []).includes(claim.id)
  if (claim.estimate) {
    estimateOk = true
    const e = claim.estimate
    const printedAnywhere = (v) => index.sentences.flatMap((s) => s.nums).some((n) => numbersEqual(n.value, v))
    if (e.measure === 'percent' || e.measure === 'rate') {
      const pct = nums.filter((n) => n.role === 'percent')
      const hit = pct.find((n) => numbersEqual(n.value, e.value))
      if (!hit) { estimateOk = false; el(elements, 'value', printedAnywhere(e.value) ? 'contradicted' : 'unbound'); fail(R.VALUE_MISMATCH) }
      else {
        // owner arm: the claim's population or comparator must name that arm, not the other.
        const owner = hit.arm
        const named = armFor(`${claim.population || ''} ${claim.comparator?.a || ''}`, index.labels.arms)
        if (owner && named && named !== owner) { estimateOk = false; el(elements, 'value', 'contradicted'); fail(R.ARM_VALUE_MISMATCH) }
        else el(elements, 'value', 'bound')
      }
      if (e.interval) {
        const ok = nums.some((n) => n.role === 'ci-low' && numbersEqual(n.value, e.interval.low)) && nums.some((n) => n.role === 'ci-high' && numbersEqual(n.value, e.interval.high))
        if (ok) el(elements, 'interval', 'bound'); else { estimateOk = false; el(elements, 'interval', 'unbound'); fail(R.INTERVAL_MISMATCH) }
      }
    } else if (e.measure === 'count') {
      const hit = nums.find((n) => (n.role === 'enrollment' || n.role === 'count' || n.role === 'denominator') && numbersEqual(n.value, e.value))
      if (hit) el(elements, 'value', 'bound'); else { estimateOk = false; el(elements, 'value', 'unbound'); fail(R.VALUE_MISMATCH) }
    } else {
      // ratio / difference tuple: measure family, value, interval, label, p, unit, sample
      const family = (m) => (RATIO.has(m) ? 'ratio' : DIFF.has(m) ? 'diff' : m)
      const candidates = tuples.filter((t) => t.measure && family(t.measure) === family(e.measure))
      tuple = candidates.find((t) => numbersEqual(t.value, e.value)) || null
      if (!tuple) {
        estimateOk = false
        const other = tuples.find((t) => numbersEqual(t.value, e.value))
        if (other) { el(elements, 'value', 'contradicted'); fail(R.MEASURE_MISMATCH) }
        else { el(elements, 'value', printedAnywhere(e.value) ? 'contradicted' : 'unbound'); fail(R.VALUE_MISMATCH) }
      } else {
        if (tuple.measure !== e.measure && !(e.measure === 'HR' && tuple.measure === 'aHR') && !(e.measure === 'aHR' && tuple.measure === 'HR')) { estimateOk = false; el(elements, 'value', 'contradicted'); fail(R.MEASURE_MISMATCH) }
        else el(elements, 'value', 'bound')
        if (e.interval) {
          if (!numbersEqual(tuple.low, e.interval.low) || !numbersEqual(tuple.high, e.interval.high)) { estimateOk = false; el(elements, 'interval', 'contradicted'); fail(R.INTERVAL_MISMATCH) }
          else if (tuple.label === 'printed-bracket' && e.interval.label && e.interval.label !== 'printed-bracket') { estimateOk = false; el(elements, 'interval', 'contradicted'); fail(R.INTERVAL_LABEL_INVENTED) }
          else el(elements, 'interval', 'bound')
        }
        if (e.p != null) {
          if (tuple.p && numbersEqual(tuple.p.value, e.p)) el(elements, 'p', 'bound')
          else { estimateOk = false; el(elements, 'p', 'contradicted'); fail(R.P_MISMATCH) }
        }
        if (e.unit) {
          const u = normalize(e.unit).replace('meters', 'metres')
          const tu = (tuple.unit || '').replace('meters', 'metres')
          if (tu === u || (u === 'percentage points' && /percentage points/.test(focalNorm))) el(elements, 'unit', 'bound')
          else { estimateOk = false; el(elements, 'unit', 'unbound'); fail(R.VALUE_MISMATCH) }
        }
        if (e.sample) {
          const after = focalNorm.slice(focalNorm.indexOf(String(e.value)))
          const studies = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (?:studies|trials|rcts)/.exec(after)
          const parts = /(\d+) participants/.exec(after)
          const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
          const sOk = e.sample.studies == null || (studies && (WORDS[studies[1]] ?? parseInt(studies[1], 10)) === e.sample.studies)
          const pOk = e.sample.participants == null || (parts && parseInt(parts[1], 10) === e.sample.participants)
          if (sOk && pOk) el(elements, 'sample', 'bound'); else { estimateOk = false; el(elements, 'sample', 'contradicted'); fail(R.SAMPLE_MISMATCH) }
        }
      }
    }
    if (simulate) { estimateOk = false; fail(R.ESTIMATE_UNCHECKED); for (const k of ['value', 'interval', 'p']) if (elements[k] === 'bound') elements[k] = 'unbound' }
  }
  if (claim.arms?.length) {
    let ok = true
    for (const a of claim.arms) {
      const label = a.arm === 'a' ? armA : armB
      for (const [key, role] of [['percent', 'percent'], ['count', 'count'], ['denominator', 'denominator']]) {
        if (a[key] == null) continue
        const tok = nums.find((n) => n.role === role && numbersEqual(n.value, a[key]))
        if (!tok) { ok = false; fail(R.VALUE_MISMATCH) }
        else if (tok.arm && label && tok.arm !== label) { ok = false; fail(R.ARM_VALUE_MISMATCH) }
      }
    }
    el(elements, 'arms', ok ? 'bound' : 'contradicted')
    if (!ok) estimateOk = estimateOk === null ? false : estimateOk && false
  }

  // ---- direction ------------------------------------------------------------------------
  if (claim.direction) {
    const t = tuple || tuples[0] || null
    let derived = null
    let orientationOk = true
    if (t && !simulate && (estimateOk !== false || !claim.estimate)) {
      const isRatio = RATIO.has(t.measure)
      const nul = isRatio ? 1 : 0
      const sig = t.low != null && t.high != null ? (t.high < nul ? 'first' : t.low > nul ? 'second' : 'null') : t.p ? (t.p.value < 0.05 && (t.p.op === '<' || t.p.op === '=') ? (t.value < nul ? 'first' : 'second') : 'null') : null
      // orientation: first-mentioned arm vs second; cross-checked against printed arm rates
      const first = armsMentioned[0]?.label, second = armsMentioned[1]?.label
      const pcts = nums.filter((n) => n.role === 'percent' && n.arm)
      if (first && second && pcts.length >= 2 && isRatio) {
        const pf = pcts.find((n) => n.arm === first)?.value, ps = pcts.find((n) => n.arm === second)?.value
        if (pf != null && ps != null && pf !== ps && ((t.value < 1) !== (pf < ps))) orientationOk = false
      }
      if (sig === 'null') derived = 'no-clear-difference'
      else if (sig && orientationOk) {
        // the favoured arm is the first-mentioned one when the ratio is < 1 (difference < 0)
        const fav = (isRatio ? t.value < 1 : t.value < 0) ? first : second
        if (armA && fav) derived = fav === armA ? 'favors-a' : fav === armB ? 'favors-b' : null
        else if (!claim.comparator) derived = sig === 'first' ? 'favors-a' : 'favors-b'
      }
    } else if (!t && NULL_WORDS.test(focalNorm)) derived = 'no-clear-difference'
    else if (!t && !claim.estimate && focal.some((s) => s.section === 'conclusions')) {
      // A conclusions sentence: direction words bind the authors' stated conclusion.
      const lower = /\b(?:significantly )?(?:lower|fewer|reduced|better|improved)\b/.test(focalNorm)
      const higher = /\b(?:significantly )?(?:higher|greater|more|worse|increased)\b/.test(focalNorm)
      if (lower !== higher && armA && armB && posA >= 0 && posB >= 0) {
        const firstArm = posA < posB ? 'a' : 'b'
        const favoursFirst = lower // "lower in the first-mentioned group than in the second"
        derived = (favoursFirst ? firstArm : firstArm === 'a' ? 'b' : 'a') === 'a' ? 'favors-a' : 'favors-b'
      } else if (lower !== higher && !claim.comparator) derived = null
      else if (NULL_WORDS.test(focalNorm)) derived = 'no-clear-difference'
    }
    if (claim.direction === 'equivalent' || claim.direction === 'non-inferior') {
      if (EQUIV_WORDS.test(focalNorm)) el(elements, 'direction', 'bound'); else { el(elements, 'direction', 'contradicted'); fail(R.EQUIVALENCE_NOT_TESTED) }
    } else if (derived && derived === claim.direction) el(elements, 'direction', 'bound')
    else if (derived) { el(elements, 'direction', 'contradicted'); fail(R.DIRECTION_UNSUPPORTED) }
    else { el(elements, 'direction', 'unbound'); if (!(claim.estimate && estimateOk === false)) fail(R.DIRECTION_UNSUPPORTED) }
  } else el(elements, 'direction', 'not-asserted')

  // ---- language -------------------------------------------------------------------------
  if (claim.language === 'causal') {
    if (index.design.randomized && !index.design.observational && elements.comparator !== 'unbound') el(elements, 'language', 'bound')
    else { el(elements, 'language', 'contradicted'); fail(R.CAUSAL_LANGUAGE_NONRANDOMIZED) }
  } else el(elements, 'language', claim.language === 'associational' ? 'bound' : 'not-asserted')

  // ---- role -----------------------------------------------------------------------------
  if (!claim.role || claim.role === 'reported') el(elements, 'role', 'not-asserted')
  else if (claim.role === 'design') el(elements, 'role', 'bound')
  else if (claim.role === 'primary' || claim.role === 'co-primary') {
    if (refersPrimary || (outcomeDef && (outcomeDef.role === 'primary' || outcomeDef.role === 'co-primary'))) el(elements, 'role', 'bound')
    else if (!primaryDefs.length) { el(elements, 'role', 'positional-only'); fail(R.ROLE_UNVERIFIED) }
    else { el(elements, 'role', 'unbound'); fail(R.ROLE_UNVERIFIED) }
  } else if (claim.role === 'secondary') el(elements, 'role', refersSecondary || /\bsecondary\b/.test(focalNorm) || (outcomeDef && outcomeDef.role === 'secondary') ? 'bound' : 'positional-only')
  else if (claim.role === 'component') el(elements, 'role', primaryDefs.some((d) => overlap(tokenSet(claim.outcome || ''), d.allTokens).length) ? 'bound' : 'positional-only')
  else if (claim.role === 'subgroup') el(elements, 'role', /\bsubgroup|cohort|grade|stratum|among patients\b/.test(focalNorm) ? 'bound' : 'positional-only')
  else if (claim.role === 'safety') el(elements, 'role', /\badverse|complication|safety|harm|headache\b/.test(focalNorm) ? 'bound' : 'positional-only')
  else el(elements, 'role', 'positional-only')

  // ---- eligibility ----------------------------------------------------------------------
  const qualitativeKeys = ['population', 'comparator', 'outcome', 'timepoint', 'language']
  const qualitativeBad = qualitativeKeys.some((k) => elements[k] === 'unbound' || elements[k] === 'contradicted')
  const directionBad = elements.direction === 'contradicted' || (elements.direction === 'unbound' && !(claim.estimate && estimateOk === false))
  if (qualitativeBad || directionBad) result.eligibility = 'fail'
  else if (claim.estimate || claim.arms?.length) {
    if (estimateOk === false) { result.eligibility = 'withhold'; if (elements.direction === 'bound') elements.direction = 'unbound' }
    else result.eligibility = elements.role === 'positional-only' ? 'pass-qualitative' : 'pass'
  } else result.eligibility = 'pass-qualitative'
  if (result.eligibility === 'withhold' && !reasons.length) fail(R.ESTIMATE_UNCHECKED)
  if (result.eligibility === 'fail' && !reasons.length) fail(R.DIRECTION_UNSUPPORTED)
  result.bound = { armA, armB, tuple, outcomeDef: outcomeDef ? { headTokens: [...outcomeDef.headTokens], componentTokens: [...outcomeDef.componentTokens] } : null, cohortLabels: labelsIn(claim.population || '', cohortLabels) }
  return result
}
