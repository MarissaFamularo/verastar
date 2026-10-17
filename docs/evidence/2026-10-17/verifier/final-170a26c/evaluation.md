# Verastar — final approved five-paper evaluation

Checkpoint: `170a26c92f13b7d2aabc1704b34c931efe0921be`. Started 2026-10-16T22:33:35.920Z; completed 2026-10-16T22:36:46.714Z.

## Outcome

All five papers completed their available pipeline stages. Ten real paid requests succeeded and settled; no provider errors or extraction retries occurred. Four findings summaries were withheld, and the sole displayed finding covered only a secondary endpoint. My source comparison rates none of the five as a complete useful summary of the supplied evidence. This is a small frozen development evaluation, not a general accuracy estimate or scientific validation. Do not release on these results.

44 quantities extracted; 19 received deterministic relationship-verified numeric verdicts; 10 context records were admitted. Only one finding rendered. Numeric verification and context admission are not semantic proof.

## Per-paper coverage

| PMID | Extracted | Numeric verified | Contexts admitted | Finding displayed |

|---|---:|---:|---:|---|

| 42513277 | 11 | 1 | 8 | No |

| 42769537 | 11 | 10 | 1 | Yes, secondary NACE only |

| 42573020 | 5 | 2 | 0 | No |

| 42681580 | 10 | 6 | 1 | No |

| 42600759 | 7 | 0 | 0 | No |

## Scope and limitations

The first two cases used their frozen body text; the final three were abstract-only. Source tables/figure-image text absent from those inputs were not invented or retrieved. The audit below compares with the actual supplied text, not unseen full papers. Whitespace-only matching is diagnostic analysis only: it was not used to modify the evaluated pipeline or its saved output.

## Exact displayed outputs and source comparison

### 42513277 — Impact of Postoperative Antithrombotic Treatment on Patency and Survival After Open Posterior Popliteal Artery Aneurysm Repair: A Multicenter Retrospective Cohort Analysis from the PARADE Study.

Findings withheld after the checker rejected whole-summary coverage; an appropriate observational-design caution was retained. The source reports conventional Cox survival HR 1.30 (CI 1.04–1.61), Fine–Gray patency-loss sHR 1.28, and an IPTW survival result with CI crossing 1 and robust log-rank P=.20. The displayed caution correctly preserves the survival-analysis conflict and absent bleeding data, but readers get none of the actual findings. The checker itself conflated Fine–Gray with IPTW log-rank qualifications and objected to “primary patency loss” despite that wording being printed in the source. These are checker-quality limitations, not evidence that the source result is unsupported.

**Exact displayed finding:**

[WITHHELD]

**Exact displayed design caution:**

Retrospective multicenter registry secondary analysis with antithrombotic therapy chosen at physician discretion, so confounding by indication is a major concern; the indication for therapy (such as atrial fibrillation or coronary disease) and bleeding outcomes were not captured. Subgroups were small, regimens heterogeneous, imaging surveillance non-standardized, and the authors label all analyses exploratory and hypothesis-generating. The weighted survival analysis gave conflicting significance between the standard and robust log-rank tests.

**Pipeline reason:** Result relationships or summary coverage were not approved.

Quote-location audit: `{"spans": 56, "exact": 56, "whitespaceOnlyMismatch": 0, "otherMissing": 0}`.

### 42769537 — Early Aspirin Discontinuation Following PCI for Acute Coronary Syndromes: A Systematic Review and Meta-Analysis of Reconstructed Individual Patient Data.

Only secondary NACE was displayed: HR 0.74, CI 0.63–0.88, P<.001, early aspirin cessation versus 12-month DAPT. Those numbers and the secondary endpoint status are source-grounded. However the summary omits the primary MACE result (HR 1.05, CI 0.83–1.32), the primary bleeding result, nonproportional hazards, and the preferred bleeding RMST estimate (3.06 additional bleeding-free days at 330 days; CI 1.91–4.21). It also omits explicit aspirin-withdrawal timing in the finding. The caution acknowledges missing primary outcomes but does not supply them. This is incomplete and potentially selective coverage, despite checker approval. Unsupported words in analysisRole labels rejected the main records; all their proposed quotes themselves were present exactly.

