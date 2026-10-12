// Section A regression tests: the shared extraction input includes the main publisher
// abstract, and the model, the verifier and the stored sourceDoc share one corpus.
// All fixtures are SYNTHETIC (invented wording and numbers).
import { describe, it, expect } from 'vitest'
import { DOMParser } from 'linkedom'
import { assembleExtractionSource, pmcAbstractParts, pmcSections, ABSTRACT_BLOCK_HEADER } from './sources.js'
import { selectEvidenceWindow } from './evidenceWindow.js'
import { verify, TIERS } from './verify.js'
import { planSinglePaper, planSummary } from '../eval/singlePaper.js'

globalThis.DOMParser = globalThis.DOMParser || DOMParser

const ABSTRACT_ONLY_RESULT = 'fatal or disabling stroke occurred in 3.7 per cent at five years (rate ratio 1.16, 95% CI 0.86-1.57; P=0.33)'

const xmlWith = (abstractXml, bodyXml) => `<?xml version="1.0"?><pmc-articleset><article><front><article-meta>${abstractXml}</article-meta></front><body>${bodyXml}</body></article></pmc-articleset>`
const STRUCTURED = `<abstract><sec><title>Methods</title><p>Synthetic randomized design in adults.</p></sec><sec><title>Results</title><p>${ABSTRACT_ONLY_RESULT}.</p></sec></abstract>`
const UNSTRUCTURED = `<abstract><p>Synthetic unstructured abstract: ${ABSTRACT_ONLY_RESULT}.</p></abstract>`
const GRAPHICAL = '<abstract abstract-type="graphical"><p>Graphical teaser text should never appear.</p></abstract>'
const BODY = '<sec sec-type="intro"><title>Introduction</title><p>Synthetic background.</p></sec><sec sec-type="results"><title>Results</title><p>Body result: patients had a mean age of 69.1 years.</p><table-wrap><label>Table 1</label><table><tr><td>Age</td><td>69.1</td></tr></table></table-wrap></sec>'

const parseDoc = (xml) => new DOMParser().parseFromString(xml, 'text/xml')
const abstractParts = (xml) => pmcAbstractParts(parseDoc(xml))

describe('assembleExtractionSource', () => {
  it('with no abstract it is byte-identical to the previous body + TABLES input', () => {
    const a = assembleExtractionSource({ text: 'Body prose.', tables: 'Table 1\nAge | 69.1', abstractParts: [] })
    expect(a.modelText).toBe('Body prose.\n\nTABLES:\nTable 1\nAge | 69.1')
    expect(a.corpusText).toBe('Body prose.')
    expect(a.coverage).toEqual({ abstractPresent: false, bodyPresent: true, tablesPresent: true, figureImageTextExtracted: false })
    expect(assembleExtractionSource({ text: 'Body only.' }).modelText).toBe('Body only.')
  })

  it('includes a structured abstract, labelled, with exact section text', () => {
    const parts = abstractParts(xmlWith(STRUCTURED, BODY))
    const a = assembleExtractionSource({ text: 'Body.', tables: '', abstractParts: parts })
    expect(a.corpusText.startsWith(`${ABSTRACT_BLOCK_HEADER}\nMethods: Synthetic randomized design in adults.\nResults: ${ABSTRACT_ONLY_RESULT}.`)).toBe(true)
    expect(a.corpusText.endsWith('\n\nBody.')).toBe(true)
    expect(a.coverage.abstractPresent).toBe(true)
  })

  it('includes an unstructured abstract without inventing a label', () => {
    const parts = abstractParts(xmlWith(UNSTRUCTURED, BODY))
    const a = assembleExtractionSource({ text: 'Body.', abstractParts: parts })
    expect(a.corpusText).toContain(`${ABSTRACT_BLOCK_HEADER}\nSynthetic unstructured abstract: ${ABSTRACT_ONLY_RESULT}.`)
  })

  it('excludes graphical/teaser abstracts', () => {
    const parts = abstractParts(xmlWith(GRAPHICAL + STRUCTURED, BODY))
    const a = assembleExtractionSource({ text: 'Body.', abstractParts: parts })
    expect(a.modelText).not.toContain('Graphical teaser')
  })

  it('the same material reaches the model and the verifier input', () => {
    const a = assembleExtractionSource({ text: 'Body.', tables: 'T | 1', abstractParts: abstractParts(xmlWith(STRUCTURED, BODY)) })
    expect(a.modelText).toBe(`${a.corpusText}\n\nTABLES:\n${a.tables}`)
  })

  it('the source-input text changes when abstract text changes', () => {
    const p1 = abstractParts(xmlWith(STRUCTURED, BODY))
    const p2 = abstractParts(xmlWith(STRUCTURED.replace('3.7 per cent', '4.1 per cent'), BODY))
    const base = assembleExtractionSource({ text: 'Body.', abstractParts: [] }).modelText
    const a = assembleExtractionSource({ text: 'Body.', abstractParts: p1 }).modelText
    const b = assembleExtractionSource({ text: 'Body.', abstractParts: p2 }).modelText
    expect(a).not.toBe(base)
    expect(a).not.toBe(b)
  })

  it('duplicate passage in abstract and body is kept in both places without merging', () => {
    const dup = 'The identical sentence appears twice.'
    const parts = [{ label: 'Results', text: dup }]
    const a = assembleExtractionSource({ text: `Intro. ${dup} Outro.`, abstractParts: parts })
    expect(a.corpusText.split(dup)).toHaveLength(3)
    expect(a.corpusText).toContain(`Results: ${dup}`)
    expect(a.corpusText).toContain(`Intro. ${dup} Outro.`)
  })
})

