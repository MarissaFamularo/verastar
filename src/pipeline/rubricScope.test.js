import { describe, expect, it } from 'vitest'
import { rubricScopeIssues, rubricSentences } from './rubricScope.js'
import { DRAFT_SYSTEM } from './interview.js'
import { PROFILE_DRAFT_SYSTEM } from './onboard.js'

const codes = (text) => rubricScopeIssues(text).map((entry) => entry.code)

describe('rubricScopeIssues', () => {
  it('routes the exact saved-retraction feedback to the Library monitor', () => {
    const [entry] = rubricScopeIssues('Flag if anything previously saved is later retracted.')
    expect(entry.code).toBe('saved-retraction')
    expect(entry.message).toMatch(/Library opens/i)
    expect(entry.message).toMatch(/does not control/i)
  })

  it('flags cross-candidate allocation while naming the coverage pass', () => {
    const [entry] = rubricScopeIssues('Rank within each bucket rather than across buckets.')
    expect(entry.code).toBe('cross-candidate')
    expect(entry.message).toMatch(/Topic coverage is applied afterward/i)
  })

  it('flags explicit future alerts and monitoring', () => {
    expect(codes('Alert me if this paper is later corrected.')).toEqual(['future-monitoring'])
    expect(codes('Monitor retractions over time.')).toEqual(['future-monitoring'])
  })

  it('flags instructions requiring saved-library or prior-run context', () => {
    expect(codes('Prioritize papers that fill gaps in my library.')).toEqual(['library-history'])
    expect(codes('Avoid anything already seen in prior runs.')).toEqual(['library-history'])
  })

  it('flags explicit topic quotas', () => {
    expect(codes('Include at least one paper from each topic.')).toEqual(['cross-candidate'])
    expect(codes('Maintain diversity across the digest topics.')).toEqual(['cross-candidate'])
  })

  it('does not warn on supported paper-level editorial criteria', () => {
    expect(rubricScopeIssues(
      'Prioritize randomized trials with clinically important outcomes. Rank lower single-center retrospective studies. Flag observational designs that overstate causality. Skip editorials.',
    )).toEqual([])
  })

  it('preserves the exact sentence so the editor can identify what needs attention', () => {
    const text = 'Prioritize trials.\nFlag if anything previously saved is later retracted.'
    expect(rubricSentences(text)).toEqual([
      'Prioritize trials.',
      'Flag if anything previously saved is later retracted.',
    ])
    expect(rubricScopeIssues(text)[0].sentence).toBe('Flag if anything previously saved is later retracted.')
  })
})

describe('generated rubric scope', () => {
  for (const [name, prompt] of [['interview', DRAFT_SYSTEM], ['short intake', PROFILE_DRAFT_SYSTEM]]) {
    it(`${name} prompt forbids cross-component rubric instructions`, () => {
      expect(prompt).toMatch(/saved library or prior runs/i)
      expect(prompt).toMatch(/compare or allocate across candidates/i)
      expect(prompt).toMatch(/monitor future events/i)
      expect(prompt).toMatch(/schedule alerts/i)
    })
  }
})
