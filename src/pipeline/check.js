// pipeline/check.js — the PROSE gate: an adversarial source-check on the digest's
// finding sentences. The number guard (triage.js sanitizeRanking) proves every DIGIT;
// this pass covers what digits can't — direction of effect, comparator, population,
// strength of language. A cheap skeptic model reads the same snippet the finding was
// written from and tries to REFUTE the sentence. Same bias as the number guard and the
// verifier: a supported claim that gets withheld is annoying; an unsupported claim that
// renders to a clinician is fatal — so uncertainty resolves to refuted, and the UI
// withholds a refuted finding instead of rendering it.
//
// This gate is advisory-by-construction where the number guard is deterministic: it is
// itself a model call, so it can NEVER block the digest — any failure (network, parse,
// missing verdict) degrades to 'unchecked', which renders exactly as before this gate
// existed. Wired inside triage() so the digest and Add-a-paper are both covered with no
// opt-out at the call sites.

import { extractStructured, MODELS } from '../lib/anthropic.js'

// The evidence window, shared with triage's writer prompt so the skeptic judges the
// claim against EXACTLY the text the writer saw: more text could "support" a claim the
// writer never had evidence for; less would manufacture refutes.
export const SNIPPET_CHARS = 900

export const CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'supported', 'reason'],
        properties: {
          id: { type: 'string' }, // the paper's pmid, echoed back
          supported: { type: 'boolean' },
          reason: { type: 'string' }, // one short clause; shown to the clinician on refute
        },
      },
    },
  },
}

const SYSTEM = `You are a skeptical peer reviewer auditing one-sentence summaries ("claims") of medical papers before a clinician reads them. For each item you get the source snippet a claim was written from and the CLAIM itself. Judge ONLY whether the snippet supports the claim as stated:
- the direction of effect (improved / reduced / no significant difference / non-inferior / increased risk)
- what is compared to what, in which population, with which intervention
- the strength of the language (a null or non-significant result stated as a benefit is unsupported; the snippet's "may" stated as "does" is overstated)
Numeric values in the claim were already verified against the source by a separate deterministic gate — do NOT judge the numbers themselves, only the prose claim around them. A claim that is vaguer or more cautious than the snippet is supported. Refute (supported=false) when the claim reverses or overstates the direction, asserts an outcome the snippet does not state, or misattributes the population, intervention, or comparator. When genuinely uncertain whether the snippet supports the claim, refute — an unsupported claim shown to a clinician is worse than a supported one withheld. Return a verdict for EVERY item id you were given, each with a one-clause reason.`

// Audit findings against their source snippets. `items` is [{ id, finding, snippet }].
// Returns a Map of String(id) -> { verdict: 'supported'|'refuted'|'unchecked', reason }.
// Items with no finding or no snippet are 'unchecked' (nothing to audit / nothing to
// audit against) and are never sent to the model. One structured call on the cheap model.
export async function checkFindings({ items, model = MODELS.fast, maxTokens = 2048 }) {
  const out = new Map(
    (items || []).map((i) => [String(i.id), { verdict: 'unchecked', reason: '' }])
  )
  const checkable = (items || []).filter(
    (i) => String(i.finding || '').trim() && String(i.snippet || '').trim()
  )
  if (!checkable.length) return out

  const content =
    `Items (${checkable.length}):\n\n` +
    checkable
      .map(
        (i) =>
          `[${i.id}]\nSNIPPET:\n${String(i.snippet).slice(0, SNIPPET_CHARS)}\nCLAIM: ${String(i.finding).trim()}`
      )
      .join('\n\n')

  const result = await extractStructured({ model, system: SYSTEM, content, schema: CHECK_SCHEMA, maxTokens })

  for (const v of result.verdicts || []) {
    const key = String(v?.id)
    // An id the model invented is dropped; an id it omitted stays 'unchecked'.
    if (out.has(key)) {
      out.set(key, {
        verdict: v.supported ? 'supported' : 'refuted',
        reason: String(v.reason || '').trim(),
      })
    }
  }
  return out
}
