#!/usr/bin/env node
// Summary-path evaluation CLI (library: src/eval/summaryEval.js). FAKE BY DEFAULT: without
// --live every command runs the complete pipeline against a deterministic fake client and
// measures nothing about any model. A live run is refused unless ALL hold: --live; --out;
// --max-usd (a finite positive cap that the ledger enforces before every dispatch);
// ANTHROPIC_API_KEY in the environment; and VERASTAR_EVAL_AUTHORIZE equal to
// "<command>:<first 12 hex of the sha256 of the frozen case manifest>" printed by a dry
// run. That variable is an OPERATOR GUARD against accidental runs, not proof that a human
// authorized spending.
//
//   node scripts/eval-summary.mjs dev            --out DIR [--checker haiku|sonnet] [--cases PARADE,ASPIRIN,...] [--live --max-usd 20]
//   node scripts/eval-summary.mjs probes         --out DIR [--checker haiku|sonnet] [--repeats 5] [--live --max-usd 2]
//   node scripts/eval-summary.mjs holdout-select --out DIR [--count 20] [--days 540] [--topics "a;b;c"]   (free: PubMed/PMC only)
//   node scripts/eval-summary.mjs holdout-run    --out DIR [--checker haiku|sonnet] [--limit N] [--live --max-usd 30]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DOMParser } from 'linkedom'
import {
  HARNESS_VERSION, CHECKER_MODELS, FROZEN_CASES, EXCLUDED_CASES, PROBES, EVAL_PROFILE, sha256,
  makeLedger, installClient, fakeClient, makeLiveClient, loadFrozenCase, extractCase, runSummary, runProbes, summarizeProbes,
  candidateFor, gradeTake, holdoutResultFromXml, reportCounts, CapReached,
} from '../src/eval/summaryEval.js'
import { searchPubmed, fetchCitations, fetchAbstractsByPmid, pmidToPmcid, fetchPmcFullText, searchPaceMs } from '../src/pipeline/sources.js'
import { MODELS } from '../src/lib/anthropic.js'

globalThis.DOMParser = DOMParser
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))

export function parseArgs(argv) {
  const out = { command: argv[0], live: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--live') out.live = true
    else if (['--out', '--max-usd', '--checker', '--cases', '--repeats', '--count', '--days', '--topics', '--limit', '--grader'].includes(a)) {
      if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`${a} needs a value`)
      out[a.slice(2)] = argv[++i]
    } else throw new Error(`Unknown argument: ${a}`)
  }
  if (!['dev', 'probes', 'holdout-select', 'holdout-run'].includes(out.command)) throw new Error('Command must be dev, probes, holdout-select or holdout-run')
  if (!out.out) throw new Error('--out is required (traces and the spend ledger are written there)')
  out.checker = CHECKER_MODELS[out.checker || 'haiku']
  if (!out.checker) throw new Error('--checker must be haiku or sonnet')
  out.maxUsd = out['max-usd'] != null ? Number(out['max-usd']) : null
  if (out.live && !(Number.isFinite(out.maxUsd) && out.maxUsd > 0)) throw new Error('--max-usd must be a finite positive number of dollars for a live run')
  return out
}

// Previously used papers: the frozen six, TEVAR, the round-3 fresh set, every PMID in the
// evidence packet, the saved dev set fixtures, and anything already in a holdout manifest.
export function usedPmids() {
  const used = new Set([...FROZEN_CASES.map((c) => c.pmid), ...EXCLUDED_CASES.map((c) => c.pmid), '42704575', '42733468', '42619594'])
  const scan = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name)
      if (name.isDirectory()) scan(p)
      else if (/\.(json|md|txt)$/.test(name.name)) for (const m of readFileSync(p, 'utf8').matchAll(/\b(3\d{7}|4\d{7})\b/g)) used.add(m[1])
    }
  }
  scan(join(REPO, 'docs', 'evidence'))
  scan(join(REPO, 'src', 'pipeline', '__fixtures__'))
  return used
}

