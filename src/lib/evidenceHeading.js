// Header counts name verified and withheld rows separately. A verified total must
// not sit above "Claim withheld" rows as if those rows had passed.

export function evidenceHeading({ verifiedCount = 0, withheldCount = 0, focused = false, summaryCount = 0 } = {}) {
  if (focused) {
    const noun = summaryCount === 1 ? 'NUMBER' : 'NUMBERS'
    const base = `EVIDENCE · ${summaryCount} ${noun} IN THE SUMMARY, VERIFIED`
    return withheldCount > 0 ? `${base} · ${withheldCount} withheld` : base
  }
  return withheldCount > 0
    ? `EVIDENCE · ${verifiedCount} verified · ${withheldCount} withheld`
    : `EVIDENCE · ${verifiedCount} verified`
}
