// A synthetic beta_admin_stats payload for tests. Every number is made up.
export const STATS = {
  range: { from: '2026-09-15T04:00:00+00:00', to: '2026-10-15T04:00:00+00:00' },
  generated_at: '2026-10-15T01:00:00+00:00',
  adoption: { signups: 24, active72: 17, returned: 12, eligible: 15, retained: 9, access_now: 24, coverage_since: '2026-09-01T00:00:00Z', complete72: true },
  spend: { today: 2.14, month: 34.82, completed: 96, outstanding: 0.32, released_unknown: 1, first_record: '2026-09-01T00:00:00Z' },
  health: { checks: ['signup','digest','heartbeat'].map(name => ({name, state:'unknown', checked_at:null})), alerts_enabled:false },
  users: { new_in_range: 2, total: 3, active: 2 },
  scheduled: { ticks: 9, manual_ticks: 1, users_any: 3, users_manual: 1, user_days: 5, generated: 2, empty: 1, failed: 1, unfinished: 1, failure_ticks: 3, retry_ticks: 2, summaries: 6 },
  browser: { runs: 3, users: 2, generated: 2, empty: 1, with_errors: 1, append_runs: 1, summaries: 3 },
  requesters: 2,
  opened: { events: 3, users: 2 },
  papers: { extractions: 3, unique_pmids: 2 },
  verifier: { available: false },
  survey: { completed: 1, skipped: 1, completed_all_time: 4, reason: { stay_current: 1 }, read_frequency: { weekly: 1 }, weekly_time: { '1_3h': 1 }, confidence: { 4: 1 } },
  earliest_retained: {
    sponsored_accounts: '2026-08-01T00:00:00+00:00',
    digest_scheduled_run: '2026-08-15T00:00:00+00:00',
    digest_run: '2026-08-15T00:00:00+00:00',
    digest_opened: null,
    evidence_cache_trusted: '2026-10-01T00:00:00+00:00',
    beta_survey_responses: '2026-10-10T00:00:00+00:00',
  },
}
