import { PILOT_DIGEST_LIMIT } from './digestLimit.js'
// pipeline/triage.js — the REASONING channel (one cheap call, not the gated facts).
//
// This writes the DIGEST prose the clinician actually reads: an evidence tier, a
// plain-language finding (what the study showed), and a relevance line tied to their
// north stars and active projects. Two-channel rule, current form: the `finding` MAY
// carry numbers, but ONLY numbers the app already verified for that paper — the model is
// handed the fact channel's exact formatted strings (fmtNum output) and told to copy them
// verbatim, and a deterministic guard (sanitizeRanking, below) re-checks every numeric
// token in the returned prose against the verified set. A finding carrying any unbacked
// digit is dropped to its number-free form before it can render, so the readable summary
// can never state a number the verifier didn't prove. `relevance` stays number-free —
// it is about fit to the clinician's projects, and the same guard strips any digit the
// model sneaks in.

import { extractStructured, MODELS } from '../lib/anthropic.js'
import { normalize, extractNumbers, extractNumbersWithIndex, numbersEqual } from './verify.js'
import { checkFindings, SNIPPET_CHARS } from './check.js'
import { repairNumberFree } from './numberFree.js'
import { tagResult, describeTags, primaryScopeVerdict, headlinesNonPrimary, PRIMARY_UNKNOWN_REASON } from './primaryResult.js'
import { journalPreferenceText } from './journals.js'

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
        required: ['id', 'score', 'tier', 'finding', 'finding_plain', 'design_caution', 'relevance'],
        properties: {
          id: { type: 'string' },
          score: { type: 'integer' }, // 0–100 fit to north stars/projects; ranking only
          tier: { type: 'integer' }, // evidence tier: 1 = strongest, 3 = weakest
          finding: { type: 'string' }, // may carry VERIFIED numbers; guard-checked
          finding_plain: { type: 'string' }, // digit-free restatement; the guard's fallback
          design_caution: { type: 'string' }, // digit-free methodological limit; separately audited
          relevance: { type: 'string' },
        },
      },
    },
  },
}

