# Verastar

**A verifiable evidence digest for clinicians.**

*Vera* (truth) + *star* (your north stars): verified evidence, aimed at the concepts
you steer by.

You tell Verastar your *north-star concepts* and your active research projects.
Every morning it hands you a digest of the last 1–3 days of literature that actually
moves those north stars forward. Open the PubMed page, or the full-text PDF when the
paper is open access. If a paper earns its salt, save it into your **Library**. The
**Connections** view then surfaces the links between what you've read and the projects
you're working on. And everything you save is written as plain markdown into a folder
you own — your reading and your memory, on your own machine, never locked inside an app.

It is the app version of a system I already run by hand: a personal knowledge base, a
context portfolio, and a daily research briefing. Verastar makes it something any
clinician can pick up — and I built it end-to-end with Claude Code, as a physician who
never wrote a line of code before late 2025.

Built for **Built with Claude: Life Sciences** (Anthropic × Gladstone Institutes),
July 7–13, 2026 — **Build track**.

---

## The sacred core: verifiable, never fabricated

Most "AI research digest" tools ask you to trust the model. Verastar does the
opposite. Two non-negotiable rules govern everything:

1. **Quote-verification is the sacred core — built and protected first.**
   Every quote, value, or citation the digest surfaces carries a *verified* badge.
   The badge is **proven by the app**, by independently matching the quote against the
   real source text — **never asserted by the model.** If the app can't find the quote
   in the source, there is no badge.

2. **Never fabricate a value or a source. Flag instead.**
   If a claim can't be tied to verifiable source text, Verastar does not smooth
   over it or invent a plausible citation. It flags the gap and shows you exactly what
   it could and couldn't confirm.

This is the whole point. Provenance is the product, not a footer.

---

## How it works

1. **Set your north stars.** Define the concepts you're steering by, plus any active
   projects. This is your steering profile (the app version of a context portfolio).
2. **Tune your digest rubric.** What counts as "worth your salt" — study design,
   sample size, relevance to a north star, novelty. You set the bar.
3. **Daily digest.** Each morning: papers from the last 1–3 days that advance your
   north stars, ranked by your rubric. Each item links to the DOI and offers the PDF
   when access allows.
4. **Save what earns it.** One click deposits a paper into your **Library** with its
   verified extractions attached — and writes it as plain markdown to a folder you own.
5. **Connections.** The Connections view surfaces throughlines across the week's
   reading, your existing library, and your active projects.

---

## Bring your own API key

Verastar runs on **your** Anthropic API key. You paste it in; the app uses it to
do the work. No shared model bill, no lock-in, and your key and reading stay yours.

---

## Run it locally

Verastar is a static React + Vite app — no backend, nothing to deploy.

```bash
git clone https://github.com/MarissaFamularo/verastar.git
cd verastar
npm install
npm run dev
```

Open the printed `localhost` URL, open **Settings**, and paste your Anthropic API
key. That's it — the digest, verifier, and library all run in your browser on your
key. **Chrome or Edge recommended:** the "file your library to disk" feature uses the
File System Access API, which Safari and Firefox don't support.

Requires Node 18+. Run the test suite with `npm test` (181 tests, including
adversarial false-verify cases).

---

## Status

Built during **Built with Claude: Life Sciences** (July 7–13, 2026) and live at
**[verastar.netlify.app](https://verastar.netlify.app)** — bring your own Anthropic key
to run it. Design + planning docs:

- [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md) — scope, build order, never-cut list, demo script.
- [docs/VERIFICATION_SPEC.md](docs/VERIFICATION_SPEC.md) — the sacred core: the gate, algorithm, tiers, integrity rules.
- [docs/EVAL.md](docs/EVAL.md) — proving the verifier never lies: precision-first metric, ground-truth sources.
- [docs/FACTS.md](docs/FACTS.md) — locked API + data facts and the demo corpus.
