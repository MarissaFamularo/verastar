// Bot protection on the email-code request: the Turnstile client, the token's path
// through both send routes, the Gmail alias function, and the CSP that lets it load.

import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTCHA_MESSAGE, CaptchaError, captchaEnabled, createCaptcha, getCaptchaToken, isCaptchaError } from './captcha.js'
import { handleGmailCanonicalOtp } from '../../supabase/functions/gmail-canonical-otp/handler.js'
import { sendCanonicalGmailCode } from './gmailCanonical.js'

const TICKET = '11111111-1111-4111-8111-111111111111'
const VERIFY = '22222222-2222-4222-8222-222222222222'
const STORED = 'jane.doe@gmail.com'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers() })

function page() {
  const { document, window } = parseHTML('<!doctype html><html><head></head><body></body></html>')
  return { doc: document, win: window }
}

// A stand-in for window.turnstile that records render options and lets the test answer.
function fakeTurnstile() {
  const widgets = []
  return {
    widgets,
    render: vi.fn((el, opts) => { widgets.push({ el, opts }); return `w${widgets.length}` }),
    remove: vi.fn(),
  }
}

describe('captcha client', () => {
  it('is off without a site key and resolves no token', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '')
    expect(captchaEnabled()).toBe(false)
    await expect(getCaptchaToken()).resolves.toBeUndefined()
    const off = createCaptcha({ siteKey: '' })
    expect(off.enabled).toBe(false)
    await expect(off.getToken()).resolves.toBeUndefined()
  })

  it('renders an interaction-only widget and returns its token once', async () => {
    const { doc, win } = page()
    const ts = fakeTurnstile()
    const c = createCaptcha({ siteKey: 'site-key', doc, win, load: async () => ts })
    const pending = c.getToken()
    await vi.waitFor(() => expect(ts.render).toHaveBeenCalledTimes(1))
    const { opts } = ts.widgets[0]
    expect(opts.sitekey).toBe('site-key')
    expect(opts.appearance).toBe('interaction-only')
    expect(opts.action).toBe('email-code')
    opts.callback('token-1')
    await expect(pending).resolves.toBe('token-1')
    // The widget is removed so the next send renders a fresh one (tokens are single-use).
    expect(ts.remove).toHaveBeenCalledWith('w1')
    expect(doc.getElementById('vs-captcha-host').childElementCount).toBe(0)
  })

  it('shows the panel only while Cloudflare asks for a click', async () => {
    const { doc, win } = page()
    const ts = fakeTurnstile()
    const c = createCaptcha({ siteKey: 'k', doc, win, load: async () => ts })
    const pending = c.getToken()
    await vi.waitFor(() => expect(ts.render).toHaveBeenCalled())
    const panel = doc.getElementById('vs-captcha-host')
    expect(panel.style.display).toBe('none')
    ts.widgets[0].opts['before-interactive-callback']()
    expect(panel.style.display).toBe('block')
    ts.widgets[0].opts['after-interactive-callback']()
    ts.widgets[0].opts.callback('t')
    await pending
    expect(panel.style.display).toBe('none')
  })

  for (const cb of ['error-callback', 'timeout-callback', 'unsupported-callback']) {
    it(`rejects with a captcha error on ${cb}`, async () => {
      const { doc, win } = page()
      const ts = fakeTurnstile()
      const c = createCaptcha({ siteKey: 'k', doc, win, load: async () => ts })
      const pending = c.getToken()
      await vi.waitFor(() => expect(ts.render).toHaveBeenCalled())
      ts.widgets[0].opts[cb]('300030')
      await expect(pending).rejects.toBeInstanceOf(CaptchaError)
    })
  }

  it('fails closed when the widget never answers', async () => {
    vi.useFakeTimers()
    const { doc, win } = page()
    const ts = fakeTurnstile()
    const c = createCaptcha({ siteKey: 'k', doc, win, timeoutMs: 1000, load: async () => ts })
    const pending = c.getToken()
    const check = expect(pending).rejects.toMatchObject({ code: 'captcha_failed', reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(1000)
    await check
  })

  it('fails closed when the script is blocked', async () => {
    const { doc, win } = page()
    const c = createCaptcha({ siteKey: 'k', doc, win, load: async () => { throw new CaptchaError('load-error') } })
    await expect(c.getToken()).rejects.toMatchObject({ message: CAPTCHA_MESSAGE })
  })

  it('recognises Supabase Auth captcha refusals', () => {
    expect(isCaptchaError({ code: 'captcha_failed' })).toBe(true)
    expect(isCaptchaError(new Error('captcha protection: request disallowed (no captcha response)'))).toBe(true)
    expect(isCaptchaError(new Error('Email rate limit exceeded'))).toBe(false)
    expect(isCaptchaError(null)).toBe(false)
  })
})

