import { beforeEach, describe, it, expect, vi } from 'vitest'

vi.mock('../lib/anthropic.js', () => ({
  extractStructured: vi.fn(),
  MODELS: { extraction: 'claude-sonnet-5' },
}))

import { extractStructured } from '../lib/anthropic.js'
import { EXTRACTION_SCHEMA, extractQuantities } from './extract.js'

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
      maxTokens: 4096,
      thinking: { type: 'disabled' },
    }))
  })
})