export const EXCLUDED_PUBTYPES = new Set(['case reports', 'review', 'editorial', 'letter', 'comment', 'published erratum', 'news', 'historical article', 'guideline', 'practice guideline'])
export const DEFAULT_TOPICS = [
  'chronic limb-threatening ischemia', 'peripheral artery disease revascularization', 'diabetic foot ulcer amputation',
  'abdominal aortic aneurysm repair', 'carotid artery stenosis endarterectomy stenting', 'venous thromboembolism anticoagulation',
  'vascular surgery randomized trial', 'dialysis access arteriovenous fistula', 'artificial intelligence clinical prediction surgery',
]

function manifestDigest(command, items) {
  return `${command}:${sha256(JSON.stringify(items)).slice(0, 12)}`
}

function liveGate(args, expected, env) {
  const problems = []
  if (!env.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY is not set in the environment')
  if (env.VERASTAR_EVAL_AUTHORIZE !== expected) problems.push(`VERASTAR_EVAL_AUTHORIZE must equal "${expected}" (operator guard for this frozen manifest; not a substitute for human authorization)`)
  if (problems.length) throw new Error(`Live run refused:\n- ${problems.join('\n- ')}`)
}

function writeReport(dir, name, data) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `${JSON.stringify(data, null, 1)}\n`)
}

