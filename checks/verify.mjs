import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { API, ModuleKind, ModuleResolutionKind } from 'typescript/sync'
import { createFileSystemLayer } from 'typescript/fs'
import { ScriptTarget } from 'typescript/ast'

import { generateFileRegistryModule } from '../src/contracts.mjs'
import { buildTargetPlan, loadManifest } from '../src/discovery.mjs'

const execFileAsync = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const config = loadManifest(root)
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

function analyze(overrides = new Map()) {
  const api = new API({ cwd: root })
  let snapshot
  try {
    const plan = buildTargetPlan({ ...config, overrides, api })
    const virtualRegistryFile = join(root, '__execution_points_registry.d.ts')
    const { text: registryText } = generateFileRegistryModule(plan, { fromFile: virtualRegistryFile, api, overrides })
    const tsCfg = existsSync(plan.tsconfig) ? api.parseConfigFile(plan.tsconfig) : undefined
    const compilerOptions = {
      strict: true,
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      ...tsCfg?.options,
      noEmit: true,
      declaration: false,
      emitDeclarationOnly: false,
      incremental: false,
      composite: false,
    }
    const files = new Map([[virtualRegistryFile, registryText]])
    for (const f of plan.files) files.set(f.file, f.source)
    for (const [f, s] of overrides) files.set(f, s)

    const rootFiles = [...new Set([...(tsCfg?.fileNames ?? []).filter((f) => !f.endsWith('.ep')), ...files.keys()])]
    snapshot = api.createSnapshot({
      fileSystem: createFileSystemLayer([...files]),
      createPrograms: [{ rootFiles, compilerOptions }],
    })
    const prog = snapshot.operation.createdPrograms[0]
    const diagnostics = [
      ...(tsCfg?.errors ?? []).filter((d) => d.code !== 18068),
      ...prog.getProgramDiagnostics(),
      ...prog.getGlobalDiagnostics(),
      ...prog.getSyntacticDiagnostics(),
      ...prog.getBindDiagnostics(),
      ...prog.getSemanticDiagnostics(),
    ]
      .filter((d) => d.category === 1)
      .map((d) => ({
        fileName: d.fileName,
        start: Math.max(0, d.pos ?? d.start ?? 0),
        end: Math.max(0, d.end ?? d.pos ?? d.start ?? 0),
        code: d.code,
        text: [d.text ?? 'TypeScript reported an error.', ...(d.messageChain ?? []).map((c) => c.text)].join('\n'),
      }))
    return { ok: diagnostics.length === 0, diagnostics }
  } finally {
    snapshot?.dispose()
    api.close()
  }
}

function passed(name) {
  verified += 1
  console.log(`PASS ${name}`)
}

async function rejectsTestSource(name, source, expectedCodes, offendingText, messagePattern) {
  const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes]
  const result = analyze(new Map([[testFile, source]]))
  assert.equal(result.ok, false, `${name}: an invalid test was accepted`)
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

  const send = (payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    child.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]))
  }
  const request = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++
      pending.set(id, { resolve: res, reject: rej })
      send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params })
    })
  const notify = (method, params) => {
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

    const cleanDiag = await request('textDocument/diagnostic', { textDocument: { uri: testUri } })
    assert.equal(
      cleanDiag.items?.length ?? 0,
      0,
      `Expected 0 LSP diagnostics on valid checkout.test.ts, got:\n${JSON.stringify(cleanDiag.items, null, 2)}`,
    )
    passed('TypeScript 7.1 LSP typechecks both select() and fromFile() natively with 0 errors')

    const userHover = await request('textDocument/hover', {
      textDocument: { uri: testUri },
      position: positionOf(testSource, 'user.id'),
    })
    const userHoverText = typeof userHover?.contents === 'string' ? userHover.contents : userHover?.contents?.value ?? ''
    assert.match(userHoverText, /\buser:\s*User\b/, `Expected hover on locals.user to show narrowed User type, got: ${userHoverText}`)

    const originalHover = await request('textDocument/hover', {
      textDocument: { uri: testUri },
      position: positionOf(testSource, 'original()'),
    })
    const originalHoverText = typeof originalHover?.contents === 'string' ? originalHover.contents : originalHover?.contents?.value ?? ''
    assert.match(originalHoverText, /Quote/, `Expected hover on original() to show Quote return type, got: ${originalHoverText}`)
    passed('VS Code LSP hover resolves real private User and Quote types directly from checkout.ts')

    // Autocomplete in select() while typing new string arguments (exact VS Code editing UX!)
    const typingText = replaceOnce(
      testSource,
      "node.capture('region', 'user', 'attempt')",
      "node.capture('region', '')",
    )
    notify('textDocument/didChange', {
      textDocument: { uri: testUri, version: 2 },
      contentChanges: [{ text: typingText }],
    })

    const capturePos = positionOf(typingText, "node.capture('region', '')")
    const captureCompletions = await request('textDocument/completion', {
      textDocument: { uri: testUri },
      position: { line: capturePos.line, character: capturePos.character + "node.capture('region', '".length },
    })
    const captureLabels = (Array.isArray(captureCompletions) ? captureCompletions : captureCompletions?.items ?? []).map((i) => i.label)
    for (const name of ['attempt', 'order', 'region', 'user']) {
      assert.ok(captureLabels.includes(name), `Expected capture autocomplete to include "${name}", got: ${JSON.stringify(captureLabels)}`)
    }
    passed('VS Code LSP autocompletes in-scope locals in select()')

    // Instant keystroke check: unknown capture + wrong return + ambiguous visitor
    const edited = replaceOnce(
      replaceOnce(testSource, "'user', 'attempt'", "'missingLocal', 'attempt'"),
      '/* invalid-return */ 7',
      '/* invalid-return */ "oops"',
    )
    notify('textDocument/didChange', {
      textDocument: { uri: testUri, version: 3 },
      contentChanges: [{ text: edited }],
    })
    const dirtyDiag = await request('textDocument/diagnostic', { textDocument: { uri: testUri } })
    const messages = (dirtyDiag.items ?? []).map((item) => item.message).join('\n')
    assert.match(messages, /missingLocal/, `Expected LSP to flag unknown capture immediately:\n${messages}`)
    assert.match(messages, /not assignable/i, `Expected LSP to flag wrong return type:\n${messages}`)
    passed('VS Code LSP immediately flags invalid captures and return types on keystrokes')

    await request('shutdown')
    notify('exit')
  } finally {
    child.kill()
  }
}

