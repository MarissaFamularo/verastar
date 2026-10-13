// Checked rows for the signed-out sample digest.
//
// Passages are exact slices of devset full text (CAR-10 CREST, CAR-07 CREST-2).
// Verdicts are whatever verify() returns against that stored text. A row the
// current verifier does not accept is omitted rather than stamped by hand.
// BASIL-3 and STARDUST are not here: the keyless excerpts check a quote against
// itself, and those trials have no stored source the verifier can accept.
// BEST-CLI and BASIL-2 stay out (docs/FACTS.md).

import { verify } from '../pipeline/verify.js'
import { isRelationshipValidated } from '../lib/evidenceVersion.js'
import papers from './checkedExamplePassages.json'

export function rowsCheckedAgainst(quantities, sourceDoc, sourceTier = 'full_text') {
  return quantities.flatMap((quantity) => {
    if (!quantity?.source_quote || !sourceDoc?.text?.includes(quantity.source_quote)) return []
    const verdict = verify(quantity, sourceDoc, { sourceTier })
    return isRelationshipValidated(verdict) ? [{ quantity, verdict }] : []
  })
}

export function checkedExampleResults(specs = papers) {
  return specs.flatMap((paper) => {
    const sourceDoc = { text: paper.passages.join('\n\n'), tables: '' }
    const rows = rowsCheckedAgainst(paper.quantities, sourceDoc, 'full_text')
    if (!rows.length) return []
    return [{
      paper: {
        id: paper.id,
        pmid: paper.pmid,
        pmcid: null,
        nct: null,
        title: paper.title,
      },
      citation: {
        pmid: paper.pmid,
        url: `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/`,
        author: paper.author,
        journal: paper.journal,
        year: paper.year,
        title: paper.title,
        verified: true,
      },
      source: { pmcid: null, tier: 'full_text', hasBody: true },
      sourceDoc,
      design: paper.design,
      rows,
      oa: null,
    }]
  })
}

export function checkedExampleTriage(specs = papers, results = checkedExampleResults(specs)) {
  const byId = new Map(results.map((result) => [result.paper.id, result]))
  return Object.fromEntries(specs.flatMap((paper) => {
    if (!byId.has(paper.id)) return []
    return [[paper.id, {
      score: paper.score,
      tier: 1,
      finding: paper.finding,
      relevance: paper.relevance,
    }]]
  }))
}
