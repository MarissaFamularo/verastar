# Acceptance suite — replacement card system

Run: `npm run test:acceptance` (separate from `npm test`, which excludes this directory).

Behavioral authority: `docs/CARD_ACCEPTANCE_REFERENCE.md` (revision 4). The cases here are its
translation and are expected to grow; they are not an exhaustive standard.

| Layer | Where | Status |
|---|---|---|
| Specified behavior | reference cards; `schema.js`; `cases/*.js` | written |
| Executable tests | `cards.acceptance.test.js` | written; run |
| Demonstrated results | `src/cards/assess.js`, `src/cards/prose.js` | **stubs — every test fails "not implemented"** |

Case files:

| file | exercises |
|---|---|
| `bestcli` | positive RCT; co-primary cohorts; omitted assertions (blocking / noted / declared); fidelity fallback; landmark recommendation |
| `crest2` | two trials in one paper; null primary with favorable component; supported-but-misleading emphasis |
| `rao` | observational; associational language; secondary over primary (development example) |
| `cilostazol` | review; pooled primary with contributing sample; secondary-with-context vs bare; no personal line |
| `pcb` | classification proposal; printed brackets; subgroup-as-whole; scoped absences (development example; **not** diagnostic-validation coverage) |
| `basil2` | normal; state A genuine, simulated, and with no independent conclusion; state B genuinely restricted |
| `adversarial` | 27 claims whose numbers are all printed in the source but attached to the wrong arm, outcome, population, timepoint, comparator, p or sample |
| `roles` | real source with no declared primary (PMID 42855613); role 'primary' unverified; positional never promoted; adjacent-sentence linkage recorded |
| `prose` | final sentences checked against a hand-written correct assessment: unbacked numbers, superlatives, untagged assertions, contradicting direction words, withheld estimates (with or without a badge), role words, not-shown claims, invented CI labels, untagged personal lines |
| `diagnosticValidation` | **missing**; `todo` with the behaviors it must cover |

Separations the suite enforces (see `schema.js`):
- claim **eligibility** vs whole-card **display** — `expectInvariants` checks every assessment;
- inventory **roleBasis / linkage** with `uncertain` set for anything positional;
- every **fallback** conclusion is an independently checked claim with its own bound direction; none ⇒ no main result;
- **final prose** may carry only what its cited claims earned.

Rules: tests judge meaning, never wording; source text comes from the saved development
fixtures and their recorded verdicts are not read; `options.simulateEstimateFailure` exists only
here; legacy behavior is not a specification.
