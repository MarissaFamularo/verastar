# Card output review — what the current code renders for the six development examples

Generated 2026-10-14 from `src/cards/` at commit 225ef32 with the reference compositions in
`src/acceptance/cases/*.js` (the same inputs the end-to-end tests use). Nothing here is edited.

## What is hand-authored and what is generated

Hand-authored (inputs, in `src/acceptance/cases/*.js`):
- every claim: kind, role, and the **label strings** for population, comparator arms, outcome and
  timepoint; the estimate fields; the `text` of limitation / absence / certainty claims; the
  evidence quote
- the card composition: which claims, in which order
- personal items (`text`, items, connection type) and the profile
- `recommendation.read` ('full' for every card in the test harness)
- BASIL-2 state A "genuine": a deliberately wrong HR (1.36) to force the withhold

Generated (outputs of `assessCard` + `renderCard`):
- per-claim eligibility and reasons; fidelity, omissions; render state and display plan;
  personalization pass/fail; the editorial read route
- every sentence, from templates over checked fields: header (design word from the index,
  count, population), findings (arm order, verb, "better"/"lower rate", timepoint preposition,
  arm rates, estimate text), withheld and results-unavailable sentences, for-you prefix,
  temper lines, read line

Important consequence: the hand-authored label strings flow into the prose verbatim. The
checker binds them to the source; it does not generate them.

## Rendered cards (verbatim output)