describe('gmail-canonical-otp forwards the token to Auth', () => {
  function request(body) {
    return new Request('https://example.test/gmail-canonical-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  function deps(overrides = {}) {
    return {
      takeSend: vi.fn(async () => STORED),
      keepVerify: vi.fn(async () => VERIFY),
      readVerify: vi.fn(async () => STORED),
      consumeVerify: vi.fn(async () => {}),
      failVerify: vi.fn(async () => 4),
      sendOtp: vi.fn(async () => ({ ok: true })),
      verifyOtp: vi.fn(async () => null),
      ...overrides,
    }
  }

  it('passes the browser token through to sendOtp', async () => {
    const bound = deps()
    const res = await handleGmailCanonicalOtp(request({ action: 'send', ticket: TICKET, captchaToken: 'tok.abc-123' }), bound)
    expect(res.status).toBe(200)
    expect(bound.sendOtp).toHaveBeenCalledWith(STORED, '', 'tok.abc-123')
  })

  it('refuses a malformed token before spending the ticket', async () => {
    for (const captchaToken of [123, 'x'.repeat(5000), 'has space', { a: 1 }]) {
      const bound = deps()
      const res = await handleGmailCanonicalOtp(request({ action: 'send', ticket: TICKET, captchaToken }), bound)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ status: 'captcha' })
      expect(bound.takeSend).not.toHaveBeenCalled()
      expect(bound.sendOtp).not.toHaveBeenCalled()
    }
  })

  it('reports an Auth captcha refusal as captcha and issues no verify ticket', async () => {
    const bound = deps({ sendOtp: vi.fn(async () => ({ ok: false, captcha: true })) })
    const res = await handleGmailCanonicalOtp(request({ action: 'send', ticket: TICKET, captchaToken: 'bad' }), bound)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ status: 'captcha' })
    expect(bound.keepVerify).not.toHaveBeenCalled()
  })

  it('index.ts hands the token to signInWithOtp and does not verify it itself', () => {
    const src = readFileSync('supabase/functions/gmail-canonical-otp/index.ts', 'utf8')
    expect(src).toMatch(/options\.captchaToken\s*=\s*captchaToken/)
    expect(src).toContain('shouldCreateUser: false')
    // A siteverify call here would spend the single-use token before Auth sees it.
    expect(src).not.toContain('siteverify')
  })
})

describe('canonical client carries the token', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
  })

  it('adds captchaToken to the body only when one exists', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ sent: true, verifyTicket: VERIFY }) }))
    vi.stubGlobal('fetch', fetchMock)
    await sendCanonicalGmailCode({ ticket: TICKET, redirectTo: '', captchaToken: 'tok' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).captchaToken).toBe('tok')
    await sendCanonicalGmailCode({ ticket: TICKET, redirectTo: '' })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('captchaToken')
  })

  it('surfaces a captcha refusal distinctly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ status: 'captcha' }) })))
    await expect(sendCanonicalGmailCode({ ticket: TICKET, captchaToken: 'tok' })).resolves.toEqual({ ok: false, captcha: true })
  })
})

describe('sendMagicLink', () => {
  it('passes captchaToken to signInWithOtp and keeps the Auth error code', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
    vi.stubGlobal('window', { location: { origin: 'https://verastar.papertrellis.com' } })
    const signInWithOtp = vi.fn(async () => ({ error: null }))
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: { signInWithOtp } }) }))
    try {
      const { sendMagicLink } = await import('./supabase.js')
      await sendMagicLink('doc@clinic.edu', 'tok')
      expect(signInWithOtp).toHaveBeenLastCalledWith({
        email: 'doc@clinic.edu',
        options: { emailRedirectTo: 'https://verastar.papertrellis.com', captchaToken: 'tok' },
      })
      await sendMagicLink('doc@clinic.edu')
      expect(signInWithOtp.mock.lastCall[0].options).not.toHaveProperty('captchaToken')
      signInWithOtp.mockResolvedValueOnce({ error: { message: 'captcha protection: request disallowed', status: 400, code: 'captcha_failed' } })
      await expect(sendMagicLink('doc@clinic.edu', 'bad')).rejects.toMatchObject({ code: 'captcha_failed', status: 400 })
    } finally {
      vi.doUnmock('@supabase/supabase-js')
      vi.resetModules()
    }
  })
})

describe('CSP allows Turnstile and nothing else new', () => {
  it('adds challenges.cloudflare.com to script-src and frame-src only', () => {
    const csp = readFileSync('public/_headers', 'utf8').match(/Content-Security-Policy:\s*(.+)/)[1]
    const dir = (name) => (csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`)) || [])[1]?.trim()
    expect(dir('script-src')).toBe("'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com")
    expect(dir('frame-src')).toBe('https://challenges.cloudflare.com')
    expect(dir('frame-ancestors')).toBe("'none'")
    expect(dir('connect-src')).not.toContain('cloudflare')
  })
})
