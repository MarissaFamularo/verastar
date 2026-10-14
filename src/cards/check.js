// cards/check.js — the claim checker. One claim in, one ClaimResult out.
//
// Every non-null field of a claim is an assertion. Each is BOUND to the evidence index — the
// located sentence, the labels it prints, the outcome phrase that owns the matched tuple, the
// definitions that phrase links to, and the roles and owners the index gave its numbers — or
// it is unbound (the source does not let us check it) or contradicted (the source says
// otherwise). The two are kept apart: a contradicted estimate makes the claim ineligible; an
// unbound estimate on an otherwise bound claim withholds the estimate. Direction is derived
// from the bound tuple, never copied from the claim, and dropped when the estimate fails.
//
// Outcome identity is resolved to a complete endpoint — a definition's core, or the sentence's
// own outcome phrase — and a claim that names one component or one disjunct of a composite is
// a substitution, not a match. One shared word never establishes identity.
//
// Deterministic and paper-agnostic: no ids, titles or expected answers appear here.

import { normalize, numbersEqual, tokens, tokenSet, overlap, acronyms } from './text.js'
import { sentencesInSpan, expand } from './index.js'
import { locateQuote } from '../pipeline/evidenceContext.js'
import { REASONS as R } from '../acceptance/schema.js'

const RESULT_KINDS = new Set(['effect', 'no-clear-difference', 'rate', 'count', 'author-statement', 'certainty'])
const RATIO = new Set(['HR', 'aHR', 'OR', 'aOR', 'RR', 'IRR'])
const DIFF = new Set(['MD', 'RD'])
const NULL_WORDS = /\bno (?:statistically )?significant difference\b|\bdid not differ\b|\bnot (?:significantly )?differ\b|\bsimilar\b|\bno (?:clear |meaningful )?difference\b|\bnot reach(?:ed)? (?:statistical )?significance\b/
const EQUIV_WORDS = /\bequivalen(?:t|ce)\b|\bnon-?inferior/
const SCOPE_WORDS = /\babstract\b|\breported\b|\bavailable\b|\bin this (?:text|paper|report|cohort|study)\b|\bin the (?:text|paper|report|cohort|study)\b|\bnot (?:separated|given|stated|provided)\b/
const OVERSCOPE = /\bnothing\b|\bnever\b|\bnot at all\b|\bno .* whatsoever\b|\bentirely\b/
const ROLE_WORDS = new Set(['primary', 'secondary', 'co-primary', 'composite', 'endpoint', 'outcome'])
const el = (elements, key, status) => { elements[key] = status }

