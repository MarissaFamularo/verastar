// cards/assess.js — entry point of the replacement card system.
//
// assessCard({ source, profile, card, options }) → Assessment   (contract: src/acceptance/schema.js)
//
//   source ──► evidence index ──► claim results (eligibility, per claim)
//                     └──► results inventory ──► fidelity (whole card, omissions)
//   profile ──► personalization results
//   eligibility + fidelity ──► render plan (display, state, fallback with independently
//                              checked conclusion claims)
//
// Nothing in the app imports this module yet; production behavior is unchanged.

import { buildIndex } from './index.js'
import { checkClaim } from './check.js'
import { buildInventory, checkFidelity } from './inventory.js'
import { normalize, tokenSet, overlap } from './text.js'
import { REASONS as R } from '../acceptance/schema.js'

const ELIGIBLE = new Set(['pass', 'pass-qualitative', 'withhold'])
const RESULT_KINDS = new Set(['effect', 'no-clear-difference', 'rate', 'count'])

function checkPersonal(p, profile, index) {
  const reasons = []
  const items = p.items.map((id) => profile.find((x) => x.id === id)).filter(Boolean)
  if (items.length !== p.items.length || !items.length) return { id: p.id, status: 'fail', reasons: [R.NO_SUPPORTING_ITEM] }
  const facts = items.filter((i) => i.kind === 'fact')
  const topical = items.filter((i) => i.kind === 'north-star' || i.kind === 'project')
  // topical overlap: the item's words against the title, background and methods (not results)
  const scope = index.sentences.filter((s) => ['background', 'methods', 'body'].includes(s.section)).map((s) => s.text).join(' ') + ' ' + index.title
  const scopeTokens = tokenSet(scope)
  const overlaps = (item) => overlap(tokenSet(item.text), scopeTokens).length > 0
  switch (p.connection) {
    case 'topic':
      if (!topical.some(overlaps)) reasons.push(R.NO_SUPPORTING_ITEM)
      break
    case 'population':
      if (!facts.length) reasons.push(R.PRACTICE_CLAIM_WITHOUT_FACT)
      if (!topical.some(overlaps) && !facts.some(overlaps)) reasons.push(R.NO_SUPPORTING_ITEM)
      break
    case 'method':
      if (!items.some((i) => i.kind === 'project' || i.kind === 'rubric')) reasons.push(R.CONNECTION_TYPE_UNSUPPORTED)
      if (!/\bif\b|\bcandidate\b|\bpotential\b|\bmay\b/.test(normalize(p.text))) reasons.push(R.CONNECTION_TYPE_UNSUPPORTED)
      break
    case 'practice':
      if (!facts.length) reasons.push(R.PRACTICE_CLAIM_WITHOUT_FACT)
      break
    case 'project-aim':
      reasons.push(R.PROJECT_AIM_ASSERTED) // a project's aim is never in the profile, only its name
      break
    default:
      reasons.push(R.CONNECTION_TYPE_UNSUPPORTED)
  }
  return { id: p.id, status: reasons.length ? 'fail' : 'pass', reasons }
}

// An editorial item applies to this source when one of its distinctive tokens (an acronym or
// a word of 5+ letters that is not a common word) is printed in the source.
function editorialApplies(item, index) {
  const words = String(item.text).split(/\s+/).filter((w) => /^[A-Z][A-Z0-9-]{2,}$/.test(w) || (/^[A-Za-z-]{5,}$/.test(w) && !/^(trial|landmark|study|paper|which|there|their|about)$/i.test(w)))
  return words.some((w) => index.norm.includes(normalize(w)))
}

