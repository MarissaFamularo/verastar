// Test helper (never imported by app code): a fake Anthropic provider that answers with a
// server-sent-event stream shaped like the documented Messages streaming format
// (https://platform.claude.com/docs/en/build-with-claude/streaming): message_start with
// input-side usage, content blocks, message_delta with CUMULATIVE usage, message_stop, and
// optional pings, a mid-stream error event, or a final message_delta with no usage.
// Prepared for the long-triage transport design (docs/LONG_TRIAGE_TRANSPORT_DESIGN.md).

export function sseEvents({
  id = 'msg_sse_fake', model = 'claude-sonnet-5-5', text = '{"rankings":[]}', chunks = 3,
  startUsage = { input_tokens: 2000, output_tokens: 1 }, finalUsage = { output_tokens: 300 },
  pings = 1, errorAfterBlock = false, omitFinalUsage = false, stopReason = 'end_turn',
} = {}) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const out = [ev('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: startUsage } })]
  for (let i = 0; i < pings; i++) out.push(ev('ping', {}))
  out.push(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
  const size = Math.ceil(text.length / chunks)
  for (let i = 0; i < text.length; i += size) out.push(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } }))
  if (errorAfterBlock) {
    out.push(ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }))
    return out
  }
  out.push(ev('content_block_stop', { index: 0 }))
  out.push(ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, ...(omitFinalUsage ? {} : { usage: finalUsage }) }))
  out.push(ev('message_stop', {}))
  return out
}

export function sseResponse(options) {
  const events = sseEvents(options)
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(new TextEncoder().encode(e))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_sse_fake' } })
}
