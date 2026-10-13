# Verastar example cards — reference draft, revision 4 (2026-10-13)

Content-design reference for re-deriving the verifier and summaries. No code, parser,
deployment or model-run changes. Sources: saved development material in the repo, PubMed
metadata (identity only), and the Verastar profile stored for famularomarissa@gmail.com.

## How to read this document

Every evidence-map row carries three independent labels.

**Basis** (where the claim comes from):
- **S** — source finding: a located passage in the available text.
- **D** — design-based interpretation: a bounded inference whose basis is stated (the design named in the source, arithmetic on printed values, or an absence scoped to the text we have). Allowed without an author sentence saying the same thing.
- **P** — personalization: rests on a named profile item; the connection is ours.
- **E** — explicit editorial judgment supplied by the user for this document.

**Legacy app check** — the verdict the *old* verifier recorded for that row in the development run (`verified-estimate`, `verified-comparison`, `source-located`, "verified as printed bracket", or `not extracted` when it never made a row). This column documents limitations of the old verifier. It is not the reference judgment and not a proposed design; it does not determine what the new verifier should be able to support.

**Reference judgment** — what the intended verifier should conclude for the claim as written on the card, with the supporting evidence in the last column:
- `pass` — the relationships the claim depends on (treatment/comparator, outcome, units, estimate, interval, timepoint, population, contributing sample where stated) are all present in the located passage and must be checked against it.
- `pass (qualitative)` — a directional or design statement whose population, comparison, outcome and direction are checkable in the located passage; no estimate is claimed.
- `derived` — arithmetic or scoping on printed values; checkable against those values.
- `profile` — matched to a profile item by id; the connection is ours and is stated as such.
- `editorial` — supplied by the user; strengthens a recommendation only.
- `withhold` — the claim's relationships could not be checked in the scenario; the card must not print it.
- `excluded` — the source section is unavailable in the scenario; the card must not carry it.

**Removed material** is kept visible under two headings:
- **Removed — unsupported**: no basis in the available text or profile.
- **Removed — supported but misleading**: the passage is real and the sentence true, but it distorts the main result or the profile connection (summary-fidelity or personalization-support failure, not a claim-support failure).

Each card closes with the **three checks**: claim support (population, comparison, outcome, timepoint, direction, magnitude, uncertainty); summary fidelity (does the whole card preserve the main result); personalization support (does the profile justify the connection as stated). Misleading variants are labeled with the check they fail.

## Reference target versus failure behavior

- **Cards 1–5 describe the intended source-supported output.** Their legacy app checks document what the old verifier could and could not confirm; those verdicts do not bound the new verifier.
- **Card 4's walking-distance mean difference is part of the intended output.** The new verifier must check its treatment/comparator (cilostazol vs placebo), outcome (initial claudication distance), units (metres), estimate (26.49), interval (18.93–34.05), and contributing sample (six trials, 1,722 participants) against the source sentence. The legacy `source-located` verdict is a limitation of the old parser, not a reason to withhold.
- **Card 6 state A is an explicit verification-failure scenario:** the qualitative main conclusion passes (population, comparison, outcome, direction checked against Methods and Findings), but the numerical estimate does not. Withhold the estimate; retain the independently supported conclusion.
- **Card 6 state B is an evidence-availability failure:** the results are unavailable. Retain only supported background and methods.

**Publication rule.** An estimate may appear only after its relevant source relationships have been checked. Merely locating it, attaching an "unverified" badge, or confirming a qualitative conclusion in the same sentence is insufficient. This rule does not require preserving the old parser or its definition of "verified."

## Material and provenance

**Saved Development set** (`src/pipeline/__fixtures__/devset/`, 39 papers): 37 RCTs, 2 meta-analyses; PubMed abstract for 33, PMC full text for 6. No observational study, no methods or diagnostic-validation paper.

**2026-10-12 digest fixture** (`live-2026-10-12.json`). Cards 3 and 5 use it; **both are development examples, not held-out evaluation material.**

**Diagnostic-validation category: unfilled.** Card 5 is an observational paper that proposes a classification and does not count as coverage.

**Profile items** (verbatim from the stored profile, updated 2026-10-12):

| id | item |
|---|---|
| NS1 | CLTI limb preservation |
| NS3 | carotid stenosis management |
| P1 | Limb Preservation Program |
| P4 | Carotid stenosis Stroke Prediction |
| P5 | limb loss prediction |
| R | rubric: "Prioritize randomized controlled trials and papers that would change practice or spark conference discussion … flag anything methodologically reusable for ongoing projects" |
| F1 | fact stated outside the app profile: she is Medical Director of a Limb Preservation Program |
| E1 | editorial judgment for this document: BEST-CLI is a landmark trial |

NS2, NS4, NS5, NS6, P2, P3 are not used. Nothing about her case mix, procedures or project aims is assumed beyond the item text.

Identity confirmed via PubMed; DOIs listed per card.

---

