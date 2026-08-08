import { describe, expect, it } from 'vitest'
import {
  applyJournalExtractions,
  journalPreferenceText,
  normalizeJournalPreferences,
  rubricWordCount,
} from './journals.js'

describe('structured journal preferences', () => {
  it('deduplicates case-insensitively and gives must-not-miss priority', () => {
    expect(normalizeJournalPreferences({
      mustNotMiss: ['JAMA', ' jama ', 'NEJM'],
      preferred: ['Jama', 'Annals of Surgery'],
    })).toEqual({ mustNotMiss: ['JAMA', 'NEJM'], preferred: ['Annals of Surgery'] })
  })

  it('renders compact scoring context and counts rubric words', () => {
    expect(journalPreferenceText({ mustNotMiss: ['JAMA'], preferred: ['BMJ'] }))
      .toBe('Must-not-miss journals: JAMA\nPreferred journals: BMJ')
    expect(rubricWordCount(' Prioritize trials and strong cohorts. ')).toBe(5)
  })
})

describe('journal migration preservation', () => {
  it('removes only an exact journal-only span and preserves other criteria verbatim', () => {
    const rubric = 'Prioritize randomized trials in JAMA and NEJM. Rank lower small retrospective series.'
    const result = applyJournalExtractions(rubric, [{
      fragment: 'in JAMA and NEJM',
      tier: 'must_not_miss',
      journals: ['JAMA', 'NEJM'],
    }], { preferred: ['BMJ'] })
    expect(result.changed).toBe(true)
    expect(result.rubric).toBe('Prioritize randomized trials. Rank lower small retrospective series.')
    expect(result.journalPreferences).toEqual({ mustNotMiss: ['JAMA', 'NEJM'], preferred: ['BMJ'] })
  })

  it('ignores inexact and overlapping model suggestions', () => {
    const rubric = 'Prefer JAMA and NEJM; skip editorials.'
    const result = applyJournalExtractions(rubric, [
      { fragment: 'not in the rubric', tier: 'preferred', journals: ['Lancet'] },
      { fragment: 'JAMA and NEJM', tier: 'preferred', journals: ['JAMA', 'NEJM'] },
      { fragment: 'NEJM', tier: 'must_not_miss', journals: ['NEJM'] },
    ])
    expect(result.removed).toHaveLength(1)
    expect(result.rubric).toBe('Prefer; skip editorials.')
  })

  it('upgrades an existing preferred journal to must-not-miss', () => {
    const result = applyJournalExtractions('Always read JAMA.', [{
      fragment: 'JAMA', tier: 'must_not_miss', journals: ['JAMA'],
    }], { preferred: ['JAMA'] })
    expect(result.journalPreferences).toEqual({ mustNotMiss: ['JAMA'], preferred: [] })
  })

  it('does not change anything without an accepted exact span', () => {
    const result = applyJournalExtractions('Prioritize trials.', [], { preferred: ['BMJ'] })
    expect(result).toMatchObject({ changed: false, rubric: 'Prioritize trials.' })
  })
})
