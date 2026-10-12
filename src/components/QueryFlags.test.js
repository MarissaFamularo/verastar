import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom } from '../test-utils/dom.js'

const sourceMocks = vi.hoisted(() => ({
  searchPubmed: vi.fn(),
  fetchCitations: vi.fn(),
  fetchAbstractsByPmid: vi.fn(),
}))

vi.mock('../pipeline/sources.js', () => ({
  searchPubmed: sourceMocks.searchPubmed,
  fetchCitations: sourceMocks.fetchCitations,
  fetchAbstractsByPmid: sourceMocks.fetchAbstractsByPmid,
  searchPaceMs: () => 0,
}))

import QueryFlags from './QueryFlags.jsx'

const topics = [
  {
    label: 'Limb preservation / CLTI / Diabetic foot',
    query: 'chronic limb-threatening ischemia OR CLTI OR diabetic foot OR amputation',
  },
  {
    label: 'Vascular access',
    query: 'arteriovenous fistula OR dialysis access OR vascular access',
  },
]

let dom

beforeEach(async () => {
  vi.clearAllMocks()
  dom = await mountDom()
  sourceMocks.searchPubmed.mockImplementation(async (term) => {
    if (String(term).includes('limb')) return ['burns', 'clti']
    return ['ccf', 'avf']
  })
  sourceMocks.fetchCitations.mockResolvedValue([
    { pmid: 'burns', title: 'Flap Reconstruction for Deep Hand Burns: A Case Series.', pubtypes: ['Journal Article'] },
    { pmid: 'clti', title: 'Outcomes of revascularization for chronic limb-threatening ischemia.', pubtypes: ['Journal Article'] },
    { pmid: 'ccf', title: 'Embolization of a traumatic carotid-cavernous fistula with a middle meningeal arteriovenous fistula.', pubtypes: ['Journal Article'] },
    { pmid: 'avf', title: 'Ultrasound-Guided Nerve Blocks for Arteriovenous Fistula Angioplasty.', pubtypes: ['Journal Article'] },
  ])
  sourceMocks.fetchAbstractsByPmid.mockResolvedValue({
    burns: 'Amputation was considered before flap coverage. Amputation was later declined.',
    clti: 'Chronic limb-threatening ischemia was treated with endovascular revascularization.',
    ccf: 'The traumatic carotid-cavernous fistula was embolized together with the middle meningeal arteriovenous fistula.',
    avf: 'Nerve blocks were used during arteriovenous fistula angioplasty.',
  })
})

afterEach(async () => { await dom.unmount() })

describe('Preview recent matches', () => {
  it('runs the 3-day compiled search and hides the off-topic beta papers', async () => {
    await dom.render(React.createElement(QueryFlags, { topics }))
    await dom.click(dom.button('Preview 10 recent matches'))

    expect(sourceMocks.searchPubmed).toHaveBeenCalledTimes(2)
    for (const call of sourceMocks.searchPubmed.mock.calls) {
      expect(call[0]).toContain('[tiab]')
      expect(call[1]).toMatchObject({ days: 3, retmax: 20 })
    }
    expect(sourceMocks.searchPubmed.mock.calls[0][0]).toBe(
      '"chronic limb threatening ischemia"[tiab] OR CLTI[tiab] OR "diabetic foot"[tiab] OR amputation[tiab]',
    )
    const text = dom.text()
    expect(text).toContain('Outcomes of revascularization for chronic limb-threatening ischemia.')
    expect(text).toContain('Ultrasound-Guided Nerve Blocks for Arteriovenous Fistula Angioplasty.')
    expect(text).not.toContain('Flap Reconstruction for Deep Hand Burns')
    expect(text).not.toContain('carotid-cavernous')
  })
})
