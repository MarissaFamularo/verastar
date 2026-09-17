import { describe, it, expect } from 'vitest'
import { specialtySlug, pickSeedRows, seedDue } from './seed.js'

describe('specialtySlug', () => {
  it('maps clinician self-descriptions onto the reference shelves', () => {
    expect(specialtySlug("I'm a vascular surgeon")).toBe('vascular-surgery')
    expect(specialtySlug('interventional cardiologist')).toBe('cardiology')
    expect(specialtySlug('general surgery resident')).toBe('general-surgery')
    expect(specialtySlug('nephrology')).toBe('general')
    expect(specialtySlug('')).toBe('general')
  })
})

describe('pickSeedRows', () => {
  const rows = [
    { specialty: 'general', pmid: '1', rank: 1 },
    { specialty: 'vascular-surgery', pmid: '2', rank: 2 },
    { specialty: 'vascular-surgery', pmid: '3', rank: 1 },
    { specialty: 'cardiology', pmid: '4', rank: 1 },
    { specialty: 'general', pmid: '3', rank: 5 }, // duplicate pmid across shelves
  ]
  it('takes the own shelf by rank, then general, without duplicates', () => {
    expect(pickSeedRows(rows, 'vascular-surgery').map((r) => r.pmid)).toEqual(['3', '2', '1'])
  })
  it('caps the total', () => {
    expect(pickSeedRows(rows, 'vascular-surgery', 2).map((r) => r.pmid)).toEqual(['3', '2'])
  })
  it('a general reader gets only the general shelf', () => {
    expect(pickSeedRows(rows, 'general').map((r) => r.pmid)).toEqual(['1', '3'])
  })
})

describe('seedDue', () => {
  const base = { signedIn: true, configured: true, profile: { onboarded: true }, paperCount: 0 }
  it('runs once, only for a signed-in onboarded account with an empty library', () => {
    expect(seedDue(base)).toBe(true)
    expect(seedDue({ ...base, signedIn: false })).toBe(false)
    expect(seedDue({ ...base, paperCount: 3 })).toBe(false)
    expect(seedDue({ ...base, profile: { onboarded: true, seededAt: 'x' } })).toBe(false)
    expect(seedDue({ ...base, profile: { onboarded: true, demo: true } })).toBe(false)
    expect(seedDue({ ...base, profile: { onboarded: false } })).toBe(false)
  })
})
