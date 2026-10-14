# Replacement card system — design proposal, revision 2 (2026-10-13)

Status: **proposal**. Nothing here is implemented or wired into the app. Behavioral authority:
`docs/CARD_ACCEPTANCE_REFERENCE.md` (revision 4). Executable translation:
`src/acceptance/` (`npm run test:acceptance`); the current cases are an initial translation of
the reference, not an exhaustive standard, and are expected to grow as the reference is applied
to more papers.

This is a replacement, not a repair. The legacy verifier's architecture (one quantity → one
tier), its verdict taxonomy, and its test expectations are not carried forward; its recorded
behavior is evidence of failure modes the new system must not reproduce.

## 1. What the reference requires, and what revision 2 adds

Revision 1 of this proposal covered claim-level checking, a results inventory, fidelity,
personalization, and failure-dependent degradation. The review of that revision asked for five
things, now specified in `src/acceptance/schema.js` and tested:

1. **Final-prose checks.** The rendered sentences are checked against the assessment, sentence
   by sentence. A sentence may carry only what the claims it cites earned (§Stage 7).
2. **Omitted factual assertions are represented.** Everything the source reports that the card
   leaves out appears in `fidelity.omitted` with its role, how that role was established, and
   whether the omission blocks; the writer may declare omissions with a reason (§Stage 5).
3. **Claim eligibility is separate from whole-card display.** A claim earns an eligibility on
   its own evidence; the render plan decides display after fidelity. A shown claim must be
   eligible; an eligible claim may still not be shown (§Stage 6).
4. **Every fallback conclusion is an independently checked claim.** When an estimate fails,
   the direction is not inherited from it; the card may state a conclusion only through a
   separate claim bound to its own located sentence. No such claim ⇒ no main result (§Stage 6).
5. **Uncertain linkage and role classification are explicit.** The inventory records
   `roleBasis` and `linkage`; anything positional is marked `uncertain`, can never support a
   role word in prose, and is never promoted into a source fact (§Stage 3).

## 2. One complete path, worked on BEST-CLI

Source: the PubMed abstract of PMID 36342173 (`src/pipeline/__fixtures__/devset/PAD-10.json`,
text only). Profile: the stored items plus F1 and E1 (see the reference).

### Stage 1 — Evidence index (deterministic, no model)

```
index = {
  sections: [ {name:'BACKGROUND', available:true, span:[…]}, {name:'METHODS', …}, {name:'RESULTS', …}, {name:'CONCLUSIONS', …} ],
  sentences: [ {i:0, section:'BACKGROUND', text:'Patients with chronic limb-threatening ischemia (CLTI) require…', norm:'…', numbers:[]}, …,
               {i:6, section:'METHODS', text:'The primary outcome was a composite of a major adverse limb event - which was defined as amputation above the ankle or a major limb reintervention (…) - or death from any cause.', numbers:[]},
               {i:7, section:'RESULTS', text:'In cohort 1, after a median follow-up of 2.7 years, a primary-outcome event occurred in 302 of 709 patients (42.6%) in the surgical group and in 408 of 711 patients (57.4%) in the endovascular group (hazard ratio, 0.68; 95% confidence interval [CI], 0.59 to 0.79; P<0.001).',
                     numbers:[{v:2.7,role:'timepoint',unit:'years'},{v:302,role:'count',arm:'surgical'},{v:709,role:'denominator',arm:'surgical'},{v:42.6,role:'percent',arm:'surgical'},{v:408,…,arm:'endovascular'},{v:711,…},{v:57.4,role:'percent',arm:'endovascular'},{v:0.68,role:'estimate',measure:'HR'},{v:0.59,role:'ci-low'},{v:0.79,role:'ci-high'},{v:0.001,role:'p',op:'<'}]},
               {i:8, section:'RESULTS', text:'In cohort 2, …', numbers:[…0.79 … 0.58 … 1.06 … 0.12 … 1.6 …]},
               {i:9, section:'RESULTS', text:'The incidence of adverse events was similar in the two groups in the two cohorts.', numbers:[]} ],
  definitions: [ {kind:'primary-outcome', sentence:6, outcomes:['major adverse limb event','death from any cause'], components:['amputation above the ankle','major limb reintervention'], qualifiers:[]} ],
  labels: { arms:['surgical group','endovascular group'], cohorts:['cohort 1','cohort 2'], subgroups:[] },
  design: { randomized:true, parallel:'two-cohort', blinding:null, observational:false, review:false, matched:false }
}
```

How each part is built:
- *Sections* from abstract labels or PMC headings; availability is per section, so a text that
  ends before RESULTS yields `RESULTS.available:false` and state B follows without special
  casing.
