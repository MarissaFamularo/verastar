// pipeline/evidenceCache.js — the shared extraction cache, client half.
//
// Extraction is not personalized: it reads source text and proposes typed quantities with
// verbatim quotes, so its output is the same for every reader of the same text. The cache
// stores that proposal keyed by (pmid, extraction version, sha256 of the exact source
// text). Two consequences worth stating plainly:
//
//   - A hit skips the MODEL CALL, never the PROOF. The verifier still runs in the reader's
//     own session against the source text they fetched. The badge is proven locally.
//   - The hash makes the key honest. PMC XML, an abstract, and a user-supplied PDF of the
//     same paper are three different texts and get three different keys; a cached
//     proposal is only ever replayed against the text it came from.
//
// Reads go straight to the table (RLS: any signed-in user). Writes happen only inside the
// sponsored proxy, which stores the model's response after a miss. Signed-out or
// unconfigured, every function here is a silent no-op.

import { supabase, supabaseConfigured, isSignedIn } from '../lib/supabase.js'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'

// Server runtime only: a service-role client that may also WRITE the cache, and the user
// the run is for. In the browser these stay null and writes never happen client-side.
let _serverClient = null
let _serverUserId = null
export function configureEvidenceCacheServer({ client, userId } = {}) {
  _serverClient = client || null
  _serverUserId = userId || null
}

function readClient() {
  if (_serverClient) return _serverClient
  if (supabaseConfigured && isSignedIn()) return supabase
  return null
}

export const SOURCE_TIERS = ['full_text', 'abstract_only', 'user_text']

// sha256 hex of a string. Web Crypto exists in every browser and in Node 20+.
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text ?? ''))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// The header value the proxy parses (functions/model/logic.js parseCacheHeader). Pure.
export function cacheKeyHeader({ pmid, hash, tier, version = CURRENT_EXTRACTION_VERSION }) {
  if (!pmid || !/^[0-9a-f]{64}$/i.test(String(hash || '')) || !SOURCE_TIERS.includes(tier)) return null
  return `${pmid}|${version}|${String(hash).toLowerCase()}|${tier}`
}

// Look for a cached extraction of exactly this source text. Resolves the stored
// extraction object or null. Never throws: a cache failure is a cache miss.
export async function lookupCachedExtraction({ pmid, hash, version = CURRENT_EXTRACTION_VERSION }) {
  const client = readClient()
  if (!client || !pmid || !hash) return null
  try {
    const { data, error } = await client
      .from('evidence_cache')
      .select('extraction, model, source_tier')
      .eq('pmid', String(pmid))
      .eq('extraction_version', version)
      .eq('source_hash', String(hash).toLowerCase())
      .maybeSingle()
    if (error || !data?.extraction) return null
    return data
  } catch {
    return null
  }
}

// Store a fresh extraction. Server runtime only: the browser never holds a client that may
// write here (the sponsored proxy does it after a miss). No-op elsewhere; never throws.
export async function storeCachedExtraction({ pmid, hash, tier, extraction, model, citation = null, version = CURRENT_EXTRACTION_VERSION }) {
  if (!_serverClient || !pmid || !hash || !extraction) return false
  try {
    const { error } = await _serverClient.from('evidence_cache').upsert({
      pmid: String(pmid),
      extraction_version: version,
      source_hash: String(hash).toLowerCase(),
      source_tier: tier,
      citation,
      extraction,
      model: model || 'unknown',
      created_by: _serverUserId,
    }, { onConflict: 'pmid,extraction_version,source_hash', ignoreDuplicates: true })
    return !error
  } catch {
    return false
  }
}
