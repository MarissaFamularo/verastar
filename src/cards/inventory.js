// cards/inventory.js — the results inventory and the whole-card fidelity check.
//
// The inventory is what the SOURCE reports, derived from the evidence index alone: one entry
// per results sentence that carries a comparison, with the role the source gives it and how
// that role was established (labeled in the sentence, linked to a definition, or merely
// positional — in which case the entry is uncertain, its role is 'other', and nothing may
// call it primary). Fidelity compares the card's eligible claims with the inventory: every
// primary covered, primaries before secondaries, a null primary never obscured, every
// uncovered entry listed as an omission with its severity.

import { normalize, tokenSet, overlap, acronyms } from './text.js'
import { REASONS as R } from '../acceptance/schema.js'

const RATIO = new Set(['HR', 'aHR', 'OR', 'aOR', 'RR', 'IRR'])
const SAFETY = /\badverse events?\b|\bserious adverse\b|\bcomplications?\b|\bsafety\b|\bheadache\b/
const NULLISH = /\bsimilar\b|\bno (?:statistically )?significant difference\b|\bdid not differ\b|\bno difference\b/
const RESULT_CLAIM_KINDS = new Set(['effect', 'no-clear-difference', 'rate'])

function tupleDirection(t) {
  if (!t) return 'unknown'
  const nul = RATIO.has(t.measure) ? 1 : 0
  if (t.low != null && t.high != null) return t.high < nul ? 'favors-first' : t.low > nul ? 'favors-second' : 'no-clear-difference'
  if (t.p) return t.p.value < 0.05 ? (t.value < nul ? 'favors-first' : 'favors-second') : 'no-clear-difference'
  return 'unknown'
}

export function buildInventory(index) {
  const entries = []
  const primaryDefs = index.definitions.filter((d) => d.role === 'primary' || d.role === 'co-primary')
  const multiCohort = index.labels.cohorts.length >= 2
  let n = 0
  for (const s of index.sentences) {
    if (s.section !== 'results' && s.section !== 'body') continue
    const hasComparison = s.tuples.length > 0 || s.nums.filter((x) => x.role === 'percent').length >= 2
    const safety = SAFETY.test(s.text)
    if (!hasComparison && !safety) continue
    const text = s.text
    const population = s.cohortsMentioned[0] || null
    const refersPrimary = /\bprimary[- ](?:outcome|end ?point)\b/.test(text)
    const refersSecondary = /\bsecondary[- ](?:outcome|end ?point)\b|\bsecondary\b/.test(text)
    const sTokens = tokenSet(text)
    let role = 'other', roleBasis = 'positional', linkage = 'positional', outcomeTokens = sTokens, outcomeText = text.slice(0, 80)
    if (refersPrimary && primaryDefs[0]) {
      role = multiCohort && population ? 'co-primary' : 'primary'; roleBasis = 'labeled'; linkage = 'definition-linked'
      outcomeTokens = primaryDefs[0].headTokens; outcomeText = primaryDefs[0].text
    } else if (refersPrimary) {
      role = 'primary'; roleBasis = 'labeled'; linkage = 'same-sentence'
    } else if (refersSecondary) {
      role = 'secondary'; roleBasis = 'labeled'; linkage = 'same-sentence'
    } else if (safety && !s.tuples.length) {
      role = 'safety'; roleBasis = 'labeled'; linkage = 'same-sentence'; outcomeText = 'adverse events'
      outcomeTokens = new Set(['adverse', 'safety', 'complication'])
    } else {
      const def = index.definitions.find((d) => overlap(d.headTokens, sTokens).length >= 1)
      if (def) { role = def.role === 'secondary' ? 'secondary' : multiCohort && population ? 'co-primary' : 'primary'; roleBasis = 'definition-linked'; linkage = 'definition-linked'; outcomeTokens = def.headTokens; outcomeText = def.text }
      else {
        const prev = index.sentences[s.i - 1]
        if (prev && prev.section === s.section && !prev.tuples.length && /\bprimary[- ](?:outcome|end ?point)\b/.test(prev.text) && primaryDefs[0]) {
          role = multiCohort && population ? 'co-primary' : 'primary'; roleBasis = 'labeled'; linkage = 'adjacent-sentence'; outcomeTokens = primaryDefs[0].headTokens; outcomeText = primaryDefs[0].text
        }
      }
    }
    const t = s.tuples[0] || null
    const direction = t ? tupleDirection(t) : NULLISH.test(text) ? 'no-clear-difference' : 'unknown'
    entries.push({
      id: `inv-${n++}`, sentence: s.i, role, roleBasis, linkage, uncertain: roleBasis === 'positional' || linkage === 'positional',
      population, outcome: outcomeText, outcomeTokens: new Set(outcomeTokens), direction, text,
      favorable: direction === 'favors-first' || direction === 'favors-second',
    })
  }
  const primaryBasis = entries.some((e) => (e.role === 'primary' || e.role === 'co-primary') && e.roleBasis === 'labeled') ? 'labeled'
    : entries.some((e) => (e.role === 'primary' || e.role === 'co-primary') && e.roleBasis === 'definition-linked') ? 'definition-linked' : 'none'
  return { entries, primaryBasis, uncertain: primaryBasis === 'none' || entries.some((e) => e.uncertain) }
}

