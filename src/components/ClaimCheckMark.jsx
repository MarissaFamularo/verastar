import { claimCheckLabel } from '../lib/claimCheck.js'

// The label after a digest sentence: what judged the CLAIM, in words that never say
// "verified" or "grounded" — those belong to numbers the verifier matched.
export function ClaimCheckMark({ check, size = 12 }) {
  const label = claimCheckLabel(check)
  if (!label) return null
  return (
    <span title={label.title} className="whitespace-nowrap" style={{ fontSize: size, color: 'var(--color-verified-soft)', opacity: 0.9 }}>
      {label.text}
    </span>
  )
}