## Card 1 — Positive randomized trial: BEST-CLI

PMID 36342173 · NEJM 2022 · doi 10.1056/NEJMoa2207899 · NCT02060630 · dev-set id PAD-10
Source used: **abstract only**. Condition exercised: intended output; all claims checkable in the abstract.

### Card

> **Surgery or endovascular therapy for CLTI (BEST-CLI)** — NEJM, 2022. International randomized trial, 1,830 patients with CLTI and infrainguinal disease, two parallel cohorts defined by conduit availability.
>
> In patients with a usable single-segment great saphenous vein (cohort 1), an initial surgical strategy led to fewer major adverse limb events or deaths than an initial endovascular strategy over a median 2.7 years (42.6% vs 57.4%; HR 0.68, 95% CI 0.59–0.79). In patients without adequate vein (cohort 2), the two strategies did not differ clearly (HR 0.79, 95% CI 0.58–1.06) over a median 1.6 years.
>
> **For you:** a randomized comparison of initial treatment strategy in CLTI, on your CLTI limb preservation north star and in the population a limb preservation program treats.
>
> **Temper it with:** the primary composite counts major reintervention alongside amputation and death, and the abstract does not separate them, so "fewer events" is not "fewer amputations." Cohort 2 was smaller and followed for less time; "similar" there means a difference was not shown, not that the strategies were shown equivalent.
>
> **Read it?** Yes, in full. The abstract carries the headline, but this is a landmark trial for the question, and the parts that decide how it transfers — the component outcomes, how vein adequacy was judged, crossover between strategies — are things to check in the full paper, not in the abstract.

### Evidence map

| Basis | Legacy app check | Reference judgment | Claim on card | Source / reasoning |
|---|---|---|---|---|
| S | not extracted | pass (qualitative) | 1,830 patients, CLTI with infrainguinal disease, two cohorts by conduit | "we enrolled 1830 patients with CLTI and infrainguinal peripheral artery disease in two parallel-cohort trials. Patients who had a single segment of great saphenous vein that could be used for surgery were assigned to cohort 1. Patients who needed an alternative bypass conduit were assigned to cohort 2." |
| S | `verified-estimate` (HR); `source-located` (percentages) | pass — comparator surgical vs endovascular, outcome primary composite, cohort 1, median 2.7 y, 42.6/57.4, HR 0.68, CI 0.59–0.79, direction | Cohort 1: 42.6% vs 57.4%; HR 0.68 (0.59–0.79); median 2.7 y; favors surgery | "In cohort 1, after a median follow-up of 2.7 years, a primary-outcome event occurred in 302 of 709 patients (42.6%) in the surgical group and in 408 of 711 patients (57.4%) in the endovascular group (hazard ratio, 0.68; 95% confidence interval [CI], 0.59 to 0.79; P<0.001)." |
| S | `verified-estimate` (HR) | pass — cohort 2, HR 0.79, CI 0.58–1.06, median 1.6 y, "not clearly different" | Cohort 2: HR 0.79 (0.58–1.06); median 1.6 y; not clearly different | "In cohort 2, a primary-outcome event occurred in 83 of 194 patients (42.8%) … and in 95 of 199 patients (47.7%) … (hazard ratio, 0.79; 95% CI, 0.58 to 1.06; P = 0.12) after a median follow-up of 1.6 years." |
| S | not extracted | pass (qualitative) | Composite includes major reintervention | "The primary outcome was a composite of a major adverse limb event - which was defined as amputation above the ankle or a major limb reintervention (a new bypass graft or graft revision, thrombectomy, or thrombolysis) - or death from any cause." |
| D | n/a | derived | Abstract does not separate components | Absence, scoped to the abstract. |
| D | n/a | derived | Cohort 2 smaller, shorter | 194 + 199 vs 709 + 711; 1.6 vs 2.7 years. |
| D | n/a | derived | Not shown different ≠ shown equivalent | CI 0.58–1.06 spans no effect and a cohort-1-sized benefit; no equivalence test reported. |
| P | n/a | profile | "On your CLTI limb preservation north star" | NS1. |
| P | n/a | profile | "The population a limb preservation program treats" | F1 plus the source population (CLTI needing revascularization). Says what such a program treats, not what hers does beyond that. |
| E | n/a | editorial | "Landmark trial for the question" | E1. Strengthens the reading recommendation; adds no finding. |
| D | n/a | derived | "Things to check in the full paper" | Phrased as questions; no claim that the full text contains them. |

**Removed — unsupported:** "largest randomized comparison"; "the first-revascularization choice your program makes."

### Misleading variants

1. *"Bypass is superior to endovascular therapy for CLTI."* — **Claim support** (population): drops the conduit condition.
2. *"Bypass cut the amputation rate by a third."* — **Claim support** (outcome): the composite is not amputation. Removing the number does not fix it.
3. *"Without usable vein, endovascular and surgical approaches are equivalent."* — **Claim support** (uncertainty): failure to show a difference is not equivalence.