- *Sentences* split on terminal punctuation outside brackets; normalized with the legacy
  `normalize` (NFKC, dash and interpunct folding, whitespace) — reused because it is correct
  and tested; nothing else from `verify.js` is reused but the number tokenizer.
- *Number roles* are assigned by local syntax only: `n of N (p%) in the X group` binds a count,
  denominator and percent to arm X; `hazard ratio, v; 95% CI, a to b; P…` binds an estimate
  tuple; `median follow-up of t years` binds a timepoint; `[a-b]` after a measure with no label
  binds a `printed-bracket`. A number whose role cannot be read from syntax gets `role:null`
  and can never bind to a claim element.
- *Arm and cohort labels* are the printed group names in Methods and Results; a claim's
  comparator must use (or map to) these.
- *Definitions* are sentences of the form "The primary outcome was…", "Primary outcomes
  were…", "Secondary outcomes included…". If none exists, `definitions` is empty and the
  inventory's `primaryBasis` is `none`.

### Stage 2 — Claim drafting (model, untrusted)

The model receives the index (not the raw text) and the profile, and returns a `CardDraft`:
typed claims each pointing at a sentence index, personal claims each citing item ids and a
connection type, and declared omissions. It cannot emit a number outside `estimate`, cannot
emit prose, and cannot assert a role the definitions do not contain except as `'reported'`.
Example output for the headline:

```
{ id:'cohort1', kind:'effect', role:'co-primary',
  population:'cohort 1', comparator:{a:'surgical group', b:'endovascular group'},
  outcome:'primary composite', timepoint:'median 2.7 years', direction:'favors-a', language:'causal',
  estimate:{measure:'HR', value:0.68, interval:{low:0.59, high:0.79, label:'95% CI'}, p:null, unit:null, sample:null},
  evidence:{sentence:7} }
```

### Stage 3 — Results inventory (deterministic)

Built from the index alone, before any claim is checked, so fidelity never depends on what the
model chose to mention:

| id | role | roleBasis | linkage | population | outcome | direction |
|---|---|---|---|---|---|---|
| inv-c1 | co-primary | definition-linked ("primary-outcome event" in s7 ↔ definition s6) | same-sentence | cohort 1 | MALE or death | favors-first (surgical) |
| inv-c2 | co-primary | definition-linked | same-sentence | cohort 2 | MALE or death | no-clear-difference (CI crosses 1, P=0.12) |
| inv-ae | safety | labeled ("adverse events") | same-sentence | both cohorts | adverse events | no-clear-difference ("similar") |

`primaryBasis: 'definition-linked'`, `uncertain: false`.

