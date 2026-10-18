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
import { sectionKind, SECTION_WINDOW_CHARS, assertEvidenceBatch, assertProseRequest, proseRequestBudget } from './evidenceWindow.js'

// The shared bound is checked, never sliced. Writer and checker receive identical
// complete evidence; duplicate finding/caution snippets are sent only once.
export const SNIPPET_CHARS = SECTION_WINDOW_CHARS

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

const SYSTEM = `You are a skeptical peer reviewer auditing one-sentence claims about medical papers before a clinician reads them. A claim may summarize a finding or state a methodological limitation. For each item you get the source snippet a claim was written from and the CLAIM itself. Judge ONLY whether the snippet supports the claim as stated:
- the direction of effect (improved / reduced / no significant difference / non-inferior / increased risk)
- what is compared to what, in which population, with which intervention
- the strength of the language (a null or non-significant result stated as a benefit is unsupported; the snippet's "may" stated as "does" is overstated)
- every factual clause and modifier must be supported independently; partial support is unsupported. If your reason says a detail is not stated or supported by the snippet, return supported=false, even if the rest of the sentence is correct. In particular, do not infer blinding status from a trial design or from quality-of-life outcomes.
- for a design caution, whether the named design, selection mechanism, matching method, exposure identification, setting, endpoint limitation, or causal constraint is supported by the snippet rather than invented
- the analysis and hypothesis: a claim that headlines a secondary, subgroup, per-protocol, or as-treated result as the study's main result, presents it as the randomized comparison, or omits or contradicts the PRIMARY result named in the item's CONTEXT line is unsupported; a noninferiority result stated as superiority (or the reverse), or a result at one timepoint or endpoint stated as another, is unsupported
- composite endpoint fidelity: the claim must not broaden, narrow, or re-define a composite endpoint's components or time window beyond what the snippet states. Refute a claim that treats any stroke as ipsilateral stroke, early-only (e.g. periprocedural or 30-day) death as death over all follow-up, or names components the snippet does not list, and refute a claim that states a definition of the primary endpoint when the snippet does not contain that definition (a claim that says only "the reported primary composite endpoint" is acceptable). Judge the claim AS RENDERED, including the meaning of any timepoint or component it names.
Numeric values in the claim were already verified against the source by a separate deterministic gate — do NOT judge the numbers themselves, only the prose claim around them. But number verification does NOT establish that the sentence means what the source means: still check which endpoint, component, population, and time window the numbers are attached to. A claim that is vaguer or more cautious than the snippet is supported. Refute (supported=false) when the claim reverses or overstates the direction, asserts an outcome the snippet does not state, or misattributes the population, intervention, or comparator. When genuinely uncertain whether the snippet supports the claim, refute — an unsupported claim shown to a clinician is worse than a supported one withheld. Return a verdict for EVERY item id you were given, each with a one-clause reason.`

// Audit findings against their source snippets. `items` is [{ id, finding, snippet }].
// Returns a Map of String(id) -> { verdict: 'supported'|'refuted'|'unchecked', reason }.
// Items with no finding or no snippet are 'unchecked' (nothing to audit / nothing to
// audit against) and are never sent to the model. One structured call on the cheap model.
export const NO_RESULTS_REASON = 'Not checked: the supplied evidence window has no identifiable Results text.'
export const NO_SNIPPET_REASON = 'Not checked: no source text was available to check this claim against.'

// Managed windows explicitly label their selected sections. Primary-result metadata
// is not source evidence. Design cautions can still be checked against Methods.
function missingResults(item) {
  if (item.claimType === 'design-caution') return false
  if (item.hasResults === false) return true
  const snippet = String(item.snippet || '')
  if (!snippet.startsWith('[Evidence window:')) return false
  const body = snippet.slice(snippet.indexOf('\n') + 1)
  // Full-text subsection labels can contain a hierarchy separator.
  return !body.split('\n').some((line) => {
    const colon = line.indexOf(':')
    return colon > 0 && line.slice(colon + 1).trim() &&
      sectionKind(line.slice(0, colon).split('›')[0]) === 'results'
  })
}

