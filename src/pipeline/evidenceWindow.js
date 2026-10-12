// pipeline/evidenceWindow.js — the ONE evidence window the prose channel reads.
//
// The triage writer and the prose checker (check.js) both judge a paper from a bounded
// snippet. That snippet used to be the first SNIPPET_CHARS of `sourceDoc.text`: fine for a
// PubMed abstract, wrong for PMC full text, whose `text` is the flattened <body> — so the
// window was usually the Introduction, numbers from other people's papers included. This
// module picks the window from the paper's own structure instead, once, when the paper is
// read, and every ranking caller (browser digest, scheduled digest, Add a paper, Library
// refresh) passes exactly that text to triage, which hands the same text to the checker.
//
// Contract:
//   - Budget is SNIPPET_CHARS, unchanged. The window never grows to "find" a result.
//   - Full text: the body's Results section(s), with a little design/population context
//     (abstract Methods, else the body Methods opening). Never the body prefix.
//   - Results not identifiable, or too long without a primary-outcome subsection:
//     the structured abstract Results when available, labelled as the abstract.
//   - Abstract (structured): Results first in priority, Methods context, then Conclusions;
//     rendered in the abstract's own order with its own labels. Unstructured: the abstract.
//   - Nothing identifiable: an explicit limited window — "opening of supplied text,
//     sections not identified" for an uploaded PDF, and NO text for full-text body that
//     has no recognizable structure (its opening is the Introduction).
//   - The window is ranking/prose input ONLY. sourceDoc.text/tables — the verifier's
//     corpus and the extraction input (and so the extraction cache key) — are untouched.

// Keep the reviewed section-selection budget independent of the checker maximum.
export const SECTION_WINDOW_CHARS = 2600
const SNIPPET_CHARS = SECTION_WINDOW_CHARS

// Stamped on every stored window. Bump when selection changes what a stored window would
// contain; a reader seeing an unknown or missing version rebuilds it (evidenceWindowFor).
export const EVIDENCE_WINDOW_VERSION = '2026-10-12.window-v4'

// Design/population context is capped so Results keep most of the budget.
const CONTEXT_CHARS = 600

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

// Section kind from a label (and a JATS sec-type when present). Results must START the
// label ("Results", "3. Results", "Main findings", "Results and discussion") so a
// Discussion subsection like "Comparison with previous results" is never taken for them.
export function sectionKind(label, secType = '') {
  const type = clean(secType).toLowerCase()
  if (type) {
    if (/^results?(?:\||$)/.test(type)) return 'results'
    if (/method|subjects|cases|patients/.test(type)) return 'methods'
    if (/intro|background/.test(type)) return 'background'
    if (/discussion/.test(type)) return 'discussion'
    if (/conclusion/.test(type)) return 'conclusions'
  }
  const l = clean(label).toLowerCase().replace(/^(?:[ivx]+|\d+(?:\.\d+)*)[.)]?\s+/, '').replace(/[:.]+$/, '')
  if (!l) return 'other'
  if (/^(?:main |key |principal |primary )?(?:results?|findings)\b/.test(l)) return 'results'
  if (/^(?:conclusions?|interpretation|relevance|implications)\b|^conclusions? and relevance/.test(l)) return 'conclusions'
  if (/^(?:introduction|background|context|rationale)\b/.test(l)) return 'background'
  if (/^(?:objectives?|aims?|purpose|importance|question)\b/.test(l)) return 'objective'
  if (/^(?:discussion|limitations?|comment|strengths)\b/.test(l)) return 'discussion'
  if (/method|design|setting|participants|patients|population|materials|subjects|interventions?|exposures?|outcomes? and measures|main outcome|data sources?|study selection|eligibility|data extraction/.test(l)) return 'methods'
  return 'other'
}

// A labelled paragraph in a PubMed plain-text abstract: "RESULTS: ...". The label must be
// one sectionKind recognizes, so an ordinary sentence with a colon is never split.
const LABELLED = /^([A-Za-z][A-Za-z ,&/-]{1,60}?):\s+([\s\S]+)$/

