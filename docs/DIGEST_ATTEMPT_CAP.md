# Finishing a digest after the daily attempt cap

Proposed code change only; not published or deployed.

On November 5, read-only production inspection confirmed two accounts at twelve
attempts with complete three- and six-paper read sets persisted in the `rank`
phase. Each had eleven earlier error attempts. Their successful reading tick used
attempt twelve and correctly handed ranking to a fresh tick, but the handler
checked the cap before reading the saved state and skipped them on every tick.
Their last completion/delivery remained on the previous day. PubMed had recovered;
seven digest emails were recorded in the preceding three hours at the inspection.

## Behavior

The normal twelve-attempt limit remains for new discovery and error retries. A
same-local-day scheduled reading/ranking handoff may use a completion allowance:

- The service-written `last_result` must report the same successful handoff phase.
- The saved record must be daily, scheduler-owned, started and attempted today,
  unfinished, undelivered today, with no spending-cap or unresolved-hold marker.
- Saved selections must be valid, unique, present in the candidate pool, and within
  the twenty-paper pilot ceiling. Ranking requires every selected paper processed.
- Every extra tick is still counted. At most twenty remaining paper-reading ticks
  plus two ranking passes are allowed beyond the normal cap: thirty-four total
  work attempts per account/local day. A non-progressing worker cannot loop forever.
- An error, hold, spending stop, or capped result ends eligibility for this
  allowance. It does not grant another search, restart a digest, or reset attempts.
- Re-read the cap, latest server result and record under the existing account claim
  before admitting the run, so a stale queue read cannot spend a later slot.

The twenty-paper bound and two ranking passes cover the existing runner's single
coverage-fallback pass. Tests tie the allowance to `PILOT_DIGEST_LIMIT`. Existing
per-tick budgets, queue fairness, provider reservations/timeouts, claim fencing,
spending holds and monetary limits still apply. The completion budget is deliberately
finite: a corrupt or repeatedly non-progressing record can still require review.

An account capped on search failures with yesterday's completed digest (including
the founder's observed state) stays capped. No live account repair is part of this
change. Stale, missing, future-dated or malformed records fail closed.

## Verification

Handler regressions reproduce the three- and six-paper cases, completion after a
handoff on attempt twelve, a failed continuation, fallback reading/ranking, the
absolute ceiling, post-claim changes, and two overlapping ticks competing for the
last slot. They also check spending holds, no repeat search and one email across
later ticks. The real headless runner separately proves the saved three- and
six-paper rank records finish with one ranking call and no new search/read.

Run `npm test`, `npm run lint`, `npm run build`,
`node scripts/check-spending-contract.mjs` and
`node scripts/check-netlify-headers.mjs`. The contract check includes the bounded
allowance and its recheck under the claim. No database definition changes are made.

## Proposed release

Publication, merge and deployment require approval for this new change. After
review and CI, merge and deploy `digest-run` with its current bundle, manifest and
existing import map. There is no migration or attempt-counter reset. The bundle
is unchanged because this edit is in the separately deployed handler.

Verify downloaded worker files, then observe normal scheduled ticks. Eligible
saved handoffs should rank and complete with attempts thirteen or later; each day
must still be delivered at most once. Do not manually trigger a digest for smoke
testing. If these records no longer meet the eligibility rules at release time,
report that state instead of changing their counters or delivery markers.

This deliberately authorizes a bounded amount of additional model work for an
already-started digest. It is not a blanket increase in new-search/error retries.
