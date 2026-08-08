// pipeline/journals.js — structured journal priorities and an opt-in rubric migration.
//
// Journal lists are stable structured context, not editorial prose. Keeping them separate
// makes every scoring batch shorter and keeps the rubric focused. Existing prose is never
// rewritten automatically: the model may identify exact journal-only spans, but pure code
// removes only those verbatim spans and preserves everything else.

import { extractStructured, MODELS } from '../lib/anthropic.js'

const text = (value) => String(value ?? '').trim()

function cleanList(value) {
  const seen = new Set()
  return (Array.isArray(value) ? value : [])
    .map(text)
    .filter((item) => {
      const key = item.toLocaleLowerCase()
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function normalizeJournalPreferences(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const mustNotMiss = cleanList(source.mustNotMiss ?? source.must_not_miss ?? source.tier1)
  const mustKeys = new Set(mustNotMiss.map((journal) => journal.toLocaleLowerCase()))
  const preferred = cleanList(source.preferred ?? source.preferredJournals ?? source.tier2)
    .filter((journal) => !mustKeys.has(journal.toLocaleLowerCase()))
  return { mustNotMiss, preferred }
}

export function journalPreferenceText(raw) {
  const journals = normalizeJournalPreferences(raw)
  const lines = []
  if (journals.mustNotMiss.length) lines.push(`Must-not-miss journals: ${journals.mustNotMiss.join(', ')}`)
  if (journals.preferred.length) lines.push(`Preferred journals: ${journals.preferred.join(', ')}`)
  return lines.length ? lines.join('\n') : '(no journal preferences set)'
}

export function rubricWordCount(rubric) {
  const value = text(rubric)
  return value ? value.split(/\s+/).length : 0
}

export const RUBRIC_WORD_WARNING = 250

export const JOURNAL_MIGRATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['extractions'],
  properties: {
    extractions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fragment', 'tier', 'journals'],
        properties: {
          fragment: { type: 'string' },
          tier: { type: 'string', enum: ['must_not_miss', 'preferred'] },
          journals: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const MIGRATION_SYSTEM = `You identify journal-preference text inside a clinician's scoring rubric. Return exact substrings only; do not rewrite the rubric.

For each span that expresses a must-not-miss or preferred journal list, return:
- fragment: the SMALLEST exact verbatim substring from the rubric that can be removed while leaving its non-journal editorial criteria intact.
- tier: must_not_miss when papers from these journals should always/must reach the reader; preferred when the journals are positive evidence but not absolute.
- journals: the journal names stated in that exact fragment.

Do not extract study-design preferences, endpoints, topics, exclusions, relevance criteria, or prose merely because it appears in the same sentence. If a sentence says "Prioritize randomized trials in JAMA and NEJM", extract only "in JAMA and NEJM", leaving "Prioritize randomized trials" intact. If no journal-only span can be removed safely, return an empty array.`

// Apply only exact, non-overlapping spans from the original rubric. This is the preservation
// guarantee: the model cannot supply replacement prose, and an inexact fragment is ignored.
export function applyJournalExtractions(rubric, extractions, currentPreferences) {
  const original = String(rubric ?? '')
  const accepted = []
  const occupied = []
  for (const row of Array.isArray(extractions) ? extractions : []) {
    const fragment = String(row?.fragment ?? '')
    const journals = cleanList(row?.journals)
    if (!fragment || !journals.length || !['must_not_miss', 'preferred'].includes(row?.tier)) continue
    const start = original.indexOf(fragment)
    if (start < 0) continue
    const end = start + fragment.length
    if (occupied.some(([a, b]) => start < b && end > a)) continue
    occupied.push([start, end])
    accepted.push({ fragment, start, end, tier: row.tier, journals })
  }

  let nextRubric = original
  for (const row of [...accepted].sort((a, b) => b.start - a.start)) {
    nextRubric = nextRubric.slice(0, row.start) + nextRubric.slice(row.end)
  }
  nextRubric = nextRubric
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const merged = normalizeJournalPreferences(currentPreferences)
  const mustNotMiss = [...merged.mustNotMiss]
  const preferred = [...merged.preferred]
  for (const row of accepted) {
    for (const journal of row.journals) {
      const key = journal.toLocaleLowerCase()
      if (row.tier === 'must_not_miss') {
        const preferredIndex = preferred.findIndex((item) => item.toLocaleLowerCase() === key)
        if (preferredIndex >= 0) preferred.splice(preferredIndex, 1)
        if (!mustNotMiss.some((item) => item.toLocaleLowerCase() === key)) mustNotMiss.push(journal)
      } else if (![...mustNotMiss, ...preferred].some((item) => item.toLocaleLowerCase() === key)) {
        preferred.push(journal)
      }
    }
  }

  return {
    rubric: nextRubric,
    journalPreferences: normalizeJournalPreferences({ mustNotMiss, preferred }),
    removed: accepted.map(({ fragment, tier, journals }) => ({ fragment, tier, journals })),
    changed: accepted.length > 0,
  }
}

export async function proposeJournalMigration({ rubric, journalPreferences, model = MODELS.triage, maxTokens = 2048 } = {}) {
  const original = String(rubric ?? '')
  const raw = await extractStructured({
    model,
    system: MIGRATION_SYSTEM,
    content: `CURRENT STRUCTURED JOURNALS:\n${journalPreferenceText(journalPreferences)}\n\nRUBRIC:\n${original}`,
    schema: JOURNAL_MIGRATION_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })
  return applyJournalExtractions(original, raw?.extractions, journalPreferences)
}
