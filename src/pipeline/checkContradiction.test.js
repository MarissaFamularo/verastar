import { readFileSync } from 'node:fs'
import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('../lib/anthropic.js', () => ({ MODELS: { fast: 'x', triage: 'x' }, extractStructured: vi.fn() }))
import { extractStructured } from '../lib/anthropic.js'
import { checkFindings, reasonAdmitsMissingEvidence } from './check.js'
import { triage } from './triage.js'
import { selectEvidenceWindow } from './evidenceWindow.js'
import { claimCheckLabel } from '../lib/claimCheck.js'

beforeEach(() => vi.mocked(extractStructured).mockReset())

it.each([
  'The snippet does not explicitly state they were unblinded.',
  "The source doesn't mention blinding.",
  'Blinding is not stated in the supplied abstract.',
  'The excerpt cannot confirm the asserted design.',
  'This is not directly supported by the source.',
  'The snippet supports the main result, but the text does not establish the subgroup benefit.',
])('withholds a positive verdict that admits missing evidence: %s', async (reason) => {
  extractStructured.mockResolvedValue({ verdicts: [{ id: 'p', supported: true, reason }] })
  const out = await checkFindings({ items: [{ id: 'p', finding: 'A claim.', snippet: 'A source.' }] })
  expect(out.get('p')).toEqual({ verdict: 'refuted', reason })
  expect(claimCheckLabel(out.get('p'))).toBeNull()
})

it.each([
  'The snippet reports no significant difference in mortality.',
  'Treatment does not reduce mortality according to the source.',
  'The claim does not overstate the result.',
  'The source explicitly states the study was unblinded.',
  'The claim correctly notes that the study cannot establish causality.',
])('preserves supported negative or cautious conclusions: %s', (reason) => {
  expect(reasonAdmitsMissingEvidence(reason)).toBe(false)
})

it('HF-13: keeps the primary finding supported but refutes the reported unblinded caution', async () => {
  const d = JSON.parse(readFileSync(new URL('./__fixtures__/devset/HF-13.json', import.meta.url), 'utf8'))
  const summary = selectEvidenceWindow({ tier: 'abstract_only', text: d.sourceDoc.text }).text
  const reason = 'The snippet does not explicitly state they were unblinded.'
  extractStructured.mockResolvedValueOnce({ rankings: [{
    id: d.pmid, score: 80, tier: 'read', finding: 'PCI did not reduce death or hospitalization for heart failure.',
    design_caution: 'Quality-of-life findings were secondary and unblinded.',
  }] }).mockResolvedValueOnce({ verdicts: [
    { id: d.pmid, supported: true, reason: 'The snippet reports no significant difference in the primary outcome.' },
    { id: `design-caution:${d.pmid}`, supported: true, reason },
  ] })
  const [take] = await triage({ candidates: [{ id: d.pmid, title: 'REVIVED', summary, verified: [], primary: { state: 'identified', name: 'Death or hospitalization for heart failure', verified: false } }] })
  expect(take.check.verdict).toBe('supported')
  expect(take.cautionCheck).toEqual({ verdict: 'refuted', reason })
  expect(extractStructured.mock.calls[1][0].system).toContain('partial support is unsupported')
})
