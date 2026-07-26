// pipeline/interview.js — the onboarding INTERVIEW: a conversation that ends in a search plan.
//
// The three-question intake (onboard.js) drafts north stars and a rubric paragraph and stops
// there. Nothing in it produces PubMed QUERIES, so the scan fell back to searching the north
// star phrases themselves — and "AI in medicine" as a search term is how neurointervention
// papers landed in a vascular-surgery digest on a real run. The queries are the part of the
// profile the digest actually depends on, and they were the part nobody was asked about.
//
// So this file ports the interview from her own published prompt (StatUp Module 2,
// briefing-prompt.md, "Phase 1 — Interview me"). Its rules are load-bearing, not stylistic:
//
//   "Ask focused questions until you understand the answers below. Don't ask all at once —
//    start broad, adapt to my answers. If I'm vague, propose 2–3 concrete options. Cap at
//    ~6 turns." … "Don't ask me to fill out a giant form. Talk to me."
//
// One question per turn, each turn a cheap structured call that sees the whole transcript;
// then ONE extraction call turns the conversation into a profile she reviews and edits. The
// temptation is to collapse this into a six-field form — that is explicitly the thing her
// prompt forbids, and a form is also why the old intake never got the queries: nobody types
// ten boolean strings into a signup screen.
//
// Everything here is pure except the two functions that make the call (nextQuestion,
// draftProfileFromInterview), which are thin wrappers over extractStructured.

import { extractStructured, MODELS } from '../lib/anthropic.js'
import { normalizeTopics } from './topics.js'
import { DEFAULT_RUBRIC, DEFAULT_SELECT_COUNT, DEFAULT_SCORE_FLOOR } from './onboard.js'

// Her cap, kept as her cap. Six exchanges is roughly two minutes of typing, and past that
// the marginal answer stops improving the queries and starts costing her the setup.
export const MAX_TURNS = 6

// Below this the transcript is too thin to draft a ten-topic search plan from — one line
// about a specialty produces generic queries, which is the failure this whole file exists to
// prevent. It is a floor on the BUTTON, not a wall: she can always skip a question.
export const MIN_ANSWERED = 2

// The topic-count band, straight from her prompt: "Aim for 6–12 queries, each narrow enough
// to be useful … Not 'vascular surgery' alone — too noisy."
export const MIN_TOPICS = 6
export const MAX_TOPICS = 12

// Turn one is asked WITHOUT a model call. It's the same question every time, so paying for
// it would be paying to regenerate a constant — and it means the interview opens instantly
// even on a cold key.
export const OPENING_QUESTION =
  "What's your specialty or sub-specialty, and how should the digest address you?"

// The script for the free paths: ?firstrun=1 preview (no key, no spend) and any turn where
// the model call fails. A failed turn must not dead-end the only route into the app, and
// falling back to a fixed question is strictly better than an error screen — these six ARE
// the interview her prompt specifies, just without the adaptation.
export const FALLBACK_QUESTIONS = [
  OPENING_QUESTION,
  'Which areas should I search every morning? Name the sub-areas you would notice missing — each one becomes its own PubMed search, so "aortic disease" and "carotid" are separate, not one "vascular surgery".',
  'Which journals are must-not-miss for you — the ones where a paper should reach you even if the topic is marginal?',
  "Which study designs do you weight up, and what's your “I'd discuss this at conference” bar? An example of a paper that cleared it helps more than a rule.",
  'Should LLM / genAI-in-medicine papers be in scope? If yes, what clears the bar — most of that literature is noise.',
  'What should never reach your morning? Case reports, narrative reviews, letters and editorials outside the top journals, single-centre retrospectives with no new method, "we asked ChatGPT" papers — tell me which of those you would actually want kept.',
]