```
==== C1-BESTCLI ====
state: full | mainResultShown: true | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): design[design/design], enrollment[count/design], primary-def[outcome-definition/primary], cohort1[effect/co-primary], cohort2[no-clear-difference/co-primary], components-not-separated[absence/design]
eligibility: design=pass-qualitative; enrollment=pass; primary-def=pass-qualitative; cohort1=pass; cohort2=pass; components-not-separated=pass-qualitative
personal: [{"id":"p-ns1","status":"pass","reasons":[]},{"id":"p-f1","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":["E1"]}
--- CARD ---
[header] Randomized trial, 1,830 patients, CLTI with infrainguinal peripheral artery disease.
[finding] In cohort 1: CLTI with a usable single segment of great saphenous vein, surgical led to a lower rate of primary composite: MALE or death than endovascular over a median 2.7 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79).
[finding] In cohort 2: CLTI needing an alternative conduit, surgical and endovascular did not differ clearly in primary composite: MALE or death over a median 1.6 years (42.8% vs 47.7%; HR 0.79, 95% CI 0.58–1.06).
[for-you] For you: on your CLTI limb preservation north star.
[for-you] For you: in the population a limb preservation program treats.
[temper] Primary outcome as defined: MALE (amputation above the ankle or major limb reintervention) or death from any cause.
[temper] Not reported in the available text: component outcomes (amputation, reintervention, death) separately.
[read] Read in full: marked as a landmark trial in your profile.

==== C2-CREST2 ====
state: full | mainResultShown: true | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): design[design/design], primary-def[outcome-definition/primary], stent-primary[effect/primary], cea-primary[no-clear-difference/primary], cea-postprocedural[effect/component], not-head-to-head[author-statement/design], limits[limitation/design], imprecise[limitation/design]
eligibility: design=pass-qualitative; primary-def=pass-qualitative; stent-primary=pass; cea-primary=pass; cea-postprocedural=pass-qualitative; not-head-to-head=pass-qualitative; limits=pass-qualitative; imprecise=pass-qualitative
personal: [{"id":"p-ns3","status":"pass","reasons":[]},{"id":"p-p4-risk","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Randomized trial, asymptomatic high-grade (≥70%) carotid stenosis.
[finding] In stenting trial, stenting plus intensive medical management led to a lower rate of primary composite than medical therapy alone at 4 years (risk difference 3.2 percentage points, 95% CI 0.6–5.9, P=0.02).
[finding] In endarterectomy trial, endarterectomy plus intensive medical management and medical therapy alone did not differ clearly in primary composite at 4 years (risk difference 1.6 percentage points, 95% CI -1.1–4.3, P=0.24).
[finding] In endarterectomy trial, endarterectomy plus intensive medical management was associated with a lower rate of ipsilateral ischemic stroke than medical therapy alone beyond 44 days.
[for-you] For you: carotid stenosis management is a north star.
[for-you] For you: medical-therapy arms report 4-year primary-composite rates — a reference point for carotid risk stratification.
[temper] Primary outcome as defined: stroke or death through day 44, then ipsilateral ischemic stroke to 4 years.
[temper] Limitation: unblinded patients and physicians; medical therapy changed during the trial.
[temper] Limitation: the endarterectomy CI runs from a small harm to a benefit about the size of the stenting trial's.
[read] Read in full.

==== C3-RAO ====
state: full | mainResultShown: true | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): design[design/design], primary-def[outcome-definition/primary], rao[effect/primary], timing[author-statement/design], secondary[effect/secondary], confounding[limitation/design]
eligibility: design=pass-qualitative; primary-def=pass-qualitative; rao=pass; timing=pass-qualitative; secondary=pass-qualitative; confounding=pass-qualitative
personal: [{"id":"p-ns3","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Study, adults undergoing CEA or CAS, propensity-matched, 17,851 per group.
[finding] In matched CEA and CAS cohorts, CEA was associated with a lower rate of retinal artery occlusion than CAS at 1 year (OR 1.64, 95% CI 1.12–2.41).
[finding] In matched CEA and CAS cohorts, CEA was associated with a lower rate of stroke; mortality than CAS at 1 year.
[for-you] For you: carotid stenosis management is a north star.
[temper] Primary outcome as defined: incidence of RAO.
[temper] Limitation: procedure choice was not random; residual confounding remains possible despite matching.
[read] Read in full.

==== C4-CILOSTAZOL ====
state: full | mainResultShown: true | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): included[design/design], primaries[outcome-definition/primary], icd[effect/primary], qol[absence/primary], headache[effect/safety], serious[absence/secondary], pentox[no-clear-difference/secondary], pubbias[certainty/design]
eligibility: included=pass-qualitative; primaries=pass-qualitative; icd=pass; qol=pass-qualitative(role-unverified); headache=pass; serious=pass-qualitative; pentox=pass-qualitative; pubbias=pass-qualitative
personal: [] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Randomized trial, stable intermittent claudication; 16 double-blind RCTs, 3,972 participants, 6–26 weeks.
[finding] In intermittent claudication (pooled RCTs), cilostazol led to better initial claudication distance than placebo (mean difference 26.49 metres, 95% CI 18.93–34.05).
[finding] In intermittent claudication (pooled RCTs), placebo led to a lower rate of headache than cilostazol (OR 2.83, 95% CI 2.26–3.55).
[finding] cilostazol and pentoxifylline did not differ clearly in initial claudication distance; absolute claudication distance.
[temper] Primary outcome as defined: initial claudication distance; quality of life.
[temper] Not reported in the available text: quality of life.
[temper] Not reported in the available text: revascularisation, amputation, cardiovascular events.
[read] Read in full.

==== C5-PCB ====
state: full | mainResultShown: true | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): design[design/design], primaries[outcome-definition/primary], differed[limitation/design], peroneal[effect/primary], grade-def[design/design], grade3[effect/subgroup], no-validation[absence/design]
eligibility: design=pass-qualitative; primaries=pass-qualitative; differed=pass-qualitative; peroneal=pass; grade-def=pass-qualitative; grade3=pass; no-validation=pass-qualitative
personal: [{"id":"p-ns1","status":"pass","reasons":[]},{"id":"p-p5-candidate","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Study, first-time CLTI revascularization, single-vessel runoff, 732 patients.
[finding] In single-vessel peroneal runoff, AT/PT runoff was associated with a lower rate of major amputation than peroneal runoff (HR 1.81, [1.04–3.13]).
[finding] In peroneal runoff with no robust communicating branch (PCB grade 3), AT/PT runoff was associated with a lower rate of major amputation than PCB grade 3 (HR 3.21, [1.76–4.84]).
[for-you] For you: on your CLTI limb preservation north star.
[for-you] For you: a candidate anatomic variable for limb-loss prediction if it holds up elsewhere.
[temper] Primary outcome as defined: wound healing; major amputation; MALE; amputation/death.
[temper] Limitation: groups differed in age, sex and diabetes.
[temper] Not reported in the available text: no separate validation is reported in the abstract.
[read] Read in full.

==== C6-BASIL2 — normal ====
state: full | mainResultShown: true | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): design[design/design], followup[design/design], population[population/design], primary-def[outcome-definition/primary], enrolled[count/design], primary[effect/primary], primary-qual[effect/primary], death[effect/component], open-label[limitation/design]
eligibility: design=pass-qualitative; followup=pass-qualitative; population=pass-qualitative; primary-def=pass-qualitative; enrolled=pass; primary=pass; primary-qual=pass-qualitative; death=pass; open-label=pass-qualitative
personal: [{"id":"p-ns1","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Randomized trial, 345 participants, CLTI requiring infra-popliteal revascularisation.
[finding] In CLTI requiring infra-popliteal revascularisation, best endovascular treatment first led to better amputation-free survival (major amputation or death) than vein bypass first (adjusted HR 1.35, 95% CI 1.02–1.8, P=0.037).
[finding] In CLTI requiring infra-popliteal revascularisation, vein bypass first and best endovascular treatment first did not differ clearly in all-cause death (adjusted HR 1.37, 95% CI 1–1.87).
[for-you] For you: CLTI limb preservation; initial treatment strategy for below-knee disease.
[temper] Primary outcome as defined: amputation-free survival (major amputation or death), intention-to-treat.
[temper] Limitation: open-label.
[read] Read in full.

==== C6-BASIL2 — stateA_genuine ====
state: reduced-estimate-withheld | mainResultShown: true | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): design[design/design], followup[design/design], population[population/design], primary-def[outcome-definition/primary], enrolled[count/design], primary[effect/primary], primary-qual[effect/primary], death[effect/component], open-label[limitation/design]
eligibility: design=pass-qualitative; followup=pass-qualitative; population=pass-qualitative; primary-def=pass-qualitative; enrolled=pass; primary=withhold(value-mismatch); primary-qual=pass-qualitative; death=pass; open-label=pass-qualitative
personal: [{"id":"p-ns1","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Randomized trial, 345 participants, CLTI requiring infra-popliteal revascularisation.
[finding] In CLTI requiring infra-popliteal revascularisation, best endovascular treatment first led to better amputation-free survival (major amputation or death) than vein bypass first; the size of the difference could not be confirmed by the app, so no estimate is shown.
[finding] In CLTI requiring infra-popliteal revascularisation, vein bypass first and best endovascular treatment first did not differ clearly in all-cause death (adjusted HR 1.37, 95% CI 1–1.87).
[for-you] For you: CLTI limb preservation; initial treatment strategy for below-knee disease.
[temper] Primary outcome as defined: amputation-free survival (major amputation or death), intention-to-treat.
[temper] Limitation: open-label.
[read] Read in full.

==== C6-BASIL2 — stateA_simulated ====
state: reduced-estimate-withheld | mainResultShown: true | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): design[design/design], followup[design/design], population[population/design], primary-def[outcome-definition/primary], enrolled[count/design], primary[effect/primary], primary-qual[effect/primary], death[effect/component], open-label[limitation/design]
eligibility: design=pass-qualitative; followup=pass-qualitative; population=pass-qualitative; primary-def=pass-qualitative; enrolled=pass; primary=withhold(estimate-unchecked); primary-qual=pass-qualitative; death=pass; open-label=pass-qualitative
personal: [{"id":"p-ns1","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Randomized trial, 345 participants, CLTI requiring infra-popliteal revascularisation.
[finding] In CLTI requiring infra-popliteal revascularisation, best endovascular treatment first led to better amputation-free survival (major amputation or death) than vein bypass first; the size of the difference could not be confirmed by the app, so no estimate is shown.
[finding] In CLTI requiring infra-popliteal revascularisation, vein bypass first and best endovascular treatment first did not differ clearly in all-cause death (adjusted HR 1.37, 95% CI 1–1.87).
[for-you] For you: CLTI limb preservation; initial treatment strategy for below-knee disease.
[temper] Primary outcome as defined: amputation-free survival (major amputation or death), intention-to-treat.
[temper] Limitation: open-label.
[read] Read in full.

==== C6-BASIL2 — stateA_noConclusion ====
state: reduced-estimate-withheld | mainResultShown: false | fidelity: pass [] | prose: all ok
inputs (hand-authored claims): design[design/design], followup[design/design], population[population/design], primary-def[outcome-definition/primary], enrolled[count/design], primary[effect/primary], death[effect/component], open-label[limitation/design]
eligibility: design=pass-qualitative; followup=pass-qualitative; population=pass-qualitative; primary-def=pass-qualitative; enrolled=pass; primary=withhold(estimate-unchecked); death=pass; open-label=pass-qualitative
personal: [{"id":"p-ns1","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Randomized trial, 345 participants, CLTI requiring infra-popliteal revascularisation.
[finding] In CLTI requiring infra-popliteal revascularisation, the main result for amputation-free survival (major amputation or death) could not be confirmed by the app; read the paper's results before repeating a takeaway.
[finding] In CLTI requiring infra-popliteal revascularisation, vein bypass first and best endovascular treatment first did not differ clearly in all-cause death (adjusted HR 1.37, 95% CI 1–1.87).
[for-you] For you: CLTI limb preservation; initial treatment strategy for below-knee disease.
[temper] Primary outcome as defined: amputation-free survival (major amputation or death), intention-to-treat.
[temper] Limitation: open-label.
[read] Read in full.

==== C6-BASIL2 — stateB ====
state: reduced-results-unavailable | mainResultShown: false | fidelity: pass ["no-declared-primary"] | prose: all ok
inputs (hand-authored claims): design[design/design], followup[design/design], population[population/design], primary-def[outcome-definition/primary], enrolled[count/design], primary[effect/primary], primary-qual[effect/primary], death[effect/component], open-label[limitation/design]
eligibility: design=pass-qualitative; followup=pass-qualitative; population=pass-qualitative; primary-def=pass-qualitative; enrolled=excluded(section-unavailable); primary=excluded(section-unavailable); primary-qual=excluded(section-unavailable,attribution-not-substitute); death=excluded(section-unavailable); open-label=pass-qualitative
personal: [{"id":"p-ns1","status":"pass","reasons":[]}] | recommendation: {"read":"full","basis":[]}
--- CARD ---
[header] Randomized trial, CLTI requiring infra-popliteal revascularisation.
[finding] Main result not available to the app: the text available did not include the results for amputation-free survival (major amputation or death), intention-to-treat; read the paper's results before repeating a takeaway.
[for-you] For you: CLTI limb preservation; initial treatment strategy for below-knee disease.
[temper] Primary outcome as defined: amputation-free survival (major amputation or death), intention-to-treat.
[temper] Limitation: open-label.
[read] Read in full.
```

