// supabase/functions/_shared/extractionContract.js — the quoted-span extraction contract
// shared by the browser pipeline, the model proxy and the scheduled digest bundle.
// Reconstructed from checkpoint 170a26c (docs/evidence/2026-10-17/verifier/final-170a26c)
// with one addition: `conflictingAnalyses`, a per-result list of passages where another
// analysis of the same outcome reaches a different conclusion. The wire representation
// keeps every optional field as an array of zero or one span (the provider does not
// compile nullable unions reliably); saved records use null-or-span.
import { compileExtractionSchema, ExtractionValidationError } from './validateExtractionSchema.js'
export const CONTEXT_FIELDS = ['outcome', 'intervention', 'comparator', 'analysis', 'interventionTiming', 'outcomeTimepoint', 'endpointRole', 'analysisRole', 'effect']
// Multi-span lists on a context. Absent on records written before this contract: a reader
// treats a missing list as empty, never as malformed.
export const CONTEXT_LISTS = ['qualifications', 'conflictingAnalyses']
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties })
const string = { type: 'string' }
export const SPAN_SCHEMA = object({ text: string, quote: string, corpus: { type: 'string', enum: ['text', 'tables'] } })
export const RESULT_CONTEXT_SCHEMA = object({
  quantity_index: { type: 'integer' },
  // Provider supports minItems 0/1, not maxItems. Cardinality stays strict locally.
  ...Object.fromEntries(CONTEXT_FIELDS.map(key => [key, { type: 'array', minItems: 0, items: SPAN_SCHEMA }])),
  qualifications: { type: 'array', items: SPAN_SCHEMA },
  conflictingAnalyses: { type: 'array', items: SPAN_SCHEMA },
})
export const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['study_id', 'design', 'quantities', 'result_contexts'],
  properties: {
    study_id: { type: 'string' },
    result_contexts: { type: 'array', items: RESULT_CONTEXT_SCHEMA },
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

export const EXTRACTION_CACHE_FORMAT = 'extraction-wire-v2'
const validate = compileExtractionSchema(EXTRACTION_SCHEMA)
export function validateWireExtraction(value, studyId) {
  validate(value)
  if (value.study_id !== String(studyId)) throw new ExtractionValidationError(['study_id: does not match requested paper'])
  const seen = new Set()
  for (const context of value.result_contexts) {
    const index = context.quantity_index
    if (index < 0 || index >= value.quantities.length || seen.has(index)) throw new ExtractionValidationError(['quantity_index: invalid or duplicate reference'])
    seen.add(index)
    for (const key of CONTEXT_FIELDS) if (context[key].length > 1) throw new ExtractionValidationError([key + ': expected zero or one span'])
    for (const span of [...CONTEXT_FIELDS.flatMap(key => context[key]), ...CONTEXT_LISTS.flatMap(key => context[key])]) {
      if (!span.text.trim() || !span.quote.trim()) throw new ExtractionValidationError(['empty context span'])
    }
  }
  return value
}
// A trusted cache row holds an explicit envelope. Untagged, mixed, malformed or foreign-paper
// records are refused (the caller treats a refusal as a miss).
export function cacheWireExtraction(envelope, studyId) {
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'format,value' || envelope.format !== EXTRACTION_CACHE_FORMAT) throw new ExtractionValidationError(['unsupported cache representation'])
  return validateWireExtraction(envelope.value, studyId)
}
export function encodeCachedExtraction(normalized, studyId) {
  // Explicit normalized -> wire conversion, never infer a representation from shape.
  const value = { ...normalized, result_contexts: (normalized.result_contexts || []).map(context => ({
    quantity_index: context.quantity_index,
    ...Object.fromEntries(CONTEXT_FIELDS.map(key => [key, context[key] == null ? [] : [context[key]]])),
    ...Object.fromEntries(CONTEXT_LISTS.map(key => [key, Array.isArray(context[key]) ? context[key] : []])),
  })) }
  validateWireExtraction(value, studyId)
  return { format: EXTRACTION_CACHE_FORMAT, value }
}
