// supabase/functions/_shared/requestPolicy.js — what a sponsor-paid request may contain.
//
// Every sponsor-funded provider attempt (browser via the `model` proxy, or the scheduled
// digest via its guarded fetch) is checked here BEFORE any reservation, and the request
// that is forwarded is rebuilt from the checked fields only. Anything not listed is
// rejected rather than dropped, so a caller learns its request was not what it thought.
//
// Admitted shape (exactly what src/lib/anthropic.js extractStructured/ping send):
//   { model, max_tokens, messages, system?, thinking?, output_config? }
//   - model: an exact id from pricing.js
//   - max_tokens: integer 1..MAX_OUTPUT_TOKENS (and <= the model's own output limit)
//   - messages: 1..MAX_MESSAGES of { role: 'user'|'assistant', content }, content a string or
//     an array of { type: 'text', text } blocks (no images, documents, tools, cache_control,
//     citations)
//   - system: a string or an array of { type: 'text', text } blocks
//   - thinking: { type } with a type pricing.js admits for that model
//   - output_config: { format: { type: 'json_schema', schema } }, schema <= MAX_SCHEMA_BYTES
// Rejected: stream, tools, tool_choice, metadata, service_tier, inference_geo, speed,
// stop_sequences, temperature/top_p/top_k, container, mcp_servers, cache_control anywhere,
// and any other key.
//
// Reservation bound (2026-10-09 review): input is bounded by the model's documented
// context window, not by an estimate from the payload. The API rejects any request whose
// input alone exceeds the context window ("prompt is too long", context-windows page), so
// input_tokens + cache reads + cache writes <= contextWindowTokens for every request that
// can be billed. Output, including thinking, is bounded by max_tokens. MAX_BODY_BYTES is a
// payload limit (memory, abuse), not a billing proof: no claim is made about tokens per
// byte. The cost of this hard bound is that each attempt reserves the full-context price
// (about $2.00 of input for Sonnet 5.5, $0.20 for Haiku 4.5) until it settles to actual.

import { PRICES, isSupportedModel, maxChargeMicro } from './pricing.js'

export const MAX_BODY_BYTES = 1_000_000
export const MAX_OUTPUT_TOKENS = 32_000
export const MAX_MESSAGES = 16
export const MAX_SCHEMA_BYTES = 64_000

const TOP_LEVEL = new Set(['model', 'max_tokens', 'messages', 'system', 'thinking', 'output_config'])

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const onlyKeys = (o, keys) => Object.keys(o).every((k) => keys.includes(k))

function checkTextBlocks(blocks, where) {
  if (!Array.isArray(blocks) || blocks.length === 0) return `${where} must be a non-empty string or array of text blocks.`
  for (const b of blocks) {
    if (!isObj(b) || b.type !== 'text' || typeof b.text !== 'string' || !onlyKeys(b, ['type', 'text'])) {
      return `${where} accepts only { type: 'text', text } blocks.`
    }
  }
  return null
}

function checkContent(content, where) {
  if (typeof content === 'string') return content.length ? null : `${where} is empty.`
  return checkTextBlocks(content, where)
}

const utf8Bytes = (s) => new TextEncoder().encode(s).length

