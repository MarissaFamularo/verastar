// concepts.test.js — the deterministic filing guard. The reader's own projects leak into
// filing via the paper's Relevance line; the prompt bans them, and sanitizeFiling repairs
// any filing that still names a topic after a project (the model proposes; the code disposes).
// Plus the domain rule the classifier is given: on a library that already HAS a taxonomy, file
// into it — a single-specialty reader whose every paper lands in "Vascular Surgery" has a dead tier.

import { describe, it, expect } from 'vitest'
import { sanitizeFiling, domainGuidance, categoryGuidance, OTHER_LABEL } from './concepts.js'

const PROJECTS = ['Limb Preservation Program', 'COSMOS utilization study']

describe('sanitizeFiling', () => {
  it('passes a clean filing through untouched', () => {
    expect(sanitizeFiling({ concept: 'Pedal Bypass Patency', hub: 'CLTI Management' }, PROJECTS)).toEqual({
      concept: 'Pedal Bypass Patency',
      hub: 'CLTI Management',
    })
  })

  it('a project-named hub collapses onto the concept', () => {
    expect(
      sanitizeFiling({ concept: 'Minor-to-Major Amputation Progression', hub: 'Limb Preservation Program' }, PROJECTS),
    ).toEqual({ concept: 'Minor-to-Major Amputation Progression', hub: 'Minor-to-Major Amputation Progression' })
  })

  it('a project-named concept files directly under its hub', () => {
    expect(sanitizeFiling({ concept: 'Limb Preservation Program', hub: 'CLTI Management' }, PROJECTS)).toEqual({
      concept: 'CLTI Management',
      hub: 'CLTI Management',
    })
  })

  it('both banned falls back to Uncategorized', () => {
    expect(
      sanitizeFiling({ concept: 'COSMOS utilization study', hub: 'Limb Preservation Program' }, PROJECTS),
    ).toEqual({ concept: 'Uncategorized', hub: 'Uncategorized' })
  })

  it('matches case- and whitespace-insensitively', () => {
    expect(sanitizeFiling({ concept: '  limb preservation program ', hub: 'CLTI Management' }, PROJECTS)).toEqual({
      concept: 'CLTI Management',
      hub: 'CLTI Management',
    })
  })

  it('no projects → no-op', () => {
    expect(sanitizeFiling({ concept: 'A', hub: 'B' }, [])).toEqual({ concept: 'A', hub: 'B' })
  })
})

describe('domainGuidance', () => {
  // Her real library after the fix: one auto-minted field, five she typed in Settings.
  const HERS = [
    { key: 'vascular-surgery', label: 'Vascular Surgery' },
    { key: 'ai-ml', label: 'AI / ML', source: 'user' },
    { key: 'carotid-disease', label: 'Carotid Disease', source: 'user' },
    { key: 'limb', label: 'Limb', source: 'user' },
    { key: 'aneurysm', label: 'Aneurysm', source: 'user' },
    { key: 'medical-education', label: 'Medical Education', source: 'user' },
  ]

  it('an empty taxonomy is named by discipline, with the anti-collapse warning', () => {
    const g = domainGuidance([])
    expect(g).toMatch(/taxonomy is empty/)
    expect(g).toMatch(/collapsing the taxonomy/)
    expect(g).not.toMatch(/ALREADY HAS/)
  })

  it('an existing taxonomy is listed by key, label and provenance', () => {
    const g = domainGuidance(HERS)
    expect(g).toMatch(/ALREADY HAS a taxonomy/)
    expect(g).toMatch(/Return the KEY verbatim/)
    for (const d of HERS) expect(g).toContain(`"${d.key}": ${d.label}`)
  })

  it('marks the fields she created herself — and only those', () => {
    const g = domainGuidance(HERS)
    const marked = g
      .split('\n')
      .filter((l) => l.includes('the reader created this field themselves'))
      .join('\n')
    expect(marked).toContain('"ai-ml"')
    expect(marked).toContain('"carotid-disease"')
    expect(marked).not.toContain('"vascular-surgery"') // Claude minted this one
    expect(g).toMatch(/prefer them over any field you would name yourself/)
  })

  it('tells the model to match her granularity, not fall back to the broad specialty', () => {
    const g = domainGuidance(HERS)
    expect(g).toMatch(/SUBJECT-level/)
    expect(g).toMatch(/do NOT fall back to the broad specialty/)
  })

  it('handles her actual mixed list — narrow fields beside the specialty Claude minted', () => {
    const g = domainGuidance(HERS)
    expect(g).toMatch(/MIXES levels/)
    expect(g).toMatch(/narrowest field the paper actually fits/)
    expect(g).toMatch(/the broad one is the last resort/)
  })

  it('minting a new field is the exception, at the granularity already on show', () => {
    const g = domainGuidance(HERS)
    expect(g).toMatch(/ONLY when the paper genuinely fits none/)
    expect(g).toMatch(/not merely because no field is a perfect fit/)
    expect(g).toMatch(/SAME level of granularity/)
    expect(g).toMatch(/never a near-duplicate of a field already listed/)
  })

  it('never instructs the model to remove or rename an existing field', () => {
    const g = domainGuidance(HERS)
    expect(g).not.toMatch(/\b(rename|delete|remove|drop)\b/i)
  })

  it('keeps the discipline-vs-subject distinction in both regimes', () => {
    for (const g of [domainGuidance([]), domainGuidance(HERS)]) {
      expect(g).toMatch(/DISCIPLINE can differ from its clinical subject|discipline rather than merely its clinical subject/)
    }
  })

  it('defaults to the empty-taxonomy regime with no argument', () => {
    expect(domainGuidance()).toBe(domainGuidance([]))
  })
})

// Once the library has category shelves, the hub answer is a CHOICE, not a coinage: pick one
// of the fixed labels or fall to Other. Deposits never change the shelf set.
describe('categoryGuidance', () => {
  const CATS = ['Carotid Disease', 'Aneurysm', 'Other']

  it('no categories yet → null (the free-form hub regime applies)', () => {
    expect(categoryGuidance([])).toBe(null)
    expect(categoryGuidance()).toBe(null)
  })

  it('lists every category label verbatim', () => {
    const g = categoryGuidance(CATS)
    for (const l of CATS) expect(g).toContain(`"${l}"`)
  })

  it('demands a fixed choice and names the Other fallback', () => {
    const g = categoryGuidance(CATS)
    expect(g).toMatch(/FIXED set/)
    expect(g).toMatch(/EXACTLY one of these labels, verbatim/)
    expect(g).toContain(`return exactly "${OTHER_LABEL}"`)
  })

  it('forbids minting, renaming, or merging a category at deposit time', () => {
    const g = categoryGuidance(CATS)
    expect(g).toMatch(/NEVER creates, renames, or merges/)
    expect(g).toMatch(/Never invent a new category name/)
  })
})
