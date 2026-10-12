// pipeline/evidenceContext.js — WHICH source text the prose channel reads.
//
// The writer (triage) and the skeptic (check.js) used to read the first SNIPPET_CHARS of
// `sourceDoc.text`. For an abstract that is usually the whole abstract; for PMC full text it
// is the INTRODUCTION (a JATS <body> excludes the abstract), and for a long structured
// abstract it stops before the results. The writer then summarized a paper it had only seen
// the background of, and the skeptic — correctly — refuted correct summaries for lack of
// evidence (2026-10-11 development set: CAR-06, CAR-07, CAR-10, CAD-01, PAD-02, HF-14 on
// full text; HF-09, PAD-05, PAD-12, PAD-15 on long abstracts).
//
// selectEvidenceContext builds the window from the RESULTS instead: the abstract (the PMC
// <abstract> when the source is full text, else the abstract itself), then verbatim
// excerpts around every extracted result's source_quote, in extraction order (primary
// first), merged and kept in document order. Everything returned is verbatim source text —
// nothing is paraphrased, so the skeptic still judges claims only against the paper. The
// writer and the skeptic receive the SAME window (the invariant check.js depends on).
//
// Pure: no network, no model. The verifier never reads this — verification corpora are
// unchanged.

export const EVIDENCE_CHARS = 6000
const HEAD_CHARS = 1500 // opening of a long single-document source (title/abstract lead)
const WINDOW_PAD = 320 // characters of context on each side of a result quote
const GAP = '\n…\n'

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Locate a quote in the text, tolerant of whitespace differences (PDF/JATS line breaks).
// Returns { start, end } or null. Never fuzzy beyond whitespace: a quote the text does not
// contain contributes no window.
export function locateQuote(text, quote) {
  const q = String(quote || '').trim()
  if (!q || !text) return null
  const exact = text.indexOf(q)
  if (exact >= 0) return { start: exact, end: exact + q.length }
  const words = q.split(/\s+/).filter(Boolean)
  if (!words.length) return null
  try {
    const m = new RegExp(words.map(escapeRe).join('\\s+')).exec(text)
    return m ? { start: m.index, end: m.index + m[0].length } : null
  } catch {
    return null
  }
}

// Expand [start, end) to sentence boundaries within WINDOW_PAD on each side.
function sentenceWindow(text, start, end) {
  let s = Math.max(0, start - WINDOW_PAD)
  let e = Math.min(text.length, end + WINDOW_PAD)
  const before = text.slice(s, start)
  const boundary = /[.!?]\s+/g
  let last = -1
  for (let m = boundary.exec(before); m; m = boundary.exec(before)) last = m.index + m[0].length
  if (last >= 0) s += last
  const after = text.slice(end, e)
  const stop = after.search(/[.!?](\s|$)/)
  if (stop >= 0) e = end + stop + 1
  return { start: s, end: e }
}

// Marks where the leading text ends and the verbatim result passages begin, so the writer
// and the checker both know the excerpts are quoted source, out of their original order.
export const EXCERPT_LABEL = '\n\nRESULT EXCERPTS (verbatim from the source text):\n'

function mergeWindows(windows) {
  const sorted = [...windows].sort((a, b) => a.start - b.start)
  const out = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && w.start <= last.end + 1) last.end = Math.max(last.end, w.end)
    else out.push({ ...w })
  }
  return out
}

// { text, abstract, quotes, limit } -> string (<= limit chars).
//   text      the source the verifier read (abstract, PMC body, or user PDF text)
//   abstract  the PMC <abstract> when `text` is a full-text body ('' otherwise)
//   quotes    extracted source_quotes in extraction (importance) order
//
// REV2 (gap 3): a quote counts as "already included" only when it is inside the RETAINED
// head — the part of the abstract (or body opening) actually kept — never merely somewhere
// in the full abstract. A long abstract is cut to half the window; a primary result printed
// past that cut used to be skipped as "already in the abstract" AND be cut off with the
// tail, so it reached neither the writer nor the checker. Excerpts are now taken from the
// body when the quote is there, else from the dropped tail of the abstract.
export function selectEvidenceContext({ text = '', abstract = '', quotes = [], limit = EVIDENCE_CHARS } = {}) {
  const body = String(text || '')
  const abs = String(abstract || '').trim()
  // A short single document (an abstract-only source) is used whole — the old behavior,
  // minus the 2,600-character cut that dropped long abstracts' results.
  if (!abs && body.length <= limit) return body

  const head = abs ? abs.slice(0, Math.min(abs.length, Math.floor(limit * 0.5))) : body.slice(0, HEAD_CHARS)
  let budget = limit - head.length - EXCERPT_LABEL.length

  // Excerpt sources, searched in order. The body's opening is already in the head when
  // there is no abstract; the abstract's retained part is the head when there is one.
  const sources = abs
    ? [{ id: 'body', doc: body, from: 0 }, { id: 'abstract', doc: abs, from: head.length }]
    : [{ id: 'body', doc: body, from: head.length }]

  // Windows in extraction order so the primary result is kept first when the budget is tight.
  const chosen = { body: [], abstract: [] }
  const used = () => Object.values(chosen).flat().reduce((n, x) => n + (x.end - x.start) + GAP.length, 0)
  for (const quote of quotes || []) {
    if (budget <= 0) break
    if (locateQuote(head, quote)) continue // genuinely in the retained text
    for (const src of sources) {
      const hit = locateQuote(src.doc, quote)
      if (!hit || hit.end <= src.from) continue
      // A quote straddling the retained cut keeps only its not-yet-included part.
      const start = Math.max(hit.start, src.from)
      const end = hit.end
      const before = used()
      const w = sentenceWindow(src.doc, start, end)
      w.start = Math.max(w.start, src.from)
      const merged = mergeWindows([...chosen[src.id], w])
      const cost = merged.reduce((n, x) => n + (x.end - x.start) + GAP.length, 0) -
        chosen[src.id].reduce((n, x) => n + (x.end - x.start) + GAP.length, 0)
      if (cost <= budget) {
        chosen[src.id] = merged
      } else {
        // Keep at least the quote itself when the padded window does not fit.
        const tightCost = end - start + GAP.length
        if (tightCost > budget) break
        chosen[src.id] = mergeWindows([...chosen[src.id], { start, end }])
      }
      budget -= used() - before
      break
    }
  }
  const excerpts = [
    ...chosen.body.map((w) => body.slice(w.start, w.end).trim()),
    ...chosen.abstract.map((w) => abs.slice(w.start, w.end).trim()),
  ]
  if (!excerpts.length) return head
  return (head + EXCERPT_LABEL + excerpts.join(GAP)).slice(0, limit)
}

// The evidence window for one runPaper() result — what every triage call site passes as
// `summary`. Quotes come from ALL extracted rows (verified or not): they are verbatim source
// passages, and the skeptic needs the primary result's text even when the deterministic
// verifier could not prove its numbers.
export function evidenceForResult(res, limit = EVIDENCE_CHARS) {
  return selectEvidenceContext({
    text: res?.sourceDoc?.text || '',
    abstract: res?.sourceDoc?.abstract || '',
    quotes: (res?.rows || []).map((row) => row?.quantity?.source_quote).filter(Boolean),
    limit,
  })
}
