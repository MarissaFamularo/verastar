// check.test.js — the prose gate. The number guard proves digits; this gate audits the
// prose claim around them (direction, comparator, population) via an adversarial second
// model. These tests mock the model call and lock the gate's PLUMBING guarantees:
// verdict mapping is by id, unauditable items never reach the model, a missing verdict
// degrades to 'unchecked' (never blocks), and triage() attaches a check to every ranking
// even when the gate itself throws.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/anthropic.js', () => ({
  MODELS: { extraction: 'x', triage: 'x', interview: 'x', fast: 'x' },
  extractStructured: vi.fn(),
}))

import { extractStructured } from '../lib/anthropic.js'
import { checkFindings, CHECK_SCHEMA, SNIPPET_CHARS } from './check.js'
import { triage, TRIAGE_SCHEMA } from './triage.js'

const ITEMS = [
  { id: 'p1', finding: 'Reduced amputation versus surgery.', snippet: 'Endovascular therapy reduced major amputation compared with surgery.' },
  { id: 'p2', finding: 'Improved wound healing.', snippet: 'No significant difference in wound healing was observed.' },
]

beforeEach(() => {
  extractStructured.mockReset()
})

describe('checkFindings — verdict plumbing', () => {
  it('maps supported and refuted verdicts back by id, with the reason', async () => {
    extractStructured.mockResolvedValue({
      verdicts: [
        { id: 'p1', supported: true, reason: 'matches the snippet' },
        { id: 'p2', supported: false, reason: 'snippet reports a null result' },
      ],
    })
    const out = await checkFindings({ items: ITEMS })
    expect(out.get('p1')).toEqual({ verdict: 'supported', reason: 'matches the snippet' })
    expect(out.get('p2')).toEqual({ verdict: 'refuted', reason: 'snippet reports a null result' })
    expect(extractStructured).toHaveBeenCalledTimes(1)
    expect(extractStructured.mock.calls[0][0].schema).toBe(CHECK_SCHEMA)
  })

  it('marks items with no finding or no snippet unchecked and never sends them to the model', async () => {
    extractStructured.mockResolvedValue({ verdicts: [{ id: 'p1', supported: true, reason: '' }] })
    const out = await checkFindings({
      items: [ITEMS[0], { id: 'p3', finding: '', snippet: 'text' }, { id: 'p4', finding: 'claim', snippet: '  ' }],
    })
    expect(out.get('p3')).toEqual({ verdict: 'unchecked', reason: '' })
    expect(out.get('p4')).toEqual({ verdict: 'unchecked', reason: '' })
    const content = extractStructured.mock.calls[0][0].content
    expect(content).toContain('[p1]')
    expect(content).not.toContain('[p3]')
    expect(content).not.toContain('[p4]')
  })

  it('makes no model call at all when nothing is auditable', async () => {
    const out = await checkFindings({ items: [{ id: 'p1', finding: 'claim', snippet: '' }] })
    expect(out.get('p1')).toEqual({ verdict: 'unchecked', reason: '' })
    expect(extractStructured).not.toHaveBeenCalled()
  })

  it('leaves an id the model omitted unchecked, and drops an id it invented', async () => {
    extractStructured.mockResolvedValue({
      verdicts: [
        { id: 'p1', supported: true, reason: '' },
        { id: 'ghost', supported: false, reason: 'invented' },
      ],
    })
    const out = await checkFindings({ items: ITEMS })
    expect(out.get('p1').verdict).toBe('supported')
    expect(out.get('p2')).toEqual({ verdict: 'unchecked', reason: '' })
    expect(out.has('ghost')).toBe(false)
  })

  it('slices the snippet to the shared evidence window (SNIPPET_CHARS)', async () => {
    extractStructured.mockResolvedValue({ verdicts: [] })
    const long = 'a'.repeat(SNIPPET_CHARS + 500)
    await checkFindings({ items: [{ id: 'p1', finding: 'claim', snippet: long }] })
    const content = extractStructured.mock.calls[0][0].content
    expect(content).not.toContain('a'.repeat(SNIPPET_CHARS + 1))
    expect(content).toContain('a'.repeat(SNIPPET_CHARS))
  })
})

describe('triage() — the gate is wired in, and can never block the digest', () => {
  const CANDIDATES = [
    { id: 'p1', title: 'T1', design: 'RCT', summary: 'Endovascular therapy reduced amputation.', verified: [] },
  ]
  const RANKINGS = {
    rankings: [
      { id: 'p1', score: 90, tier: 1, finding: 'Reduced amputation.', finding_plain: 'Reduced amputation.', relevance: 'CLTI work.' },
    ],
  }

  it('attaches the check verdict to each ranking', async () => {
    extractStructured.mockImplementation(async ({ schema }) => {
      if (schema === TRIAGE_SCHEMA) return RANKINGS
      if (schema === CHECK_SCHEMA) return { verdicts: [{ id: 'p1', supported: false, reason: 'overstated' }] }
      throw new Error('unexpected schema')
    })
    const out = await triage({ candidates: CANDIDATES })
    expect(out).toHaveLength(1)
    expect(out[0].finding).toBe('Reduced amputation.')
    expect(out[0].check).toEqual({ verdict: 'refuted', reason: 'overstated' })
  })

  it('audits the AS-RENDERED finding — post number guard, not the raw model output', async () => {
    extractStructured.mockImplementation(async ({ schema, content }) => {
      if (schema === TRIAGE_SCHEMA)
        return {
          rankings: [
            // Unbacked digit: the guard will fall back to finding_plain before the audit.
            { id: 'p1', score: 90, tier: 1, finding: 'Reduced amputation by 42%.', finding_plain: 'Reduced amputation.', relevance: 'CLTI.' },
          ],
        }
      if (schema === CHECK_SCHEMA) {
        expect(content).toContain('CLAIM: Reduced amputation.')
        expect(content).not.toContain('42%')
        return { verdicts: [{ id: 'p1', supported: true, reason: '' }] }
      }
      throw new Error('unexpected schema')
    })
    const out = await triage({ candidates: CANDIDATES })
    expect(out[0].finding).toBe('Reduced amputation.')
    expect(out[0].check.verdict).toBe('supported')
  })

  it('degrades to unchecked when the gate itself throws — rankings are untouched', async () => {
    extractStructured.mockImplementation(async ({ schema }) => {
      if (schema === TRIAGE_SCHEMA) return RANKINGS
      throw new Error('network down')
    })
    const out = await triage({ candidates: CANDIDATES })
    expect(out[0].finding).toBe('Reduced amputation.')
    expect(out[0].check).toEqual({ verdict: 'unchecked', reason: '' })
  })
})
