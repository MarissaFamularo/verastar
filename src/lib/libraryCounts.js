// Rail counts for the reader's own library. Starter samples (saveSource 'seed',
// such as the CREST reference) stay in the Library with a Starter label, but they
// are not the reader's saves and must not inflate "saved" or "with checked numbers".

import { savedWithoutWhy } from '../pipeline/save.js'
import { hasValidatedPaperEvidence } from './evidenceVersion.js'

export function isStarterPaper(paper) {
  return paper?.saveSource === 'seed'
}

function starterTitle(paper) {
  const title = String(paper?.title || paper?.citation?.title || '').trim()
  if (!title) return 'sample paper'
  const named = title.match(/\bCREST(?:-\d)?\b/)
  if (named && title.length > 42) return named[0]
  return title.length > 42 ? `${title.slice(0, 41)}…` : title
}

export function libraryRailCounts(papers) {
  const list = Array.isArray(papers) ? papers.filter(Boolean) : []
  const starters = list.filter(isStarterPaper)
  const own = list.filter((paper) => !isStarterPaper(paper))
  return {
    verified: own.filter(hasValidatedPaperEvidence).length,
    saved: own.length,
    flagged: own.filter((paper) => paper?.flagged).length,
    withoutWhy: savedWithoutWhy(own).length,
    starters: starters.length,
    starterTitle: starters.length === 1 ? starterTitle(starters[0]) : '',
  }
}
