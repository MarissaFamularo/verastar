import { SECTION_WINDOW_CHARS } from './evidenceWindow.js'
// The shared Results/Abstract evidence window (evidenceWindow.js) and the PMC structure it
// reads (sources.js). Every paper below is a SYNTHETIC fixture written for these tests —
// the wording, numbers and citations are invented, not quoted from a publication. XML is
// parsed with linkedom, the DOM the scheduled digest uses on the server.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DOMParser } from 'linkedom'

const anthropic = vi.hoisted(() => ({ extractStructured: vi.fn() }))
vi.mock('../lib/anthropic.js', async (importOriginal) => ({ ...(await importOriginal()), extractStructured: anthropic.extractStructured }))

import { selectEvidenceWindow, evidenceWindowFor, evidenceSummary, parseAbstractText, sectionKind, EVIDENCE_WINDOW_VERSION } from './evidenceWindow.js'
import { fetchPmcFullText, pmcSections, pmcAbstractParts } from './sources.js'
import { SNIPPET_CHARS } from './check.js'
import { triage } from './triage.js'
import { verify, TIERS } from './verify.js'

// SYNTHETIC: an Introduction that prints another trial's hazard ratio (the misleading
// background number), a Methods section, the paper's own Results, and a Discussion whose
// subsection title contains the word "results".
const INTRO_HR = 'An earlier trial reported a hazard ratio of 0.50 (95% CI 0.40-0.62) for death with drug Q [3].'
const OWN_RESULT = 'Among 812 randomized patients, the primary endpoint occurred in 61 of 405 patients assigned to stenting and 58 of 407 assigned to surgery (hazard ratio 1.05, 95% CI 0.74-1.49).'
const SYNTH_PMC = `<?xml version="1.0"?>
<pmc-articleset><article>
<front><article-meta>
  <abstract abstract-type="graphical"><p>Graphical abstract text.</p></abstract>
  <abstract>
    <sec><title>Background</title><p>Synthetic background sentence.</p></sec>
    <sec><title>Methods</title><p>We randomly assigned adults with condition Z to stenting or surgery at 30 centers.</p></sec>
    <sec><title>Results</title><p>The primary endpoint did not differ between groups.</p></sec>
    <sec><title>Conclusions</title><p>Stenting and surgery had similar outcomes.</p></sec>
  </abstract>
</article-meta></front>
<body>
  <sec sec-type="intro"><title>Introduction</title><p>${INTRO_HR} Prior work is mixed.</p></sec>
  <sec sec-type="methods"><title>Methods</title><p>Synthetic design: a randomized trial in adults with condition Z.</p></sec>
  <sec sec-type="results"><title>Results</title>
    <sec><title>Patients</title><p>${OWN_RESULT}</p></sec>
    <table-wrap><label>Table 1</label><table><tr><td>Age</td><td>69.1</td></tr></table></table-wrap>
  </sec>
  <sec sec-type="discussion"><title>Discussion</title>
    <sec><title>Comparison with previous results</title><p>Unlike the hazard ratio of 0.50 in the earlier trial, ours was neutral.</p></sec>
  </sec>
</body></article></pmc-articleset>`

const parse = (xml) => new DOMParser().parseFromString(xml, 'text/xml')

describe('sectionKind', () => {
  it('reads labels and JATS sec-types', () => {
    expect(sectionKind('Results')).toBe('results')
    expect(sectionKind('3. Results')).toBe('results')
    expect(sectionKind('Results and Discussion')).toBe('results')
    expect(sectionKind('Main findings')).toBe('results')
    expect(sectionKind('', 'results|discussion')).toBe('results')
    expect(sectionKind('DESIGN, SETTING, AND PARTICIPANTS')).toBe('methods')
    expect(sectionKind('MAIN OUTCOMES AND MEASURES')).toBe('methods')
    expect(sectionKind('CONCLUSIONS AND RELEVANCE')).toBe('conclusions')
    expect(sectionKind('Introduction')).toBe('background')
  })
  it('does not take a Discussion subsection that mentions results for the Results', () => {
    expect(sectionKind('Comparison with previous results')).toBe('other')
    expect(sectionKind('Interpretation of results')).not.toBe('results')
  })
})

