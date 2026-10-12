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
// hits that are not about the topic: a single passing abstract mention of a specific
// concept, a genuinely broad word (amputation, surgery, outcomes) that never makes the
// title, or a neurovascular fistula returned for dialysis access. Tags other than
// title/abstract stay with PubMed, and syntax this matcher cannot read is kept for scoring.

const ACRONYMS = new Set(['aaa', 'avf', 'avg', 'cas', 'cea', 'clti', 'dvt', 'evar', 'pad', 'pe', 'svg', 'tavr', 'tevar', 'vte'])

// Title-only terms. Everything else, including a specific single word such as "diabetes",
// can qualify from repeated use in the abstract. Plurals are listed explicitly so a stem
// does not turn "outcomes" into a different word.
const BROAD_TERMS = new Set([
  'amputation', 'amputations', 'outcome', 'outcomes', 'surgeries', 'surgery',
])

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

function isBroadTerm(value) {
  const words = wordsOf(value)
  if (words.length !== 1) return false
  return BROAD_TERMS.has(words[0].replace(/\*$/, ''))
}

// [ti] / [ab] / [tiab] are the only tags the local gate can check. Publication type, MeSH,
// author, date, and the rest are already applied by PubMed and must not be re-required in prose.
function fieldScope(value) {
  const match = String(value || '').match(/\[([^\]]+)\]\s*$/)
  if (!match) return 'tiab'
  const tag = match[1].trim().toLowerCase()
  if (tag === 'ti' || tag === 'title') return 'title'
  if (tag === 'ab' || tag === 'abstract') return 'abstract'
  if (tag === 'tiab' || tag === 'title/abstract') return 'tiab'
  return null
}

function wordBody(word) {
  // Trailing truncation: stent* matches stenting. A star anywhere else is not this pattern.
  if (/^[a-z0-9]+\*$/.test(word)) return `${escapeRegExp(word.slice(0, -1))}[a-z0-9]*`
  return `${escapeRegExp(word)}(?:s|es)?`
}

function termPattern(value, flags) {
  const words = wordsOf(value)
  if (!words.length) return null
  const body = words.map(wordBody).join('[\\s\\-\u2010-\u2015]+')
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
  // A multi-word concept, including a trailing wildcard ("carotid stent*"[tiab]), stays one
  // clause. PubMed applies truncation at the end of a quoted phrase. Splitting the words
  // into AND would change the meaning of a surrounding OR.
  if (/\s/.test(bare)) return `"${bare}"[tiab]`
  return `${bare}[tiab]`
}

// A compiled fragment that itself contains AND/OR/NOT has to be one operand. Parentheses
// keep the surrounding expression's precedence identical to the query that was stored.
function embed(compiled) {
  const text = String(compiled || '').trim()
  if (!text) return text
  if (innerExpression(text) != null) return text
  if (/\b(AND|OR|NOT)\b/.test(text)) return `(${text})`
  return text
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
  if (/^NOT\b/i.test(value)) return `NOT ${embed(compileAtom(value.replace(/^NOT\s+/i, '')))}`
  return compileAtom(value)
}

