import { ESLint } from 'eslint'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

// Existing diagnostics are explicit debt, not suppressed ESLint rules. Fingerprint
// each by file, rule, message and actual source line: moving code is harmless,
// while another diagnostic in the same file/rule cannot spend an old allowance.
const baselinePath = new URL('../eslint-baseline.json', import.meta.url)
const results = await new ESLint().lintFiles(['.'])
const actual = {}
for (const result of results) {
  if (!result.messages.length) continue
  const source = (await readFile(result.filePath, 'utf8')).split(/\r?\n/)
  for (const message of result.messages) {
    const entry = {
      file: path.relative(process.cwd(), result.filePath).split(path.sep).join('/'),
      rule: message.ruleId || 'parse-error', severity: message.severity,
      message: message.message.split('\n')[0],
      source: (source[message.line - 1] || '').trim(),
    }
    const key = JSON.stringify(entry)
    actual[key] = (actual[key] || 0) + 1
  }
}
if (process.argv.includes('--write-baseline')) {
  await writeFile(baselinePath, JSON.stringify({ version: 1, entries: actual }, null, 2) + '\n')
  console.log('Wrote explicit lint debt. Review every entry before accepting this file.')
} else {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')).entries
  let failures = 0
  for (const [key, count] of Object.entries(actual)) {
    const entry = JSON.parse(key)
    const allowed = entry.rule === 'parse-error' ? 0 : (baseline[key] || 0)
    if (count > allowed) {
      failures += count - allowed
      console.error(`${entry.file}: ${entry.rule}: ${entry.message} (${count - allowed} new)\n  ${entry.source}`)
    }
  }
  const messages = Object.entries(actual).flatMap(([key,count]) => Array(count).fill(JSON.parse(key)))
  const errors = messages.filter((message) => message.severity === 2).length
  const warnings = messages.length - errors
  console.log(`Lint debt: ${errors} existing errors, ${warnings} existing warnings. New diagnostics: ${failures}.`)
  if (failures) process.exitCode = 1
}
