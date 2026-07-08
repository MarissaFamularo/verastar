import { useEffect, useState } from 'react'
import { setApiKey, hasApiKey, clearApiKey, ping } from './lib/anthropic.js'
import { getProfile } from './lib/store.js'
import NorthStars from './components/NorthStars.jsx'
import OnboardingQuiz from './components/OnboardingQuiz.jsx'
import SpineCheck from './components/SpineCheck.jsx'

// Day-0 scaffold surface: paste your Anthropic key (BYOK, sessionStorage-only) and prove
// the browser-direct round-trip works. Everything else hangs off this wiring.
export default function App() {
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(hasApiKey())
  const [status, setStatus] = useState('idle') // idle | pinging | ok | error
  const [reply, setReply] = useState('')
  const [error, setError] = useState('')
  const [onboarded, setOnboarded] = useState(null) // null = loading profile

  // First run shows the onboarding quiz; once a profile is saved we show the digest.
  useEffect(() => {
    getProfile().then((profile) => setOnboarded(!!profile?.onboarded))
  }, [])

  function handleSave(e) {
    e.preventDefault()
    if (!key.trim()) return
    setApiKey(key)
    setKey('')
    setSaved(true)
    setStatus('idle')
    setReply('')
    setError('')
  }

  function handleClear() {
    clearApiKey()
    setSaved(false)
    setStatus('idle')
    setReply('')
    setError('')
  }

  async function handlePing() {
    setStatus('pinging')
    setError('')
    setReply('')
    try {
      const text = await ping()
      setReply(text)
      setStatus('ok')
    } catch (err) {
      setError(err?.message || String(err))
      setStatus('error')
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-2xl px-6 py-16">
        <header className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight">Verastar</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-400">
            A verifiable evidence digest for clinicians. Verified, never fabricated.
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-medium">Bring your own key</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Your Anthropic API key stays in this tab's <code>sessionStorage</code> — never
            sent to any server, never written to disk. It clears when you close the tab.
          </p>

          {!saved ? (
            <form onSubmit={handleSave} className="mt-4 flex gap-2">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-ant-…"
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-950"
                autoComplete="off"
              />
              <button
                type="submit"
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                Save
              </button>
            </form>
          ) : (
            <div className="mt-4 flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Key set
              </span>
              <button
                onClick={handlePing}
                disabled={status === 'pinging'}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
              >
                {status === 'pinging' ? 'Pinging…' : 'Test connection'}
              </button>
              <button
                onClick={handleClear}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Clear key
              </button>
            </div>
          )}

          {status === 'ok' && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
              <span className="font-medium">Anthropic replied:</span> “{reply}” — browser-direct
              call works.
            </div>
          )}
          {status === 'error' && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200">
              <span className="font-medium">Call failed:</span> {error}
            </div>
          )}
        </section>

        {/* First run: build a steering profile. After that: edit it + run the digest. */}
        {onboarded === false ? (
          <OnboardingQuiz onDone={() => setOnboarded(true)} />
        ) : onboarded === true ? (
          <>
            <NorthStars />
            {/* Re-mount on key change so the disabled state tracks the saved key. */}
            <SpineCheck key={saved ? 'keyed' : 'nokey'} />
          </>
        ) : null}
      </div>
    </div>
  )
}
