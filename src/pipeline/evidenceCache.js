// pipeline/evidenceCache.js — the shared extraction cache, client half.
//
// Extraction is not personalized: it reads source text and proposes typed quantities with
// verbatim quotes, so its output is the same for every reader of the same text. The cache
// stores that proposal keyed by (pmid, extraction version, sha256 of the exact source
// text). Two consequences worth stating plainly:
//
//   - A hit skips the MODEL CALL, not the verifier: the deterministic checks still run in
//     the reader's session against the source text they fetched. Those checks have
//     documented unchecked dimensions (arm, population, timepoint, surrounding claim), so a
//     replayed proposal can still surface a wrong badge; that is why only proposals with
//     server-owned provenance are shared.
//   - The hash makes the key honest. PMC XML, an abstract, and a user-supplied PDF of the
//     same paper are three different texts and get three different keys; a cached
//     proposal is only ever replayed against the text it came from.
//
// Trusted boundary (2026-10-09 review): reads and writes use evidence_cache_trusted only.
// Rows there are written by the scheduled digest, which fetched and hashed the source
// itself and ran the bundled extraction prompt/schema at CURRENT_EXTRACTION_VERSION, and
// each carries server-owned provenance (writer, bundle source hash). The legacy
// evidence_cache table, populated by the proxy from client-supplied keys, is preserved
// untouched and never read: a row without provenance is a miss. The browser never writes.
// Signed-out or unconfigured, every function here is a silent no-op.

import { cacheWireExtraction, encodeCachedExtraction } from '../../supabase/functions/_shared/extractionContract.js'
import { normalizeResultContexts } from './resultHandoff.js'
import { supabase, supabaseConfigured, isSignedIn } from '../lib/supabase.js'
import { CURRENT_EXTRACTION_VERSION } from '../lib/evidenceVersion.js'
import { currentServerScope } from '../lib/serverScope.js'

export const TRUSTED_CACHE_TABLE = 'evidence_cache_trusted'
export const TRUSTED_WRITER = 'digest-run'

// Tests only: a process-wide service-role writer. The digest edge function binds its
// writer through the request scope ({ cache: { client, userId, provenance } }) instead.
let _serverClient = null
let _serverUserId = null
let _serverProvenance = null
export function configureEvidenceCacheServer({ client, userId, provenance } = {}) {
  _serverClient = client || null
  _serverUserId = userId || null
  _serverProvenance = provenance || null
}

function serverWriter() {
  const scope = currentServerScope()
  if (scope) return scope.cache?.client ? scope.cache : null
  return _serverClient ? { client: _serverClient, userId: _serverUserId, provenance: _serverProvenance } : null
}

// Provenance the server attaches; never accepted from a client.
export function isTrustedProvenance(p) {
  return !!p && typeof p === 'object' && p.writer === TRUSTED_WRITER && /^[0-9a-f]{64}$/.test(String(p.bundle_source_sha256 || ''))
}

function readClient() {
  const writer = serverWriter()
  if (writer) return writer.client
  if (supabaseConfigured && isSignedIn()) return supabase
  return null
}

// Only source text the server fetched itself may populate the shared cache.
export const TRUSTED_WRITE_TIERS = ['full_text', 'abstract_only']

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
      .from(TRUSTED_CACHE_TABLE)
      .select('extraction, model, source_tier, provenance')
      .eq('pmid', String(pmid))
      .eq('extraction_version', version)
      .eq('source_hash', String(hash).toLowerCase())
      .maybeSingle()
    if (error || !data?.extraction || !isTrustedProvenance(data.provenance)) return null
    // Trusted rows hold an explicit envelope; anything else (older formats, foreign papers,
    // malformed rows) is a miss, never an inferred representation.
    const wire = cacheWireExtraction(data.extraction, pmid)
    return { ...data, extraction: { ...wire, result_contexts: normalizeResultContexts(wire.result_contexts) } }
  } catch {
    return null
  }
}

// Store a fresh extraction. Trusted server runtime only; a no-op elsewhere. Refuses
// user-supplied text, any version other than the current extraction version, and a writer
// without server provenance. Never throws; an existing row is never overwritten.
export async function storeCachedExtraction({ pmid, hash, tier, extraction, model, citation = null, version = CURRENT_EXTRACTION_VERSION }) {
  const writer = serverWriter()
  if (!writer || !pmid || !hash || !extraction) return false
  if (!TRUSTED_WRITE_TIERS.includes(tier) || version !== CURRENT_EXTRACTION_VERSION || !/^[0-9a-f]{64}$/i.test(String(hash))) return false
  if (!isTrustedProvenance(writer.provenance)) return false
  try {
    const { error } = await writer.client.from(TRUSTED_CACHE_TABLE).upsert({
      pmid: String(pmid),
      extraction_version: version,
      source_hash: String(hash).toLowerCase(),
      source_tier: tier,
      citation,
      extraction: encodeCachedExtraction(extraction, pmid),
      model: model || 'unknown',
      provenance: { ...writer.provenance, extraction_version: version, source_tier: tier },
      created_by: writer.userId || null,
    }, { onConflict: 'pmid,extraction_version,source_hash', ignoreDuplicates: true })
    return !error
  } catch {
    return false
  }
}