---

## Card 2 — Inconclusive trial with a favorable secondary finding: CREST-2 (endarterectomy trial)

PMID 41269206 · NEJM 2025 · doi 10.1056/NEJMoa2508800 · PMC13148431 · dev-set id CAR-07
Source used: **full text** (saved fixture). Condition exercised: intended output; two trials in one paper, carried in paper order without comparison.

### Card

> **Revascularization plus intensive medical management vs intensive medical management alone for asymptomatic ≥70% carotid stenosis (CREST-2)** — NEJM, 2025. Two parallel observer-blinded randomized trials, one for stenting and one for endarterectomy, each against the same medical-management program.
>
> Stenting trial: adding stenting lowered the 4-year primary composite (stroke or death through day 44, then ipsilateral ischemic stroke to 4 years) from 6.0% to 2.8% (risk difference 3.2 percentage points, 95% CI 0.6–5.9). Endarterectomy trial: no significant difference in the same primary outcome, 5.3% vs 3.7% (risk difference 1.6 points, 95% CI −1.1 to 4.3; P=0.24). In both trials, ipsilateral ischemic stroke after the periprocedural period was less frequent in the revascularized group; for endarterectomy that is one component of a primary outcome that did not reach significance, not a substitute for it.
>
> **For you:** carotid stenosis management is a north star, and the medical-therapy arms report 4-year primary-composite rates under intensive medical management for asymptomatic ≥70% stenosis — a reference point for carotid risk stratification.
>
> **Temper it with:** the endarterectomy estimate is imprecise. Its confidence interval runs from a small harm to a benefit about the size of the stenting trial's, so the result neither shows nor excludes a benefit. Event counts were low in all groups, patients and treating physicians were unblinded, and medical therapy changed during the trial.
>
> **Read it?** Read the full paper. The one-line reading — stenting works, surgery doesn't — compares two separately randomized trials, which the design does not support; the authors note that event rates in the two revascularization groups appeared similar.

### Evidence map

| Basis | Legacy app check | Reference judgment | Claim on card | Source / reasoning |
|---|---|---|---|---|
| S | not extracted | pass (qualitative) | Two parallel observer-blinded trials, each vs IMM | "We conducted CREST-2, which comprised two parallel, observer-blinded trials: a stenting trial … and an endarterectomy trial …" |
| S | not extracted | pass (qualitative) | Asymptomatic, ≥70% | "eligible if they had no history of stroke, transient ischemic attack (TIA), or amaurosis fugax in the carotid artery territory within 180 days before randomization. Also required were stenosis of at least 70% …" |
| S | not extracted | pass (qualitative) | Primary outcome: stroke/death through day 44, then ipsilateral ischemic stroke to 4 years | "The primary outcome was a 4-year composite of any stroke (ischemic or hemorrhagic) or death, assessed from randomization to 44 days (periprocedural period), or ipsilateral ischemic stroke, assessed during the remaining follow-up period up to 4 years (postprocedural period)." |
| S | `source-located` (rates, RD); `verified-estimate` (RR 2.13, not shown) | pass — stenting trial, medical vs stenting, primary composite, 4 y, 6.0/2.8, RD 3.2, CI 0.6–5.9, direction | Stenting: 6.0% vs 2.8%; RD 3.2 (0.6–5.9) | "In the stenting trial, the 4-year rate of the composite primary outcome was 6.0% (95% confidence interval [CI], 3.8 to 8.3) in the medical therapy group and 2.8% (95% CI, 1.5 to 4.3) in the stenting group. The absolute risk difference was 3.2 percentage points (95% CI, 0.6 to 5.9; P=0.02)" |
| S | `source-located` (rates, RD); `verified-estimate` (RR 1.43, not shown) | pass — CEA trial, 5.3/3.7, RD 1.6, CI −1.1 to 4.3, P=0.24, "no significant difference" | CEA: 5.3% vs 3.7%; RD 1.6 (−1.1 to 4.3); P=0.24; no significant difference | "In the endarterectomy trial, the 4-year rate of the primary outcome was 5.3% (95% CI, 3.3 to 7.4) in the medical-therapy group and 3.7% (95% CI, 2.1 to 5.5) in the endarterectomy group. The absolute risk difference was 1.6 percentage points (95% CI, −1.1 to 4.3; P=0.24)" / "we found no significant difference in the 4-year incidence of primary-outcome events" |
| S | `verified-estimate` (RR 2.38) | pass (qualitative) — direction only shown | Postprocedural ipsilateral stroke less frequent after CEA | "in the endarterectomy group, 10 ischemic strokes occurred among 596 patients … annual event rate of 0.5% (95% CI, 0.3 to 1.0), with a relative risk of 2.38 (95% CI, 1.13 to 5.00)". RR is medical-vs-CEA; omitted to avoid inversion. |
| D | n/a | derived | "One component of the primary, not a substitute" | From the primary-outcome definition. |
| D | n/a | derived | CI "from a small harm to a benefit about the size of the stenting trial's" | −1.1 to 4.3 against the stenting trial's printed 3.2. |
| S | not extracted | pass (qualitative) | Low event counts | e.g. 9 periprocedural strokes in the CEA group; 10 postprocedural ipsilateral strokes in 596. |
| S | not extracted | pass (qualitative) | Unblinded; medical therapy changed | "First, although stroke adjudicators were unaware of the treatment assignments, patients and treating physicians were not. Second, various changes in medical-therapy practices occurred during the trials that could lower stroke rates …" |
| S | not extracted | pass (qualitative) | Not head-to-head; revascularization-group rates appeared similar | "The event rate among patients who had been assigned to a revascularization group appeared to be similar in the two trials (Fig. 2A)." |
| P | n/a | profile | "Carotid stenosis management is a north star" | NS3. |
| P | n/a | profile | "Medical-therapy arms report 4-year primary-composite rates … reference point for carotid risk stratification" | P4 read only as a project about stroke risk in carotid stenosis. Endpoint named as the primary composite; numbers not repeated in this line. |

