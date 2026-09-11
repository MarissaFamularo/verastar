# Reproducible frontend checks (2026-09-11)

The clean locked baseline used Node 24.12.0 / npm 11.6.2. It installed independently
of the developer's existing node_modules. Tests and build passed before upgrades;
the audit reported 6 affected packages (3 high, 3 moderate), all development paths.

The final package manifest pins direct dependencies exactly and the lockfile pins
transitive dependencies. Vite remains 7.3.6 and Supabase JS 2.110.8. Vitest moves
from 3.2.7 to **4.1.11**, the minimum patched stable major for
[GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).
The maintainers explicitly state that 2.x/3.x will not receive that fix. This is a
development-server mock plugin issue, not evidence of a deployed-site exploit.
No `npm audit fix --force` was used. Ordinary compatible transitive updates clear
the other reported advisories; current audit results are zero affected packages,
not a guarantee of zero vulnerabilities.

The major test-runner change is reviewed separately: no browser-mode, coverage,
workspace, custom pool, class mock, or mock-reset migration is needed in this
suite. Both installed versions have isolate=true and clearMocks/mockReset/
restoreMocks=false. Existing tests explicitly clear mocks where needed. Tests
remain in the Node environment and their inclusion pattern is unchanged. Final
validation uses a fresh `npm ci --ignore-scripts`, full test suite, build, lint
gate and audit on the final lockfile. No application test was weakened for the
runner upgrade.

## CI and explicit lint debt

The workflow on pull requests/main performs clean installation, lint, tests,
build and moderate-or-higher audit checks on Node 24, with read-only repository
permissions and no API secrets. Install scripts are disabled, matching the
validated local clean installation; required native binaries arrive as optional
platform packages. No model call, production database mutation or paid service
is required.

`npm run lint:raw` reports all diagnostics. `npm run lint` compares them with the
reviewed `eslint-baseline.json`: **9 existing errors and 10 warnings**. The errors
are existing render/ref/effect patterns; warnings are existing hook dependencies
and exported pure helpers used in tests. The React hook rules remain enabled.
Each allowance binds file, rule, message, exact source line and count; a new
diagnostic fails even when another warning elsewhere disappears. A synthetic
unused-variable probe was added, the gate correctly exited 1, and the probe was
moved out afterward. Do not regenerate the baseline automatically in CI.

Only generated output, dependencies and the non-application `design/` reference
are excluded. Application source is not excluded. Routine unused binding and
redundant escape findings were corrected. The note editor now keeps a draft
separately from incoming props instead of synchronously copying props in an
effect; failed saves retain the draft.

## Final local result

| Package/check | Final lockfile | Clean-installed result |
|---|---|---|
| Vite | 7.3.6 | 7.3.6 |
| Supabase JS | 2.110.8 | 2.110.8 |
| React / React DOM | 19.2.7 | 19.2.7 |
| Vitest | 4.1.11 | 4.1.11 |
| Tests | Full configured suite | 830 passed / 50 files |
| Build | Vite production build | Passed |
| Lint gate | Reviewed fingerprints | Passed; raw debt remains above |
| npm audit | Final lockfile, 2026-09-11 | 0 affected packages |

The first final `npm ci` exposed a missing optional wasm dependency in npm's
incrementally rewritten lockfile. Rebuilding the lockfile from the exact manifest
with no dependency tree fixed it; the subsequent clean install and all checks
passed. ESLint stays on major 9 for this bounded lint introduction (npm labels
that major unsupported); its next major is a separate maintenance change, and
no current advisory is being suppressed. CI has been prepared locally, not run
on GitHub or marked as a production release.

The release includes `.nvmrc` set to `24`, matching CI and explicitly selecting Netlify’s build runtime. Production build configuration was checked read-only: both sites retain the intended Supabase URL and an anonymous client key; no environment values were changed. Netlify supports this repository setting: [build dependency documentation](https://docs.netlify.com/build/configure-builds/manage-dependencies/). The next hosted build must confirm the selected runtime.