function claimCovers(claim, result, entry, index) {
  if (!RESULT_CLAIM_KINDS.has(claim.kind)) return false
  if (!['pass', 'pass-qualitative', 'withhold'].includes(result.eligibility)) return false
  // population: the entry's cohort must be the claim's cohort (both unlabelled also matches)
  const claimCohorts = index.labels.cohorts.filter((c) => normalize(claim.population || '').includes(c))
  if (entry.population && !claimCohorts.includes(entry.population)) return false
  if (!entry.population && claimCohorts.length && index.labels.cohorts.length >= 2) return false
  const want = tokenSet(claim.outcome || '')
  for (const a of acronyms(claim.outcome || '')) want.add(a)
  if (overlap(want, entry.outcomeTokens).length >= 1) return true
  // a primary-role claim covers a primary entry of the same cohort
  return (claim.role === 'primary' || claim.role === 'co-primary') && (entry.role === 'primary' || entry.role === 'co-primary')
}

export function checkFidelity({ claims, results, inventory, card, index }) {
  const reasons = []
  const add = (c) => { if (!reasons.includes(c)) reasons.push(c) }
  const byId = new Map(results.map((r) => [r.id, r]))
  const eligible = claims.filter((c) => ['pass', 'pass-qualitative', 'withhold'].includes(byId.get(c.id)?.eligibility))

  // coverage and omissions
  const omitted = []
  for (const e of inventory.entries) {
    const covered = eligible.some((c) => claimCovers(c, byId.get(c.id), e, index))
    if (covered) continue
    const declared = (card.omissions || []).some((o) => overlap(tokenSet(o.describes), tokenSet(e.text)).length >= 2)
    const blocking = e.role === 'primary' || e.role === 'co-primary'
    omitted.push({ entry: e.outcome || e.text, role: e.role, roleBasis: e.roleBasis, severity: blocking ? 'blocking' : 'noted', declared })
    if (blocking) add(R.PRIMARY_MISSING)
  }

  // order among result claims, in card order
  const resultClaims = eligible.filter((c) => RESULT_CLAIM_KINDS.has(c.kind))
  const isPrimary = (c) => c.role === 'primary' || c.role === 'co-primary'
  const isSub = (c) => ['secondary', 'component', 'subgroup', 'safety'].includes(c.role)
  const firstPrimary = resultClaims.findIndex(isPrimary)
  const firstSub = resultClaims.findIndex(isSub)
  const primariesOnCard = resultClaims.some(isPrimary)
  const primaryEntries = inventory.entries.filter((e) => e.role === 'primary' || e.role === 'co-primary')
  if (primariesOnCard && firstSub >= 0 && firstSub < firstPrimary) add(R.PRIMARY_AFTER_SECONDARY)
  if (resultClaims.length && isSub(resultClaims[0]) && (!primariesOnCard || primaryEntries.some((e) => e.direction === 'no-clear-difference'))) add(R.COMPONENT_AS_HEADLINE)
  // a null primary preceded by a favorable sub-result, or omitted while favorable results show
  const nullPrimaryEntries = primaryEntries.filter((e) => e.direction === 'no-clear-difference')
  for (const e of nullPrimaryEntries) {
    const covering = resultClaims.findIndex((c) => claimCovers(c, byId.get(c.id), e, index))
    const favorableSubBefore = resultClaims.findIndex((c) => isSub(c) && (c.direction === 'favors-a' || c.direction === 'favors-b'))
    if (covering < 0 && resultClaims.some((c) => c.direction === 'favors-a' || c.direction === 'favors-b')) add(R.NULL_PRIMARY_OBSCURED)
    else if (covering >= 0 && favorableSubBefore >= 0 && favorableSubBefore < covering) add(R.NULL_PRIMARY_OBSCURED)
  }
  // an author sentence placed before a null primary's claim (supported but misleading emphasis)
  const authorIdx = eligible.findIndex((c) => c.kind === 'author-statement' && /significan/.test(normalize(c.text || '')))
  if (authorIdx >= 0 && nullPrimaryEntries.length) {
    const coveringIdx = eligible.findIndex((c) => nullPrimaryEntries.some((e) => claimCovers(c, byId.get(c.id), e, index)))
    if (coveringIdx < 0 || authorIdx < coveringIdx + 2) add(R.NULL_PRIMARY_OBSCURED)
  }
  // no declared primary: ordering still applies to the set of reported results
  if (inventory.primaryBasis === 'none') {
    add(R.NO_DECLARED_PRIMARY)
    const favorableShown = resultClaims.some((c) => c.direction === 'favors-a' || c.direction === 'favors-b')
    const nullOmitted = inventory.entries.some((e) => e.direction === 'no-clear-difference' && !eligible.some((c) => claimCovers(c, byId.get(c.id), e, index)))
    if (favorableShown && nullOmitted) { add(R.NULL_PRIMARY_OBSCURED); add(R.SECONDARY_WITHOUT_CONTEXT) }
  }
  // a secondary estimate without a primary on the card
  if (!primariesOnCard && inventory.primaryBasis !== 'none' && resultClaims.some((c) => isSub(c) && c.estimate)) add(R.SECONDARY_WITHOUT_CONTEXT)

  const blocking = [R.PRIMARY_MISSING, R.PRIMARY_AFTER_SECONDARY, R.COMPONENT_AS_HEADLINE, R.NULL_PRIMARY_OBSCURED, R.SECONDARY_WITHOUT_CONTEXT, R.CROSS_TRIAL_RANKING]
  const status = reasons.some((r) => blocking.includes(r)) ? 'fail' : 'pass'
  return {
    status, reasons,
    inventory: { entries: inventory.entries.map(({ outcomeTokens, text, favorable, sentence, ...e }) => e), primaryBasis: inventory.primaryBasis, uncertain: inventory.uncertain },
    omitted,
    covers: (claim, entry) => claimCovers(claim, byId.get(claim.id), entry, index),
  }
}