describe('coverage tier semantics', () => {
  it('abstract_only text is the abstract, not a body', () => {
    const a = assembleExtractionSource({ text: 'Abstract text of a non-open-access paper.', tables: '', abstractParts: [], tier: 'abstract_only' })
    expect(a.coverage).toEqual({ abstractPresent: true, bodyPresent: false, tablesPresent: false, figureImageTextExtracted: false })
    expect(a.corpusText).toBe('Abstract text of a non-open-access paper.')
    expect(a.modelText).toBe('Abstract text of a non-open-access paper.')
  })
  it('user_text is a body with no abstract', () => {
    const a = assembleExtractionSource({ text: 'Uploaded manuscript body.', tables: '', abstractParts: [], tier: 'user_text' })
    expect(a.coverage).toEqual({ abstractPresent: false, bodyPresent: true, tablesPresent: false, figureImageTextExtracted: false })
    expect(a.corpusText).toBe('Uploaded manuscript body.')
  })
  it('a full-text paper with no abstract reports body only', () => {
    const a = assembleExtractionSource({ text: 'Body only.', abstractParts: [], tier: 'full_text' })
    expect(a.coverage).toMatchObject({ abstractPresent: false, bodyPresent: true })
  })
})

describe('plan summaries never leak the source', () => {
  it('planSummary drops source, assembled text and request content', async () => {
    const plan = await planSinglePaper({ caseId: 'ZZZ-1', pmid: '1', pmcXml: xmlWith(STRUCTURED, BODY) })
    const summary = planSummary(plan)
    expect(summary.source).toBeUndefined()
    expect(summary.assembled).toBeUndefined()
    const text = JSON.stringify(summary)
    expect(text).not.toContain(ABSTRACT_ONLY_RESULT)
    expect(text).not.toContain('Body result')
    expect(summary.request.contentChars).toBe(plan.request.content.length)
    expect(summary.request.content).toBeUndefined()
  })
})

describe('verification can locate abstract-only values in the shared corpus', () => {
  const parts = abstractParts(xmlWith(STRUCTURED, BODY))
  const q = {
    name: 'fatal or disabling stroke', quantity_type: 'single', value: 1.16, unit: 'rate ratio',
    ci_low: 0.86, ci_high: 1.57, p_value: 0.33,
    source_quote: 'rate ratio 1.16, 95% CI 0.86-1.57; P=0.33',
  }
  it('is located when the abstract is part of the corpus', () => {
    const a = assembleExtractionSource({ text: 'Body without it.', abstractParts: parts })
    const v = verify(q, { text: a.corpusText, tables: a.tables }, { sourceTier: 'full_text' })
    expect(v.flagged).toBeFalsy()
    expect(v.tier).not.toBe(TIERS.FLAGGED)
  })
  it('is not located in the old body-only corpus (the demonstrated defect)', () => {
    const v = verify(q, { text: 'Body without it.', tables: '' }, { sourceTier: 'full_text' })
    expect(v.flagged).toBe(true)
  })
  it('existing body/table receipts still verify with the abstract present', () => {
    const sentence = 'Body result: patients in the synthetic cohort had a mean age of 69.1 years.'
    const a = assembleExtractionSource({ text: sentence, tables: 'Table 1\nAge | 69.1', abstractParts: parts })
    const qb = { name: 'patients in the synthetic cohort had a mean age', quantity_type: 'single', value: 69.1, unit: 'years', ci_low: null, ci_high: null, p_value: null, source_quote: sentence }
    const v = verify(qb, { text: a.corpusText, tables: a.tables }, { sourceTier: 'full_text' })
    expect(v.sourceLocated).toBe(true)
    expect(v.numericCoverage).toBe(true)
    expect(v.tier).not.toBe(TIERS.FLAGGED)
  })
})