// Validate a parsed body. Returns { ok: false, error } or
// { ok: true, forward, forwardText, bound: { maxInputTokens, maxOutputTokens, micro } }.
// `forward` is the rebuilt request; `forwardText` is exactly what is sent upstream.
export function checkPaidRequest(body) {
  if (!isObj(body)) return { ok: false, error: 'Request body must be a JSON object.' }
  if (body.stream !== undefined) return { ok: false, error: 'Streaming is not supported through the sponsored proxy.' }
  for (const k of Object.keys(body)) {
    if (!TOP_LEVEL.has(k)) return { ok: false, error: `Field "${k}" is not accepted by the sponsored proxy.` }
  }
  if (!isSupportedModel(body.model)) return { ok: false, error: 'That model is not available through the sponsored proxy.' }
  const price = PRICES[body.model]

  const max = body.max_tokens
  if (!Number.isSafeInteger(max) || max < 1 || max > Math.min(MAX_OUTPUT_TOKENS, price.maxOutputTokens)) {
    return { ok: false, error: `max_tokens must be an integer between 1 and ${Math.min(MAX_OUTPUT_TOKENS, price.maxOutputTokens)}.` }
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
    return { ok: false, error: `messages must hold 1 to ${MAX_MESSAGES} entries.` }
  }
  for (const [i, m] of body.messages.entries()) {
    if (!isObj(m) || !onlyKeys(m, ['role', 'content']) || !['user', 'assistant'].includes(m.role)) {
      return { ok: false, error: `messages[${i}] must be { role: 'user'|'assistant', content }.` }
    }
    const bad = checkContent(m.content, `messages[${i}].content`)
    if (bad) return { ok: false, error: bad }
  }

  if (body.system !== undefined) {
    const bad = checkContent(body.system, 'system')
    if (bad) return { ok: false, error: bad }
  }

  if (body.thinking !== undefined) {
    const t = body.thinking
    if (!isObj(t) || !onlyKeys(t, ['type']) || !price.thinking.includes(t.type)) {
      return { ok: false, error: `thinking must be one of ${price.thinking.map((x) => `{ type: '${x}' }`).join(', ')} for ${body.model}.` }
    }
  }

  if (body.output_config !== undefined) {
    const oc = body.output_config
    const f = oc?.format
    if (!isObj(oc) || !onlyKeys(oc, ['format']) || !isObj(f) || !onlyKeys(f, ['type', 'schema']) || f.type !== 'json_schema' || !isObj(f.schema)) {
      return { ok: false, error: "output_config accepts only { format: { type: 'json_schema', schema } }." }
    }
    if (utf8Bytes(JSON.stringify(f.schema)) > MAX_SCHEMA_BYTES) return { ok: false, error: 'The output schema is too large.' }
  }

  // Rebuild from checked fields only, in a fixed order, so the fingerprint is canonical
  // for the same logical request.
  const forward = { model: body.model, max_tokens: max }
  if (body.system !== undefined) forward.system = body.system
  if (body.thinking !== undefined) forward.thinking = { type: body.thinking.type }
  forward.messages = body.messages
  if (body.output_config !== undefined) forward.output_config = { format: { type: 'json_schema', schema: body.output_config.format.schema } }

  const forwardText = JSON.stringify(forward)
  // cache_control is a chargeable feature (cache writes) at any depth; the rebuild above
  // already removes it from known places, and this catches it inside the schema too.
  if (/"cache_control"\s*:/.test(forwardText)) return { ok: false, error: 'Prompt caching is not accepted by the sponsored proxy.' }
  const bytes = utf8Bytes(forwardText)
  if (bytes > MAX_BODY_BYTES) return { ok: false, error: 'Request is too large for the sponsored proxy.' }

  const maxInputTokens = price.contextWindowTokens
  const maxOutputTokens = max
  return {
    ok: true,
    forward,
    forwardText,
    bound: { maxInputTokens, maxOutputTokens, micro: maxChargeMicro(body.model, { maxInputTokens, maxOutputTokens }) },
  }
}

// Read a request body without letting an oversized one into memory. Honors a declared
// Content-Length first, then counts the streamed bytes. Resolves { ok, text } or
// { ok: false, status, error }.
export async function readBoundedText(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) return { ok: false, status: 413, error: 'Request is too large for the sponsored proxy.' }
  if (!req.body) return { ok: true, text: '' }
  const reader = req.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      try { await reader.cancel() } catch { /* already closed */ }
      return { ok: false, status: 413, error: 'Request is too large for the sponsored proxy.' }
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(all) }
  } catch {
    return { ok: false, status: 400, error: 'Body must be UTF-8 JSON.' }
  }
}

// SHA-256 hex of the canonical forwarded request plus its ledger purpose: the identity a
// request id is bound to.
export async function requestFingerprint(forwardText, purpose) {
  const bytes = new TextEncoder().encode(`${purpose || ''}\n${forwardText}`)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
