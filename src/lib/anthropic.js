// lib/anthropic.js — BYOK Anthropic client factory.
//
// The API key lives in browser storage ONLY (never repo, file, IndexedDB, logs, or a
// server). Default is sessionStorage — cleared when the tab closes. "Remember on this
// device" opts into localStorage instead, so daily use doesn't mean re-pasting the key
// every morning. Every model call in Verastar goes through this module so there is
// exactly one place that touches the key.
//
// Facts locked in docs/FACTS.md:
//   - new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
//   - models: extraction/triage/interview -> claude-sonnet-5; fast/check -> claude-haiku-4-5
//   - current models REJECT temperature / top_p / top_k / budget_tokens (400)
//   - structured output: output_config: { format: { type: "json_schema", schema } }
//   - do NOT combine citations with output_config.format (400) -> separate calls

import Anthropic from '@anthropic-ai/sdk'
import { supabase, supabaseConfigured } from './supabase.js'
import { isSponsored, CAP_MESSAGE } from './sponsor.js'

const KEY_STORAGE = 'verastar.anthropic_key'
const NCBI_KEY_STORAGE = 'verastar.ncbi_key'
const NCBI_EMAIL_STORAGE = 'verastar.ncbi_email'
const USAGE_STORAGE = 'verastar.anthropic_usage.v1'

export const MODELS = {
  // Extraction ran Opus for the hackathon; downgraded to Sonnet because the deterministic
  // verifier gates every extracted number against the source — a weaker extractor can
  // miss values (they fail verification and get flagged), never fabricate one on screen.
  extraction: 'claude-sonnet-5',
  triage: 'claude-sonnet-5',
  interview: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5-20251001',
}

// Browser-local spend ledger. Anthropic returns token usage on every successful response,
// including a response whose JSON is later rejected, so record it before parsing. Prices
// are USD per million tokens; Sonnet 5's introductory rate ends after 2026-08-31.
export function modelRates(model, now = new Date()) {
  if (String(model).includes('haiku-4-5')) return { input: 1, output: 5 }
  if (String(model).includes('sonnet-5')) {
    return now < new Date('2026-09-01T00:00:00Z') ? { input: 2, output: 10 } : { input: 3, output: 15 }
  }
  return { input: 3, output: 15 }
}

function readUsage() {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : { calls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }
  } catch {
    return { calls: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 }
  }
}

export function recordUsage(model, usage, now = new Date()) {
  // The ledger is "spend on your own key". A sponsored call (no key set) is not that,
  // and a sponsored user never sees a dollar figure anyway.
  if (accessMode() === 'sponsored') return readUsage()
  const input = Number(usage?.input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0)
  const cached = Number(usage?.cache_read_input_tokens || 0)
  const output = Number(usage?.output_tokens || 0)
  const rates = modelRates(model, now)
  const cost = ((input * rates.input) + (cached * rates.input * 0.1) + (output * rates.output)) / 1_000_000
  const prev = readUsage()
  const next = {
    calls: Number(prev.calls || 0) + 1,
    inputTokens: Number(prev.inputTokens || 0) + input + cached,
    outputTokens: Number(prev.outputTokens || 0) + output,
    estimatedUsd: Number(prev.estimatedUsd || 0) + cost,
    updatedAt: now.toISOString(),
  }
  try { localStorage.setItem(USAGE_STORAGE, JSON.stringify(next)) } catch { /* private mode */ }
  return next
}

export function getUsageSummary() {
  return readUsage()
}

// --- credential management (session-backed by default, localStorage when remembered) ---

function setCredential(storageKey, value, remember) {
  const trimmed = String(value || '').trim()
  if (!trimmed) {
    sessionStorage.removeItem(storageKey)
    localStorage.removeItem(storageKey)
    return
  }
  if (remember) {
    localStorage.setItem(storageKey, trimmed)
    sessionStorage.removeItem(storageKey)
  } else {
    sessionStorage.setItem(storageKey, trimmed)
    localStorage.removeItem(storageKey)
  }
}

function getCredential(storageKey) {
  return sessionStorage.getItem(storageKey) || localStorage.getItem(storageKey) || ''
}

// The key lives in exactly ONE of the two stores at a time: remember=true moves it to
// localStorage (survives tab close, this device only), remember=false keeps it in
// sessionStorage (gone on tab close).
export function setApiKey(key, { remember = false } = {}) {
  setCredential(KEY_STORAGE, key, remember)
}

