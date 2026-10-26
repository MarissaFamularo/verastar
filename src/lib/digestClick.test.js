// The signed click-through link (supabase/functions/_shared/digestClick.js), the function
// that records and redirects (digest-click/handler.js), and the pause email's resume
// button (_shared/unsubscribe.js resume helpers, digest-resume/handler.js).
import { describe, it, expect } from 'vitest'
import { signClick, verifyClick, clickUrl, CLICK_KINDS } from '../../supabase/functions/_shared/digestClick.js'
import { signResume, verifyResume, resumeUrl, signUnsubscribe, verifyUnsubscribe } from '../../supabase/functions/_shared/unsubscribe.js'
import { handleClick } from '../../supabase/functions/digest-click/handler.js'
import { handleResume } from '../../supabase/functions/digest-resume/handler.js'

const SECRET = 'a-long-enough-test-secret-value'
const USER = '41fd38b0-c67e-4ce1-a647-3612fbc6010e'
const OTHER = '41fd38b0-c67e-4ce1-a647-3612fbc6010f'
const FN = 'https://ref.supabase.co/functions/v1'
const TO = 'https://pubmed.ncbi.nlm.nih.gov/40000001/'
const NOW = new Date('2026-10-27T11:00:00Z')

// Just enough of supabase-js for the two handlers: update().eq()[.select()], insert().
function fakeAdmin({ row = { user_id: USER, enabled: true, paused_at: '2026-10-26T10:00:00Z', unopened_streak: 7, engaged_at: null }, failUpdate = false, throwEvents = false } = {}) {
  const t = { digest_schedules: row ? [row] : [], events: [] }
  const from = (table) => {
    let payload = null
    const filters = []
    const run = () => {
      if (failUpdate) return { data: null, error: { message: 'down' } }
      const hit = t[table].filter((r) => filters.every(([k, v]) => r[k] === v))
      for (const r of hit) Object.assign(r, payload)
      return { data: hit.map((r) => ({ ...r })), error: null }
    }
    const chain = {
      update: (p) => { payload = p; return chain },
      eq: (k, v) => { filters.push([k, v]); return chain },
      select: () => chain,
      insert: (r) => { if (throwEvents) throw new Error('events down'); t[table].push(r); return Promise.resolve({ error: null }) },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    }
    return chain
  }
  return { t, admin: { from } }
}

describe('signed click link', () => {
  it('signs and verifies the account, kind, paper and destination together', async () => {
    const link = { userId: USER, kind: 'paper', paperId: 'p1', to: TO }
    const token = await signClick(link, SECRET)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(await verifyClick({ ...link, token }, SECRET)).toEqual({ userId: USER, kind: 'paper', paperId: 'p1', to: TO })
    expect(await verifyClick({ ...link, userId: USER.toUpperCase(), token: token.toUpperCase() }, SECRET)).toBeTruthy()
    // Change any one part and the token no longer fits.
    expect(await verifyClick({ ...link, token, userId: OTHER }, SECRET)).toBeNull()
    expect(await verifyClick({ ...link, token, kind: 'fulltext' }, SECRET)).toBeNull()
    expect(await verifyClick({ ...link, token, paperId: 'p2' }, SECRET)).toBeNull()
    expect(await verifyClick({ ...link, token, to: 'https://evil.test/' }, SECRET)).toBeNull()
    expect(await verifyClick({ ...link, token }, 'another-secret-that-is-long')).toBeNull()
    expect(await verifyClick({ ...link, token: token.slice(0, 63) }, SECRET)).toBeNull()
    expect(await verifyClick({ ...link, token: '' }, SECRET)).toBeNull()
    expect(await verifyClick({ ...link, token }, '')).toBeNull()
  })
  it('refuses to sign anything odd', async () => {
    await expect(signClick({ userId: USER, kind: 'paper', to: TO }, 'short')).rejects.toThrow(/secret/)
    await expect(signClick({ userId: 'abc', kind: 'paper', to: TO }, SECRET)).rejects.toThrow(/uuid/)
    await expect(signClick({ userId: USER, kind: 'mystery', to: TO }, SECRET)).rejects.toThrow(/kind/)
    await expect(signClick({ userId: USER, kind: 'paper', paperId: 'a b<', to: TO }, SECRET)).rejects.toThrow(/paper id/)
    await expect(signClick({ userId: USER, kind: 'paper', to: 'javascript:alert(1)' }, SECRET)).rejects.toThrow(/http/)
    await expect(signClick({ userId: USER, kind: 'paper', to: 'not a url' }, SECRET)).rejects.toThrow(/http/)
    expect(CLICK_KINDS).toEqual(['paper', 'fulltext', 'open', 'pause-open'])
  })
  it('is not interchangeable with the unsubscribe or resume tokens', async () => {
    const unsub = await signUnsubscribe(USER, SECRET)
    const resume = await signResume(USER, SECRET)
    expect(unsub).not.toBe(resume)
    expect(await verifyResume(USER, unsub, SECRET)).toBe(false)
    expect(await verifyUnsubscribe(USER, resume, SECRET)).toBe(false)
    expect(await verifyClick({ userId: USER, kind: 'open', to: TO, token: unsub }, SECRET)).toBeNull()
  })
  it('builds the function url with every part in the query', async () => {
    const url = new URL(await clickUrl(`${FN}/`, { userId: USER, kind: 'fulltext', paperId: 'p1', to: 'https://pmc.test/a?b=1&c=2' }, SECRET))
    expect(`${url.origin}${url.pathname}`).toBe(`${FN}/digest-click`)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ u: USER, k: 'fulltext', p: 'p1', to: 'https://pmc.test/a?b=1&c=2' })
    const noPaper = new URL(await clickUrl(FN, { userId: USER, kind: 'open', to: 'https://app.test/?src=digest-email' }, SECRET))
    expect(noPaper.searchParams.has('p')).toBe(false)
  })
})

