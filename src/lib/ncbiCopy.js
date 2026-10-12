// Settings copy. An unset NCBI key or email is optional, never an error: PubMed
// works without them, and a key only raises the request rate.

export function ncbiCredentialCopy(status = {}) {
  const key = status.keyActive
    ? `API key ${status.keyRemembered ? 'active · remembered' : 'active · this session'}`
    : 'API key not set · optional'
  const email = status.emailActive
    ? `Email ${status.emailRemembered ? 'active · remembered' : 'active · this session'}`
    : 'Email not set · optional'
  return { key, email }
}
