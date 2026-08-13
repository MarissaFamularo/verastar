import { describe, it, expect } from 'vitest'
import { EXTRACTION_SCHEMA } from './extract.js'

describe('extraction quantity semantics', () => {
  const quantity = EXTRACTION_SCHEMA.properties.quantities.items

  it('requires a semantic type and fields for labeled two-value results', () => {
    expect(quantity.required).toEqual(expect.arrayContaining([
      'quantity_type', 'first_label', 'first_value', 'second_label', 'second_value',
    ]))
    expect(quantity.properties.quantity_type.enum).toEqual(['single', 'range', 'change', 'comparison'])
  })
})
