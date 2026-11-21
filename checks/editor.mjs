import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import config from '../points.config.mjs'
import { buildPlan } from '../src/discovery.mjs'
import { analyzeEditor } from '../src/editor-service.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testFile = join(root, 'examples/checkout.test.ts')
const appFile = join(root, 'examples/checkout.ts')
const testSource = await readFile(testFile, 'utf8')
const appSource = await readFile(appFile, 'utf8')
const baselinePlan = buildPlan(config)
const sourceFiles = [...new Set([
  ...baselinePlan.tests.map(test => test.file),
  ...baselinePlan.targets.map(target => target.file),
])]
const originalBytes = new Map(await Promise.all(sourceFiles.map(async file => [file, await readFile(file)])))
const sourceDirectories = new Map(await Promise.all(
  [...new Set(sourceFiles.map(dirname))].map(async directory => [directory, (await readdir(directory)).sort()]),
))
let verified = 0

function passed(name) {
  verified += 1
  console.log(`PASS ${name}`)
}

function replaceOnce(source, needle, replacement) {
  const position = source.indexOf(needle)
  assert.notEqual(position, -1, `Missing editor fixture marker: ${needle}`)
  assert.equal(source.indexOf(needle, position + needle.length), -1, `Ambiguous editor fixture marker: ${needle}`)
  return source.slice(0, position) + replacement + source.slice(position + needle.length)
}

function diagnosticsText(result) {
  return result.diagnostics.map(diagnostic =>
    `${relative(root, diagnostic.fileName ?? root)} TS${diagnostic.code}: ${diagnostic.text}`,
  ).join('\n')
}

function analyze(options = {}) {
  // Exercise the same JSON-compatible boundary used by the editor worker.
  return JSON.parse(JSON.stringify(analyzeEditor(config, options)))
}

function tokenPosition(source, occurrence, token) {
  const start = source.indexOf(occurrence)
  assert.notEqual(start, -1, `Missing editor query fixture: ${occurrence}`)
  const tokenStart = start + occurrence.lastIndexOf(token)
  return { start: tokenStart, end: tokenStart + token.length, position: tokenStart + 1 }
}

function assertHover(result, token, source) {
  assert.equal(result.projected, true, diagnosticsText(result))
  assert.ok(result.queryResult?.text, `No hover result:\n${diagnosticsText(result)}`)
  assert.equal(result.queryResult.start, token.start, 'Hover must begin at the authored token, not its virtual position')
  assert.equal(result.queryResult.end, token.end, 'Hover must end at the authored token, not its virtual position')
  assert.equal(source.slice(result.queryResult.start, result.queryResult.end), source.slice(token.start, token.end))
  return result.queryResult.text
}