// What the interview has to come away with. Order is the order to ask in; the model may
// merge or reorder as the conversation warrants, which is the whole point of adapting.
const CHECKLIST = `1. Specialty / sub-specialty and research focus, and how to address them.
2. The 6–12 areas to search daily, each narrow enough to be useful. "Vascular surgery" alone is too noisy. This is the most important answer in the interview — if they name only two or three, ask what else they would notice missing.
3. Tier-1 / must-not-miss journals.
4. Study designs they weight up.
5. Their "would discuss this at conference / would change my practice" bar, ideally with an example.
6. Whether LLM / genAI-in-medicine papers are in scope, and at what quality bar.
7. Hard exclusions — what should never reach their morning.`

export const INTERVIEW_SYSTEM = `You are interviewing a busy clinician-researcher to set up their personalized morning literature digest. You will ask ONE question at a time.

Everything you need to learn, in rough priority order:
${CHECKLIST}

How to interview:
- ONE focused question per turn. Never a numbered list of questions, never a form.
- Start broad, then adapt to what they actually said. Follow the thread that matters — if their answer to the topics question is thin, dig there rather than moving on.
- If they are vague, propose 2–3 CONCRETE options they can pick from or correct. "What do you read?" is a bad question; "Should I treat aortic and carotid as separate searches, or one vascular search?" is a good one.
- Cover several checklist items in one question when they clearly go together (designs + the conference bar; LLM scope + exclusions). You have at most ${MAX_TURNS} turns, so budget them.
- Speak in plain sentences, second person, no bullet lists, no markdown, at most ~45 words. One short acknowledgement of what they just told you, then the question.
- Do NOT ask them to write PubMed queries or boolean search strings. Writing those is your job afterwards — ask about the CONCEPTS.
- Do NOT ask how many papers a day they want, and do not ask about scheduling, file paths, or anything about how the app works.

Set done=true when you have enough to draft a real search plan and rubric, or when the remaining gaps are not worth another turn. When done=true the question field is ignored, so leave it empty.

Return: ack (one short sentence reacting to their last answer, or empty on the first turn), question (the single next question, no ack repeated inside it), done (boolean).`

// Strict-schema per the output_config contract: additionalProperties:false + required on
// every object, no min/max/minLength.
export const INTERVIEW_TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ack', 'question', 'done'],
  properties: {
    ack: { type: 'string' },
    question: { type: 'string' },
    done: { type: 'boolean' },
  },
}

export const PROFILE_INTERVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'northStars', 'projects', 'topics', 'rubric'],
  properties: {
    name: { type: 'string' },
    northStars: { type: 'array', items: { type: 'string' } },
    projects: { type: 'array', items: { type: 'string' } },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'query'],
        properties: {
          label: { type: 'string' }, // what she reads in the digest, e.g. "Aortic Disease"
          query: { type: 'string' }, // what PubMed runs, e.g. "aortic aneurysm OR TEVAR"
        },
      },
    },
    rubric: { type: 'string' },
  },
}

