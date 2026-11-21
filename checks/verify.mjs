import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import config from '../points.config.mjs'
import { checkPlan } from '../src/compiler.mjs'
import { buildPlan } from '../src/discovery.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tscBin = join(root, 'node_modules/typescript/bin/tsc')
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

async function analyze(overrides = new Map(), { tolerant = true } = {}) {
  const plan = await buildPlan({ ...config, overrides, tolerant })
  return await checkPlan(plan, { overrides })
}

function passed(name) {
  verified += 1
  console.log(`PASS ${name}`)
}

async function rejectsTestSource(name, source, expectedCodes, offendingText, messagePattern) {
  const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes]
  const result = await analyze(new Map([[testFile, source]]))
  assert.equal(result.ok, false, `${name}: an invalid callback was accepted`)
  const diagnostics = result.diagnostics.filter(
    (diagnostic) =>
      codes.includes(diagnostic.code) &&
      typeof diagnostic.fileName === 'string' &&
      resolve(diagnostic.fileName).toLowerCase() === testFile.toLowerCase(),
  )
  assert.ok(
    diagnostics.length,
    `${name}: expected TS${codes.join('/')} in the test file\n${describeDiagnostics(result.diagnostics)}`,
  )
  assert.ok(
    diagnostics.some((diagnostic) => messagePattern.test(diagnostic.text)),
    `${name}: the diagnostic did not explain the intended error\n${describeDiagnostics(diagnostics)}`,
  )

  const start = source.indexOf(offendingText)
  assert.notEqual(start, -1, `${name}: missing invalid expression in fixture`)
  const end = start + offendingText.length
  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.start < end && diagnostic.end > start),
    `${name}: the error was not mapped to the original test expression\n${describeDiagnostics(diagnostics)}`,
  )
  passed(name)
}

function positionOf(source, needle) {
  const index = source.indexOf(needle)
  assert.notEqual(index, -1, `Missing marker in source: ${needle}`)
  const beforeText = source.slice(0, index)
  const lines = beforeText.split('\n')
  return { line: lines.length - 1, character: lines[lines.length - 1].length }
}

async function verifyLsp() {
  const child = spawn(process.execPath, [tscBin, '--lsp', '--stdio'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let nextId = 1
  const pending = new Map()
  let buffer = Buffer.alloc(0)

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = buffer.subarray(0, headerEnd).toString('ascii')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) return
      const length = Number(match[1])
      if (buffer.length < headerEnd + 4 + length) return
      const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8'))
      buffer = buffer.subarray(headerEnd + 4 + length)
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve: res, reject: rej } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) rej(new Error(JSON.stringify(message.error)))
        else res(message.result)
      } else if (message.id !== undefined && message.method) {
        send({ jsonrpc: '2.0', id: message.id, result: null })
      }
    }
  })

  function send(payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }

  function request(method, params) {
    const id = nextId++
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej })
      send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    })
  }

  function notify(method, params) {
    send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  try {
    const rootUri = pathToFileURL(root).href
    const testUri = pathToFileURL(testFile).href

    await request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'execution-points' }],
      initializationOptions: { runExternalCode: true },
      capabilities: {
        textDocument: {
          diagnostic: { dynamicRegistration: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
    })
    notify('initialized', {})

    notify('textDocument/didOpen', {
      textDocument: { uri: testUri, languageId: 'typescript', version: 1, text: testSource },
    })

    const cleanDiag = await request('textDocument/diagnostic', {
      textDocument: { uri: testUri },
    })
    assert.equal(
      cleanDiag.items?.length ?? 0,
      0,
      `Expected 0 LSP diagnostics on valid checkout.test.ts, got:\n${JSON.stringify(cleanDiag.items, null, 2)}`,
    )
    passed('TypeScript 7.1 LSP (VS Code language server) typechecks checkout.test.ts natively with 0 errors')

    const userPos = positionOf(testSource, 'user.id')
    const userHover = await request('textDocument/hover', {
      textDocument: { uri: testUri },
      position: userPos,
    })
    const userHoverText = typeof userHover?.contents === 'string'
      ? userHover.contents
      : userHover?.contents?.value ?? ''
    assert.match(userHoverText, /\buser:\s*User\b/, `Expected hover on locals.user to show narrowed User type, got: ${userHoverText}`)

    const originalPos = positionOf(testSource, 'original()')
    const originalHover = await request('textDocument/hover', {
      textDocument: { uri: testUri },
      position: originalPos,
    })
    const originalHoverText = typeof originalHover?.contents === 'string'
      ? originalHover.contents
      : originalHover?.contents?.value ?? ''
    assert.match(originalHoverText, /Quote/, `Expected hover on original() to show Quote return type, got: ${originalHoverText}`)
    passed('VS Code LSP hover resolves real private User and Quote types directly from checkout.ts')

    // Edit buffer in-memory in LSP: mutate capture list to include nonexistent local & break return type
    const edited = replaceOnce(
      replaceOnce(testSource, "'user'", "'missingLocal'"),
      '/* invalid-return */ 7',
      '/* invalid-return */ "oops"',
    )
    notify('textDocument/didChange', {
      textDocument: { uri: testUri, version: 2 },
      contentChanges: [{ text: edited }],
    })
    const dirtyDiag = await request('textDocument/diagnostic', {
      textDocument: { uri: testUri },
    })
    const messages = (dirtyDiag.items ?? []).map((item) => item.message).join('\n')
    assert.match(messages, /missingLocal/, `Expected LSP to flag unknown capture immediately:\n${messages}`)
    assert.match(messages, /not assignable/i, `Expected LSP to flag wrong replacement return type:\n${messages}`)
    passed('VS Code LSP immediately flags unknown captures and wrong replacement return types on keystrokes')

    // Check capture autocomplete in VS Code LSP (includes in-scope 'order' even though not yet captured!)
    const capturePos = positionOf(testSource, "'region'")
    const completions = await request('textDocument/completion', {
      textDocument: { uri: testUri },
      position: { line: capturePos.line, character: capturePos.character + 1 },
    })
    const completionLabels = (Array.isArray(completions) ? completions : completions?.items ?? []).map((item) => item.label)
    for (const expectedLocal of ['attempt', 'order', 'region', 'user']) {
      assert.ok(
        completionLabels.includes(expectedLocal),
        `Expected capture autocomplete to include "${expectedLocal}", got: ${JSON.stringify(completionLabels)}`,
      )
    }
    passed('VS Code LSP autocompletes all in-scope local bindings inside capture: [...]')

    await request('shutdown')
    notify('exit')
  } finally {
    child.kill()
  }
}

