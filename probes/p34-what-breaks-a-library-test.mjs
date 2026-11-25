// Probe (reads stored benchmark rows, runs no agent, costs nothing): in the registered run of
// harness v2.6, how many blocks did each arm solve, and what made a test written with the library
// stop testing a buggy refactor or reject a valid fix? Then, on one task's source: which way of
// saying "this call" survives the two changes that broke most tests?
//
//   node probes/p34-what-breaks-a-library-test.mjs [results directory]
//
// The rows are not in the repository. Without the directory the first part is skipped.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REPO, discovery } from './lib.mjs'

// One task of the benchmark, and the two edits of its calibration set that broke most library tests.
const taskSource = readFileSync(join(REPO, 'bench/tasks/token-session/src/session-manager.ts'), 'utf8')
const versions = {
  'as the task ships it': taskSource,
  'the helper renamed (refactor R2)': taskSource.replaceAll('requestNewToken', 'issueSessionToken'),
  'the helper called at two places (fix T4)': taskSource.replace(
    'const raw = await requestNewToken(userId)',
    'const raw = userId === "__fallback__" ? await requestNewToken(userId) : await requestNewToken(userId)',
  ),
}
console.log('## How many expressions each selector matches in token-session (1 is a selection)')
console.log(`${''.padEnd(44)} by callee   through the function and the constant`)
for (const [label, source] of Object.entries(versions)) {
  const { nodes, containers } = discovery.indexTargetFile('/app/src/session-manager.ts', source, '/app')
  // select(file, (node) => node.callee === 'requestNewToken' && node)
  const byCallee = nodes.filter((node) => node.callee === 'requestNewToken').length
  // select(file, { Function: (fn) => fn.name === 'getActiveToken' && fn.traverse({
  //   VariableDeclarator: (declared) => declared.name === 'raw' && declared.traverse({ CallExpression: (call) => call }) }) })
  const inFunction = containers.filter((container) => container.type === 'Function' && container.name === 'getActiveToken')
  const constants = inFunction.flatMap((fn) => fn.containers.map((index) => containers[index])).filter((inner) => inner.type === 'VariableDeclarator' && inner.name === 'raw')
  const throughStructure = new Set(constants.flatMap((constant) => constant.nodes).filter((index) => nodes[index].kind === 'CallExpression')).size
  console.log(`${label.padEnd(44)} ${String(byCallee).padEnd(11)} ${throughStructure}`)
}
console.log()

const base = process.argv[2] ?? join(homedir(), '.ep-bench-results/full-v2.6-2026-11-24')
if (!existsSync(join(base, 'rep1/results.jsonl'))) {
  console.log(`No stored rows at ${base}: nothing to count.`)
  process.exit(0)
}

const rows = []
for (const rep of [1, 2, 3, 4, 5]) {
  for (const line of readFileSync(join(base, `rep${rep}/results.jsonl`), 'utf8').split('\n')) {
    if (line.trim()) rows.push({ ...JSON.parse(line), rep })
  }
}
const ARMS = ['control', 'treatment', 'required']
const CLOSED = 'closed-module' // Stratum A: plain Vitest has no seam to reach the bug through

/** Exact two-sided McNemar: the binomial tail of the smaller discordant count, doubled. */
function mcnemar(b, c) {
  const n = b + c
  let term = 0.5 ** n
  let tail = 0
  for (let i = 0; i <= Math.min(b, c); i += 1) {
    tail += term
    term = (term * (n - i)) / (i + 1)
  }
  return Math.min(1, 2 * tail)
}

/** A block is one task, model, reasoning level and replicate, run once in every arm. */
function compare(label, inScope, counts = (row) => row.solved) {
  const blocks = new Map()
  for (const row of rows) {
    if (!inScope(row)) continue
    const key = [row.taskId, row.model, row.reasoning, row.rep].join('|')
    blocks.set(key, { ...blocks.get(key), [row.arm]: counts(row) })
  }
  const all = [...blocks.values()]
  const total = (arm) => all.filter((block) => block[arm]).length
  const pair = (a, b) => {
    const onlyB = all.filter((block) => block[b] && !block[a]).length
    const onlyA = all.filter((block) => block[a] && !block[b]).length
    return `${b} only ${onlyB} / ${a} only ${onlyA}, p = ${mcnemar(onlyB, onlyA).toPrecision(2)}`
  }
  console.log(`${label.padEnd(46)} ${String(all.length).padStart(3)} blocks   ${ARMS.map((arm) => `${arm} ${total(arm)}`).join('   ')}`)
  console.log(`${''.padEnd(46)} ${pair('control', 'treatment')};  ${pair('control', 'required')}`)
}

console.log(`${rows.length} rows of harness ${[...new Set(rows.map((row) => row.harnessVersion))]} at commit ${[...new Set(rows.map((row) => row.gitCommit))]}\n`)
console.log('## Blocks solved')
compare('seven tasks plain Vitest can reach (B + C)', (row) => row.stratum !== CLOSED)
compare('three closed-module tasks (A)', (row) => row.stratum === CLOSED)
for (const task of [...new Set(rows.filter((row) => row.stratum === CLOSED).map((row) => row.taskId))].sort()) {
  compare(`  ${task}`, (row) => row.taskId === task)
}
compare('all ten tasks', () => true)
const strict = (row) => Boolean(row.solved) && row.validFixRobustness.notGreenCount === 0
compare('all ten, and the test accepts every valid fix', () => true, strict)
compare('  token-session, the same', (row) => row.taskId === 'token-session', strict)