// The query-writing rules are HERS, quoted from the header of her production queries.json,
// with her real queries as the worked examples. This prompt is the only place in the app
// that writes a PubMed query from scratch, so the failure mode it has to avoid is the one
// she documented: an over-specified query that MeSH expansion turns into zero results.
export const DRAFT_SYSTEM = `You are turning an interview with a clinician-researcher into the steering profile for their morning literature digest. Return JSON only.

- name: how the digest should address them (e.g. "Dr. Famularo"). If they never said, use "Doctor".
- northStars: 3–6 SHORT concept phrases (2–4 words) naming what they steer by, e.g. "CLTI outcomes", "carotid revascularization". These feed the rubric's relevance line, NOT the search.
- projects: 1–4 short names of the concrete efforts they are driving (programs, studies, initiatives). Empty array if none were mentioned.
- topics: ${MIN_TOPICS}–${MAX_TOPICS} rows, each { label, query }. This is the search plan and it is the most important field. One row per area they want watched — a busy area and a quiet one must never share a row, because each row gets its own PubMed search and its own cap.
- rubric: 3–6 sentences of first-person steering prose ("Prioritize…", "Rank lower…", "Skip…") drawn from what they told you about tier-1 journals, study designs, their conference bar, whether LLM papers are in scope, and their hard exclusions. Name their journals and their exclusions explicitly. No output-format rules, no numbers-handling instructions, no invented preferences.

How to write the query field — these rules come from the user's own working system, and breaking them returns zero papers:
- Use simple OR-based queries. Complex AND chains expand to zero results due to MeSH expansion.
- No field tags. Never write [tiab], [ti], [mh], [Title/Abstract] or any bracketed tag, and do not wrap phrases in quotes. PubMed's automatic term mapping is doing the work; quoting and tagging turn it off.
- JOIN CONCEPTS WITH OR, explicitly. Words sitting next to each other are ANDed by PubMed, so a string of four or five juxtaposed concepts is an AND chain wearing a disguise and it returns almost nothing over a three-day window.
- Two to five anchor concepts per query. Never a single bare word.
- Good: "aortic aneurysm OR aortic dissection OR TEVAR OR EVAR" · "peripheral artery disease OR limb ischemia OR diabetic foot OR wound healing amputation" · "carotid stenosis OR carotid endarterectomy OR carotid artery stenting" · "large language model healthcare clinical OR ChatGPT clinical OR GPT-4 medical"
- Bad: "aortic aneurysm[tiab] AND (TEVAR OR EVAR) AND mortality" (AND chain plus field tag) · "carotid stenosis endarterectomy stenting stroke prevention" (five juxtaposed concepts, all ANDed — nearly empty) · "carotid" (too broad to be a topic)
- Include the abbreviations and synonyms a surgeon would use, since those are how half the titles are written.

Label each row the way they would say it out loud. Draft confidently from what they gave you — this is a starting point they will edit before anything is saved.`

function str(value) {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : ''
}

// --- transcript ---------------------------------------------------------------
//
// A transcript is [{ question, answer }] in the order asked. The last entry may be
// unanswered (that's the question currently on screen).

// Turns she actually put words into. A skipped question is kept in the transcript (the model
// should see that it asked and got nothing rather than asking again) but it doesn't count
// toward having enough to draft from.
export function answeredTurns(transcript) {
  return (Array.isArray(transcript) ? transcript : []).filter((t) => str(t?.answer)).length
}

// Enough conversation to be worth a drafting call.
export function canDraft(transcript) {
  return answeredTurns(transcript) >= MIN_ANSWERED
}

// Out of turns. The cap is on questions ASKED, so a transcript of 6 asked questions ends the
// interview whether or not she answered the last one.
export function outOfTurns(transcript) {
  return (Array.isArray(transcript) ? transcript : []).length >= MAX_TURNS
}

// The transcript as the plain Q/A text both calls read. Unanswered and skipped turns are
// marked rather than dropped: "(skipped)" is information — it means don't ask that again.
export function transcriptText(transcript) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((t) => `Q: ${str(t?.question)}\nA: ${str(t?.answer) || '(skipped)'}`)
    .join('\n\n')
}

// The next scripted question — the free path. Skips anything already asked so a mixed
// transcript (model questions, then a failed call) doesn't repeat itself.
export function fallbackQuestion(transcript) {
  const asked = new Set((Array.isArray(transcript) ? transcript : []).map((t) => str(t?.question)))
  return FALLBACK_QUESTIONS.find((q) => !asked.has(q)) || ''
}

// One interview turn. Returns { ack, question, done } — done means "stop asking, go draft".
// Any failure (bad key, rate limit, malformed JSON) degrades to the scripted question rather
// than throwing: a broken turn must never be a dead end in the only path into the app.
export async function nextQuestion({ transcript = [], model = MODELS.triage, maxTokens = 512 } = {}) {
  if (!transcript.length) return { ack: '', question: OPENING_QUESTION, done: false }
  if (outOfTurns(transcript)) return { ack: '', question: '', done: true }
  const content = `The interview so far (${transcript.length} of ${MAX_TURNS} turns used):\n\n${transcriptText(transcript)}`
  let turn
  try {
    turn = await extractStructured({
      model,
      system: INTERVIEW_SYSTEM,
      content,
      schema: INTERVIEW_TURN_SCHEMA,
      maxTokens,
      // Disabled deliberately: adaptive thinking on Sonnet 5 truncates structured JSON
      // (handoff gotcha), and picking the next question is not a reasoning task.
      thinking: { type: 'disabled' },
    })
  } catch {
    const question = fallbackQuestion(transcript)
    return { ack: '', question, done: !question, fallback: true }
  }
  const question = str(turn?.question)
  const done = turn?.done === true || !question
  return { ack: str(turn?.ack), question: done ? '' : question, done }
}

