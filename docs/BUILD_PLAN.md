# Verastar — build plan

*Authored 2026-07-07. Built with Claude: Life Sciences (Anthropic × Gladstone), Jul 7–13.
Build track. Solo + Claude Code, fresh repo, all product code written live during the event.*

## Thesis + named user
A busy clinician-researcher steers by a few recurring concepts (north stars) and can't
keep up with the daily literature by hand. Verastar gives them the loop: **current**
(daily digest) · **organized** (projects) · **connected** (graph edges) — and makes
every surfaced number **click-traceable to its exact source, or flagged when it can't
be verified.** Demo persona: Dr. Reyes (fictional, built live in the onboarding
interview). First real user: a vascular-surgery / CLTI / AI-in-medicine clinician.

## The P0 spine (must work even if nothing else does)
fetch a paper → extract quantities with a verbatim `source_quote` → **deterministically
verify** the quote + numbers against fetched text → badge it. Everything (UI, graph,
digests) hangs off this. Spec: [VERIFICATION_SPEC.md](VERIFICATION_SPEC.md).

## Locked decisions
1. Numeric check = tokenized float-equality, no substring, no rounding tolerance.
2. `verified-against-registry` requires the value to match the CT.gov posted outcome.
3. Live-swing entry = DOI→PMID→PMCID with a CrossRef fallback; worst case flags.
4. **Local-first / IndexedDB**, behind a `store.js` interface (Supabase is a P2 swap).
5. Onboarding interview drafts the rubric, with a hardcoded Dr. Reyes rubric fallback.
6. Never-cut / cut-order lists below.

## Scope
**Never cut:** extraction → verify → badges → one click-to-source → refuse-to-pool card
→ one live connection card (paper → project → graph edge).
**Cut order if behind:** Weekend digest → Weekly digest → live rubric re-rank → PDF drop.

## Module layout (fresh repo)
```
src/
  lib/anthropic.js   // BYOK client factory (sessionStorage key)
  lib/store.js       // ONE storage interface; IndexedDB impl first
  pipeline/
    sources.js       // eUtils / PMC OA / CT.gov / idconv / DOI+CrossRef fetchers
    triage.js        // one-call ranked triage vs rubric + north stars + projects
    extract.js       // Opus 4.8 structured extraction → quantities[]
    verify.js        // ← SACRED CORE
    figures.js       // effect-size figures from verified values; poolability guard
  pages/             // Setup, DailyDigest, KnowledgeGraph, ActiveProjects, Weekly, Northstar
  components/        // digest card, provenance badge, source-highlight viewer, rubric editor
```

## Build order (adjust to the real event schedule)
- **Day 0 — setup.** `npm create vite@latest` (React) → Tailwind → `@anthropic-ai/sdk`.
  Add `lib/anthropic.js` + `lib/store.js` (IndexedDB).
  *Done when:* app runs and a hardcoded browser call to Anthropic returns a response.
- **Spine day.** `sources.js` fetches one PMC OA paper + its CT.gov record; `extract.js`
  returns `quantities[]`; `verify.js` assigns tiers.
  *Done when:* the [VERIFICATION_SPEC test oracle](VERIFICATION_SPEC.md#test-oracle)
  passes — BASIL-3 verified-full-text, STARDUST verified-registry, a corrupted value
  flagged — as badges on a bare page.
- **Daily digest UI.** Effect-size figure from verified values only; click-a-value →
  highlight its source sentence; refuse-to-pool card; citations-API hero-number jump.
  *Done when:* clicking BASIL-3's HR scrolls to + highlights the exact sentence, and a
  heterogeneous set renders the refuse-to-pool card instead of a chart.
- **Setup interview + rubric + live re-rank.** Interview drafts the rubric (fallback:
  hardcoded Dr. Reyes); `triage.js` ranks candidates in one call; editing the rubric
  re-ranks live via prompt cache.
  *Done when:* a fresh run builds Dr. Reyes's rubric and editing it visibly re-orders papers.
- **Graph + projects + connection card.** `react-force-graph`; "save to graph" writes a
  paper node + project edge; per-project relevance renders a connection card.
  *Done when:* a digest card's "Connects to [project]" click adds a wired node.
- **Polish + demo.** Cache the 3 spotlight papers' **source docs** (PMC XML, CT.gov JSON)
  so venue wifi can't flake — pipeline still runs live on them (cached source, not cached
  results). Deploy a preview. Rehearse the 5-min script + the live swing.

## Demo script (5 min, cold start, no personal data)
Open empty app → onboarding interview builds Dr. Reyes's rubric live → "Run today's scan"
→ click BASIL-3's HR, jump to the exact source sentence → STARDUST shows
*verified-against-registry* → refuse-to-pool card on a heterogeneous question → a
*flagged* value greyed, not charted → connection card wires a paper to a project →
edit the rubric, papers re-rank live → **live swing:** a judge pastes any DOI; worst
case it flags, never fabricates. "Two minutes ago this app was blank."

## Open questions — confirm from the participant portal / acceptance email
- Exact submission deliverables (demo video? public repo? writeup?) and format.
- Submission deadline + time zone on Jul 13.
- Judging rubric weights.
- The precise "written during the event" rule for code (we assume the strict reading).
