// pipeline/extract.js — structured extraction (Opus 4.8).
//
// The model's output surface is deliberately narrow: it may only emit
// (value, source_quote, location) tuples. There is NO schema field for a free-floating
// number, so the model literally cannot assert a quantity without attaching a receipt.
// Everything it returns is untrusted until verify.js re-derives it from source text.

import { extractStructured, MODELS } from '../lib/anthropic.js'

// Strict JSON schema per docs/FACTS.md, adjusted to the locked structured-output rules:
// every object has additionalProperties:false + required; optional fields are nullable
// via anyOf and listed in required (the API rejects properties-not-in-required patterns).
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['study_id', 'design', 'quantities'],
  properties: {
    study_id: { type: 'string' },
    design: {
      type: 'string',
      enum: [
        'RCT',
        'prospective_cohort',
        'retrospective_cohort',
        'meta_analysis',
        'single_arm',
        'case_series',
        'other',
      ],
    },
    quantities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'value', 'unit', 'ci_low', 'ci_high', 'p_value', 'source_quote', 'location_hint'],
        properties: {
          name: { type: 'string' },
          value: { type: 'number' },
          unit: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          ci_low: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          ci_high: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          p_value: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          source_quote: { type: 'string' },
          location_hint: { type: 'string' },
        },
      },
    },
  },
}

const SYSTEM = `You extract headline quantitative results from a biomedical paper into a strict schema.

Non-negotiable rules:
- source_quote MUST be copied VERBATIM from the provided source text — an exact
  substring, character for character. Do NOT paraphrase, re-punctuate, or "clean up"
  numbers. If the paper writes 0·84 with a middle dot, copy 0·84.
- Every number you put in value / ci_low / ci_high / p_value MUST appear inside its own
  source_quote. The quote is the receipt for the number.
- If you cannot find an exact supporting sentence, DO NOT include that quantity. Never
  invent a value, a confidence interval, or a citation. Omission is correct; fabrication
  is fatal.
- location_hint names where the quote is (e.g. "Results, primary outcome" or "Table 2").
- Extract the study's primary and key secondary effect estimates (hazard ratios, risk
  ratios, mean differences, proportions) — not every number in the paper.
- Order quantities by importance: the PRIMARY / headline effect estimate FIRST, then key
  secondary outcomes. The first item should be the number a clinician would quote.
- design is your best classification of the study design.

A downstream verifier will re-check every quote and number against the source text and
flag anything it cannot prove. Precision beats recall.`

// Extract quantities from source text. Returns the parsed object matching
// EXTRACTION_SCHEMA. Callers pass the result straight into verify.js — nothing here is
// trusted.
export async function extractQuantities({ studyId, sourceText, model = MODELS.extraction, maxTokens = 4096 }) {
  const content = `study_id: ${studyId}\n\nSOURCE TEXT:\n${sourceText}`
  const result = await extractStructured({
    model,
    system: SYSTEM,
    content,
    schema: EXTRACTION_SCHEMA,
    maxTokens,
  })
  // Guarantee study_id is set even if the model omitted it.
  if (!result.study_id) result.study_id = studyId
  return result
}