// --- the draft ----------------------------------------------------------------

// The model's raw output -> the profile shape, defensively. Never throws: a malformed draft
// degrades to an editable near-empty review screen, which she can fix, instead of taking
// down onboarding. Topic rows go through normalizeTopics (dedupe, half-rows, legacy keys) so
// the interview and the paste box land in exactly the same shape.
export function normalizeInterviewDraft(
  raw,
  { selectCount = DEFAULT_SELECT_COUNT, scoreFloor = DEFAULT_SCORE_FLOOR } = {},
) {
  const draft = raw && typeof raw === 'object' ? raw : {}
  const strings = (list) =>
    (Array.isArray(list) ? list : []).map(str).filter(Boolean)
  return {
    name: str(draft.name) || 'Doctor',
    northStars: strings(draft.northStars),
    projects: strings(draft.projects),
    topics: normalizeTopics(draft.topics),
    rubric: {
      criteria: str(draft.rubric) || DEFAULT_RUBRIC,
      // NOT drafted by the model. selectCount and the score floor are calibrations she tunes
      // once she has seen a few mornings of scores; on a re-run they arrive from her existing
      // profile, so re-interviewing never silently resets a number she chose.
      selectCount: selectCount,
      scoreFloor: scoreFloor,
    },
  }
}

// The one drafting call: whole transcript in, profile draft out.
export async function draftProfileFromInterview({
  transcript = [],
  model = MODELS.triage,
  maxTokens = 4096,
  selectCount,
  scoreFloor,
} = {}) {
  const raw = await extractStructured({
    model,
    system: DRAFT_SYSTEM,
    content: `Interview transcript:\n\n${transcriptText(transcript)}`,
    schema: PROFILE_INTERVIEW_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })
  return normalizeInterviewDraft(raw, { selectCount, scoreFloor })
}

// --- query-quality validator --------------------------------------------------
//
// The guard against the documented failure: a query that looks rigorous and returns zero.
// It runs on the model's draft BEFORE anything is saved and its flags render next to the
// offending row, because the only person who can fix a bad query is her, and the only moment
// she'll look is the review screen. Pure, so it's cheap to test every rule.

const FIELD_TAG = /\[[^\]]*\]/
const AND_OPERATOR = /\bAND\b/g

// PubMed ANDs words that just sit next to each other, so a long run of juxtaposed concepts
// inside one OR-alternate is an AND chain in disguise. Measured against PubMed (30-day edat,
// 2026-07-26): her real row "carotid stenosis endarterectomy stenting stroke prevention"
// returned 2 results where the OR-joined equivalent returned 128. The threshold is 5 because
// a legitimate single concept can run 4 words ("chronic limb threatening ischemia") and this
// flag must not cry wolf on those.
const JUXTAPOSED_WORDS = 5
const BOOLEAN_WORD = /^(AND|OR|NOT)$/i

// Longest run of concept words in any OR-alternate. Boolean operators (either case — a
// lowercase "and" is a PubMed stopword, not a concept) don't count as words.
function longestJuxtaposition(q) {
  return Math.max(
    ...q.split(/\bOR\b/).map((seg) => seg.split(/\s+/).filter((w) => w && !BOOLEAN_WORD.test(w)).length),
  )
}

