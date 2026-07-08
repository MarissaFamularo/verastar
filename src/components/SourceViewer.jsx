// components/SourceViewer.jsx — the click-to-source money shot.
//
// Given a located quote, show the ACTUAL source text (the same prose/table text the
// verifier matched against) with the exact sentence highlighted and scrolled into view.
// The quote is verbatim from what we fetched, so a whitespace-tolerant search of the
// original corpus finds it directly — no offset math, no reconstruction.

import { useEffect, useMemo, useRef } from 'react'

// Locate the quote span [start, end) in the original corpus. Exact first, then a
// whitespace-tolerant regex (handles line reflow / collapsed spacing). null if unfound.
export function findQuoteSpan(corpus, quote) {
  const q = (quote || '').trim()
  if (!q || !corpus) return null

  const exact = corpus.indexOf(q)
  if (exact !== -1) return [exact, exact + q.length]

  // Escape regex metachars, then let any whitespace run match any whitespace run.
  const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  try {
    const m = new RegExp(pattern).exec(corpus)
    if (m) return [m.index, m.index + m[0].length]
  } catch {
    /* pathological quote — fall through to no-highlight */
  }
  return null
}

export default function SourceViewer({ open, onClose, title, corpusLabel, corpusText, quote, valueLabel }) {
  const markRef = useRef(null)

  const parts = useMemo(() => {
    const span = findQuoteSpan(corpusText, quote)
    if (!span) return { before: corpusText || '', match: '', after: '', found: false }
    const [start, end] = span
    return {
      before: corpusText.slice(0, start),
      match: corpusText.slice(start, end),
      after: corpusText.slice(end),
      found: true,
    }
  }, [corpusText, quote])

  useEffect(() => {
    if (open && markRef.current) {
      markRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [open, quote])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* backdrop */}
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />

      {/* slide-over panel */}
      <div className="relative flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl dark:bg-slate-900">
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Source · {corpusLabel === 'tables' ? 'table' : 'full text'}
            </p>
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {valueLabel && (
              <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
                Proving: <span className="tabular-nums font-medium">{valueLabel}</span>
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {!parts.found && (
            <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              Couldn't align the highlight, but the quote was verified against this text.
            </p>
          )}
          <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700 dark:text-slate-300">
            {parts.before}
            {parts.match && (
              <mark
                ref={markRef}
                className="rounded bg-amber-200 px-0.5 py-0.5 text-slate-900 ring-2 ring-amber-400 dark:bg-amber-400/80 dark:text-slate-900"
              >
                {parts.match}
              </mark>
            )}
            {parts.after}
          </p>
        </div>

        <footer className="border-t border-slate-200 px-6 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
          Highlighted text is matched by the app against the fetched source — the model never asserted it.
        </footer>
      </div>
    </div>
  )
}
