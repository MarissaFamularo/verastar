// cards/prose.js — the final-prose check. Each rendered sentence is held to the claims it
// cites: numbers must be tokens those claims earned (and never a withheld estimate, badge or
// not), direction words must agree with a cited bound direction, comparatives and role words
// need a claim behind them, and a finding sentence must keep its claim's population, arm
// order, outcome and timepoint — a sentence that cites a valid claim and prints its real
// numbers still fails when it swaps the arms, substitutes a component for the composite,
// drops the cohort restriction or changes the timepoint.

import { normalize, extractNumbersWithIndex, numbersEqual, tokens, tokenSet, overlap } from './text.js'
import { REASONS as R } from '../acceptance/schema.js'

const COMPARATIVE = /\b(largest|biggest|smallest|first(?:-ever)?|superior|inferior|outperform(?:ed|s)?|best|strongest|unprecedented|landmark|definitive|practice-changing)\b/
const BENEFIT = /\b(fewer|lower|reduced|reduce[sd]?|improved?|less|decreased?|better|favou?red|protective|benefit(?:ed)?)\b/
const HARM = /\b(higher|more|increased?|worse|greater|excess)\b/
const NULLW = /\bdid not differ\b|\bno (?:statistically )?significant difference\b|\bno (?:clear|meaningful) difference\b|\bsimilar\b|\bno difference\b|\bnot differ\b|\bwere comparable\b/
const TIME = /(?<![\d.])(\d+(?:\.\d+)?)(?:\s|-)(?:years?|months?|weeks?|days?)\b/g
const CI_LABEL = /(\d+)%\s*(?:ci|confidence interval)\b|\bci\b|\bconfidence interval\b/
const GENERIC_ARM = new Set(['initial', 'strategy', 'group', 'arm', 'therapy', 'treatment', 'first', 'best'])

function claimNumbers(claim) {
  const out = []
  const e = claim.estimate
  if (e) { out.push(e.value); if (e.interval) out.push(e.interval.low, e.interval.high); if (e.p != null) out.push(e.p); if (e.sample) out.push(...Object.values(e.sample).filter((v) => v != null)) }
  for (const a of claim.arms || []) for (const k of ['percent', 'count', 'denominator']) if (a[k] != null) out.push(a[k])
  return out
}
const numbersIn = (s) => extractNumbersWithIndex(normalize(s)).map((t) => t.value)
const armTokens = (s) => tokens(s).filter((t) => !GENERIC_ARM.has(t))
function firstPos(norm, toks) {
  const ps = toks.map((t) => norm.search(new RegExp(`\\b${t}`))).filter((p) => p >= 0)
  return ps.length ? Math.min(...ps) : -1
}