// One query -> the things wrong with it, worst first. Empty array means it looks fine.
export function topicIssues(query) {
  const q = str(query)
  const issues = []
  if (!q) {
    issues.push({ code: 'empty', message: 'No query — this topic would search nothing.' })
    return issues
  }
  const ands = (q.match(AND_OPERATOR) || []).length
  if (ands >= 2) {
    issues.push({
      code: 'and-chain',
      message: `Long AND chain (${ands} ANDs) — MeSH expansion turns these into zero results. Use OR instead.`,
    })
  }
  const run = longestJuxtaposition(q)
  if (run >= JUXTAPOSED_WORDS) {
    issues.push({
      code: 'juxtaposed',
      message: `${run} words with no OR between them — PubMed ANDs juxtaposed words, so this is an AND chain in disguise and returns almost nothing on a short window. Join the distinct concepts with OR.`,
    })
  }
  if (FIELD_TAG.test(q)) {
    issues.push({
      code: 'field-tag',
      message: 'Field tag like [tiab] switches off PubMed term mapping — drop the brackets.',
    })
  }
  if (!/\s/.test(q)) {
    issues.push({
      code: 'bare-word',
      message: 'A single bare word is too broad to be a topic — add two or three OR-ed concepts.',
    })
  }
  return issues
}

// The whole search plan -> { ok, rows, list, count }.
//   rows  — one entry per topic that has issues: { index, label, query, issues }
//   list  — issues with the plan as a whole (too few / too many / none at all)
//   count — total flags, for the "3 things to look at" line
// Advisory, never blocking: she can save over every one of these. Her queries are better
// than this validator's opinion of them, and a checker that refuses to save would be wrong
// about that more often than it would be right.
export function checkTopics(topics) {
  const rows = []
  const list = []
  const clean = Array.isArray(topics) ? topics : []
  clean.forEach((t, index) => {
    const issues = topicIssues(t?.query)
    if (issues.length) rows.push({ index, label: str(t?.label), query: str(t?.query), issues })
  })
  if (!clean.length) {
    list.push({ code: 'none', message: 'No topics — your digest would fall back to searching your north stars.' })
  } else if (clean.length < MIN_TOPICS) {
    list.push({
      code: 'too-few',
      message: `Only ${clean.length} topic${clean.length === 1 ? '' : 's'} — aim for ${MIN_TOPICS}–${MAX_TOPICS} so nothing you care about goes unsearched.`,
    })
  } else if (clean.length > MAX_TOPICS) {
    list.push({
      code: 'too-many',
      message: `${clean.length} topics — past ${MAX_TOPICS} the morning gets long and each search costs a call. Consider merging the close ones.`,
    })
  }
  const count = list.length + rows.reduce((n, r) => n + r.issues.length, 0)
  return { ok: count === 0, rows, list, count }
}

// --- saving without collateral damage -----------------------------------------

// The profile keys the interview owns. Anything else in a saved profile — her API-key
// preferences, the search window, the demo flag, fields a later version adds — is HERS and
// survives a re-interview untouched.
export const INTERVIEW_FIELDS = ['name', 'northStars', 'projects', 'topics', 'rubric', 'search']

// Merge a fresh draft into whatever profile already exists.
//
// This exists because re-running the interview is expected: she has a library and will want
// to rebuild the search plan against it. The write path is saveProfile() — ONE record in the
// `profile` collection — so `papers`, `graphNodes`, `graphEdges`, `digests` and `seen` are
// different collections and are not reachable from here. What this function guarantees on
// top of that is that the profile record itself is patched, not replaced: no store.clear(),
// no dropping of keys the interview doesn't know about, and rubric numbers she has tuned
// (selectCount, scoreFloor) survive a draft that omits them.
export function mergeInterviewProfile(existing, fields) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {}
  const patch = fields && typeof fields === 'object' ? fields : {}
  for (const key of INTERVIEW_FIELDS) {
    if (patch[key] === undefined) continue
    // The rubric is patched field-by-field so a draft carrying only `criteria` cannot reset
    // the two numbers she calibrated by hand.
    base[key] = key === 'rubric' ? { ...(base.rubric || {}), ...patch.rubric } : patch[key]
  }
  base.onboarded = true
  return base
}
