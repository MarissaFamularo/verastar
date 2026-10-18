import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseAbstractText, selectEvidenceWindow, evidenceWindowFor, SECTION_WINDOW_CHARS } from './evidenceWindow.js'
vi.mock('../lib/anthropic.js', () => ({ MODELS: { fast: 'x', triage: 'x' }, extractStructured: vi.fn() }))
import { extractStructured } from '../lib/anthropic.js'
import { checkFindings, NO_RESULTS_REASON } from './check.js'
import { triage } from './triage.js'

beforeEach(() => vi.mocked(extractStructured).mockReset())

// Existing Development fixtures preserve real PubMed text and its original line wraps.
for (const id of ['AS-04', 'AS-02', 'PAD-12', 'HF-13']) {
  it(`${id}: keeps PubMed Results through section selection and cache rebuilding`, () => {
    const d = JSON.parse(readFileSync(new URL(`./__fixtures__/devset/${id}.json`, import.meta.url), 'utf8'))
    const source = { tier: 'abstract_only', text: d.sourceDoc.text }
    const parsed = parseAbstractText(source.text)
    const results = parsed.parts.find((p) => p.kind === 'results')
    expect(results).toBeDefined()
    expect(results.text).not.toContain('CONCLUSIONS:')
    const window = selectEvidenceWindow(source)
    expect(window.hasResults).toBe(true)
    expect(window.text).toContain(results.text.slice(0, 100))
    expect(window.text.length).toBeLessThanOrEqual(SECTION_WINDOW_CHARS)
    expect(evidenceWindowFor({ source, sourceDoc: d.sourceDoc, evidenceWindow: { version: '2026-10-10.window-v3', text: 'BACKGROUND: stale' } }).text).toBe(window.text)
  })
}

it('preserves wrapped lines and ordinary colons, including CRLF abstracts', () => {
  const p = parseAbstractText('BACKGROUND: Background.\r\nMETHODS: A trial with\r\nrandom allocation: continued prose.\r\nRESULTS: No difference.\r\nCONCLUSIONS: No benefit.')
  expect(p.parts.map((x) => x.kind)).toEqual(['background', 'methods', 'results', 'conclusions'])
  expect(p.parts[1].text).toBe('A trial with random allocation: continued prose.')
})

it('never sends a Results-free finding to the checker, even with primary metadata', async () => {
  const out = await checkFindings({ items: [{ id: 'p', finding: 'Treatment reduced mortality.', snippet: "[Evidence window: the paper's abstract]\nBACKGROUND: Treatment may help.", context: 'Primary result: reduced mortality.' }] })
  expect(out.get('p')).toEqual({ verdict: 'unchecked', reason: NO_RESULTS_REASON })
  expect(extractStructured).not.toHaveBeenCalled()
})

it('does not let an extra model verdict overwrite an excluded finding', async () => {
  extractStructured.mockResolvedValue({ verdicts: [{ id: 'p', supported: true }, { id: 'design-caution:p', supported: true }] })
  const snippet = "[Evidence window: the paper's abstract]\nMETHODS: Observational study."
  const out = await checkFindings({ items: [{ id: 'p', finding: 'Improved survival.', snippet }, { id: 'design-caution:p', claimType: 'design-caution', finding: 'Observational study.', snippet }] })
  expect(out.get('p').verdict).toBe('unchecked')
  expect(out.get('design-caution:p').verdict).toBe('supported')
})

it('passes the restored real Results text to both writer and checker', async () => {
  const d = JSON.parse(readFileSync(new URL('./__fixtures__/devset/AS-04.json', import.meta.url), 'utf8'))
  const summary = selectEvidenceWindow({ tier: 'abstract_only', text: d.sourceDoc.text }).text
  extractStructured.mockResolvedValueOnce({ rankings: [{ id: d.pmid, score: 80, tier: 'read', finding: 'Outcomes were similar.', findingNumberFree: 'Outcomes were similar.' }] }).mockResolvedValueOnce({ verdicts: [{ id: d.pmid, supported: true }] })
  const [take] = await triage({ candidates: [{ id: d.pmid, title: 'Trial', summary, verified: [], primary: { state: 'identified', name: 'Death or disabling stroke', verified: false } }] })
  expect(extractStructured).toHaveBeenCalledTimes(2)
  for (const [call] of extractStructured.mock.calls) expect(call.content).toContain(summary)
  expect(take.check.verdict).toBe('supported')
})
