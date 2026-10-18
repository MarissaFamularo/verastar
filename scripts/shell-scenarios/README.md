# App-shell scenarios (simulated backend)

Drives the real app in Chromium against an in-memory fake of the Supabase HTTP surface:
real `supabase-js`, real components, synthetic accounts, no live services, no paid calls.
Covers onboarding survey submit / skip / backend error / backend timeout / keyboard-only,
optional-code enrollment handoff, admin and non-admin Settings at desktop and phone widths, scrolling, and focus behavior.
Writes `docs/screenshots/beta-release/shell-*.png` and `shell-results.txt` locally (git-ignored). Not part of CI.

```bash
# terminal 1: the app, pointed at the host the script intercepts
VITE_SUPABASE_URL=http://fake.supabase.local VITE_SUPABASE_ANON_KEY=anon-test-key npx vite --port 5198 --strictPort
# terminal 2 (needs playwright-core and a Chromium; CHROMIUM_PATH overrides the binary)
npm i --no-save playwright-core@1.56.1 && node scripts/shell-scenarios/shell.mjs
```

Simulated evidence only: it proves the client's behavior against the documented server
contract, not the live project, the real RPCs, or RLS (those are `supabase/tests/`).