**Removed — unsupported:** "the authors end by naming the open question your project is aimed at — which features predict benefit from revascularization." Stroke-risk prediction is not treatment-benefit prediction.

**Removed — supported but misleading:** the tipping-point sentence ("seven fewer events in the endarterectomy group, or six more in the medical group, would have made it significant") is printed and true; as the lead limitation it implied the null result was nearly positive. Summary-fidelity failure.

### Misleading variants

1. *"Endarterectomy does not reduce stroke in asymptomatic carotid stenosis."* — **Claim support** (direction/uncertainty).
2. *"Both stenting and endarterectomy cut long-term ipsilateral stroke by more than half."* — **Summary fidelity**: all numbers printed; the card leads with a component and loses the null CEA primary and the periprocedural events.
3. *"Stenting outperformed endarterectomy in CREST-2."* — **Claim support** (comparison): no head-to-head randomization.
4. *"Directly informs your project on who benefits from revascularization."* — **Personalization support**.
5. *"Medical therapy alone carried a 6% four-year stroke-or-death risk."* — **Claim support** (outcome/timepoint): the stroke-or-death limb of the composite ends at day 44.

---

## Card 3 — Observational study: retinal artery occlusion after CEA vs CAS

PMID 42854197 · Retina 2026 · doi 10.1097/IAE.0000000000005029 · no PMC · **development example**
Source used: **abstract only**. Condition exercised: intended output for an observational design; association language throughout.

### Card

> **Retinal artery occlusion after carotid endarterectomy vs carotid stenting** — Retina, 2026. Retrospective propensity-matched cohort from the TriNetX network, 2004–2026, 17,851 patients per group.
>
> After matching, stenting was associated with higher 1-year odds of retinal artery occlusion than endarterectomy (0.421% vs 0.257%; OR 1.64, 95% CI 1.12–2.41). Absolute rates were under half a percent in both groups, and most events were within 72 hours of the procedure. Stenting was also associated with higher odds of stroke and of death at 1 year.
>
> **For you:** carotid stenosis management is a north star; this is comparative data on an uncommon ocular complication of the two procedures.
>
> **Temper it with:** the choice between stenting and endarterectomy was not random, and residual confounding remains possible despite matching. The authors describe the findings as observational and pending prospective confirmation.
>
> **Read it?** Abstract is enough unless you are writing about or counseling on CAS complications. If you do open it, the things to check are how RAO was identified in the database and what the matched covariates were.

### Evidence map

| Basis | Legacy app check | Reference judgment | Claim on card | Source / reasoning |
|---|---|---|---|---|
| S | not extracted | pass (qualitative) | Design, network, dates, N per group | "Retrospective multicenter cohort study using the TriNetX Research Network (January 1, 2004-March 15, 2026). … Propensity score matching … yielded 17,851 patients per cohort." |
| S | verified (percentages and labelled OR, per `liveAbstracts.test.js`) | pass — CAS vs CEA, RAO, 1 y, 0.421/0.257, OR 1.64, CI 1.12–2.41, direction | RAO 0.421% vs 0.257%; OR 1.64 (1.12–2.41); 1 year; direction | "At 1 year, CAS was associated with higher risks of RAO (0.421% vs 0.257%; OR 1.64; 95% CI, 1.12-2.41)" |
| S | not extracted | pass (qualitative) | Most events within 72 h | "Most events occurred within 72 hours post-procedure." |
| S | verified (stroke percentages); unlabelled intervals refused | pass (qualitative) — direction only shown; figures withheld as secondary | Higher odds of stroke and death | "CAS also conferred higher odds of stroke (6.20% vs 4.43%; OR 1.42; 1.25-1.62) and mortality (6.41% vs 3.87%; OR 1.70; 1.54-1.88)." |
| S | not extracted | pass (qualitative) | Authors' hedge | "In this retrospective propensity-matched analysis … These observational findings … pending prospective confirmation." |
| D | n/a | derived | Not random; residual confounding possible despite matching | From the stated design. Bounded: "possible." |
| D | n/a | derived | "Under half a percent" | 0.421% and 0.257%. |
| P | n/a | profile | NS3 | P4 not cited: the stroke association is secondary and confounded. |

