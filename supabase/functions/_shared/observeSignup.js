// Failure of monitoring must never change an enrollment response. Only status + fixed
// codes are recorded, using the service-owned monitor ledger, never client telemetry.
export async function observeSignup(admin, status) {
  try {
    await admin.rpc('beta_monitor_record', { p_check: 'signup', p_ok: status < 500, p_code: status < 500 ? 'ok' : 'failed' })
  } catch { /* no successful observation is fabricated */ }
}

export async function observeDigest(admin, { userId, phase, searchComplete = false, recoveryEvidence = false, failed }) {
  if (!userId || (!failed && !searchComplete) || (!failed && phase !== 'done' && phase !== 'empty')) return
  const outcome = failed ? 'failed' : phase === 'done' && recoveryEvidence ? 'done' : 'empty'
  try { await admin.rpc('beta_digest_observe', { p_user_id: userId, p_outcome: outcome }) } catch { /* unavailable monitoring stays unknown */ }
}
