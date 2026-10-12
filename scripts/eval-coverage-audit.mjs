#!/usr/bin/env node
// Evaluation-only coverage audit CLI (src/eval/coverageAudit.js). DRY-RUN BY DEFAULT.
//
//   node scripts/eval-coverage-audit.mjs --case CAR-10 --pmid 20505173 --pmc-xml <file>
//       --extraction-report <live-report.json> [--model <id> --max-usd <n>] [--out <dir>]
//       [--live]   also needs --model, --max-usd, --out and VERASTAR_EVAL_AUTHORIZE
//
// One paper, one file, one existing live extraction report. Refuses directories, lists and
// corpus options; refuses --out inside the public repo or an existing output directory.
// Live reuses the single-paper gate and provider (one attempt, retries 0, explicit timeout,
// receipts persisted BEFORE dispatch, response-model identity check). The operator env guard
// only prevents accidents; explicit user authorization is the existing spending envelope.
// The API key is read only from the passed env, never from disk. Errors become receipts;
// full source is never logged.
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync } from 'node:fs'
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser } from 'linkedom'
import { makeLiveProvider, validCap } from '../src/eval/singlePaper.js'
import { planCoverageAudit, coverageSummary, runCoverageAudit } from '../src/eval/coverageAudit.js'
import { liveGate } from './eval-single-paper.mjs'

globalThis.DOMParser = DOMParser
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const VALUE_FLAGS = ['--case', '--pmid', '--pmc-xml', '--extraction-report', '--out', '--model', '--max-usd']

export function parseArgs(argv) {
  const out = { live: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--live') out.live = true
    else if (VALUE_FLAGS.includes(a)) {
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`)
      out[a.slice(2)] = argv[++i]
    } else throw new Error(`Unknown or extra argument: ${a} (one paper, one file, one report)`)
  }
  if (!out.case || !out.pmid || !out['pmc-xml'] || !out['extraction-report']) throw new Error('--case, --pmid, --pmc-xml and --extraction-report are required')
  return out
}

const REPO_REAL = (() => { try { return realpathSync(REPO) } catch { return REPO } })()
const within = (root, p) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// Resolve the deepest existing ancestor through symlinks, then re-append the not-yet-existing
// tail, so a symlinked parent cannot smuggle a write into the public repo.
export function resolveRealPath(p) {
  let cur = resolve(p)
  const tail = []
  while (!existsSync(cur) && !lstatExists(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break
    tail.unshift(basename(cur))
    cur = parent
  }
  let real
  try { real = realpathSync(cur) } catch { real = cur }
  return tail.length ? join(real, ...tail) : real
}
function lstatExists(p) { try { lstatSync(p); return true } catch { return false } }

const insideRepo = (p) => within(REPO_REAL, resolveRealPath(p)) || within(REPO, resolve(p))

// Atomically own a FRESH leaf directory: non-recursive mkdir fails with EEXIST if anything
// (file, dir, dangling symlink) already occupies the leaf, so a race cannot overwrite.
// Parents are created first (recursive) but the leaf itself is always newly created by us.
function ownFreshDir(out) {
  if (lstatExists(out)) throw new Error('--out already exists; refusing to overwrite preserved artifacts')
  mkdirSync(dirname(resolve(out)), { recursive: true })
  try { mkdirSync(resolve(out)) } catch (err) {
    if (err?.code === 'EEXIST') throw new Error('--out already exists; refusing to overwrite preserved artifacts')
    throw err
  }
  // Re-check after creation: the real location must still be outside the public repo.
  if (insideRepo(out)) throw new Error('--out must be outside the public app repo')
}

function oneFile(p, what) {
  if (!statSync(p).isFile()) throw new Error(`${what} must be one file, not a directory`)
  return readFileSync(p, 'utf8')
}

export const authorizationFor = (plan) => `${plan.caseId}:${plan.sourceSha256.slice(0, 12)}`

export async function main(argv, env = process.env, log = console.log, { Anthropic, fetch } = {}) {
  const args = parseArgs(argv)
  if (args.out && insideRepo(args.out)) throw new Error('--out must be outside the public app repo')
  if (args.out && lstatExists(args.out)) throw new Error('--out already exists; refusing to overwrite preserved artifacts')
  const maxUsd = args['max-usd'] != null ? Number(args['max-usd']) : null
  if (maxUsd != null && !validCap(maxUsd)) throw new Error('--max-usd must be a finite positive number of dollars')
  const extractionReport = JSON.parse(oneFile(args['extraction-report'], '--extraction-report'))
  const plan = await planCoverageAudit({ caseId: args.case, pmid: args.pmid, pmcXml: oneFile(args['pmc-xml'], '--pmc-xml'), extractionReport, model: args.model || null, maxUsd })
  const report = { mode: 'dry-run', plan: coverageSummary(plan) }

  if (args.live) {
    const problems = liveGate(plan, { model: args.model, maxUsd, out: args.out, env })
    if (problems.length) throw new Error(`Live run refused:\n- ${problems.join('\n- ')}`)
    report.mode = 'live'
    // Own a fresh leaf BEFORE any provider send so a race cannot overwrite artifacts.
    ownFreshDir(args.out)
    const receipts = []
    const provider = makeLiveProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(Anthropic ? { Anthropic } : {}),
      ...(fetch ? { fetch } : {}),
      context: { auditVersion: plan.auditVersion, caseId: plan.caseId, pmid: plan.pmid, sourceSha256: plan.sourceSha256, extractionInputSha256: plan.extractionInputSha256, extractionReportSha256: plan.extractionReportSha256, chargeBoundUsd: plan.chargeBoundUsd, maxUsd },
      onReceipt: async (rawReceipt) => {
        // Provider error messages can echo secrets or source text; persist safe metadata only.
        const receipt = rawReceipt.error ? { ...rawReceipt, error: { name: rawReceipt.error.name, message: 'Provider error details withheld.' } } : rawReceipt
        receipts.push(receipt)
        writeFileSync(resolve(args.out, `${plan.caseId}.coverage.${receipt.model}.attempt-${receipt.startedAt.replace(/[:.]/g, '-')}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
      },
    })
    try {
      report.run = await runCoverageAudit(plan, provider, { label: 'live' })
    } catch (err) {
      report.error = { name: err?.constructor?.name || 'Error', message: 'Provider request or audit processing failed; inspect the safe attempt metadata.' }
    } finally {
      report.attempt = receipts.at(-1) ?? null
    }
  }

  const text = JSON.stringify(report, null, 2)
  if (args.out) {
    // Dry-run path: own a fresh leaf now. Live already owns it; do not recreate.
    if (report.mode !== 'live') ownFreshDir(args.out)
    writeFileSync(resolve(args.out, `${args.case}.coverage.${report.mode}.json`), `${text}\n`)
  }
  // Log only a safe summary; never the key, the source or the raw model text.
  log(report.mode === 'live' ? JSON.stringify({ mode: report.mode, failed: !!report.error, status: report.run?.audit?.status ?? null, findings: report.run?.audit?.accepted?.length ?? null }) : text)
  if (report.error) {
    // Interface choice: the persisted report and receipts are preserved FIRST, then main
    // rejects with a safe generic error (no provider message, key or source). The CLI wrapper
    // turns that rejection into a non-zero exit, so failure is observable to callers/scripts.
    const failure = new Error('Live coverage audit failed; the error report and attempt receipt were persisted under --out.')
    failure.report = report
    throw failure
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