function compileAndNot(tokens) {
  if (!tokens.length) return ''
  let index = 0
  let acc = ''
  if (tokens[0].type === 'op' && tokens[0].value === 'NOT') {
    acc = `NOT ${embed(compilePrimary(tokens[1]))}`
    index = 2
  } else {
    acc = embed(compilePrimary(tokens[0]))
    index = 1
  }
  for (; index < tokens.length; index += 2) {
    const op = tokens[index]
    const rhs = tokens[index + 1]
    if (!op || op.type !== 'op' || !rhs) break
    acc = `${acc} ${op.value} ${embed(compilePrimary(rhs))}`
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

function leafTerms(part) {
  const inner = innerExpression(part)
  if (inner != null) return tokenize(inner).filter((token) => token.type === 'atom').flatMap((token) => leafTerms(token.value))
  return [part]
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

function abstractMissing(abstract) {
  return !String(abstract || '').trim()
}

// Supported truncation is a trailing * on a word of letters or digits (stent*). A leading
// or internal star, ?, or ~ is left to PubMed: the gate keeps the paper.
function hasUnsupportedSyntax(query) {
  const withoutSupported = String(query || '').replace(/[A-Za-z0-9]\*(?![A-Za-z0-9*])/g, 'W')
  return /[*?~]/.test(withoutSupported)
}

// Kleene three-valued logic. A MeSH, author, publication-type, or other non-text tag is
// unknown: this gate cannot see it. NOT unknown stays unknown, and unknown never becomes
// a successful match that a surrounding NOT can turn into an exclusion.
const TRUE = 'true'
const FALSE = 'false'
const UNKNOWN = 'unknown'

function kleeneNot(value) {
  if (value === TRUE) return FALSE
  if (value === FALSE) return TRUE
  return UNKNOWN
}

function kleeneAnd(values) {
  if (values.some((value) => value === FALSE)) return FALSE
  if (values.some((value) => value === UNKNOWN)) return UNKNOWN
  return TRUE
}

function kleeneOr(values) {
  if (values.some((value) => value === TRUE)) return TRUE
  if (values.some((value) => value === UNKNOWN)) return UNKNOWN
  return FALSE
}

// How one positive text leaf meets the gate. A broad word has to be the title's subject.
// A specific concept can pass from the title, or from repeated abstract use. One passing
// abstract mention is not enough. Metadata and a missing abstract are unknown, not failures.
function leafEval(part, title, abstract) {
  const scope = fieldScope(part)
  if (scope == null) return { value: UNKNOWN, anchor: null, kind: 'metadata' }
  const broad = isBroadTerm(part)
  const inTitle = scope !== 'abstract' && termMatches(part, title)
  const missing = abstractMissing(abstract)
  const count = scope !== 'title' && !missing ? termCount(part, abstract) : 0
  if (broad && scope !== 'abstract') {
    return inTitle
      ? { value: TRUE, anchor: 'title', kind: 'text' }
      : { value: FALSE, anchor: null, kind: 'text' }
  }
  if (scope === 'title') {
    return inTitle
      ? { value: TRUE, anchor: 'title', kind: 'text' }
      : { value: FALSE, anchor: null, kind: 'text' }
  }
  if (inTitle) return { value: TRUE, anchor: 'title', kind: 'text' }
  if (missing) return { value: UNKNOWN, anchor: null, kind: 'text' }
  if (count >= (broad ? 1 : 2)) return { value: TRUE, anchor: 'repeated', kind: 'text' }
  if (count === 1) return { value: TRUE, anchor: 'once', kind: 'text' }
  return { value: FALSE, anchor: null, kind: 'text' }
}

// Presence, not the inclusion bar. A negated word excludes when it actually occurs.
// A negated metadata tag stays unknown, so it cannot exclude.
function presence(part, title, abstract) {
  const inner = innerExpression(part)
  if (inner != null) return presenceExpr(tokenize(inner), title, abstract)
  const scope = fieldScope(part)
  if (scope == null) return UNKNOWN
  if (scope !== 'abstract' && termMatches(part, title)) return TRUE
  if (scope === 'title') return FALSE
  if (abstractMissing(abstract)) return UNKNOWN
  return termMatches(part, abstract) ? TRUE : FALSE
}

function presenceAnd(tokens, title, abstract) {
  const values = [
    ...positiveParts(tokens).map((part) => presence(part, title, abstract)),
    ...negativeParts(tokens).map((part) => kleeneNot(presence(part, title, abstract))),
  ]
  if (!values.length) return UNKNOWN
  return kleeneAnd(values)
}

function presenceExpr(tokens, title, abstract) {
  const groups = splitBy(tokens, 'OR')
  const values = groups.map((group) => presenceAnd(group, title, abstract))
  return groups.length > 1 ? kleeneOr(values) : values[0]
}

function statusOf(part, title, abstract) {
  const inner = innerExpression(part)
  if (inner == null) return leafEval(part, title, abstract)
  return evalExpr(tokenize(inner), title, abstract)
}

// Text requirements only. Metadata clauses are PubMed's job and are not requirements here.
// One substantive concept carries an AND-group whose other text concepts are present.
function judgeText(parts) {
  if (!parts.length) return { keeps: true, anchor: null }
  if (parts.some((part) => part.value === FALSE)) return { keeps: false, anchor: null }
  if (parts.some((part) => part.value === UNKNOWN)) return { keeps: true, anchor: null }
  if (parts.every((part) => part.anchor === 'title')) return { keeps: true, anchor: 'title' }
  if (parts.some((part) => part.anchor === 'repeated')) return { keeps: true, anchor: 'repeated' }
  return { keeps: false, anchor: 'once' }
}

function evalAnd(tokens, title, abstract) {
  const positives = positiveParts(tokens).map((part) => statusOf(part, title, abstract))
  const notValues = negativeParts(tokens).map((part) => kleeneNot(presence(part, title, abstract)))
  const value = kleeneAnd([...positives.map((part) => part.value), ...notValues])
  if (value === FALSE) return { value: FALSE, keeps: false, kind: 'text', anchor: null }
  const text = positives.filter((part) => part.kind !== 'metadata')
  const judged = judgeText(text)
  return {
    value,
    keeps: judged.keeps,
    kind: text.length ? 'text' : 'metadata',
    anchor: judged.anchor,
  }
}

function evalExpr(tokens, title, abstract) {
  const groups = splitBy(tokens, 'OR')
  if (groups.length <= 1) return evalAnd(groups[0] || [], title, abstract)
  const results = groups.map((group) => evalAnd(group, title, abstract))
  const value = kleeneOr(results.map((result) => result.value))
  if (value === FALSE) return { value: FALSE, keeps: false, kind: 'text', anchor: null }
  const anchored = results.some((result) => (
    result.keeps && result.kind !== 'metadata' && (result.anchor === 'title' || result.anchor === 'repeated')
  ))
  if (anchored) {
    const anchor = results.some((result) => result.anchor === 'repeated') ? 'repeated' : 'title'
    return { value: TRUE, keeps: true, kind: 'text', anchor }
  }
  // Unknown metadata, or a text term we could not read, must not exclude the paper.
  if (value === UNKNOWN) {
    const onlyMeta = results.every((result) => result.kind === 'metadata')
    return { value: UNKNOWN, keeps: true, kind: onlyMeta ? 'metadata' : 'text', anchor: null }
  }
  return { value: TRUE, keeps: false, kind: 'text', anchor: 'once' }
}

function negativeHits(part, title, abstract) {
  return presence(part, title, abstract) === TRUE
}

function textMatchesOnce(part, title, abstract) {
  const scope = fieldScope(part)
  if (scope == null) return true
  if (scope !== 'abstract' && termMatches(part, title)) return true
  if (scope === 'title') return false
  if (abstractMissing(abstract)) return true
  return termCount(part, abstract) >= 1
}

function partMatchesOnce(part, title, abstract) {
  const inner = innerExpression(part)
  if (inner != null) return exprMatchesOnce(tokenize(inner), title, abstract)
  return textMatchesOnce(part, title, abstract)
}

function exprMatchesOnce(tokens, title, abstract) {
  const groups = splitBy(tokens, 'OR')
  if (groups.length > 1) return groups.some((group) => andMatchesOnce(group, title, abstract))
  return andMatchesOnce(tokens, title, abstract)
}

function andMatchesOnce(tokens, title, abstract) {
  const positives = positiveParts(tokens).filter((part) => fieldScope(part) != null || innerExpression(part) != null)
  if (!positives.length) return false
  if (!positives.every((part) => partMatchesOnce(part, title, abstract))) return false
  return negativeParts(tokens).every((part) => !negativeHits(part, title, abstract))
}

// The title already names the topic, so one abstract mention of a specific concept is enough.
// A broad word still has to be the title's subject; that path is decided above.
function labelRescue(tokens, title, abstract) {
  return splitBy(tokens, 'OR').some((group) => {
    const leaves = positiveParts(group).flatMap(leafTerms).filter((part) => fieldScope(part) != null)
    return leaves.length > 0
      && leaves.every((part) => !isBroadTerm(part))
      && andMatchesOnce(group, title, abstract)
  })
}

// True when this paper belongs on the topic's preview line and in the pool that is scored
// before digest triage. Title and abstract only — a MeSH, author, or publication-type tag
// is not searched again in the prose.
export function fitsTopic({ title = '', abstract = '', query = '', label = '' } = {}) {
  const raw = typeof query === 'string' ? query.trim() : ''
  if (!raw) return false
  if (hasUnsupportedSyntax(raw)) return true
  if (crossSpecialtyVeto({ title, abstract, query, label })) return false
  const result = evalExpr(tokenize(raw), title, abstract)
  if (result.keeps) return true
  if (!titleCarriesLabel(title, label)) return false
  return labelRescue(tokenize(raw), title, abstract)
}
