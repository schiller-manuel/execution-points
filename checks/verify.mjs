import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import config from '../points.config.mjs'
import { checkPlan } from '../src/compiler.mjs'
import { buildPlan } from '../src/discovery.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testFile = join(root, 'examples/checkout.test.ts')
const testSource = await readFile(testFile, 'utf8')
const before = await fingerprintProject()
let verified = 0

function replaceOnce(source, needle, replacement) {
  const start = source.indexOf(needle)
  assert.notEqual(start, -1, `Missing verification fixture marker: ${needle}`)
  assert.equal(
    source.indexOf(needle, start + needle.length),
    -1,
    `Verification fixture marker must be unique: ${needle}`,
  )
  return source.slice(0, start) + replacement + source.slice(start + needle.length)
}

function describeDiagnostics(diagnostics) {
  return diagnostics
    .map(({ fileName, code, text }) => `${relative(root, fileName ?? root)} ${code}: ${text}`)
    .join('\n')
}

async function analyze(overrides = new Map()) {
  const plan = await buildPlan({ ...config, overrides })
  return await checkPlan(plan, { overrides })
}

function passed(name) {
  verified += 1
  console.log(`PASS ${name}`)
}

async function rejectsTestSource(name, source, code, offendingText, messagePattern) {
  const result = await analyze(new Map([[testFile, source]]))
  assert.equal(result.ok, false, `${name}: an invalid callback was accepted`)
  const diagnostics = result.diagnostics.filter(
    (diagnostic) => diagnostic.code === code
      && typeof diagnostic.fileName === 'string'
      && resolve(diagnostic.fileName) === testFile,
  )
  assert.ok(
    diagnostics.length,
    `${name}: expected TS${code} in the test file\n${describeDiagnostics(result.diagnostics)}`,
  )
  assert.ok(
    diagnostics.some((diagnostic) => messagePattern.test(diagnostic.text)),
    `${name}: the diagnostic did not explain the intended error\n${describeDiagnostics(diagnostics)}`,
  )

  // Hidden type arguments shift the compiler's source positions. Verify that
  // diagnostics still identify the offending expression in the authored view.
  const start = source.indexOf(offendingText)
  assert.notEqual(start, -1, `${name}: missing invalid expression in fixture`)
  const end = start + offendingText.length
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.start < end && diagnostic.end > start),
    `${name}: the error was not mapped to the original test expression\n${describeDiagnostics(diagnostics)}`,
  )
  passed(name)
}

const valid = await analyze()
assert.equal(valid.ok, true, `Valid example failed:\n${describeDiagnostics(valid.diagnostics)}`)
assert.equal(valid.diagnostics.length, 0, describeDiagnostics(valid.diagnostics))
passed('the ordinary TypeScript example type-checks through the virtual compiler')

const invalidReturn = replaceOnce(
  testSource,
  '/* invalid-return */ 7',
  '/* invalid-return */ "not a number"',
)
await rejectsTestSource(
  'a replacement with the wrong result type is rejected',
  invalidReturn,
  2345,
  '({ locals }) => {',
  /not assignable/i,
)

const invalidLocal = replaceOnce(
  testSource,
  '/* captured-region */ locals.region',
  '/* captured-region */ locals.notCaptured',
)
await rejectsTestSource(
  'only explicitly captured locals are exposed',
  invalidLocal,
  2339,
  'locals.notCaptured',
  /notCaptured/,
)

const invalidAssignment = replaceOnce(
  testSource,
  '/* binding-check */',
  "/* binding-check */ locals.region = 'US';",
)
await rejectsTestSource(
  'captured bindings cannot be reassigned by the replacement',
  invalidAssignment,
  2540,
  "locals.region = 'US'",
  /read.only|cannot assign/i,
)

const captureLists = [...testSource.matchAll(/\bcapture\s*:\s*\[[^\]]*\]/g)]
  .filter(([list]) => /(['"])user\1/.test(list))
assert.equal(captureLists.length, 1, 'Expected one capture list containing user')
const captureList = captureLists[0][0]
const invalidCapture = replaceOnce(
  testSource,
  captureList,
  captureList.replace(/(['"])user\1/, "'missingLocal'"),
)
let captureError
let captureResult
try {
  captureResult = await analyze(new Map([[testFile, invalidCapture]]))
} catch (error) {
  captureError = error
}
const captureMessage = captureError
  ? String(captureError.message ?? captureError)
  : describeDiagnostics(captureResult.diagnostics)
assert.ok(
  captureError || captureResult.ok === false,
  'A nonexistent lexical binding was silently accepted',
)
assert.match(captureMessage, /missingLocal/, 'The error must name the unknown capture')
assert.match(
  captureMessage,
  /capture|scope|binding|cannot find|not found|unknown|unresolved|not defined|not accessible/i,
  'The error must explain why the capture cannot be used',
)
passed('a nonexistent capture fails with a useful diagnostic')

const after = await fingerprintProject()
const changed = [...new Set([...before.keys(), ...after.keys()])]
  .filter((file) => before.get(file) !== after.get(file))
assert.deepEqual(changed, [], 'Compiler checks must not create, remove, or modify project files')
assert.deepEqual(
  [...after.keys()].filter((file) => /(^|\/)\.generated(?:[./]|$)|\.generated\.[^/]+$/.test(file)),
  [],
  'The prototype must not leave generated contract files on disk',
)
passed('all project files stay unchanged and no generated contracts are written')

console.log(`Verified ${verified} compiler behaviors.`)

async function fingerprintProject() {
  const files = new Map()
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) {
        const hash = createHash('sha256').update(await readFile(absolute)).digest('hex')
        files.set(relative(root, absolute), hash)
      }
    }
  }
  await walk(root)
  return files
}
