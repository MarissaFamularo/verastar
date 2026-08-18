// One paper-sharing control for both the live digest and saved Library.
// Shares the publication itself, never Verastar's personalized summary or app state.

import { logEvent } from '../lib/events.js'
import { pmcUrl } from '../pipeline/openaccess.js'

export function paperShareDetails(paper = {}) {
  const citation = paper.citation || {}
  const pmid = paper.pmid || citation.pmid || (/^\d+$/.test(String(paper.id || '')) ? paper.id : '')
  const doi = paper.doi || citation.doi
  const title = paper.title || citation.title || (pmid ? `PubMed ${pmid}` : 'Research article')
  const url = citation.url || (pmid
    ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
    : doi
      ? `https://doi.org/${String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}`
      : '')
  const cite = [citation.author, citation.journal, citation.year].filter(Boolean).join(' · ')
  const text = [title, cite].filter(Boolean).join(' — ')
  const fullTextUrl = paper.pdfUrl || paper.oaUrl || pmcUrl(paper.pmcid)

  return { title, url, text, fullTextUrl, pmid: pmid || paper.id || '' }
}

export async function sharePaper(paper, { surface = 'library', navigatorObject, locationObject } = {}) {
  const details = paperShareDetails(paper)
  const nav = navigatorObject ?? globalThis.navigator

  if (typeof nav?.share === 'function') {
    try {
      await nav.share({ title: details.title, text: details.text, url: details.url })
      logEvent('paper_shared', { pmid: details.pmid, method: 'native', surface })
      return 'native'
    } catch {
      // Closing the system share sheet is a normal cancellation, not an error and not a
      // reason to unexpectedly open a second sharing method.
      return 'cancelled'
    }
  }

  const location = locationObject ?? globalThis.location
  if (!location) return 'unavailable'
  const body = [details.text, details.url, details.fullTextUrl && `Full text: ${details.fullTextUrl}`]
    .filter(Boolean)
    .join('\n')
  location.href = `mailto:?subject=${encodeURIComponent(details.title)}&body=${encodeURIComponent(body)}`
  logEvent('paper_shared', { pmid: details.pmid, method: 'mailto', surface })
  return 'mailto'
}

export default function SharePaperButton({ paper, surface = 'library', style }) {
  return (
    <button
      type="button"
      onClick={() => sharePaper(paper, { surface })}
      title="Send this article"
      aria-label={`Share ${paperShareDetails(paper).title}`}
      className="cursor-pointer"
      style={{
        borderRadius: 7,
        padding: '3px 9px',
        border: 0,
        background: 'rgba(239,143,91,.14)',
        color: 'var(--color-accent-bright)',
        fontSize: 11,
        fontWeight: 600,
        fontFamily: 'inherit',
        ...style,
      }}
    >
      Share ↑
    </button>
  )
}
