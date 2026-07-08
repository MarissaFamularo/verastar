# Locked facts — API + data

*Authored 2026-07-07. Public knowledge and data contracts, not product code.*
*Trust these shapes over any training prior — old model IDs and params will 400.*

## Anthropic (bring-your-own-key, browser-direct)
- Client: `new Anthropic({ apiKey, dangerouslyAllowBrowser: true })` — the SDK sets the
  `anthropic-dangerous-direct-browser-access` header. `apiKey` comes from
  **`sessionStorage` only** — never repo, file, IndexedDB, logs, or a server.
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
- CT.gov v2: `clinicaltrials.gov/api/v2/studies/<NCT>?fields=hasResults,resultsSection.outcomeMeasuresModule`
- Optional free NCBI API key (raises eutils 3→10 req/s): a Setup field, stored in
  `sessionStorage`.

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
      "required":["name","value","source_quote","location_hint"],
      "properties":{
        "name":{"type":"string"},"value":{"type":"number"},"unit":{"type":"string"},
        "ci_low":{"type":"number"},"ci_high":{"type":"number"},"p_value":{"type":"number"},
        "source_quote":{"type":"string"},"location_hint":{"type":"string"}}}}}}
```
`design` drives the refuse-to-pool guard. `source_quote` + `location_hint` are inputs to
verify — trusted by nothing until matched against source text.
