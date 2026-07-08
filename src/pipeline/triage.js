// pipeline/triage.js — the REASONING channel (one cheap call, not the gated facts).
//
// This writes the DIGEST prose the clinician actually reads: an evidence tier, a
// plain-language finding (what the study showed), and a relevance line tied to their
// north stars and active projects. Numbers are shown separately as app-verified facts —
// the reasoning here is number-free (two-channel rule) and is written from ONLY the
// values the app verified, so the readable summary is grounded in proven facts.

import { extractStructured, MODELS } from '../lib/anthropic.js'

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rankings'],
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'score', 'tier', 'finding', 'relevance'],
        properties: {
          id: { type: 'string' },
          score: { type: 'integer' }, // 0–100 fit to north stars/projects; ranking only
          tier: { type: 'integer' }, // evidence tier: 1 = strongest, 3 = weakest
          finding: { type: 'string' },
          relevance: { type: 'string' },
        },
      },
    },
  },
}

const SYSTEM = `You brief a busy clinician-researcher on today's new papers, in the style of a morning literature digest. For each paper you get its title, a snippet, the study design, and the results the app has INDEPENDENTLY VERIFIED against the source. Return per paper:

- score: integer 0–100 — fit to the clinician's north stars and active projects (100 = directly, importantly advances one; 0 = irrelevant). Drives ordering.
- tier: integer 1–3 evidence strength. 1 = strongest (well-powered RCT, meta-analysis of RCTs, or a rigorous practice-relevant study); 2 = solid observational / cohort / smaller trial; 3 = limited (case series, single-arm, preliminary). Judge from study design, apparent sample size, and rigor.
- finding: ONE plain sentence — what the study SHOWED, the takeaway a clinician would repeat to a colleague, stated directionally (improved / reduced / no significant difference / non-inferior / increased risk). Prefer the verified results; when a paper has no verified numeric results (e.g. a narrative review or methods piece), summarize its conclusion from the snippet instead. Never invent a specific result. EVERY paper gets a finding.
- relevance: ONE short clause on why it matters to THIS clinician — name the specific north star or project it touches (e.g. "adjacent to your CLTI perfusion work" or "validates your hospital-free-days endpoint").

HARD RULE: neither finding nor relevance may contain any number, effect size, hazard/risk ratio, confidence interval, p-value, percentage, or sample size. Convey magnitude and significance in words ("significantly improved", "roughly halved the risk", "no meaningful difference") — never with digits. The numbers are shown separately as verified facts.`

// candidates: [{ id, title, summary, design, verified: [{name, value}] }]
// Returns [{ id, score, tier, finding, relevance }]. One structured call on a cheap model.
export async function triage({
  northStars = [],
  projects = [],
  candidates,
  model = MODELS.triage,
  maxTokens = 8192,
}) {
  const stars = northStars.length ? northStars.join(', ') : '(none set)'
  const projs = projects.length ? projects.join(', ') : '(none set)'
  const content =
    `North stars: ${stars}\nActive projects: ${projs}\n\nCandidates:\n\n` +
    candidates
      .map((c) => {
        const facts = (c.verified || []).length
          ? c.verified.map((v) => `  - ${v.name}: ${v.value}`).join('\n')
          : '  (no verified values)'
        return `[${c.id}] ${c.title}\nDesign: ${c.design || 'unknown'}\n${(c.summary || '').slice(0, 900)}\nVerified results:\n${facts}`
      })
      .join('\n\n')

  const result = await extractStructured({
    model,
    system: SYSTEM,
    content,
    schema: TRIAGE_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' }, // ranking/summary is not a reasoning task; keep output for JSON
  })
  return result.rankings ?? []
}