## Comparison with the reference cards (meaning, usefulness, missing content)

### Cross-cutting (every card)
1. **Ratio orientation vs arm order.** The renderer names the favored arm first and keeps the
   source's ratio: "CEA was associated with a lower rate of RAO than CAS (OR 1.64)", "placebo
   led to a lower rate of headache than cilostazol (OR 2.83)", "AT/PT runoff … lower rate …
   than peroneal runoff (HR 1.81)", "best endovascular … better AFS than vein bypass (aHR 1.35)".
   Correct, prose-checked, and confusing to a clinical reader who expects the first-named arm
   to be the numerator. The reference always names the numerator arm ("stenting was associated
   with higher odds … OR 1.64").
2. **Checked content with no template is dropped silently.** `author-statement`, `certainty`,
   `population`, and any `design` claim after the first pass eligibility and render nothing:
   CREST-2 "not a head-to-head comparison", RAO "most events within 72 hours", cilostazol
   "publication bias strongly suspected", PCB the three-tier grade definition, BASIL-2 "41
   centres, minimum two years". Those are the reference cards' main temper and read-it points.
3. **Raw field echo.** "primary composite: MALE or death", "stroke; mortality", "initial
   claudication distance; absolute claudication distance", "In cohort 1: CLTI with …",
   "In stenting trial". Labels written for binding are printed as prose.
4. **Checked numbers not printed.** Contributing sample (six trials, 1,722 participants),
   certainty grades, and arm rates that are not in the claim's `arms` field (CREST-2 6.0% vs
   2.8%; RAO 0.421% vs 0.257%; BASIL-2 63% vs 53%) are bound or available but never shown.
