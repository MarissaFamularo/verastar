// acceptance/schema.js — the vocabulary the acceptance cases are written in.
//
// This file defines SPECIFIED BEHAVIOR: the shapes a replacement card system must accept
// and produce for the acceptance suite to run against it. It is not an implementation and
// it deliberately shares nothing with pipeline/verify.js's verdict taxonomy.
//
// Cases test MEANING, not wording. A card is therefore represented as a set of typed
// claims, not as prose. How prose is produced from checked claims is the design's concern
// (docs/CARD_REPLACEMENT_DESIGN.md); the acceptance suite judges the claim set.

/**
 * @typedef {Object} Interval
 * @property {number} low
 * @property {number} high
 * @property {'95% CI'|'97.5% CI'|'printed-bracket'|null} label  — 'printed-bracket' means the source
 *   prints [a-b] with no label; the card may show it only as printed, never as a CI.
 */

/**
 * @typedef {Object} Estimate
 * @property {'HR'|'aHR'|'OR'|'RR'|'MD'|'RD'|'rate'|'percent'|'count'} measure
 * @property {number} value
 * @property {Interval|null} interval
 * @property {number|null} p
 * @property {string|null} unit                       — e.g. 'metres', 'percentage points'
 * @property {{studies?: number, participants?: number}|null} sample — contributing sample when the
 *   source states one (pooled estimates); must be checked when stated.
 */

/**
 * A claim the card wants to make. Every field that is non-null is an ASSERTION the verifier
 * must find bound to the located evidence; null means "not asserted".
 *
 * @typedef {Object} Claim
 * @property {string} id
 * @property {'design'|'population'|'outcome-definition'|'effect'|'no-clear-difference'|'rate'|
 *            'count'|'certainty'|'limitation'|'author-statement'|'absence'} kind
 * @property {'primary'|'co-primary'|'secondary'|'component'|'subgroup'|'safety'|'design'|null} role
 * @property {string|null} population         — e.g. 'CLTI, usable single-segment GSV (cohort 1)'
 * @property {{a: string, b: string}|null} comparator — a is the arm the direction refers to
 * @property {string|null} outcome
 * @property {string|null} timepoint
 * @property {'favors-a'|'favors-b'|'no-clear-difference'|'equivalent'|'non-inferior'|null} direction
 * @property {Estimate|null} estimate
 * @property {'causal'|'associational'|'none'} language — the strength of the verb the card uses
 * @property {'source'|'design'|'editorial'} basis
 * @property {'authors'|null} attribution     — "the authors report/attribute" — never a substitute for checking
 * @property {{quote: string, section?: string}|null} evidence — proposed anchor; the verifier re-locates it
 * @property {string} [text]                   — optional prose for human reading; never judged
 */

/**
 * @typedef {Object} PersonalClaim
 * @property {string} id
 * @property {string[]} items                  — profile item ids the connection rests on
 * @property {'topic'|'population'|'method'|'practice'|'project-aim'} connection
 *   topic: the paper's subject overlaps the item's topic (weakest, usually sufficient for a north star)
 *   population: the paper's population is one a named program/role treats (needs a practice fact)
 *   method: the paper's method is reusable for a project (needs the project to be about that method)
 *   practice: asserts something about the user's own practice or patients (needs an F-type fact)
 *   project-aim: asserts what a project is trying to do (needs the aim in the profile, not just a name)
 * @property {string} text
 */

/**
 * @typedef {Object} ProfileItem
 * @property {string} id
 * @property {'north-star'|'project'|'rubric'|'fact'|'editorial'} kind
 * @property {string} text
 */

/**
 * @typedef {Object} CardDraft
 * @property {Claim[]} claims
 * @property {PersonalClaim[]} personal
 * @property {{read: 'full'|'abstract-enough'|'lower-priority', reasons: string[]}} recommendation
 */

/**
 * @typedef {Object} SourceInput
 * @property {string} text                     — exactly the text available (may be truncated to simulate availability)
 * @property {'full_text'|'abstract_only'|'partial'} tier
 * @property {string} [tables]
 */

/**
 * Harness options exist only for acceptance scenarios. `simulateEstimateFailure` forces the
 * estimate check of the named claim ids to fail WITHOUT altering the source, so the suite can
 * exercise state A explicitly (reference Card 6, state A). It must not exist in production paths.
 *
 * @typedef {Object} AssessOptions
 * @property {string[]} [simulateEstimateFailure]
 */