describe('PMC structure (sources.js, linkedom)', () => {
  it('finds the outermost Results and blocks "results" inside the Discussion', () => {
    const doc = parse(SYNTH_PMC)
    const body = doc.querySelector('body').cloneNode(true)
    body.querySelectorAll('table-wrap').forEach((n) => n.remove())
    const sections = pmcSections(body)
    const results = sections.filter((s) => s.kind === 'results')
    expect(results).toHaveLength(1)
    expect(results[0].label).toBe('Results')
    expect(results[0].text).toContain(OWN_RESULT)
    expect(results[0].text).not.toContain('69.1') // tables stay out of prose
    expect(sections.find((s) => s.label === 'Comparison with previous results').kind).toBe('other')
  })
  it('reads the main structured abstract and skips the graphical one', () => {
    const parts = pmcAbstractParts(parse(SYNTH_PMC))
    expect(parts.map((p) => p.label)).toEqual(['Background', 'Methods', 'Results', 'Conclusions'])
    expect(parts.some((p) => /Graphical/.test(p.text))).toBe(false)
  })
})

describe('fetchPmcFullText keeps the verification corpus byte-for-byte', () => {
  const realFetch = globalThis.fetch
  const realParser = globalThis.DOMParser
  beforeEach(() => {
    globalThis.DOMParser = DOMParser
    globalThis.fetch = vi.fn(async () => ({ ok: true, text: async () => SYNTH_PMC }))
  })
  afterEach(() => {
    globalThis.fetch = realFetch
    globalThis.DOMParser = realParser
  })
  it('text/tables are what the pre-window parser produced; structure rides alongside', async () => {
    const full = await fetchPmcFullText('PMC0000000')
    // The pre-window computation, inlined: body minus table-wraps, whitespace-collapsed.
    const body = parse(SYNTH_PMC).querySelector('body').cloneNode(true)
    body.querySelectorAll('table-wrap').forEach((n) => n.remove())
    expect(full.text).toBe(body.textContent.replace(/\s+/g, ' ').trim())
    expect(full.text).toContain(INTRO_HR) // the complete corpus, Introduction included
    expect(full.tables).toContain('Age | 69.1')
    expect(full.sections.some((s) => s.kind === 'results')).toBe(true)
    expect(full.abstractParts).toHaveLength(4)
  })
})