5. **Design word.** "Randomized trial" for the Cochrane review (the abstract says RCTs);
   "Study" for the two observational papers (the reference says retrospective
   propensity-matched cohort / retrospective review).
6. **Read line.** Comes from the hand-authored `recommendation.read`, which the harness sets
   to 'full' for every card. RAO ("abstract is enough") and cilostazol ("lower priority")
   therefore disagree with the reference. Only the editorial-landmark route is generated.
7. **Interpretive temper is absent unless hand-written.** "Fewer events is not fewer
   amputations", "similar means a difference was not shown", "the grade's performance comes
   from the cohort in which it was defined" exist only as `limitation.text`, i.e. hand-authored
   prose passed through with number/direction checks only.

### Per card
- **BEST-CLI.** Facts match the reference (1,830; 42.6% vs 57.4%; HR 0.68; cohort 2 null; median
  follow-ups; definition; components not separated; landmark route). Missing: the cohort-2
  equivalence caution; the read-it reasons (components, vein adequacy, crossover); arm labels
  are bare ("surgical led to"). Two for-you fragments instead of one sentence.
- **CREST-2.** RD 3.2 and RD 1.6 with CIs and P are right; the component result is kept
  separate from the primary. Missing: the 4-year rates (6.0% vs 2.8%, 5.3% vs 3.7%); the
  sentence that the component "is not a substitute" for a null primary; the "two separately
  randomized trials, not head-to-head" caveat (passes, not rendered); "observer-blinded".
