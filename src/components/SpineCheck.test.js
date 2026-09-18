import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import SpineCheck, {
  candidateDisplayScore,
  WhyPrompt,
  DigestRunControls,
  failedDigestResults,
  retryBaseSnapshot,
  ScanDetails,
} from './SpineCheck.jsx'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

describe('SpineCheck source examples', () => {
  beforeEach(() => {
    globalThis.sessionStorage = memoryStorage()
    globalThis.localStorage = memoryStorage()
  })

  it('keeps clearly labeled source examples reachable in the keyless sample profile', () => {
    const html = renderToStaticMarkup(React.createElement(SpineCheck, { demo: true }))

    expect(html).toContain('Sample digest · read only.')
    expect(html).toContain('Source examples')
    expect(html).toContain('Precomputed trial examples; inspect the original source before use')
    expect(html).not.toContain('Verifier proof')
    expect(html).not.toContain('guarantees')
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
    expect(html).toContain('Picked 8 of 70 new papers')
    expect(html).toContain('See all 70')
    expect(html).toContain('Searched 9 topics over the last 3 days.')
  })

  it('labels an opened receipt with the matching close action', () => {
    const html = renderToStaticMarkup(
      React.createElement(ScanDetails, { candidates: 70, digest: 8, open: true }),
    )

    expect(html).toContain('<details open=""')
    expect(html).toContain('>Hide<')
  })
})

describe('failed digest retry', () => {
  const success = { paper: { id: 'ok' }, rows: [] }
  const failed = { paper: { id: 'failed' }, error: 'Unexpected end of JSON input', rows: [] }
  const excludedButProcessed = { paper: { id: 'below-floor' }, rows: [] }

  it('identifies only visible non-retraction failures', () => {
    expect(failedDigestResults([success, failed, { ...failed, retracted: true }])).toEqual([failed])
  })

  it('removes only failed attempts from the retry base', () => {
    const snapshot = retryBaseSnapshot({
      results: [success, failed],
      processedResults: [success, failed, excludedButProcessed],
      triaged: { ok: { score: 80 } },
    })

    expect(snapshot.results).toEqual([success])
    expect(snapshot.processedResults).toEqual([success, excludedButProcessed])
    expect([...snapshot.failedIds]).toEqual(['failed'])
    expect(snapshot.triaged).toEqual({ ok: { score: 80 } })
  })

  it('makes retry primary and warns that a new scan replaces the digest', () => {
    const html = renderToStaticMarkup(React.createElement(DigestRunControls, {
      failedCount: 1,
      hasExistingScan: true,
      keySet: true,
    }))

    expect(html).toContain('Retry 1 failed paper')
    expect(html).toContain('Start a new scan')
    expect(html).toContain('new unseen-paper pool and replaces the digest on screen')
    expect(html).not.toContain("Run today&#x27;s digest")
  })

  it('withholds the new-scan button while today\'s digest is on screen', () => {
    const html = renderToStaticMarkup(React.createElement(DigestRunControls, {
      hasExistingScan: true,
      lockedToday: true,
      paperCount: 6,
      keySet: true,
    }))

    // One digest a day: with today's digest on screen there is no run control at all.
    expect(html).toBe('')
  })

  it('keeps retry primary but also withholds the plain new-scan path on the same day', () => {
    const html = renderToStaticMarkup(React.createElement(DigestRunControls, {
      failedCount: 2,
      hasExistingScan: true,
      lockedToday: true,
      paperCount: 4,
      keySet: true,
    }))

    expect(html).toContain('Retry 2 failed papers')
    expect(html).not.toContain('Start a new scan')
    expect(html).not.toContain('Replace today')
  })
})

describe('WhyPrompt', () => {
  it('renders the skippable one-line why prompt', () => {
    const html = renderToStaticMarkup(React.createElement(WhyPrompt, { onSave() {}, onSkip() {}, autoFocus: false }))
    expect(html).toContain('Why this one?')
    expect(html).toContain('Skip')
    expect(html).toContain('maxLength="280"')
  })
})