// The app's integrity contract — output shape + the verified-numbers-only rule. This is
// NOT user-editable; it guarantees the digest prose never carries an unverified number.
// The prompt is only the first line of defense: sanitizeRanking() re-checks every digit
// deterministically, so a contract violation is dropped, never rendered.
export const OUTPUT_CONTRACT = `You brief a busy clinician-researcher on today's new papers, in the style of a morning literature digest. For each paper you get its title, a snippet, the study design, and the results the app has INDEPENDENTLY VERIFIED against the source. Return per paper:

- score: integer 0–100 — editorial importance and fit to the clinician's rubric, north stars, and active projects (100 = directly, importantly advances one; 0 = irrelevant). This decides admission and ordering; it is NOT an evidence-strength score. Apply the rubric above as the deciding voice.
- tier: integer 1–3 evidence strength. 1 = strongest (well-powered RCT, meta-analysis of RCTs, or a rigorous practice-relevant study); 2 = solid observational / cohort / smaller trial; 3 = limited (case series, single-arm, preliminary). Judge from study design, apparent sample size, and rigor.
- finding: ONE plain sentence — what the study SHOWED, the takeaway a clinician would repeat to a colleague, stated directionally (improved / reduced / no significant difference / non-inferior / increased risk). Weave in the key result so the proof is in the claim (e.g. "reduced mortality by 8% versus placebo", "HR 0.84 for amputation-free survival") — but ONLY numbers copied VERBATIM from that paper's "Verified results" list, formatted exactly as given there. Never rescale, round, convert, subtract, or derive a new number from a verified one, and never take a number from the snippet, the title, or another paper. When no verified value fits the sentence — or the paper has none (e.g. a narrative review or methods piece) — write the finding entirely number-free and summarize its conclusion from the snippet. Never invent a specific result. EVERY paper gets a finding.
- finding_plain: the SAME takeaway restated with NO digits at all — convey magnitude in words ("significantly improved", "roughly halved the risk", "no meaningful difference"). The app renders this instead of finding if any number in finding fails its verification guard, so it must stand alone. If finding is already number-free, repeat it here. If finding_plain contains any digit the app withholds the finding entirely rather than render it, so never put a number, timepoint, or count in it.

COMPOSITE ENDPOINT FIDELITY — apply to finding, finding_plain, and design_caution: when a primary endpoint is a composite (e.g. several events combined) and the snippet does not state its definition, refer to "the reported primary composite endpoint" and do NOT invent, expand, or narrow its components or its time window. Do not treat any stroke as ipsilateral stroke, early-only (e.g. periprocedural) death as death over all follow-up, or any component as the whole composite. Name a component or timepoint only when the snippet states it for that endpoint. Passing the number guard does not establish that the sentence means what the source means; the claim as rendered must match the source's endpoint definition and time window.
- design_caution: ONE plain, number-free sentence naming a material design limitation that constrains how strongly the finding can be used. Ground it in the supplied design and snippet; never invent a limitation the methods do not support. For observational comparisons, distinguish association from causation and identify consequential selection/conditioning, matching, surrogate exposure identification, single-center scope, or endpoint limitations when the snippet states them. An observational study advocating adoption or "standard of care" MUST say that its design cannot by itself establish a causal or universal standard. Use an empty string only when there is no material design caution supported by the supplied evidence.
- relevance: ONE short clause on why it matters to THIS clinician — name the specific north star or project it touches (e.g. "adjacent to your CLTI perfusion work" or "validates your hospital-free-days endpoint"). When search-topic steering is supplied, prefer the north star explicitly mapped to the topic that found the paper. Never invent a mapping for a topic marked unmapped.

SEPARATE EDITORIAL IMPORTANCE FROM EVIDENCE STRENGTH:
- Put methodological strength in tier and methodological limitations in design_caution. Do not automatically subtract from score because a study is small, single-center, observational, or lacks external validation.
- Judge what evidence is realistically attainable for the question. An indication-defining study, field-leading prospective series, or rare long-term follow-up may deserve a high score while also receiving a weaker tier and a clear design caution.
- Conversely, randomized, multicenter, large, externally validated, or systematic-review labels do not by themselves make a paper important to this clinician. Never use a design label as a substitute for importance.
- The clinician's explicit rubric still controls. If it specifically prioritizes or excludes a design for editorial reasons, honor that instruction; otherwise keep score separate from rigor.

CLAIM-STRENGTH RULES — apply these to BOTH finding and finding_plain:
- A numerical difference with a non-significant P value, or a confidence interval containing the measure's null, is NOT evidence that one arm is better. You may state the numerical direction cautiously, but must say the evidence was inconclusive or that there was no statistically clear difference. Never call it "clearly better", "superior", "improved", "reduced", "proved", or "demonstrated" without statistical support.
- Statistical significance alone does not establish clinical importance, causality, or practice-changing benefit. Match the strength of the source and study design; observational associations are not causal effects.
- A non-significant result does not prove equivalence or "no effect". Say "no statistically clear difference" unless the study actually tested and established equivalence or non-inferiority.
- When a reported effect estimate, confidence interval, P value, and source conclusion appear to conflict, preserve the uncertainty rather than choosing the strongest interpretation.

PRIMARY RESULT AND ANALYSIS RULES — apply to finding and finding_plain:
- Lead with the study's PRIMARY result (the paper's "Primary result" line). Never present a secondary, subgroup, per-protocol, or as-treated result as the main result, and never present a per-protocol or as-treated analysis as the randomized comparison. When the primary result was null, say so first; other results may follow, named for what they are.
- When the primary result is marked NOT verified, describe it in words from the snippet and never copy numbers for it from anywhere.
- Keep the tags shown in square brackets: the analysis population (intention-to-treat, per-protocol, as-treated), noninferiority versus superiority, the endpoint, and the timepoint. A noninferiority result is not superiority; a result at one timepoint or for one endpoint is not another.
- A verified value already carries its estimate label (e.g. "0.84 hazard ratio (CI …)"); do not add a second label in front of it ("HR 0.84 hazard ratio").

HARD RULE: finding may contain ONLY numbers that appear verbatim in that paper's Verified results, plus a result's printed timepoint (shown as "timepoint as printed") written as a timepoint — "at 12 months", "12-month patency" — the app deterministically checks every digit and discards the sentence if one is unbacked, so an unlisted number means your finding is thrown away. finding_plain, design_caution, and relevance may not contain ANY number, effect size, hazard/risk ratio, confidence interval, p-value, percentage, or sample size — no digits, ever.`

