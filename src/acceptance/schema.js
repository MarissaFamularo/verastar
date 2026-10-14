// acceptance/schema.js — the vocabulary the acceptance cases are written in.
//
// SPECIFIED BEHAVIOR: the shapes a replacement card system must accept and produce for the
// acceptance suite to run against it. Not an implementation; shares nothing with the legacy
// verdict taxonomy. The card reference (docs/CARD_ACCEPTANCE_REFERENCE.md) is the behavioral
// authority; this schema and the cases are its translation and are expected to grow.
//
// Four separations the schema enforces:
//   1. claim ELIGIBILITY (what a claim earned on its own evidence) is separate from DISPLAY
//      (what the whole-card checks let the renderer show);
//   2. the results INVENTORY records how each entry's role and linkage were established —
//      labeled, definition-linked, adjacent-sentence, or positional — and positional
//      classification is never a source fact;
//   3. every FALLBACK conclusion must be an independently checked claim, never text derived
//      from a failed estimate or from the inventory alone;
//   4. FINAL PROSE is checked sentence by sentence against the assessment; a sentence may carry
//      only what the claims it cites earned.

/** @typedef {{low:number, high:number, label:'95% CI'|'97.5% CI'|'printed-bracket'|null}} Interval */

/**
 * @typedef {Object} Estimate
 * @property {'HR'|'aHR'|'OR'|'RR'|'MD'|'RD'|'rate'|'percent'|'count'} measure
 * @property {number} value
 * @property {Interval|null} interval
 * @property {number|null} p
 * @property {string|null} unit
 * @property {{studies?:number, participants?:number}|null} sample
 */

/**
 * Every non-null field is an ASSERTION the checker must bind to evidence.
 * @typedef {Object} Claim
 * @property {string} id
 * @property {'design'|'population'|'outcome-definition'|'effect'|'no-clear-difference'|'rate'|'count'|'certainty'|'limitation'|'author-statement'|'absence'} kind
 * @property {'primary'|'co-primary'|'secondary'|'component'|'subgroup'|'safety'|'design'|'reported'|null} role
 *   'reported' = the card makes no role assertion (used when the source declares no primary).
 * @property {string|null} population
 * @property {{a:string, b:string}|null} comparator
 * @property {string|null} outcome
 * @property {string|null} timepoint
 * @property {'favors-a'|'favors-b'|'no-clear-difference'|'equivalent'|'non-inferior'|null} direction
 * @property {Estimate|null} estimate
 * @property {{arm:'a'|'b', percent?:number, count?:number, denominator?:number}[]} [arms]
 *   arm-specific printed values the card will show; each is checked for owner arm
 * @property {'causal'|'associational'|'none'} language
 * @property {'source'|'design'|'editorial'} basis
 * @property {'authors'|null} attribution
 * @property {{quote:string, section?:string}|null} evidence
 * @property {string} [text]
 */

/**
 * @typedef {Object} PersonalClaim
 * @property {string} id
 * @property {string[]} items
 * @property {'topic'|'population'|'method'|'practice'|'project-aim'} connection
 * @property {string} text
 */

/** @typedef {{id:string, kind:'north-star'|'project'|'rubric'|'fact'|'editorial', text:string}} ProfileItem */

/**
 * A deliberate omission the writer declares, so the fidelity check can tell "left out on
 * purpose, with a reason" from "forgotten". Omitting a primary is never acceptable; declaring
 * it only makes the failure explicit.
 * @typedef {{describes:string, reason:'secondary-not-shown'|'safety-not-shown'|'out-of-scope'|'other'}} DeclaredOmission
 */

/**
 * @typedef {Object} CardDraft
 * @property {Claim[]} claims
 * @property {PersonalClaim[]} personal
 * @property {DeclaredOmission[]} [omissions]
 * @property {{read:'full'|'abstract-enough'|'lower-priority', reasons:string[]}} recommendation
 */

/** @typedef {{text:string, tier:'full_text'|'abstract_only'|'partial', tables?:string}} SourceInput */

/**
 * Acceptance-only options. `simulateEstimateFailure` forces the estimate check of the named
 * claims to fail with the source untouched (Card 6 state A2). Must not exist in production.
 * @typedef {{simulateEstimateFailure?:string[]}} AssessOptions
 */

// ---------------------------------------------------------------------------------------
// Results

