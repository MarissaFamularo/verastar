import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import SpineCheck, { candidateDisplayScore, ScanDetails } from './SpineCheck.jsx'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

describe('SpineCheck verifier proof', () => {
  beforeEach(() => {
    globalThis.sessionStorage = memoryStorage()
    globalThis.localStorage = memoryStorage()
  })

  it('keeps verifier proof reachable in the keyless sample profile', () => {
    const html = renderToStaticMarkup(React.createElement(SpineCheck, { demo: true }))

    expect(html).toContain('Sample digest · read only.')
    expect(html).toContain('Verifier proof')
    expect(html).not.toContain("Run today&#x27;s digest")
  })
})

describe('candidate funnel score', () => {
  const candidate = { id: 'paper-1', score: 45 }

  it('shows the post-read score after a paper has been processed', () => {
    expect(candidateDisplayScore(candidate, new Set(['paper-1']), { 'paper-1': { score: 58 } })).toBe(58)
  })

  it('keeps the screening score for an unread paper', () => {
    expect(candidateDisplayScore(candidate, new Set(), { 'paper-1': { score: 58 } })).toBe(45)
  })

  it('falls back to the screening score when reading finished before ranking', () => {
    expect(candidateDisplayScore(candidate, new Set(['paper-1']), {})).toBe(45)
  })
})

describe('completed scan disclosure', () => {
  it('keeps the scan receipt in the DOM but collapsed behind headline counts', () => {
    const html = renderToStaticMarkup(
      React.createElement(
        ScanDetails,
        { candidates: 70, digest: 8, open: false },
        React.createElement('p', null, 'Searched 9 topics over the last 3 days.'),
      ),
    )

    expect(html).toContain('<details')
    expect(html).not.toContain('<details open=""')
    expect(html).toContain('Today’s scan')
    expect(html).toContain('70 candidates · 8 in digest')
    expect(html).toContain('View details')
    expect(html).toContain('Searched 9 topics over the last 3 days.')
  })

  it('labels an opened receipt with the matching close action', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScanDetails, { candidates: 70, digest: 8, open: true }),
    )

    expect(html).toContain('<details open=""')
    expect(html).toContain('Hide details')
  })
})