**Removed — unsupported:** "mortality gap larger than a procedure effect could plausibly produce"; "a scale no single center reaches."

### Misleading variants

1. *"Carotid stenting causes retinal artery occlusion."* — **Claim support** (design/direction).
2. *"CAS carried 70% higher mortality than CEA."* — **Summary fidelity** (secondary over primary) and **claim support** (OR reported as RR).
3. *"RAO is a common complication of stenting."* — **Claim support** (magnitude).

---

## Card 4 — Review: Cochrane, cilostazol for intermittent claudication

PMID 34192807 · Cochrane Database Syst Rev 2021 (update) · doi 10.1002/14651858.CD003748.pub5 · PMC8245159 · dev-set id PAD-05
Source used: **abstract only**. Condition exercised: intended output for a systematic review; the primary pooled estimate is part of the intended output even though the legacy verifier only located it.

### Card

> **Cilostazol for intermittent claudication** — Cochrane review, 2021 update. 16 double-blind randomized trials, 3,972 participants, treatment for 6–26 weeks.
>
> Against placebo, cilostazol lengthened initial claudication distance by about 26 metres (MD 26.49 m, 95% CI 18.93–34.05; six trials, 1,722 participants; low-certainty evidence) and roughly tripled the odds of headache (OR 2.83, 95% CI 2.26–3.55; eight trials; moderate certainty). Quality of life, the review's other primary outcome, could not be pooled. Too few trials reported amputation, revascularisation or cardiovascular events for any conclusion. Against pentoxifylline, no difference in walking distance was detected, from one trial (initial distance) and two (absolute distance).
>
> **Temper it with:** certainty was downgraded for every outcome because publication bias was strongly suspected, and one of the two primary outcomes has no pooled answer.
>
> **Read it?** Lower priority. The abstract carries the usable content; open the full review if you need the GRADE table for a guideline or teaching.

No personal line: no profile item covers claudication therapy. The card is still shown; the absence does not by itself lower its rank.

### Evidence map

| Basis | Legacy app check | Reference judgment | Claim on card | Source / reasoning |
|---|---|---|---|---|
| S | not extracted | pass (qualitative) | 16 RCTs, 3,972, 6–26 weeks | "We included 16 double-blind, RCTs (3972 participants) comparing cilostazol with placebo … Treatment duration ranged from six to 26 weeks." |
| S | `source-located` | **pass** — cilostazol vs placebo, initial claudication distance, metres, MD 26.49, CI 18.93–34.05, six studies, 1,722 participants, low certainty. All seven elements are in one sentence; the new verifier must check each. | ICD MD 26.49 (18.93–34.05); six trials; 1,722; low certainty | "Participants taking cilostazol had a higher ICD compared with those taking placebo (MD 26.49 metres; 95% CI 18.93 to 34.05; 1722 participants; six studies; low-certainty evidence)." |
| S | `verified-estimate` | pass — cilostazol vs placebo, headache, OR 2.83, CI 2.26–3.55, eight studies, moderate | Headache OR 2.83 (2.26–3.55); eight trials; moderate | "increased odds of experiencing headache … (OR 2.83; 95% CI 2.26 to 3.55; 2584 participants; eight studies; moderate-certainty evidence)." |
| S | not extracted | pass (qualitative) | QoL is a primary outcome; not pooled | "Primary outcomes were initial claudication distance (ICD) and quality of life (QoL)." / "We reported QoL measures descriptively due to insufficient statistical detail within the studies to combine the results" |
| S | not extracted | pass (qualitative) | No conclusions on serious events | "Very few studies reported on other outcomes so conclusions on revascularisation, amputation, or cardiovascular events could not be made." |
| S | `source-located` | pass (qualitative) — "no difference detected," study counts; estimates not shown | Pentoxifylline: walking distance only; one and two studies | "ICD (MD 20.0 metres, 95% CI -2.57 to 42.57; 417 participants; one study; low-certainty evidence); and ACD (MD 13.4 metres, 95% CI -43.50 to 70.36; 866 participants; two studies; very low-certainty evidence)" |
| S | not extracted | pass (qualitative) | Downgraded for publication bias | "The certainty of the evidence was downgraded by one level for all studies because publication bias was strongly suspected." |
| D | n/a | derived | "Roughly tripled the odds" | OR 2.83, stated as odds. |
| P | n/a | none | — | NS1 is CLTI; claudication is not CLTI. Omitted rather than stretched. |

**Removed — unsupported:** "Claudication sits upstream of CLTI limb preservation."

