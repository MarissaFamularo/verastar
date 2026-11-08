import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parseHTML } from 'linkedom'
import { createClient } from '@supabase/supabase-js'
import { DIGEST_ACTION_RESULTS, digestActionResponse } from '../../supabase/functions/_shared/digestAction.js'
import { handleResume } from '../../supabase/functions/digest-resume/handler.js'
import { handleUnsubscribe } from '../../supabase/functions/digest-unsubscribe/handler.js'
import { resumeUrl, unsubscribeUrl } from '../../supabase/functions/_shared/unsubscribe.js'
import { renderDigestStatus } from './digestStatus.js'

const USER = '41fd38b0-c67e-4ce1-a647-3612fbc6010e'
const OTHER = '41fd38b0-c67e-4ce1-a647-3612fbc6010f'
const SECRET = 'only-a-synthetic-test-secret'
const FN = 'https://ref.supabase.co/functions/v1'
const APP = 'https://app.test'
const request = async (kind, method = 'GET') => new Request(await (kind === 'resume' ? resumeUrl : unsubscribeUrl)(FN, USER, SECRET), { method })

// Exercise the real PostgREST client and its update/select/insert response semantics.
// All HTTP requests terminate in this fake; no test uses a production token or account.
function database(responses, { eventFailure = false } = {}) {
  const calls = []
  const fetch = vi.fn(async (input, init) => {
    const url = new URL(input)
    const call = { path: url.pathname, query: Object.fromEntries(url.searchParams), method: init.method, body: init.body && JSON.parse(init.body) }
    calls.push(call)
    if (url.pathname.endsWith('/events')) {
      if (eventFailure) throw new Error('offline')
      return new Response(null, { status: 201 })
    }
    if (!url.pathname.endsWith('/digest_schedules')) throw new Error('Unexpected request')
    const response = responses.shift()
    if (!response) throw new Error('Unexpected database operation')
    if (response instanceof Error) throw response
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), { status: response.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  const admin = createClient('https://db.test', 'synthetic-test-key', { global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  return { admin, calls }
}
const locationResult = (res) => new URL(res.headers.get('Location')).searchParams.get('result')

describe('email-link outcomes', () => {
  it.each(['resume', 'unsubscribe'])('%s rejects a bad token before any database call and redirects without the credential', async (kind) => {
    const { admin, calls } = database([])
    const req = new Request(`${FN}/digest-${kind}?u=${USER}&t=invalid&redirect=https://evil.test`)
    const res = await (kind === 'resume' ? handleResume : handleUnsubscribe)(req, { admin, secret: SECRET, appUrl: APP })
    expect(res.status).toBe(303)
    expect(res.headers.get('Location')).toBe(`${APP}/digest-status.html?result=${kind}-invalid`)
    expect(await res.text()).toBe('')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(calls).toEqual([])
  })

  it.each(['resume', 'unsubscribe'])('%s HEAD probes never write or report success', async (kind) => {
    const { admin, calls } = database([])
    const res = await (kind === 'resume' ? handleResume : handleUnsubscribe)(await request(kind, 'HEAD'), { admin, secret: SECRET, appUrl: APP })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect(res.headers.get('Location')).toBeNull()
    expect(calls).toEqual([])
  })

  it.each([
    [[], 'resume-missing', 404],
    [[{ user_id: USER, enabled: true }], 'resumed', 200],
    [[{ user_id: USER, enabled: false }], 'resume-disabled', 200],
  ])('resume only confirms a returned schedule (%s)', async (rows, expected, status) => {
    const { admin, calls } = database([{ body: rows }])
    const res = await handleResume(await request('resume'), { admin, secret: SECRET, appUrl: APP })
    expect(res.status).toBe(303)
    expect(locationResult(res)).toBe(expected)
    expect(DIGEST_ACTION_RESULTS[expected].status).toBe(status)
    expect(calls[0]).toMatchObject({ method: 'PATCH', query: { user_id: `eq.${USER}`, select: 'user_id,enabled' }, body: { paused_at: null, unopened_streak: 0 } })
    expect(calls[0].body).not.toHaveProperty('enabled')
    expect(calls[0].body).not.toHaveProperty('email_digest')
    expect(calls.filter((c) => c.path.endsWith('/events'))).toHaveLength(rows.length)
  })

  it.each([null, [{ user_id: OTHER, enabled: true }], [{ user_id: USER }]])('resume refuses an unconfirmed database result (%s)', async (rows) => {
    const { admin, calls } = database([{ body: rows }])
    const res = await handleResume(await request('resume', 'POST'), { admin, secret: SECRET, appUrl: APP })
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(1)
  })

  it('a missing schedule gives direct POST callers 404 and no success event', async () => {
    const { admin, calls } = database([{ body: [] }])
    const res = await handleResume(await request('resume', 'POST'), { admin, secret: SECRET, appUrl: APP })
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Nothing was resumed')
    expect(calls).toHaveLength(1)
  })

  it('resume is safe to repeat and never switches email or automatic runs on', async () => {
    const { admin, calls } = database([{ body: [{ user_id: USER, enabled: false }] }, { body: [{ user_id: USER, enabled: false }] }])
    for (let i = 0; i < 2; i++) {
      const res = await handleResume(await request('resume'), { admin, secret: SECRET, appUrl: APP })
      expect(locationResult(res)).toBe('resume-disabled')
    }
    for (const call of calls.filter((c) => c.method === 'PATCH')) {
      expect(Object.keys(call.body).sort()).toEqual(['engaged_at', 'paused_at', 'unopened_streak', 'updated_at'])
    }
  })

  it('a competing insert is followed by a confirmed unsubscribe update, preserving automatic runs', async () => {
    const { admin, calls } = database([{ body: [] }, { status: 409, body: { code: '23505', message: 'duplicate key' } }, { body: [{ user_id: USER }] }])
    const res = await handleUnsubscribe(await request('unsubscribe'), { admin, secret: SECRET, appUrl: APP })
    expect(locationResult(res)).toBe('unsubscribed')
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST', 'PATCH', 'POST'])
    expect(calls[1].body).toEqual({ user_id: USER, enabled: false, email_digest: false })
    expect(calls[2].body.email_digest).toBe(false)
    expect(calls[2].body).not.toHaveProperty('enabled')
    expect(calls[2].query.user_id).toBe(`eq.${USER}`)
  })

  it('unsubscribe creates an all-off row when missing and confirms the insert', async () => {
    const { admin, calls } = database([{ body: [] }, { status: 201 }])
    const res = await handleUnsubscribe(await request('unsubscribe'), { admin, secret: SECRET, appUrl: APP })
    expect(locationResult(res)).toBe('unsubscribed')
    expect(calls[1].body).toEqual({ user_id: USER, enabled: false, email_digest: false })
    expect(calls[2].path).toBe('/rest/v1/events')
  })

  it('unsubscribe insert failure is not success and does not record an event', async () => {
    const { admin, calls } = database([{ body: [] }, { status: 400, body: { code: '23503', message: 'account missing' } }])
    const res = await handleUnsubscribe(await request('unsubscribe', 'POST'), { admin, secret: SECRET, appUrl: APP })
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(2)
  })

  it.each([
    { body: [] },
    { body: null },
    { status: 503, body: { message: 'down' } },
  ])('a failed conflict retry does not claim unsubscribe or record an event (%s)', async (retry) => {
    const { admin, calls } = database([{ body: [] }, { status: 409, body: { code: '23505', message: 'duplicate key' } }, retry])
    const res = await handleUnsubscribe(await request('unsubscribe', 'POST'), { admin, secret: SECRET, appUrl: APP })
    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain('Unsubscribed')
    expect(calls.every((c) => !c.path.endsWith('/events'))).toBe(true)
  })

  it('mail-client unsubscribe POSTs receive a direct 200 with no HTML or redirect', async () => {
    const { admin, calls } = database([{ body: [{ user_id: USER }] }])
    const req = new Request(await unsubscribeUrl(FN, USER, SECRET), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })
    const res = await handleUnsubscribe(req, { admin, secret: SECRET, appUrl: APP })
    expect(res.status).toBe(200)
    expect(res.headers.get('Location')).toBeNull()
    expect(res.headers.get('Content-Type')).toContain('text/plain')
    expect(await res.text()).toMatch(/^Unsubscribed\n/)
    expect(calls[1].body.payload).toEqual({ via: 'one-click' })
  })

  it.each(['resume', 'unsubscribe'])('%s database errors produce retry, never success', async (kind) => {
    const { admin, calls } = database([{ status: 503, body: { message: 'internal error with private details' } }])
    const res = await (kind === 'resume' ? handleResume : handleUnsubscribe)(await request(kind), { admin, secret: SECRET, appUrl: APP })
    expect(locationResult(res)).toBe('retry')
    expect(calls).toHaveLength(1)
  })

  it.each(['resume', 'unsubscribe'])('%s analytics failure does not hide the saved change', async (kind) => {
    const admin = { from: (table) => {
      if (table === 'events') throw new Error('events unavailable')
      const chain = { update: () => chain, eq: () => chain, select: async () => ({ data: [{ user_id: USER, enabled: true }], error: null }) }
      return chain
    } }
    const res = await (kind === 'resume' ? handleResume : handleUnsubscribe)(await request(kind), { admin, secret: SECRET, appUrl: APP })
    expect(locationResult(res)).toBe(kind === 'resume' ? 'resumed' : 'unsubscribed')
  })
})

describe('confirmation page', () => {
  const html = readFileSync(new URL('../../digest-status.html', import.meta.url), 'utf8')
  it.each(Object.keys(DIGEST_ACTION_RESULTS))('renders %s without sign-in or mutations', (code) => {
    const { document } = parseHTML(html)
    renderDigestStatus(document, `?result=${code}`)
    expect(document.getElementById('result-title').textContent).toBe(DIGEST_ACTION_RESULTS[code].title)
    expect(document.getElementById('result-body').textContent).toBe(DIGEST_ACTION_RESULTS[code].body)
    expect(document.querySelector('a').getAttribute('href')).toBe('./')
  })
  it.each(['', '?result=__proto__', '?result=constructor', '?result=%3Cscript%3Ealert(1)%3C/script%3E'])('unknown or injected results stay neutral (%s)', (search) => {
    const { document } = parseHTML(html)
    renderDigestStatus(document, search)
    expect(document.getElementById('result-title').textContent).toBe(DIGEST_ACTION_RESULTS.unknown.title)
    expect(document.querySelectorAll('script')).toHaveLength(1)
  })
  it('repeated renders and Back to another result replace rather than append the message', () => {
    const { document } = parseHTML(html)
    for (const code of ['resumed', 'resumed', 'unsubscribe-invalid', 'unsubscribed']) renderDigestStatus(document, `?result=${code}`)
    expect(document.getElementById('result-title').textContent).toBe('Unsubscribed')
    expect(document.querySelectorAll('h1')).toHaveLength(1)
  })
  it.each(['', 'not a url', 'javascript:alert(1)', 'https://user:pass@app.test'])('a missing or invalid configured app URL safely falls back to plain text (%s)', async (appUrl) => {
    const res = digestActionResponse(new Request(FN), 'resumed', appUrl)
    expect(res.status).toBe(200)
    expect(res.headers.get('Location')).toBeNull()
    expect(await res.text()).not.toContain('<html')
  })
  it('does not inherit query strings/fragments from APP_URL or the signed request', () => {
    const res = digestActionResponse(new Request(`${FN}?u=${USER}&t=private`), 'resumed', 'https://app.test/subpath/?debug=yes#private')
    expect(res.headers.get('Location')).toBe('https://app.test/subpath/digest-status.html?result=resumed')
  })
  it('the service worker never substitutes the app shell for a confirmation page', () => {
    const listeners = {}
    const fetch = vi.fn()
    const caches = { match: vi.fn() }
    runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
      self: { addEventListener: (name, callback) => { listeners[name] = callback }, location: { origin: APP } },
      URL, fetch, caches,
    })
    const respondWith = vi.fn()
    listeners.fetch({ request: { url: `${APP}/digest-status.html?result=unsubscribed`, mode: 'navigate' }, respondWith })
    expect(respondWith).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(caches.match).not.toHaveBeenCalled()
  })
})
