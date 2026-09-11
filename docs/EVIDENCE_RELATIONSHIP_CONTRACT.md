# Evidence relationship contract — 2026-09-11

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