export async function assessCard({ source, profile = [], card, options = {} }) {
  const claims = card?.claims || []
  const personal = card?.personal || []
  const index = buildIndex(source)
  const results = claims.map((c) => checkClaim(c, index, options))
  const byId = new Map(results.map((r) => [r.id, r]))
  const inventory = buildInventory(index)
  const fidelity = checkFidelity({ claims, results, inventory, card, index })
  const personalResults = personal.map((p) => checkPersonal(p, profile, index))

  // ---- render plan ----------------------------------------------------------------------
  const display = {}
  for (const c of claims) {
    const r = byId.get(c.id)
    display[c.id] = !ELIGIBLE.has(r.eligibility) ? 'not-shown' : r.eligibility === 'pass' && (c.estimate || c.arms?.length) ? 'shown-with-estimate' : 'shown-qualitative'
  }
  const primaryClaims = claims.filter((c) => (c.role === 'primary' || c.role === 'co-primary') && RESULT_KINDS.has(c.kind))
  const withheldPrimary = primaryClaims.filter((c) => byId.get(c.id).eligibility === 'withhold')
  const resultsUnavailable = !index.available.results && claims.some((c) => byId.get(c.id).eligibility === 'excluded')
  let state = 'full', fallback = null, mainResultShown
  const primaryEntries = fidelity.inventory.entries.filter((e) => e.role === 'primary' || e.role === 'co-primary')
  const coveredByShown = (e) => claims.some((c) => display[c.id] !== 'not-shown' && fidelity.covers(c, inventory.entries.find((x) => x.id === e.id)))

  if (resultsUnavailable) {
    state = 'reduced-results-unavailable'
    fallback = { kind: 'results-unavailable', conclusionClaims: [] }
    mainResultShown = false
  } else if (fidelity.status === 'fail') {
    state = 'reduced-fidelity-failed'
    // only eligible, direction-bound primary claims may carry a conclusion; the main result
    // shows only if every primary entry is covered by a shown claim
    const conclusionClaims = primaryClaims.filter((c) => ['pass', 'pass-qualitative'].includes(byId.get(c.id).eligibility) && byId.get(c.id).elements.direction === 'bound').map((c) => c.id)
    fallback = { kind: 'fidelity-rebuild', conclusionClaims }
    mainResultShown = false
  } else if (withheldPrimary.length) {
    state = 'reduced-estimate-withheld'
    // an independently checked conclusion: a different eligible claim, direction bound on its
    // own sentence, about the same outcome and population
    const conclusionClaims = []
    const conclusionFor = {}
    for (const w of withheldPrimary) {
      const wTok = tokenSet(w.outcome || '')
      const wCohorts = byId.get(w.id).bound.cohortLabels || []
      const samePopulation = (c) => {
        const cCohorts = byId.get(c.id).bound.cohortLabels || []
        if (wCohorts.length && cCohorts.length) return cCohorts.some((l) => wCohorts.includes(l))
        if (wCohorts.length !== cCohorts.length) return false
        return !w.population || !c.population || overlap(tokenSet(c.population), tokenSet(w.population)).length >= 1
      }
      const match = claims.find((c) => c.id !== w.id && ['pass', 'pass-qualitative'].includes(byId.get(c.id).eligibility) && byId.get(c.id).elements.direction === 'bound' && overlap(tokenSet(c.outcome || ''), wTok).length >= 1 && samePopulation(c))
      if (match) { conclusionClaims.push(match.id); conclusionFor[w.id] = match.id }
    }
    fallback = { kind: 'estimate-withheld', conclusionClaims, conclusionFor }
    mainResultShown = conclusionClaims.length > 0 && primaryEntries.every((e) => coveredByShown(e))
  } else {
    mainResultShown = primaryEntries.length ? primaryEntries.every((e) => coveredByShown(e)) : claims.some((c) => RESULT_KINDS.has(c.kind) && display[c.id] !== 'not-shown')
  }
  const claimsShown = claims.filter((c) => display[c.id] !== 'not-shown').map((c) => c.id)
  const estimatesShown = claims.filter((c) => display[c.id] === 'shown-with-estimate').map((c) => c.id)
  const personalShown = personalResults.filter((p) => p.status === 'pass').map((p) => p.id)

  // ---- recommendation -------------------------------------------------------------------
  const editorial = profile.filter((i) => i.kind === 'editorial' && editorialApplies(i, index))
  const recommendation = editorial.length ? { read: 'full', basis: editorial.map((i) => i.id) } : { read: card?.recommendation?.read || 'abstract-enough', basis: [] }

  const { covers, ...fidelityOut } = fidelity
  return {
    claims: results.map(({ bound, ...r }) => ({ ...r, bound })),
    fidelity: fidelityOut,
    personal: personalResults,
    render: { state, display, claimsShown, estimatesShown, personalShown, mainResultShown, fallback },
    recommendation,
    context: { design: index.design, arms: index.labels.arms, cohorts: index.labels.cohorts, available: index.available },
  }
}
