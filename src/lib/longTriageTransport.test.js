// Long-triage transport (docs/LONG_TRIAGE_TRANSPORT_DESIGN.md): DESIGN STAGE. The fake SSE
// provider is verified against the real SDK's own stream accumulator now, so the planned
// tests (it.todo below) start from a faithful fixture. Nothing here enables streaming.
import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { sseResponse } from './sseFakeProvider.js'
import { checkPaidRequest } from '../../supabase/functions/_shared/requestPolicy.js'

const client = (respond) => new Anthropic({ apiKey: 'test', maxRetries: 0, timeout: 600_000, fetch: async (_u, init) => respond(JSON.parse(init.body)) })

describe('fake SSE provider fidelity (against the real SDK stream accumulator)', () => {
  it('the SDK rebuilds the message, text and cumulative usage from the fake stream', async () => {
    let seen
    const c = client((body) => { seen = body; return sseResponse({ text: '{"rankings":[{"id":"x"}]}', chunks: 4 }) })
    const msg = await c.messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 32000, messages: [{ role: 'user', content: 'rank' }] }).finalMessage()
    expect(seen.stream).toBe(true)
    expect(msg.content[0].text).toBe('{"rankings":[{"id":"x"}]}')
    expect(msg.stop_reason).toBe('end_turn')
    expect(msg.usage).toMatchObject({ input_tokens: 2000, output_tokens: 300 })
  })
  it('a mid-stream error event surfaces as an SDK error (the boundary will treat it as ambiguous)', async () => {
    const c = client(() => sseResponse({ errorAfterBlock: true }))
    await expect(c.messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 32000, messages: [{ role: 'user', content: 'rank' }] }).finalMessage()).rejects.toThrow()
  })
  it('a final message_delta without usage (a shape the streaming docs show) breaks the SDK accumulator: ours must treat it as ambiguous, not crash', async () => {
    const c = client(() => sseResponse({ omitFinalUsage: true }))
    await expect(c.messages.stream({ model: 'claude-sonnet-5-5', max_tokens: 32000, messages: [{ role: 'user', content: 'rank' }] }).finalMessage()).rejects.toThrow(/output_tokens/)
  })
  it('callers still cannot request streaming through the policy', () => {
    expect(checkPaidRequest({ model: 'claude-sonnet-5-5', max_tokens: 32000, stream: true, messages: [{ role: 'user', content: 'x' }] }).ok).toBe(false)
  })
})

describe('long-triage transport (planned; see the design doc §5)', () => {
  it.todo('accumulator rebuilds the same Message as the SDK from the same fake stream')
  it.todo('usage merge: input from message_start, cumulative output from the last usage-bearing message_delta; none => ambiguous')
  it.todo('one reservation, one exact settlement; provider body = checked body + stream:true; fingerprint unchanged')
  it.todo('mid-stream error, dropped connection, idle gap, max cap => ambiguous, full liability, x-should-retry:false')
  it.todo('proxy early-200 + whitespace keepalive + final JSON parses identically in the real non-streaming SDK')
  it.todo('in-body error envelope => typed APIError with original status, no SDK retry; 402 => CapReachedError')
  it.todo('browser exposed-header filter: long path dispatches exactly once')
  it.todo('scheduler heartbeat renews the lease mid-stream; claim loss aborts the provider stream, ambiguous, run halts')
  it.todo('ranking applied to the digest is identical for short (non-streaming) and long (streaming) fake answers, 30 and 60 candidates')
  it.todo('long_transport_enabled off => proxy refuses long requests with 402 long_request_unavailable, no reservation')
})