/**
 * Per-claim outcome. `elements` records which asserted fields were bound to evidence.
 *
 * @typedef {Object} ClaimResult
 * @property {string} id
 * @property {'pass'|'pass-qualitative'|'withhold'|'fail'|'excluded'} status
 *   pass            — every asserted element bound; estimate (if any) checked; shown with estimate
 *   pass-qualitative— no estimate asserted (or estimate withheld) and the qualitative elements bound
 *   withhold        — the qualitative part passes but the estimate did not check; shown without estimate
 *   fail            — an asserted element is unbound or contradicted; not shown
 *   excluded        — the evidence section is not in the available source; not shown
 * @property {Record<string, 'bound'|'unbound'|'contradicted'|'not-asserted'>} elements
 *   keys: population, comparator, outcome, timepoint, direction, value, interval, p, unit, sample, language
 * @property {string[]} reasons — stable reason codes (see REASONS)
 */

/**
 * @typedef {Object} FidelityResult
 * @property {'pass'|'fail'} status
 * @property {string[]} reasons
 * @property {{primaries: string[], shown: string[]}} inventory — primary results the source reports vs those the card shows
 */

/**
 * @typedef {Object} PersonalResult
 * @property {string} id
 * @property {'pass'|'fail'} status
 * @property {string[]} reasons
 */

/**
 * @typedef {Object} RenderPlan
 * @property {'full'|'reduced-estimate-withheld'|'reduced-results-unavailable'} state
 * @property {string[]} claimsShown
 * @property {string[]} estimatesShown         — subset of claimsShown whose estimate may print
 * @property {string[]} personalShown
 * @property {boolean} mainResultShown
 */

/**
 * @typedef {Object} Assessment
 * @property {ClaimResult[]} claims
 * @property {FidelityResult} fidelity
 * @property {PersonalResult[]} personal
 * @property {RenderPlan} render
 */

// Reason codes the suite asserts on. Implementations may add codes; they may not rename these.
export const REASONS = Object.freeze({
  QUOTE_NOT_LOCATED: 'quote-not-located',
  POPULATION_UNBOUND: 'population-unbound',
  POPULATION_OVERGENERALIZED: 'population-overgeneralized',
  COMPARATOR_UNBOUND: 'comparator-unbound',
  COMPARATOR_NOT_RANDOMIZED: 'comparator-not-randomized', // cross-trial / cross-cohort comparison
  OUTCOME_UNBOUND: 'outcome-unbound',
  OUTCOME_SUBSTITUTED: 'outcome-substituted',             // component or different outcome named as the claimed one
  TIMEPOINT_UNBOUND: 'timepoint-unbound',
  DIRECTION_UNSUPPORTED: 'direction-unsupported',         // interval includes null / P ns, but direction claimed
  EQUIVALENCE_NOT_TESTED: 'equivalence-not-tested',
  VALUE_MISMATCH: 'value-mismatch',
  INTERVAL_MISMATCH: 'interval-mismatch',
  INTERVAL_LABEL_INVENTED: 'interval-label-invented',     // printed bracket shown as a CI
  MEASURE_MISMATCH: 'measure-mismatch',                   // OR reported as RR, etc.
  SAMPLE_MISMATCH: 'sample-mismatch',
  CAUSAL_LANGUAGE_NONRANDOMIZED: 'causal-language-nonrandomized',
  SUBGROUP_AS_WHOLE: 'subgroup-as-whole',
  ESTIMATE_UNCHECKED: 'estimate-unchecked',               // located, not checked → withhold (publication rule)
  SECTION_UNAVAILABLE: 'section-unavailable',
  ATTRIBUTION_NOT_SUBSTITUTE: 'attribution-not-substitute',
  VALIDATION_NOT_REPORTED: 'validation-not-reported',
  ABSENCE_OVERSCOPED: 'absence-overscoped',               // "nothing was validated" vs "not reported in the abstract"
  // fidelity
  PRIMARY_MISSING: 'primary-missing',
  PRIMARY_AFTER_SECONDARY: 'primary-after-secondary',
  NULL_PRIMARY_OBSCURED: 'null-primary-obscured',
  COMPONENT_AS_HEADLINE: 'component-as-headline',
  CROSS_TRIAL_RANKING: 'cross-trial-ranking',
  SECONDARY_WITHOUT_CONTEXT: 'secondary-without-context', // secondary shown without outcome/certainty/relation to primary
  // personalization
  NO_SUPPORTING_ITEM: 'no-supporting-item',
  PROJECT_AIM_ASSERTED: 'project-aim-asserted',
  PRACTICE_CLAIM_WITHOUT_FACT: 'practice-claim-without-fact',
  CONNECTION_TYPE_UNSUPPORTED: 'connection-type-unsupported',
})

// The profile as the acceptance suite sees it: the stored Verastar profile items used by the
// reference cards, plus the two non-profile facts the reference admits with their own kinds.
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

// A profile WITHOUT the practice fact and editorial judgment, for cases that test what the app
// may say from the stored profile alone.
export const PROFILE_STORED_ONLY = Object.freeze(PROFILE.filter((p) => p.kind !== 'fact' && p.kind !== 'editorial'))
