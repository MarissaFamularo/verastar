// No raw error text, account identifier, email, NPI, paper, or event payload enters mail.
export function incidentEmail(event) {
  if (!['signup', 'digest', 'heartbeat'].includes(event?.check) || !['incident', 'recovery'].includes(event?.kind)) throw new Error('Invalid alert')
  const label = event.kind === 'incident' ? 'Needs attention' : 'Recovered'
  return { subject: `Verastar: ${event.check} — ${label}`, text: `${event.check}: ${label}. Open Beta admin for current monitored evidence. No participant data is included in this message.` }
}
export async function runMonitor({ rpc, sendMail, enabled = false }) {
  const tick = await rpc('beta_monitor_tick')
  if (tick.error) return { ok: false, stage: 'checks' }
  if (!enabled || !sendMail) return { ok: true, delivery: 'disabled' }
  const { data: event, error } = await rpc('beta_alert_claim')
  if (error) return { ok: false, stage: 'claim' }
  if (!event) return { ok: true, delivery: 'idle' }
  let sent = false
  try { await sendMail({ ...incidentEmail(event), id: event.id }); sent = true } catch { /* content intentionally discarded */ }
  const saved = await rpc('beta_alert_finish', { p_id: event.id, p_sent: sent })
  return { ok: sent && !saved.error, delivery: saved.error ? 'uncertain' : sent ? 'sent' : 'failed' }
}
