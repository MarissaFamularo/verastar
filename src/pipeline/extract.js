// pipeline/extract.js — structured extraction (Opus 4.8).
//
// The model's output surface is deliberately narrow: it may only emit
// semantically typed quantitative tuples with a source_quote and location. There is NO schema field for a free-floating
// number, so the model literally cannot assert a quantity without attaching a receipt.
// Everything it returns is untrusted until verify.js re-derives it from source text.
// Two-number results remain distinguishable as a range, a change over time, or a comparison
// between labeled groups. Confidence intervals remain separate: they describe uncertainty
// around an estimate rather than the estimate's semantic shape.

import { extractStructured, MODELS } from '../lib/anthropic.js'

export const EXTRACTION_MAX_TOKENS = 8192
export const EXTRACTION_RETRY_MAX_TOKENS = 16384

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
        required: ['name', 'quantity_type', 'value', 'range_low', 'range_high', 'first_label', 'first_value', 'second_label', 'second_value', 'unit', 'ci_low', 'ci_high', 'p_value', 'source_quote', 'location_hint'],
        properties: {
          name: { type: 'string' },
          quantity_type: { type: 'string', enum: ['single', 'range', 'change', 'comparison'] },
          value: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          range_low: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          range_high: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          first_label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          first_value: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          second_label: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          second_value: { anyOf: [{ type: 'number' }, { type: 'null' }] },
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
- Copy a complete supporting sentence when available, retaining endpoint, units, groups,
  timepoints and population. Keep the name faithful to the endpoint and qualifiers.
  Never rewrite source text to fit a verification template. Matching numeric tokens is
  source-location evidence, not proof of the claim relationship.
- source_quote MUST be copied VERBATIM from the provided source text — an exact
  substring, character for character. Do NOT paraphrase, re-punctuate, or "clean up"
  numbers. If the paper writes 0·84 with a middle dot, copy 0·84.
- Every number you put in value / range_low / range_high / first_value / second_value / ci_low / ci_high / p_value MUST appear inside its own
  source_quote. The quote is the receipt for the number.
- A quantity must use exactly ONE estimate shape:
  - single: put the estimate in value. Set every range and first/second field to null.
  - range: put the two endpoints in range_low/range_high. Set value and every
    first/second field to null. Use this ONLY when the source describes a true span,
    interval, minimum-to-maximum range, or values across models. Never use it for two
    groups or two time points.
  - change: put the earlier value in first_value and the later value in second_value.
    If the quote names the time points or states, copy those exact labels into
    first_label and second_label (for example, "baseline" and "follow-up"); if it only
    says "increased from" or "decreased from", set both labels to null. Set value and
    range fields to null. The first/second order must always preserve earlier-to-later.
  - comparison: put each group value in first_value/second_value and copy the exact
    corresponding group labels from the quote into first_label/second_label. Preserve
    source order even if the second group is named first elsewhere. Set value and range
    fields to null.
  Any labels you supply must be non-empty exact substrings of source_quote, not inferred descriptions.
  A reported estimate range is NOT a confidence interval. Keep ci_low/ci_high for a CI
  explicitly identified as such by the source.
- Preserve the source's printed precision in source_quote. For example, copy "1.00" and
  "P=0.00" exactly even though the numeric schema fields necessarily encode them as 1
  and 0. A downstream formatter recovers the display spelling from this verbatim quote.
- If you cannot find an exact supporting sentence, DO NOT include that quantity. Never
  invent a value, a confidence interval, or a citation. Omission is correct; fabrication
  is fatal.
- location_hint names where the quote is (e.g. "Results, primary outcome" or "Table 2").
- Extract the study's primary and key secondary effect estimates (hazard ratios, risk
  ratios, mean differences, proportions) — not every number in the paper.
- Order quantities by importance: the PRIMARY / headline effect estimate FIRST, then key
  secondary outcomes. The first item should be the number a clinician would quote.
- design is your best classification of the study design.
- Do not silently repair statistically implausible results. Extract what the source
  prints verbatim; a deterministic downstream plausibility pass will warn separately.

A downstream verifier will re-check every quote and number against the source text and
flag anything it cannot prove. Precision beats recall.`

// Extract quantities from source text. Returns the parsed object matching
// EXTRACTION_SCHEMA. Callers pass the result straight into verify.js — nothing here is
// trusted.
export async function extractQuantities({ studyId, sourceText, model = MODELS.extraction, maxTokens = EXTRACTION_MAX_TOKENS, cacheKey = null }) {
  const content = `study_id: ${studyId}\n\nSOURCE TEXT:\n${sourceText}`
  let result
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      result = await extractStructured({
        model,
        system: SYSTEM,
        content,
        schema: EXTRACTION_SCHEMA,
        maxTokens: attempt === 1 ? maxTokens : Math.max(maxTokens, EXTRACTION_RETRY_MAX_TOKENS),
        thinking: { type: 'disabled' },
        purpose: 'extraction',
        cacheKey,
      })
      break
    } catch (err) {
      const retryable = err?.retryable === true || err instanceof SyntaxError || /json|parse|unexpected end|unterminated|truncat|incomplete structured/i.test(String(err?.message || ''))
      if (!retryable) throw err
      if (attempt === 2) {
        throw new Error('Claude could not finish extracting this paper after two attempts. Try this paper again later.')
      }
    }
  }
  // Guarantee study_id is set even if the model omitted it.
  if (!result.study_id) result.study_id = studyId
  return result
}
