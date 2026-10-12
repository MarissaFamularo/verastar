// Reference trials stay off a clinician's own papers. They remain reachable on the
// sample profile, without model access, and whenever no digest is on screen —
// including after an error that left the morning empty.

export function sourceExamplesVisible({ demo = false, keySet = false, resultCount = 0 } = {}) {
  return Boolean(demo || !keySet || resultCount === 0)
}
