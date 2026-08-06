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
  recordUsage(MODELS.fast, res.usage)
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
  recordUsage(model, res.usage)
  const text = res.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return JSON.parse(text)
}
