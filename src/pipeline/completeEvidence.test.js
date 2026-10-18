import { describe, it, expect, vi, beforeEach } from 'vitest'
const mock = vi.hoisted(() => vi.fn())
vi.mock('../lib/anthropic.js', async importOriginal => ({ ...(await importOriginal()), extractStructured: mock }))
import { selectEvidenceWindow, evidenceSummary, assertEvidenceBatch, SECTION_WINDOW_CHARS } from './evidenceWindow.js'
import { triage } from './triage.js'
import { checkFindings } from './check.js'

// Synthetic regression: an early null result precedes a qualified late outcome.
// No paper identifier, disease, therapy name or numeric result drives selection.
const exception = 'Long-term outcomes were similar across regimens, except for combined therapy, which had worse outcomes.'
const later = 'After weighting, the patency association persisted, whereas survival was not significantly different.'
const abstractParts = [{ label: 'Methods', text: 'A retrospective registry compared postoperative regimens.' }, { label: 'Results', text: exception }, { label: 'Conclusions', text: 'Confounding limits causal interpretation.' }]
const results = 'Early outcomes did not differ. ' + 'Complete cohort description. '.repeat(230) + exception + ' ' + later
const source = { tier: 'full_text', abstractParts, sections: [{ label: 'Results', kind: 'results', depth: 0, parent: -1, text: results }] }
beforeEach(() => { mock.mockReset() })
describe('complete evidence boundaries', () => {
  it('retains the entire abstract and late qualified Results, with truthful provenance', () => {
    const w = selectEvidenceWindow(source)
    expect(w.text.length).toBeGreaterThan(6000)
    expect(w.text.length).toBeLessThanOrEqual(SECTION_WINDOW_CHARS)
    for (const p of abstractParts) expect(w.text).toContain(p.text)
    expect(w.text).toContain(results)
    expect(w.parts.map(p => p.from)).toEqual(['abstract', 'abstract', 'abstract', 'body'])
    expect(w.text).not.toContain('…')
    expect(source.sections[0].text).toBe(results)
  })
  it('passes identical complete evidence beyond the old downstream cutoff to both models', async () => {
    const w = selectEvidenceWindow(source)
    mock.mockImplementation(async ({schema}) => schema.properties.rankings ? {rankings:[{id:'x',finding:exception,finding_plain:exception,design_caution:'',relevance:'Relevant.',score:70,tier:2}]} : {verdicts:[{id:'x',supported:true,reason:'Explicit exception retained.'}]})
    await triage({candidates:[{id:'x',title:'Synthetic registry',summary:w.text,verified:[]}]})
    expect(mock).toHaveBeenCalledTimes(2)
    expect(mock.mock.calls[0][0].content).toContain(w.text)
    expect(mock.mock.calls[1][0].content).toContain(`SNIPPET:\n${w.text}\nCLAIMS:`)
    for(const [call] of mock.mock.calls) expect(call.content).toContain(later)
  })
  it('declines the entire window when complete sections cannot fit; no abstract-only success mask', () => {
    const w = selectEvidenceWindow({...source, sections:[{...source.sections[0],text:results.repeat(30)}]})
    expect(w).toMatchObject({blocked:true,text:'',kind:'unavailable'})
    expect(w.reason).toMatch(/exceeding.*limit/)
    expect(()=>evidenceSummary({evidenceWindow:w})).toThrow(/No truncated evidence/)
  })
  it('rejects a tiny custom budget instead of cutting a sentence or its decimal', () => {
    const w=selectEvidenceWindow({tier:'abstract_only',text:'RESULTS: The hazard ratio was 0.75, but uncertainty remained.'},{budget:80})
    expect(w.blocked).toBe(true)
    expect(w.text).toBe('')
  })
  it('does not duplicate nested Results', () => {
    const w=selectEvidenceWindow({...source,sections:[source.sections[0],{label:'Primary results',kind:'results',parent:0,depth:1,text:exception}]})
    expect(w.parts.filter(p=>p.from==='body')).toHaveLength(1)
  })
  it('fails before writer or checker dispatch for oversized inputs and aggregate UTF-8 bounds', async () => {
    const long='x'.repeat(SECTION_WINDOW_CHARS+1)
    await expect(triage({candidates:[{id:'x',summary:long}]})).rejects.toThrow(/no truncated evidence/)
    await expect(checkFindings({items:[{id:'x',finding:'claim',snippet:long}]})).rejects.toThrow(/no truncated evidence/)
    expect(()=>assertEvidenceBatch(Array(20).fill('x'.repeat(12000)))).not.toThrow()
    expect(()=>assertEvidenceBatch(['文'.repeat(SECTION_WINDOW_CHARS / 2)])).toThrow(/model budget/)
    expect(mock).not.toHaveBeenCalled()
  })
})