console.log('\n## Trials in which the bug is fixed (the hidden grader passes), whatever the regression test is like')
for (const arm of ARMS) {
  const mine = rows.filter((row) => row.arm === arm)
  console.log(`${arm.padEnd(10)} ${mine.filter((row) => row.oraclePass).length} of ${mine.length}`)
}
const unsolved = rows.filter((row) => row.arm === 'control' && !row.solved)
console.log(`control, not solved: ${unsolved.length}, of them with the bug fixed ${unsolved.filter((row) => row.oraclePass).length}, with a regression test that does not pin the bug ${unsolved.filter((row) => row.reproduction === 'inadequate').length}`)

console.log('\n## Trials whose final test uses the library')
for (const arm of ARMS) {
  const mine = rows.filter((row) => row.arm === arm)
  const used = (set) => `${set.filter((row) => row.usesExecutionPoints).length} of ${set.length}`
  console.log(`${arm.padEnd(10)} ${used(mine).padEnd(12)} closed-module ${used(mine.filter((row) => row.stratum === CLOSED)).padEnd(12)} the other seven ${used(mine.filter((row) => row.stratum !== CLOSED))}`)
}

/** What a broken run says, in the library's own words. */
function reason(result) {
  if (result.outcome === 'timeout') return 'the test timed out'
  const summary = result.summary ?? ''
  const matched = /must match exactly 1 expression; matched (\d+)/.exec(summary)
  if (matched) return matched[1] === '0' ? 'select matched 0 expressions' : 'select matched 2 or more expressions'
  if (/ran 0 times|expected at least once/.test(summary)) return 'the replacement never ran'
  if (/without reaching|nothing was paused/.test(summary)) return 'the pause was never reached'
  return `${result.outcome}: ${summary.replace(/\s+/g, ' ').slice(0, 80)}`
}

const libraryTests = rows.filter((row) => row.arm !== 'control' && row.adequateReproduction && row.usesExecutionPoints)
for (const [title, field, fine] of [
  ['Buggy refactors that a library test stopped testing', 'refactorRobustness', 'true_red'],
  ['Valid fixes that a library test rejected', 'validFixRobustness', 'true_green'],
]) {
  const broken = new Map()
  // How many library tests met each variant at all.
  const met = new Map()
  let checks = 0
  for (const row of libraryTests) {
    for (const result of row[field].results) {
      checks += 1
      const variant = `${row.taskId} / ${result.id}`
      met.set(variant, (met.get(variant) ?? 0) + 1)
      if (result.outcome === fine) continue
      const key = `${reason(result).padEnd(38)} ${variant}`
      broken.set(key, { n: (broken.get(key)?.n ?? 0) + 1, variant })
    }
  }
  const count = [...broken.values()].reduce((sum, each) => sum + each.n, 0)
  console.log(`\n## ${title}: ${count} of ${checks} (${((100 * count) / checks).toFixed(1)}%), adequate reproductions that use the library`)
  for (const [key, { n, variant }] of [...broken].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${String(n).padStart(5)} of ${String(met.get(variant)).padStart(3)} tests  ${key}`)
  }
}
for (const [title, field, key] of [
  ['buggy refactors stopped testing', 'refactorRobustness', 'stoppedTestingCount'],
  ['valid fixes rejected', 'validFixRobustness', 'notGreenCount'],
]) {
  const control = rows.filter((row) => row.arm === 'control' && row.adequateReproduction)
  const sum = (pick) => control.reduce((total, row) => total + pick(row[field]), 0)
  console.log(`${field === 'refactorRobustness' ? '\n' : ''}Control, ${title}: ${sum((each) => each[key])} of ${sum((each) => each.total)}`)
}

// The selectors themselves: what do the library tests compare to say which expression they mean?
const compared = new Map()
let selections = 0
let files = 0
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.name === 'node_modules' ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.test.ts') ? [join(dir, entry.name)] : [],
  )
for (const rep of [1, 2, 3, 4, 5]) {
  const trials = join(base, `rep${rep}/trials`)
  for (const trial of readdirSync(trials)) {
    if (trial.includes('__control__') || !existsSync(join(trials, trial, 'src'))) continue
    for (const file of walk(join(trials, trial, 'src'))) {
      const source = readFileSync(file, 'utf8')
      const found = [...source.matchAll(/select\(\s*['"][^'"]+['"]\s*,\s*([\s\S]{0,400}?)\)\s*(?:\.|\n|;)/g)]
      if (found.length) files += 1
      for (const [, visitor] of found) {
        selections += 1
        const names = new Set(visitor.match(/\.(kind|callee|operator|object|inFunction|nth|id|name)\b/g) ?? [])
        if (visitor.includes('traverse(')) names.add('traverse()')
        for (const name of names) compared.set(name, (compared.get(name) ?? 0) + 1)
      }
    }
  }
}
console.log(`\n## What ${selections} selections in ${files} library test files compare`)
for (const [name, n] of [...compared].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${name.replace(/^\./, '')}`)