export function getApiKey() {
  return getCredential(KEY_STORAGE)
}

export function hasApiKey() {
  return getApiKey().length > 0
}

// Which lane a model call would take right now. A pasted key always wins: someone on
// sponsored access who adds their own key has chosen to use it.
export function accessMode() {
  if (hasApiKey()) return 'byok'
  if (isSponsored()) return 'sponsored'
  return 'none'
}

// The gate every feature checks before offering a model-backed action. Replaces the old
// hasApiKey() gate so sponsored accounts get the same UI as a key holder.
export function hasModelAccess() {
  return accessMode() !== 'none'
}

// True when the saved key persists across tab close (localStorage).
export function isKeyRemembered() {
  return !!localStorage.getItem(KEY_STORAGE)
}

export function clearApiKey() {
  sessionStorage.removeItem(KEY_STORAGE)
  localStorage.removeItem(KEY_STORAGE)
}

// Optional free NCBI key raises eutils from 3 -> 10 req/s. With no explicit option it
// follows the Anthropic key's current Remember choice, so onboarding cannot split the
// three credentials across different persistence policies.
export function setNcbiKey(key, { remember = isKeyRemembered() } = {}) {
  setCredential(NCBI_KEY_STORAGE, key, remember)
}

export function getNcbiKey() {
  return getCredential(NCBI_KEY_STORAGE)
}

// Optional email identifies us politely to NCBI (their contact-before-block channel).
export function setNcbiEmail(email, { remember = isKeyRemembered() } = {}) {
  setCredential(NCBI_EMAIL_STORAGE, email, remember)
}

export function getNcbiEmail() {
  return getCredential(NCBI_EMAIL_STORAGE)
}

// Move every credential that currently exists to the same storage tier. This is the
// Settings checkbox's one implementation and also repairs the old split state where the
// Anthropic key was local but NCBI values were still session-only.
export function setAllCredentialsRemembered(remember) {
  for (const storageKey of [KEY_STORAGE, NCBI_KEY_STORAGE, NCBI_EMAIL_STORAGE]) {
    const value = getCredential(storageKey)
    if (value) setCredential(storageKey, value, remember)
  }
}

export function getNcbiCredentialStatus() {
  return {
    keyActive: !!getNcbiKey(),
    emailActive: !!getNcbiEmail(),
    keyRemembered: !!localStorage.getItem(NCBI_KEY_STORAGE),
    emailRemembered: !!localStorage.getItem(NCBI_EMAIL_STORAGE),
  }
}

export function clearNcbiCredentials() {
  setCredential(NCBI_KEY_STORAGE, '', false)
  setCredential(NCBI_EMAIL_STORAGE, '', false)
}

// --- client ---

let _client = null
let _clientKey = null
let _sponsoredClient = null

// Returns a memoized Anthropic client for the current lane. BYOK binds to the browser-held
// key and talks to Anthropic directly. Sponsored points the same SDK at the `model` edge
// function, which swaps the Supabase JWT for the sponsor key server-side, so every call
// site stays identical. Throws when neither lane is open — callers gate on hasModelAccess().
export function getClient() {
  const apiKey = getApiKey()
  if (!apiKey && isSponsored()) return getSponsoredClient()
  if (!apiKey) {
    throw new Error('No Anthropic API key set. Add your key in Setup.')
  }
  if (!_client || _clientKey !== apiKey) {
    _client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
    _clientKey = apiKey
  }
  return _client
}

function getSponsoredClient() {
  if (_sponsoredClient) return _sponsoredClient
  if (!supabaseConfigured) throw new Error('Sponsored access needs a configured backend.')
  const base = String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')
  _sponsoredClient = new Anthropic({
    apiKey: 'sponsored', // discarded by the proxy; the SDK insists on a value
    baseURL: `${base}/functions/v1/model`,
    dangerouslyAllowBrowser: true,
    // Inject a fresh JWT per request: supabase-js refreshes tokens in the background,
    // so reading the session at call time is the only way to never send a stale one.
    fetch: async (url, init = {}) => {
      const { data } = await supabase.auth.getSession()
      const token = data?.session?.access_token
      if (!token) throw new Error('Sign in again to continue.')
      const headers = new Headers(init.headers || {})
      headers.set('Authorization', `Bearer ${token}`)
      headers.set('apikey', import.meta.env.VITE_SUPABASE_ANON_KEY)
      return fetch(url, { ...init, headers })
    },
  })
  return _sponsoredClient
}

