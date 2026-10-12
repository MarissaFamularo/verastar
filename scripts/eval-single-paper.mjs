#!/usr/bin/env node
// One-paper evaluation harness (src/eval/singlePaper.js). DRY-RUN BY DEFAULT: it parses
// the one saved PMC XML file, prints the plan (hashes, evidence window, the exact
// extraction request size, its conservative charge bound and a separately labelled rough
// estimate) and exits without a model call.
//
//   node scripts/eval-single-paper.mjs --case CAR-10 --pmid 20505173 --pmc-xml <file>
//       [--reference <file.json>] [--out <dir outside this repo>]
//       [--fake <fake-extraction.json>]                 plumbing only, no network
//       [--live --model <id> --max-usd <n> --out <dir>] also needs VERASTAR_EVAL_AUTHORIZE
//
// Live is refused unless ALL hold: --model is a priced model (the shared sponsored table, or
// the harness's eval-only table in src/eval/evalModels.js); --max-usd is a finite positive
// number that covers the conservative charge bound (whole context window + max_tokens);
// --out is set, so the attempt receipt is persisted before dispatch; and
// VERASTAR_EVAL_AUTHORIZE equals "<case>:<first 12 hex of the source sha256>". That variable
// is an OPERATOR GUARD against accidental runs, not proof that a human authorized spending:
// a live run still requires Marissa's separate, explicit authorization. One attempt, SDK
// retries disabled, explicit timeout, no cache, no store.
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser } from 'linkedom'
import { planSinglePaper, planSummary, runSinglePaper, compareToReference, makeLiveProvider, validCap } from '../src/eval/singlePaper.js'

globalThis.DOMParser = DOMParser
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function parseArgs(argv) {
  const out = { live: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--live') out.live = true
    else if (['--case', '--pmid', '--pmc-xml', '--reference', '--out', '--fake', '--model', '--max-usd'].includes(a)) {
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`)
      out[a.slice(2)] = argv[++i]
    } else throw new Error(`Unknown or extra argument: ${a} (one paper, one file)`)
  }
  if (!out.case || !out.pmid || !out['pmc-xml']) throw new Error('--case, --pmid and --pmc-xml are required')
  if (out.live && out.fake) throw new Error('Choose --fake or --live, not both')
  return out
}

const insideRepo = (p) => {
  const rel = relative(REPO, resolve(p))
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function oneFile(p, what) {
  if (!statSync(p).isFile()) throw new Error(`${what} must be one file, not a directory`)
  return readFileSync(p, 'utf8')
}

// The operator-guard string a live run needs, for this exact source. It prevents an
// accidental run; it does not prove a human authorized one.
export const authorizationFor = (plan) => `${plan.caseId}:${plan.sourceSha256.slice(0, 12)}`

export function liveGate(plan, { model, maxUsd, out, env }) {
  const problems = []
  if (!model) problems.push('--model is required (no default model for a live run)')
  if (!validCap(maxUsd)) problems.push('--max-usd is required (a finite positive per-run cap in dollars)')
  if (!out) problems.push('--out is required (the attempt receipt is written there before dispatch)')
  if (model && plan.chargeBoundUsd == null) problems.push(`${model} has no price in the shared or eval-only price table; its cost cannot be bounded`)
  if (plan.chargeBoundUsd != null && validCap(maxUsd) && plan.chargeBoundUsd > maxUsd) problems.push(`conservative charge bound $${plan.chargeBoundUsd.toFixed(4)} exceeds --max-usd ${maxUsd}`)
  if (env.VERASTAR_EVAL_AUTHORIZE !== authorizationFor(plan)) problems.push(`VERASTAR_EVAL_AUTHORIZE must equal "${authorizationFor(plan)}" (operator guard for this source; not a substitute for human authorization)`)
  return problems
}

export async function main(argv, env = process.env, log = console.log) {
  const args = parseArgs(argv)
  if (args.out && insideRepo(args.out)) throw new Error('--out must be outside the public app repo')
  const maxUsd = args['max-usd'] != null ? Number(args['max-usd']) : null
  if (maxUsd != null && !validCap(maxUsd)) throw new Error('--max-usd must be a finite positive number of dollars')
  const plan = await planSinglePaper({ caseId: args.case, pmid: args.pmid, pmcXml: oneFile(args['pmc-xml'], '--pmc-xml'), model: args.model || null, maxUsd })
  const report = { mode: 'dry-run', plan: planSummary(plan) }

  if (args.fake) {
    report.mode = 'fake'
    const fake = JSON.parse(oneFile(args.fake, '--fake'))
    report.run = await runSinglePaper(plan, async () => fake, { label: 'fake' })
  } else if (args.live) {
    const problems = liveGate(plan, { model: args.model, maxUsd, out: args.out, env })
    if (problems.length) throw new Error(`Live run refused:\n- ${problems.join('\n- ')}`)
    report.mode = 'live'
    mkdirSync(args.out, { recursive: true })
    const receipts = []
    const provider = makeLiveProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      context: { caseId: plan.caseId, pmid: plan.pmid, sourceSha256: plan.sourceSha256, extractionInputSha256: plan.extractionInputSha256, chargeBoundUsd: plan.chargeBoundUsd, maxUsd },
      onReceipt: async (receipt) => {
        receipts.push(receipt)
        writeFileSync(resolve(args.out, `${plan.caseId}.${receipt.model}.attempt-${receipt.startedAt.replace(/[:.]/g, '-')}.json`), `${JSON.stringify(receipt, null, 2)}\n`)
      },
    })
    try {
      report.run = await runSinglePaper(plan, provider, { label: 'live' })
    } finally {
      report.attempt = receipts.at(-1) ?? null
    }
  }
  if (report.run && args.reference) report.comparison = compareToReference(report.run, JSON.parse(oneFile(args.reference, '--reference')))

  const text = JSON.stringify(report, null, 2)
  if (args.out) {
    mkdirSync(args.out, { recursive: true })
    writeFileSync(resolve(args.out, `${args.case}.${report.mode}.json`), `${text}\n`)
  }
  log(text)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
