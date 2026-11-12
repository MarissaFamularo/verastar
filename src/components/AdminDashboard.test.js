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
// The dashboard also loads the feedback inbox; these tests count the stats request only.
const statsCalls = () => mocks.rpc.mock.calls.filter(([name]) => name === 'beta_release_stats')
beforeEach(async () => {
  vi.clearAllMocks()
  dom = await mountDom()
})
afterEach(async () => { await dom.unmount() })

describe('AdminDashboard', () => {
  it('loads the default 30-day range once when shown, and renders every section', async () => {
    mocks.rpc.mockResolvedValue({ data: STATS, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    expect(statsCalls()).toHaveLength(1)
    const [name, args] = statsCalls()[0]
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
    expect(statsCalls()).toHaveLength(1)
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
    expect(statsCalls()).toHaveLength(1)
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
    expect(statsCalls()).toHaveLength(1)
    await dom.settle(() => pending.resolve({ data: STATS, error: null }))
    expect(dom.button('Update').getAttribute('aria-busy')).toBe('false')
  })

  it('reloads for a new range on Update', async () => {
    mocks.rpc.mockResolvedValue({ data: STATS, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    await dom.type(dom.q('input[aria-label="From date"]'), '2026-10-01')
    await dom.type(dom.q('input[aria-label="To date"]'), '2026-10-07')
    await dom.submit(dom.q('form'))
    expect(statsCalls()).toHaveLength(2)
    const args = statsCalls()[1][1]
    expect(Math.round((new Date(args.p_to) - new Date(args.p_from)) / 86_400_000)).toBe(7)
    expect(dom.text()).toContain('7 days')
  })
})

for (const [name, checks, expected] of [
  ['missing', [], 'Status unknown or stale'],
  ['fresh', ['signup','digest','heartbeat','schedule'].map(name=>({name,state:'ok',checked_at:new Date().toISOString()})), 'Monitor active · schedule on track'],
  ['stale', ['signup','digest','heartbeat','schedule'].map(name=>({name,state:'ok',checked_at:'2000-01-01T00:00:00Z'})), 'Status unknown or stale'],
  ['stale failure', [{name:'signup',state:'failed',checked_at:'2000-01-01T00:00:00Z'}], 'Needs attention'],
  ['sustained failure', [{name:'signup',state:'failed',checked_at:new Date().toISOString()}], 'Needs attention'],
]) it(`renders ${name} monitoring honestly`,async()=>{
  await dom.render(React.createElement(ReleaseOverview,{stats:{health:{checks},adoption:{eligible:0},spend:{completed:0}}}))
  expect(dom.text()).toContain(expected)
  expect(dom.text()).toContain('Insufficient history')
  expect(dom.text()).toContain('Unknown')
})

it('shows quiet schedule health separately from untested signup',async()=>{
 await dom.render(React.createElement(ReleaseOverview,{stats:{health:{checks:[{name:'signup',state:'unknown'}, {name:'digest',state:'ok',checked_at:'2000-01-01T00:00:00Z'}, ...['heartbeat','schedule'].map(name=>({name,state:'ok',checked_at:new Date().toISOString()}))]}}}))
 expect(dom.text()).toContain('Monitor active · schedule on track')
 expect(dom.text()).toContain('untested / no successful observation')
})

it('lists feedback with its sender and counts wrong-badge reports', async () => {
    const feedback = { messages: [{ at: '2026-10-18T21:51:04Z', email: 'reader@example.test', text: 'Line one\nLine two', view: 'settings', test: false }], wrong_total: 3, wrong_7d: 1 }
    mocks.rpc.mockImplementation(async (name) => name === 'beta_admin_feedback' ? { data: feedback, error: null } : { data: STATS, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    const inbox = dom.container.querySelector('section[aria-label="Feedback"]')
    expect(inbox.textContent).toContain('Line one')
    expect(inbox.querySelector('a[href="mailto:reader@example.test"]')).toBeTruthy()
    expect(dom.text()).toContain('“This is wrong” reports')
    expect(dom.text()).toContain('1 in the last 7 days')
  })

describe('Day-30 survey section', () => {
  const S30 = {
    eligible_now: 12, completed: 3,
    read_frequency: { weekly: 2, daily: 1 }, weekly_time: { '30_60m': 3 }, confidence: { 4: 2, 2: 1 },
    digest_fit: { 5: 1, 4: 2 }, if_gone: { very_disappointed: 2, stopped_using: 1 },
    paired: { n: 3, confidence: { up: 2, same: 0, down: 1 }, weekly_time: { more: 0, same: 1, less: 2 } },
  }
  const respond = (s30) => mocks.rpc.mockImplementation(async (name) =>
    name === 'beta_survey30_stats' ? s30 : name === 'beta_admin_feedback' ? { data: { messages: [] }, error: null } : { data: STATS, error: null })

  it('shows counts, the paired change, and the day-30 answer tables', async () => {
    respond({ data: S30, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    const s = dom.container.querySelector('section[aria-label="Day-30 survey"]')
    expect(s.textContent).toContain('3 of 12 accounts past day 30 have answered')
    expect(s.textContent).toContain('Change since signup (3 answered both)')
    expect(s.textContent).toContain('Higher 2')
    expect(s.textContent).toContain('Less 2')
    expect(s.textContent).toContain('How would you feel if you could no longer use Verastar?')
    expect(s.textContent).toContain('Very disappointed')
    expect(s.textContent).toContain('67%')
  })
  it('says when nobody has answered both, and says so when the stats fail', async () => {
    respond({ data: { ...S30, paired: { n: 0 } }, error: null })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    expect(dom.container.querySelector('section[aria-label="Day-30 survey"]').textContent).toContain('No account has completed both surveys yet.')
    await dom.unmount()
    dom = await mountDom()
    respond({ data: null, error: { code: 'PGRST202', message: 'missing' } })
    await dom.render(React.createElement(AdminDashboard, { active: true }))
    expect(dom.container.querySelector('section[aria-label="Day-30 survey"]').textContent).toContain('Not available')
  })
})
