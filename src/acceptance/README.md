# Acceptance suite — replacement card system

Run: `npm run test:acceptance` (separate from `npm test`, which excludes this directory).

| Layer | Where | Status |
|---|---|---|
| Specified behavior | `docs/CARD_ACCEPTANCE_REFERENCE.md` (reference cards, rev. 4) and `cases/*.js` (typed claims, reason codes, render states) | written |
| Executable tests | `cards.acceptance.test.js` against the contract in `schema.js` | written; run |
| Demonstrated results | `src/cards/assess.js` | **stub — every test fails "not implemented"** |

Cases: `bestcli` (positive RCT), `crest2` (inconclusive with favorable secondary; two trials),
`rao` (observational; development example), `cilostazol` (review; primary estimate is intended
output), `pcb` (observational classification proposal; development example; not
diagnostic-validation coverage), `basil2` (normal, state A genuine, state A simulated, state B
genuinely restricted), `diagnosticValidation` (**missing**, `todo`).

Rules of the suite:
- Tests judge meaning: claim status, bound elements, reason codes, render state. Never wording.
- Source text comes from the saved development fixtures; their recorded verdicts are not read.
- `options.simulateEstimateFailure` exists only here (state A2). It must not exist in production paths.
- Legacy behavior is not a specification. Do not weaken a case to match `pipeline/verify.js`.