### Misleading variants

1. *"Cilostazol improves walking distance and quality of life."* — **Claim support** (outcome/certainty).
2. *"Cilostazol adds about 40 metres of walking."* — **Summary fidelity**: 39.57 m is printed and is a walking-distance result. It misleads when presented as *the* walking-distance result without naming the outcome (absolute distance), its certainty (very low), and its relation to the primary (26 m, low certainty). Stated with all three, it is admissible.
3. *"Cilostazol is safe and effective for claudication."* — **Claim support**: insufficient evidence on serious events.
4. The recorded Verastar take, leading with headache — **Summary fidelity**: the only legacy-verified number became the main result. This is the failure the reference target exists to prevent.

---

## Card 5 — Observational paper proposing a classification: peroneal communicating-branch grade

PMID 42855019 · J Vasc Surg 2026 · doi 10.1016/j.jvs.2026.10.003 · no PMC · **development example**
Source used: **abstract only**. Condition exercised: intended output for a retrospective series with a proposed classification and four named primary outcomes. **Does not fill the diagnostic-validation category.**

### Card

> **Single-vessel tibial runoff and peroneal communicating-branch quality in CLTI revascularization** — J Vasc Surg, 2026. Retrospective review of first-time CLTI revascularizations, 2005–2022; 732 patients with single-vessel runoff.
>
> Patients whose only runoff was the peroneal had higher adjusted risk of major amputation (HR 1.81 [1.04–3.13]) and of major adverse limb events than those with sole anterior or posterior tibial runoff. The authors propose a three-tier Peroneal Communicating Branch (PCB) grade, defined and evaluated in this cohort: patients with no robust communicating branch had the highest adjusted amputation risk (HR 3.21 [1.76–4.84]), while those with both branches and at least one robust one showed no difference in amputation or MALE from AT/PT runoff. No separate validation is reported in the abstract.
>
> **For you:** on your CLTI limb preservation north star, and a candidate anatomic variable for limb-loss prediction if it holds up elsewhere.
>
> **Temper it with:** the grade's performance comes from the cohort in which it was defined; the runoff groups differed in age, sex and diabetes; and the study names four primary outcomes.
>
> **Read it?** Worth reading if you are considering anatomic variables for a limb-loss model. Things to check in the full paper: how a branch was judged "robust," who graded, and whether agreement between graders was assessed. Otherwise the abstract suffices.

### Evidence map

| Basis | Legacy app check | Reference judgment | Claim on card | Source / reasoning |
|---|---|---|---|---|
| S | not extracted | pass (qualitative) | Design, period, N | "All patients undergoing first-time revascularization for CLTI were retrospectively reviewed (2005-2022) … Overall, 732 patients had single-vessel below-knee runoff: 225 AT, 315 peroneal, and 192 PT." |
| S | verified as printed bracket (abstract never says "CI") | pass — peroneal vs AT/PT, major amputation, adjusted HR 1.81, bracket 1.04–3.13, direction; the bracket is printed without a label and must be shown as printed | Peroneal: amputation HR 1.81 [1.04–3.13]; MALE higher; adjusted | "After adjustment, peroneal runoff was independently associated with higher risk of major amputation (HR 1.81 [1.04-3.13]) and MALE (HR 1.52 [1.03-2.25]) compared with AT/PT runoff." |
| S | not extracted | pass (qualitative) | Three-tier grade definitions | "a three-tiered, Peroneal Communicating Branch (PCB) Grade: Both branches present with at least one robust (PCB Grade 1), a single robust branch (PCB Grade 2), or no robust branch (PCB Grade 3)" |
| S | verified as printed bracket | pass — grade 3 vs AT/PT, major amputation, HR 3.21, bracket 1.76–4.84; grade 1 "no difference" | Grade 3 HR 3.21 [1.76–4.84]; grade 1 no difference | "patients without any robust branch (PCB Grade 3) had significantly higher risk of major amputation (HR 3.21 [1.76-4.84]) and MALE (HR 2.41 [1.53-3.79]), while those with two branches with at least one being robust (PCB Grade 1) … no difference in major amputation or MALE." |
| D | n/a | derived | "Defined and evaluated in this cohort" | Methods describe the grade and its application here; no derivation process asserted. |
| D | n/a | derived | "No separate validation is reported in the abstract" | Absence, scoped to the abstract. |
| S | not extracted | pass (qualitative) | Groups differed in age, sex, diabetes | "Groups differed significantly in age, sex, and diabetes prevalence." |
| S | not extracted | pass (qualitative) | Four primary outcomes | "Primary outcomes were wound healing, major amputation, major adverse limb events (MALE), and amputation/death" |
| P | n/a | profile | NS1, P5 | "Candidate anatomic variable" is our reading of P5's name; "if it holds up elsewhere" is the condition. |
| D | n/a | derived | "Things to check in the full paper" | Questions to bring to the full text. |