- **RAO.** Direction and OR correct but inverted in presentation (item 1). Missing: 0.421% vs
  0.257% (the reference prints them to show how rare the event is); "most events within 72
  hours"; "stroke and death" rendered as "stroke; mortality"; design words; read line wrong.
- **Cilostazol.** Header calls a Cochrane review a randomized trial. "Not reported in the
  available text: quality of life" misstates the source: QoL was reported descriptively and
  could not be pooled (the claim's `text` says so and is not rendered). Missing: sample and
  certainty per result; "from one trial (ICD) and two (ACD)"; publication-bias downgrade (the
  reference's only temper point); read line should be lower priority.
- **PCB.** Both HRs right; grade-3 sentence duplicates the population and the arm ("In
  peroneal runoff with no robust communicating branch (PCB grade 3), AT/PT runoff … than PCB
  grade 3"). Missing: the MALE result (not in the hand-authored card); the grade proposal
  itself (design claim, dropped); the grades 1–2 null; "defined and evaluated in this cohort".
  The validation absence reads as a double negative.
- **BASIL-2 normal.** Right facts; the HR orientation problem; "largely driven by fewer
  deaths" lost (the conclusions claim restates and is deduplicated, its text never printed);
  63% vs 53% not printed; centres and minimum follow-up dropped.
- **BASIL-2 state A (genuine and simulated).** Matches the reference behavior: direction from
  the independently checked conclusions sentence, no number, explicit "could not be confirmed".
  Missing the deaths attribution. **No-conclusion variant** correctly shows no direction.
- **BASIL-2 state B.** Matches the reference: methods-only header, explicit unavailability,
  definition kept, no count, no direction. Header lacks "41 units, UK/Sweden/Denmark, minimum
  two years" (design-claim rendering gap, not an eligibility gap: those claims pass).

## Smallest remaining step to drop hand-authored claims

Stage 2 of the design (claim drafting) is the only unimplemented stage. Everything downstream
runs unchanged on its output. The step:

1. `src/cards/draft.js`: one structured call through the existing `extractStructured` helper in
   `src/lib/anthropic.js` (Sonnet, thinking off, as the other structured calls do). Input: the
   index's numbered sentences with section labels, the definitions, arm and cohort labels, and
   the profile items (id, kind, text). Output schema: the `Claim` contract in
   `src/acceptance/schema.js` as an array, plus `personal` and `omissions`, with
   `evidence.sentence` as an index instead of a quote.
2. Map `evidence.sentence` → `index.sentences[i].text` to form the quote, pass the result to
   `assessCard` and `renderCard` as they are.
3. A script that runs the eight fixtures and prints what this file prints, so the drafted
   cards can be compared with these hand-authored ones claim by claim.

What it costs: about eight Sonnet calls per run; no paid run has been made so far and none
will be without approval. What stays hand-authored after it: the profile (by design) and the
read recommendation, which needs a rule of its own rather than a model field. What it will
expose: items 1–5 above get worse, not better, when a model writes the labels, because the
renderer prints labels verbatim and drops kinds it has no template for. Those are renderer
fixes inside the existing stages, not architecture changes, and they are the right thing to
settle after the first drafted output is in hand, not before.