// 1. Real CLI tsc --noEmit --runExternalCode
const tscResult = await execFileAsync(process.execPath, [tscBin, '--noEmit', '--runExternalCode'], {
  cwd: root,
})
assert.equal(tscResult.stdout.trim(), '')
assert.equal(tscResult.stderr.trim(), '')
passed('regular `tsc --noEmit --runExternalCode` typechecks the entire repository natively')

// 2. Real TypeScript 7.1 LSP (VS Code language server)
await verifyLsp()

// 3. Programmatic checkPlan verification
const valid = await analyze()
assert.equal(valid.ok, true, `Valid example failed:\n${describeDiagnostics(valid.diagnostics)}`)
assert.equal(valid.diagnostics.length, 0, describeDiagnostics(valid.diagnostics))
passed('the ordinary TypeScript example type-checks through the shared registry compiler')

const originalPlan = buildPlan(config)
const originalPoints = originalPlan.tests.find((test) => test.file === testFile).points
assert.ok(originalPoints.length > 0, 'The fixture must include a real imported point declaration')
const shadowedSource =
  testSource +
  `
function ordinaryLocalPointUsage() {
  function point(value: string) { return value }
  return point('ordinary local call')
}
`
const shadowedPlan = buildPlan({ ...config, overrides: new Map([[testFile, shadowedSource]]) })
assert.deepEqual(
  shadowedPlan.tests.find((test) => test.file === testFile).points,
  originalPoints,
  'A nested function named point must not be treated as the imported execution-point API',
)
assert.deepEqual(shadowedPlan.targets, originalPlan.targets)
passed('a shadowed local point function is ignored while the imported point remains discoverable')

const invalidReturn = replaceOnce(
  testSource,
  '/* invalid-return */ 7',
  '/* invalid-return */ "not a number"',
)
await rejectsTestSource(
  'a replacement with the wrong result type is rejected',
  invalidReturn,
  [2345, 2322],
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

const uncapturedInScopeLocal = replaceOnce(
  testSource,
  '/* captured-region */ locals.region',
  '/* captured-region */ locals.order',
)
await rejectsTestSource(
  'in-scope locals not listed in capture remain hidden from locals',
  uncapturedInScopeLocal,
  2339,
  'locals.order',
  /order/,
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

const captureLists = [...testSource.matchAll(/\bcapture\s*:\s*\[[^\]]*\]/g)].filter(([list]) =>
  /(['"])user\1/.test(list),
)
assert.equal(captureLists.length, 1, 'Expected one capture list containing user')
const captureList = captureLists[0][0]
const invalidCapture = replaceOnce(testSource, captureList, captureList.replace(/(['"])user\1/, "'missingLocal'"))
await rejectsTestSource(
  'a nonexistent capture fails directly on the capture literal with valid local names',
  invalidCapture,
  [2322, 2345],
  "'missingLocal'",
  /missingLocal/,
)

const badSelector = replaceOnce(
  testSource,
  'CallExpression[expression.name.escapedText="send"]',
  'CallExpression[expression.name.escapedText="doesNotExist"]',
)
await rejectsTestSource(
  'an invalid selector reports the discovery error directly on the point() call',
  badSelector,
  2345,
  "file: 'examples/checkout.ts'",
  /matched 0/i,
)

const after = await fingerprintProject()
const changed = [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file))
assert.deepEqual(changed, [], 'Compiler checks must not create, remove, or modify project files')
assert.deepEqual(
  [...after.keys()].filter((file) => /(^|\/)\.generated(?:[./]|$)|\.generated\.[^/]+$/.test(file)),
  [],
  'The prototype must not leave generated contract files on disk',
)
passed('all project files stay unchanged and no generated contracts are written')

console.log(`Verified ${verified} compiler and editor behaviors.`)

async function fingerprintProject() {
  const files = new Map()
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    )
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
