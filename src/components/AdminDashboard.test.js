import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountDom } from '../test-utils/dom.js'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../lib/supabase.js', () => ({
  supabaseConfigured: true,
  currentUser: () => ({ id: 'admin' }),
  supabase: { rpc: mocks.rpc },
}))

import { STATS } from '../lib/betaAdmin.fixture.js'
import AdminDashboard, { ReleaseOverview } from './AdminDashboard.jsx'

let dom
beforeEach(async () => {
  vi.clearAllMocks()
  dom = await mountDom()
})
afterEach(async () => { await dom.unmount() })

describe('AdminDashboard', () => {
  it('loads the default 30-day range once when shown, and renders every section', async () => {
    mocks.rpc.mockResolvedValue({ data: STATS, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    const [name, args] = mocks.rpc.mock.calls[0]
    expect(name).toBe('beta_release_stats')
    expect(Math.round((new Date(args.p_to) - new Date(args.p_from)) / 86_400_000)).toBe(30)
    for (const title of ['Beta users', 'Digest requests', 'Browser digest runs', 'Paper summaries', 'Digests opened', 'Verifier rejections', 'Survey answers']) {
      expect(dom.container.querySelector(`section[aria-label="${title}"]`)).toBeTruthy()
    }
    expect(dom.text()).toContain('Unique users who requested a digest')
    expect(dom.text()).toContain('Not available')
    expect(dom.text()).toContain('Stay current')
    expect(dom.text()).not.toContain('admin@') // no identities anywhere
  })

  it('does not load while hidden, then loads when activated', async () => {
    mocks.rpc.mockResolvedValue({ data: STATS, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: false }))
    expect(mocks.rpc).not.toHaveBeenCalled()
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('shows the server refusal for a non-admin', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'beta admin only' } })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    expect(dom.q('[role="alert"]').textContent).toContain('not on the beta admin list')
    expect(dom.container.querySelector('section')).toBeNull()
  })

  it('shows a retryable error for any other failure', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '500', message: 'down' } })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    expect(dom.q('[role="alert"]').textContent).toContain('could not be loaded (down)')
  })

  it('rejects a reversed range without calling the server', async () => {
    mocks.rpc.mockResolvedValue({ data: STATS, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    await dom.type(dom.q('input[aria-label="From date"]'), '2026-10-20')
    await dom.type(dom.q('input[aria-label="To date"]'), '2026-10-10')
    await dom.submit(dom.q('form'))
    expect(dom.q('[role="alert"]').textContent).toContain('end date is before the start date')
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('keeps Update focusable while loading and ignores a second submit', async () => {
    const { deferred } = await import('../test-utils/dom.js')
    const pending = deferred()
    mocks.rpc.mockReturnValue(pending.promise)
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    const button = dom.button('Loading')
    expect(button).toBeTruthy()
    expect(button.disabled).toBe(false) // a disabled control drops focus out of the settings dialog
    expect(button.getAttribute('aria-busy')).toBe('true')
    await dom.submit(dom.q('form'))
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
    await dom.settle(() => pending.resolve({ data: STATS, error: null }))
    expect(dom.button('Update').getAttribute('aria-busy')).toBe('false')
  })

  it('reloads for a new range on Update', async () => {
    mocks.rpc.mockResolvedValue({ data: STATS, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    await dom.type(dom.q('input[aria-label="From date"]'), '2026-10-01')
    await dom.type(dom.q('input[aria-label="To date"]'), '2026-10-07')
    await dom.submit(dom.q('form'))
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    const args = mocks.rpc.mock.calls[1][1]
    expect(Math.round((new Date(args.p_to) - new Date(args.p_from)) / 86_400_000)).toBe(7)
    expect(dom.text()).toContain('7 days')
  })
})

for (const [name, checks, expected] of [
  ['missing', [], 'Status unknown or stale'],
  ['fresh', ['signup','digest','heartbeat'].map(name=>({name,state:'ok',checked_at:new Date().toISOString()})), 'Monitored checks passing'],
  ['stale', ['signup','digest','heartbeat'].map(name=>({name,state:'ok',checked_at:'2000-01-01T00:00:00Z'})), 'Status unknown or stale'],
  ['stale failure', [{name:'signup',state:'failed',checked_at:'2000-01-01T00:00:00Z'}], 'Status unknown or stale'],
  ['sustained failure', [{name:'signup',state:'failed',checked_at:new Date().toISOString()}], 'Needs attention'],
]) it(`renders ${name} monitoring honestly`,async()=>{
  await dom.render(React.createElement(ReleaseOverview,{stats:{health:{checks},adoption:{eligible:0},spend:{completed:0}}}))
  expect(dom.text()).toContain(expected)
  expect(dom.text()).toContain('Insufficient history')
  expect(dom.text()).toContain('Unknown')
})