function labelsIn(text, labels) {
  const n = normalize(text)
  return labels.filter((l) => new RegExp(`\\b${l.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(n))
}
function armFor(text, arms) {
  const t = tokenSet(text)
  return arms.find((a) => overlap(tokenSet(a), t).length > 0) || null
}

// ---- timepoints: value, unit and sense ----------------------------------------------------
const UNIT_WORD = /(\d+(?:\.\d+)?)\s*-?\s*(years?|months?|weeks?|days?)\b/g
function parseTimepoint(tp) {
  const n = normalize(tp)
  const items = [...n.matchAll(UNIT_WORD)].map((m) => ({ value: parseFloat(m[1]), unit: m[2].replace(/s$/, '') }))
  const sense = /\bmedian|\bmean\b/.test(n) ? 'median-follow-up' : /\bminimum|\bat least\b/.test(n) ? 'minimum-follow-up' : /\bfor\b|\bduration|\blasting\b/.test(n) ? 'duration' : 'fixed'
  return { items, sense, explicit: /\bmedian|\bmean\b|\bminimum|\bat least\b|\bfor\b|\bduration|\bat\b|\bby\b|\bwithin\b/.test(n) }
}

// ---- outcome identity --------------------------------------------------------------------
// Does a claim's outcome name the complete endpoint `ep` ({tokens, disjuncts, core?}) and not
// merely a part of it?  'identity' | 'component' | 'none'
function identity(claimTokens, ep, claimAcronyms = new Set()) {
  // the claim may use only words the endpoint (core or components) uses
  const vocabulary = ep.all || ep.tokens
  const extra = [...claimTokens].filter((t) => !vocabulary.has(t) && !ROLE_WORDS.has(t) && !(ep.acronyms && ep.acronyms.has(t)))
  if (extra.length) return 'none'
  const coreShared = overlap(claimTokens, ep.tokens)
  const sayComposite = claimTokens.has('composite') || (ep.acronyms && [...claimTokens, ...claimAcronyms].some((t) => ep.acronyms.has(t)))
  const coreSize = [...ep.tokens].filter((t) => t.length > 2 && !(ep.acronyms && ep.acronyms.has(t))).length
  // naming the core itself (half its words or more) is identity
  if (sayComposite || (coreShared.length >= Math.max(1, Math.ceil(coreSize / 2)) && coreSize <= 3) || (coreShared.length >= Math.ceil(coreSize / 2) && coreShared.length >= 2)) return 'identity'
  const disj = ep.disjuncts || []
  if (disj.length >= 2) {
    const covered = disj.filter((d) => overlap(claimTokens, d).length > 0).length
    if (covered === disj.length) return 'identity'
    return covered ? 'component' : 'none'
  }
  if (!coreShared.length) return ep.components && overlap(claimTokens, ep.components).length ? 'component' : 'none'
  return coreSize <= 2 ? 'identity' : 'component'
}
const defEndpoint = (def) => ({ kind: 'definition', key: `def:${def.sentence.i}:${def.role}`, tokens: def.coreTokens, all: def.allTokens, disjuncts: def.coreDisjuncts.length >= 2 ? def.coreDisjuncts : def.componentDisjuncts.length >= 2 ? def.componentDisjuncts : [], acronyms: new Set([...acronyms(def.core)].filter((a) => a.length >= 3)), components: def.componentTokens, def })
const phraseEndpoint = (p, i) => ({ kind: 'phrase', key: `phrase:${i}:${[...p.tokens].sort().join('+')}`, tokens: p.tokens, disjuncts: p.disjuncts, components: new Set() })
export { parseTimepoint }

export function checkClaim(claim, index, options = {}) {
  const elements = {}
  const reasons = []
  const result = { id: claim.id, eligibility: 'fail', elements, linkage: 'none', reasons, bound: {} }
  const fail = (code) => { if (!reasons.includes(code)) reasons.push(code) }

  // ---- design-based claims without a quote: scope, never location ----------------------
  if (!claim.evidence && claim.basis === 'design') {
    const text = `${claim.text || ''} ${claim.outcome || ''}`
    if (OVERSCOPE.test(normalize(text)) || !SCOPE_WORDS.test(normalize(text))) { fail(R.ABSENCE_OVERSCOPED); return result }
    if (claim.kind === 'absence' && claim.outcome) {
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
      fail(R.SECTION_UNAVAILABLE); if (claim.attribution) fail(R.ATTRIBUTION_NOT_SUBSTITUTE); result.eligibility = 'excluded'
    } else { fail(R.QUOTE_NOT_LOCATED); if (claim.attribution) fail(R.ATTRIBUTION_NOT_SUBSTITUTE) }
    return result
  }
  const focal = sentencesInSpan(index, span)
  const focalText = focal.map((s) => s.text).join(' ')
  const focalNorm = normalize(focalText)
  const focalTokens = new Set(expand(tokens(focalText), index.abbr))
  const nums = focal.flatMap((s) => s.nums)
  const tuples = focal.flatMap((s) => s.tuples)
  const phrases = focal.flatMap((s) => s.phrases)
  const armsMentioned = focal.flatMap((s) => s.armsMentioned)
  const inConclusions = focal.some((s) => s.section === 'conclusions')
  const inResults = focal.some((s) => s.section === 'results' || s.section === 'body') || inConclusions
  if (RESULT_KINDS.has(claim.kind) && !inResults && claim.kind !== 'author-statement' && !index.available.results) {
    fail(R.SECTION_UNAVAILABLE); if (claim.attribution) fail(R.ATTRIBUTION_NOT_SUBSTITUTE); result.eligibility = 'excluded'; return result
  }

  // ---- population -----------------------------------------------------------------------
  const cohortLabels = index.labels.cohorts
  const resultClaim = ['effect', 'no-clear-difference', 'rate', 'count'].includes(claim.kind)
  if (claim.population) {
    const inClaim = labelsIn(claim.population, cohortLabels)
    const inFocal = labelsIn(focalText, cohortLabels)
    if (inFocal.length && resultClaim) {
      if (inClaim.some((l) => inFocal.includes(l))) el(elements, 'population', 'bound')
      else if (!inClaim.length && cohortLabels.length >= 2) { el(elements, 'population', 'contradicted'); fail(R.POPULATION_OVERGENERALIZED) }
      else { el(elements, 'population', 'contradicted'); fail(R.POPULATION_UNBOUND) }
    } else if (inClaim.length && cohortLabels.length && resultClaim) {
      const defines = focal.some((s) => s.section === 'methods' && inClaim.some((l) => s.text.includes(l)))
      if (defines) el(elements, 'population', 'bound'); else { el(elements, 'population', 'unbound'); fail(R.POPULATION_UNBOUND) }
    } else {
      const want = tokenSet(claim.population)
      const methods = index.sentences.filter((s) => ['methods', 'background', 'body'].includes(s.section))
      const ok = overlap(want, focalTokens).length >= 1 || methods.some((s) => overlap(want, tokenSet(s.text)).length >= 2) || overlap(want, tokenSet(index.title)).length >= 2
      if (ok) el(elements, 'population', 'bound'); else { el(elements, 'population', 'unbound'); fail(R.POPULATION_UNBOUND) }
      if (ok && resultClaim && claim.role !== 'subgroup' && inFocal.length === 0) {
        const sub = /\b(?:in the|among) (?:the )?([a-z-]+ (?:cohort|subgroup|stratum))\b/.exec(focalNorm)
        if (sub && !normalize(claim.population).includes(sub[1])) { el(elements, 'population', 'contradicted'); fail(R.POPULATION_OVERGENERALIZED); fail(R.SUBGROUP_AS_WHOLE) }
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
    const aWord = armA ? focalNorm.indexOf(armA) : -1, bWord = armB ? focalNorm.indexOf(armB) : -1
    if (armA && armB && armA !== armB && ((posA >= 0 && posB >= 0) || (aWord >= 0 && bWord >= 0))) { el(elements, 'comparator', 'bound'); if (posA < 0) posA = aWord; if (posB < 0) posB = bWord }
    else if (armA && armB && armA !== armB && inConclusions && (aWord >= 0 || bWord >= 0)) { el(elements, 'comparator', 'bound'); posA = aWord; posB = bWord } // a conclusion names the arm it favours; the other is the trial's only comparator
    else {
      const aTok = overlap(tokenSet(claim.comparator.a), focalTokens).length > 0
      const bTok = overlap(tokenSet(claim.comparator.b), focalTokens).length > 0
      if (aTok && bTok && !armA && !armB) el(elements, 'comparator', 'bound')
      else { el(elements, 'comparator', 'unbound'); fail(R.COMPARATOR_UNBOUND) }
    }
  } else el(elements, 'comparator', 'not-asserted')

  // ---- estimate tuple selection (needed to know which outcome phrase owns the value) ------
  let tuple = null
  const family = (m) => (RATIO.has(m) ? 'ratio' : DIFF.has(m) ? 'diff' : m)
  if (claim.estimate && !['percent', 'rate', 'count'].includes(claim.estimate.measure)) {
    const cands = tuples.filter((t) => t.measure && family(t.measure) === family(claim.estimate.measure))
    tuple = cands.find((t) => numbersEqual(t.value, claim.estimate.value)) || null
  }

  // ---- outcome --------------------------------------------------------------------------
  const primaryDefs = index.definitions.filter((d) => d.role === 'primary' || d.role === 'co-primary')
  const secondaryDefs = index.definitions.filter((d) => d.role === 'secondary')
  let endpoint = null
  if (claim.outcome) {
    const want = new Set(expand(tokens(claim.outcome), index.abbr))
    const wantAcr = new Set([...acronyms(claim.outcome)].filter((a) => a.length >= 3))
    const defHere = index.definitions.find((d) => focal.some((s) => s.i === d.sentence.i))
    // candidate endpoints, most specific first: the phrase owning the matched tuple, else the
    // sentence's phrases; a phrase that refers to the primary/secondary outcome or that
    // matches a definition resolves to that definition.
    let candidates = []
    const resolve = (p) => {
      if (p.refersPrimary && primaryDefs[0]) return defEndpoint(primaryDefs[0])
      if (p.refersSecondary && secondaryDefs[0]) return defEndpoint(secondaryDefs[0])
      for (const d of index.definitions) {
        const ep = defEndpoint(d)
        if (identity(p.tokens, ep) === 'identity') return ep
      }
      return phraseEndpoint(p, focal[0].i)
    }
    if (defHere) candidates = [defEndpoint(defHere)]
    else if (tuple && tuple.owner) candidates = [resolve(tuple.owner)]
    else if (phrases.length) candidates = phrases.map(resolve)
    else {
      const prev = index.sentences[focal[0].i - 1]
      if (prev && prev.section === focal[0].section && !prev.tuples.length && prev.phrases.length) {
        candidates = prev.phrases.map(resolve); result.linkage = 'adjacent-sentence'
      }
    }
    let verdict = 'none'
    for (const ep of candidates) {
      const v = identity(want, ep, wantAcr)
      if (v === 'identity') { verdict = 'identity'; endpoint = ep; break }
      if (v === 'component') { verdict = 'component'; endpoint = ep }
    }
    // substitution in the other direction: the claim names a composite while the sentence
    // reports one of its components
    if (verdict === 'none') {
      for (const d of index.definitions) {
        const ep = defEndpoint(d)
        if (identity(want, ep, wantAcr) === 'identity' && candidates.some((c) => c.kind === 'phrase' && identity(c.tokens, ep) === 'component')) verdict = 'component'
      }
    }
    if (verdict === 'identity') {
      el(elements, 'outcome', 'bound')
      if (result.linkage === 'none') result.linkage = endpoint.kind === 'definition' && !defHere ? 'definition-linked' : 'same-sentence'
    } else if (verdict === 'component') { el(elements, 'outcome', 'contradicted'); fail(R.OUTCOME_SUBSTITUTED) }
    else { el(elements, 'outcome', 'unbound'); fail(R.OUTCOME_UNBOUND) }
  } else el(elements, 'outcome', 'not-asserted')

  // ---- timepoint: value, unit, sense -----------------------------------------------------
  if (claim.timepoint) {
    const want = parseTimepoint(claim.timepoint)
    const here = nums.filter((n) => n.role === 'timepoint')
    const all = index.sentences.flatMap((s) => s.nums).filter((n) => n.role === 'timepoint')
    if (!want.items.length) { el(elements, 'timepoint', overlap(tokenSet(claim.timepoint), focalTokens).length ? 'bound' : 'unbound'); if (elements.timepoint === 'unbound') fail(R.TIMEPOINT_UNBOUND) }
    else {
      const exact = want.items.every((w) => here.some((n) => numbersEqual(n.value, w.value) && n.unit === w.unit && n.sense === want.sense))
      if (exact) el(elements, 'timepoint', 'bound')
      else {
        const sameNumber = want.items.some((w) => all.some((n) => numbersEqual(n.value, w.value)))
        const sameNumberUnit = want.items.some((w) => here.some((n) => numbersEqual(n.value, w.value) && n.unit === w.unit))
        el(elements, 'timepoint', sameNumber ? 'contradicted' : 'unbound')
        fail(sameNumberUnit ? R.TIMEPOINT_MEANING_MISMATCH : sameNumber ? (here.some((n) => want.items.some((w) => numbersEqual(n.value, w.value))) ? R.TIMEPOINT_UNIT_MISMATCH : R.TIMEPOINT_MISMATCH) : R.TIMEPOINT_UNBOUND)
      }
    }
  } else el(elements, 'timepoint', 'not-asserted')

  // ---- estimate and arm values ---------------------------------------------------------
  // estimateState: null (none asserted) | 'bound' | 'unbound' (cannot verify) | 'contradicted'
  let estimateState = null
  const simulate = (options.simulateEstimateFailure || []).includes(claim.id)
  const printedAnywhere = (v) => index.sentences.flatMap((s) => s.nums).some((n) => numbersEqual(n.value, v))
  const setEst = (st) => { estimateState = estimateState === 'contradicted' ? 'contradicted' : st === 'contradicted' ? 'contradicted' : estimateState === 'unbound' ? 'unbound' : st }
  if (claim.estimate) {
    estimateState = 'bound'
    const e = claim.estimate
    if (e.measure === 'percent' || e.measure === 'rate') {
      const hit = nums.filter((n) => n.role === 'percent').find((n) => numbersEqual(n.value, e.value))
      if (!hit) { setEst(printedAnywhere(e.value) ? 'contradicted' : 'unbound'); el(elements, 'value', printedAnywhere(e.value) ? 'contradicted' : 'unbound'); fail(R.VALUE_MISMATCH) }
      else {
        const named = armFor(`${claim.population || ''} ${claim.comparator?.a || ''}`, index.labels.arms)
        if (hit.arm && named && named !== hit.arm) { setEst('contradicted'); el(elements, 'value', 'contradicted'); fail(R.ARM_VALUE_MISMATCH) }
        else el(elements, 'value', 'bound')
      }
      if (e.interval) {
        const ok = nums.some((n) => n.role === 'ci-low' && numbersEqual(n.value, e.interval.low)) && nums.some((n) => n.role === 'ci-high' && numbersEqual(n.value, e.interval.high))
        if (ok) el(elements, 'interval', 'bound'); else { setEst('unbound'); el(elements, 'interval', 'unbound'); fail(R.INTERVAL_MISMATCH) }
      }
    } else if (e.measure === 'count') {
      const hit = nums.find((n) => ['enrollment', 'count', 'denominator'].includes(n.role) && numbersEqual(n.value, e.value))
      if (hit) el(elements, 'value', 'bound'); else { setEst(printedAnywhere(e.value) ? 'contradicted' : 'unbound'); el(elements, 'value', 'unbound'); fail(R.VALUE_MISMATCH) }
    } else if (!tuple) {
      const other = tuples.find((t) => numbersEqual(t.value, e.value))
      if (other) { setEst('contradicted'); el(elements, 'value', 'contradicted'); fail(R.MEASURE_MISMATCH) }
      else { const printed = printedAnywhere(e.value); setEst(printed ? 'contradicted' : 'unbound'); el(elements, 'value', printed ? 'contradicted' : 'unbound'); fail(R.VALUE_MISMATCH) }
    } else {
      if (tuple.measure !== e.measure && !(e.measure === 'HR' && tuple.measure === 'aHR') && !(e.measure === 'aHR' && tuple.measure === 'HR')) { setEst('contradicted'); el(elements, 'value', 'contradicted'); fail(R.MEASURE_MISMATCH) }
      else el(elements, 'value', 'bound')
      if (e.interval) {
        if (!numbersEqual(tuple.low, e.interval.low) || !numbersEqual(tuple.high, e.interval.high)) { setEst('contradicted'); el(elements, 'interval', 'contradicted'); fail(R.INTERVAL_MISMATCH) }
        else if (tuple.label === 'printed-bracket') {
          if (e.interval.label && e.interval.label !== 'printed-bracket') { setEst('contradicted'); el(elements, 'interval', 'contradicted'); fail(R.INTERVAL_LABEL_INVENTED) } else el(elements, 'interval', 'bound')
        } else if (tuple.label) {
          // a labeled interval binds only with its stated confidence level
          if (normalize(e.interval.label || '') === normalize(tuple.label)) el(elements, 'interval', 'bound')
          else { setEst(e.interval.label ? 'contradicted' : 'unbound'); el(elements, 'interval', e.interval.label ? 'contradicted' : 'unbound'); fail(R.INTERVAL_LEVEL_MISMATCH) }
        } else { setEst('unbound'); el(elements, 'interval', 'unbound'); fail(R.INTERVAL_LEVEL_MISMATCH) }
      }
      if (e.p != null) {
        if (tuple.p && numbersEqual(tuple.p.value, e.p)) el(elements, 'p', 'bound')
        else { setEst(tuple.p || printedAnywhere(e.p) ? 'contradicted' : 'unbound'); el(elements, 'p', 'contradicted'); fail(R.P_MISMATCH) }
      }
      if (e.unit) {
        const u = normalize(e.unit).replace('meters', 'metres'), tu = (tuple.unit || '').replace('meters', 'metres')
        if (tu === u || (u === 'percentage points' && /percentage points/.test(focalNorm))) el(elements, 'unit', 'bound')
        else { setEst('unbound'); el(elements, 'unit', 'unbound'); fail(R.VALUE_MISMATCH) }
      }
      if (e.sample) {
        const after = focalNorm.slice(focalNorm.indexOf(String(e.value)))
        const studies = /(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (?:studies|trials|rcts)/.exec(after)
        const parts = /(\d+) participants/.exec(after)
        const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 }
        const sOk = e.sample.studies == null || (studies && (WORDS[studies[1]] ?? parseInt(studies[1], 10)) === e.sample.studies)
        const pOk = e.sample.participants == null || (parts && parseInt(parts[1], 10) === e.sample.participants)
        if (sOk && pOk) el(elements, 'sample', 'bound'); else { setEst('contradicted'); el(elements, 'sample', 'contradicted'); fail(R.SAMPLE_MISMATCH) }
      }
    }
    if (simulate) { setEst('unbound'); fail(R.ESTIMATE_UNCHECKED); for (const k of ['value', 'interval', 'p']) if (elements[k] === 'bound') elements[k] = 'unbound' }
  }
  if (claim.arms?.length) {
    let st = 'bound'
    for (const a of claim.arms) {
      const label = a.arm === 'a' ? armA : armB
      for (const [key, role] of [['percent', 'percent'], ['count', 'count'], ['denominator', 'denominator']]) {
        if (a[key] == null) continue
        const tok = nums.find((n) => n.role === role && numbersEqual(n.value, a[key]))
        if (!tok) { st = st === 'contradicted' ? st : 'unbound'; fail(R.VALUE_MISMATCH) }
        else if (tok.arm && label && tok.arm !== label) { st = 'contradicted'; fail(R.ARM_VALUE_MISMATCH) }
      }
    }
    el(elements, 'arms', st)
    if (st !== 'bound') { if (estimateState === null) estimateState = st; else setEst(st) }
  }
  const estimateFailed = estimateState === 'unbound' || estimateState === 'contradicted'

  // ---- direction ------------------------------------------------------------------------
  if (claim.direction) {
    const t = tuple || (!claim.estimate ? tuples[0] : null)
    let derived = null
    if (t && !estimateFailed) {
      const isRatio = RATIO.has(t.measure)
      const nul = isRatio ? 1 : 0
      const sig = t.low != null && t.high != null ? (t.high < nul ? 'first' : t.low > nul ? 'second' : 'null') : t.p ? (t.p.value < 0.05 && t.p.op !== '>' ? (t.value < nul ? 'first' : 'second') : 'null') : null
      const first = armsMentioned[0]?.label, second = armsMentioned[1]?.label
      const pcts = nums.filter((n) => n.role === 'percent' && n.arm)
      let orientationOk = true
      if (first && second && pcts.length >= 2 && isRatio) {
        const pf = pcts.find((n) => n.arm === first)?.value, ps = pcts.find((n) => n.arm === second)?.value
        if (pf != null && ps != null && pf !== ps && ((t.value < 1) !== (pf < ps))) orientationOk = false
      }
      if (sig === 'null') derived = 'no-clear-difference'
      else if (sig && orientationOk) {
        const fav = (isRatio ? t.value < 1 : t.value < 0) ? first : second
        if (armA && fav) derived = fav === armA ? 'favors-a' : fav === armB ? 'favors-b' : null
        else if (!claim.comparator) derived = sig === 'first' ? 'favors-a' : 'favors-b'
      }
    } else if (!t && NULL_WORDS.test(focalNorm)) derived = 'no-clear-difference'
    else if (!t && !claim.estimate && inConclusions) {
      const lower = /\b(?:significantly )?(?:lower|fewer|reduced|better|improved)\b/.test(focalNorm)
      const higher = /\b(?:significantly )?(?:higher|greater|more|worse|increased)\b/.test(focalNorm)
      if (lower !== higher && armA && armB) {
        const mentioned = [posA >= 0 ? 'a' : null, posB >= 0 ? 'b' : null].filter(Boolean)
        const firstArm = posA >= 0 && posB >= 0 ? (posA < posB ? 'a' : 'b') : mentioned[0]
        if (firstArm) { const fav = lower ? firstArm : firstArm === 'a' ? 'b' : 'a'; derived = fav === 'a' ? 'favors-a' : 'favors-b' }
      } else if (NULL_WORDS.test(focalNorm)) derived = 'no-clear-difference'
    }
    if (claim.direction === 'equivalent' || claim.direction === 'non-inferior') {
      if (EQUIV_WORDS.test(focalNorm)) el(elements, 'direction', 'bound'); else { el(elements, 'direction', 'contradicted'); fail(R.EQUIVALENCE_NOT_TESTED) }
    } else if (derived && derived === claim.direction) el(elements, 'direction', 'bound')
    else if (derived) { el(elements, 'direction', 'contradicted'); fail(R.DIRECTION_UNSUPPORTED) }
    else { el(elements, 'direction', 'unbound'); if (!estimateFailed) fail(R.DIRECTION_UNSUPPORTED) }
  } else el(elements, 'direction', 'not-asserted')

  // ---- language -------------------------------------------------------------------------
  if (claim.language === 'causal') {
    if (index.design.randomized && !index.design.observational && elements.comparator !== 'unbound') el(elements, 'language', 'bound')
    else { el(elements, 'language', 'contradicted'); fail(R.CAUSAL_LANGUAGE_NONRANDOMIZED) }
  } else el(elements, 'language', claim.language === 'associational' ? 'bound' : 'not-asserted')

  // ---- role -----------------------------------------------------------------------------
  const refersPrimary = /\bprimary[- ](?:outcome|end ?point)\b/.test(focalNorm)
  const refersSecondary = /\bsecondary[- ](?:outcome|end ?point)\b/.test(focalNorm)
  const epDef = endpoint?.kind === 'definition' ? endpoint.def : null
  if (!claim.role || claim.role === 'reported') el(elements, 'role', 'not-asserted')
  else if (claim.role === 'design') el(elements, 'role', 'bound')
  else if (claim.role === 'primary' || claim.role === 'co-primary') {
    if (refersPrimary || (epDef && (epDef.role === 'primary' || epDef.role === 'co-primary'))) el(elements, 'role', 'bound')
    else if (!primaryDefs.length) { el(elements, 'role', 'positional-only'); fail(R.ROLE_UNVERIFIED) }
    else { el(elements, 'role', 'unbound'); fail(R.ROLE_UNVERIFIED) }
  } else if (claim.role === 'secondary') el(elements, 'role', refersSecondary || /\bsecondary\b/.test(focalNorm) || (epDef && epDef.role === 'secondary') ? 'bound' : 'positional-only')
  else if (claim.role === 'component') el(elements, 'role', primaryDefs.some((d) => overlap(tokenSet(claim.outcome || ''), d.componentTokens).length) ? 'bound' : 'positional-only')
  else if (claim.role === 'subgroup') el(elements, 'role', /\bsubgroup|cohort|grade|stratum|among patients\b/.test(focalNorm) ? 'bound' : 'positional-only')
  else if (claim.role === 'safety') el(elements, 'role', /\badverse|complication|safety|harm|headache\b/.test(focalNorm) ? 'bound' : 'positional-only')
  else el(elements, 'role', 'positional-only')

  // ---- eligibility ----------------------------------------------------------------------
  const qualitativeBad = ['population', 'comparator', 'outcome', 'timepoint', 'language'].some((k) => elements[k] === 'unbound' || elements[k] === 'contradicted')
  const directionBad = elements.direction === 'contradicted' || (elements.direction === 'unbound' && !estimateFailed)
  if (qualitativeBad || directionBad || estimateState === 'contradicted') result.eligibility = 'fail'
  else if (claim.estimate || claim.arms?.length) {
    if (estimateState === 'unbound') { result.eligibility = 'withhold'; if (elements.direction === 'bound') elements.direction = 'unbound' }
    else result.eligibility = elements.role === 'positional-only' ? 'pass-qualitative' : 'pass'
  } else result.eligibility = 'pass-qualitative'
  if (result.eligibility === 'withhold' && !reasons.length) fail(R.ESTIMATE_UNCHECKED)
  if (result.eligibility === 'fail' && !reasons.length) fail(R.DIRECTION_UNSUPPORTED)
  result.bound = {
    armA, armB, tuple: tuple ? { measure: tuple.measure, value: tuple.value, low: tuple.low, high: tuple.high, label: tuple.label } : null,
    endpointKey: endpoint?.key || null,
    outcomeDef: endpoint ? { headTokens: [...endpoint.tokens], acronyms: [...(endpoint.acronyms || [])], disjuncts: (endpoint.disjuncts || []).map((d) => [...d]), componentTokens: [...(endpoint.components || [])] } : null,
    cohortLabels: labelsIn(claim.population || '', cohortLabels),
    timepoint: claim.timepoint ? parseTimepoint(claim.timepoint) : null,
  }
  return result
}
