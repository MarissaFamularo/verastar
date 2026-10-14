# Evidence relationship contract — 2026-09-11

## Amendment 2026-10-14 — token-boundary slices, folded glyphs, governed cues (`2026-10-14.estimates-v13`)

Pre-beta adversarial audit (`src/pipeline/betaAudit.verify.test.js`, 73 cases: 20 false
verifies and 5 crashes reproduced, then repaired). Every change refuses; nothing is
admitted that v12 refused.

- **Token-boundary slices.** Every non-sentence validator (estimate, bracket interval,
  comparison, "and" pair, proportion, heterogeneity) first requires the located quote to
  start and end on token boundaries of the FULL source. A quote that cuts a token
  ("5% vs 7%" inside "15% vs 7%", "…0.8-1.5" inside "…0.8-1.57", a dropped minus sign)
  earns no validated tier. v12 read the slice's own edges as boundaries.
- **Bare "or".** "or" counts as an odds ratio only where the full source opens a clause
  there (start of text, sentence end, or after `( [ ; :`); "10% or 0.10 (95% CI …)" quoted
  from "or" no longer verifies as an estimate.
- **Folded glyphs.** For verification only, a digit run glued to a superscript, subscript,
  circled digit or vulgar fraction ("10²", "1½") becomes a non-numeric placeholder in both
  quote and source, so 10² can never match 102 and 1½ never 11. The shared `normalize()`
  is unchanged so the prose guard still sees those digits.
- **European decimals.** A comma group led by a lone 0 ("0,847", "P = 0,001") is never
  rewritten as thousands.
- **Governed "and" pair cue.** The cue word must be the last cue before the first label,
  separated from it only by a short preposition run ("similar for", "compared with",
  "differed between"). "higher than expected, with mortality (5%) and stroke (3%)" is
  refused.
- **Numeric arm labels.** A `comparison` whose label itself contains a numeric token is
  refused: "men and 6 mg in women" could swallow another arm's value.
- **Heterogeneity P.** The P must end its clause in the full source (same rule as the
  estimate tier) and may not carry an exponent or scientific suffix ("1.2e-5").
- **Robustness.** `verify()` never throws: a null quantity, null options, a non-string
  `location_hint`, or an unreadable quote returns a flagged verdict.

**Read-time policy.** Because v13 refuses shapes every earlier stamp admitted,
`FULLY_COMPATIBLE_VERIFICATION_VERSIONS` is now empty: a v7–v12 validated verdict is
re-derived from saved source text where it exists (digest store and Library do this on
read) and shown as legacy-unchecked otherwise. Documented design limits that stay as they
are, under the badge's "groups / endpoint unchecked" caveat: SD or denominator read as a
group value, a range start as an operand, years as group values, swapped labels, an
estimate name not compared to the printed measure, an assumed effect in a sample-size
sentence, and I² as a Methods threshold (`[design-limit-N]` cases in the audit file).

**Prose guard, same day** (`src/pipeline/numberFree.js`, `triage.js`, `check.js`,
`lib/claimCheck.js`, `lib/digestStore.js`, `lib/evidenceVersion.js`; probes in
`src/pipeline/betaAudit.prose.test.js`): the nomenclature exemption refuses a statistic
glued to its label ("HR0.84", "OR0.5", "x2") while keeping names (TcPO2, P2Y12, COVID-19);
non-ASCII decimal digits are never grounded; the repair path reads the same normalized
tokens as the guard (full-width and circled digits no longer leak into relevance text); a
timepoint carries its unit, so "12 months" cannot back "12 days"; a duplicate checker
verdict can only refute; an unchecked claim is always labelled; a validated verdict must
also carry a validated tier; and a restored digest re-runs the number guard on each saved
finding against the rows validated now, withholding a sentence whose numbers were demoted.


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

**Same day, `2026-10-04.estimates-v6`** (v5 was a local-only build that refused any P on I²; v6 re-checks its verdicts): new tier `verified-heterogeneity` ("I² verified as
printed · analysis unchecked"). A `single` quantity whose name says I² / heterogeneity /
inconsistency verifies when its span prints exactly one "I² = x%" (NFKC "i2"; separator `=`,
`:`, `,`, "was", "of", "is" or a space), x is 0–100 and equals the value, and no CI is claimed.
A claimed P is accepted only when the span labels exactly one P as the heterogeneity test
("Cochran Q-test p = 0.003", "P for heterogeneity = …"); the pooled estimate's own P never
qualifies. τ² never matches. Which pooled analysis it describes is not checked. Tests in
the same file (3 controls, 8 guards); v4 stays readable.

**`2026-10-09.estimates-v7`** (candidate `2026-10-06`, repaired before integration): the
estimate tier binds a P printed after the CI's own bracket — "(aHR = 0.78 [95% CI:
0.70-0.86]; P < 0.001)". The bracket the P steps over must be the one opened directly before
the CI label. "(HR, 0.44; 95% CI, 0.34-0.55), P < .001 overall" still leaves its P unbound.
v7 also TIGHTENS every P binding, in the estimate and the "A vs B, P" comparison grammar: a
P binds only when it ends its clause in the full source — end of text, sentence end, or a
closing bracket not followed by another bracket, unless that bracket is a cross-reference
("(Table 2)", "[12]", "(Fig. 2A)"). "P = 0.02, for interaction", "P = 0.02;
interaction test", "P = 0.02 for trend" and "P = 0.02) (interaction test)" leave the P
unbound, and a quote truncated before the qualifier cannot hide it. v1–v6 bound several of
these. After a closing bracket and any cross-references, an explicit P-test qualifier
("…; P = 0.02) for interaction", "…) (Table 2) for trend", "…) (Table 2; P for
interaction)", "…) one-sided") leaves the P unbound, while a population qualifier ("(95% CI
1.34-4.98, p = 0.004) for eGFR 30-< 45") still binds, with the endpoint/population unchecked
as before (Codex R2 repair, same stamp — v7 was never deployed). Because this is a
tightening, older stamps stay readable only outside `TIGHTENED_TIERS` (verified-estimate,
verified-comparison): there they are re-derived from saved source text, or else shown as
legacy-unchecked. Tests: `src/pipeline/estimateBracketP.test.js`, `src/lib/evidencePolicy.test.js`.

Tests:
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