describe('selectEvidenceWindow — full text', () => {
  const doc = parse(SYNTH_PMC)
  const body = doc.querySelector('body').cloneNode(true)
  body.querySelectorAll('table-wrap').forEach((n) => n.remove())
  const source = { tier: 'full_text', text: body.textContent.replace(/\s+/g, ' ').trim(), sections: pmcSections(body), abstractParts: pmcAbstractParts(doc) }

  it('selects the paper\'s own Results, never the misleading Introduction', () => {
    const w = selectEvidenceWindow(source)
    expect(w.kind).toBe('results')
    expect(w.version).toBe(EVIDENCE_WINDOW_VERSION)
    expect(w.text).toContain(OWN_RESULT)
    expect(w.text).not.toContain('0.50')
    expect(w.text).not.toContain('[3]')
    expect(w.text).not.toContain('Unlike the hazard ratio')
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
  })
  it('carries study-design context, labelled as coming from the abstract', () => {
    const w = selectEvidenceWindow(source)
    expect(w.text).toContain('METHODS (abstract): We randomly assigned adults')
    expect(w.text.indexOf('METHODS')).toBeLessThan(w.text.indexOf('RESULTS'))
    expect(w.parts.map((p) => p.kind)).toEqual(['methods', 'results'])
  })
  it('the old body-prefix window would have been the Introduction (why this exists)', () => {
    expect(source.text.slice(0, SNIPPET_CHARS)).toContain('0.50 (95% CI 0.40-0.62)')
  })
  it('stays inside the unchanged budget when Results are long', () => {
    const long = { ...source, abstractParts: source.abstractParts.filter((p) => p.label !== 'Results'), sections: [{ label: 'Results', kind: 'results', text: `${OWN_RESULT} `.repeat(40) }] }
    const w = selectEvidenceWindow(long)
    expect(SECTION_WINDOW_CHARS).toBe(2600)
    expect(w.text.length).toBeLessThanOrEqual(SECTION_WINDOW_CHARS)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(w.text).toMatch(/…$/)
    expect(w.text).toContain('METHODS (abstract)')
  })
  it('keeps a combined Results and Discussion and says so', () => {
    const w = selectEvidenceWindow({ ...source, sections: [{ label: 'Results and Discussion', kind: 'results', text: OWN_RESULT }] })
    expect(w.kind).toBe('results')
    expect(w.combinedWithDiscussion).toBe(true)
    expect(w.text).toContain('RESULTS AND DISCUSSION: ')
  })
  it('uses the body Methods opening for context when the abstract has none', () => {
    const w = selectEvidenceWindow({ ...source, abstractParts: [] })
    expect(w.text).toContain('METHODS: Synthetic design')
  })
  it('falls back to the abstract, labelled as the abstract, when no Results section exists', () => {
    const w = selectEvidenceWindow({ ...source, sections: source.sections.filter((s) => s.kind !== 'results') })
    expect(w.kind).toBe('abstract')
    expect(w.text).toMatch(/^\[Evidence window: the paper's abstract\]/)
    expect(w.text).toContain('RESULTS: The primary endpoint did not differ')
    expect(w.text).not.toContain(INTRO_HR)
    expect(w.reason).toMatch(/No Results section identified/)
  })
  it('is explicitly unavailable — not a body prefix — with neither Results nor an abstract', () => {
    const w = selectEvidenceWindow({ ...source, sections: [{ label: 'Introduction', kind: 'background', text: INTRO_HR }], abstractParts: [] })
    expect(w).toMatchObject({ kind: 'unavailable', limited: true, text: '' })
  })
})

describe('selectEvidenceWindow — abstracts', () => {
  // SYNTHETIC PubMed plain-text record, already through cleanAbstractText.
  const STRUCTURED = [
    'Synthetic title of a trial.',
    `BACKGROUND: ${'Background prose about a condition. '.repeat(40)}`,
    'METHODS: Adults with condition Z were randomized at 30 centers.',
    `RESULTS: ${OWN_RESULT}`,
    'CONCLUSIONS: Outcomes were similar.',
  ].join('\n\n')

  it('parses labels and drops the title block', () => {
    const { structured, parts } = parseAbstractText(STRUCTURED)
    expect(structured).toBe(true)
    expect(parts.map((p) => p.kind)).toEqual(['background', 'methods', 'results', 'conclusions'])
  })
  it('keeps Results whole and trims a long Background first, within budget', () => {
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: STRUCTURED })
    expect(w.kind).toBe('abstract')
    expect(w.structured).toBe(true)
    expect(w.text).toContain(`RESULTS: ${OWN_RESULT}`)
    expect(w.text).toContain('METHODS: Adults')
    expect(w.text).toContain('CONCLUSIONS: Outcomes were similar.')
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    const bg = w.parts.find((p) => p.kind === 'background')
    expect(bg.chars).toBeLessThan(400)
    // Reading order is the abstract's own.
    expect(w.text.indexOf('BACKGROUND')).toBeLessThan(w.text.indexOf('METHODS'))
  })
  it('an unstructured abstract is the abstract, not "Results"', () => {
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: `Synthetic title.\n\n${OWN_RESULT} Outcomes were similar.` })
    expect(w).toMatchObject({ kind: 'abstract', structured: false, hasResults: false })
    expect(w.text).not.toMatch(/RESULTS/)
    expect(w.text).toContain(OWN_RESULT)
  })
  it('a structured abstract with no Results says so', () => {
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: 'T.\n\nBACKGROUND: Some context here for a review.\n\nCONCLUSIONS: A narrative review conclusion sentence.' })
    expect(w.hasResults).toBe(false)
    expect(w.reason).toMatch(/no Results section/)
  })
  it('an uploaded PDF is a limited, explicitly labelled opening', () => {
    const w = selectEvidenceWindow({ tier: 'user_text', text: `${INTRO_HR} ${OWN_RESULT}` })
    expect(w).toMatchObject({ kind: 'opening', limited: true })
    expect(w.text).toMatch(/^\[Evidence window: opening of the supplied text\. Sections were not identified; this is not necessarily the Results\]/)
  })
})

