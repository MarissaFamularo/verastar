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
} from './extract.js'

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