/**
 * Per-claim ELIGIBILITY — what the claim earned on its own evidence. Display is decided
 * separately (RenderPlan). Values:
 *   pass             every asserted element bound; estimate checked → eligible with estimate
 *   pass-qualitative no estimate asserted (or none claimed) and qualitative elements bound
 *   withhold         population/comparator/outcome bound, estimate failed → eligible without
 *                    estimate; direction is NOT inherited from the failed estimate
 *   fail             a qualitative element unbound or contradicted → ineligible
 *   excluded         evidence section unavailable → ineligible
 *
 * @typedef {Object} ClaimResult
 * @property {string} id
 * @property {'pass'|'pass-qualitative'|'withhold'|'fail'|'excluded'} eligibility
 * @property {Record<string,'bound'|'unbound'|'contradicted'|'not-asserted'|'positional-only'>} elements
 *   keys: population, comparator, outcome, timepoint, direction, value, interval, p, unit, sample, language, role
 * @property {'same-sentence'|'definition-linked'|'adjacent-sentence'|'positional'|'none'} linkage
 *   how the outcome/population named in the claim was tied to the located sentence
 * @property {string[]} reasons
 */

/**
 * One entry of the results inventory the system derives from the source, independent of the
 * card. `roleBasis` says how the role was established; 'positional' entries are uncertain and
 * may never be asserted as source facts (no "primary" wording may rest on them).
 * @typedef {Object} InventoryEntry
 * @property {string} id
 * @property {'primary'|'co-primary'|'secondary'|'component'|'subgroup'|'safety'|'other'} role
 * @property {'labeled'|'definition-linked'|'positional'|'none'} roleBasis
 * @property {'same-sentence'|'definition-linked'|'adjacent-sentence'|'positional'} linkage
 * @property {boolean} uncertain       — true whenever roleBasis or linkage is positional
 * @property {string|null} population  — cohort / trial / subgroup label as printed
 * @property {string} outcome
 * @property {'favors-first'|'favors-second'|'no-clear-difference'|'not-reported'|'not-pooled'|'unknown'} direction
 */

/**
 * @typedef {Object} FidelityResult
 * @property {'pass'|'fail'} status
 * @property {string[]} reasons
 * @property {{entries:InventoryEntry[], primaryBasis:'labeled'|'definition-linked'|'none', uncertain:boolean}} inventory
 * @property {{entry:string, role:string, roleBasis:string, severity:'blocking'|'noted', declared:boolean}[]} omitted
 *   every inventory entry with no claim on the card; blocking when the role is primary/co-primary
 */

/** @typedef {{id:string, status:'pass'|'fail', reasons:string[]}} PersonalResult */

/**
 * DISPLAY decisions, made after fidelity. A claim may be eligible and still not shown
 * (dropped by a fallback); a shown claim must be eligible.
 * @typedef {Object} RenderPlan
 * @property {'full'|'reduced-estimate-withheld'|'reduced-results-unavailable'|'reduced-fidelity-failed'} state
 * @property {Record<string,'shown-with-estimate'|'shown-qualitative'|'not-shown'>} display
 * @property {string[]} claimsShown
 * @property {string[]} estimatesShown
 * @property {string[]} personalShown
 * @property {boolean} mainResultShown
 * @property {{kind:'estimate-withheld'|'results-unavailable'|'fidelity-rebuild', conclusionClaims:string[]}|null} fallback
 *   conclusionClaims: the independently checked claims that state the main conclusion in a
 *   fallback. Empty ⇒ the card may not state a direction and mainResultShown must be false.
 */

/**
 * @typedef {Object} Assessment
 * @property {ClaimResult[]} claims
 * @property {FidelityResult} fidelity
 * @property {PersonalResult[]} personal
 * @property {RenderPlan} render
 * @property {{read:string, basis:string[]}} recommendation
 */

// ---------------------------------------------------------------------------------------
// Final prose

/**
 * What the renderer produces: sentences, each tagged with the claim and personal ids it renders.
 * @typedef {{text:string, claims:string[], personal?:string[], kind?:'finding'|'for-you'|'temper'|'read'|'header'}} Sentence
 * @typedef {{sentences:Sentence[]}} RenderedCard
 */

/**
 * checkProse({ rendered, assessment, claims }) → ProseResult
 * @typedef {{index:number, status:'ok'|'reject', reasons:string[]}} SentenceResult
 * @typedef {{status:'pass'|'fail', sentences:SentenceResult[]}} ProseResult
 */

