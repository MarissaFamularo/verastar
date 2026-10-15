// No raw error text, account identifier, email, NPI, paper, or event payload enters mail.
export function incidentEmail(event) {
  if (!['signup', 'digest', 'heartbeat', 'schedule'].includes(event?.check) || !['incident', 'recovery'].includes(event?.kind)) throw new Error('Invalid alert')
  const observed = typeof event.observed_at === 'string' ? new Date(event.observed_at) : null
  if (!observed || !Number.isFinite(observed.getTime())) throw new Error('Invalid observation time')
  const label = event.kind === 'incident' ? 'Needs attention' : 'Recovered'
  return { subject: `Verastar: ${event.check} — ${label}`, text: `Status: ${event.check} — ${label}\nTime: ${observed.toISOString()}\nDashboard: https://verastar.papertrellis.com/` }
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

export function monitorAuthorized(headers, serviceKey, cronSecret) {
  return Boolean((serviceKey && headers.get('authorization') === `Bearer ${serviceKey}`) ||
    (cronSecret && headers.get('x-cron-secret') === cronSecret))
}
export async function runDeliveryTest({ rpc, sendMail }) {
  const {data: observedAt,error} = await rpc('beta_alert_test_claim')
  if (error) return {ok:false,stage:'test-claim'}
  if (!observedAt) return {ok:true,delivery:'test-already-attempted'}
  const subject='Verastar: alert delivery test'
  const text=`Status: Alert delivery test\nTime: ${new Date(observedAt).toISOString()}\nDashboard: https://verastar.papertrellis.com/`
  let sent=false
  try { await sendMail({subject,text,id:'beta-alert-setup-test-20261015'}); sent=true } catch { /* never expose SMTP errors */ }
  const saved=await rpc('beta_alert_test_finish',{p_sent:sent})
  return {ok:sent&&!saved.error,delivery:saved.error?'uncertain':sent?'sent':'failed',subject,observed_at:observedAt}
}
