# Locked facts — API + data

*Authored 2026-07-07. Public knowledge and data contracts, not product code.*
*Trust these shapes over any training prior — old model IDs and params will 400.*

## Anthropic (bring-your-own-key, browser-direct)
- Client: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })` — the SDK sets the
  `anthropic-dangerous-direct-browser-access` header. `apiKey` comes from browser storage:
  sessionStorage by default, or localStorage after “Remember on this device” — never repo,
  file, IndexedDB, logs, or a server.
- Models: extraction → `claude-opus-4-8`; triage / onboarding interview →
  `claude-sonnet-5` or `claude-haiku-4-5`. No `claude-3-*`.
- Current models **reject** `temperature`, `top_p`, `top_k`, `budget_tokens` (400).
  Determinism comes from strict schema + deterministic verify, not sampling params.
- Structured output: `output_config: { format: { type: "json_schema", schema } }`.
  Schema rules: every object needs `additionalProperties:false` + `required`; no
  `minimum`/`maximum`/`minLength`/recursion; optional fields → nullable via `anyOf`.
- **Do not combine citations with `output_config.format`** (400). The hero click-to-
  source citation is therefore a **separate** API call from the structured extraction.
- Prompt caching: put the full-text document first with
  `cache_control:{type:"ephemeral"}`, volatile rubric/question after it → editing the
  rubric re-ranks at ~0.1× cost. Min cacheable prefix ~4096 tokens (full papers qualify;
  bare abstracts may not).

## Data endpoints (all CORS-open — send `Access-Control-Allow-Origin: *`, no proxy)
- PubMed search: `eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=…&retmode=json`
- Abstracts: `…/efetch.fcgi?db=pubmed&id=<pmids>&rettype=abstract`
- PMC full text (OA): `…/efetch.fcgi?db=pmc&id=<numeric PMCID>&rettype=xml` → parse
  `<body>`, strip tags. **No `<body>` ⇒ not in OA subset ⇒ abstract-only tier.**
- PMID → PMCID: `pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=<pmid>&format=json`
- **DOI → PMID** (live swing): `esearch.fcgi?db=pubmed&term=<doi>[AID]&retmode=json`.
  Not in PubMed at all ⇒ **CrossRef fallback**: `api.crossref.org/works/<doi>` for
  metadata + abstract → abstract-only tier. Worst case flags; never throws.
- Retractions: PubMed `esummary` publication type `Retracted Publication` is checked before
  digest selection and when the saved Library opens. Crossref `update-to` relations are not
  currently checked: the existing Crossref path is only a DOI metadata fallback for works with
  no PubMed record, so it cannot safely override PubMed status without a separate relation audit.
- CT.gov v2: `clinicaltrials.gov/api/v2/studies/<NCT>?fields=hasResults,resultsSection.outcomeMeasuresModule`
- Optional free NCBI API key (raises eutils 3→10 req/s) and contact email follow the same
  sessionStorage/localStorage “Remember on this device” choice as the Anthropic key.

## Digest slate selection
- PubMed returns a bounded newest-first pool per topic (`overfetchFor`, at most 100).
  Seen/saved PMIDs are removed before metadata or model work. All remaining resolvable,
  non-retracted papers are pre-scored against the rubric and mapped steering before the
  configured per-topic take is applied.
- The per-topic take keeps the highest pre-read scores; PubMed recency breaks exact score
  ties. A paper matching several topics is scored once, may win through several topics,
  and remains one candidate with every search attribution. The bounded scored pool is
  cached so a rubric re-rank can reapply topic caps without a new PubMed search.
- The abstract-aware screen applies its score floor before any slate allocation. Topic
  coverage never admits a paper below that floor.
- Among qualifying papers, selection repeatedly takes the highest-scoring paper that adds
  an uncovered search topic. One paper can cover multiple attributed topics. Remaining
  slots are filled in global score order; the post-read admission bar is unchanged.
- Rubric criteria score one paper at a time. Cross-candidate instructions such as “rank
  within each bucket” are executed by the deterministic coverage pass, not by the scorer.
- Explicit topics may carry `northStars: string[]`. Generated profiles require at least
  one exact top-level north-star name per topic. Manual or legacy topics may remain
  unmapped, but the editor flags each one and never guesses a semantic mapping.
- Candidate attribution carries both the search topic and its mapped north stars into the
  pre-read scorer and post-read relevance writer. A deleted mapping is shown as unmapped.
- Rubric prose is paper-level: it can use the current paper's metadata/abstract/design,
  mapped steering, north stars, projects, and editorial criteria. It cannot inspect saved
  library/history, schedule future monitoring, or allocate/compare across candidates.
  Clear cross-scope sentences receive non-blocking inline warnings and remain editable.
- Journal preferences are structured profile fields (`mustNotMiss` and `preferred`) and
  are passed once as compact scoring context rather than repeated in rubric prose. Existing
  rubrics are never changed silently: the migration preview accepts only exact verbatim
  journal-only spans, shows the shortened rubric, and requires an explicit Apply action.
- The editor displays rubric word count and warns above 250 words because the rubric is
  repeated in every scoring batch.
- Saved PubMed retractions are monitored separately when the Library opens. Topic coverage
  is allocated separately after paper scoring. Neither behavior is controlled by rubric text.
- Saved paper records retain the post-read fit score, relevance explanation, design caution,
  save entry point, and only non-flagged verified quantities. Library cards expose those
  values behind explicit summary/evidence controls; legacy records without a score simply
  omit the fit badge.

## Lookback coverage
- A successful search + screening pass writes a separate `daily:last-successful-scan`
  checkpoint. It is not advanced by a failed search or failed scoring pass, and clearing
  the transient `daily:latest` digest does not remove it.
- If calendar days since that checkpoint exceed the saved lookback, the digest offers a
  one-run window equal to the elapsed interval. The saved profile is unchanged and the
  seen ledger removes overlap. Catch-up is capped at 90 days; any earlier uncovered days
  are stated explicitly rather than implied to be recoverable.

## Demo corpus (public identifiers — the app re-verifies every value live)
| Paper | PMID / PMCID / registry | Demo role | Headline value |
|---|---|---|---|
| **BASIL-3** (BMJ 2024, CLTI endovascular) | 39993822 / PMC11848676 / ISRCTN | full-text click-to-source hero | HR 0.84 (97.5% CI 0.61–1.16, P=0.22) |
| **STARDUST** (JAMA Netw Open 2024, PAD) | 38470420 / PMC10933706 / **NCT04881110** | **registry hero** (`hasResults=true`) | TcPO2 diff 11.2 mmHg (95% CI 8.0–14.5, P<0.001) |
| **ACST-2** (Lancet 2021, carotid CAS vs CEA) | 34469763 / PMC8473558 / ISRCTN | carotid + full-text | RR 1.16 (95% CI 0.86–1.57, p=0.33) |

- CT.gov→outcome map (the one row the registry tier needs):
  `NCT04881110` → "Peripheral Transcutaneous Oxygen Pressure" → diff 11.2 mmHg (95% CI 8.0–14.5).
- UK trials register on **ISRCTN**, which has no CT.gov-style structured results — so the
  registry tier rides on STARDUST; the others land at full-text tier.
- Do **not** use BEST-CLI / BASIL-2 — not in PMC (NEJM/Lancet don't deposit), and
  BEST-CLI has `hasResults=false`.

## Extraction JSON schema (data contract)
```json
{ "type":"object","additionalProperties":false,
  "required":["study_id","design","quantities"],
  "properties":{
    "study_id":{"type":"string"},
    "design":{"type":"string","enum":["RCT","prospective_cohort","retrospective_cohort","meta_analysis","single_arm","case_series","other"]},
    "quantities":{"type":"array","items":{"type":"object","additionalProperties":false,
      "required":["name","value","range_low","range_high","unit","ci_low","ci_high","p_value","source_quote","location_hint"],
      "properties":{
        "name":{"type":"string"},
        "value":{"anyOf":[{"type":"number"},{"type":"null"}]},
        "range_low":{"anyOf":[{"type":"number"},{"type":"null"}]},
        "range_high":{"anyOf":[{"type":"number"},{"type":"null"}]},
        "unit":{"anyOf":[{"type":"string"},{"type":"null"}]},
        "ci_low":{"anyOf":[{"type":"number"},{"type":"null"}]},
        "ci_high":{"anyOf":[{"type":"number"},{"type":"null"}]},
        "p_value":{"anyOf":[{"type":"number"},{"type":"null"}]},
        "source_quote":{"type":"string"},"location_hint":{"type":"string"}}}}}}
```
Each quantity uses exactly one estimate shape: scalar `value`, or both
`range_low`/`range_high`. A reported estimate range is distinct from a confidence interval.
`design` drives the refuse-to-pool guard. `source_quote` + `location_hint` are inputs to
verify — trusted by nothing until matched against source text.
