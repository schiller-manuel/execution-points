'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const { pathToFileURL, fileURLToPath } = require('node:url')
const { createRequire } = require('node:module')

const root = path.resolve('/virtual workspace')
const testFile = path.join(root, 'example.test.ts')
const appFile = path.join(root, 'app.ts')
const configFile = path.join(root, 'points.config.mjs')
const requireHere = createRequire(__filename)

function event() {
  const listeners = new Set()
  return {
    on(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener) } } },
    fire(value) { for (const listener of listeners) listener(value) },
  }
}

class Position {
  constructor(line, character) { Object.assign(this, { line, character }) }
}
class Range {
  constructor(line, character, endLine, endCharacter) {
    this.start = new Position(line, character)
    this.end = new Position(endLine, endCharacter)
  }
}
class Uri {
  constructor(url) { this.url = url; this.scheme = new URL(url).protocol.slice(0, -1); this.fsPath = this.scheme === 'file' ? fileURLToPath(url) : '' }
  toString() { return this.url }
  static file(file) { return new Uri(pathToFileURL(file).href) }
  static parse(uri) { return new Uri(uri) }
}

function document(fileName, text) {
  return {
    fileName, uri: Uri.file(fileName), version: 1, text,
    getText() { return this.text },
    positionAt(offset) {
      const prefix = this.text.slice(0, Math.max(0, offset))
      const lines = prefix.split('\n')
      return new Position(lines.length - 1, lines.at(-1).length)
    },
    offsetAt(position) {
      const lines = this.text.split('\n')
      return lines.slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character
    },
  }
}

