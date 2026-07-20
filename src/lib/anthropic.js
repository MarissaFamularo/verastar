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
//   - models: extraction -> claude-opus-4-8; triage/interview -> claude-sonnet-5 / claude-haiku-4-5
//   - current models REJECT temperature / top_p / top_k / budget_tokens (400)
//   - structured output: output_config: { format: { type: "json_schema", schema } }
//   - do NOT combine citations with output_config.format (400) -> separate calls

import Anthropic from '@anthropic-ai/sdk'

const KEY_STORAGE = 'verastar.anthropic_key'
const NCBI_KEY_STORAGE = 'verastar.ncbi_key'
const NCBI_EMAIL_STORAGE = 'verastar.ncbi_email'

export const MODELS = {
  extraction: 'claude-opus-4-8',
  triage: 'claude-sonnet-5',
  interview: 'claude-sonnet-5',
  fast: 'claude-haiku-4-5-20251001',
}

// --- key management (session-backed by default, localStorage when remembered) ---

// The key lives in exactly ONE of the two stores at a time: remember=true moves it to
// localStorage (survives tab close, this device only), remember=false keeps it in
// sessionStorage (gone on tab close).
export function setApiKey(key, { remember = false } = {}) {
  const trimmed = key.trim()
  if (remember) {
    localStorage.setItem(KEY_STORAGE, trimmed)
    sessionStorage.removeItem(KEY_STORAGE)
  } else {
    sessionStorage.setItem(KEY_STORAGE, trimmed)
    localStorage.removeItem(KEY_STORAGE)
  }
}

export function getApiKey() {
  return sessionStorage.getItem(KEY_STORAGE) || localStorage.getItem(KEY_STORAGE) || ''
}

export function hasApiKey() {
  return getApiKey().length > 0
}

// True when the saved key persists across tab close (localStorage).
export function isKeyRemembered() {
  return !!localStorage.getItem(KEY_STORAGE)
}

export function clearApiKey() {
  sessionStorage.removeItem(KEY_STORAGE)
  localStorage.removeItem(KEY_STORAGE)
}

// Optional free NCBI key raises eutils from 3 -> 10 req/s. Also sessionStorage-only.
export function setNcbiKey(key) {
  sessionStorage.setItem(NCBI_KEY_STORAGE, key.trim())
}

export function getNcbiKey() {
  return sessionStorage.getItem(NCBI_KEY_STORAGE) || ''
}

// Optional email identifies us politely to NCBI (their contact-before-block channel).
export function setNcbiEmail(email) {
  sessionStorage.setItem(NCBI_EMAIL_STORAGE, email.trim())
}

export function getNcbiEmail() {
  return sessionStorage.getItem(NCBI_EMAIL_STORAGE) || ''
}

// --- client ---

let _client = null
let _clientKey = null

// Returns a memoized Anthropic client bound to the current sessionStorage key.
// Rebuilds if the key changed. Throws if no key is set — callers should gate on
// hasApiKey() and route the user to Setup.
export function getClient() {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('No Anthropic API key set. Add your key in Setup.')
  }
  if (!_client || _clientKey !== apiKey) {
    _client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
    _clientKey = apiKey
  }
  return _client
}

// Day-0 smoke test: a minimal round-trip that proves the key + browser-direct wiring
// works. Returns the model's text. Kept intentionally tiny.
export async function ping(prompt = 'Reply with exactly the word: pong') {
  const client = getClient()
  const res = await client.messages.create({
    model: MODELS.fast,
    max_tokens: 16,
    messages: [{ role: 'user', content: prompt }],
  })
  return res.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

// Structured-output call. `schema` is a JSON Schema per the output_config contract
// (additionalProperties:false + required on every object; nullable via anyOf; no
// minimum/maximum/minLength/recursion). Returns the parsed object. NOTE: never pass
// citations here — that is a separate call (combining them 400s).
export async function extractStructured({ model = MODELS.extraction, system, content, schema, maxTokens = 4096, thinking }) {
  const client = getClient()
  const res = await client.messages.create({
    model,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    ...(thinking ? { thinking } : {}),
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
  })
  const text = res.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return JSON.parse(text)
}