// --- The number guard --------------------------------------------------------
//
// Deterministic, pure, and applied to EVERY ranking before triage() returns — the same
// philosophy as verify.js: the model proposes prose, this layer disposes. The prompt's
// HARD RULE is only persuasion; this is the guarantee. The bias mirrors the verifier's:
// a grounded number that gets dropped is annoying; an unverified number that renders is
// fatal. So any doubt resolves to the number-free form.

// Every number a finding is allowed to carry: the numeric tokens of the paper's verified
// value strings (fmtNum output — the exact strings the fact channel renders). Tokenized
// with the verifier's own normalize/extractNumbers so "0·84", "8 %", and CI en-dashes
// read identically here and there.
export function allowedNumbers(verified) {
  const out = []
  for (const v of verified || []) {
    const value = normalize(String(v?.value ?? '')).replace(CI_LEVEL_RE, ' ')
    for (const n of extractNumbers(value)) out.push(n)
  }
  return out
}

// An interval's printed level ("99% CI", "95% credible interval") is a label fmtNum renders
// beside a verified interval, not a verified value: it never joins the allowed set, and a
// finding may carry it only directly in front of the same label, when one of the paper's
// verified value strings prints that level (2026-10-11 fix 4).
const CI_LEVEL_RE = /(?<![\d.])(\d{2}(?:\.\d+)?)\s*%\s*(?=(?:CI|credible interval)\b)/gi
const CI_LEVEL_AHEAD = /^\s*%\s*(?:CI|credible interval)\b/i
export function allowedCiLevels(verified) {
  const out = []
  for (const v of verified || []) {
    for (const m of normalize(String(v?.value ?? '')).matchAll(CI_LEVEL_RE)) out.push(Number(m[1]))
  }
  return out
}

// Timepoints (2026-10-04). A result's value strings never carry its timepoint — "67.3%
// versus 50%" — so "no clear benefit at 12 months" lost its 12 even when the 12-month
// result itself verified. A finding may also carry a number used AS A TIMEPOINT (number
// then a time unit: "at 12 months", "12-month") when that same number-and-unit is printed
// in the quote of one of the paper's VERIFIED rows. Narrow on both sides: the token must
// sit before a time unit in the finding, and the quote must print it before a time unit,
// so a timepoint can never launder a statistic and a statistic never launders a timepoint.
// Whether it is the RIGHT timepoint for the claim is a prose judgment — the check pass
// (pipeline/check.js) covers it, not this guard.
const TIME_UNIT = '(?:hours?|days?|weeks?|months?|years?)\\b'
const QUOTE_TIMEPOINT = new RegExp(`(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*-?\\s*${TIME_UNIT}`, 'g')
const FOLLOWED_BY_UNIT = new RegExp(`^\\s*-?\\s*${TIME_UNIT}`)

export function allowedTimepoints(verified) {
  const out = []
  for (const v of verified || []) {
    for (const m of normalize(String(v?.quote ?? '')).matchAll(QUOTE_TIMEPOINT)) out.push(Number(m[1]))
  }
  return out
}

// Nomenclature exemption, shared by the check and the strip so the two layers can never
// disagree: a numeric token whose character DIRECTLY before it is a letter is part of a
// name (TcPO2, CD34, P2Y12, COVID-19, SF-36 — the token there starts at the dash), not a
// statistic. A statistic in prose is always delimited from letters by a space, comparator,
// or punctuation ("8%", "HR 0.84", "n=84"), so nothing delimited ever slips this gate —
// "type 2 diabetes", "30-day", and "8-fold" all stay gated (conservatively: they fall
// back unless verified).
const isLetter = (ch) => ch != null && /[a-z]/i.test(ch)

// True when EVERY gated numeric token in `text` equals some allowed number (verifier
// representation-equality: 8 == 8.0, 0.84 == .84 — never rounding). Boundary-safe by
// construction: extractNumbersWithIndex tokenizes "2008" as 2008, so a verified 8 can
// never launder a year, and 0.84 never satisfies 0.8.
export function numbersGrounded(text, allowed, timepoints = [], ciLevels = []) {
  const norm = normalize(text || '')
  return extractNumbersWithIndex(norm).every(
    (t) =>
      isLetter(norm[t.start - 1]) ||
      allowed.some((a) => numbersEqual(a, t.value)) ||
      (FOLLOWED_BY_UNIT.test(norm.slice(t.end)) && timepoints.some((a) => numbersEqual(a, t.value))) ||
      (CI_LEVEL_AHEAD.test(norm.slice(t.end)) && ciLevels.some((a) => numbersEqual(a, t.value)))
  )
}