// ---------------------------------------------------------------------------------------
// Reason codes the suite asserts on. Implementations may add codes, never rename these.
export const REASONS = Object.freeze({
  // claim support — location and binding
  QUOTE_NOT_LOCATED: 'quote-not-located',
  POPULATION_UNBOUND: 'population-unbound',
  POPULATION_OVERGENERALIZED: 'population-overgeneralized',
  COMPARATOR_UNBOUND: 'comparator-unbound',
  COMPARATOR_NOT_RANDOMIZED: 'comparator-not-randomized',
  ARM_VALUE_MISMATCH: 'arm-value-mismatch',               // a printed value bound to the other arm
  OUTCOME_UNBOUND: 'outcome-unbound',
  OUTCOME_SUBSTITUTED: 'outcome-substituted',
  TIMEPOINT_UNBOUND: 'timepoint-unbound',
  TIMEPOINT_MISMATCH: 'timepoint-mismatch',               // a printed timepoint from another result
  DIRECTION_UNSUPPORTED: 'direction-unsupported',
  EQUIVALENCE_NOT_TESTED: 'equivalence-not-tested',
  VALUE_MISMATCH: 'value-mismatch',
  INTERVAL_MISMATCH: 'interval-mismatch',
  INTERVAL_LABEL_INVENTED: 'interval-label-invented',
  P_MISMATCH: 'p-mismatch',
  MEASURE_MISMATCH: 'measure-mismatch',
  SAMPLE_MISMATCH: 'sample-mismatch',
  CAUSAL_LANGUAGE_NONRANDOMIZED: 'causal-language-nonrandomized',
  SUBGROUP_AS_WHOLE: 'subgroup-as-whole',
  ROLE_UNVERIFIED: 'role-unverified',                     // role asserted; source gives only positional support
  LINKAGE_UNCERTAIN: 'linkage-uncertain',
  ESTIMATE_UNCHECKED: 'estimate-unchecked',
  SECTION_UNAVAILABLE: 'section-unavailable',
  ATTRIBUTION_NOT_SUBSTITUTE: 'attribution-not-substitute',
  VALIDATION_NOT_REPORTED: 'validation-not-reported',
  ABSENCE_OVERSCOPED: 'absence-overscoped',
  // fidelity
  PRIMARY_MISSING: 'primary-missing',
  PRIMARY_AFTER_SECONDARY: 'primary-after-secondary',
  NULL_PRIMARY_OBSCURED: 'null-primary-obscured',
  COMPONENT_AS_HEADLINE: 'component-as-headline',
  CROSS_TRIAL_RANKING: 'cross-trial-ranking',
  SECONDARY_WITHOUT_CONTEXT: 'secondary-without-context',
  NO_DECLARED_PRIMARY: 'no-declared-primary',             // informational: inventory.primaryBasis === 'none'
  // fallback
  FALLBACK_CONCLUSION_UNCHECKED: 'fallback-conclusion-unchecked',
  // personalization
  NO_SUPPORTING_ITEM: 'no-supporting-item',
  PROJECT_AIM_ASSERTED: 'project-aim-asserted',
  PRACTICE_CLAIM_WITHOUT_FACT: 'practice-claim-without-fact',
  CONNECTION_TYPE_UNSUPPORTED: 'connection-type-unsupported',
  // final prose
  UNBACKED_NUMBER: 'unbacked-number',                     // number not carried by a cited pass claim
  NUMBER_FROM_WITHHELD_ESTIMATE: 'number-from-withheld-estimate',
  UNBACKED_COMPARATIVE: 'unbacked-comparative',           // largest / first / superior with no claim
  DIRECTION_WORD_CONTRADICTS_CLAIM: 'direction-word-contradicts-claim',
  UNTAGGED_ASSERTION: 'untagged-assertion',               // factual sentence with no claim ids
  ROLE_WORD_UNBACKED: 'role-word-unbacked',               // "primary" resting on positional role
  CLAIM_NOT_SHOWN_CITED: 'claim-not-shown-cited',
  PROSE_INTERVAL_LABEL_INVENTED: 'prose-interval-label-invented',
  PERSONAL_UNTAGGED: 'personal-untagged',
  // final prose — structure against the cited claim's checked fields
  PROSE_ARM_SWAPPED: 'prose-arm-swapped',                 // favored arm not first, or arm values in the wrong order
  PROSE_OUTCOME_SUBSTITUTED: 'prose-outcome-substituted', // a component named where the claim's outcome belongs
  PROSE_POPULATION_DROPPED: 'prose-population-dropped',   // cohort / restriction in the claim absent from the sentence
  PROSE_TIMEPOINT_CHANGED: 'prose-timepoint-changed',
})

/** @type {ProfileItem[]} */
export const PROFILE = Object.freeze([
  { id: 'NS1', kind: 'north-star', text: 'CLTI limb preservation' },
  { id: 'NS3', kind: 'north-star', text: 'carotid stenosis management' },
  { id: 'P1', kind: 'project', text: 'Limb Preservation Program' },
  { id: 'P4', kind: 'project', text: 'Carotid stenosis Stroke Prediction' },
  { id: 'P5', kind: 'project', text: 'limb loss prediction' },
  { id: 'R', kind: 'rubric', text: 'Prioritize randomized controlled trials and papers that would change practice or spark conference discussion; flag anything methodologically reusable for ongoing projects' },
  { id: 'F1', kind: 'fact', text: 'Medical Director of a Limb Preservation Program' },
  { id: 'E1', kind: 'editorial', text: 'BEST-CLI is a landmark trial' },
])

export const PROFILE_STORED_ONLY = Object.freeze(PROFILE.filter((p) => p.kind !== 'fact' && p.kind !== 'editorial'))
