# Evidence relationship contract — 2026-09-11

## Amendment 2026-10-04 — qualifiers, "and" pairs, recomputed proportions (`2026-10-04.estimates-v4`)

Three true printed values from a real digest that no rule admitted. Each is narrow, and
none changes what an existing tier claims:

- **Estimate qualifier.** The estimate tuple may carry a qualifier between the measure and
  its verb ("the pooled hazard ratio for the highest versus lowest frailty group was 1.81
  (95% confidence interval = 0.97-3.39 …)"), and the CI clause may use `=`. The qualifier
  must be plain description: no digit, no sentence punctuation, no verb (a verb means the
  match spanned a clause), and no second measure name (English "or" is allowed). Same tier,
  same "endpoint unchecked" claim.
- **"and" pair.** A `comparison` printed as "similar for A (x%) and B (y%)" verifies as
  `verified-comparison` only when both labels are supplied and each is printed directly
  before its own bracketed value, the span holds exactly two bracketed values, a comparison
  cue word ("similar", "compared", "higher" …) precedes the pair, and no CI or P is
  claimed. Without the cue, "mortality (5%) and stroke (3%)" stays unresolved.
- **New tier `verified-proportion`** ("Percentage recomputed from its count · endpoint
  unchecked"): a `single` percentage printed as "n of N (p%)" / "n out of N" / "n/N"
  verifies only when the app recomputes n/N and it rounds to the printed precision
  (109/117 = 93.16… → 93.2). Exactly one such tuple in the span; n ≤ N; no CI or P.
  `relationshipStatus: 'proportion-validated'`, `endpointValidated: false`.

I² and other heterogeneity statistics still have no rule. Tests:
`src/pipeline/verifyGaps.test.js` (5 controls, 17 false-verify guards). `estimates-v3`
verdicts remain readable as stamped (a subset). PaperTrellis's copy of the verifier was
not changed by this amendment.

## Amendment 2026-09-30 — two-group comparisons, AUC, plural ratio names (`2026-09-30.estimates-v3`)

- New tier `verified-comparison` ("Values verified as printed · groups unchecked"): a
  `comparison` quantity whose exact, unique prose span prints exactly one `A vs B` / `A versus B`
  pair, with the extraction's first and second values as its left and right numbers in that
  order. A claimed unit must be printed on the pair (right-hand value or its ± spread); a
  claimed P must be the one printed directly after it (`, P = .028`). Mean ± SD pairs are
  admitted; the spread is never a group value. Which groups and endpoint the values belong
  to is **not** validated (`endpointValidated: false`, `relationshipStatus:
  'comparison-validated'`). Withheld: two comparators in the span, any CI clause or claimed
  CI, words between a value and "vs", "compared with", negative values, range bounds,
  tables, fuzzy and repeated quotes, qualifier fields.
- A `comparison` may now omit both labels (the groups are usually named earlier in the
  sentence). Labels, when given, must still be exact substrings of the quote.
- The estimate tier admits AUC / AUROC / ROC-AUC / C-statistic / C-index tuples (unsigned,
  unitless) and plural ratio names ("adjusted HRs were 2.59 (95% CI: 1.34-4.98, p = 0.004)").

Earlier stamps (`2026-09-11`, `2026-09-24`, `2026-09-27`) remain readable as stamped.
Tests: `comparisonVerify.test.js` (4 controls, 19 false-verify guards) and additions to
`estimateVerify.test.js`, in both apps. On the 30 Sep digest, 4 of 11 extracted two-group
results verify; the rest are phrased without "vs", print two pairs in one quote, or carry
a paraphrased group label.

## Amendment 2026-09-27 — bracketed abbreviations, spelled-out numbers (`2026-09-27.estimates-v2`)

Two parser gaps found on a real digest, no change in what the estimate tier claims:

- A spelled-out ratio name may carry its bracketed abbreviation, and "confidence interval"
  may carry `[CI]`/`(CI)`: `hazard ratio [HR] 1.77, 95% confidence interval [CI] 1.03 - 3.02`.
  The abbreviation must belong to the same ratio family as the name (`hazard ratio [OR]` withholds).
- A value the source writes as a word (`eight achieved…`, `Seventy-nine percent`, integers
  0–99) moves from red `flagged` ("does not match the source") to amber `source-located`.
  It is never verified: a word is not a printed numeral.

`2026-09-24.estimates-v1` verdicts remain readable as stamped (a subset). PaperTrellis
mirrors both changes and the stamp. On the 26 Sep digest (63 extracted rows): verified
9 → 10, red flags 6 → 2, source-located 48 → 51.

## Amendment 2026-09-24 — printed ratio estimates (Verastar `2026-09-24.estimates-v1`)

Real Results sections print effects as `(HR, 0.44; 95% CI, 0.34-0.55; P < .001)`, so the
sentence grammar below withheld essentially every trial result. A new tier,
`verified-estimate` ("Estimate verified as printed · endpoint unchecked"), validates a
narrower claim: exactly one printed **ratio** tuple (HR/aHR/sHR, OR/aOR, RR/relative risk,
IRR/rate ratio) in an exact, unique prose span, whose value, CI bounds and (if claimed) P
equal the extraction in their stated roles. The span must contain exactly one CI clause.
A unit, if given, must name the same ratio family. Qualifier fields (population,
timepoint, endpoint, direction, unknown keys) withhold. Differences, tables, fuzzy quotes
and repeated spans stay unresolved.

What it does **not** prove: which endpoint, comparison, population or timepoint the tuple
belongs to. The verdict carries `relationshipValidated: true` (the value may be shown),
`endpointValidated: false`, `relationshipStatus: 'estimate-validated'`, and a reason naming
the source tier. Verdicts stamped `2026-09-11.relationships-v1` are still read as stamped
(their guarantees are a subset). PaperTrellis adopts the same amendment and stamp
(Publish_or_Perish `feat/estimate-tier`). Tests: `src/pipeline/estimateVerify.test.js` (8 controls, 22 false-verify guards).

This revision supersedes earlier descriptions that equated numeric-token coverage with
verified claim meaning. The version is `2026-09-11.relationships-v1` in both apps.

## Persisted and runtime fields

Each quantity carries a full `verdict`, including `verificationVersion`, `sourceLocated`,
`numericCoverage`, `relationshipValidated`, `relationshipStatus`, `sourceTier`, `tier`,
`flagged`, and the located source offsets. Historical `found` and `consistent` fields
remain aliases for source location and numeric coverage only. Neither proves a relationship.
`relationshipStatus` is `validated` or `unresolved`; old read-time verdicts are `unchecked`.

A located quote with complete numeric coverage but unresolved binding receives
`source-located`, `flagged: true`, and `relationshipValidated: false`. A missing quote,
invalid estimate shape, or absent numeric token remains `flagged`. Strong tiers require
`relationshipValidated: true` and a current verification stamp. Model review of prose or
manuscript citation support is a separate channel, not deterministic semantic proof.

## Deliberately bounded relationship validation

The validator matches a **complete, uniquely located prose sentence** against anchored
syntax. It checks the exact normalized endpoint name, unit, numeric order and arm labels.
Supported forms are `ENDPOINT was VALUE UNIT`, `ENDPOINT was VALUE UNIT in ARM and
VALUE UNIT in ARM`, `ENDPOINT ranged from VALUE UNIT to VALUE UNIT`, and
`ENDPOINT increased/decreased/changed from VALUE UNIT to VALUE UNIT`. Decimal and whitespace
normalization still apply. No nearest-label matching or model-agreement upgrade exists.

Flattened tables, fuzzy or partial sentences, repeated source spans, statistical tuples
(CI/P), different or absent endpoint names/units, and other prose formulations remain
unresolved. This intentionally withholds many *correct* complex claims; their source quote
and proposed extraction are retained for review. The stronger badge proves only the explicit
sentence relationship, not clinical applicability, primary-study attribution, population
interpretation outside that sentence, or a general semantic guarantee. Extraction must
retain source wording; it must never rewrite a quote to satisfy this grammar.

Registry upgrade additionally requires exact endpoint, unit, timepoint, population and all
numeric fields to agree. Missing identity cannot upgrade. Typical HR/CI/P tuples remain unresolved even when a registry row matches numerically.
Existing registry adapters do not supply complete identity and therefore withhold the registry tier; numerically matching an
unrelated posted endpoint no longer creates a stronger label.

## Stored work, displays and rollout

Verastar's extraction version is bumped; PaperTrellis's analysis version is 2. Every new
saved quantity retains its full verdict, including unresolved/rejected proposals. Original
source, annotation and other-app provenance are unchanged. Old verdicts are downgraded only
in runtime views to `legacy-unchecked`; no bulk extraction or paid migration occurs.
Daily digest restoration, saved evidence panels, the paper panel, exported notes and
PaperTrellis assistant context enforce the stamp. Source receipts remain available while
unresolved quantity assertions are withheld. Counts distinguish validated relationships.

Ship both frontend changes together and have users reload existing tabs: an already running
old browser bundle can continue presenting old stored badges under its old interpretation.
No database migration is required for these additive JSON fields. Rolling back the frontend
retains data but restores the unsafe old interpretation; it is not a safe verification
rollback. A rollback must keep the conservative rendering policy or withhold affected badges.

## Evaluation and withholding

The shared synthetic core contains 14 fixtures: 4 supported correct controls and 10 adverse
or unresolved cases. All 4 controls validate; all 10 other cases withhold the stronger tier.
The older verifier suite executes 44 verification calls: 0 relationship-validated, 24
source-located/unresolved, and 20 quote/numeric/shape failures. This is a substantial
withholding increase, especially for statistical tuples; source evidence remains readable.
The suite also contains normalization and plausibility utility tests outside those 44 calls.
Additional tests cover extra endpoint/population/timepoint/direction qualifiers, unknown fields,
registry identity, abstract provenance, normalized decimals, partial
sentence boundaries, numeric-source regressions, legacy read-time downgrades and save/export
round trips. These finite tests are regression evidence, not clinical validation or a
measured real-paper recall estimate. No real papers or paid model calls were processed.