// Last-resort number-free form: delete gated numeric tokens (with any glued comparator,
// sign, percent, or joining dash) and tidy the seams. Only reached when the model violated
// the contract in BOTH finding and finding_plain — the output may read slightly clipped,
// but it cannot carry a gated digit, which is the invariant that matters. The lookbehinds
// mirror the nomenclature exemption above: no letter directly before the number, and no
// letter-dash directly before it (SF-36 / COVID-19 stay whole), so everything this
// preserves is exactly what numbersGrounded exempts.
const STRIP_RE = /[<>≤≥=~≈]?(?<![a-z0-9.])(?<![a-z][-‐–—−])[-−]?(?:\d+(?:[.,·]\d+)*|\.\d+)%?[-‐–—−]?/gi

export function stripNumbers(text) {
  return String(text || '')
    .replace(STRIP_RE, ' ')
    .replace(/\(\s*\)/g, ' ') // "(CI )" survives; "( )" does not
    .replace(/\s+([,.;:)\]])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// A verified value string already carries its estimate label ("0.84 hazard ratio (CI …)");
// writers prefixed their own ("HR 0.84 hazard ratio") — six of 67 dev-set findings. Drop the
// trailing duplicate when it names the same estimate as the label in front. Text-only: no
// number is added, removed, or changed.
const ESTIMATE_LABELS = [
  ['hr', 'hazard ratio'],
  ['or', 'odds ratio'],
  ['rr', 'risk ratio', 'relative risk'],
  ['irr', 'rate ratio', 'incidence rate ratio'],
  ['win ratio'],
]
const LABEL_ALT = ESTIMATE_LABELS.flat().sort((a, b) => b.length - a.length).map((l) => l.replace(/ /g, '\\s+')).join('|')
const DOUBLED_LABEL = new RegExp(
  `\\b(${LABEL_ALT})(\\s*(?:of|was|=|,|:)?\\s*)([-−]?\\d+(?:[.·]\\d+)?)\\s+(${LABEL_ALT})\\b`,
  'gi'
)
const labelGroup = (l) => ESTIMATE_LABELS.findIndex((g) => g.includes(l.toLowerCase().replace(/\s+/g, ' ')))
export function dedupeEstimateLabels(text) {
  return String(text ?? '').replace(DOUBLED_LABEL, (m, a, sep, num, b) =>
    labelGroup(a) >= 0 && labelGroup(a) === labelGroup(b) ? `${a}${sep}${num}` : m
  )
}

// Number-free form of a sentence (pipeline/numberFree.js): whole number phrases and
// clauses go, never just the digits (2026-10-11 fix 3: "cut day operative mortality").
// '' when the sentence cannot be repaired cleanly — callers fall back.
const numberFree = (t) => {
  const s = String(t ?? '').trim()
  return numbersGrounded(s, []) ? s : repairNumberFree(s)
}

// The guard proper. Given one raw ranking and that paper's verified values, return the
// ranking that is allowed to render: finding falls back to a valid finding_plain or is withheld
// the moment it carries an unbacked number; finding_plain, design_caution,
// and relevance are number-free by contract, so any digit in them is stripped outright.
// Pure — unit-tested without a model call.
export function sanitizeRanking(rk, verified, { primary = null } = {}) {
  const allowed = allowedNumbers(verified)
  const timepoints = allowedTimepoints(verified)
  // Fail closed: the fallback is used only when it is nonempty and already number-free
  // under the nomenclature rules. Never hard-strip it (stripping leaves malformed prose
  // like "the year rate of stroke"); otherwise withhold the finding as empty.
  const cleanFallback = (t) => {
    const s = String(t ?? '').trim()
    return s && numbersGrounded(s, []) ? s : ''
  }
  const finding = dedupeEstimateLabels(String(rk?.finding ?? '').trim())
  const ciLevels = allowedCiLevels(verified)
  const grounded = numbersGrounded(finding, allowed, timepoints, ciLevels) &&
    !headlinesNonPrimary({ finding, verified, primary })
  return {
    id: rk?.id,
    score: rk?.score,
    tier: rk?.tier,
    finding: grounded ? finding : cleanFallback(rk?.finding_plain),
    designCaution: numberFree(rk?.design_caution),
    relevance: numberFree(rk?.relevance),
  }
}