// One ledger per output directory (the cap's running total); every run writes its calls
// and per-paper traces under its own runs/<command>-<checker>-<timestamp>/ so a second
// checker model never overwrites the first model's traces.
function runDirFor(args, command) {
  const checker = args.checker.includes('haiku') ? 'haiku' : 'sonnet'
  const dir = join(args.out, 'runs', `${command}-${checker}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
async function setupClient(args, { label, env, traceDir }) {
  const ledger = makeLedger({ capUsd: args.live ? args.maxUsd : 1e9, dir: args.out, label })
  const context = { caseId: null, purpose: null }
  const inner = args.live ? await makeLiveClient({ apiKey: env.ANTHROPIC_API_KEY }) : fakeClient()
  installClient(inner, { ledger, traceDir, context })
  return { ledger, context }
}

async function dev(args, env) {
  const selected = args.cases ? FROZEN_CASES.filter((c) => args.cases.split(',').includes(c.id)) : FROZEN_CASES
  const loaded = selected.map(loadFrozenCase)
  const manifest = loaded.map((l) => ({ id: l.case.id, pmid: l.case.pmid, sourceSha256: l.provenance.sourceSha256, extractionInputSha256: l.provenance.extractionInputSha256, extractionReused: l.provenance.extractionReused }))
  const expected = manifestDigest('dev', manifest)
  const plan = { harnessVersion: HARNESS_VERSION, mode: args.live ? 'live' : 'fake', command: 'dev', checkerModel: args.checker, writerModel: MODELS.triage, extractionModel: MODELS.extraction, profileSha256: sha256(JSON.stringify(EVAL_PROFILE)), cases: manifest, excluded: EXCLUDED_CASES, authorization: expected, capUsd: args.maxUsd }
  console.log(JSON.stringify(plan, null, 1))
  if (args.live) liveGate(args, expected, env)
  const traceDir = runDirFor(args, 'dev')
  const { ledger, context } = await setupClient(args, { label: 'dev', env, traceDir })
  writeReport(args.out, 'plan.dev.json', plan)
  writeReport(traceDir, 'plan.dev.json', plan)
  const outcomes = []
  let stopped = null
  for (const l of loaded) {
    try {
      if (l.needsExtraction) {
        context.caseId = l.case.id
        context.purpose = 'extraction'
        await extractCase(l)
        writeFileSync(join(traceDir, `extraction.${l.case.id}.json`), `${JSON.stringify(l.extraction, null, 1)}\n`)
      }
      context.purpose = null
      outcomes.push(await runSummary({ loaded: l, checkerModel: args.checker, traceDir, context }))
    } catch (err) {
      if (err instanceof CapReached) { stopped = { at: l.case.id, message: err.message }; break }
      outcomes.push({ case: l.case, error: String(err?.message || err) })
    }
  }
  const report = {
    ...plan, traceDir, completedAt: new Date().toISOString(), spendUsd: ledger.total, ledger: ledger.state, stopped,
    counts: reportCounts(outcomes),
    papers: outcomes.map((o) => o.error ? { id: o.case.id, error: o.error } : {
      id: o.case.id, pmid: o.case.pmid, summaryKind: o.take.summaryKind, finding: o.take.finding, designCaution: o.take.designCaution, rewriteUsed: o.take.rewriteUsed,
      checkReason: o.take.check?.reason, summaryReason: o.take.summaryReason, failures: (o.take.summaryChecks || []).filter((f) => !f.informational), latencyMs: o.latencyMs, expectations: o.case.expectations,
    }),
  }
  writeReport(traceDir, 'report.json', report)
  writeReport(args.out, `report.dev.${args.live ? 'live' : 'fake'}.${args.checker.includes('haiku') ? 'haiku' : 'sonnet'}.json`, report)
  console.log(JSON.stringify({ traceDir, counts: report.counts, spendUsd: report.spendUsd, stopped }, null, 1))
  return report
}

async function probes(args, env) {
  const repeats = Number(args.repeats || 5)
  const expected = manifestDigest('probes', PROBES)
  const plan = { harnessVersion: HARNESS_VERSION, mode: args.live ? 'live' : 'fake', command: 'probes', checkerModel: args.checker, repeats, probes: PROBES.map((p) => p.id), authorization: expected, capUsd: args.maxUsd }
  console.log(JSON.stringify(plan, null, 1))
  if (args.live) liveGate(args, expected, env)
  const traceDir = runDirFor(args, 'probes')
  const { ledger, context } = await setupClient(args, { label: 'probes', env, traceDir })
  let results = []
  let stopped = null
  try {
    results = await runProbes({ checkerModel: args.checker, repeats, traceDir, context })
  } catch (err) {
    if (!(err instanceof CapReached)) throw err
    stopped = err.message
  }
  const report = { ...plan, traceDir, completedAt: new Date().toISOString(), spendUsd: ledger.total, stopped, summary: summarizeProbes(results), results }
  writeReport(traceDir, 'report.json', report)
  writeReport(args.out, `report.probes.${args.live ? 'live' : 'fake'}.${args.checker.includes('haiku') ? 'haiku' : 'sonnet'}.json`, report)
  console.log(JSON.stringify({ traceDir, summary: report.summary, spendUsd: report.spendUsd, stopped }, null, 1))
  return report
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Free: PubMed search per topic, exclude used PMIDs, keep PMC open-access full text with a
// body, freeze the XML and a manifest BEFORE any model output exists.
async function holdoutSelect(args) {
  const count = Number(args.count || 20)
  const days = Number(args.days || 540)
  const topics = args.topics ? args.topics.split(';').map((t) => t.trim()).filter(Boolean) : DEFAULT_TOPICS
  const used = usedPmids()
  const dir = join(args.out, 'holdout')
  mkdirSync(join(dir, 'sources'), { recursive: true })
  const candidates = []
  const seen = new Set()
  for (const topic of topics) {
    await sleep(searchPaceMs())
    let pmids = []
    try { pmids = await searchPubmed(topic, { retmax: 40, days }) } catch (err) { console.warn(`search failed for "${topic}": ${err.message}`); continue }
    for (const pmid of pmids) {
      const id = String(pmid)
      if (seen.has(id) || used.has(id)) continue
      seen.add(id)
      candidates.push({ pmid: id, topic })
    }
  }
  const cites = candidates.length ? await fetchCitations(candidates.map((c) => c.pmid)) : []
  const abstracts = candidates.length ? await fetchAbstractsByPmid(candidates.map((c) => c.pmid)).catch(() => ({})) : {}
  const byPmid = new Map(cites.map((c) => [String(c.pmid), c]))
  const selected = []
  const considered = []
  // Round-robin across topics so no single topic fills the set.
  const byTopic = new Map()
  for (const c of candidates) (byTopic.get(c.topic) || byTopic.set(c.topic, []).get(c.topic)).push(c)
  const queues = [...byTopic.values()]
  let round = 0
  while (selected.length < count && queues.some((q) => q.length)) {
    const q = queues[round % queues.length]
    round += 1
    const c = q.shift()
    if (!c) continue
    const cite = byPmid.get(c.pmid)
    if (!cite || cite.retracted) { considered.push({ ...c, skipped: 'no citation or retracted' }); continue }
    // Results papers only: case reports, narrative reviews, editorials and letters have no
    // result to verify; an abstract with no Results section or almost no numbers is skipped.
    const types = (cite.pubtypes || []).map((t) => String(t).toLowerCase())
    if (types.some((t) => EXCLUDED_PUBTYPES.has(t)) && !types.some((t) => /meta-analysis|systematic review|randomized controlled trial|clinical trial/.test(t))) { considered.push({ ...c, skipped: `publication type: ${(cite.pubtypes || []).join(', ')}` }); continue }
    const abstract = abstracts[c.pmid] || ''
    if (!/\bresults?\b/i.test(abstract) || (abstract.match(/\d/g) || []).length < 6) { considered.push({ ...c, skipped: 'abstract has no Results section or too few numbers' }); continue }
    await sleep(searchPaceMs())
    let pmcid = null
    try { pmcid = await pmidToPmcid(c.pmid) } catch { pmcid = null }
    if (!pmcid) { considered.push({ ...c, skipped: 'no PMC open-access record' }); continue }
    await sleep(searchPaceMs())
    let xml = null
    try {
      const { fetchPmcFullText: _unused, ...rest } = { fetchPmcFullText }
      void rest
      const res = await fetch(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${String(pmcid).replace(/^PMC/i, '')}&rettype=xml&retmode=xml&tool=verastar`)
      if (!res.ok) throw new Error(`${res.status}`)
      xml = await res.text()
    } catch (err) { considered.push({ ...c, skipped: `PMC fetch failed: ${err.message}` }); continue }
    let parsed
    try { parsed = holdoutResultFromXml({ pmid: c.pmid, xml, title: cite.title }) } catch (err) { considered.push({ ...c, skipped: err.message }); continue }
    writeFileSync(join(dir, 'sources', `${c.pmid}.xml`), xml)
    selected.push({ pmid: c.pmid, pmcid, topic: c.topic, title: cite.title, journal: cite.journal, year: cite.year, sourceSha256: parsed.sourceSha256, extractionInputSha256: sha256(parsed.modelText), chars: parsed.modelText.length, abstractChars: (abstracts[c.pmid] || '').length })
    considered.push({ ...c, selected: true })
  }
  const manifest = { harnessVersion: HARNESS_VERSION, frozenAt: new Date().toISOString(), days, topics, count: selected.length, requested: count, usedExcluded: used.size, papers: selected, considered, authorization: manifestDigest('holdout-run', selected.map((p) => [p.pmid, p.sourceSha256])) }
  writeReport(dir, 'manifest.json', manifest)
  console.log(JSON.stringify({ selected: selected.length, authorization: manifest.authorization, papers: selected.map((p) => `${p.pmid} ${p.title.slice(0, 80)}`) }, null, 1))
  return manifest
}