// Cleaned PubMed text (sources.js cleanAbstractText) -> [{ label, kind, text }]. The first
// unlabelled block of a structured record is its title and is dropped (triage shows the
// title separately). Unstructured: one part with the abstract body.
export function parseAbstractText(text) {
  // Preserve wrapped prose, but start recognized labelled sections even when PubMed
  // separates them with only one newline. Do this before whitespace normalization.
  const separated = String(text ?? '').replace(/\r\n?/g, '\n').replace(
    /\n[ \t]*([A-Za-z][A-Za-z ,&/-]{1,60}?):(?=\s)/g,
    (match, label) => sectionKind(label) !== 'other' ? `\n\n${label}:` : match,
  )
  const blocks = separated.split(/\n\s*\n/).map(clean).filter(Boolean)
  const parts = blocks.map((block) => {
    const m = block.match(LABELLED)
    const kind = m ? sectionKind(m[1]) : 'other'
    return m && kind !== 'other' ? { label: m[1].trim(), kind, text: clean(m[2]) } : { label: '', kind: 'other', text: block }
  })
  const structured = parts.some((p) => p.label)
  if (structured) return { structured, parts: parts.filter((p) => p.label || p !== parts[0]) }
  // Unstructured: drop a short leading title block when a longer body follows.
  const body = parts.length > 1 && parts[0].text.length < 300 ? parts.slice(1) : parts
  return { structured: false, parts: body.length ? [{ label: '', kind: 'abstract', text: body.map((p) => p.text).join(' ') }] : [] }
}

// Generic explicit definition of the primary endpoint/outcome in a Methods block. Matches
// sentence structure only ("primary end point/outcome ... was/were/defined/comprised/
// consisted/composite"), never study names, IDs, numbers, or topic keywords.
const ENDPOINT_SENTENCE = /\b(?:primary|main|principal)\s+(?:composite\s+)?(?:end\s?points?|outcomes?)\b/i
const ENDPOINT_DEFINES = /\b(?:was|were|is|are|defined|comprised|consisted|included|composite|composed|combined)\b/i

