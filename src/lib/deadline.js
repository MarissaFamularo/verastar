// A stalled network call must not hold a screen forever. The underlying promise
// keeps running; callers decide whether a late result is still worth honoring.

export async function awaitWithin(promise, ms) {
  let timer
  const guarded = Promise.resolve(promise).then(
    (value) => ({ timeout: false, value }),
    (error) => ({ timeout: false, error }),
  )
  try {
    const result = await Promise.race([
      guarded,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timeout: true }), ms)
      }),
    ])
    if (result.timeout) return { timeout: true }
    if (result.error) throw result.error
    return { timeout: false, value: result.value }
  } finally {
    clearTimeout(timer)
  }
}
