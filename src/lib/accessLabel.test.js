import { describe, it, expect } from 'vitest'
import { savedKeyLabel } from './accessLabel.js'

describe('savedKeyLabel', () => {
  it('never calls a personal key active while sponsorship takes precedence', () => {
    expect(savedKeyLabel({ sponsored: true })).toBe('Saved · not in use')
    expect(savedKeyLabel({ sponsored: true, remembered: true })).toBe('Saved · remembered · not in use')
    expect(savedKeyLabel({ sponsored: true, remembered: true })).not.toMatch(/Active/)
  })
  it('a key in use is active', () => {
    expect(savedKeyLabel({})).toBe('Active')
    expect(savedKeyLabel({ remembered: true })).toBe('Active · remembered')
  })
})