export async function checkFindings({ items, model = MODELS.fast, maxTokens }) {
  assertEvidenceBatch([...new Set((items || []).map(i => String(i.snippet || '')))])
  const out = new Map(
    (items || []).map((i) => [
      String(i.id),
      {
        verdict: 'unchecked',
        reason: missingResults(i) ? NO_RESULTS_REASON : String(i.finding || '').trim() && !String(i.snippet || '').trim() ? NO_SNIPPET_REASON : '',
      },
    ])
  )
  const checkable = (items || []).filter(
    (i) => String(i.finding || '').trim() && String(i.snippet || '').trim() && !missingResults(i)
  )
  if (!checkable.length) return out

  // A paper may now contribute two claims (finding + design caution). Group identical
  // snippets so the full evidence window rides on the call once per paper, not once per
  // claim; the new safety check should not double recurring input cost.
  const groups = []
  const bySnippet = new Map()
  for (const item of checkable) {
    const snippet = String(item.snippet)
    let group = bySnippet.get(snippet)
    if (!group) {
      group = { snippet, claims: [] }
      bySnippet.set(snippet, group)
      groups.push(group)
    }
    group.claims.push(item)
  }
  const content =
    `Items (${checkable.length}) across ${groups.length} source${groups.length === 1 ? '' : 's'}:\n\n` +
    groups.map((group) =>
      `SNIPPET:\n${group.snippet}\nCLAIMS:\n` +
      group.claims.map((i) => {
        const context = String(i.context || '').trim()
        return `[${i.id}] CLAIM: ${String(i.finding).trim()}${context ? `\n  CONTEXT: ${context}` : ''}`
      }).join('\n')
    ).join('\n\n')

  const outputTokens = maxTokens ?? Math.min(8192, Math.max(2048, checkable.length * 128))
  if (!proseRequestBudget(SYSTEM, content, CHECK_SCHEMA, outputTokens).fits && groups.length > 1) {
    const middle = Math.ceil(groups.length / 2)
    for (const groupSet of [groups.slice(0, middle), groups.slice(middle)]) {
      const snippets = new Set(groupSet.map(group => group.snippet))
      const checked = await checkFindings({ items: checkable.filter(item => snippets.has(String(item.snippet))), model, maxTokens })
      for (const [id, verdict] of checked) out.set(id, verdict)
    }
    return out
  }
  assertProseRequest(SYSTEM, content, CHECK_SCHEMA, outputTokens)
  const result = await extractStructured({ model, system: SYSTEM, content, schema: CHECK_SCHEMA, maxTokens: outputTokens })

  // Match each returned verdict to a claim id. Models echo ids with decoration ("[123]",
  // "CLAIM 123", "id: 123", quotes, stray spaces); normalizing that is bookkeeping, not
  // judgment. A verdict that still matches nothing is dropped — but now LOGGED, and every
  // claim left without a verdict says so in its reason instead of rendering silently
  // unchecked (2026-10-11 dev set: CAR-12 came back unchecked with no reason).
  const wanted = new Map(checkable.map((i) => [normalizeClaimId(i.id), String(i.id)]))
  const matched = new Set()
  const unmatched = []
  for (const v of result.verdicts || []) {
    const raw = String(v?.id ?? '')
    const key = wanted.get(normalizeClaimId(raw))
    if (!key) {
      unmatched.push(raw)
      continue
    }
    const verdict = v.supported === true && !reasonAdmitsMissingEvidence(v.reason) ? 'supported' : 'refuted'
    // A second verdict for the same claim can only make it stricter: any refute wins
    // (2026-10-14 beta audit: first-verdict-wins let a later refute be dropped).
    if (matched.has(key)) {
      if (verdict === 'refuted' && out.get(key)?.verdict !== 'refuted') out.set(key, { verdict, reason: String(v.reason || '').trim() })
      continue
    }
    matched.add(key)
    out.set(key, { verdict, reason: String(v.reason || '').trim() })
  }
  const missing = checkable.map((i) => String(i.id)).filter((id) => !matched.has(id))
  for (const id of missing) out.set(id, { verdict: 'unchecked', reason: NO_VERDICT_REASON })
  if (unmatched.length || missing.length) {
    console.warn(
      `Prose check: ${unmatched.length} verdict id(s) matched no claim [${unmatched.join(', ')}]; ` +
        `${missing.length} claim(s) got no verdict [${missing.join(', ')}] and render unchecked.`
    )
  }
  return out
}

// A positive boolean cannot override the checker's own admission of missing evidence.
// This is a conservative contradiction guard, not an independent source verifier.
// Scope negative reporting verbs to the source so "does not reduce mortality" and
// "the claim does not overstate" remain valid reasons for a supported null finding.
export function reasonAdmitsMissingEvidence(reason) {
  const text = String(reason || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ')
  return /\b(?:snippet|source|abstract|text|excerpt|passage|evidence)\s+(?:(?:does|do)\s+not|doesn't|don't|cannot|can't|fails?\s+to)\s+(?:explicitly\s+|directly\s+|clearly\s+)?(?:state|say|mention|report|describe|specify|establish|support|confirm|show|demonstrate|provide|contain)\b/i.test(text) ||
    /\b(?:not|never)\s+(?:explicitly\s+|directly\s+|clearly\s+)?(?:stated|mentioned|reported|described|specified|established|supported|confirmed|shown|provided|contained)\s+(?:in|by)\s+(?:the\s+)?(?:supplied\s+|provided\s+)?(?:snippet|source|abstract|text|excerpt|passage|evidence)\b/i.test(text) ||
    // Paraphrases of the same admission (2026-10-14 beta audit).
    /\b(?:snippet|source|abstract|text|excerpt|passage|evidence)\s+(?:is|was|remains)\s+silent\s+(?:on|about)\b/i.test(text) ||
    /\b(?:cannot|can't|could not|couldn't|unable to)\s+(?:be\s+)?(?:confirm(?:ed)?|verif(?:y|ied)|establish(?:ed)?|determine[d]?)\b[^.]*\b(?:from|against|in|by|with)\s+(?:the\s+)?(?:supplied\s+|provided\s+)?(?:snippet|source|abstract|text|excerpt|passage|evidence)\b/i.test(text) ||
    /\b(?:absent|missing)\s+from\s+(?:the\s+)?(?:supplied\s+|provided\s+)?(?:snippet|source|abstract|text|excerpt|passage|evidence)\b/i.test(text) ||
    /\bno\s+evidence\s+in\s+(?:the\s+)?(?:supplied\s+|provided\s+)?(?:snippet|source|abstract|text|excerpt|passage|evidence)\b/i.test(text)
}

export const NO_VERDICT_REASON = 'Not checked: the source checker returned no verdict for this claim.'

export function normalizeClaimId(id) {
  return String(id ?? '')
    .trim()
    .replace(/^[\s"'`[(]+|[\s"'`\])]+$/g, '')
    .replace(/^(?:claim|id|item|pmid)\s*(?:id)?\s*[:#=]?\s*/i, '')
    .replace(/^[\s"'`[(]+|[\s"'`\])]+$/g, '')
    .toLowerCase()
}