async function holdoutRun(args, env) {
  const dir = join(args.out, 'holdout')
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  const expected = manifestDigest('holdout-run', manifest.papers.map((p) => [p.pmid, p.sourceSha256]))
  const plan = { harnessVersion: HARNESS_VERSION, mode: args.live ? 'live' : 'fake', command: 'holdout-run', checkerModel: args.checker, graderModel: args.grader || 'claude-sonnet-5-5', papers: manifest.papers.length, authorization: expected, capUsd: args.maxUsd }
  console.log(JSON.stringify(plan, null, 1))
  if (args.live) liveGate(args, expected, env)
  const traceDir = runDirFor(args, 'holdout-run')
  const { ledger, context } = await setupClient(args, { label: 'holdout', env, traceDir })
  const limit = args.limit ? Number(args.limit) : manifest.papers.length
  const outcomes = []
  let stopped = null
  for (const p of manifest.papers.slice(0, limit)) {
    const caseId = `HOLD-${p.pmid}`
    try {
      const xml = readFileSync(join(dir, 'sources', `${p.pmid}.xml`), 'utf8')
      if (sha256(xml) !== p.sourceSha256) throw new Error('frozen source changed since selection')
      const { result, modelText } = holdoutResultFromXml({ pmid: p.pmid, xml, title: p.title })
      const loaded = { case: { id: caseId, pmid: p.pmid, record: 'holdout' }, result, modelText, provenance: { manifest: 'holdout/manifest.json', sourceSha256: p.sourceSha256, extractionInputSha256: sha256(modelText), extractionReused: false }, needsExtraction: true }
      context.caseId = caseId
      context.purpose = 'extraction'
      await extractCase(loaded)
      writeFileSync(join(traceDir, `extraction.${p.pmid}.json`), `${JSON.stringify(loaded.extraction, null, 1)}\n`)
      context.purpose = null
      const out = await runSummary({ loaded, checkerModel: args.checker, traceDir, context })
      context.purpose = 'holdout-grade'
      const candidate = candidateFor(result)
      const grade = await gradeTake({ take: out.take, candidate, model: plan.graderModel })
      outcomes.push({ ...out, grade })
      writeFileSync(join(traceDir, 'papers', caseId, 'grade.json'), `${JSON.stringify(grade, null, 1)}\n`)
    } catch (err) {
      if (err instanceof CapReached) { stopped = { at: p.pmid, message: err.message, completed: outcomes.length }; break }
      outcomes.push({ case: { id: caseId, pmid: p.pmid }, error: String(err?.message || err) })
    }
  }
  const graded = outcomes.filter((o) => o.grade)
  const report = {
    ...plan, traceDir, completedAt: new Date().toISOString(), spendUsd: ledger.total, ledger: ledger.state, stopped, completed: outcomes.length,
    counts: reportCounts(outcomes),
    hardFailures: graded.reduce((n, o) => n + (o.grade.response.hard_failures || []).length, 0),
    primaryCovered: graded.filter((o) => o.grade.response.primary_covered).length,
    numericBindingOk: graded.filter((o) => o.grade.response.numeric_binding_ok).length,
    meanReadability: graded.length ? graded.reduce((n, o) => n + (o.grade.response.readability || 0), 0) / graded.length : null,
    meanLatencyMs: graded.length ? graded.reduce((n, o) => n + o.latencyMs, 0) / graded.length : null,
    papers: outcomes.map((o) => o.error ? { id: o.case.id, error: o.error } : { id: o.case.id, pmid: o.case.pmid, summaryKind: o.take.summaryKind, finding: o.take.finding, designCaution: o.take.designCaution, rewriteUsed: o.take.rewriteUsed, failures: (o.take.summaryChecks || []).filter((f) => !f.informational), grade: o.grade.response, latencyMs: o.latencyMs }),
    note: 'The model pre-grade is provisional. Physician grading of at least ten holdout papers decides.',
  }
  writeReport(traceDir, 'report.json', report)
  writeReport(dir, `report.holdout.${args.live ? 'live' : 'fake'}.${args.checker.includes('haiku') ? 'haiku' : 'sonnet'}.json`, report)
  console.log(JSON.stringify({ traceDir, completed: report.completed, counts: report.counts, hardFailures: report.hardFailures, spendUsd: report.spendUsd, stopped }, null, 1))
  return report
}

export async function main(argv, env = process.env) {
  const args = parseArgs(argv)
  mkdirSync(args.out, { recursive: true })
  if (args.command === 'dev') return dev(args, env)
  if (args.command === 'probes') return probes(args, env)
  if (args.command === 'holdout-select') return holdoutSelect(args)
  return holdoutRun(args, env)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1) })
}
