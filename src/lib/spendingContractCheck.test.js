// The offline drift check (scripts/check-spending-contract.mjs) passes on this tree. A stale
// bundle, a remote scheduler import, an unpriced default model, a second provider route, a
// proxy cache write or a client-callable spending function fails it.
import { it, expect } from 'vitest'
import { runChecks } from '../../scripts/check-spending-contract.mjs'

it('every spending/scheduler contract check passes', async () => {
  const failed = (await runChecks()).filter((r) => !r.ok)
  expect(failed).toEqual([])
}, 30_000)
