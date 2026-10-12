import { supabase, currentUser } from './supabase.js'
import { hasNpiMatch } from '../../supabase/functions/_shared/npiMatch.js'
export { hasNpiMatch }
export const NPI_MESSAGES = {
  invalid: 'Enter your first name, last name, and a valid 10-digit NPI number.',
  mismatch: 'The name does not match this NPI. Use your first and last name as listed in the NPI Registry.',
  not_found: 'No active individual NPI was found for that number. Check the number and try again.',
  unavailable: 'The NPI check is unavailable right now. Please try again shortly.',
  slow_down: 'Too many NPI checks. Please try again in an hour.',
  signin: 'Sign in again to check your NPI.',
}
let sessionMatch = null
export function currentNpiMatch() {
  const user = currentUser()
  if (sessionMatch?.userId === user?.id && user?.id) return sessionMatch.match
  return hasNpiMatch(user) ? user.app_metadata.npi_match : null
}
export async function matchNpi(input) {
  if (!supabase) throw new Error(NPI_MESSAGES.unavailable)
  const initiatingUserId = currentUser()?.id
  const { data } = await supabase.auth.getSession()
  if (!initiatingUserId || data?.session?.user?.id !== initiatingUserId) throw new Error(NPI_MESSAGES.signin)
  if (!data?.session?.access_token) throw new Error(NPI_MESSAGES.signin)
  let response, result
  try {
    response = await fetch(`${String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, '')}/functions/v1/match-npi`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    result = await response.json()
  } catch { throw new Error(NPI_MESSAGES.unavailable) }
  if (!response.ok || result?.status !== 'matched' || !hasNpiMatch({ app_metadata: { npi_match: result.match } })) {
    throw new Error(NPI_MESSAGES[result?.status] || NPI_MESSAGES.unavailable)
  }
  if (currentUser()?.id !== initiatingUserId) throw new Error(NPI_MESSAGES.signin)
  sessionMatch = { userId: initiatingUserId, match: result.match }
  return result.match
}
