import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../lib/anthropic.js', () => ({ MODELS: { fast: 'x', triage: 'x' }, extractStructured: vi.fn() }))
import { extractStructured } from '../lib/anthropic.js'
import { triage } from './triage.js'
import { digestCount, fitDigestPapers } from './digestLimit.js'
beforeEach(() => vi.mocked(extractStructured).mockReset())
it('clamps legacy preferences without increasing smaller chosen counts', () => {
  expect([5, 20, 30, undefined].map((n) => digestCount(n))).toEqual([5, 20, 20, 5])
})
it('deduplicates additions before using the remaining slots', () => {
  const processed = Array.from({ length: 19 }, (_, i) => ({ paper: { id: String(i) } }))
  expect(fitDigestPapers([{ id: '0' }, { id: '19' }, { id: '19' }, { id: '20' }], processed)).toEqual([{ id: '19' }])
})
it('sends no ranking call when there are no papers', async () => {
  expect(await triage({ candidates: [] })).toEqual([])
  expect(await triage({})).toEqual([])
  expect(extractStructured).not.toHaveBeenCalled()
})
it('rejects oversized legacy ranking before any model call', async () => {
  await expect(triage({ candidates: Array.from({ length: 21 }, (_, i) => ({ id: String(i) })) })).rejects.toThrow('limited to 20')
  expect(extractStructured).not.toHaveBeenCalled()
})
it('twenty papers reach both writer and checker, with room for forty verdicts', async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: 'Trial', summary: "[Evidence window: the paper's abstract]\nMETHODS: Randomized trial.\nRESULTS: No difference in mortality.", verified: [] }))
  extractStructured.mockResolvedValueOnce({ rankings: candidates.map((c) => ({ id: c.id, score: 80, tier: 1, finding: 'No difference in mortality.', design_caution: 'A randomized trial.' })) })
    .mockResolvedValueOnce({ verdicts: candidates.flatMap((c) => [c.id, `design-caution:${c.id}`].map((id) => ({ id, supported: true, reason: 'Supported by the snippet.' }))) })
  const out = await triage({ candidates })
  expect(out).toHaveLength(20)
  expect(out.every((r) => r.check.verdict === 'supported' && r.cautionCheck.verdict === 'supported')).toBe(true)
  expect(extractStructured.mock.calls[1][0].maxTokens).toBe(5120)
  for (const c of candidates) {
    expect(extractStructured.mock.calls[0][0].content).toContain(`[${c.id}]`)
    expect(extractStructured.mock.calls[1][0].content).toContain(`[design-caution:${c.id}]`)
  }
})
