# Replacement card system — design proposal (2026-10-13)

Status: **proposal**. Nothing here is implemented or wired into the app. The acceptance suite
(`src/acceptance/`, `npm run test:acceptance`) specifies the behavior; this document proposes
the design needed to satisfy it. Reference cards: `docs/CARD_ACCEPTANCE_REFERENCE.md`.

This is a replacement, not a repair. The old verifier's architecture (one `quantity` at a
time → tier), its verdict taxonomy (`verified-estimate`, `source-located`, …) and its test
expectations are not carried forward. Its recorded behavior is evidence of failure modes the
new system must not reproduce.

## 1. What the cards require

From the reference and the acceptance cases, the system must be able to:

1. Check a **claim** — not a number — against source text: population, comparator, outcome,
   timepoint, direction, magnitude, interval, p, unit, contributing sample, and the strength
   of the verb (causal vs associational) relative to the design.
2. Check the **whole card**: every primary result the source reports is present, before any
   secondary, component or subgroup result; a null primary is never obscured by a favorable
   secondary; two separately randomized trials are never ranked against each other; a
   secondary estimate is shown only with its outcome, certainty and relation to the primary.
3. Check **personalization**: each personal sentence cites profile items, and the connection
   type it makes (topic, population, method, practice, project-aim) is one those items can
   support.
4. Degrade **by failure type**: an estimate that fails its check is withheld while the
   independently checked conclusion stays (state A); a missing results section removes every
   results claim, attributed or not, and leaves background and methods (state B).
