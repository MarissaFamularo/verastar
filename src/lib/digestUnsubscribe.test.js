// The signed unsubscribe link (supabase/functions/_shared/unsubscribe.js) and the function
// that honours it (supabase/functions/digest-unsubscribe/handler.js).
import { describe, it, expect } from 'vitest'
import { signUnsubscribe, verifyUnsubscribe, unsubscribeUrl } from '../../supabase/functions/_shared/unsubscribe.js'
import { handleUnsubscribe } from '../../supabase/functions/digest-unsubscribe/handler.js'

const SECRET = 'a-long-enough-test-secret-value'
const USER = '41fd38b0-c67e-4ce1-a647-3612fbc6010e'

describe('signed link', () => {
  it('signs a uuid, verifies it, and refuses anything else', async () => {
    const t = await signUnsubscribe(USER, SECRET)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(await verifyUnsubscribe(USER, t, SECRET)).toBe(true)
    expect(await verifyUnsubscribe(USER.toUpperCase(), t.toUpperCase(), SECRET)).toBe(true)
    expect(await verifyUnsubscribe(USER, t, 'another-secret-that-is-long')).toBe(false)
    expect(await verifyUnsubscribe('41fd38b0-c67e-4ce1-a647-3612fbc6010f', t, SECRET)).toBe(false)
    expect(await verifyUnsubscribe(USER, t.slice(0, 63), SECRET)).toBe(false)
    expect(await verifyUnsubscribe(USER, '', SECRET)).toBe(false)
    expect(await verifyUnsubscribe('not-a-uuid', t, SECRET)).toBe(false)
    expect(await verifyUnsubscribe(USER, t, '')).toBe(false)
  })
  it('refuses a short secret and a non-uuid at signing time', async () => {
    await expect(signUnsubscribe(USER, 'short')).rejects.toThrow(/secret/)
    await expect(signUnsubscribe('abc', SECRET)).rejects.toThrow(/uuid/)
  })
  it('builds the function url', async () => {
    const url = await unsubscribeUrl('https://ref.supabase.co/functions/v1/', USER, SECRET)
    expect(url).toBe(`https://ref.supabase.co/functions/v1/digest-unsubscribe?u=${USER}&t=${await signUnsubscribe(USER, SECRET)}`)
  })
})

function fakeAdmin({ hasRow = true, updateError = null } = {}) {
  const t = { digest_schedules: hasRow ? [{ user_id: USER, enabled: true, email_digest: true }] : [], events: [] }
  const from = (table) => {
    let filters = []
    let payload = null
    let op = 'select'
    const rows = () => t[table].filter((r) => filters.every((f) => f(r)))
    const chain = {
      update: (p) => { op = 'update'; payload = p; return chain },
      eq: (k, v) => { filters.push((r) => r[k] === v); return chain },
      select: () => chain,
      insert: (row) => { if (table === 'digest_schedules' && t[table].some((r) => r.user_id === row.user_id)) return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } }); t[table].push(row); return Promise.resolve({ error: null }) },
      then: (res, rej) => {
        if (op === 'update') {
          if (updateError) return Promise.resolve({ data: null, error: updateError }).then(res, rej)
          const hit = rows(); for (const r of hit) Object.assign(r, payload)
          return Promise.resolve({ data: hit.map((r) => ({ user_id: r.user_id })), error: null }).then(res, rej)
        }
        return Promise.resolve({ data: rows(), error: null }).then(res, rej)
      },
    }
    return chain
  }
  return { admin: { from }, t }
}
const req = async (method = 'GET', user = USER, token = null) => new Request(`https://fn.test/digest-unsubscribe?u=${user}&t=${token ?? await signUnsubscribe(USER, SECRET)}`, { method })

describe('handleUnsubscribe', () => {
  it('a valid link turns the email off, records it, and says so', async () => {
    const { admin, t } = fakeAdmin()
    const res = await handleUnsubscribe(await req('GET'), { admin, secret: SECRET, appUrl: 'https://app.test' })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Unsubscribed')
    expect(t.digest_schedules[0]).toMatchObject({ enabled: true, email_digest: false })
    expect(t.events).toEqual([expect.objectContaining({ user_id: USER, type: 'digest_email_unsubscribed', payload: { via: 'link' } })])
  })
  it('a one-click POST from a mail client works the same and is recorded as such', async () => {
    const { admin, t } = fakeAdmin()
    const res = await handleUnsubscribe(await req('POST'), { admin, secret: SECRET })
    expect(res.status).toBe(200)
    expect(t.events[0].payload).toEqual({ via: 'one-click' })
  })
  it('an account without a schedule row gets one that is off in every way', async () => {
    const { admin, t } = fakeAdmin({ hasRow: false })
    expect((await handleUnsubscribe(await req(), { admin, secret: SECRET })).status).toBe(200)
    expect(t.digest_schedules).toEqual([{ user_id: USER, enabled: false, email_digest: false }])
  })
  it('a bad token changes nothing', async () => {
    const { admin, t } = fakeAdmin()
    const res = await handleUnsubscribe(await req('GET', USER, 'f'.repeat(64)), { admin, secret: SECRET })
    expect(res.status).toBe(400)
    expect(t.digest_schedules[0].email_digest).toBe(true)
    expect(t.events).toEqual([])
  })
  it('refuses other methods and an unconfigured server without touching the row', async () => {
    const { admin, t } = fakeAdmin()
    expect((await handleUnsubscribe(await req('DELETE'), { admin, secret: SECRET })).status).toBe(405)
    expect((await handleUnsubscribe(await req('GET'), { admin, secret: '' })).status).toBe(500)
    expect(t.digest_schedules[0].email_digest).toBe(true)
  })
  it('a storage failure asks for a retry and keeps the link valid', async () => {
    const { admin } = fakeAdmin({ updateError: { message: 'down' } })
    const res = await handleUnsubscribe(await req(), { admin, secret: SECRET })
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('try it again')
  })
})
