import { describe, it, expect } from 'vitest'
import { pickOaPdf } from './openaccess.js'

describe('pickOaPdf', () => {
  it('returns the direct PDF url when the best OA location has one', () => {
    const data = {
      is_oa: true,
      best_oa_location: { url_for_pdf: 'https://www.bmj.com/content/372/bmj.n71.full.pdf', url: 'https://doi.org/x' },
    }
    expect(pickOaPdf(data)).toBe('https://www.bmj.com/content/372/bmj.n71.full.pdf')
  })

  it('returns null when the best OA location is only a landing page (no direct PDF)', () => {
    const data = { is_oa: true, best_oa_location: { url_for_pdf: null, url: 'https://doi.org/x' } }
    expect(pickOaPdf(data)).toBeNull()
  })

  it('returns null when the paper is not open access', () => {
    expect(pickOaPdf({ is_oa: false, best_oa_location: null })).toBeNull()
  })

  it('returns null when there is no best OA location', () => {
    expect(pickOaPdf({ is_oa: true, best_oa_location: null })).toBeNull()
  })

  it('does not throw on empty / malformed input', () => {
    expect(pickOaPdf(null)).toBeNull()
    expect(pickOaPdf(undefined)).toBeNull()
    expect(pickOaPdf({})).toBeNull()
  })
})
