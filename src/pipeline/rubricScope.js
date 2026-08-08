// pipeline/rubricScope.js — advisory scope checks for user-authored rubric prose.
//
// The rubric scores one current paper. It does not read the saved library, remember prior
// runs, schedule future work, or allocate the whole slate. Those capabilities either live
// elsewhere (saved-paper retraction checks; deterministic topic coverage) or do not exist.
// Keep this checker conservative: a false warning trains users to ignore all warnings, so
// only explicit cross-component language is flagged. Text is never deleted or blocked.

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()

export function rubricSentences(criteria) {
  return String(criteria ?? '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map(clean)
    .filter(Boolean)
}

const SAVED_HISTORY = /\b(?:previously|already)\s+(?:saved|seen|read)|\bsaved\s+(?:papers?|articles?)|\b(?:my|the|our)\s+(?:saved\s+)?library|\bpast\s+(?:digests?|runs?)|\bprior\s+(?:digests?|runs?)\b/i
const RETRACTION = /\bretract(?:ed|ion|ions)?\b/i
const FUTURE_ACTION = /\b(?:notify|alert|remind)\b|\b(?:monitor|track|watch)\b[^.!?]*\b(?:future|later|subsequent|updates?|corrections?|retractions?|over time)\b|\b(?:future|later|subsequent|updates?|corrections?|retractions?|over time)\b[^.!?]*\b(?:monitor|track|watch)\b/i
const CROSS_CANDIDATE = /\brank\s+(?:within|across)\s+(?:each\s+)?(?:buckets?|topics?|categories?|fields?)\b|\b(?:quota|quotas)\b|\b(?:at least|exactly)\s+(?:one|two|three|\d+)\s+(?:papers?\s+)?(?:from|per|for)\s+(?:each\s+)?(?:topics?|buckets?|categories?|fields?)\b|\b(?:balance|diversify|diversity)\b[^.!?]*\b(?:slate|digest|topics?|fields?)\b|\bcompare\s+(?:the\s+)?(?:papers?|candidates?)\s+(?:with|against|to)\s+(?:each other|one another)\b/i

const issue = (code, sentence, message) => ({ code, sentence, message })

export function rubricScopeIssues(criteria) {
  const out = []
  for (const sentence of rubricSentences(criteria)) {
    const saved = SAVED_HISTORY.test(sentence)
    const retraction = RETRACTION.test(sentence)
    if (saved && retraction) {
      out.push(issue(
        'saved-retraction',
        sentence,
        'The paper scorer cannot see saved-paper history. Verastar checks saved PubMed papers for retraction when the Library opens; this rubric sentence does not control that monitor.',
      ))
      continue
    }
    if (saved) {
      out.push(issue(
        'library-history',
        sentence,
        'The paper scorer cannot see your saved library or prior digest history, so this instruction cannot affect its score.',
      ))
    }
    if (FUTURE_ACTION.test(sentence)) {
      out.push(issue(
        'future-monitoring',
        sentence,
        'The paper scorer runs only during the current digest; it cannot schedule alerts or monitor future changes.',
      ))
    }
    if (CROSS_CANDIDATE.test(sentence)) {
      out.push(issue(
        'cross-candidate',
        sentence,
        'The rubric scores papers individually. Topic coverage is applied afterward across the slate; exact bucket quotas or comparisons between candidates are not executed by this sentence.',
      ))
    }
  }
  return out
}
