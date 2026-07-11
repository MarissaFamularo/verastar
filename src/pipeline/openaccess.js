// pipeline/openaccess.js — resolve a legal open-access PDF LINK for a paper via Unpaywall.
//
// Why a link, not a file: browser byte-download of PDFs is a dead end — PMC and publisher OA hosts
// don't send `Access-Control-Allow-Origin`, so a cross-origin fetch of the bytes is blocked (a
// `no-cors` fetch returns an unreadable opaque body). So we resolve a clickable PDF URL the
// clinician can open in their own browser (where cookies/session apply, no CORS), and write that
// link into the note. This also FIXES the old broken PMC link: NCBI migrated PMC to a new host and
// the templated `…/pmc/articles/<id>/pdf/` path now 404s — Unpaywall returns a URL that actually works.
//
// Unpaywall is free, CORS-open, no key (100k/day). It requires only a contact email per request.

const UNPAYWALL = 'https://api.unpaywall.org/v2'
// Unpaywall's politeness policy wants a contact email on every call. Not a secret, not stored.
const CONTACT_EMAIL = 'statupfordocs@gmail.com'

// Pure: pick the best OA link from an Unpaywall response. Prefers a direct PDF (`url_for_pdf`)
// but keeps a landing-page-only location too — some gold-OA publishers (e.g. Lippincott) never
// expose a direct PDF url, and dropping those made genuinely free papers look paywalled. The
// `isPdf` flag keeps the UI label honest: a landing page is free full text, not a "PDF". Split
// out so it's unit-testable without a network call.
export function pickOaLink(data) {
  if (!data || data.is_oa === false) return null
  const loc = data.best_oa_location
  if (!loc) return null
  if (loc.url_for_pdf) return { url: loc.url_for_pdf, isPdf: true }
  if (loc.url) return { url: loc.url, isPdf: false }
  return null
}

// The paper-record patch for a resolved OA link: a direct PDF fills pdfUrl, a landing-page-only
// location fills oaUrl. Pure, shared by save-time enrichment, the Library backfill, and the
// on-disk deposit.
export function oaPatch(link) {
  if (!link?.url) return null
  return link.isPdf ? { pdfUrl: link.url } : { oaUrl: link.url }
}

// Resolve a DOI to its best open-access link — { url, isPdf } — or null. Never throws: a missing
// DOI, a network hiccup, a non-OA paper, or a rate-limit all resolve to null, so the caller
// behaves exactly as it did before this feature existed (no free-full-text link).
export async function resolveOaLink(doi) {
  if (!doi) return null
  try {
    const resp = await fetch(
      `${UNPAYWALL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(CONTACT_EMAIL)}`,
    )
    if (!resp.ok) return null
    return pickOaLink(await resp.json())
  } catch {
    return null
  }
}
