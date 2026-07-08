# Verastar — build plan

*Authored 2026-07-07. Built with Claude: Life Sciences (Anthropic × Gladstone).
**Build track.** Solo + Claude Code, fresh repo, all product code written live during
the event per the "new work only" rule.*

## Event facts (confirmed from the participant guide)
- **Hacking window:** Tue Jul 7, 12:30 PM ET → **submissions due Mon Jul 13, 9:00 PM ET**
  via the CV platform (~6.5 days).
- **Deliverables:** (1) **3-minute-max demo video** (YouTube/Loom), (2) **open-source
  GitHub repo** under an approved license, (3) **100–200 word written summary**.
- **Rules:** open source required; **new work only — started from scratch during the
  event, no previous work**; teams ≤ 2. Pre-existing `~/Desktop/evidence-digest/` work
  stays out of this repo; the smoke test is re-implemented live, never copied.
- **Judging:** async (Jul 14–15) → top 3/track → live final (Jul 16). Weights below.

## Judging criteria & how Verastar scores (this drives every tradeoff)
| Criterion | Weight | Our play |
|---|---|---|
| **Demo** | **30%** | The 3-min video is the highest-leverage artifact. Click-to-source, the *flagged* value, and the on-camera live swing are built to be "cool to watch." |
| **Impact** | 25% | Named user is **real and it's the builder** — a practicing vascular surgeon who needs this daily. Adjacent to their own trial-matcher example ("reasoning shown for every match"). |
| **Claude Use** | 25% | *The* differentiator, and where generic apps lose. Narrate the pattern: **a deterministic verifier gates the model — Claude cannot assert a citation the app hasn't proven.** Plus structured output, the citations API for exact click-to-source, prompt-cache live re-rank. "Claude Science should ship this." |
| **Depth & Execution** | 20% | Show the craft: the two integrity fixes, interpunct-decimal normalization, refuse-to-pool. Evidence we wrestled past the first idea. |

## Thesis + named user
A busy clinician-researcher steers by a few recurring concepts (north stars) and can't
keep up with the daily literature by hand. Verastar gives them the loop: **current**
(daily digest) · **organized** (projects) · **connected** (graph edges) — and makes
every surfaced number **click-traceable to its exact source, or flagged when it can't
be verified.** **Named user: a practicing vascular-surgery / CLTI / AI-in-medicine
clinician — real, not hypothetical.** Demo driver: Dr. Reyes (a stand-in built live in
the onboarding interview so the demo starts from a truly empty app).

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
- **Polish + video + summary (Sun–Mon).** Cache the 3 spotlight papers' **source docs**
  (PMC XML, CT.gov JSON) so wifi can't flake — pipeline still runs live on them (cached
  source, not cached results). Deploy a preview. **Record the 3-min video** and write the
  **100–200 word summary.** Submit by Mon 9:00 PM ET (aim: Sun night, buffer for reshoot).

## Demo video script (3-minute MAX — the 30% artifact; pre-recorded)
Ruthless cut. Every second earns its place.
- **0:00–0:20** — Empty app. "An hour ago this repo didn't exist. I'm a vascular surgeon;
  I can't read everything. Here's the tool I built to trust what I do read."
- **0:20–0:45** — Set one north star → "Run today's scan" → digest appears, ranked.
- **0:45–1:35** — **The core.** Click BASIL-3's HR → viewer jumps to and highlights the
  exact source sentence. "The app *proved* this number is in the paper — the model never
  asserted it." Show the badge tiers.
- **1:35–2:05** — STARDUST *verified-against-registry* (value matches CT.gov). Then a
  heterogeneous question → the **refuse-to-pool** card instead of a misleading chart.
- **2:05–2:30** — A **flagged** value: greyed, not charted. "It refuses to fabricate."
- **2:30–2:55** — **Live swing, on camera:** paste a random DOI → worst case it flags,
  never invents. Connection card wires paper → project → graph edge.
- **2:55–3:00** — "Provenance you can click. Claude Science should ship this."

## Written summary (100–200 words) — draft during polish
Lead with the named user and the one-sentence wedge (verified, never fabricated); name
the Claude-use pattern (deterministic verifier gating the model); end on impact.
