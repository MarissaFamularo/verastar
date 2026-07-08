// pipeline/onboard.js — the steering-profile drafter.
//
// The onboarding quiz asks a clinician a few free-text questions, then ONE structured
// Sonnet call drafts their steering profile: north stars, active projects, a digest
// rubric, and how many papers a day they want. The user reviews and edits before it's
// saved — this is a draft, not an oracle. A hardcoded fallback (Dr. Famularo, the real
// named user) lets the demo start from a truly empty app and seed a profile in one click.

import { extractStructured, MODELS } from '../lib/anthropic.js'

// The user-owned steering criteria feed triage (the reasoning channel). The app's
// integrity rules (the number-free two-channel contract, the output schema) live in
// triage.js and are NOT part of this editable rubric — only the priorities are.
export const DEFAULT_RUBRIC =
  `Prioritize papers that directly advance my north stars and active projects — practice-changing evidence in CLTI and limb preservation, carotid revascularization, and applied AI in clinical medicine.

Rank highest: well-powered randomized trials and meta-analyses of RCTs with a clear, practice-relevant outcome; studies reporting hard endpoints (amputation-free survival, stroke or death, hospital-free days) that touch one of my projects.

Rank lower: small single-arm or retrospective series, narrow subgroup analyses, and papers only tangentially related to my north stars.

Skip: purely preclinical or animal work, editorials without new data, and topics outside vascular surgery and clinical AI unless they directly inform a project.`

export const DEFAULT_SELECT_COUNT = 10

// The demo / skip fallback: the real named user's profile, seeded instantly so the app
// can go from empty to steered in one click on camera (BUILD_PLAN's from-empty demo path).
export const DEMO_PROFILE = {
  name: 'Dr. Famularo',
  northStars: ['CLTI outcomes', 'Carotid revascularization', 'AI in medicine'],
  projects: ['Limb Preservation Program', 'COSMOS utilization study'],
  rubric: { criteria: DEFAULT_RUBRIC, selectCount: DEFAULT_SELECT_COUNT },
  onboarded: true,
}

// Strict-schema per the output_config contract: additionalProperties:false + required on
// every object, no min/max/minLength. Arrays of plain strings for the chips.
export const PROFILE_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'northStars', 'projects', 'rubric', 'selectCount'],
  properties: {
    name: { type: 'string' }, // how the digest greets them, e.g. "Dr. Reyes"
    northStars: { type: 'array', items: { type: 'string' } },
    projects: { type: 'array', items: { type: 'string' } },
    rubric: { type: 'string' }, // the steering criteria prose (becomes rubric.criteria)
    selectCount: { type: 'integer' }, // papers per day to select
  },
}

const SYSTEM = `You are setting up a personalized morning literature digest for a busy clinician-researcher. From their short intake answers, draft a steering profile they will review and edit. Return:

- name: how the digest should address them (e.g. "Dr. Reyes"). If they don't give a name, use "Doctor".
- northStars: 3–6 SHORT concept phrases (2–4 words each) naming the recurring topics they steer by. These are used verbatim as PubMed title/abstract search terms, so make them clean, searchable clinical concepts (e.g. "carotid revascularization", "CLTI outcomes", "AI in medicine") — NOT full sentences, NOT boolean queries.
- projects: 1–4 short names of the concrete efforts they're driving (programs, studies, initiatives). If none are stated, return an empty array.
- rubric: a short prose steering doc (3–5 sentences) describing what makes a paper worth THEIR morning — what to prioritize, what to rank lower, what to skip. Ground it in their answers. Write it in first person ("Prioritize…", "Skip…") so it reads as their own instruction. Do NOT include any output-format rules or numbers-handling instructions — only their editorial priorities.
- selectCount: how many papers per day they want to see. Use their stated number; if none, use 10.

Draft confidently from whatever they gave you. It's a starting point they will refine.`

// Draft a steering profile from the intake answers. `answers` is a plain object of
// question -> free-text response. Returns { name, northStars, projects, rubric, selectCount }.
// One cheap structured call, thinking disabled (a drafting task, not a reasoning one —
// and adaptive thinking on Sonnet 5 truncates structured JSON; see the handoff gotcha).
export async function draftProfile({ answers, model = MODELS.interview, maxTokens = 2048 }) {
  const content =
    'Intake answers:\n\n' +
    Object.entries(answers)
      .map(([q, a]) => `Q: ${q}\nA: ${(a || '').trim() || '(no answer)'}`)
      .join('\n\n')

  const draft = await extractStructured({
    model,
    system: SYSTEM,
    content,
    schema: PROFILE_DRAFT_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })

  return {
    name: (draft.name || 'Doctor').trim(),
    northStars: (draft.northStars || []).map((s) => s.trim()).filter(Boolean),
    projects: (draft.projects || []).map((s) => s.trim()).filter(Boolean),
    rubric: {
      criteria: (draft.rubric || DEFAULT_RUBRIC).trim(),
      selectCount: Number(draft.selectCount) > 0 ? Math.round(draft.selectCount) : DEFAULT_SELECT_COUNT,
    },
  }
}
