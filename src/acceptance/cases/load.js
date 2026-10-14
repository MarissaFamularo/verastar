// acceptance/cases/load.js — source text for the acceptance cases, read from the SAVED
// development fixtures. The fixtures are reused as source material only; the verdicts stored
// beside them are legacy evidence and are never read here.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '..', '..', 'pipeline', '__fixtures__')

export function devsetSource(id) {
  const d = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'devset', `${id}.json`), 'utf8'))
  return { pmid: d.pmid, text: d.sourceDoc.text, tables: d.sourceDoc.tables || '', tier: d.tier }
}

export function liveSource(pmid) {
  const d = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'live-2026-10-12.json'), 'utf8'))
  return { pmid, text: `${d[pmid].title}\n\n${d[pmid].abstract}`, tables: '', tier: 'abstract_only' }
}

// Genuinely restricted input for Card 6 state B: the abstract up to, not including, FINDINGS.
export function methodsOnly(source, marker = 'FINDINGS:') {
  const i = source.text.indexOf(marker)
  if (i < 0) throw new Error(`marker ${marker} not found`)
  return { ...source, text: source.text.slice(0, i), tier: 'partial' }
}

// Claim factory: every field explicit so a case never relies on defaults it did not state.
export function claim(fields) {
  return {
    id: fields.id,
    kind: fields.kind,
    role: fields.role ?? null,
    population: fields.population ?? null,
    comparator: fields.comparator ?? null,
    outcome: fields.outcome ?? null,
    timepoint: fields.timepoint ?? null,
    direction: fields.direction ?? null,
    estimate: fields.estimate ?? null,
    arms: fields.arms ?? undefined,
    language: fields.language ?? 'none',
    basis: fields.basis ?? 'source',
    attribution: fields.attribution ?? null,
    evidence: fields.evidence ?? null,
    text: fields.text,
  }
}

export const ci = (low, high, label = '95% CI') => ({ low, high, label })
export const bracket = (low, high) => ({ low, high, label: 'printed-bracket' })
