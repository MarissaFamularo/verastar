import { describe, it, expect } from 'vitest'
import { pickOaLink, oaPatch } from './openaccess.js'

describe('pickOaLink', () => {
  it('prefers the direct PDF url when the best OA location has one', () => {
    const data = {
      is_oa: true,
      best_oa_location: { url_for_pdf: 'https://www.bmj.com/content/372/bmj.n71.full.pdf', url: 'https://doi.org/x' },
    }
    expect(pickOaLink(data)).toEqual({ url: 'https://www.bmj.com/content/372/bmj.n71.full.pdf', isPdf: true })
  })

  it('keeps a landing-page-only location, flagged as not-a-PDF (gold OA without url_for_pdf)', () => {
    const data = { is_oa: true, best_oa_location: { url_for_pdf: null, url: 'https://doi.org/x' } }
    expect(pickOaLink(data)).toEqual({ url: 'https://doi.org/x', isPdf: false })
  })

  it('returns null when the paper is not open access', () => {
    expect(pickOaLink({ is_oa: false, best_oa_location: null })).toBeNull()
  })

  it('returns null when there is no best OA location or it has no urls at all', () => {
    expect(pickOaLink({ is_oa: true, best_oa_location: null })).toBeNull()
    expect(pickOaLink({ is_oa: true, best_oa_location: { url_for_pdf: null, url: null } })).toBeNull()
  })

  it('does not throw on empty / malformed input', () => {
    expect(pickOaLink(null)).toBeNull()
    expect(pickOaLink(undefined)).toBeNull()
    expect(pickOaLink({})).toBeNull()
  })
})

describe('oaPatch', () => {
  it('routes a direct PDF to pdfUrl and a landing page to oaUrl', () => {
    expect(oaPatch({ url: 'https://host/x.pdf', isPdf: true })).toEqual({ pdfUrl: 'https://host/x.pdf' })
    expect(oaPatch({ url: 'https://doi.org/x', isPdf: false })).toEqual({ oaUrl: 'https://doi.org/x' })
  })

  it('returns null for a missing link', () => {
    expect(oaPatch(null)).toBeNull()
    expect(oaPatch({ url: '', isPdf: true })).toBeNull()
  })
})
