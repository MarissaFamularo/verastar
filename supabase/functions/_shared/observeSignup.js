// Failure of monitoring must never change an enrollment response. Only status + fixed
// codes are recorded, using the service-owned monitor ledger, never client telemetry.
export async function observeSignup(admin, status) {
  try {
    await admin.rpc('beta_monitor_record', { p_check: 'signup', p_ok: status < 500, p_code: status < 500 ? 'ok' : 'failed' })
  } catch { /* no successful observation is fabricated */ }
}

export async function observeDigest(admin, { finished, failed }) {
  if (!finished && !failed) return
  try { await admin.rpc('beta_monitor_record', { p_check: 'digest', p_ok: finished && !failed, p_code: finished && !failed ? 'ok' : 'failed' }) } catch { /* unavailable monitoring stays unknown */ }
}