**Exact displayed finding:**

NACE: early aspirin cessation versus 12-month DAPT; reduced the risk of NACE. Analysis: reconstructed IPD pooled Cox model. Endpoint role: secondary end point. Estimate: 0.74 hazard ratio (CI 0.63–0.88), P<.001.

**Exact displayed design caution:**

Meta-analysis of five randomized trials using individual patient data reconstructed from published Kaplan-Meier curves, so patient-level subgroup analyses (such as high bleeding risk or complex PCI) were not possible. Four of the five trials had some risk-of-bias concerns, and most were open-label. Outcome definitions for ischemic events and bleeding differed across trials, and one trial used clopidogrel rather than a potent P2Y12 inhibitor. Discontinuation timing clustered around one month, so the optimal timing cannot be defined. Immediate aspirin withdrawal strategies were excluded. Net adverse clinical events are a secondary endpoint. The pooled analysis of net adverse clinical events used reconstructed data, and a separate random-effects pooling of published hazard ratios was less precise but pointed the same way. This estimate should be read alongside the primary ischemic and bleeding endpoints, which are not among the selected results.

**Pipeline reason:** Result relationships and the complete retained summary were checked by a model.

Quote-location audit: `{"spans": 64, "exact": 64, "whitespaceOnlyMismatch": 0, "otherMissing": 0}`.

### 42573020 — Drug-eluting balloon angioplasty versus uncoated balloon angioplasty for peripheral arterial disease of the lower limbs.

No finding or caution displayed. All 39 context quotes differ from the frozen source only in whitespace, so exact raw-source matching rejected all contexts. The source includes the null primary amputation result (OR 1.45, CI 0.91–2.29), improvements in target-lesion revascularization (OR 0.34) and binary restenosis (OR 0.29), null mortality/ABI results, and certainty/power limitations. None reached the displayed summary. This is a coverage failure caused by quote-format mismatch, not absence of scientific results.

**Exact displayed finding:**

[WITHHELD]

**Exact displayed design caution:**

[NONE]

**Pipeline reason:** Complete result context unavailable.

Quote-location audit: `{"spans": 39, "exact": 0, "whitespaceOnlyMismatch": 39, "otherMissing": 0}`.

### 42681580 — A Randomized Controlled Trial Evaluating Negative Pressure Therapy (NPT) to Reduce Wound Complications Following Major Lower Extremity Amputation.

No finding or caution displayed. Fifty of 53 context quotes differ only in whitespace. The sole admitted record was descriptive mortality and was numerically unverified; its selection could not produce an eligible plan. The source primary wound-complication comparison (19.4% versus 24%; RR 0.80, CI 0.51–1.26, P=.339), secondary outcomes, and explicitly post hoc subgroup findings were omitted. The source contains an internally discordant reoperation percentage/RR pair; the displayed output neither propagated nor resolved it because it displayed nothing.

**Exact displayed finding:**

[WITHHELD]

**Exact displayed design caution:**

[NONE]

**Pipeline reason:** Complete result context unavailable.

Quote-location audit: `{"spans": 53, "exact": 3, "whitespaceOnlyMismatch": 50, "otherMissing": 0}`.

### 42600759 — Quantification of Hemodynamic Changes and Wound Healing Following Transcatheter Arterialization of the Deep Veins (TADV) in No-Option Chronic Limb-Threatening Ischemia.

No finding or caution displayed. Single-arm contexts populated intervention but lacked comparator/effect, so they failed the complete-comparison rule instead of entering the descriptive path. Additional quote/label/numeric-expression failures occurred, and no numeric row passed the relationship verifier. Source results such as limb salvage 68.7% at one year, healed/healing status 75.5%, and waveform maturation were omitted. The supplied abstract does not establish comparative efficacy; no comparative benefit should be inferred.

**Exact displayed finding:**

[WITHHELD]

**Exact displayed design caution:**

[NONE]

**Pipeline reason:** Complete result context unavailable.

Quote-location audit: `{"spans": 27, "exact": 22, "whitespaceOnlyMismatch": 5, "otherMissing": 0}`.

