import { beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => vi.fn())
vi.mock('../lib/anthropic.js', async original => ({ ...await original(), extractStructured: mock }))
import { evidenceSummary, selectEvidenceWindow, proseRequestBudget, SECTION_WINDOW_CHARS } from './evidenceWindow.js'
import { triage } from './triage.js'
import { checkFindings } from './check.js'
beforeEach(() => {
  mock.mockReset()
  mock.mockImplementation(async request => {
    const ids = [...request.content.matchAll(/^\[([^\]]+)\] (?:CLAIM:|Paper)/gm)].map(m => m[1])
    return request.schema.properties.rankings
      ? { rankings: ids.map(id => ({ id, score: 80, tier: 2, finding: 'Outcomes were similar.', finding_plain: 'Outcomes were similar.', design_caution: 'Observational design.', relevance: 'Relevant.' })) }
      : { verdicts: ids.map(id => ({ id, supported: true, reason: 'Complete source.' })) }
  })
})
it('admits a modest source longer than 12k without dropping any abstract or Results text', () => {
  const abstract = 'Complete abstract. '.repeat(100)
  const results = 'Complete results with exceptions. '.repeat(360)
  const w = selectEvidenceWindow({tier:'full_text',abstractParts:[{label:'Results',text:abstract}],sections:[{label:'Results',kind:'results',text:results}]})
  expect(w.blocked).toBe(false)
  expect(w.text.length).toBeGreaterThan(12327)
  expect(w.text).toContain(abstract.trim())
  expect(w.text).toContain(results.trim())
})
it('resumes old clipped windows using all saved source and tables, including late exceptions', async () => {
  const text = 'PUBLISHER ABSTRACT: Complete abstract.\nBODY: ' + 'Background. '.repeat(700) + 'Results: Outcomes were similar except treatment worsened patency.'
  const result = JSON.parse(JSON.stringify({source:{tier:'full_text'},sourceDoc:{text,tables:'Table: complete findings'},evidenceWindow:{version:'2026-10-12.window-v4',text:'stale incomplete fragment'}}))
  const summary=evidenceSummary(result)
  expect(summary).toContain(text)
  expect(summary).toContain('Table: complete findings')
  expect(summary).not.toContain('stale incomplete fragment')
  await triage({candidates:[{id:'old',title:'Paper old',summary,verified:[]}]})
  expect(mock).toHaveBeenCalledTimes(2)
  for(const [call] of mock.mock.calls)expect(call.content).toContain(summary)
})
it('stops missing legacy sources instead of generating without evidence', () => {
  expect(()=>evidenceSummary({source:{tier:'full_text'},sourceDoc:{text:''},evidenceWindow:{version:'v4',text:'clipped'}})).toThrow(/Re-read/)
  expect(mock).not.toHaveBeenCalled()
})
it('splits a 20-paper writer batch and retains every complete source and verdict', async () => {
  const candidates=Array.from({length:20},(_,i)=>({id:String(i),title:`Paper ${i}`,summary:`Source ${i}: `+'Complete results. '.repeat(900),verified:[]}))
  const rankings=await triage({candidates})
  expect(rankings.map(x=>x.id)).toEqual(candidates.map(x=>x.id))
  expect(rankings.every(x=>x.check.verdict==='supported')).toBe(true)
  expect(mock.mock.calls.filter(([r])=>r.schema.properties.rankings).length).toBeGreaterThan(1)
  for(const [call] of mock.mock.calls)expect(proseRequestBudget(call.system,call.content,call.schema,call.maxTokens).fits).toBe(true)
  for(const c of candidates){
    expect(mock.mock.calls.filter(([r])=>r.schema.properties.rankings&&r.content.includes(c.summary))).toHaveLength(1)
    expect(mock.mock.calls.filter(([r])=>r.schema.properties.verdicts&&r.content.includes(c.summary))).toHaveLength(1)
  }
})
it('splits standalone checker batches by source and keeps finding/caution pairs together', async () => {
  const items=Array.from({length:20},(_,i)=>{const snippet=`Source ${i}: `+'Complete results. '.repeat(900);return [{id:String(i),finding:'Outcomes were similar.',snippet},{id:`design-caution:${i}`,claimType:'design-caution',finding:'Observational.',snippet}]}).flat()
  const checks=await checkFindings({items})
  expect(checks.size).toBe(40)
  expect([...checks.values()].every(x=>x.verdict==='supported')).toBe(true)
  expect(mock.mock.calls.length).toBeGreaterThan(1)
  for(const [call] of mock.mock.calls){
    expect(proseRequestBudget(call.system,call.content,call.schema,call.maxTokens).fits).toBe(true)
    for(const id of [...call.content.matchAll(/^\[(\d+)\] CLAIM:/gm)].map(m=>m[1]))expect(call.content).toContain(`[design-caution:${id}] CLAIM:`)
  }
})
it('counts UTF-8, JSON escaping, schema, output and fixed padding before dispatch', async () => {
  expect(proseRequestBudget('', '文').inputTokens).toBeGreaterThan(proseRequestBudget('', 'x').inputTokens)
  expect(proseRequestBudget('', '\u0000').inputTokens).toBeGreaterThan(proseRequestBudget('', 'x').inputTokens)
  expect(proseRequestBudget('', '', {description:'x'.repeat(160000)}).fits).toBe(false)
  expect(proseRequestBudget('', '', {},200000).fits).toBe(false)
  await expect(triage({rubric:'x'.repeat(200000),candidates:[{id:'x',title:'Paper x',summary:'Complete source.'}]})).rejects.toThrow(/token budget/)
  expect(mock).not.toHaveBeenCalled()
  expect(()=>evidenceSummary({source:{tier:'full_text'},sourceDoc:{text:'x'.repeat(SECTION_WINDOW_CHARS+1)}})).toThrow(/model budget/)
})
