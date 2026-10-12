// Deno-runtime proof that the GENERATED scheduler bundle keeps overlapping accounts apart
// when bound through AsyncLocalStorage, exactly as digest-run/index.ts does.
//   cd supabase/functions && deno test --no-lock --allow-net=127.0.0.1 --config deno.json tests/
import { AsyncLocalStorage } from 'node:async_hooks'
import * as app from '../digest-run/app.bundle.js'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const scopes = new AsyncLocalStorage()
app.installServerScope(() => scopes.getStore() ?? null)

function recordingStore(owner: string, seen: string[]) {
  return {
    get: async (collection: string, key: string) => {
      await sleep(Math.random() * 15)
      seen.push(`${owner}:${collection}/${key}`)
      return collection === 'profile' && key === 'me' ? { onboarded: false, owner } : undefined
    },
    put: async () => { throw new Error('not expected') },
    all: async () => [],
    delete: async () => {},
    clear: async () => {},
  }
}

Deno.test('the bundled runner reads only its own account under interleaving', async () => {
  const seen: Record<string, string[]> = { A: [], B: [], C: [] }
  const run = (u: string) => scopes.run({ userId: u, store: recordingStore(u, seen[u]), client: null, cache: null }, () => app.runDailyDigest({ budgetMs: 1000 }))
  const out = await Promise.all([run('A'), run('B'), run('C'), run('A')])
  for (const r of out) assert(r.phase === 'empty', `unexpected phase ${r.phase}`)
  for (const u of Object.keys(seen)) {
    assert(seen[u].length > 0, `${u} saw no reads`)
    assert(seen[u].every((s) => s.startsWith(`${u}:`)), `${u} store saw another account: ${seen[u]}`)
  }
})

Deno.test('outside a scope the bundled runner refuses', async () => {
  let error = ''
  try { await app.runDailyDigest({ budgetMs: 1000 }) } catch (e) { error = (e as Error).message }
  assert(/outside an account scope/.test(error), `expected a refusal, got "${error}"`)
})

Deno.test('the scope survives timers, microtasks, and real network I/O', async () => {
  const server = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen() {} }, async () => { await sleep(5); return new Response('ok') })
  const url = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/`
  try {
    const probe = (u: string) => scopes.run({ userId: u }, async () => {
      const ids: unknown[] = []
      await sleep(Math.random() * 10)
      ids.push((scopes.getStore() as { userId: string }).userId)
      await new Promise<void>((r) => queueMicrotask(r))
      ids.push((scopes.getStore() as { userId: string }).userId)
      await (await fetch(url)).text()
      ids.push((scopes.getStore() as { userId: string }).userId)
      await new Promise((r) => setTimeout(r, Math.random() * 10))
      ids.push((scopes.getStore() as { userId: string }).userId)
      return ids
    })
    const results = await Promise.all(['A', 'B', 'C', 'D'].map(probe))
    results.forEach((ids, i) => assert(ids.every((x) => x === 'ABCD'[i]), `scope lost: ${ids}`))
  } finally {
    await server.shutdown()
  }
})