describe('old rows (saved before windows existed)', () => {
  it('a full-text row is explicitly unavailable, never its saved body prefix', () => {
    const old = { source: { tier: 'full_text' }, sourceDoc: { text: `${INTRO_HR} ${OWN_RESULT}`, tables: '' } }
    const w = evidenceWindowFor(old)
    expect(w).toMatchObject({ kind: 'unavailable', limited: true, legacy: true, text: '' })
    expect(evidenceSummary(old)).toBe('')
  })
  it('an abstract-only row is rebuilt from its saved abstract with no fetch', () => {
    const old = { source: { tier: 'abstract_only' }, sourceDoc: { text: `T.\n\nMETHODS: Adults were randomized.\n\nRESULTS: ${OWN_RESULT}`, tables: '' } }
    const w = evidenceWindowFor(old)
    expect(w).toMatchObject({ kind: 'abstract', legacy: true })
    expect(w.text).toContain(OWN_RESULT)
  })
  it('a stored window of the current version is used as stored', () => {
    const stored = { version: EVIDENCE_WINDOW_VERSION, kind: 'results', text: 'stored window' }
    expect(evidenceWindowFor({ evidenceWindow: stored, sourceDoc: { text: 'body' } })).toBe(stored)
  })
  it('a stored window of an unknown version is rebuilt, not trusted', () => {
    const w = evidenceWindowFor({ evidenceWindow: { version: 'future', text: 'x' }, source: { tier: 'full_text' }, sourceDoc: { text: INTRO_HR } })
    expect(w.kind).toBe('unavailable')
  })
})

describe('the window never touches verification', () => {
  it('a value printed only in the Introduction still verifies against the full corpus', () => {
    // The window excludes the Introduction from ranking prose; the verifier corpus does not.
    const q = { name: 'death', quantity_type: 'single', value: 0.5, unit: 'HR', ci_low: 0.4, ci_high: 0.62, p_value: null, source_quote: 'a hazard ratio of 0.50 (95% CI 0.40-0.62)' }
    expect(verify(q, { text: `${INTRO_HR} ${OWN_RESULT}`, tables: '' }, { sourceTier: 'full_text' }).tier).toBe(TIERS.ESTIMATE)
  })
})

describe('writer/checker parity through triage()', () => {
  beforeEach(() => { anthropic.extractStructured.mockReset() })
  it('the checker audits exactly the window the writer was shown', async () => {
    const window = selectEvidenceWindow({ tier: 'abstract_only', text: `T.\n\nMETHODS: Adults were randomized.\n\nRESULTS: ${OWN_RESULT}` })
    const calls = []
    anthropic.extractStructured.mockImplementation(async (args) => {
      calls.push(args)
      if (args.schema?.properties?.rankings) {
        return { rankings: [{ id: '1', score: 80, tier: 1, finding: 'Outcomes were similar.', finding_plain: 'Outcomes were similar.', design_caution: '', relevance: 'r' }] }
      }
      return { verdicts: [{ id: '1', supported: true, reason: 'ok' }] }
    })
    await triage({ candidates: [{ id: '1', title: 'T', design: 'RCT', summary: window.text, verified: [] }] })
    const [writer, checker] = calls
    expect(writer.content).toContain(window.text)
    expect(checker.content).toContain(`SNIPPET:\n${window.text}\nCLAIMS:`)
    expect(window.text.length).toBeLessThanOrEqual(SNIPPET_CHARS) // neither side truncates it differently
  })
})

describe('Results subsections — the primary outcome gets first claim', () => {
  // SYNTHETIC: Results that open with a long enrolment/flow subsection, as many trials do.
  const FLOW = 'From 2000 through 2008, patients were randomly assigned; some withdrew consent and some crossed over. '.repeat(30)
  const PRIMARY = 'The primary end point did not differ between groups (hazard ratio, 1.11; 95% CI, 0.81 to 1.51; P = 0.51).'
  const SECONDARY = 'Secondary end points favoured neither group.'
  const xml = `<?xml version="1.0"?><pmc-articleset><article><front><article-meta></article-meta></front><body>
    <sec sec-type="results"><title>Results</title>
      <sec><title>Study population</title><p>${FLOW}</p></sec>
      <sec><title>Secondary end points</title><p>${SECONDARY}</p></sec>
      <sec><title>Primary end point</title><p>${PRIMARY}</p></sec>
    </sec></body></article></pmc-articleset>`
  const doc = parse(xml)
  const sections = pmcSections(doc.querySelector('body'))

  it('records each subsection\'s parent', () => {
    const results = sections.findIndex((s) => s.kind === 'results')
    expect(sections.filter((s) => s.parent === results).map((s) => s.label)).toEqual(['Study population', 'Secondary end points', 'Primary end point'])
  })
  it('keeps the primary result even when the flow subsection alone exceeds the budget', () => {
    const w = selectEvidenceWindow({ tier: 'full_text', sections, abstractParts: [] })
    expect(w.text).toContain(PRIMARY)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    const kinds = Object.fromEntries(w.parts.map((p) => [p.label, p.kind]))
    expect(kinds['Results › Primary end point']).toBe('results-primary')
    expect(kinds['Results › Secondary end points']).toBe('results-other')
    expect(w.parts.find((p) => p.kind === 'results-population').chars).toBeLessThanOrEqual(500)
    // Source order is preserved for reading.
    expect(w.text.indexOf('STUDY POPULATION')).toBeLessThan(w.text.indexOf('PRIMARY END POINT'))
    expect(w.hasResults).toBe(true)
  })
  it('without a primary-outcome subsection, Results are read from the top as before', () => {
    const noPrimary = sections.filter((s) => s.label !== 'Primary end point')
    const w = selectEvidenceWindow({ tier: 'full_text', sections: noPrimary, abstractParts: [] })
    expect(w.parts.map((p) => p.kind)).toEqual(['results'])
  })
})

