// Synthetic, network-free fixture for a scheduled digest tick that makes real paid-path
// attempts. Shared by the Deno test on the generated bundle
// (supabase/functions/tests/scheduled_rank_test.ts) and the Docker local-stack test
// (scripts/local-stack-spending-test.mjs).
//
// The seeded `daily:latest` record is a scheduler run already past search and reading
// (server.phase 'rank'), so the bundled runDailyDigest goes straight to ranking:
//   1. triage   (claude-sonnet-5-5, structured)  -> one paid attempt
//   2. checkFindings on the returned finding (claude-haiku-4-5-20251001) -> one paid attempt
// then persists the finished digest and the seen ledger through the claim-fenced store.
// Nothing fetches PubMed, PMC or CT.gov: the rank phase reads only the store and the model.
// All data is invented; no PHI, no real paper.

export const PAPER_ID = 'synthetic-101'

export function profileFixture() {
  return {
    onboarded: true,
    northStars: ['Synthetic north star'],
    rubric: { criteria: 'Synthetic rubric for a test run.', selectCount: 5, scoreFloor: 0 },
  }
}

export function rankPhaseDigest(now = new Date()) {
  const paper = { id: PAPER_ID, pmid: PAPER_ID, title: 'Synthetic trial of a placeholder intervention', topics: ['Synthetic topic'] }
  const processed = {
    paper,
    citation: { pmid: PAPER_ID, title: paper.title },
    design: 'RCT',
    source: { tier: 'abstract_only', hasBody: false, hash: 'a'.repeat(64) },
    // Explicit Results keeps this two-call accounting fixture auditable under window v4.
    sourceDoc: { text: 'RESULTS: In this synthetic trial the placeholder intervention was associated with fewer events than control.', tables: '' },
    rows: [],
  }
  return {
    kind: 'daily',
    savedAt: now.toISOString(),
    ranAt: now.toISOString(),
    runBy: 'scheduler',
    server: { phase: 'rank', startedAt: now.toISOString() },
    results: [processed],
    processedResults: [processed],
    triaged: {},
    candidates: [{ ...paper, score: 90, selectionRole: 'score' }],
    preCapCandidates: [],
    searchContext: { counts: [{ label: 'Synthetic topic', found: 1, kept: 1 }], failed: [], days: 3 },
    selectedIds: [PAPER_ID],
    openedAt: null,
  }
}

// Fixed usage per call, and the exact micro-dollar settlement each implies:
//   triage (Sonnet 5.5): 2,000 x $2 + 300 x $10 per MTok = 7,000 micro-dollars
//   check  (Haiku 4.5):    500 x $1 +  50 x $5  per MTok =   750 micro-dollars
export const EXPECTED = {
  triage: { model: 'claude-sonnet-5-5', usage: { input_tokens: 2000, output_tokens: 300 }, micro: 7000 },
  check: { model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 500, output_tokens: 50 }, micro: 750 },
}

// The fake provider's reply for one Messages request body. Returns { status, body }.
export function fakeProviderReply(request, n = 1) {
  const schema = request?.output_config?.format?.schema?.properties || {}
  if (schema.rankings) {
    return ok(request, n, EXPECTED.triage.usage, {
      rankings: [{
        id: PAPER_ID, score: 90, tier: 1,
        finding: 'The placeholder intervention was associated with fewer events than control.',
        finding_plain: 'The placeholder intervention was associated with fewer events than control.',
        design_caution: '',
        relevance: 'touches the synthetic north star',
      }],
    })
  }
  if (schema.verdicts) {
    return ok(request, n, EXPECTED.check.usage, { verdicts: [{ id: PAPER_ID, supported: true, reason: 'matches the snippet' }] })
  }
  return { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'fixture: unexpected request' } } }
}

function ok(request, n, usage, payload) {
  return {
    status: 200,
    body: {
      id: `msg_fixture_${n}`, type: 'message', role: 'assistant', model: request.model,
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      stop_reason: 'end_turn', stop_sequence: null, usage,
    },
  }
}
