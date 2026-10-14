// cards/prose.js — the final-prose check. Each rendered sentence is held to the claims it
// cites: numbers must be tokens those claims earned (and never a withheld estimate, badge or
// not), direction words must agree with a cited bound direction, comparatives and role words
// need a claim behind them, and a finding sentence must keep its claim's population, arm
// order, outcome and timepoint — a sentence that cites a valid claim and prints its real
// numbers still fails when it swaps the arms, substitutes a component for the composite,
// drops the cohort restriction or changes the timepoint.

import { normalize, extractNumbersWithIndex, numbersEqual, tokens, tokenSet, overlap } from './text.js'
import { REASONS as R } from '../acceptance/schema.js'
import { parseTimepoint } from './check.js'

const COMPARATIVE = /\b(largest|biggest|smallest|first(?:-ever)? (?:trial|study|randomi[sz]ed|to show|to demonstrate|evidence)|superior|inferior|outperform(?:ed|s)?|best|strongest|unprecedented|landmark|definitive|practice-changing)\b/
const BENEFIT = /\b(fewer|lower|reduced|reduce[sd]?|improved?|less|decreased?|better|favou?red|protective|benefit(?:ed)?)\b/
const HARM = /\b(higher|more|increased?|worse|greater|excess)\b/
const NULLW = /\bdid not differ\b|\bno (?:statistically )?significant difference\b|\bno (?:clear|meaningful) difference\b|\bsimilar\b|\bno difference\b|\bnot differ\b|\bwere comparable\b/
const TIME_UNIT = /(?<![\d.])(\d+(?:\.\d+)?)(?:\s|-)(years?|months?|weeks?|days?)\b/g
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
      if (c.claim.outcome && c.res.elements.outcome === 'bound') allowed.push(...numbersIn(c.claim.outcome))
      if (c.claim.population) allowed.push(...numbersIn(c.claim.population))
      const lab = c.claim.estimate?.interval?.label
      if (lab && lab !== 'printed-bracket') { anyCi = true; allBracket = false; allowed.push(parseInt(lab, 10)) }
    }
    const ciHere = CI_LABEL.test(norm)
    if (ciHere && allBracket && !anyCi && live.some((c) => c.claim.estimate?.interval)) add(R.PROSE_INTERVAL_LABEL_INVENTED)
    const levels = live.map((c) => c.claim.estimate?.interval?.label).filter((l) => l && l !== 'printed-bracket').map((l) => parseFloat(l))
    for (const m of norm.matchAll(/(\d+(?:\.\d+)?)%\s*(?:ci|confidence interval)\b/g)) if (!levels.some((l) => numbersEqual(l, parseFloat(m[1])))) add(R.PROSE_INTERVAL_LEVEL_CHANGED)
    for (const n of numbersIn(s.text)) {
      if (withheld.some((w) => numbersEqual(w, n)) && !allowed.some((a) => numbersEqual(a, n))) add(R.NUMBER_FROM_WITHHELD_ESTIMATE)
      else if (!allowed.some((a) => numbersEqual(a, n))) add(R.UNBACKED_NUMBER)
    }

    // a comparative inside a printed arm label ("best endovascular treatment") is a name, not a claim
    let masked = norm
    for (const c of live) for (const arm of [c.claim.comparator?.a, c.claim.comparator?.b]) if (arm) masked = masked.split(normalize(arm).replace(/\s*\([^)]*\)\s*/g, ' ').trim()).join(' ')
    if (kind !== 'read' && COMPARATIVE.test(masked)) add(R.UNBACKED_COMPARATIVE)
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
          // a leading population phrase ("In peroneal runoff patients, …") may share a word
          // with an arm; arm order is read from the clause after it
          let body = norm
          if (cl.population) { const pn = normalize(cl.population); if (body.startsWith(`in ${pn}`)) body = body.slice(3 + pn.length) }
          const pa = firstPos(body, ta.filter((t) => !tb.includes(t))), pb = firstPos(body, tb.filter((t) => !ta.includes(t)))
          if (pa < 0 || pb < 0) add(R.PROSE_ARM_SWAPPED)
          else {
            // benefit framing ("A led to fewer … than B") names the favored arm first; harm
            // framing ("A had higher risk than B") names the disfavored arm first
            const harmFramed = HARM.test(norm) && !BENEFIT.test(norm)
            const favoredFirst = cl.direction === 'favors-a' ? pa < pb : pb < pa
            if (harmFramed ? favoredFirst : !favoredFirst) add(R.PROSE_ARM_SWAPPED)
            const pcts = [...body.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => ({ v: parseFloat(m[1]), pos: m.index }))
            const ra = cl.arms?.find((x) => x.arm === 'a')?.percent, rb = cl.arms?.find((x) => x.arm === 'b')?.percent
            if (pcts.length >= 2 && ra != null && rb != null) {
              const firstArmIsA = pa < pb
              if (!numbersEqual(pcts[0].v, firstArmIsA ? ra : rb) || !numbersEqual(pcts[1].v, firstArmIsA ? rb : ra)) add(R.PROSE_ARM_SWAPPED)
            }
          }
        }
        if (cl.outcome) {
          // the sentence must name the complete endpoint the claim was bound to: the core (half
          // its words or more), its acronym, or every disjunct of a composite. Naming one
          // component or one disjunct is a substitution.
          const st = tokenSet(s.text)
          const od = c.res.bound?.outcomeDef || { headTokens: tokens(cl.outcome), acronyms: [], disjuncts: [], componentTokens: [] }
          const acr = new Set(od.acronyms || [])
          const core = new Set((od.headTokens || []).filter((t) => !acr.has(t)))
          const coreSize = [...core].filter((t) => t.length > 2).length
          const coreHit = overlap(core, st).length
          const disj = (od.disjuncts || []).map((d) => new Set(d))
          const disjAcr = od.disjunctAcronyms || []
          const isComposite = disj.length >= 2 || (od.componentTokens || []).length > 0 || core.has('composite')
          const sayComposite = isComposite && (st.has('composite') || [...acr].some((a) => st.has(a)))
          // a disjunct is named by its own acronym or by at least half of its words
          const covered = disj.filter((d, i) => (disjAcr[i] && st.has(disjAcr[i])) || overlap(d, st).filter((t) => t !== disjAcr[i]).length >= Math.max(1, Math.ceil([...d].filter((t) => t.length > 2 && t !== disjAcr[i]).length / 2))).length
          const compHit = overlap(new Set(od.componentTokens || []), st).length > 0
          const named = sayComposite || (coreSize <= 3 ? coreHit >= Math.max(1, Math.ceil(coreSize / 2)) : coreHit >= Math.ceil(coreSize / 2) && coreHit >= 2) || (disj.length >= 2 && covered === disj.length)
          const carried = cl.direction === 'no-clear-difference' && overlap(core, prevOutcome).length > 0
          if (!named && (compHit || covered > 0)) add(R.PROSE_OUTCOME_SUBSTITUTED)
          else if (!named && !carried) add(R.PROSE_OUTCOME_SUBSTITUTED)
          if (named) prevOutcome = core
        }
        if (cl.timepoint && c.res.elements.timepoint === 'bound') {
          // number, unit and sense must all match the claim's checked timepoint
          const want = c.res.bound?.timepoint || parseTimepoint(cl.timepoint)
          for (const m of norm.matchAll(TIME_UNIT)) {
            const h = { value: parseFloat(m[1]), unit: m[2].replace(/s$/, '') }
            const before = norm.slice(0, m.index)
            // "over" states follow-up of any sense; "at/by/within" name a fixed horizon; "for" a duration
            const sense = /\b(?:median|mean)\b[^.]{0,20}$/.test(before) ? 'median-follow-up' : /\b(?:minimum|at least)\b[^.]{0,12}$/.test(before) ? 'minimum-follow-up' : /\b(?:at|by|within)\s+(?:a\s+)?$/.test(before) ? 'fixed' : /\b(?:for|lasting)\s+(?:a\s+)?$/.test(before) ? 'duration' : null
            const ok = want.items.some((w) => numbersEqual(w.value, h.value) && (!w.unit || w.unit === h.unit)) && (!want.sense || !sense || sense === want.sense || (sense === 'duration' && want.sense === 'median-follow-up' && /\bmedian\b/.test(before.slice(-30))))
            if (!ok) add(R.PROSE_TIMEPOINT_CHANGED)
          }
        }
      }
    }
    out.push({ index, status: reasons.length ? 'reject' : 'ok', reasons })
  }
  return { status: out.every((x) => x.status === 'ok') ? 'pass' : 'fail', sentences: out }
}
