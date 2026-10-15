import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SharePaperButton, { paperShareDetails, sharePaper } from './SharePaperButton.jsx'

vi.mock('../lib/events.js', () => ({ logEvent: vi.fn() }))
import { logEvent } from '../lib/events.js'
beforeEach(() => vi.clearAllMocks())

const paper = {
  id: '42560069',
  pmid: '42560069',
  title: 'A paper worth sending',
  citation: {
    author: 'Morgan et al.',
    journal: 'Journal of Testing',
    year: '2026',
    url: 'https://pubmed.ncbi.nlm.nih.gov/42560069/',
  },
  oaUrl: 'https://example.org/full-text',
}

describe('paper sharing', () => {
  it('renders an accessible send action', () => {
    const html = renderToStaticMarkup(React.createElement(SharePaperButton, { paper, surface: 'digest' }))

    expect(html).toContain('Share ↑')
    expect(html).toContain('title="Send this article"')
    expect(html).toContain('aria-label="Share A paper worth sending"')
  })

  it('builds the share from the canonical citation rather than app state', () => {
    expect(paperShareDetails(paper)).toMatchObject({
      title: 'A paper worth sending',
      url: 'https://pubmed.ncbi.nlm.nih.gov/42560069/',
      text: 'A paper worth sending — Morgan et al. · Journal of Testing · 2026',
      fullTextUrl: 'https://example.org/full-text',
    })
  })

  it('uses the native share sheet when available', async () => {
    const nativeShare = vi.fn().mockResolvedValue(undefined)
    const location = { href: '' }

    await expect(sharePaper(paper, {
      surface: 'digest',
      navigatorObject: { share: nativeShare },
      locationObject: location,
    })).resolves.toBe('native')
    expect(nativeShare).toHaveBeenCalledWith({
      title: 'A paper worth sending',
      text: 'A paper worth sending — Morgan et al. · Journal of Testing · 2026',
      url: 'https://pubmed.ncbi.nlm.nih.gov/42560069/',
    })
    expect(location.href).toBe('')
    expect(logEvent).toHaveBeenCalledTimes(1)
    expect(logEvent).toHaveBeenCalledWith('paper_share_clicked', { surface: 'digest' })
  })

  it('opens an addressed-ready email when native sharing is unavailable', async () => {
    const location = { href: '' }

    await expect(sharePaper(paper, {
      navigatorObject: {},
      locationObject: location,
    })).resolves.toBe('mailto')
    expect(logEvent).toHaveBeenCalledTimes(1)
    expect(logEvent).toHaveBeenCalledWith('paper_share_clicked', { surface: 'library' })
    expect(location.href).toContain('mailto:?subject=A%20paper%20worth%20sending')
    expect(decodeURIComponent(location.href)).toContain('https://pubmed.ncbi.nlm.nih.gov/42560069/')
    expect(decodeURIComponent(location.href)).toContain('Full text: https://example.org/full-text')
  })

  it('does not open email after a cancelled native share sheet', async () => {
    const location = { href: '' }

    await expect(sharePaper(paper, {
      navigatorObject: { share: vi.fn().mockRejectedValue(new Error('AbortError')) },
      locationObject: location,
    })).resolves.toBe('cancelled')
    expect(location.href).toBe('')
    expect(logEvent).toHaveBeenCalledTimes(1)
    expect(logEvent).toHaveBeenCalledWith('paper_share_clicked', { surface: 'library' })
  })
  it('counts each button click once without waiting for telemetry', async () => {
    logEvent.mockReturnValue(new Promise(() => {}))
    const nativeShare = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { share: nativeShare })
    try {
      const button = SharePaperButton({ paper, surface: 'digest' })
      await button.props.onClick()
      await button.props.onClick()
      expect(nativeShare).toHaveBeenCalledTimes(2)
      expect(logEvent.mock.calls).toEqual([
        ['paper_share_clicked', { surface: 'digest' }],
        ['paper_share_clicked', { surface: 'digest' }],
      ])
    } finally { vi.unstubAllGlobals() }
  })
  it('counts a click even if sharing is unavailable', async () => {
    await expect(sharePaper(paper, { navigatorObject: {}, locationObject: null })).resolves.toBe('unavailable')
    expect(logEvent).toHaveBeenCalledTimes(1)
  })
})
