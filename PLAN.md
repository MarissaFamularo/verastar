# Paper Trellis — one-week build plan

**Event:** Built with Claude: Life Sciences (Anthropic × Gladstone), Jul 7–13, 2026. Build track.
**Named user:** A practicing clinician-researcher who steers by a handful of recurring
concepts and can't keep up with the daily literature by hand. (Our first user is Dr.
Famularo — vascular surgery, CLTI / aortic / carotid, AI-in-medicine — but the app is
built to onboard any clinician's north stars.)
**One-line pitch:** A verifiable evidence digest — every citation proven against source
text by the app, never asserted by the model.

---

## Build order (verification first, on purpose)

The verification engine is the moat and the demo. Build it first; if we run out of
time, we cut the digest polish, never the verification.

### Phase 0 — Verification engine (the sacred core)
The deterministic layer that earns the "verified" badge.

- **Input:** a claim + a candidate supporting quote + a source (DOI → full text or abstract).
- **Process:** the app *independently* fetches the source text and matches the quote
  against it (exact match, then normalized/fuzzy for whitespace/hyphenation/OCR noise).
- **Output:** `verified` (quote found in source, with location) or `unverified` (flag,
  with what was and wasn't found). The model never sets this flag — the app does.
- **Guardrail:** numbers and named sources that can't be tied to fetched text are
  flagged, never rendered as fact.

Deliverable: given a paper + an extraction, the badge is correct and reproducible.

### Phase 1 — Steering profile
- North-star concepts + active projects.
- Digest rubric (design, N, relevance, novelty — user-weighted).

### Phase 2 — Daily digest
- Pull last 1–3 days from a source (PubMed E-utilities is the deterministic default;
  free, no key). Rank by rubric against north stars.
- Each item: title, why-it-matters, DOI link, PDF when access allows, verified
  extractions from Phase 0.

### Phase 3 — Knowledge Base
- Save a paper → deposits it with verified extractions attached.
- Reuses the structure of the existing personal KB (wiki + graph).

### Phase 4 — Weekend synthesis
- Weekly digest: connections across the week's saved reading and the north stars.
- Same verification rules apply to any quote it surfaces.

---

## Architecture sketch (to pressure-test)

- **BYO key.** User pastes an Anthropic API key; it stays client-side (local storage /
  local app), used to call the API directly. **Open question:** browser-direct calls
  need the dangerous-direct-browser-access header + CORS handling, or a thin local
  proxy. Decide Phase 0. Do not ship a key to a server we control.
- **Model does extraction + reasoning; app does verification.** Clean separation is
  what makes the badge trustworthy. The model proposes; the app disposes.
- **Sources:** PubMed E-utilities (metadata + abstracts, free). Full text via
  Unpaywall / PMC OA for open access; institutional access is user-configured.
- **Storage:** local-first for the KB (matches the "your reading stays yours" promise).

---

## MVP cut line (what has to work in the demo)

A clinician sets one north star → gets a daily digest of real recent papers → each
surfaced quote/value carries a badge the app can prove → one paper without verifiable
support is visibly *flagged, not faked* → save a good one to the KB. That single flow,
airtight, beats a broad app with a model you have to trust.

---

## Open questions — pull from the participant portal / acceptance email

- Exact submission deliverables (demo video? public repo? writeup?) and format.
- Submission deadline + time zone on Jul 13.
- Judging rubric weights.
- Whether the repo must be public (we've made it public regardless).