Role basis rules, in order: `labeled` (the sentence itself says primary/secondary/post hoc/
subgroup, or names a component of a defined composite); `definition-linked` (the sentence's
outcome matches a definition); `positional` (no label and no definition match; the entry is
`uncertain: true`, its role is `other`, and nothing downstream may call it primary). A result
sentence that names no outcome (CREST-2's "The absolute risk difference was 3.2 percentage
points…") is linked `adjacent-sentence` only when the preceding sentence in the same paragraph
reports the same comparison and no other result sentence intervenes; the linkage is recorded
on both the inventory entry and the claim result, never silently upgraded to `same-sentence`.

When the source declares no primary (PMID 42855613 in `cases/roles.js`): `primaryBasis:'none'`,
`uncertain:true`, every entry `role:'other'`, and fidelity reports `no-declared-primary`. The
first result is **not** labeled primary by position.

### Stage 4 — Claim checking (deterministic) → eligibility

For `cohort1`:

| element | how bound | result |
|---|---|---|
| evidence | sentence 7 located | ok |
| population | "cohort 1" is a cohort label in s7 | bound |
| comparator | both arm labels printed in s7; order surgical→endovascular | bound |
| outcome | "primary-outcome event" in s7 → definition s6 | bound (`definition-linked`) |
| timepoint | "median follow-up of 2.7 years" in s7 | bound |
| value / interval / p | 0.68, 0.59–0.79 tokens with roles estimate/ci-low/ci-high in s7; label "95% CI" printed | bound |
| direction | HR<1 with surgical first and 42.6%<57.4%; CI excludes 1 | bound (favors-a) |
| language | causal allowed: randomized contrast between the claimed arms | bound |
| role | co-primary: definition-linked, two cohorts | bound |

→ `eligibility:'pass'`, `linkage:'definition-linked'`.

Eligibility values: `pass` (everything bound, estimate checked), `pass-qualitative` (no
estimate asserted, qualitative elements bound), `withhold` (population/comparator/outcome
bound, estimate element unbound or contradicted; **direction is set `unbound`**, because it
was derived from the failed estimate), `fail` (a qualitative element unbound/contradicted),
`excluded` (evidence section unavailable).

What makes a correct number fail (the adversarial file, 27 cases): the token's **role and
owner** in the sentence must match the claim's slot. 57.4 has `arm:endovascular`; a claim
putting it on the surgical arm is `arm-value-mismatch`. 0.68 belongs to sentence 7's estimate
tuple; a claim for cohort 2 citing sentence 8 finds 0.79 there (`value-mismatch`) and a claim
citing sentence 7 with population "cohort 2" finds the cohort label contradicted. 1.6 years is
a timepoint token in sentence 8 only (`timepoint-mismatch`). 42.6% is bound to the primary
composite via the definition; "major amputation" is a component, so `outcome-substituted`.
Sample tokens (`1722 participants; six studies`) belong to the sentence that prints them; a
pooled estimate claiming the review's totals is `sample-mismatch`. A `printed-bracket` label is
part of the interval token; claiming "95% CI" is `interval-label-invented`. None of this is
heuristic: each is a role/owner comparison on the index.

### Stage 5 — Fidelity (deterministic) → whole-card verdict and omissions

Compare the card's claim set with the inventory:

- each inventory entry with role primary/co-primary must be covered by an eligible claim
  (`primary-missing`, `omitted[].severity:'blocking'`);
- a secondary/component/subgroup claim may not precede a primary claim
  (`primary-after-secondary`); the first effect claim may not be a component or secondary when a
  primary is null or absent (`component-as-headline`, `null-primary-obscured`);
- no claim may compare arms from different randomizations (`cross-trial-ranking`);
- a secondary estimate must name its outcome, its certainty where the source grades it, and
  sit beside a primary (`secondary-without-context`);
- an author sentence placed as the lead limitation beside a null primary is
  `null-primary-obscured` even though it is located and true (supported-but-misleading);
- without a declared primary the ordering checks still apply to the set of reported results
  (a card showing only the favorable results and omitting a null one fails).

Every inventory entry with no covering claim is listed in `fidelity.omitted` with `role`,
`roleBasis`, `severity` (`blocking` for primaries, `noted` otherwise) and `declared` (true when
the writer's `omissions` names it). For the BEST-CLI reference card, `omitted` = [inv-ae,
noted]; for the card that drops cohort 2, `omitted` = [inv-c2, blocking] and fidelity fails.

### Stage 6 — Render plan → display, fallbacks

Display is decided here, from eligibility and fidelity together:

| condition | state | display | mainResultShown | fallback |
|---|---|---|---|---|
| fidelity pass, all primaries `pass` | `full` | eligible claims shown; `pass` with estimate | true | null |
| a primary is `withhold` and a separate eligible claim states its conclusion | `reduced-estimate-withheld` | the withheld claim `shown-qualitative`; conclusion claim shown | true | `{kind:'estimate-withheld', conclusionClaims:[…]}` |
| a primary is `withhold` and no eligible claim states its conclusion | `reduced-estimate-withheld` | withheld claim shown as "could not be confirmed"; no direction | **false** | `conclusionClaims:[]` |
| results section unavailable | `reduced-results-unavailable` | design/population/definition/limitation only | false | `{kind:'results-unavailable', conclusionClaims:[]}` |
| fidelity fail | `reduced-fidelity-failed` | eligible claims that do not create the failure; no main result unless a checked claim covers every primary | false unless so | `{kind:'fidelity-rebuild', conclusionClaims:⊆ eligible}` |

Invariants (checked by the suite on every assessment): a shown claim is eligible; an estimate
shown requires `pass`; `display[id]` agrees with `claimsShown`/`estimatesShown`; every
`fallback.conclusionClaims` entry is `pass`/`pass-qualitative` with `elements.direction:'bound'`
on its own sentence; empty `conclusionClaims` ⇒ `mainResultShown:false`.

A fidelity failure may trigger one writer re-run with the inventory's primaries pinned; the
re-run's claims go through Stage 4 again. There is no path in which inventory text reaches the
card without becoming a checked claim.

### Stage 7 — Constrained rendering and final-prose check

The renderer is **not** a model with a filter. `render.js` builds each sentence by template
from checked claim fields only (population, comparator, outcome, timepoint, arm values,
estimate, interval label), tags it with the claim ids it was built from, and uses model text
nowhere in a factual sentence (personal lines carry the model's connection text, which the
personalization checker has already judged by connection type). `checkProse` then holds every
sentence — rendered or hand-written — to the claims it cites, structurally as well as by
tokens: the claim's cohort label or restriction must appear, the favored arm must be named
first (or the disfavored first under harm framing), arm values must sit in arm order, the
outcome head must appear and no component may stand in for it, and timepoints must match.
A sentence that cites a valid claim and prints its real numbers still fails when it swaps the
arms, substitutes amputation for the composite, drops the conduit restriction or changes the
timepoint (`cases/prose.js › renderedAdversarial`). It rejects a sentence when:

| condition | reason |
|---|---|
| a number in the sentence is not a token of a `pass` claim it cites (value, interval bound, p, count, timepoint, sample) | `unbacked-number` |
| a number belongs to a claim whose display is `shown-qualitative` (a withheld estimate), with or without a badge word | `number-from-withheld-estimate` |
| a comparative or superlative (largest, first, superior, outperformed…) with no claim asserting it | `unbacked-comparative` |
| a direction word (reduced, improved, lower, no difference…) that contradicts the cited claims' bound direction, or rests only on a claim whose direction is `unbound` | `direction-word-contradicts-claim` |
| a factual sentence with no claim ids | `untagged-assertion` |
| "primary"/"secondary" when no cited claim has `role:'bound'` | `role-word-unbacked` |
| a cited claim whose display is `not-shown` | `claim-not-shown-cited` |
| "95% CI" (or any label) for an interval whose claim carries `printed-bracket` | `prose-interval-label-invented` |
| a for-you sentence without personal ids, or citing an item not in `personalShown` | `personal-untagged` |

Number tokens in prose are extracted with the same tokenizer as Stage 1, so "0·84", "0.84" and
"8 %" compare equal. The check is deterministic; a rejected sentence sends the renderer back
with the reason, up to a bounded number of attempts, after which the sentence is dropped and
fidelity is re-evaluated on what remains (a dropped primary sentence ⇒ `reduced-fidelity-failed`).

Final card for BEST-CLI: the reference Card 1 text, every sentence tagged
(`[design]`, `[cohort1, primary-def]`, `[cohort2]`, `[design + p-ns1, p-f1]`, `[primary-def,
components-not-separated]`, read-recommendation with basis E1).

## 3. Where the model sits, and where it does not

| step | model | trusted? |
|---|---|---|
| Stage 2 claim drafting | yes (structured output, index as input) | no — every field is checked |
| Stage 7 prose rendering | yes | no — every sentence is checked |
| personalization topic overlap when not lexical | small structured call | verdict recorded; connection-type rules are deterministic |
| everything else (index, inventory, claim check, fidelity, render plan, prose check) | no | — |

## 4. Reuse from existing code, with justification

| module | reuse | why |
|---|---|---|
| `pipeline/verify.js` `normalize`, `extractNumbersWithIndex`, `numbersEqual` | yes | correct, tested normalization and representation-equal comparison; the index and the prose check need exactly these |
| `pipeline/verify.js` tiers, `verify()`, version stamps | no | the quantity-at-a-time model and taxonomy are what is replaced |
| `pipeline/evidenceContext.js` `locateQuote` | yes, as the location primitive | section awareness added around it |
| `pipeline/sources.js` fetch, `pmcSections`, `cleanAbstractText` | yes | source acquisition unchanged; `pmcSections` gives full-text sections |
| `pipeline/primaryResult.js` | no | its strict declared-primary matcher withheld whole cards; the inventory's roleBasis replaces it and a miss degrades to `primary-missing`/`no-declared-primary`, never to no card |
| `pipeline/triage.js` number guard, `numberFree.js`, `check.js` | no | repair-after-the-fact and advisory model audit; the renderer is rejected, not repaired, and fidelity is deterministic |
| devset fixtures | source text only | recorded rows and takes are legacy evidence |

## 5. Specified / executable / demonstrated

| | state |
|---|---|
| Specified | reference rev. 4; `schema.js`; 10 case files |
| Executable | `npm run test:acceptance` — see the run count in the suite output; 6 `todo` for the unfilled diagnostic-validation category |
| Demonstrated | **BEST-CLI path only** (`src/cards/`): index → claim check → inventory/fidelity → render plan → constrained renderer → prose check. All 46 BEST-CLI and prose tests pass, including state A end to end and the five rendered-output adversarial cases. Other cards' cases run against the same code and fail where their source patterns are not yet parsed (see `src/acceptance/README.md`). Nothing is wired into the app; `npm test` (legacy) is unchanged |

## 6. Open implementation questions (not editorial)

- Arm-label vocabulary on terse abstracts: when neither Methods nor the result sentence names
  the arms, comparator binding fails (`comparator-unbound`). This is the intended conservative
  behavior; the frequency on real digests is unknown until the index runs over the 39 fixtures.
- Sentence splitting inside brackets and around "vs." abbreviations needs its own tests before
  Stage 1 is trusted.
- The renderer's retry bound and whether a dropped non-primary sentence should be reported to
  the reader ("one result omitted: could not be rendered safely") are UI decisions.
