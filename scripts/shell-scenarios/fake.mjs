// In-memory fake of the Supabase HTTP surface the Verastar client touches, installed as a
// Playwright route on http://fake.supabase.local/**. Real supabase-js, real app code; only
// the network is simulated. Synthetic accounts only.

export const BASE = 'http://fake.supabase.local'
export const ANON = 'anon-test-key'

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
export function fakeJwt(user, exp) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`
}

export function makeUser({ id, email, npi = true }) {
  return {
    id, email, aud: 'authenticated', role: 'authenticated',
    app_metadata: npi ? { provider: 'email', npi_match: { npi: '1234567890', matched_at: '2026-10-01T00:00:00Z' } } : { provider: 'email' },
    user_metadata: {}, created_at: '2026-10-01T00:00:00Z',
  }
}

export function sessionFor(user) {
  const exp = Math.floor(Date.now() / 1000) + 6 * 3600
  return { access_token: fakeJwt(user, exp), refresh_token: 'refresh-test', token_type: 'bearer', expires_in: 6 * 3600, expires_at: exp, user }
}

// --- a tiny PostgREST ----------------------------------------------------------------------
function applyFilters(rows, params) {
  let out = rows
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue
    const m = /^(eq|neq|gte|lte|gt|lt|in|is)\.(.*)$/s.exec(v)
    if (!m) continue
    const [, op, raw] = m
    out = out.filter((r) => {
      const x = r[k]
      if (op === 'eq') return String(x) === raw
      if (op === 'neq') return String(x) !== raw
      if (op === 'is') return raw === 'null' ? x == null : String(x) === raw
      if (op === 'in') return raw.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).includes(String(x))
      if (op === 'gte') return x >= raw
      if (op === 'lte') return x <= raw
      if (op === 'gt') return x > raw
      if (op === 'lt') return x < raw
      return true
    })
  }
  const order = params.get('order')
  if (order) {
    const [col, dir] = order.split('.')
    out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1))
  }
  return out
}
function project(rows, select) {
  if (!select || select === '*') return rows
  const cols = select.split(',').map((s) => s.trim()).filter(Boolean)
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])))
}

export function makeFake({ user, admin = false, tables = {}, log = [] }) {
  const db = {
    kv: [], events: [], sponsored_accounts: [], digest_schedules: [], beta_survey_responses: [],
    evidence_cache_trusted: [], reference_papers: [], ...tables,
  }
  const control = { survey: 'ok', stats: null, redeem: 'enrolled' } // survey: ok | error | stall | forbidden
  const calls = { rpc: [], functions: [], rest: [] }
  const keys = { kv: ['user_id', 'collection', 'key'], digest_schedules: ['user_id'], sponsored_accounts: ['user_id'], beta_survey_responses: ['user_id', 'wave'] }

  async function handle(route) {
    const req = route.request()
    const url = new URL(req.url())
    const method = req.method()
    const json = (status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', ...headers }, body: body === undefined ? '' : JSON.stringify(body) })
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })

    if (url.pathname === '/auth/v1/user') return json(200, user)
    if (url.pathname.startsWith('/auth/v1/token')) return json(200, sessionFor(user))
    if (url.pathname.startsWith('/auth/v1/logout')) return json(204, undefined)

    if (url.pathname.startsWith('/functions/v1/')) {
      const fn = url.pathname.split('/')[3]
      calls.functions.push({ fn, body: req.postDataJSON?.() })
      if (fn === 'redeem-invite') {
        const status = control.redeem
        if (status === 'enrolled' && !db.sponsored_accounts.some((r) => r.user_id === user.id)) {
          db.sponsored_accounts.push({ user_id: user.id, active: true, ends_at: null, cohort: 'pilot-synthetic', created_at: new Date().toISOString() })
        }
        return json(200, { status, cohort: 'pilot-synthetic' })
      }
      return json(404, { error: `no fake for ${fn}` })
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/')[4]
      const args = req.postDataJSON?.() || {}
      calls.rpc.push({ fn, args })
      if (fn === 'beta_admin_check') return json(200, admin)
      if (fn === 'beta_release_stats') {
        if (!admin) return json(403, { code: '42501', message: 'beta admin only', details: null, hint: null })
        return json(200, { ...control.stats, range: { from: args.p_from, to: args.p_to }, generated_at: new Date().toISOString() })
      }
      if (fn === 'beta_survey_submit') {
        if (control.survey === 'stall') return new Promise(() => {}) // never answers
        if (control.survey === 'error') return json(500, { code: 'XX000', message: 'synthetic failure', details: null, hint: null })
        if (control.survey === 'forbidden') return json(403, { code: '42501', message: 'beta access required', details: null, hint: null })
        const existing = db.beta_survey_responses.find((r) => r.user_id === user.id && r.wave === args.p_wave)
        if (existing) return json(200, { status: 'already', recorded_status: existing.status })
        db.beta_survey_responses.push({ user_id: user.id, wave: args.p_wave, survey_version: args.p_version, status: args.p_status, ...args.p_answers, responded_at: new Date().toISOString() })
        return json(200, { status: 'recorded', recorded_status: args.p_status })
      }
      return json(404, { code: 'PGRST202', message: `no fake rpc ${fn}` })
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.split('/')[3]
      const rows = db[table]
      calls.rest.push({ method, table, query: url.search })
      if (!rows) return json(404, { code: 'PGRST205', message: `no fake table ${table}` })
      const params = url.searchParams
      const prefer = req.headers()['prefer'] || ''
      if (method === 'GET' || method === 'HEAD') {
        const matched = applyFilters(rows, params)
        const range = req.headers()['range']
        let page = matched
        if (range) { const [a, b] = range.split('-').map(Number); page = matched.slice(a, b + 1) }
        const headers = {}
        if (/count=exact/.test(prefer)) headers['content-range'] = `0-${Math.max(page.length - 1, 0)}/${matched.length}`
        return json(200, method === 'HEAD' ? undefined : project(page, params.get('select')), headers)
      }
      if (method === 'POST') {
        const body = req.postDataJSON()
        const list = Array.isArray(body) ? body : [body]
        const key = keys[table]
        for (const row of list) {
          const idx = key ? rows.findIndex((r) => key.every((k) => r[k] === row[k])) : -1
          if (idx >= 0) {
            if (/resolution=merge-duplicates/.test(prefer) || params.has('on_conflict')) rows[idx] = { ...rows[idx], ...row }
            else if (/resolution=ignore-duplicates/.test(prefer)) continue
            else return json(409, { code: '23505', message: 'duplicate key' })
          } else rows.push({ id: rows.length + 1, created_at: new Date().toISOString(), ts: new Date().toISOString(), ...row })
        }
        return json(201, /return=minimal/.test(prefer) ? undefined : list)
      }
      if (method === 'PATCH') {
        const body = req.postDataJSON()
        for (const r of applyFilters(rows, params)) Object.assign(r, body)
        return json(204, undefined)
      }
      if (method === 'DELETE') {
        const gone = new Set(applyFilters(rows, params))
        db[table] = rows.filter((r) => !gone.has(r))
        return json(204, undefined)
      }
    }
    log.push(`unhandled ${method} ${url.pathname}`)
    return json(404, { error: 'unhandled' })
  }

  return { db, control, calls, handle }
}

export async function installFake(page, fake, user) {
  await page.route(`${BASE}/**`, (route) => fake.handle(route))
  // Outside hosts (PubMed, PaperTrellis, fonts): fail fast instead of waiting on the proxy.
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1|fake\.supabase\.local).*/, (route) => route.abort())
  await page.addInitScript(({ key, session }) => {
    window.localStorage.setItem(key, JSON.stringify(session))
  }, { key: 'sb-fake-auth-token', session: sessionFor(user) })
}
