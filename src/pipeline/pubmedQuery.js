// pipeline/pubmedQuery.js — turn a topic's OR query into the PubMed search that actually runs,
// and decide whether a hit is about that topic before it is shown or scored.
//
// The text stored on a topic stays the short OR query a clinician can read and edit. Sending
// that text to esearch untagged was the beta failure. PubMed's automatic term mapping then:
//   - splits a multi-word concept into independent words across every indexed field, so
//     "vascular surgery" matched a tinnitus guideline that never says the phrase, and
//     "venous stent" matched an Impella / mitral-valve paper that mentions a stent post
//     and a vein somewhere else in the record;
//   - explodes MeSH, so "venous thromboembolism" pulled an immune-thrombocytopenia study
//     indexed under the narrower heading Venous Thrombosis, and "arteriovenous fistula"
//     pulled carotid-cavernous fistulas.
// A hand-burn flap series also survived "amputation" because the word appears in the
// abstract while the paper is not about limb preservation.
//
// Compilation quotes each OR-clause into [tiab]. That keeps the synonyms (so a 3-day window
// still returns papers) and turns mapping off for that clause. The lexical gate then drops
// hits whose title is about something else: a single passing abstract mention, a generic
// word that never makes the title, or a neurovascular fistula returned for dialysis access.

const ACRONYMS = new Set(['aaa', 'avf', 'avg', 'cas', 'cea', 'clti', 'dvt', 'evar', 'pad', 'pe', 'svg', 'tavr', 'tevar', 'vte'])

// Words that appear in topic labels but do not say which disease the title is about.
const GENERIC = new Set([
  'access', 'acute', 'adult', 'care', 'chronic', 'clinical', 'disease', 'diseases', 'education',
  'endovascular', 'guideline', 'health', 'human', 'injury', 'injuries', 'major', 'management',
  'medical', 'medicine', 'minor', 'open', 'outcome', 'outcomes', 'patient', 'patients', 'practice',
  'program', 'related', 'repair', 'research', 'review', 'study', 'surgery', 'surgical', 'therapy',
  'therapies', 'training', 'treatment', 'update', 'vascular',
])

const ACCESS_TOPIC = /vascular access|dialysis access|\bdialysis\b|h[ae]modialysis|arteriovenous graft|\bAVF\b|\bAVG\b/i
const OTHER_FISTULA = /carotid[-\s\u2010-\u2015]?cavernous|cavernous sinus|dural arteriovenous|intracranial arteriovenous|meningeal arteriovenous|cerebral dural/i
const OWN_FISTULA = /h[ae]modialysis|\bdialysis\b|vascular access|arteriovenous graft|\bcannulat/i

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Top-level boolean tokens. Parentheses stay inside an atom so nested OR/AND is compiled
// by recursion rather than flattened here.
function tokenize(expr) {
  const tokens = []
  let current = ''
  let depth = 0
  let quote = false
  const push = () => {
    if (current.trim()) tokens.push({ type: 'atom', value: current.trim() })
    current = ''
  }
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]
    if (ch === '"') {
      quote = !quote
      current += ch
      continue
    }
    if (!quote && ch === '(') depth++
    if (!quote && ch === ')') depth = Math.max(0, depth - 1)
    if (!quote && depth === 0) {
      const match = expr.slice(i).match(/^(AND|OR|NOT)\b/i)
      const next = match ? expr[i + match[0].length] : ''
      const prev = i === 0 ? ' ' : expr[i - 1]
      if (match && !/[A-Za-z0-9]/.test(prev) && !/[A-Za-z0-9]/.test(next || ' ')) {
        push()
        tokens.push({ type: 'op', value: match[1].toUpperCase() })
        i += match[0].length - 1
        continue
      }
    }
    current += ch
  }
  push()
  return tokens
}

function splitBy(tokens, operator) {
  const groups = [[]]
  for (const token of tokens) {
    if (token.type === 'op' && token.value === operator) groups.push([])
    else groups[groups.length - 1].push(token)
  }
  return groups.filter((group) => group.length)
}

function stripTag(value) {
  return String(value || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim()
}

function normalizePhrase(value) {
  return stripTag(value)
    .replace(/^"+|"+$/g, '')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function wordsOf(value) {
  return normalizePhrase(value).split(' ').filter(Boolean)
}

function isAcronym(word) {
  const token = String(word || '')
  return ACRONYMS.has(token.toLowerCase()) || /^[A-Z]{2,6}$/.test(token)
}

function isOrdinaryWord(value) {
  const words = wordsOf(value)
  if (words.length !== 1) return false
  const raw = stripTag(String(value || '')).replace(/^"+|"+$/g, '').trim()
  return !isAcronym(raw)
}

function termPattern(value, flags) {
  const words = wordsOf(value)
  if (!words.length) return null
  const body = words.length === 1
    ? `${escapeRegExp(words[0])}(?:s|es)?`
    : words.map(escapeRegExp).join('[\\s\\-\u2010-\u2015]+')
  return new RegExp(`(?:^|[^A-Za-z0-9])(?:${body})(?=[^A-Za-z0-9]|$)`, flags)
}

function termMatches(value, text) {
  const pattern = termPattern(value, 'i')
  return Boolean(pattern && pattern.test(String(text || '')))
}

function termCount(value, text) {
  const pattern = termPattern(value, 'gi')
  if (!pattern) return 0
  return (String(text || '').match(pattern) || []).length
}

function compileAtom(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/\[[^\]]+\]\s*$/.test(raw)) return raw
  const bare = raw.replace(/^"+|"+$/g, '').replace(/[\u2010-\u2015-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!bare) return ''
  if (/\s/.test(bare)) return `"${bare}"[tiab]`
  return `${bare}[tiab]`
}

// The whole string is one parenthesized expression, not a phrase that merely contains parens.
function innerExpression(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return null
  let depth = 0
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '"') continue
    if (trimmed[i] === '(') depth++
    else if (trimmed[i] === ')') depth--
    if (depth === 0 && i < trimmed.length - 1) return null
  }
  return depth === 0 ? trimmed.slice(1, -1).trim() : null
}

