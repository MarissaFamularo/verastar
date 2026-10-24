// lib/captcha.js — Cloudflare Turnstile token for each email-code request.
//
// Supabase Auth checks the token itself when CAPTCHA protection is on
// (Auth > Bot and Abuse Protection), so this module only fetches one. A token
// is single-use and expires after five minutes, so every send asks for a new
// one and the widget is removed once it answers.
//
// With no VITE_TURNSTILE_SITE_KEY the module is off: getCaptchaToken() resolves
// undefined and sign-in sends exactly what it sent before. Set the key in the
// build and turn CAPTCHA on in the dashboard together, or every send fails.
//
// appearance 'interaction-only' keeps the widget hidden for most people. When
// Cloudflare wants a click, the widget shows in a fixed panel at the bottom of
// the screen, which is visible on every sign-in screen and in an installed
// home-screen app. It is an iframe, not a popup, so standalone mode is fine.

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
// Long enough for a person to answer an interactive check; a stalled load still fails.
export const CAPTCHA_TIMEOUT_MS = 45000
export const CAPTCHA_MESSAGE = 'We couldn’t confirm this browser for sign-in. Reload the page and try again. If it keeps failing, turn off content blockers for this site.'

const HOST_ID = 'vs-captcha-host'

export class CaptchaError extends Error {
  constructor(reason) {
    super(CAPTCHA_MESSAGE)
    this.name = 'CaptchaError'
    this.code = 'captcha_failed'
    this.reason = reason
  }
}

export function isCaptchaError(err) {
  if (!err) return false
  if (err.code === 'captcha_failed' || err.name === 'CaptchaError') return true
  return /captcha/i.test(String(err.message || ''))
}

function siteKeyFromEnv() {
  const env = import.meta.env || {}
  return String(env.VITE_TURNSTILE_SITE_KEY || '').trim()
}

let scriptPromise = null

function loadScript(doc, win, timeoutMs) {
  if (win.turnstile?.render) return Promise.resolve(win.turnstile)
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CaptchaError('load-timeout')), timeoutMs)
    const finish = () => {
      clearTimeout(timer)
      if (win.turnstile?.render) resolve(win.turnstile)
      else reject(new CaptchaError('load-missing'))
    }
    const tag = doc.createElement('script')
    tag.src = TURNSTILE_SCRIPT
    tag.async = true
    tag.defer = true
    tag.onload = finish
    tag.onerror = () => { clearTimeout(timer); reject(new CaptchaError('load-error')) }
    doc.head.appendChild(tag)
  }).catch((err) => {
    // A blocked or failed load must not poison every later attempt.
    scriptPromise = null
    throw err
  })
  return scriptPromise
}

function host(doc) {
  let el = doc.getElementById(HOST_ID)
  if (el) return el
  el = doc.createElement('div')
  el.id = HOST_ID
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', 'Confirm you are a person to send your sign-in code')
  Object.assign(el.style, {
    position: 'fixed',
    left: '50%',
    bottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
    transform: 'translateX(-50%)',
    zIndex: '2147483000',
    display: 'none',
    padding: '10px',
    borderRadius: '12px',
    background: '#11141d',
    border: '1px solid rgba(255,255,255,.12)',
    boxShadow: '0 12px 40px rgba(0,0,0,.5)',
    maxWidth: 'calc(100vw - 32px)',
  })
  doc.body.appendChild(el)
  return el
}

// Exposed for tests: every dependency can be injected.
export function createCaptcha({
  siteKey = siteKeyFromEnv(),
  doc = typeof document === 'undefined' ? null : document,
  win = typeof window === 'undefined' ? null : window,
  timeoutMs = CAPTCHA_TIMEOUT_MS,
  load = loadScript,
} = {}) {
  const enabled = Boolean(siteKey)

  async function getToken() {
    if (!enabled) return undefined
    if (!doc || !win) throw new CaptchaError('no-dom')
    const turnstile = await load(doc, win, timeoutMs)
    const panel = host(doc)
    const slot = doc.createElement('div')
    panel.appendChild(slot)
    return new Promise((resolve, reject) => {
      let id = null
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { if (id != null) turnstile.remove(id) } catch { /* already gone */ }
        slot.remove()
        if (!panel.childElementCount) panel.style.display = 'none'
        fn(value)
      }
      const timer = setTimeout(() => finish(reject, new CaptchaError('timeout')), timeoutMs)
      try {
        id = turnstile.render(slot, {
          sitekey: siteKey,
          action: 'email-code',
          appearance: 'interaction-only',
          theme: 'dark',
          'refresh-expired': 'never',
          'refresh-timeout': 'never',
          callback: (token) => {
            if (typeof token === 'string' && token) finish(resolve, token)
            else finish(reject, new CaptchaError('empty'))
          },
          'error-callback': () => {
            finish(reject, new CaptchaError('error'))
            return true
          },
          'timeout-callback': () => finish(reject, new CaptchaError('interactive-timeout')),
          'unsupported-callback': () => finish(reject, new CaptchaError('unsupported')),
          'before-interactive-callback': () => { panel.style.display = 'block' },
          'after-interactive-callback': () => { panel.style.display = 'none' },
        })
      } catch {
        finish(reject, new CaptchaError('render'))
      }
    })
  }

  return { enabled, getToken }
}

let shared = null

export function captchaEnabled() {
  return Boolean(siteKeyFromEnv())
}

// One token per call. Resolves undefined when CAPTCHA is not configured.
export function getCaptchaToken() {
  if (!captchaEnabled()) return Promise.resolve(undefined)
  if (!shared) shared = createCaptcha()
  return shared.getToken()
}