// Codex R2 review P1 (2026-10-09): the Methods cap applied per part, and every Methods part
// outranked Results, so an abstract with several design labels pushed Results out of the
// window entirely. Design context now shares ONE aggregate budget; Results keep the rest
// of the unchanged total. Synthetic fixtures.
describe('aggregate design-context budget — Results are never crowded out (Codex R2)', () => {
  const LABELS = ['DESIGN', 'SETTING', 'PARTICIPANTS', 'INTERVENTIONS', 'MAIN OUTCOME MEASURES']
  const CONTEXT = 'Study design context. '.repeat(35)
  const RESULT = 'The primary endpoint did not differ between groups.'
  const pubmed = (results) => [...LABELS.map((l) => `${l}: ${CONTEXT}`), ...results.map((r) => `RESULTS: ${r}`)].join('\n\n')
  const designChars = (w) => w.parts.filter((p) => p.kind === 'methods' || p.kind === 'objective').reduce((n, p) => n + p.chars + 1, 0)

  it('PubMed text: the Codex reproduction keeps its Results', () => {
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: pubmed([RESULT]) })
    expect(w.hasResults).toBe(true)
    expect(w.text).toContain(`RESULTS: ${RESULT}`)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(designChars(w)).toBeLessThanOrEqual(600)
  })
  it('PMC abstract fallback (full text without Results) keeps its Results', () => {
    const abstractParts = [...LABELS.map((label) => ({ label, text: CONTEXT })), { label: 'Results', text: RESULT }]
    const w = selectEvidenceWindow({ tier: 'full_text', sections: [{ label: 'Introduction', kind: 'background', text: 'x' }], abstractParts })
    expect(w.kind).toBe('abstract')
    expect(w.text).toContain(`RESULTS: ${RESULT}`)
    expect(designChars(w)).toBeLessThanOrEqual(600)
  })
  it('full text: several abstract design labels stay within the aggregate context budget', () => {
    const abstractParts = LABELS.map((label) => ({ label, text: CONTEXT }))
    const w = selectEvidenceWindow({ tier: 'full_text', sections: [{ label: 'Results', kind: 'results', depth: 0, parent: -1, text: `${RESULT} `.repeat(60) }], abstractParts })
    expect(designChars(w)).toBeLessThanOrEqual(600)
    expect(w.parts.find((p) => p.kind === 'results').chars).toBeGreaterThan(1800)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
  })
  it('long Results are truncated, never absent, and the total budget is unchanged', () => {
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: pubmed([`${RESULT} `.repeat(100)]) })
    expect(w.hasResults).toBe(true)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
    expect(SECTION_WINDOW_CHARS).toBe(2600)
    expect(w.text.length).toBeLessThanOrEqual(SECTION_WINDOW_CHARS)
  })
  it('a very short Results part is still included', () => {
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: pubmed(['No change.']) })
    expect(w.text).toContain('RESULTS: No change.')
  })
  it('zero Results: design context may use the whole budget, and the window says Results are missing', () => {
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: pubmed([]) })
    expect(w.hasResults).toBe(false)
    expect(w.reason).toMatch(/no Results section/)
    expect(w.text.length).toBeGreaterThan(1500)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
  })
  it('multiple Results parts share the Results budget; none is dropped', () => {
    const long = `${RESULT} `.repeat(60)
    const w = selectEvidenceWindow({ tier: 'abstract_only', text: [`METHODS: ${CONTEXT}`, `RESULTS: First ${long}`, `FINDINGS: Second ${long}`].join('\n\n') })
    const results = w.parts.filter((p) => p.kind === 'results')
    expect(results).toHaveLength(2)
    expect(Math.min(...results.map((p) => p.chars))).toBeGreaterThan(700)
    expect(w.text.length).toBeLessThanOrEqual(SNIPPET_CHARS)
  })
})
