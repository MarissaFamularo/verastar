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
        required: ['id', 'score', 'tier', 'finding', 'finding_plain', 'relevance'],
        properties: {
          id: { type: 'string' },
          score: { type: 'integer' }, // 0–100 fit to north stars/projects; ranking only
          tier: { type: 'integer' }, // evidence tier: 1 = strongest, 3 = weakest
          finding: { type: 'string' }, // may carry VERIFIED numbers; guard-checked
          finding_plain: { type: 'string' }, // digit-free restatement; the guard's fallback
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
const OUTPUT_CONTRACT = `You brief a busy clinician-researcher on today's new papers, in the style of a morning literature digest. For each paper you get its title, a snippet, the study design, and the results the app has INDEPENDENTLY VERIFIED against the source. Return per paper:

- score: integer 0–100 — fit to the clinician's rubric, north stars, and active projects (100 = directly, importantly advances one; 0 = irrelevant). Drives ordering. Apply the rubric above as the deciding voice.
- tier: integer 1–3 evidence strength. 1 = strongest (well-powered RCT, meta-analysis of RCTs, or a rigorous practice-relevant study); 2 = solid observational / cohort / smaller trial; 3 = limited (case series, single-arm, preliminary). Judge from study design, apparent sample size, and rigor.
- finding: ONE plain sentence — what the study SHOWED, the takeaway a clinician would repeat to a colleague, stated directionally (improved / reduced / no significant difference / non-inferior / increased risk). Weave in the key result so the proof is in the claim (e.g. "reduced mortality by 8% versus placebo", "HR 0.84 for amputation-free survival") — but ONLY numbers copied VERBATIM from that paper's "Verified results" list, formatted exactly as given there. Never rescale, round, convert, subtract, or derive a new number from a verified one, and never take a number from the snippet, the title, or another paper. When no verified value fits the sentence — or the paper has none (e.g. a narrative review or methods piece) — write the finding entirely number-free and summarize its conclusion from the snippet. Never invent a specific result. EVERY paper gets a finding.
- finding_plain: the SAME takeaway restated with NO digits at all — convey magnitude in words ("significantly improved", "roughly halved the risk", "no meaningful difference"). The app renders this instead of finding if any number in finding fails its verification guard, so it must stand alone. If finding is already number-free, repeat it here.
- relevance: ONE short clause on why it matters to THIS clinician — name the specific north star or project it touches (e.g. "adjacent to your CLTI perfusion work" or "validates your hospital-free-days endpoint").

HARD RULE: finding may contain ONLY numbers that appear verbatim in that paper's Verified results — the app deterministically checks every digit and discards the sentence if one is unbacked, so an unlisted number means your finding is thrown away. finding_plain and relevance may not contain ANY number, effect size, hazard/risk ratio, confidence interval, p-value, percentage, or sample size — no digits, ever.`

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
    for (const n of extractNumbers(normalize(String(v?.value ?? '')))) out.push(n)
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
export function numbersGrounded(text, allowed) {
  const norm = normalize(text || '')
  return extractNumbersWithIndex(norm).every(
    (t) => isLetter(norm[t.start - 1]) || allowed.some((a) => numbersEqual(a, t.value))
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

// The guard proper. Given one raw ranking and that paper's verified values, return the
// ranking that is allowed to render: finding falls back to finding_plain (then to a
// hard strip) the moment it carries an unbacked number; finding_plain and relevance are
// number-free by contract, so any digit in them is stripped outright. Pure — unit-tested
// without a model call.
export function sanitizeRanking(rk, verified) {
  const allowed = allowedNumbers(verified)
  // Digit-free by contract: pass through untouched when the guard sees no gated number
  // (empty allowed set = nothing is permitted), strip otherwise.
  const plain = (t) => {
    const s = String(t ?? '').trim()
    return numbersGrounded(s, []) ? s : stripNumbers(s)
  }
  const finding = String(rk?.finding ?? '').trim()
  return {
    id: rk?.id,
    score: rk?.score,
    tier: rk?.tier,
    finding: numbersGrounded(finding, allowed)
      ? finding
      : plain(rk?.finding_plain) || stripNumbers(finding),
    relevance: plain(rk?.relevance),
  }
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

// candidates: [{ id, title, summary, design, verified: [{name, value}] }] — `value` is the
// fmtNum-formatted string (callers format via lib/format.js), so the prompt shows the model
// the exact rendering the fact channel uses and an inline number can never disagree with it.
// Returns [{ id, score, tier, finding, relevance }], every ranking already through the
// number guard. One structured call on a cheap model.
export async function triage({
  northStars = [],
  projects = [],
  rubric = '',
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
    system: buildSystem(rubric),
    content,
    schema: TRIAGE_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' }, // ranking/summary is not a reasoning task; keep output for JSON
  })
  // The guard, unconditionally — every ranking is sanitized against ITS paper's verified
  // set before any caller can render it. An id the model invented gets an empty verified
  // set, so any number it carries is dropped too.
  const verifiedById = new Map(candidates.map((c) => [String(c.id), c.verified || []]))
  return (result.rankings ?? []).map((rk) =>
    sanitizeRanking(rk, verifiedById.get(String(rk?.id)) || [])
  )
}