**Removed — unsupported:** "Nothing was validated"; "built and tested on the cohort that generated it."

### Misleading variants

1. *"A validated grading system identifies peroneal-runoff patients at high amputation risk."* — **Claim support**.
2. *"Peroneal-only runoff triples amputation risk."* — **Claim support** (population/magnitude): 3.21 is the grade-3 subgroup; peroneal overall is 1.81; association, not effect.
3. *"Peroneal-only runoff should push you toward bypass."* — **Claim support** (comparison): no treatment comparison made.
4. *"Directly relevant to your limb-loss prediction model."* — **Personalization support**.

---

## Card 6 — Reduced card: BASIL-2, two failure scenarios

PMID 37116524 · Lancet 2023 · doi 10.1016/S0140-6736(23)00462-2 · no PMC · dev-set id PAD-12
Source used: **abstract only**.

Legacy run: the old verifier confirmed only the all-cause-death HR; the primary-outcome row (adjusted HR 1·35 [1·02–1·80]) stayed `source-located`. The recorded take led with death and was refuted.

**Attribution and number removal do not bypass verification.** A qualitative conclusion printed on the card must itself be located and checked for population, comparison, outcome and direction, exactly as a number would be.

### State A — verification failure: qualitative main conclusion passes; numerical estimate does not

Condition exercised: the full abstract is available; by construction of the scenario the estimate's relationships are not confirmed. (With the intended verifier and this abstract, the HR sentence would be checkable and the estimate would print; state A describes the behavior when such a check fails.)

> **Vein bypass first vs best endovascular treatment first for CLTI requiring infra-popliteal revascularisation (BASIL-2)** — Lancet, 2023. Open-label pragmatic randomized trial, 345 patients, 41 centres in the UK, Sweden and Denmark, minimum two years' follow-up. Primary outcome: amputation-free survival (major amputation or death), intention-to-treat.
>
> Amputation-free survival was better with the best-endovascular-first strategy than with vein-bypass-first, a difference the authors attribute largely to fewer deaths in the endovascular-first group. The size of the difference could not be confirmed by the app, so no estimate is shown; read the Findings before quoting one.
>
> **For you:** CLTI limb preservation. A randomized comparison of initial treatment strategy for CLTI with below-knee disease.
>
> **Temper it with:** open-label, 345 patients, and a primary-outcome difference the authors say was driven mainly by deaths rather than amputations.
>
> **Read it?** Read it. The main result bears directly on the north star and the card cannot carry its size.

#### Evidence map — state A (full abstract available)

| Basis | Legacy app check | Reference judgment | Claim on card | Source / reasoning |
|---|---|---|---|---|
| S | not extracted | pass (qualitative) | Open-label pragmatic RCT; 41 centres; countries; ≥2 y follow-up | Methods: "BASIL-2 was an open-label, pragmatic, multicentre, phase 3, randomised trial done at 41 vascular surgery units in the UK (n=39), Sweden (n=1), and Denmark (n=1). … Participants were followed up for a minimum of 2 years." |
| S | not extracted | pass (qualitative) | 345 patients | Findings: "345 participants … were enrolled in the trial and randomly assigned" |
| S | not extracted | pass (qualitative) | Primary outcome, ITT | Methods: "The primary outcome was amputation-free survival defined as time to first major (above the ankle) amputation or death from any cause measured in the intention-to-treat population." |
| S | not extracted | pass (qualitative) — population, comparison (bypass-first vs endovascular-first), outcome (AFS), direction checked against Methods and Findings | Direction: endovascular-first better on AFS; authors attribute it largely to deaths | Interpretation: "a best endovascular treatment first revascularisation strategy was associated with a better amputation-free survival, which was largely driven by fewer deaths in the best endovascular treatment group." Findings: "Major amputation or death occurred in 108 (63%) of 172 patients in the vein bypass group and 92 (53%) of 173 patients in the best endovascular treatment group (adjusted hazard ratio [HR] 1·35 [95% CI 1·02-1·80]; p=0·037)." |
| S | `source-located` | **withhold** (scenario condition) | Adjusted HR 1·35 [1·02–1·80]; p=0·037 — not printed | Same Findings sentence. Under the publication rule, located-but-unchecked relationships are not enough; a qualitative pass in the same sentence does not license the estimate. |
| P | n/a | profile | NS1; "initial treatment strategy for CLTI with below-knee disease" | Restates the source population; no claim about her program. |

### State B — evidence-availability failure: results unavailable

Condition exercised: only the title, Background and Methods are available (what the checker saw in the legacy run). Every retained detail must come from those sections. No directional statement, attributed or not.