function splitSentences(text) {
  return String(text ?? '').match(/.+?(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) || []
}

// Methods text, tailored for a limited allocation: when the whole block would be cut and
// an explicit primary-endpoint definition sentence sits in the part that would be lost,
// keep the opening design/population sentences that fit and then that sentence, in the
// block's own order. Short blocks, and blocks without such a sentence, are unchanged.
export function compactMethods(text, max) {
  const t = clean(text)
  if (max <= 0 || t.length <= max) return t
  const sentences = splitSentences(t)
  const idx = sentences.findIndex((s) => ENDPOINT_SENTENCE.test(s) && ENDPOINT_DEFINES.test(s))
  if (idx < 0) return t
  let endpoint = sentences[idx]
  if (endpoint.length > max - 20) endpoint = truncate(endpoint, max - 20)
  const head = []
  let used = endpoint.length + 1
  for (let i = 0; i < idx; i++) {
    if (used + sentences[i].length + 1 > max) break
    head.push(sentences[i])
    used += sentences[i].length + 1
  }
  // Endpoint already inside what plain truncation would keep: nothing to rescue.
  if (head.length === idx) return t
  return [...head, ...(head.length < idx ? ['…'] : []), endpoint].join(' ')
}

function truncate(text, max) {
  if (max <= 0) return ''
  if (text.length <= max) return text
  const room = max - 2
  if (room <= 0) return ''
  const cut = text.slice(0, room)
  const end = cut.lastIndexOf('. ')
  return `${end >= room * 0.6 ? cut.slice(0, end + 1) : cut.trimEnd()} …`
}

const HEADERS = {
  results: '[Evidence window: Results section of the full text, with study design context]',
  abstract: '[Evidence window: the paper\'s abstract]',
  opening: '[Evidence window: opening of the supplied text. Sections were not identified; this is not necessarily the Results]',
}

// Allocation (Codex R2, 2026-10-09). When the window has Results, design context (Methods,
// Objective) shares ONE aggregate budget of CONTEXT_CHARS, however many labels a
// structured abstract splits it into; Results then take what is left — the primary-outcome
// subsection first; other context (Conclusions, Background, …) fills any room after that.
// Within a group the room is shared evenly, so several Methods labels or several Results
// sections each get a slice and none crowds the others out. Without Results, design
// context may use the whole budget. Everything is printed in the source's own order. A part
// that would be cut below 40 characters is left out rather than shown as a stub.
const DESIGN = new Set(['methods', 'objective'])
const PART_CAPS = { 'results-population': 500, 'results-other': 350, conclusions: 400, background: 300, discussion: 300, other: 300 }
const isResults = (kind) => String(kind).startsWith('results')

// Within a Results section that has titled subsections, the one reporting the primary
// outcome gets first claim on the budget: Results usually open with enrolment and flow,
// and a window filled from the top can stop before the primary result (CREST's Results
// open with ~2,200 characters of randomization and withdrawal counts). Population
// context follows, capped; other subsections get a short opening each.
const isPrimarySub = (title) => /primary|main (?:outcome|result|end ?point)/i.test(title) ||
  (/end ?points?\b|efficacy|outcomes?\b/i.test(title) && !/secondary|safety|adverse|other|additional|exploratory|post hoc/i.test(title))
const POPULATION_SUB = /population|patients|participants|enrol|enroll|baseline|characteristics|recruitment|flow/i
function resultsParts(sections, index) {
  const own = sections[index]
  const label = own.label || 'Results'
  const children = sections.filter((s) => s.parent === index && clean(s.text))
  const primary = children.filter((c) => isPrimarySub(c.label || ''))
  if (!primary.length) return [{ label, kind: 'results', from: 'body', text: clean(own.text) }]
  return children.map((c) => ({
    label: `${label} › ${c.label}`,
    kind: primary.includes(c) ? 'results-primary' : POPULATION_SUB.test(c.label || '') ? 'results-population' : 'results-other',
    from: 'body',
    text: clean(c.text),
  }))
}

function render(kind, parts, budget) {
  const header = HEADERS[kind]
  const prefix = (p) => (p.label ? `${p.label.toUpperCase()}${p.from === 'abstract' && kind === 'results' ? ' (abstract)' : ''}: ` : '')
  const indexed = parts.map((p, i) => ({ ...p, i }))
  const target = (p) => prefix(p).length + Math.min(p.text.length, PART_CAPS[p.kind] ?? Infinity)
  let left = budget - header.length
  const size = new Map()
  // Share min(pool, what is left) evenly across the group; each part takes at most its
  // target, and leftover from short parts flows to the longer ones.
  const fill = (group, pool) => {
    let room = Math.min(pool, left)
    let open = group.filter((p) => !size.has(p.i))
    while (open.length && room > 0) {
      const share = Math.floor(room / open.length)
      const fits = open.filter((p) => target(p) + 1 <= share)
      for (const p of fits.length ? fits : open) {
        let n = fits.length ? target(p) : share - 1
        if (n < target(p) && n < prefix(p).length + 40) n = 0
        size.set(p.i, n)
        if (n > 0) {
          room -= n + 1
          left -= n + 1
        }
      }
      if (!fits.length) break
      open = open.filter((p) => !size.has(p.i))
    }
  }
  const body = indexed.filter((p) => isResults(p.kind) || p.kind === 'abstract' || p.kind === 'opening')
  const design = indexed.filter((p) => DESIGN.has(p.kind))
  const rest = indexed.filter((p) => !body.includes(p) && !design.includes(p))
  if (body.length) {
    fill(design, CONTEXT_CHARS)
    fill(body.filter((p) => p.kind === 'results-primary'), Infinity)
    fill(body.filter((p) => p.kind !== 'results-primary'), Infinity)
  } else {
    fill(design, Infinity)
  }
  fill(rest, Infinity)
  const lines = indexed.filter((p) => size.get(p.i) > 0).map((p) => {
    const pre = prefix(p)
    const room = size.get(p.i) - pre.length
    const body = p.kind === 'methods' ? compactMethods(p.text, room) : p.text
    return { label: p.label, kind: p.kind, from: p.from, line: pre + truncate(body, room) }
  })
  const text = [header, ...lines.map((l) => l.line)].join('\n')
  return { text, parts: lines.map(({ label, kind, from, line }) => ({ label, kind, from, chars: line.length })) }
}

function windowResult(kind, fields, rendered) {
  return {
    version: EVIDENCE_WINDOW_VERSION,
    kind,
    limited: kind === 'opening' || kind === 'unavailable',
    hasResults: rendered ? rendered.parts.some((p) => isResults(p.kind)) : false,
    text: rendered ? rendered.text : '',
    parts: rendered ? rendered.parts : [],
    ...fields,
  }
}

function abstractWindow(abstract, budget, reason) {
  const { structured, parts } = abstract
  if (!parts.length) return null
  if (!structured) {
    return windowResult('abstract', { basis: 'abstract', structured: false, reason }, render('abstract', [{ label: '', kind: 'abstract', from: 'abstract', text: parts[0].text }], budget))
  }
  const kept = parts.map((p) => ({ ...p, from: 'abstract' }))
  const rendered = render('abstract', kept, budget)
  return windowResult('abstract', { basis: 'abstract', structured: true, reason: rendered.parts.some((p) => isResults(p.kind)) ? reason : `${reason} The abstract has no Results section.` }, rendered)
}

// source: { tier, text, abstractParts?: [{label, text}], sections?: [{label, kind, text}] }
//   tier          'full_text' | 'abstract_only' | 'user_text'
//   text          the verification prose (body for full text; cleaned abstract otherwise)
//   abstractParts the publisher abstract from PMC <front>, when the body was fetched
//   sections      PMC body sections, outermost Results first-class (sources.js pmcSections)
export function selectEvidenceWindow(source, { budget = SNIPPET_CHARS } = {}) {
  const tier = source?.tier || 'abstract_only'
  const fromParts = (parts) => {
    const list = (parts || []).map((p) => ({ label: clean(p.label), kind: p.kind || sectionKind(p.label), text: clean(p.text) })).filter((p) => p.text)
    return { structured: list.some((p) => p.label && p.kind !== 'other'), parts: list.some((p) => p.label && p.kind !== 'other') ? list : list.length ? [{ label: '', kind: 'abstract', text: list.map((p) => p.text).join(' ') }] : [] }
  }

  if (tier === 'full_text') {
    const abstract = fromParts(source?.abstractParts)
    const sections = Array.isArray(source?.sections) ? source.sections : null
    if (!sections) {
      return windowResult('unavailable', { basis: 'none', reason: 'Full-text section structure was not recorded with this paper. The body opens with the Introduction, so no window is used rather than an unlabelled body prefix.' })
    }
    const results = sections.filter((s) => s.kind === 'results' && clean(s.text))
    if (results.length) {
      const methodsAbstract = abstract.parts.filter((p) => p.kind === 'methods' || p.kind === 'objective')
      // Top-level only: a Results subsection titled "Study population" is not Methods.
      const methodsBody = sections.find((s) => s.kind === 'methods' && !(s.depth > 0) && clean(s.text))
      const context = methodsAbstract.length
        ? [{ label: methodsAbstract.map((p) => p.label).join(' / '), kind: 'methods', from: 'abstract', text: methodsAbstract.map((p) => p.text).join(' ') }]
        : methodsBody ? [{ label: methodsBody.label || 'Methods', kind: 'methods', from: 'body', text: clean(methodsBody.text) }] : []
      const resultParts = results.flatMap((s) => resultsParts(sections, sections.indexOf(s)))
      // A long, unsplit Results section may open with recruitment and procedure details.
      // Its prefix is not a reliable results summary. Prefer the paper's structured
      // abstract when no primary-outcome subsection can guide the bounded selection.
      const hasPrimary = resultParts.some((p) => p.kind === 'results-primary')
      const bodyWouldTruncate = resultParts.reduce((n, p) => n + p.text.length + p.label.length + 4, 0) >
        budget - HEADERS.results.length - (context.length ? CONTEXT_CHARS : 0)
      if (!hasPrimary && bodyWouldTruncate && abstract.parts.some((p) => p.kind === 'results' && p.text)) {
        return abstractWindow(abstract, budget, 'Long Results section has no identifiable primary-outcome subsection; the structured publisher abstract is used instead of a truncated body opening.')
      }
      return windowResult('results', { basis: 'full_text_sections', combinedWithDiscussion: results.some((s) => /discussion/i.test(s.label || '')), reason: 'Results section identified in the full text.' }, render('results', [...context, ...resultParts], budget))
    }
    const fallback = abstractWindow(abstract, budget, 'No Results section identified in the full text; the publisher abstract is used instead.')
    return fallback || windowResult('unavailable', { basis: 'none', reason: 'No Results section identified in the full text and no abstract available.' })
  }

  if (tier === 'user_text') {
    const text = clean(source?.text)
    if (!text) return windowResult('unavailable', { basis: 'none', reason: 'No supplied text.' })
    return windowResult('opening', { basis: 'supplied_text_opening', reason: 'Uploaded text has no recognized section structure; its opening is used and labelled as such.' }, render('opening', [{ label: '', kind: 'opening', from: 'supplied', text }], budget))
  }

  const abstract = source?.abstractParts ? fromParts(source.abstractParts) : parseAbstractText(source?.text)
  return abstractWindow(abstract, budget, 'Abstract-only source.') || windowResult('unavailable', { basis: 'none', reason: 'No abstract text available.' })
}

// The window for a paper result, stored or not. A result read by this version carries its
// own window (pipeline.js runPaper). An older result — a saved digest, a resumed scheduled
// run, a Library refresh of an old snapshot — is rebuilt deterministically from what it
// saved, with no fetch: an abstract-only row re-parses its saved abstract; a full-text row
// saved only its flattened body, so it gets the explicit 'unavailable' window rather than
// the body opening.
export function evidenceWindowFor(result) {
  const stored = result?.evidenceWindow
  if (stored?.version === EVIDENCE_WINDOW_VERSION && typeof stored.text === 'string') return stored
  const rebuilt = selectEvidenceWindow({ tier: result?.source?.tier || 'abstract_only', text: result?.sourceDoc?.text || '' })
  return { ...rebuilt, legacy: true }
}

// What triage receives as a candidate's `summary` — and therefore what check.js audits.
export function evidenceSummary(result) {
  return evidenceWindowFor(result).text
}
