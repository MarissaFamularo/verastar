import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { digestControlPolicy, scheduledDigestStatus, frozenDigestState, HELD_DIGEST_NOTE, ABANDONED_DIGEST_NOTE } from '../lib/digestStore.js'
import SpineCheck, {
  candidateDisplayScore,
  WhyPrompt,
  DigestRunControls,
  DigestContinuation,
  failedDigestResults,
  retryBaseSnapshot,
  ScanDetails,
} from './SpineCheck.jsx'
import { sourceExamplesVisible } from '../lib/sourceExamples.js'

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

  it('keeps source examples reachable when a failed run leaves no digest', () => {
    expect(sourceExamplesVisible({ demo: false, keySet: true, resultCount: 0 })).toBe(true)
    expect(sourceExamplesVisible({ demo: false, keySet: true, resultCount: 3 })).toBe(false)
    expect(sourceExamplesVisible({ demo: false, keySet: false, resultCount: 3 })).toBe(true)
    expect(sourceExamplesVisible({ demo: true, keySet: true, resultCount: 3 })).toBe(true)
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

// Held and stopped server digests: the controls a reader is offered, rendered as the screen
// renders them (the policy feeds the same two components). `keySet` true is the browser lane
// with a key or a sponsored proxy; the policy does not depend on the lane.
describe('controls for a held or stopped server digest', () => {
  const html = (el) => renderToStaticMarkup(el)
  const screen = ({ saved, missing = 0, failedCount = 0, incomplete = false, lockedToday = false, keySet = true }) => {
    const frozen = frozenDigestState(scheduledDigestStatus(saved))
    const controls = digestControlPolicy({ frozen, incomplete: incomplete && !frozen, missing, failedCount, lockedToday })
    return html(React.createElement('div', null,
      React.createElement(DigestRunControls, { failedCount: controls.failedCount, lockedToday: controls.lockedToday, keySet, busy: false }),
      React.createElement(DigestContinuation, { show: controls.showFinish, note: incomplete && !frozen ? 'short restore' : '', keySet, busy: false })))
  }
  const held = { kind: 'daily', runBy: 'scheduler', results: [], server: { phase: 'rank', held: { reason: 'unresolved_liability' } } }
  const abandoned = { kind: 'daily', runBy: 'scheduler', results: [], server: { phase: 'done', abandoned: true } }
  const browser = { kind: 'daily', runBy: 'user', results: [], server: null }

  for (const [lane, keySet] of [['sponsored lane', true], ['browser lane with a key', true], ['browser lane without a key', false]]) {
    it(`held partial digest (${lane}): no Finish, no retry, no run control`, () => {
      const out = screen({ saved: held, missing: 1, failedCount: 2, keySet })
      expect(out).not.toMatch(/Finish this digest|Retry|Run today|Start a new scan/)
    })
    it(`abandoned partial digest (${lane}): no Finish and no retry; the separate new-run control is as before`, () => {
      const out = screen({ saved: abandoned, missing: 1, failedCount: 2, keySet })
      expect(out).not.toMatch(/Finish this digest|Retry/)
      expect(out).toMatch(/Run today/) // starting a NEW scan is a different decision and is not redesigned here
    })
  }
  it('an ordinary browser digest with unranked papers still offers Finish', () => {
    expect(screen({ saved: browser, missing: 1 })).toMatch(/Finish this digest/)
    expect(screen({ saved: browser, incomplete: true })).toMatch(/short restore[\s\S]*Finish this digest/)
  })
  it('an ordinary browser digest with failed papers still offers retry', () => {
    expect(screen({ saved: browser, failedCount: 2 })).toMatch(/Retry 2 failed papers/)
  })
  it('an ordinary unfinished or finished server digest is not frozen', () => {
    expect(screen({ saved: { ...held, server: { phase: 'rank' } }, missing: 1 })).toMatch(/Finish this digest/)
    expect(screen({ saved: { ...held, server: { phase: 'done' } }, failedCount: 1 })).toMatch(/Retry 1 failed paper/)
  })
  it('the Finish block renders nothing when not shown, and the messages stay the existing ones', () => {
    expect(html(React.createElement(DigestContinuation, { show: false, note: 'x' }))).toBe('')
    expect(scheduledDigestStatus(held).note).toBe(HELD_DIGEST_NOTE)
    expect(scheduledDigestStatus(abandoned).note).toBe(ABANDONED_DIGEST_NOTE)
  })
})