> **Vein bypass first vs best endovascular treatment first for CLTI requiring infra-popliteal revascularisation (BASIL-2)** — Lancet, 2023. Open-label pragmatic multicentre randomized trial at 41 vascular surgery units in the UK, Sweden and Denmark; participants followed for a minimum of two years. Primary outcome: amputation-free survival (major amputation or death), intention-to-treat.
>
> **Main result not available to the app.** The text available did not include the trial's results, so nothing about the outcome is shown here. Read the paper's Findings before repeating a takeaway.
>
> **For you:** CLTI limb preservation — a randomized comparison of initial treatment strategy for CLTI requiring infra-popliteal revascularisation.
>
> **Temper it with:** open-label design.
>
> **Read it?** Read it: a randomized trial on the north star whose result the app could not see.

#### Evidence map — state B (title, Background, Methods only)

| Basis | Legacy app check | Reference judgment | Claim on card | Source / reasoning |
|---|---|---|---|---|
| S | not extracted | pass (qualitative) | Open-label pragmatic multicentre RCT; 41 units; UK/Sweden/Denmark | Methods: "BASIL-2 was an open-label, pragmatic, multicentre, phase 3, randomised trial done at 41 vascular surgery units in the UK (n=39), Sweden (n=1), and Denmark (n=1)." |
| S | not extracted | pass (qualitative) | Minimum two years' follow-up | Methods: "Participants were followed up for a minimum of 2 years." |
| S | not extracted | pass (qualitative) | Population: CLTI requiring infra-popliteal revascularisation | Title and Background/Methods: "patients with chronic limb threatening ischaemia who required an infra-popliteal, with or without an additional more proximal infra-inguinal, revascularisation procedure" |
| S | not extracted | pass (qualitative) | Primary outcome, ITT | Methods sentence as in state A. |
| D | n/a | derived | "Main result not available"; "open-label" as the only limitation | Absence of a Findings section in the available text; design word from Methods. |
| P | n/a | profile | NS1 | As in state A. |
| — | — | excluded | 345 patients | Findings only. |
| — | — | excluded | Any direction, "driven by deaths," any estimate | Interpretation/Findings only. |
| — | — | excluded | Any statement about the Findings paragraph's length or content | Not available. |

**Removed — unsupported** (both states): "the question your program decides most often"; "the population is narrower than the title suggests" (the title specifies infra-popliteal revascularisation); "the Findings paragraph is short / one paragraph."

### Misleading variants

1. The recorded Verastar take: *"a vein-bypass-first strategy was associated with higher all-cause death than best-endovascular-first (adjusted HR 1·37, CI 1·00–1·87)."* — **Summary fidelity**: a secondary component headlined because it was the only legacy-verified number.
2. *"Endovascular-first is safer than bypass in CLTI."* — **Claim support** (population/outcome/uncertainty): infra-popliteal population only; "safer" is not the measured outcome; primary CI 1·02–1·80.
3. *"Bypass increases mortality."* — **Claim support**. Causal language is not prohibited for a randomized comparison; the failure is the unqualified generalization. The randomized contrast is bypass-*first* vs endovascular-*first*; the population is CLTI needing infra-popliteal revascularisation; the outcome is a secondary component with CI lower bound 1·00; the primary result is amputation-free survival. Supportable form: "In this trial, a vein-bypass-first strategy led to worse amputation-free survival than endovascular-first in patients needing infra-popliteal revascularisation, largely through deaths."
4. State B with an attributed direction (*"the authors conclude endovascular-first was better"*) — **Claim support**: attribution does not substitute for a located, checked sentence.
5. State A with the HR printed under an "unverified" badge — **Publication rule**: a badge does not substitute for checked relationships.

---

## Settled editorial distinctions

These apply to every card above and are given for the next derivation.

1. **Basis, legacy app check, and reference judgment are three separate labels.** Basis says where a claim comes from; the legacy column records what the old verifier did; the reference judgment says what the intended verifier should conclude, with its evidence. None implies another.
2. **Removed material is classified by failure type.** Unsupported (no basis) vs supported-but-misleading (true sentence, distorted whole). The second is a summary-fidelity or personalization-support failure, not speculation.
3. **Design-based limitations are allowed without an author sentence**, provided the basis is stated and the claim is bounded.
4. **Two-trial papers: paper order by default; both results always preserved.**
5. **No personal line: the card is still shown.** An absent personalization sentence does not by itself lower the rank.
6. **Landmark status may strengthen the reading recommendation.** It cannot add findings not in the available text, and it is never assigned by the model from familiarity, journal name, or in-paper "first/largest" language. In this document it comes only from the user (E1).
7. **Attribution and number removal never bypass verification.** A qualitative conclusion is located and checked on population, comparison, outcome and direction, or it is not printed.
8. **Publication rule for estimates.** An estimate appears only after its relevant source relationships (treatment/comparator, outcome, units, estimate, interval, timepoint, population, contributing sample where stated) have been checked. Location alone, an "unverified" badge, or a qualitative pass in the same sentence is insufficient. The rule does not require preserving the old parser or its definition of "verified."
9. **Reduced cards carry only what the available sections support.** A verification failure (state A) withholds the estimate and keeps the checked conclusion; an availability failure (state B) keeps background and methods only.