function compilePrimary(token) {
  if (!token) return ''
  const value = token.type === 'atom' ? token.value : String(token.value || token)
  const inner = innerExpression(value)
  if (inner != null) return `(${compilePubmedQuery(inner)})`
  if (/^NOT\b/i.test(value)) return `NOT ${compileAtom(value.replace(/^NOT\s+/i, ''))}`
  return compileAtom(value)
}

function compileAndNot(tokens) {
  if (!tokens.length) return ''
  let index = 0
  let acc = ''
  if (tokens[0].type === 'op' && tokens[0].value === 'NOT') {
    acc = `NOT ${compilePrimary(tokens[1])}`
    index = 2
  } else {
    acc = compilePrimary(tokens[0])
    index = 1
  }
  for (; index < tokens.length; index += 2) {
    const op = tokens[index]
    const rhs = tokens[index + 1]
    if (!op || op.type !== 'op' || !rhs) break
    acc = `${acc} ${op.value} ${compilePrimary(rhs)}`
  }
  return acc
}

function compileTokens(tokens) {
  const orGroups = splitBy(tokens, 'OR')
  if (orGroups.length > 1) return orGroups.map(compileTokens).filter(Boolean).join(' OR ')
  return compileAndNot(tokens)
}

// The esearch term for one stored topic query. OR, AND, NOT, parentheses, and an explicit
// field tag the clinician already typed are preserved. Untagged concepts become [tiab].
export function compilePubmedQuery(query) {
  const raw = typeof query === 'string' ? query.trim() : ''
  if (!raw) return ''
  return compileTokens(tokenize(raw))
}

function positiveParts(tokens) {
  const parts = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === 'op' && token.value === 'NOT') {
      i += 1
      continue
    }
    if (token.type === 'op') continue
    parts.push(token.value)
  }
  return parts
}

function negativeParts(tokens) {
  const parts = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'op' && tokens[i].value === 'NOT' && tokens[i + 1]?.type === 'atom') {
      parts.push(tokens[i + 1].value)
    }
  }
  return parts
}

function partMatches(part, text) {
  const inner = innerExpression(part)
  if (inner != null) return expressionMatches(tokenize(inner), text)
  return termMatches(part, text)
}

function andNotMatches(tokens, text) {
  const positive = positiveParts(tokens)
  if (!positive.length || !positive.every((part) => partMatches(part, text))) return false
  return negativeParts(tokens).every((part) => !partMatches(part, text))
}

function expressionMatches(tokens, text) {
  const groups = splitBy(tokens, 'OR')
  if (groups.length > 1) return groups.some((group) => andNotMatches(group, text))
  return andNotMatches(tokens, text)
}

function leafTerms(part) {
  const inner = innerExpression(part)
  if (inner != null) return tokenize(inner).filter((token) => token.type === 'atom').flatMap((token) => leafTerms(token.value))
  return [part]
}

function orGroups(query) {
  return splitBy(tokenize(query), 'OR')
}

function distinctiveLabelTokens(label) {
  return normalizePhrase(label)
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !GENERIC.has(token) && (token.length >= 4 || ACRONYMS.has(token)))
}

function titleCarriesLabel(title, label) {
  return distinctiveLabelTokens(label).some((token) => termMatches(token, title))
}

// Dialysis access and intracranial fistula share the MeSH parent "arteriovenous fistula".
// A title that names the intracranial lesion is not a vascular-access paper unless it also
// uses the dialysis wording.
function crossSpecialtyVeto({ title, abstract, query, label }) {
  const topic = `${label || ''}\n${query || ''}`
  if (!ACCESS_TOPIC.test(topic)) return false
  const blob = `${title || ''}\n${abstract || ''}`
  if (!OTHER_FISTULA.test(blob)) return false
  if (OWN_FISTULA.test(blob)) return false
  return true
}

function groupKept(tokens, title, abstract) {
  if (andNotMatches(tokens, title)) return true
  const combined = `${title}\n${abstract}`
  if (!andNotMatches(tokens, combined)) return false
  const leaves = positiveParts(tokens).flatMap(leafTerms)
  // "Amputation" twice in a hand-burn abstract is not limb preservation. A generic word
  // has to be the title's subject. A real multi-word concept can carry a bland title when
  // the abstract keeps returning to it, not when it is named once in passing.
  if (leaves.some((part) => isOrdinaryWord(part) && !termMatches(part, title))) return false
  return leaves.some((part) => !isOrdinaryWord(part) && termCount(part, abstract) >= 2)
}

// True when this paper belongs on the topic's preview line and in the pool that is scored
// before digest triage. Title and abstract only — MeSH-only hits never qualify.
export function fitsTopic({ title = '', abstract = '', query = '', label = '' } = {}) {
  const groups = orGroups(query)
  if (!groups.length) return false
  if (crossSpecialtyVeto({ title, abstract, query, label })) return false
  if (groups.some((group) => groupKept(group, title, abstract))) return true
  if (!titleCarriesLabel(title, label)) return false
  const combined = `${title}\n${abstract}`
  return groups.some((group) => {
    const leaves = positiveParts(group).flatMap(leafTerms)
    return leaves.length > 0
      && leaves.every((part) => !isOrdinaryWord(part))
      && andNotMatches(group, combined)
  })
}