// Thrown when the proxy declines a sponsored call because a spending cap was reached.
// Carries the one user-facing sentence; nothing about amounts.
export class CapReachedError extends Error {
  constructor(message = CAP_MESSAGE) {
    super(message)
    this.name = 'CapReachedError'
    this.capReached = true
  }
}

export function isCapReached(err) {
  return err?.capReached === true || err?.status === 402
}

// Every proxied call passes through here so a 402 becomes a CapReachedError whatever the
// SDK wrapped it in. Other errors pass through untouched.
async function guarded(fn) {
  try {
    return await fn()
  } catch (err) {
    if (err?.status === 402) throw new CapReachedError(err?.error?.error?.message || err?.message || CAP_MESSAGE)
    throw err
  }
}

// Day-0 smoke test: a minimal round-trip that proves the key + browser-direct wiring
// works. Returns the model's text. Kept intentionally tiny.
export async function ping(prompt = 'Reply with exactly the word: pong') {
  const client = getClient()
  const res = await guarded(() => client.messages.create({
    model: MODELS.fast,
    max_tokens: 16,
    messages: [{ role: 'user', content: prompt }],
  }, requestOptions({ purpose: 'ping' })))
  recordUsage(MODELS.fast, res.usage)
  return res.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

export class StructuredOutputError extends Error {
  constructor(message, { stopReason = null, retryable = false } = {}) {
    super(message)
    this.name = 'StructuredOutputError'
    this.stopReason = stopReason
    this.retryable = retryable
  }
}

// A 200 response is not necessarily complete. Structured output can still be cut off at
// the output or context limit, and parsing that partial text only reports a misleading raw
// SyntaxError. Classify the response first so callers can retry the right failures.
export function parseStructuredResponse(res) {
  const stopReason = res?.stop_reason || null
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    throw new StructuredOutputError('Claude structured output was incomplete.', { stopReason, retryable: true })
  }
  if (stopReason === 'refusal') {
    throw new StructuredOutputError('Claude declined this structured-output request.', { stopReason })
  }
  if (stopReason && stopReason !== 'end_turn') {
    throw new StructuredOutputError(`Claude stopped structured output early (${stopReason}).`, { stopReason })
  }

  const text = (res?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (!text.trim()) {
    throw new StructuredOutputError('Claude returned no structured output.', { stopReason, retryable: true })
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new StructuredOutputError('Claude returned incomplete structured output.', { stopReason, retryable: true })
  }
}

// Structured-output call. `schema` is a JSON Schema per the output_config contract
// (additionalProperties:false + required on every object; nullable via anyOf; no
// minimum/maximum/minLength/recursion). Returns the parsed object. NOTE: never pass
// citations here — that is a separate call (combining them 400s).
//
// `purpose` labels the call in the sponsor's ledger. `cacheKey` (pipeline/evidenceCache.js)
// names the exact source text an extraction came from; the proxy serves a cached extraction
// for the same key instead of calling the model, and stores a fresh one for the next reader.
// Both are headers, so a BYOK call (browser-direct to Anthropic) simply carries them unused.
export async function extractStructured({ model = MODELS.extraction, system, content, schema, maxTokens = 4096, thinking, purpose, cacheKey }) {
  const client = getClient()
  const res = await guarded(() => client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(thinking ? { thinking } : {}),
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
  }, requestOptions({ purpose, cacheKey })))
  recordUsage(model, res.usage)
  return parseStructuredResponse(res)
}

// Per-request headers for the proxy. Only on the sponsored lane: a BYOK call goes
// browser-direct to Anthropic, whose CORS preflight would reject an unknown header and
// take the whole call down with it. Exported for tests.
export function requestOptions({ purpose, cacheKey } = {}, mode = accessMode()) {
  if (mode !== 'sponsored') return undefined
  const headers = {}
  if (purpose) headers['x-verastar-purpose'] = purpose
  if (cacheKey) headers['x-verastar-cache'] = cacheKey
  return Object.keys(headers).length ? { headers } : undefined
}