5. Admit **bounded design-based interpretation** ("residual confounding remains possible despite
   matching") with its basis recorded, and refuse over-scoped absences ("nothing was validated").
6. Never let attribution ("the authors report…") or number removal bypass a check.

## 2. Core change: the unit of verification is a claim

The old system verified a *quantity* (a number plus a quote) and let a separate model write
prose around whatever verified. That produced the recorded failures: the only verified number
became the headline (BASIL-2 death HR, cilostazol headache), and a correct number migrated
to the wrong outcome or population.

The replacement verifies a **claim**: a typed object asserting population, comparator,
outcome, timepoint, direction, estimate, language and role (see `src/acceptance/schema.js`).
Every non-null field is an assertion the verifier must **bind** to evidence. Prose is produced
*from* checked claims, never checked after the fact.

```
source text ──► evidence index (sections, sentences, outcome definitions, result sentences)
                         │
model ──► claim drafts ──► claim checker ──► claim results (pass / pass-qualitative / withhold / fail / excluded)
                         │
                         ├──► results inventory (what the source says its primaries are, and their results)
                         │
                         └──► fidelity checker (card vs inventory) ──► render plan ──► prose renderer ──► card
profile ──► personalization checker ──► personal lines shown / omitted
```

### 2.1 Evidence index (deterministic)

Built once per source, before any model call:

- **Sections** — abstract labels (BACKGROUND/METHODS/FINDINGS/INTERPRETATION, OBJECTIVE/…/RESULTS/
  CONCLUSIONS) and PMC body headings. Availability is recorded per section; a claim whose
  evidence must come from a section that is absent is `excluded`, which is how state B arises
  without any special casing.
- **Sentences** with offsets, normalized the same way quotes are (NFKC, dash and interpunct
  folding, whitespace). The old `normalize`/`extractNumbersWithIndex` in `pipeline/verify.js`
  do this correctly and are independently justified for reuse; the tier logic around them is
  not.
- **Outcome definitions** — sentences of the form "The primary outcome was …", "Primary
  outcomes were …", with the named outcomes and any timepoint and population qualifiers
  ("intention-to-treat", "4-year").
- **Arms and populations** — arm labels as the source prints them ("surgical group",
  "best endovascular treatment group", "medical-therapy group") and cohort/trial/subgroup
  labels ("cohort 1", "stenting trial", "PCB Grade 3", "bypass cohort").
- **Design** — randomized / observational / review, blinding, matching, registry, from
  explicit words in Methods. This feeds the language check (causal verbs need a randomized
  contrast) and the role check (what counts as the main result in a review).

### 2.2 Claim checker

For each claim, in order:

1. **Locate** the proposed evidence sentence(s). Not found → `fail` (`quote-not-located`).
   Found in a section marked unavailable → `excluded` (`section-unavailable`).
2. **Bind elements.** Each asserted field is matched against the located sentence plus the
   definitions the index links to it:
   - *population*: the sentence's cohort/trial/subgroup label, or the Methods population when
     the sentence carries none. A claim naming a broader population than the sentence binds to
     is `population-overgeneralized` (cohort 1 → "CLTI"; grade 3 → "peroneal runoff").
   - *comparator*: both arms must be printed in the sentence or its definition; a pair that
     was never randomized against each other (stenting vs endarterectomy across trials;
     bypass vs endovascular in a series that compared runoff vessels) is
     `comparator-not-randomized` / `comparator-unbound`.
   - *outcome*: must be the outcome the sentence reports or its linked definition. A
     component or different outcome named as the claimed one is `outcome-substituted`
     ("amputation" for the MALE-or-death composite; "stroke or death" for a composite whose
     stroke-or-death limb ends at day 44).
   - *timepoint*: as printed ("median 2.7 years", "4-year", "at 1 year").
   - *estimate*: measure word, value, interval bounds and label, p, unit, and sample
     (`n studies; n participants`) each matched to tokens in the sentence, in their roles. A
     bracket the source prints without a label binds only as `printed-bracket`; calling it a
     CI is `interval-label-invented`. An OR claimed as RR is `measure-mismatch`. A sample
     taken from the review's total rather than the pooled analysis is `sample-mismatch`.
   - *direction*: derived from the bound estimate and the sentence's verb. An interval
     including the null, or a non-significant P, supports only `no-clear-difference`;
     `equivalent` and `non-inferior` require an equivalence or non-inferiority test in the
     source (`equivalence-not-tested`). A direction claimed against the bound comparator
     orientation (RR 2.38 read as favoring medical therapy) is `direction-unsupported`.
   - *language*: `causal` requires a randomized contrast between the claimed arms;
     otherwise `causal-language-nonrandomized`. Randomized trials may use causal language
     **for the randomized strategy, population and outcome**; the generalization is what
     fails, through the population/comparator/outcome binds above (reference Card 6,
     variant 3).
3. **Attribution** changes nothing in steps 1–2. "The authors report X" is checked as X.
4. **Status.** All asserted elements bound → `pass` (estimate may print). No estimate asserted
   and qualitative elements bound → `pass-qualitative`. Qualitative elements bound but an
   estimate element unbound or contradicted → `withhold` (state A: the conclusion stays, the
   estimate does not). Any qualitative element unbound or contradicted → `fail`. Evidence in
   an unavailable section → `excluded`.

**Publication rule** (reference §Reference target): an estimate prints only from a `pass`.
There is no render state that prints a `withhold` estimate under a badge, and a
`pass-qualitative` in the same sentence does not promote the estimate.

**Absences and design-based limitations** (`basis: 'design'`) are checked for scope, not
location: the claim must name what is absent and the text it is absent from ("not reported in
the abstract"). An unscoped absence ("nothing was validated") is `absence-overscoped`. A design
inference is admitted when the design word it rests on is in the index (retrospective,
propensity-matched, open-label).

### 2.3 Results inventory and fidelity checker

The inventory is built from the evidence index, independently of the model:

- the primary outcome(s) as defined, with their cohort/trial split where the source has one
  (BEST-CLI's two cohorts, CREST-2's two trials, the Cochrane review's two primaries);
- for each, the result sentence(s) and the derived direction (favors / no clear difference /
  not reported / could not be pooled);
- secondary, component, subgroup and safety results, tagged by role from their own wording
  ("secondary", "post hoc", a subgroup label, a component of a defined composite).

The fidelity checker compares the card's claim set with the inventory:

| Condition | Reason code |
|---|---|
| A primary (or co-primary cohort/trial) in the inventory has no claim on the card | `primary-missing` |
| A secondary/component/subgroup claim precedes a primary claim | `primary-after-secondary` |
| The first effect claim is a component or secondary while a primary is null or absent | `component-as-headline`, `null-primary-obscured` |
| A claim compares arms from different randomizations | `cross-trial-ranking` |
| A secondary estimate lacks outcome name, certainty (where the source grades it) or a primary on the card | `secondary-without-context` |
| A supported-but-misleading emphasis (the tipping-point sentence placed as the lead limitation beside a null primary) | `null-primary-obscured` |

Fidelity is a property of the set and its order, so prose cannot satisfy it by rewording.

### 2.4 Personalization checker

Inputs: the stored profile as typed items (north-star, project, rubric, fact, editorial) and
the card's personal sentences, each with the item ids it rests on and a **connection type**.
Rules:

- `topic` — admissible for a north star whose topic overlaps the source's population or
  condition (deterministic concept overlap first; a model judgment only when the overlap is
  not lexical, and its verdict is recorded).
- `population` — the paper's population is one that a named program/role treats: requires a
  `fact` item (F1) in addition to the topical item.
- `method` — reusable for a project: requires the project item's text to name the method
  class or the rubric's "methodologically reusable" clause; must be conditional ("if it holds
  up elsewhere").
- `practice` — anything about the user's own patients, decisions or program activity:
  requires a `fact` item that states it; otherwise `practice-claim-without-fact`.
- `project-aim` — what a project is trying to do: requires the aim in the profile, not a
  name; otherwise `project-aim-asserted`.
- No item supports the connection → `no-supporting-item`; the line is omitted and the card
  still renders with no rank penalty (settled distinction 5).

Editorial items (E1 "landmark") may change the recommendation only (`recommendation.basis`
records the id); they can add no claim.

### 2.5 Render plan and failure effects on the displayed card

| Situation | Card |
|---|---|
| All checks pass | Full card: claims with estimates, personal lines, recommendation |
| A claim `fail`s | That claim is dropped; the writer is re-run with the inventory if the drop breaks fidelity |
| Primary estimate `withhold` (state A) | `reduced-estimate-withheld`: the conclusion sentence stays, no number, a one-line note that the size could not be confirmed; `mainResultShown: true` |
| Results section unavailable (state B) | `reduced-results-unavailable`: design, population, primary-outcome definition, design limitation; "main result not available to the app"; `mainResultShown: false`; no counts from Findings |
| Fidelity `fail` | Card is not shown as drafted; the writer is re-run with the inventory's primaries pinned first; if it still fails, the card falls back to the inventory's primary results stated qualitatively |
| Personal line `fail` | Line omitted; card unaffected |
| Editorial landmark present | `recommendation.read: 'full'` with basis E1; content unchanged |

### 2.6 Where the model sits

Two structured model calls, neither trusted:

1. **Claim drafting** — the model is given the evidence index (sections, outcome definitions,
   result sentences with offsets) and returns claims in the schema, each pointing at a
   sentence. It may not return prose numbers; numbers exist only inside `estimate`.
2. **Prose rendering** — the model turns the *checked* claim set and render plan into the
   card's sentences, each sentence tagged with the claim ids it renders. A deterministic
   pass rejects any sentence that carries a number not present in a `pass` claim it cites,
   a comparative or superlative not present in a claim, or a claim id whose status is not
   shown. Personal sentences carry item ids the same way.

The personalization checker's non-lexical topic judgment is a third, small call with a
recorded verdict.

## 3. Reuse from the existing code, with justification

| Module | Reuse? | Why |
|---|---|---|
| `pipeline/verify.js` — `normalize`, `extractNumbers`, `extractNumbersWithIndex`, `numbersEqual` | yes | Correct, tested text normalization and representation-equal number comparison; the new checker needs exactly this and nothing else from the file |
| `pipeline/verify.js` — tiers, `verify()`, version stamps | no | The quantity-at-a-time model and its taxonomy are what the replacement removes |
| `pipeline/evidenceContext.js` — `locateQuote` | yes, as the location primitive | Already handles the normalization; section awareness is added around it |
| `pipeline/sources.js` — PubMed/PMC fetch, `pmcSections`, `cleanAbstractText` | yes | Source acquisition is unchanged; `pmcSections` gives the section index for full text |
| `pipeline/primaryResult.js` | no | Its declared-primary matcher is the component whose strictness withheld whole cards; the inventory replaces it with a definition index plus result-sentence linkage, and a miss degrades to `primary-missing` on the card, not to no card |
| `pipeline/triage.js` number guard, `numberFree.js` | no | They repair prose after the fact; the renderer rejects rather than repairs |
| `pipeline/check.js` (model prose audit) | no as a gate | Fidelity is deterministic over the claim set; a model audit may remain as advisory telemetry |
| devset fixtures (`__fixtures__/devset/*.json`, `live-2026-10-12.json`) | source text only | Their `rows` and `recordedTake` are legacy evidence, read by the legacy suite, not by acceptance |

## 4. What is specified, executable, and demonstrated

| | State |
|---|---|
| Specified behavior | Reference cards (rev. 4) and the typed cases in `src/acceptance/cases/` |
| Executable tests | `npm run test:acceptance` — 7 case files, 103 tests, 6 `todo` for the unfilled diagnostic-validation category |
| Demonstrated results | None. `src/cards/assess.js` is a stub that throws; on 2026-10-13 the run was 103 failed / 6 todo, every failure "not implemented". The legacy suite (`npm test`, 2,210 passed) is unchanged and excludes the acceptance directory; lint adds no new diagnostics |

## 5. Open implementation questions (not editorial)

- Element binding for population and comparator needs a label vocabulary per paper (arm
  names, cohort names). The index derives it from Methods; abstracts that never name arms
  will bind only when the result sentence names them. Expect `comparator-unbound` to be the
  common failure on terse abstracts; that is the intended conservative behavior.
- The inventory's "role from wording" tagging is deterministic for labeled sentences
  ("secondary", "post hoc", "subgroup", a defined composite's component). Unlabeled
  secondary results in abstracts are tagged by position after the primary's sentence; this
  is a heuristic and is recorded as such in the inventory.
- Prose-renderer rejection needs the same number tokenizer as the checker; reuse is listed above.