describe('digest-click', () => {
  const link = (over = {}) => clickUrl(FN, { userId: USER, kind: 'paper', paperId: 'p1', to: TO, ...over }, SECRET)
  it('records the click with the paper id, marks the account engaged, and redirects to the signed destination', async () => {
    const { t, admin } = fakeAdmin()
    const res = await handleClick(new Request(await link()), { admin, secret: SECRET, now: () => NOW })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(TO)
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(t.events).toEqual([{ user_id: USER, type: 'digest_link_clicked', payload: { paper_id: 'p1', kind: 'paper' } }])
    expect(t.digest_schedules[0].engaged_at).toBe(NOW.toISOString())
  })
  it('a link without a paper records a null paper id', async () => {
    const { t, admin } = fakeAdmin()
    await handleClick(new Request(await link({ kind: 'open', paperId: '', to: 'https://app.test/?src=digest-email' })), { admin, secret: SECRET })
    expect(t.events[0].payload).toEqual({ paper_id: null, kind: 'open' })
  })
  it('HEAD redirects without recording, so a link checker is not the reader', async () => {
    const { t, admin } = fakeAdmin()
    const res = await handleClick(new Request(await link(), { method: 'HEAD' }), { admin, secret: SECRET })
    expect(res.status).toBe(302)
    expect(t.events).toEqual([])
    expect(t.digest_schedules[0].engaged_at).toBeNull()
  })
  it('a tampered destination is a 400 page with no redirect and nothing recorded', async () => {
    const { t, admin } = fakeAdmin()
    const url = new URL(await link())
    url.searchParams.set('to', 'https://evil.test/')
    const res = await handleClick(new Request(url), { admin, secret: SECRET })
    expect(res.status).toBe(400)
    expect(res.headers.get('Location')).toBeNull()
    expect(await res.text()).toContain('This link is not valid')
    expect(t.events).toEqual([])
  })
  it('a database failure still sends the reader on', async () => {
    const { admin } = fakeAdmin({ failUpdate: true, throwEvents: true })
    const res = await handleClick(new Request(await link()), { admin, secret: SECRET })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe(TO)
  })
  it('no secret, wrong method', async () => {
    const { admin } = fakeAdmin()
    expect((await handleClick(new Request(await link()), { admin, secret: '' })).status).toBe(500)
    expect((await handleClick(new Request(await link(), { method: 'POST' }), { admin, secret: SECRET })).status).toBe(405)
  })
})

describe('digest-resume', () => {
  it('builds the function url', async () => {
    expect(await resumeUrl(`${FN}/`, USER, SECRET)).toBe(`${FN}/digest-resume?u=${USER}&t=${await signResume(USER, SECRET)}`)
  })
  it('clears the pause, resets the streak, marks the account engaged, logs the click, and confirms', async () => {
    const { t, admin } = fakeAdmin()
    const res = await handleResume(new Request(await resumeUrl(FN, USER, SECRET)), { admin, secret: SECRET, now: () => NOW })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Thanks. Your digest is back on')
    expect(t.digest_schedules[0]).toMatchObject({ paused_at: null, unopened_streak: 0, engaged_at: NOW.toISOString() })
    expect(t.events).toEqual([{ user_id: USER, type: 'digest_resume_clicked', payload: { via: 'link' } }])
  })
  it('a schedule switched off in Settings stays off, and the page says so', async () => {
    const { t, admin } = fakeAdmin({ row: { user_id: USER, enabled: false, paused_at: '2026-10-26T10:00:00Z', unopened_streak: 7 } })
    const res = await handleResume(new Request(await resumeUrl(FN, USER, SECRET)), { admin, secret: SECRET })
    expect(await res.text()).toContain('switched off under Settings')
    expect(t.digest_schedules[0]).toMatchObject({ enabled: false, paused_at: null })
  })
  it('HEAD changes nothing', async () => {
    const { t, admin } = fakeAdmin()
    await handleResume(new Request(await resumeUrl(FN, USER, SECRET), { method: 'HEAD' }), { admin, secret: SECRET })
    expect(t.digest_schedules[0].paused_at).toBeTruthy()
    expect(t.events).toEqual([])
  })
  it('a bad token, another account’s token, or an unsubscribe token changes nothing', async () => {
    for (const t of [await signResume(OTHER, SECRET), await signUnsubscribe(USER, SECRET), 'abc']) {
      const { t: db, admin } = fakeAdmin()
      const res = await handleResume(new Request(`${FN}/digest-resume?u=${USER}&t=${t}`), { admin, secret: SECRET })
      expect(res.status).toBe(400)
      expect(db.digest_schedules[0].paused_at).toBeTruthy()
      expect(db.events).toEqual([])
    }
  })
  it('a save failure asks to try again and logs nothing', async () => {
    const { t, admin } = fakeAdmin({ failUpdate: true })
    const res = await handleResume(new Request(await resumeUrl(FN, USER, SECRET)), { admin, secret: SECRET })
    expect(res.status).toBe(503)
    expect(t.events).toEqual([])
  })
})