export function checkProse({ rendered, assessment, claims }) {
  const byId = new Map(claims.map((c) => [c.id, c]))
  const resById = new Map(assessment.claims.map((r) => [r.id, r]))
  const out = []
  let prevOutcome = new Set() // outcome tokens of the previous finding sentence, for a null result stated right after it
  for (const [index, s] of rendered.sentences.entries()) {
    const reasons = []
    const add = (c) => { if (!reasons.includes(c)) reasons.push(c) }
    const kind = s.kind || 'finding'
    const norm = normalize(s.text)
    const cited = (s.claims || []).map((id) => ({ id, claim: byId.get(id), res: resById.get(id) }))

    for (const c of cited) if (!c.claim || !c.res || assessment.render.display[c.id] === 'not-shown' || !assessment.render.display[c.id]) add(R.CLAIM_NOT_SHOWN_CITED)
    const live = cited.filter((c) => c.claim && c.res && assessment.render.display[c.id] && assessment.render.display[c.id] !== 'not-shown')

    if (kind === 'for-you') {
      const ids = s.personal || []
      if (!ids.length || ids.some((id) => !assessment.render.personalShown.includes(id))) add(R.PERSONAL_UNTAGGED)
    } else if (kind !== 'read' && !cited.length) add(R.UNTAGGED_ASSERTION)

    // numbers
    const allowed = [], withheld = []
    let anyCi = false, allBracket = live.some((c) => c.claim.estimate?.interval)
    for (const c of live) {
      const disp = assessment.render.display[c.id]
      if (disp === 'shown-with-estimate') allowed.push(...claimNumbers(c.claim))
      else if (c.res.eligibility === 'withhold') withheld.push(...claimNumbers(c.claim))
      if (c.claim.timepoint && c.res.elements.timepoint === 'bound') allowed.push(...numbersIn(c.claim.timepoint))
      if (c.claim.population) allowed.push(...numbersIn(c.claim.population))
      const lab = c.claim.estimate?.interval?.label
      if (lab && lab !== 'printed-bracket') { anyCi = true; allBracket = false; allowed.push(parseInt(lab, 10)) }
    }
    const ciHere = CI_LABEL.test(norm)
    if (ciHere && allBracket && !anyCi && live.some((c) => c.claim.estimate?.interval)) add(R.PROSE_INTERVAL_LABEL_INVENTED)
    for (const n of numbersIn(s.text)) {
      if (withheld.some((w) => numbersEqual(w, n)) && !allowed.some((a) => numbersEqual(a, n))) add(R.NUMBER_FROM_WITHHELD_ESTIMATE)
      else if (!allowed.some((a) => numbersEqual(a, n))) add(R.UNBACKED_NUMBER)
    }

    if (kind !== 'read' && COMPARATIVE.test(norm)) add(R.UNBACKED_COMPARATIVE)
    if (kind !== 'read' && /\b(primary|secondary)\b/.test(norm) && !live.some((c) => c.res.elements.role === 'bound')) add(R.ROLE_WORD_UNBACKED)

    if (kind === 'finding') {
      const dirs = live.filter((c) => c.res.elements.direction === 'bound').map((c) => c.claim.direction)
      const favors = dirs.some((d) => d === 'favors-a' || d === 'favors-b')
      const nul = dirs.includes('no-clear-difference')
      if ((BENEFIT.test(norm) || HARM.test(norm)) && !favors) add(R.DIRECTION_WORD_CONTRADICTS_CLAIM)
      if (NULLW.test(norm) && !nul) add(R.DIRECTION_WORD_CONTRADICTS_CLAIM)

      // structural check against the cited result claim(s): population, arm order and arm
      // values, outcome head vs component, timepoint
      for (const c of live) {
        const cl = c.claim
        if (!['effect', 'no-clear-difference', 'rate'].includes(cl.kind) || c.res.eligibility === 'withhold') continue
        if (cl.population) {
          const label = /\b(cohort \d+|[a-z-]+ trial|grade \d+|[a-z-]+ cohort)\b/.exec(normalize(cl.population))
          const popTokens = tokenSet(cl.population)
          const ok = label ? norm.includes(label[1]) : overlap(popTokens, tokenSet(s.text)).length >= 1
          if (!ok) add(R.PROSE_POPULATION_DROPPED)
        }
        if (cl.comparator && (cl.direction === 'favors-a' || cl.direction === 'favors-b')) {
          // distinctive arm words only (a shared word like "runoff" or "group" places neither arm)
          const ta = armTokens(cl.comparator.a), tb = armTokens(cl.comparator.b)
          const pa = firstPos(norm, ta.filter((t) => !tb.includes(t))), pb = firstPos(norm, tb.filter((t) => !ta.includes(t)))
          if (pa < 0 || pb < 0) add(R.PROSE_ARM_SWAPPED)
          else {
            // benefit framing ("A led to fewer … than B") names the favored arm first; harm
            // framing ("A had higher risk than B") names the disfavored arm first
            const harmFramed = HARM.test(norm) && !BENEFIT.test(norm)
            const favoredFirst = cl.direction === 'favors-a' ? pa < pb : pb < pa
            if (harmFramed ? favoredFirst : !favoredFirst) add(R.PROSE_ARM_SWAPPED)
            const pcts = [...norm.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => ({ v: parseFloat(m[1]), pos: m.index }))
            const ra = cl.arms?.find((x) => x.arm === 'a')?.percent, rb = cl.arms?.find((x) => x.arm === 'b')?.percent
            if (pcts.length >= 2 && ra != null && rb != null) {
              const firstArmIsA = pa < pb
              if (!numbersEqual(pcts[0].v, firstArmIsA ? ra : rb) || !numbersEqual(pcts[1].v, firstArmIsA ? rb : ra)) add(R.PROSE_ARM_SWAPPED)
            }
          }
        }
        if (cl.outcome) {
          const st = tokenSet(s.text)
          const head = new Set([...(c.res.bound?.outcomeDef?.headTokens || []), ...tokens(cl.outcome)])
          const comp = new Set((c.res.bound?.outcomeDef?.componentTokens || []).filter((t) => !head.has(t)))
          const headHit = overlap(head, st).length > 0
          const compHit = overlap(comp, st).length > 0
          const carried = cl.direction === 'no-clear-difference' && overlap(head, prevOutcome).length > 0
          if (compHit && !headHit) add(R.PROSE_OUTCOME_SUBSTITUTED)
          else if (!headHit && !carried) add(R.PROSE_OUTCOME_SUBSTITUTED)
          if (headHit) prevOutcome = head
        }
        if (cl.timepoint && c.res.elements.timepoint === 'bound') {
          const want = numbersIn(cl.timepoint)
          const here = [...norm.matchAll(TIME)].map((m) => parseFloat(m[1]))
          if (here.length && !here.every((h) => want.some((w) => numbersEqual(w, h)))) add(R.PROSE_TIMEPOINT_CHANGED)
        }
      }
    }
    out.push({ index, status: reasons.length ? 'reject' : 'ok', reasons })
  }
  return { status: out.every((x) => x.status === 'ok') ? 'pass' : 'fail', sentences: out }
}