const regionToken = tokenPosition(testSource, '/* captured-region */ locals.region', 'region')
const regionHover = analyze({ query: { kind: 'hover', fileName: testFile, position: regionToken.position } })
assert.equal(regionHover.diagnostics.length, 0, diagnosticsText(regionHover))
assert.deepEqual([...regionHover.files].sort(), [...sourceFiles].sort())
const regionText = assertHover(regionHover, regionToken, testSource)
assert.match(regionText, /["']EU["']/)
assert.match(regionText, /["']US["']/)
passed('hover reports the captured region union at its authored source position')

const userToken = tokenPosition(testSource, 'expect(locals.user.id)', 'user')
const userHover = analyze({ query: { kind: 'hover', fileName: testFile, position: userToken.position } })
const userText = assertHover(userHover, userToken, testSource)
assert.match(userText, /\bUser\b|\bid\s*:/)
assert.doesNotMatch(userText, /\bnull\b|\bundefined\b/)
passed('hover preserves the application guard that narrows user to a non-null value')

const incompleteSource = replaceOnce(
  testSource,
  '/* captured-region */ locals.region',
  '/* captured-region */ locals.',
)
const completionPosition = incompleteSource.indexOf('/* captured-region */ locals.')
  + '/* captured-region */ locals.'.length
const completion = analyze({
  overrides: new Map([[testFile, incompleteSource]]),
  query: { kind: 'completion', fileName: testFile, position: completionPosition },
})
assert.equal(completion.projected, true, diagnosticsText(completion))
assert.ok(completion.queryResult?.entries, 'Incomplete unsaved source must still support completions')
const completionNames = new Set(completion.queryResult.entries.map(entry => entry.name))
for (const name of ['region', 'user', 'attempt']) assert.ok(completionNames.has(name), `Missing ${name} completion`)
for (const entry of completion.queryResult.entries) {
  if (entry.start !== undefined) assert.equal(entry.start, completionPosition)
  if (entry.end !== undefined) assert.equal(entry.end, completionPosition)
}
passed('an unsaved incomplete locals. expression offers captured bindings with valid insertion ranges')

const invalidReturn = '// This comment exists only in an unsaved editor buffer.\n\n' + replaceOnce(
  testSource,
  '/* invalid-return */ 7',
  '/* invalid-return */ "not a number"',
)

function assertInvalidReturn(result) {
  assert.equal(result.projected, true, diagnosticsText(result))
  const handler = invalidReturn.indexOf('({ locals }) => {')
  assert.notEqual(handler, -1)
  const expectedLine = invalidReturn.slice(0, handler).split('\n').length
  const errors = result.diagnostics.filter(diagnostic => diagnostic.code === 2345
    && diagnostic.fileName && resolve(diagnostic.fileName) === testFile)
  assert.ok(errors.length, `Expected TS2345 in the unsaved test:\n${diagnosticsText(result)}`)
  assert.ok(errors.some(diagnostic =>
    invalidReturn.slice(0, diagnostic.start).split('\n').length === expectedLine
      && diagnostic.start <= handler && diagnostic.end > handler,
  ), `Diagnostic must point to the authored unsaved handler line ${expectedLine}`)
  assert.ok(errors.some(diagnostic => /not assignable/i.test(diagnostic.text)))
}

assertInvalidReturn(analyze({ overrides: new Map([[testFile, invalidReturn]]) }))
passed('an invalid unsaved replacement is rejected on the correct authored line')

const narrowedApp = replaceOnce(
  appSource,
  'const region = order.region',
  'const region = order.region\n  if (region !== "EU") throw new Error("EU only in this unsaved buffer")',
)
const narrowedHover = analyze({
  overrides: new Map([[appFile, narrowedApp]]),
  query: { kind: 'hover', fileName: testFile, position: regionToken.position },
})
const narrowedText = assertHover(narrowedHover, regionToken, testSource)
assert.match(narrowedText, /["']EU["']/)
assert.doesNotMatch(narrowedText, /["']US["']/)
passed('unsaved application narrowing updates the inferred type in the test')

const unrelated = analyze({
  overrides: new Map([[join(root, 'excluded-editor-buffer.ts'), 'const unrelated: string = 123\n']]),
})
assert.equal(unrelated.projected, true, diagnosticsText(unrelated))
assert.equal(unrelated.diagnostics.length, 0, diagnosticsText(unrelated))
passed('an unrelated open buffer does not become a new compiler root')

const selector = testSource.match(/\bquery:\s*'[^']*'/)?.[0]
assert.ok(selector, 'The fixture must contain a literal query')
const malformedSelector = replaceOnce(testSource, selector, "query: 'CallExpression['")
assert.throws(() => analyze({
  overrides: new Map([[testFile, malformedSelector]]),
  query: { kind: 'hover', fileName: testFile, position: regionToken.position },
}), /Invalid AST selector/i)
passed('a malformed selector fails instead of returning an earlier type contract')

await verifyWorker()
passed('the JSONL worker frames requests, uses unsaved buffers, and clears failed query results')

for (const [file, bytes] of originalBytes) {
  assert.deepEqual(await readFile(file), bytes, `Editor queries modified ${relative(root, file)}`)
}
for (const [directory, entries] of sourceDirectories) {
  assert.deepEqual((await readdir(directory)).sort(), entries, 'Editor queries must not write generated companion files')
}
passed('authored source files stay unchanged and no companion files are generated')

console.log(`Verified ${verified} editor behaviors.`)

async function verifyWorker() {
  const child = spawn(process.execPath, [join(root, 'src/editor-worker.mjs'), root], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const waiting = new Map()
  let stderr = ''
  let protocolError
  let closing = false
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000) })
  const rejectWaiting = error => {
    for (const pending of waiting.values()) pending.reject(error)
    waiting.clear()
  }
  const output = createInterface({ input: child.stdout, crlfDelay: Infinity })
  output.on('line', line => {
    try {
      const response = JSON.parse(line)
      const pending = waiting.get(response.id)
      assert.ok(pending, `Unexpected worker response id: ${response.id}`)
      waiting.delete(response.id)
      pending.resolve(response)
    } catch (error) {
      protocolError = error
      rejectWaiting(error)
    }
  })
  child.on('error', error => { protocolError = error; rejectWaiting(error) })
  const exited = new Promise(resolveExit => child.on('exit', (code, signal) => {
    if (!closing) rejectWaiting(new Error(`Editor worker exited before completing requests (${code ?? signal}).\n${stderr}`))
    resolveExit()
  }))

  function responseFor(id) {
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        rejectResponse(new Error(`Timed out waiting for editor response ${id}.\n${stderr}`))
      }, 20_000)
      waiting.set(id, {
        resolve: response => { clearTimeout(timer); resolveResponse(response) },
        reject: error => { clearTimeout(timer); rejectResponse(error) },
      })
    })
  }

  try {
    const firstResponse = responseFor('split-hover')
    const firstRequest = JSON.stringify({
      id: 'split-hover', method: 'hover', fileName: testFile, position: regionToken.position,
      overrides: [[appFile, narrowedApp]],
    })
    const split = Math.floor(firstRequest.length / 2)
    child.stdin.write(firstRequest.slice(0, split))
    await new Promise(resolveNext => setImmediate(resolveNext))
    child.stdin.write(firstRequest.slice(split) + '\n')
    const first = await firstResponse
    assert.equal(first.error, undefined, first.error)
    assert.match(first.result.queryResult.text, /["']EU["']/)
    assert.doesNotMatch(first.result.queryResult.text, /["']US["']/)

    const invalidResponse = responseFor('unsaved-error')
    const malformedResponse = responseFor('malformed-query')
    // Two complete requests in one write exercise line framing as well as IDs.
    child.stdin.write([
      { id: 'unsaved-error', method: 'analyze', overrides: [[testFile, invalidReturn]] },
      { id: 'malformed-query', method: 'hover', fileName: testFile, position: regionToken.position,
        overrides: [[testFile, malformedSelector]] },
    ].map(request => JSON.stringify(request)).join('\n') + '\n')
    const [invalid, malformed] = await Promise.all([invalidResponse, malformedResponse])
    assert.equal(invalid.error, undefined, invalid.error)
    assertInvalidReturn(invalid.result)
    assert.match(malformed.error ?? '', /Invalid AST selector/i)
    assert.equal(malformed.result?.queryResult, undefined, 'A failed request must not reuse the previous hover')
    assert.equal(protocolError, undefined)
  } finally {
    closing = true
    child.stdin.end()
    const killTimer = setTimeout(() => child.kill(), 2000)
    await exited
    clearTimeout(killTimer)
    output.close()
    rejectWaiting(new Error('Editor worker verification finished'))
  }
}
