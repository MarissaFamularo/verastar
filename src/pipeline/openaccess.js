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
const CONTACT_EMAIL = 'caivory03@gmail.com'

// Pure: pick the best OA *PDF* url from an Unpaywall response. Prefers a direct PDF (`url_for_pdf`);
// returns null when the paper isn't OA, has no best location, or that location is only a landing
// page (we keep the "PDF" label honest — a landing page is not a PDF). Split out so it's unit-testable
// without a network call.
export function pickOaPdf(data) {
  if (!data || data.is_oa === false) return null
  const loc = data.best_oa_location
  if (!loc) return null
  return loc.url_for_pdf || null
}

// Resolve a DOI to a direct open-access PDF url, or null. Never throws: a missing DOI, a network
// hiccup, a non-OA paper, or a rate-limit all resolve to null, so the caller behaves exactly as it
// did before this feature existed (no PDF link).
export async function resolveOaPdf(doi) {
  if (!doi) return null
  try {
    const resp = await fetch(
      `${UNPAYWALL}/${encodeURIComponent(doi)}?email=${encodeURIComponent(CONTACT_EMAIL)}`,
    )
    if (!resp.ok) return null
    return pickOaPdf(await resp.json())
  } catch {
    return null
  }
}
