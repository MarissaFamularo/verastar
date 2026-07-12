// pipeline/connect.js — Claude PROPOSES connections; the clinician disposes.
//
// The trust ethos of the verifier, carried into the graph: this call never asserts a link
// as fact. It looks at one paper and the clinician's existing stars (north stars + projects
// + already-saved papers) and SUGGESTS which ones it connects to, each with a one-line
// reason. Every suggestion lands on the map as a dashed, pulsing "maybe" the user confirms
// — nothing is drawn solid until they say so. A proposal is NOT a verify: it's cheap Sonnet,
// structured output, thinking disabled (a suggestion task, and adaptive thinking on Sonnet 5
// truncates structured JSON — same gotcha as triage/select/onboard).

import { extractStructured, MODELS } from '../lib/anthropic.js'

export const CONNECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['connections'],
  properties: {
    connections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['target_id', 'rationale'],
        properties: {
          target_id: { type: 'string' }, // must be one of the candidate ids given
          rationale: { type: 'string' }, // one short clause: why they connect
        },
      },
    },
  },
}

const SYSTEM = `You help a clinician-researcher grow a personal knowledge graph. You are given ONE new paper and a list of existing nodes in their graph — their north stars (recurring concepts), their active projects, and other papers they've saved. Propose which existing nodes this paper meaningfully connects to, and give a SHORT reason for each (one clause, plain language, e.g. "reports the amputation-free survival endpoint your Limb Preservation Program tracks").

Rules:
- Only propose connections you can justify from the paper's own content. This is a SUGGESTION the clinician will confirm or reject — never state it as established fact, and don't force links that aren't there.
- Prefer a few strong, non-obvious connections over many weak ones. Zero is a valid answer.
- target_id MUST be copied exactly from the candidate list. Never invent an id.
- Favor connections to projects and north stars; propose a paper↔paper link only when the two papers genuinely speak to each other.`

// Propose edges from a paper to existing graph nodes. `paper` = { title, finding, relevance,
// abstract? }. `candidates` = [{ id, kind, label }] (the anchors + other papers, NOT the
// subject itself). `subjectKind: 'project'` reframes the ask — the subject is one of the
// reader's own projects and the question is which saved topics/papers inform or advance it
// (how a project star earns its connections; a name-match alone can't bridge "Limb
// Preservation Program" ↔ "Diabetic Foot Wound Management").
// Returns [{ target_id, rationale }] filtered to real candidate ids.
export async function proposeConnections({ paper, candidates, subjectKind = 'paper', model = MODELS.triage, maxTokens = 2048 }) {
  if (!candidates?.length) return []

  const kindLabel = { northStar: 'north star', project: 'project', paper: 'saved paper' }
  const list = candidates
    .map((c) => `[${c.id}] (${kindLabel[c.kind] || c.kind}) ${c.label}`)
    .join('\n')

  const head =
    subjectKind === 'project'
      ? `ACTIVE PROJECT — one of the reader's own efforts. Propose which existing nodes meaningfully inform or advance THIS project.\nProject`
      : `NEW PAPER\nTitle`

  const content =
    `${head}: ${paper.title || '(untitled)'}\n` +
    (paper.finding ? `Finding: ${paper.finding}\n` : '') +
    (paper.relevance ? `Relevance: ${paper.relevance}\n` : '') +
    (paper.abstract ? `\nAbstract:\n${paper.abstract.slice(0, 2500)}\n` : '') +
    `\nEXISTING NODES (propose connections only to these ids):\n${list}`

  const result = await extractStructured({
    model,
    system: SYSTEM,
    content,
    schema: CONNECT_SCHEMA,
    maxTokens,
    thinking: { type: 'disabled' },
  })

  const valid = new Set(candidates.map((c) => c.id))
  return (result.connections || []).filter((c) => valid.has(c.target_id) && c.rationale?.trim())
}
