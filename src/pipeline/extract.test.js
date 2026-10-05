import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../lib/anthropic.js', () => ({
  extractStructured: vi.fn(),
  MODELS: { extraction: 'claude-sonnet-5' },
}))

import { extractStructured } from '../lib/anthropic.js'
import {
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_RETRY_MAX_TOKENS,
  EXTRACTION_SCHEMA,
  extractQuantities,
  dropUnprovenLabels,
} from './extract.js'
import { verify } from './verify.js'

beforeEach(() => {
  vi.mocked(extractStructured).mockReset()
  vi.mocked(extractStructured).mockResolvedValue({ study_id: '123', design: 'other', quantities: [] })
})

describe('extraction quantity semantics', () => {
  const quantity = EXTRACTION_SCHEMA.properties.quantities.items

  it('requires a semantic type and fields for labeled two-value results', () => {
    expect(quantity.required).toEqual(expect.arrayContaining([
      'quantity_type', 'first_label', 'first_value', 'second_label', 'second_value',
    ]))
    expect(quantity.properties.quantity_type.enum).toEqual(['single', 'range', 'change', 'comparison'])
  })

  it('disables adaptive thinking so extraction JSON keeps the full output budget', async () => {
    await extractQuantities({ studyId: '123', sourceText: 'Abstract text.' })

    expect(extractStructured).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-5',
      maxTokens: EXTRACTION_MAX_TOKENS,
      thinking: { type: 'disabled' },
    }))
  })

  it('retries incomplete structured output once with a larger allowance', async () => {
    vi.mocked(extractStructured)
      .mockRejectedValueOnce(Object.assign(new Error('Claude structured output was incomplete.'), { retryable: true }))
      .mockResolvedValueOnce({ study_id: '123', design: 'other', quantities: [] })

    await expect(extractQuantities({ studyId: '123', sourceText: 'Abstract text.' })).resolves.toMatchObject({ study_id: '123' })

    expect(extractStructured).toHaveBeenCalledTimes(2)
    expect(extractStructured.mock.calls[0][0].maxTokens).toBe(EXTRACTION_MAX_TOKENS)
    expect(extractStructured.mock.calls[1][0].maxTokens).toBe(EXTRACTION_RETRY_MAX_TOKENS)
  })

  it('replaces a second parse failure with a controlled paper-level error', async () => {
    vi.mocked(extractStructured).mockRejectedValue(new SyntaxError('Unexpected end of JSON input'))

    await expect(extractQuantities({ studyId: '123', sourceText: 'Abstract text.' }))
      .rejects.toThrow('Claude could not finish extracting this paper after two attempts. Try this paper again later.')
    expect(extractStructured).toHaveBeenCalledTimes(2)
  })

  it('does not retry non-structured API failures', async () => {
    vi.mocked(extractStructured).mockRejectedValue(new Error('API credit balance is too low'))

    await expect(extractQuantities({ studyId: '123', sourceText: 'Abstract text.' }))
      .rejects.toThrow('API credit balance is too low')
    expect(extractStructured).toHaveBeenCalledTimes(1)
  })
})

// The quote rule in SYSTEM exists because of this verifier contract (2026-10-04, PMID
// 42829536): a sentence packing two "vs." pairs can never verify, so the extractor must
// cut one result per quote. If verify.js ever changes this, the prompt must change too.
describe('quote rule ↔ verifier contract', () => {
  const SRC = 'At 12 months, primary patency (67.3% vs. 50%, p = 0.16) and freedom from TLR (70.2% vs. 54.2%, p = 0.26) did not differ between treatment modalities, nor between femoral and popliteal access.'
  const q = (source_quote) => ({ name: '12-month primary patency', quantity_type: 'comparison', first_value: 67.3, second_value: 50, unit: '%', p_value: 0.16, source_quote })
  it('a packed sentence with two comparisons does not verify', () => {
    expect(verify(q(SRC), SRC, { sourceTier: 'full_text' }).relationshipValidated).toBe(false)
  })
  it('one result cut at its end, with its timepoint, verifies', () => {
    const v = verify(q('At 12 months, primary patency (67.3% vs. 50%, p = 0.16)'), SRC, { sourceTier: 'full_text' })
    expect(v.relationshipValidated).toBe(true)
    expect(v.relationshipStatus).toBe('comparison-validated')
  })
  it('the prompt states the rule', async () => {
    await extractQuantities({ studyId: '1', sourceText: SRC })
    const { system } = vi.mocked(extractStructured).mock.calls[0][0]
    expect(system).toMatch(/shortest contiguous span/)
    expect(system).toMatch(/ALWAYS extract\s+the primary outcome/)
  })
})

describe('dropUnprovenLabels — a group label the quote does not print cannot be proven', () => {
  const base = { name: '12-month primary patency, RA+DCB vs DCB alone', quantity_type: 'comparison', first_value: 67.3, second_value: 50, unit: '%', p_value: 0.16, source_quote: 'At 12 months, primary patency (67.3% vs. 50%, p = 0.16)' }
  const SRC = 'At 12 months, primary patency (67.3% vs. 50%, p = 0.16) and freedom from TLR (70.2% vs. 54.2%, p = 0.26) did not differ.'

  it('drops both labels when either is missing from the quote, so the row can verify unlabeled', () => {
    const q = { ...base, first_label: 'RA+DCB', second_label: 'DCB alone' }
    expect(verify(q, SRC).shapeError).not.toBe('')
    const fixed = dropUnprovenLabels(q)
    expect(fixed).toMatchObject({ first_label: null, second_label: null })
    expect(verify(fixed, SRC, { sourceTier: 'full_text' }).relationshipStatus).toBe('comparison-validated')
  })
  it('keeps labels the quote prints', () => {
    const q = { ...base, source_quote: 'patency was 67.3% with RA+DCB vs. 50% with DCB alone', first_label: 'RA+DCB', second_label: 'DCB alone' }
    expect(dropUnprovenLabels(q)).toBe(q)
  })
  it('leaves an unlabeled quantity untouched', () => {
    expect(dropUnprovenLabels(base)).toBe(base)
  })
})
