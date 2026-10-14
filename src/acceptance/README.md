# Acceptance suite — replacement card system

Run: `npm run test:acceptance` (separate from `npm test`, which excludes this directory).

Behavioral authority: `docs/CARD_ACCEPTANCE_REFERENCE.md` (revision 4). The cases here are its
translation and are expected to grow; they are not an exhaustive standard.

| Layer | Where | Status |
|---|---|---|
| Specified behavior | reference cards; `schema.js`; `cases/*.js` | written |
| Executable tests | `cards.acceptance.test.js` | written; run |
| Demonstrated results | `src/cards/` | **BEST-CLI path complete** (see below); other cards not yet extended |

## Demonstrated: the BEST-CLI path (source → assessment → rendered card)

`src/cards/index.js` (evidence index) → `check.js` (claim eligibility) → `inventory.js`
(results inventory, fidelity, omissions) → `assess.js` (render plan, personalization,
recommendation) → `render.js` (constrained templates from checked fields) → `prose.js`
(sentence-level check). None of it is wired into the app; production behavior is unchanged.

Passing on BEST-CLI (46 tests): every supported claim including the enrollment count and
both arm-specific percentages; all misleading variants; fidelity pass/fail with omissions
(blocking / noted / declared); personalization pass/fail; the editorial landmark route; state A
end to end (simulated estimate failure renders the conclusion from the independently checked
conclusions-sentence claim, no number); the constrained renderer's output passes the prose
check and carries every reference fact; the reference rendering passes against the real
assessment; and five rendered-output adversarial cases — arms swapped, arm values swapped,
amputation substituted for the composite, conduit restriction removed, timepoint changed —
each fail for the specified reason, against both the hand-written and the real assessment.

Not hardcoded anywhere: paper ids, claim ids, expected answers. The checker binds claim
fields to number roles and owners the index reads from local syntax.

## Not yet demonstrated

Other cards' cases run against the same code and currently fail where their sources use
patterns the index does not yet parse (Lancet "n (p%) of N patients in the X group",
Cochrane "MD x metres; 95% CI …; n participants; k studies", bracketed HRs without a label,
"x% vs y%" arm pairs, two-trial papers). 21 of 27 cross-paper adversarial cases already fail
correctly; the remaining six fail for a different reason code or, in one case before the
composite-disjunction rule, were accepted (BASIL-2 primary HR bound to "all-cause death").
These are the next extension, card by card, with each false accept treated as a checker
defect.

## Case files

| file | exercises |
|---|---|
| `bestcli` | positive RCT; co-primary cohorts; enrollment count and arm percentages as claims; omitted assertions; fidelity fallback; landmark recommendation |
| `crest2` | two trials in one paper; null primary with favorable component; supported-but-misleading emphasis |
| `rao` | observational; associational language; secondary over primary (development example) |
| `cilostazol` | review; pooled primary with contributing sample; secondary-with-context vs bare; no personal line |
| `pcb` | classification proposal; printed brackets; subgroup-as-whole; scoped absences (development example; **not** diagnostic-validation coverage) |
| `basil2` | normal; state A genuine, simulated, and with no independent conclusion; state B genuinely restricted |
| `adversarial` | 27 claims whose numbers are all printed in the source but attached to the wrong arm, outcome, population, timepoint, comparator, p or sample |
| `roles` | real source with no declared primary (PMID 42855613); role 'primary' unverified; positional never promoted; adjacent-sentence linkage recorded |
| `prose` | reference rendering, state-A rendering, rendered-output adversarial cases, and sentence-level rejections |
| `diagnosticValidation` | **missing**; `todo` with the behaviors it must cover |

Rules: tests judge meaning, never wording; source text comes from the saved development
fixtures and their recorded verdicts are not read; `options.simulateEstimateFailure` exists only
here; legacy behavior is not a specification; a test that contradicts the reference is a
specification defect to report, not a reason to bypass a check.
