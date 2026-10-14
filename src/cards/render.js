// cards/render.js — constrained rendering. Sentences are built by templates from CHECKED
// claim fields only; no free prose is generated here. Every sentence carries the claim ids
// (and personal item ids) it was built from, so checkProse can hold it to exactly what those
// claims earned. Model text (claim.text, personal.text) is used only for personal lines,
// which the personalization checker has already judged by connection type, and never for a
// factual sentence.

import { fmtNum, cap, tokenSet, overlap } from './text.js'

const tokenOverlap = (a, b) => overlap(tokenSet(a || ''), tokenSet(b || '')).length > 0

const NOUN = { HR: 'HR', aHR: 'adjusted HR', OR: 'OR', aOR: 'adjusted OR', RR: 'RR', IRR: 'rate ratio', MD: 'mean difference', RD: 'risk difference' }

function estimateText(e) {
  if (!e) return ''
  const parts = [`${NOUN[e.measure] || e.measure} ${e.value}${e.unit ? ' ' + e.unit : ''}`]
  if (e.interval) parts.push(e.interval.label === 'printed-bracket' ? `[${e.interval.low}–${e.interval.high}]` : `${e.interval.label || 'CI'} ${e.interval.low}–${e.interval.high}`)
  if (e.p != null) parts.push(`P=${e.p}`)
  return parts.join(', ')
}
function armRates(claim) {
  const a = claim.arms?.find((x) => x.arm === 'a'), b = claim.arms?.find((x) => x.arm === 'b')
  return a?.percent != null && b?.percent != null ? `${a.percent}% vs ${b.percent}%` : ''
}
const strip = (s) => String(s || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()

function effectSentence(claim, withEstimate) {
  const a = strip(claim.comparator?.a), b = strip(claim.comparator?.b)
  const where = claim.population ? `In ${claim.population}, ` : ''
  const when = claim.timepoint ? ` over ${claim.timepoint}` : ''
  const verb = claim.language === 'causal' ? 'led to' : 'was associated with'
  const numbers = withEstimate ? [armRates(claim), estimateText(claim.estimate)].filter(Boolean).join('; ') : ''
  const tail = numbers ? ` (${numbers})` : ''
  if (claim.direction === 'no-clear-difference') return `${where}${a && b ? `${a} and ${b}` : 'the two groups'} did not differ clearly in ${claim.outcome}${when}${tail}.`
  const [fav, other] = claim.direction === 'favors-b' ? [b, a] : [a, b]
  // a "good" outcome (survival, healing, patency, walking distance) is better, not lower
  const good = /\bsurvival\b|\bhealing\b|\bpatency\b|\bdistance\b|\bquality of life\b|\bsuccess\b/.test(String(claim.outcome).toLowerCase())
  return `${cap(`${where}${fav} ${verb} ${good ? 'better' : 'a lower rate of'} ${claim.outcome} than ${other}${when}${tail}.`)}`
}

export function renderCard({ assessment, claims, personal = [] }) {
  const shown = (id) => assessment.render.display[id] && assessment.render.display[id] !== 'not-shown'
  const withEst = (id) => assessment.render.display[id] === 'shown-with-estimate'
  const sentences = []

  // header: design + enrollment
  const design = claims.find((c) => c.kind === 'design' && shown(c.id))
  const enroll = claims.find((c) => c.kind === 'count' && withEst(c.id))
  if (design) {
    const bits = [assessment.context?.design?.randomized ? 'Randomized trial' : assessment.context?.design?.review ? 'Review' : 'Study']
    if (enroll) bits.push(`${fmtNum(enroll.estimate.value)} ${enroll.estimate.unit || 'patients'}`)
    bits.push(design.population || '')
    sentences.push({ text: `${bits.filter(Boolean).join(', ')}.`, claims: [design.id, ...(enroll ? [enroll.id] : [])], kind: 'header' })
  }

  // findings, in card order; a withheld estimate is rendered from the conclusion claim the
  // render plan paired with it. An authors'-conclusion claim that restates a result already
  // shown with its estimate is not rendered twice.
  const conclusionIds = new Set(assessment.render.fallback?.conclusionClaims || [])
  const conclusionFor = assessment.render.fallback?.conclusionFor || {}
  const resultIds = claims.filter((c) => ['effect', 'no-clear-difference', 'rate'].includes(c.kind) && withEst(c.id)).map((c) => c.id)
  const restates = (c) => c.attribution === 'authors' && !c.estimate && claims.some((k) => resultIds.includes(k.id) && k.id !== c.id && k.direction === c.direction && tokenOverlap(k.outcome, c.outcome) && tokenOverlap(k.population, c.population))
  for (const c of claims) {
    if (!shown(c.id) || !['effect', 'no-clear-difference', 'rate'].includes(c.kind)) continue
    if (conclusionIds.has(c.id) || restates(c)) continue
    const r = assessment.claims.find((x) => x.id === c.id)
    if (r.eligibility === 'withhold') {
      const conclusion = claims.find((k) => k.id === conclusionFor[c.id])
      if (conclusion) sentences.push({ text: `${effectSentence(conclusion, false).replace(/\.$/, '')}; the size of the difference could not be confirmed by the app, so no estimate is shown.`, claims: [conclusion.id, c.id], kind: 'finding' })
      else sentences.push({ text: `${c.population ? `In ${c.population}, ` : ''}the main result for ${c.outcome} could not be confirmed by the app; read the paper's results before repeating a takeaway.`, claims: [c.id], kind: 'finding' })
      continue
    }
    sentences.push({ text: effectSentence(c, withEst(c.id)), claims: [c.id], kind: 'finding' })
  }

  // results unavailable: say so, anchored to the outcome definition when one is shown
  if (assessment.render.state === 'reduced-results-unavailable') {
    const def = claims.find((c) => c.kind === 'outcome-definition' && shown(c.id))
    sentences.push({ text: `Main result not available to the app: the text available did not include the results${def ? ` for ${def.outcome}` : ''}; read the paper's results before repeating a takeaway.`, claims: def ? [def.id] : [], kind: def ? 'finding' : 'read' })
  }

  // for you
  for (const p of personal) if (assessment.render.personalShown.includes(p.id)) sentences.push({ text: `For you: ${p.text}.`.replace(/\.\.$/, '.'), claims: design ? [design.id] : [], personal: [p.id], kind: 'for-you' })

  // temper: outcome definition, absences, limitations
  for (const c of claims) {
    if (!shown(c.id)) continue
    if (c.kind === 'outcome-definition') sentences.push({ text: `${cap(c.role || 'reported')} outcome as defined: ${c.outcome}.`, claims: [c.id], kind: 'temper' })
    if (c.kind === 'absence') sentences.push({ text: `Not reported in the available text: ${c.outcome || c.text}.`, claims: [c.id], kind: 'temper' })
    if (c.kind === 'limitation') sentences.push({ text: `Limitation: ${c.text || c.outcome}.`, claims: [c.id], kind: 'temper' })
  }

  // read
  const rec = assessment.recommendation
  const readText = rec.read === 'full' ? (rec.basis?.length ? 'Read in full: marked as a landmark trial in your profile.' : 'Read in full.') : rec.read === 'lower-priority' ? 'Lower priority; the abstract carries the usable content.' : 'Abstract is enough.'
  sentences.push({ text: readText, claims: [], kind: 'read' })
  return { sentences }
}