describe('evidence window selection is unchanged by abstract inclusion', () => {
  it('still selects Results (not the Introduction) from the original body-only source', () => {
    const doc = parseDoc(xmlWith(STRUCTURED, BODY))
    const body = doc.querySelector('body').cloneNode(true)
    body.querySelectorAll('table-wrap').forEach((n) => n.remove())
    const source = { tier: 'full_text', text: body.textContent.replace(/\s+/g, ' ').trim(), sections: pmcSections(body), abstractParts: pmcAbstractParts(doc) }
    const w = selectEvidenceWindow(source)
    expect(w.text).not.toContain('PUBLISHER ABSTRACT')
    expect(w.kind).toBe('results')
    expect(w.text).toContain('Body result')
    expect(w.text).not.toContain('Synthetic background')
    expect(w.text.length).toBeLessThanOrEqual(2600)
    // assembling the corpus must not mutate the structure used by the window
    assembleExtractionSource(source)
    expect(selectEvidenceWindow(source)).toEqual(w)
  })
})

describe('production/eval parity', () => {
  it('planSinglePaper request content equals the shared assembly input exactly', async () => {
    const xml = xmlWith(STRUCTURED, BODY)
    const plan = await planSinglePaper({ caseId: 'ZZZ-1', pmid: '1', pmcXml: xml })
    const parts = abstractParts(xml)
    const doc = parseDoc(xml)
    const body = doc.querySelector('body').cloneNode(true)
    body.querySelectorAll('table-wrap').forEach((n) => n.remove())
    const text = body.textContent.replace(/\s+/g, ' ').trim()
    const tables = 'Table 1\nAge | 69.1'
    const expected = assembleExtractionSource({ text, tables, abstractParts: parts }).modelText
    expect(plan.request.content).toBe(`study_id: 1\n\nSOURCE TEXT:\n${expected}`)
    expect(plan.inputCoverage).toEqual({ abstractPresent: true, bodyPresent: true, tablesPresent: true, figureImageTextExtracted: false })
    expect(plan.request.content).toContain(ABSTRACT_ONLY_RESULT)
  })
  it('hash differs between an abstract and a no-abstract version of the same paper', async () => {
    const withAbs = await planSinglePaper({ caseId: 'ZZZ-1', pmid: '1', pmcXml: xmlWith(STRUCTURED, BODY) })
    const without = await planSinglePaper({ caseId: 'ZZZ-1', pmid: '1', pmcXml: xmlWith('', BODY) })
    expect(withAbs.extractionInputSha256).not.toBe(without.extractionInputSha256)
    expect(without.inputCoverage.abstractPresent).toBe(false)
  })
  it('a missing clinically required component stays a reviewer-attention omission, not detected by numeric verification', () => {
    // Accurate extraction of one outcome; a second outcome in the source is simply absent.
    const sentenceA = 'Outcome A in the synthetic trial was 4 vs 13 events in the treated and control groups.'
    const source = { text: `${sentenceA} Outcome B in the synthetic trial was 5 vs 12 events (P=0.15).`, tables: '' }
    const extracted = [{ name: 'Outcome A', quantity_type: 'comparison', first_value: 4, second_value: 13, source_quote: sentenceA }]
    const verdicts = extracted.map((qty) => verify(qty, source, { sourceTier: 'full_text' }))
    // The extracted outcome locates and its numbers are covered by the quote.
    expect(verdicts.every((v) => v.sourceLocated && v.numericCoverage)).toBe(true)
    // The omitted second outcome is invisible to the numeric gate: nothing was proposed for it.
    expect(extracted.some((qty) => /Outcome B/.test(JSON.stringify(qty)))).toBe(false)
  })
})
