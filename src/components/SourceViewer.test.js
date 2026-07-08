// Locks the click-to-source highlight matcher — the demo's centerpiece must land the
// highlight on the right span every time.
import { describe, it, expect } from 'vitest'
import { findQuoteSpan } from './SourceViewer.jsx'

describe('findQuoteSpan', () => {
  it('finds an exact substring', () => {
    const corpus = 'Intro. The hazard ratio was 0.84 (P=0.22). Outro.'
    const span = findQuoteSpan(corpus, 'hazard ratio was 0.84')
    expect(span).not.toBeNull()
    expect(corpus.slice(span[0], span[1])).toBe('hazard ratio was 0.84')
  })

  it('tolerates line reflow / collapsed whitespace', () => {
    const corpus = 'The adjusted hazard\n   ratio  was 0.84 overall.'
    const span = findQuoteSpan(corpus, 'hazard ratio was 0.84')
    expect(span).not.toBeNull()
    expect(corpus.slice(span[0], span[1])).toMatch(/hazard\s+ratio\s+was 0\.84/)
  })

  it('finds a pipe-separated table quote (matches how we flatten tables)', () => {
    const tables = 'Primary outcome | Endovascular | 12.5 | Surgery | 14.1'
    const span = findQuoteSpan(tables, 'Endovascular | 12.5')
    expect(span).not.toBeNull()
    expect(tables.slice(span[0], span[1])).toBe('Endovascular | 12.5')
  })

  it('returns null when the quote is absent', () => {
    expect(findQuoteSpan('nothing relevant here', 'hazard ratio was 0.84')).toBeNull()
  })

  it('handles empty inputs without throwing', () => {
    expect(findQuoteSpan('', 'x')).toBeNull()
    expect(findQuoteSpan('abc', '')).toBeNull()
  })
})
