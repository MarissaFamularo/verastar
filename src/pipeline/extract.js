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
import { normalize } from './verify.js'

export const EXTRACTION_MAX_TOKENS = 8192
export const EXTRACTION_RETRY_MAX_TOKENS = 16384

// Strict JSON schema per docs/FACTS.md, adjusted to the locked structured-output rules:
// every object has additionalProperties:false + required; optional fields are nullable
// via anyOf and listed in required (the API rejects properties-not-in-required patterns).
// The schema is the shared contract (supabase/functions/_shared/extractionContract.js):
// typed quantities plus per-result quoted context spans.
export { EXTRACTION_SCHEMA } from '../../supabase/functions/_shared/extractionContract.js'
import { EXTRACTION_SCHEMA, validateWireExtraction } from '../../supabase/functions/_shared/extractionContract.js'
import { RESULT_CONTEXT_INSTRUCTIONS, normalizeResultContexts } from './resultHandoff.js'

const SYSTEM = `You extract headline quantitative results from a biomedical paper into a strict schema.

Non-negotiable rules:
- source_quote is ONE result's receipt. Copy the shortest contiguous span that holds
  that result with its endpoint, timepoint, groups and statistics. When a sentence
  reports one result, copy the whole sentence. When it packs several results together
  ("At 12 months, primary patency (67.3% vs. 50%, p = 0.16) and freedom from TLR
  (70.2% vs. 54.2%, p = 0.26) did not differ"), extract each as its own quantity and
  cut each quote at the end of that result: "At 12 months, primary patency (67.3% vs.
  50%, p = 0.16)". A quote holding two "vs." pairs or two confidence intervals cannot be
  verified, so it is wasted. Keep the name faithful to the endpoint, timepoint and
  qualifiers (e.g. "12-month primary patency, RA+DCB vs DCB alone"). Never rewrite
  source text to fit a verification template. Matching numeric tokens is
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
  When the quote does not print the group names (e.g. "primary patency (67.3% vs. 50%,
  p = 0.16)", with the groups named earlier in the paper), set BOTH labels to null and put
  the groups in name instead ("12-month primary patency, RA+DCB vs DCB alone").
  A reported estimate range is NOT a confidence interval. Keep ci_low/ci_high for a CI
  explicitly identified as such by the source.
- ci_low/ci_high belong ONLY to a single quantity, and only when the source prints that
  interval for the estimate you put in value. Never fill ci_low/ci_high on a comparison,
  change or range: an interval printed after two group values is the interval of the
  effect estimate beside it, not of the group values. In "(8.1% vs. 6.2%; hazard ratio,
  1.31; 95% CI, 0.84 to 2.04)" the interval belongs to the hazard ratio 1.31. If you
  extract both results, emit two separate quantities that may share the quote: a
  comparison (8.1, 6.2) with ci_low/ci_high null, and a single (value 1.31) with the
  interval. If you extract only the group values, leave ci_low/ci_high null. Never
  compute or infer an estimate the source does not print.
- A P value is never a quantity on its own. Fill p_value only beside an estimate the
  same quote prints (value, a range, or a first/second pair). When the source reports
  only a P value with no estimate ("an interaction was detected (P = 0.02)"), omit it.
  Never put a P value in value.
- Preserve the source's printed precision in source_quote. For example, copy "1.00" and
  "P=0.00" exactly even though the numeric schema fields necessarily encode them as 1
  and 0. A downstream formatter recovers the display spelling from this verbatim quote.
- If you cannot find an exact supporting sentence, DO NOT include that quantity. Never
  invent a value, a confidence interval, or a citation. Omission is correct; fabrication
  is fatal.
- location_hint names where the quote is (e.g. "Results, primary outcome" or "Table 2").
- Extract the study's primary and key secondary effect estimates (hazard ratios, risk
  ratios, mean differences, proportions) — not every number in the paper. ALWAYS extract
  the primary outcome's result when the source prints it, INCLUDING a null or
  non-significant one ("67.3% vs. 50%, p = 0.16"): a clinician needs the headline result
  whether or not it reached significance, and a significant secondary finding is never
  a substitute for it.
- Beyond the primary result, also cover clinically key outcomes the CURRENT study reports
  separately and prints with their own numbers: principal benefit and harm/safety outcomes
  (e.g. death, major bleeding, major adverse events), and the individually printed
  components of a composite primary endpoint. Prefer the current study's own results over
  background, literature or pooled prior work, and keep populations and timepoints
  distinct (e.g. ITT vs per-protocol, 30-day vs 12-month) in name. Only extract what is
  actually printed: never derive a value (a sentence saying an event occurred "equally in
  both groups" prints no two numbers), and do not try to extract every table row. When the
  same result is printed in several places, prefer one self-contained verbatim passage that
  spells out the measure and group labels over an abbreviated table cell or fragment;
  never rewrite source text to make it fit.
- Order quantities by importance: the PRIMARY / headline effect estimate FIRST, then key
  secondary outcomes. The first item should be the number a clinician would quote.
  Extra coverage must never come at the expense of the quote, CI and P rules above.
- design is your best classification of the study design.
- Do not silently repair statistically implausible results. Extract what the source
  prints verbatim; a deterministic downstream plausibility pass will warn separately.

A downstream verifier will re-check every quote and number against the source text and
flag anything it cannot prove. Precision beats recall.

${RESULT_CONTEXT_INSTRUCTIONS}`

// Exported read-only so the offline single-paper evaluation harness (src/eval/) sends the
// exact request extractQuantities sends.
export const EXTRACTION_SYSTEM = SYSTEM

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
        rawJson: true,
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
  // Validate the complete response before any caller can verify or save a quantity.
  // Outside the retry loop: invalid data is rejected, never repaired or retried.
  validateWireExtraction(result, studyId)
  result.result_contexts = normalizeResultContexts(result.result_contexts)
  return result
}

// Group labels are the model's claim about which value belongs to which group. A label
// the quote does not print cannot be proven, and verify.js rejects the whole row over it
// (the 2026-10-04 SFA paper lost its primary outcome this way). Drop BOTH labels when
// either is missing from the quote: the row then verifies, at most, as an unlabeled
// comparison, which the verdict and badge already mark "groups unchecked". This only ever
// removes an unproven claim; it never adds one. Applied in the pipeline right before
// verify, so cached extractions get it too.
export function dropUnprovenLabels(quantity) {
  const first = quantity?.first_label
  const second = quantity?.second_label
  if (first == null && second == null) return quantity
  const quote = normalize(quantity.source_quote || '')
  const printed = (label) => {
    const l = normalize(label || '')
    return l.length > 0 && quote.includes(l)
  }
  if (printed(first) && printed(second)) return quantity
  return { ...quantity, first_label: null, second_label: null }
}
