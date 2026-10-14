# Acceptance suite — replacement card system

Run: `npm run test:acceptance` (separate from `npm test`, which excludes this directory).

Behavioral authority: `docs/CARD_ACCEPTANCE_REFERENCE.md` (revision 4). The cases here are its
translation and are expected to grow; they are not an exhaustive standard.

| Layer | Where | Status |
|---|---|---|
| Specified behavior | reference cards; `schema.js`; `cases/*.js` | written |
| Executable tests | `cards.acceptance.test.js` | written; run |
| Demonstrated results | `src/cards/` | **all six cards, the roles/linkage cases, the adversarial set and the prose cases pass** (201 passed, 6 `todo` for diagnostic validation); see the coverage and the false-accept record below |

## Demonstrated: source → assessment → rendered card, every card

`src/cards/index.js` (evidence index) → `check.js` (claim eligibility) → `inventory.js`
(results inventory, fidelity, omissions) → `assess.js` (render plan, personalization,
recommendation) → `render.js` (constrained templates from checked fields) → `prose.js`
(sentence-level check). None of it is wired into the app; production behavior is unchanged.

Per card, the suite runs every supported claim, every misleading variant, every fidelity
composition, personalization, the end-to-end render of the reference composition through the
constrained renderer and the prose check, and the card's share of the adversarial set:

| card | what the path had to learn beyond BEST-CLI |
|---|---|
| BEST-CLI | enrollment count and arm percentages as claims; state A with an independently checked conclusion; five rendered-output adversarial cases |
| BASIL-2 | timepoints bound by value + unit + meaning; intervals by confidence level; disjunctive composites ("major amputation or death") where one word never establishes identity; wrong-arm percentage is a contradiction, not a withhold; normal, state A (genuine, simulated, no conclusion) and state B rendered |
| CREST-2 | two trials in one paper; cohort labels by position; "in the X group as compared with the Y group" tuples; "A plus B" arm phrases; component rate ("beyond 44 days") kept apart from the primary composite |
| RAO after CEA vs CAS | abbreviations whose letters are not word initials (CEA); "x% vs y%" pairs owned by the single named arm; a secondary claim with two outcomes in one sentence |
| Cochrane cilostazol | "MD x metres; 95% CI; n participants; k studies" tuples with sample binding; ICD/ACD resolved to their definitions by printed abbreviation; an authors' verdict ("safe") refused when the cited sentence abstains |
| PCB grade | list definitions with a trailing "assessed by …" clause; MALE resolved to its own definition, not to the half-overlapping "major amputation"; subgroup sentences; printed brackets |
| roles | no declared primary → `primaryBasis 'none'`; positional promotion refused; adjacent-sentence linkage recorded |

Not hardcoded anywhere: paper ids, claim ids, expected answers. The checker binds claim
fields to number roles and owners the index reads from local syntax.

## Observed false accepts

Every one below was an accept of a wrong claim by an earlier version of this code, found by
the suite or by a mutation probe (each passing supported claim corrupted by arm swap,
direction flip, +10% value, interval shift, timepoint +1, arms swapped, outcome swapped for
another outcome of the same paper, causal language on an observational source). Each is now a
reason-coded failure and has a case in the suite.

| source | wrong claim that was accepted | cause | fix |
|---|---|---|---|
| BASIL-2 | primary HR bound to "all-cause death" | one shared word ("death") counted as outcome identity | disjunct coverage: every disjunct of a composite must be named; a component shares the vocabulary but is `outcome-substituted` |
| CREST-2 | post-procedural stroke rate accepted as the primary (transient, during development) | phrase ownership of the 0.4% not resolved to the component | tuple/percent ownership and `outcome-substituted` + `timepoint-mismatch` |
| CREST-2 | the 4-year primary rate labeled "ipsilateral ischemic stroke" | the definition's window-initials ("iis" from the last three core words) let a component name the composite | an endpoint's acronym is the acronym of its whole core or a printed abbreviation covering the whole core; a disjunct carries only its own acronym |
| CREST-2 | post-procedural ipsilateral-stroke rate labeled "primary composite" | the word "composite" in a claim short-circuited identity against any phrase | naming the composite identifies a defined composite endpoint only |
| cilostazol | the ACD mean difference (39.57 m) labeled initial claudication distance | "initial" was a stop word, so ICD and ACD shared a core | "initial" removed from the stop list |
| PCB | MALE HR 1.52 labeled major amputation | a phrase resolved to the first definition it half-covered ("major amputation") instead of the one it names | best-match resolution; a value owned by a different outcome's phrase is `value-mismatch` |
| apixaban (roles) | comparator unbound on a two-arm null result because "venous thromboembolism" was read as a third arm | greedy "A vs B for C" pair capture | sided arm trimming: last segment left of "vs", first segment right of it |

What the probe shows now: of 88 mutants across the six cards, 8 are still accepted, and all 8
are rewordings of the same endpoint (the full composite name in place of "primary composite",
"incidence of RAO" for RAO, one of two null outcomes reported together). The probe does not
mutate population labels or evidence quotes, and its outcome swaps are drawn only from the
paper's own supported claims. Passing it is not evidence of general correctness: the index
reads local syntax, and each card above required new syntax.

## Not demonstrated

- Diagnostic-validation cards (`diagnosticValidation.js`, 6 `todo`): no reference card yet.
- Sources outside the eight fixtures above. Terse abstracts that never name the arms bind no
  comparator (intended), and the frequency of that on real digests is unmeasured.
- Any run of the drafting model: all claims here are hand-written from the reference; the
  stage that produces claims from a source has not been exercised.

## Case files

| file | exercises |
|---|---|
| `bestcli` | positive RCT; co-primary cohorts; enrollment count and arm percentages as claims; omitted assertions; fidelity fallback; landmark recommendation |
| `crest2` | two trials in one paper; null primary with favorable component; supported-but-misleading emphasis |
| `rao` | observational; associational language; secondary over primary (development example) |
| `cilostazol` | review; pooled primary with contributing sample; secondary-with-context vs bare; no personal line |
| `pcb` | classification proposal; printed brackets; subgroup-as-whole; scoped absences (development example; **not** diagnostic-validation coverage) |
| `basil2` | normal; state A genuine, simulated, and with no independent conclusion; state B genuinely restricted |
| `adversarial` | 40 claims whose numbers are all printed in the source but attached to the wrong arm, outcome, population, timepoint, comparator, p or sample |
| `roles` | real source with no declared primary (PMID 42855613); role 'primary' unverified; positional never promoted; adjacent-sentence linkage recorded |
| `prose` | reference rendering, state-A rendering, rendered-output adversarial cases, and sentence-level rejections |
| `diagnosticValidation` | **missing**; `todo` with the behaviors it must cover |

Rules: tests judge meaning, never wording; source text comes from the saved development
fixtures and their recorded verdicts are not read; `options.simulateEstimateFailure` exists only
here; legacy behavior is not a specification; a test that contradicts the reference is a
specification defect to report, not a reason to bypass a check.