// 1. Real CLI tsc --noEmit --runExternalCode
const tscResult = await execFileAsync(process.execPath, [tscBin, '--noEmit', '--runExternalCode'], { cwd: root })
assert.equal(tscResult.stdout.trim(), '')
assert.equal(tscResult.stderr.trim(), '')
passed('regular `tsc --noEmit --runExternalCode` typechecks both APIs natively')

// 2. Real TypeScript 7.1 LSP (VS Code language server)
await verifyLsp()

// 3. Negative type-safety checks
const valid = analyze()
assert.equal(valid.ok, true, `Valid example failed:\n${describeDiagnostics(valid.diagnostics)}`)
passed('valid select() and fromFile() examples typecheck through the file schema')

await rejectsTestSource(
  'a replacement with the wrong result type is rejected',
  replaceOnce(testSource, '/* invalid-return */ 7', '/* invalid-return */ "not a number"'),
  [2345, 2322],
  '({ locals }) => {',
  /not assignable/i,
)

await rejectsTestSource(
  'only explicitly captured locals are exposed',
  replaceOnce(testSource, '/* captured-region */ locals.region', '/* captured-region */ locals.notCaptured'),
  2339,
  'locals.notCaptured',
  /notCaptured/,
)

await rejectsTestSource(
  'in-scope locals not listed in capture remain hidden from locals',
  replaceOnce(testSource, '/* captured-region */ locals.region', '/* captured-region */ locals.order'),
  2339,
  'locals.order',
  /order/,
)

await rejectsTestSource(
  'captured bindings cannot be reassigned by the replacement',
  replaceOnce(testSource, '/* binding-check */', "/* binding-check */ locals.region = 'US';"),
  2540,
  "locals.region = 'US'",
  /read.only|cannot assign/i,
)

await rejectsTestSource(
  'an unknown capture name is rejected at the capture() call',
  replaceOnce(testSource, "'user', 'attempt'", "'missingLocal', 'attempt'"),
  2345,
  "'missingLocal'",
  /missingLocal/,
)

await rejectsTestSource(
  'an ambiguous select() visitor (matching 2+ nodes) is rejected at compile time',
  replaceOnce(
    testSource,
    "if (node.inFunction === 'checkout' && node.kind === 'CallExpression' && node.callee === 'send')",
    "if (node.inFunction === 'checkout')",
  ),
  2339,
  'quotePoint.withReplacement',
  /multiple expressions|withReplacement/i,
)

await rejectsTestSource(
  'a nonexistent callee in select() is rejected at compile time by TS narrowing',
  replaceOnce(testSource, "node.callee === 'send'", "node.callee === 'doesNotExist'"),
  2367,
  "node.callee === 'doesNotExist'",
  /no overlap/i,
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