// Output budget for one ranking call. Every paper gets four prose fields plus JSON
// framing (~500 tokens in practice); a fixed 8192 could truncate a combined re-rank of
// fifteen or more papers, which failed the whole call and left papers unsummarized.
export function triageMaxTokens(count) {
  const n = Math.max(0, Number(count) || 0)
  return Math.min(32000, Math.max(8192, 1024 + n * 700))
}

// The clinician's own rubric leads; the fixed output contract follows. Editing the rubric
// (in the steering profile) changes how papers score and rank.
function buildSystem(rubric) {
  const criteria = (rubric || '').trim()
  const header = criteria
    ? `The clinician's digest rubric — their editorial priorities, in their words. Treat it as the deciding voice on what ranks high and what to downrank:\n\n${criteria}\n\n---\n\n`
    : ''
  return header + OUTPUT_CONTRACT
}

// Primary state for a candidate. findPrimary() never returns null; an explicit null from a
// caller is treated as UNKNOWN (withheld), never as "fine". Only a candidate that omits the
// key entirely (callers predating the primary contract, and unit tests of other behaviour)
// keeps the old behaviour; every production call site passes findPrimary(...).
function primaryState(c) {
  if (!c || !('primary' in c)) return 'not-supplied'
  return c.primary?.state || 'unknown'
}