async function host(respond, options = {}) {
  const methods = new Map()
  const commands = new Map()
  const diagnosticItems = new Map()
  const messages = []
  const logs = []
  const requests = []
  const spawns = []
  const documents = [document(testFile, '// 😀\nlocals.region\n'), document(appFile, 'export const value = 1\n')]
  const events = Object.fromEntries(['open', 'change', 'save', 'close', 'folders', 'configuration'].map(name => [name, event()]))
  const subscriptions = []
  const nativeAPI = {
    registerLspMiddleware(name, callback) { methods.set(name, callback); return { dispose() { methods.delete(name) } } },
    onLanguageServerInitialized() { return { dispose() {} } },
  }
  const vscode = {
    Position, Range, Uri,
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }) } },
    DiagnosticSeverity: { Error: 0 },
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }) } },
    workspace: {
      isTrusted: options.trusted !== false,
      workspaceFolders: [{ uri: Uri.file(root), name: 'fixture', index: 0 }],
      textDocuments: documents,
      getConfiguration() { return { get() { return '/Node with spaces/bin/node' } } },
      createFileSystemWatcher() {
        return { onDidChange: event().on, onDidCreate: event().on, onDidDelete: event().on, dispose() {} }
      },
      onDidOpenTextDocument: events.open.on,
      onDidChangeTextDocument: events.change.on,
      onDidSaveTextDocument: events.save.on,
      onDidCloseTextDocument: events.close.on,
      onDidChangeWorkspaceFolders: events.folders.on,
      onDidChangeConfiguration: events.configuration.on,
    },
    languages: {
      createDiagnosticCollection() {
        return {
          set(uri, items) { diagnosticItems.set(uri.fsPath, items) },
          delete(uri) { diagnosticItems.delete(uri.fsPath) },
          dispose() { diagnosticItems.clear() },
        }
      },
    },
    window: {
      createOutputChannel() { return { appendLine: line => logs.push(line), append: line => logs.push(line), show() {}, dispose() {} } },
      showErrorMessage: message => messages.push(message),
      showInformationMessage: message => messages.push(message),
    },
    commands: {
      registerCommand(name, callback) { commands.set(name, callback); return { dispose() { commands.delete(name) } } },
    },
    extensions: { getExtension() { return { activate: async () => nativeAPI } } },
  }
  const fakeFs = { existsSync: file => file === configFile || file === path.join(root, 'src', 'editor-worker.mjs'), readFileSync: () => '' }
  const fakeProcesses = {
    spawn(executable, args, options) {
      const child = new EventEmitter()
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), killed: false })
      child.stdin = new Writable({ write(chunk, encoding, callback) {
        const request = JSON.parse(chunk.toString())
        requests.push(request)
        Promise.resolve().then(() => respond(request)).then(
          result => { if (!child.killed) child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n') },
          error => { if (!child.killed) child.stdout.write(JSON.stringify({ id: request.id, error: error.message }) + '\n') },
        )
        callback()
      } })
      child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); child.emit('exit', null, 'SIGTERM') }
      spawns.push({ executable, args, options, child })
      return child
    },
  }
  const module = { exports: {} }
  const load = vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(path.join(__dirname, 'extension.cjs'), 'utf8')}\n})`, { filename: 'extension.cjs' })
  load(name => name === 'vscode' ? vscode : name === 'node:fs' ? fakeFs : name === 'node:child_process' ? fakeProcesses : requireHere(name), module, module.exports)
  await module.exports.activate({ subscriptions })
  return {
    methods, commands, diagnosticItems, messages, logs, requests, spawns, documents, events,
    async check() { await commands.get('executionPoints.check')() },
    context(position = { line: 1, character: 7 }, file = testFile) { return { params: { textDocument: { uri: Uri.file(file).toString() }, position } } },
    dispose() { for (const subscription of subscriptions.reverse()) subscription.dispose() },
  }
}

const report = extra => ({ projected: true, files: [testFile, appFile], diagnostics: [], ...extra })
const tick = () => new Promise(resolve => setImmediate(resolve))

test('publishes complete mapped diagnostics, includes unsaved buffers, and only suppresses owned native reports', async t => {
  const environment = await host(() => report({ diagnostics: [{ fileName: testFile, start: 7, end: 13, code: 2339, text: 'Property does not exist.' }] }))
  t.after(() => environment.dispose())
  await environment.check()
  const diagnostic = environment.diagnosticItems.get(testFile)[0]
  assert.equal(diagnostic.code, 2339)
  assert.equal(diagnostic.source, 'execution-points')
  assert.equal(diagnostic.range.start.line, 1)
  assert.equal(environment.requests[0].overrides.find(([file]) => file === testFile)[1], environment.documents[0].text)
  assert.equal(environment.spawns[0].executable, '/Node with spaces/bin/node')
  assert.deepEqual(environment.spawns[0].args, [path.join(root, 'src', 'editor-worker.mjs'), root])
  assert.notEqual(environment.spawns[0].options.shell, true)

  const original = { kind: 'full', items: [{ message: 'Misleading never error.' }] }
  const middleware = environment.methods.get('textDocument/diagnostic')
  assert.deepEqual(await middleware(original, environment.context()), { kind: 'full', items: [] })
  assert.equal(await middleware(original, environment.context(undefined, path.join(root, 'other.ts'))), original)
  assert.equal(environment.requests.length, 1, 'identical document revisions reuse analysis')
})

test('maps hover and completion positions through the authored document, including UTF-16 offsets', async t => {
  const environment = await host(request => report({ queryResult: request.method === 'hover'
    ? { text: 'region: "EU"', start: 13, end: 19 }
    : request.method === 'completion' ? { entries: [{ name: 'region', kind: 10, sortText: '11', start: 13, end: 19 }] } : undefined }))
  t.after(() => environment.dispose())
  await environment.check()
  const hover = await environment.methods.get('textDocument/hover')(null, environment.context())
  assert.deepEqual(hover.contents, { language: 'typescript', value: 'region: "EU"' })
  assert.deepEqual(hover.range, { start: { line: 1, character: 7 }, end: { line: 1, character: 13 } })
  assert.equal(environment.requests.find(request => request.method === 'hover').position, 13)
  const completion = await environment.methods.get('textDocument/completion')(null, environment.context())
  assert.equal(completion.items[0].kind, 10)
  assert.deepEqual(completion.items[0].textEdit.range, hover.range)
  assert.equal(completion.items[0].textEdit.newText, 'region')
})

test('discards a hover response after a newer buffer version and prevents stale diagnostics', async t => {
  let release
  const environment = await host(request => request.method === 'hover'
    ? new Promise(resolve => { release = resolve })
    : report())
  t.after(() => environment.dispose())
  await environment.check()
  const original = { contents: 'native result' }
  const pending = environment.methods.get('textDocument/hover')(original, environment.context())
  for (let i = 0; i < 20 && !release; i++) await tick()
  assert.equal(typeof release, 'function')
  const doc = environment.documents[0]
  doc.text = '// changed\nlocals.user\n'
  doc.version++
  environment.events.change.fire({ document: doc })
  release(report({ diagnostics: [{ fileName: testFile, start: 0, end: 4, code: 2322, text: 'Old error.' }], queryResult: { text: 'Old type', start: 0, end: 4 } }))
  assert.equal(await pending, original)
  assert.equal(environment.diagnosticItems.has(testFile), false)
})

test('preserves native diagnostics and exposes backend errors when projection fails', async t => {
  let broken = false
  const environment = await host(() => {
    if (broken) throw new Error('Selected operation no longer exists.')
    return report()
  })
  t.after(() => environment.dispose())
  await environment.check()
  broken = true
  environment.documents[0].version++
  environment.events.change.fire({ document: environment.documents[0] })
  const original = { kind: 'full', items: [{ message: 'An ordinary TypeScript error.' }] }
  assert.equal(await environment.methods.get('textDocument/diagnostic')(original, environment.context()), original)
  assert.match(environment.diagnosticItems.get(configFile)[0].message, /Selected operation no longer exists/)
  assert.equal(environment.diagnosticItems.has(testFile), false)
  assert.ok(environment.logs.some(line => line.includes('Selected operation no longer exists')))
})

test('keeps native reports while publishing explicit diagnostics from an unsuccessful projection', async t => {
  const environment = await host(() => report({ projected: false, diagnostics: [{ fileName: configFile, start: 0, end: 1, code: 90001, text: 'Capture cannot be resolved.' }] }))
  t.after(() => environment.dispose())
  const original = { kind: 'full', items: [{ message: 'Native error.' }] }
  assert.equal(await environment.methods.get('textDocument/diagnostic')(original, environment.context()), original)
  assert.equal(environment.diagnosticItems.get(configFile)[0].code, 90001)
})

test('never starts workspace code in an untrusted workspace', async t => {
  const environment = await host(() => report(), { trusted: false })
  t.after(() => environment.dispose())
  await environment.check()
  assert.equal(environment.spawns.length, 0)
  assert.equal(environment.methods.size, 0)
  assert.match(environment.messages[0], /trusted workspace/)
})
