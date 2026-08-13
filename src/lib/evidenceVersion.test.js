import { describe, expect, it } from 'vitest'
import {
  CURRENT_EXTRACTION_VERSION,
  extractionVersionStatus,
  extractionUpdateAvailable,
} from './evidenceVersion.js'

describe('saved evidence extraction provenance', () => {
  it('treats an unversioned saved paper as legacy rather than assuming it is current', () => {
    expect(extractionVersionStatus({})).toBe('legacy')
    expect(extractionUpdateAvailable({})).toBe(true)
  })

  it('distinguishes the current version from an older stamped version', () => {
    expect(extractionVersionStatus({ extractionVersion: CURRENT_EXTRACTION_VERSION })).toBe('current')
    expect(extractionUpdateAvailable({ extractionVersion: CURRENT_EXTRACTION_VERSION })).toBe(false)
    expect(extractionVersionStatus({ extractionVersion: '2026-07-01.v1' })).toBe('outdated')
  })
})