// candidates: [{ id, title, summary, design, verified: [{name, value, quote}], primary? }] —
// `primary` is primaryResult.findPrimary(rows, <the caller's verified predicate>). `value` is the
// fmtNum-formatted string (callers format via lib/format.js), so the prompt shows the model
// the exact rendering the fact channel uses and an inline number can never disagree with it.
// Returns [{ id, score, tier, finding, relevance, check }], every ranking already
// through the number guard, with `check` from the adversarial prose gate
// ({ verdict: 'supported'|'refuted'|'unchecked', reason }). Two structured calls on
// cheap models (rank+write, then audit).
export async function triage({
  northStars = [],
  projects = [],
  journalPreferences,
  rubric = '',
  candidates,
  model = MODELS.triage,
  maxTokens,
}) {
  // Nothing new to rank: do not send a model call. An empty finish, an empty rank phase,
  // and a caller that already filtered the list all land here.
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  if (candidates.length > PILOT_DIGEST_LIMIT) throw new Error('Pilot digests are limited to 20 papers; no ranking request was sent.')
  const stars = northStars.length ? northStars.join(', ') : '(none set)'
  const projs = projects.length ? projects.join(', ') : '(none set)'
  const content =
    `North stars: ${stars}\nActive projects: ${projs}\n` +
    `Journal preferences (structured signal; they do not override hard exclusions):\n${journalPreferenceText(journalPreferences)}\n\nCandidates:\n\n` +
    candidates
      .map((c) => {
        const facts = (c.verified || []).length
          ? c.verified.map((v) => {
              const tps = [...new Set(allowedTimepoints([v]))]
              const tags = describeTags(tagResult({ name: v.name, source_quote: v.quote }), {
                isPrimary: Boolean(c.primary?.verified && c.primary.name === v.name),
              })
              return `  - ${v.name}: ${v.value}${tps.length ? ` (timepoint as printed: ${tps.join(', ')})` : ''}${tags ? ` ${tags}` : ''}`
            }).join('\n')
          : '  (no verified values)'
        const primaryLine = c.primary?.state === 'identified'
          ? `Primary result: ${c.primary.name}${c.primary.verified ? ' (verified; listed below)' : ' (NOT verified by the app — describe it in words from the snippet, never copy numbers for it)'}\n`
          : primaryState(c) === 'unspecified'
            ? 'Primary result: this paper does not name one. Summarize only the verified results below, and do not call any of them the primary result.\n'
            : primaryState(c) === 'unknown'
              ? 'Primary result: NOT identified by the app among the extracted results — do not present any listed result as the main result.\n'
              : ''
        const steering = (Array.isArray(c.topicSteering) ? c.topicSteering : [])
          .map((row) => `${row.topic || 'Unnamed topic'} → ${(row.northStars || []).length ? row.northStars.join(', ') : '(unmapped)'}`)
          .join('; ')
        return `[${c.id}] ${c.title}\nDesign: ${c.design || 'unknown'}\nSearch steering: ${steering || '(not available)'}\n${(c.summary || '').slice(0, SNIPPET_CHARS)}\n${primaryLine}Verified results:\n${facts}`
      })
      .join('\n\n')

  const result = await extractStructured({
    model,
    system: buildSystem(rubric),
    content,
    schema: TRIAGE_SCHEMA,
    maxTokens: maxTokens ?? triageMaxTokens(candidates.length),
    thinking: { type: 'disabled' }, // ranking/summary is not a reasoning task; keep output for JSON
  })
  // The guard, unconditionally — every ranking is sanitized against ITS paper's verified
  // set before any caller can render it. An id the model invented gets an empty verified
  // set, so any number it carries is dropped too.
  const verifiedById = new Map(candidates.map((c) => [String(c.id), c.verified || []]))
  const primaryById = new Map(candidates.map((c) => [String(c.id), c.primary || null]))
  const unknownPrimary = new Set(candidates.filter((c) => primaryState(c) === 'unknown').map((c) => String(c.id)))
  const sanitized = (result.rankings ?? []).map((rk) =>
    sanitizeRanking(rk, verifiedById.get(String(rk?.id)) || [], { primary: primaryById.get(String(rk?.id)) })
  )

  // Deterministic scope check before the model audit: a finding whose numbers come only
  // from per-protocol / as-treated analyses is refuted outright (primaryResult.js) and is
  // not sent to the checker.
  const scope = new Map()
  for (const rk of sanitized) {
    const verdict = primaryScopeVerdict({
      finding: rk.finding,
      verified: verifiedById.get(String(rk.id)) || [],
      primary: primaryById.get(String(rk.id)),
    })
    if (verdict) scope.set(String(rk.id), { verdict: verdict.verdict, reason: verdict.reason })
    // REV2 gap 1: results were extracted but none is the primary → the main finding is
    // withheld outright, whatever the model checker would have said.
    if (unknownPrimary.has(String(rk.id))) {
      const primary = primaryById.get(String(rk.id))
      scope.set(String(rk.id), {
        verdict: 'refuted',
        reason: primary?.reason || PRIMARY_UNKNOWN_REASON,
        withheld: 'primary-unknown',
      })
    }
  }

  // The prose gate (pipeline/check.js) — an adversarial second model audits each
  // AS-RENDERED finding and design caution (post-number-guard) against the same snippet
  // the writer saw. Advisory and non-blocking: any failure here degrades to 'unchecked'.
  // The UI withholds refuted findings and cautions.
  const summaryById = new Map(candidates.map((c) => [String(c.id), c.summary || '']))
  let checks = new Map()
  let failure = ''
  try {
    checks = await checkFindings({
      items: sanitized.flatMap((rk) => {
        const snippet = summaryById.get(String(rk.id)) || ''
        const primary = primaryById.get(String(rk.id))
        const context = primary?.name
          ? `The study's primary result is "${primary.name}"${primary.verified ? '' : ' (its numbers were not verified by the app)'}.`
          : ''
        return [
          ...(scope.has(String(rk.id)) ? [] : [{ id: rk.id, finding: rk.finding, snippet, context }]),
          { id: `design-caution:${rk.id}`, claimType: 'design-caution', finding: rk.designCaution, snippet },
        ]
      }),
    })
  } catch (err) {
    failure = String(err?.message || 'unknown error').slice(0, 160)
    console.warn('Prose check failed (findings render unchecked):', failure)
  }
  const fallback = failure
    ? { verdict: 'unchecked', reason: `Not checked: the source check failed (${failure}).` }
    : { verdict: 'unchecked', reason: '' }
  return sanitized.map((rk) => ({
    ...rk,
    check: scope.get(String(rk.id)) || checks.get(String(rk.id)) || fallback,
    cautionCheck: checks.get(`design-caution:${rk.id}`) || fallback,
  }))
}
