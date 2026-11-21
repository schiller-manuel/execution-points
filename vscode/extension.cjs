'use strict'

const vscode = require('vscode')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { createRequire } = require('node:module')

const DEBOUNCE_MS = 250
const REQUEST_TIMEOUT_MS = 30_000
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/i
const fileKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
const isWithin = (root, file) => {
  const relative = path.relative(fileKey(root), fileKey(file))
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

// These are LSP CompletionItemKind numbers, not vscode.CompletionItemKind.
const completionKinds = {
  method: 2, function: 3, constructor: 4, getter: 10, setter: 10,
  property: 10, var: 6, let: 6, const: 21, local: 6, parameter: 6,
  class: 7, interface: 8, module: 9, alias: 18, enum: 13,
  'enum member': 20, keyword: 14, primitive: 14, type: 25,
  'type parameter': 25, string: 12, warning: 1, script: 17, directory: 19,
}

function positionAtText(text, offset) {
  const end = Math.max(0, Math.min(text.length, offset || 0))
  let line = 0
  let lineStart = 0
  for (let i = 0; i < end; i++) {
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') i++
      line++
      lineStart = i + 1
    } else if (text[i] === '\n') {
      line++
      lineStart = i + 1
    }
  }
  return new vscode.Position(line, Math.max(0, end - lineStart))
}

function lspRange(document, start, end) {
  const a = document.positionAt(Math.max(0, start || 0))
  const b = document.positionAt(Math.max(start || 0, end ?? start ?? 0))
  return { start: { line: a.line, character: a.character }, end: { line: b.line, character: b.character } }
}

class Project {
  constructor(folder, diagnostics, output) {
    this.folder = folder
    this.root = folder.uri.fsPath
    this.diagnostics = diagnostics
    this.output = output
    this.revision = 0
    this.nextId = 0
    this.publishedRevision = -1
    this.ownedFiles = new Set()
    this.publishedFiles = new Set()
    this.disposed = false
  }

  owns(file) {
    return this.publishedRevision === this.revision && this.ownedFiles.has(fileKey(file))
  }

  buffers() {
    return new Map(vscode.workspace.textDocuments
      .filter(document => document.uri.scheme === 'file' && TYPESCRIPT_FILE.test(document.fileName) && isWithin(this.root, document.fileName))
      .map(document => [path.resolve(document.fileName), document.getText()]))
  }

  clearDiagnostics() {
    for (const file of this.publishedFiles) this.diagnostics.delete(vscode.Uri.file(file))
    this.publishedFiles.clear()
    this.ownedFiles.clear()
    this.publishedRevision = -1
  }

  invalidate(restart = false) {
    this.revision++
    this.analysis = undefined
    clearTimeout(this.timer)
    this.clearDiagnostics()
    if (restart) this.stopWorker(new Error('Workspace files changed; restarting the compiler worker.'))
    if (!this.disposed) this.timer = setTimeout(() => { void this.analyze().catch(() => {}) }, DEBOUNCE_MS)
  }

  workerPath() {
    const local = path.join(this.root, 'src', 'editor-worker.mjs')
    if (fs.existsSync(local)) return local
    try {
      return createRequire(path.join(this.root, 'package.json')).resolve('execution-points-prototype/editor-worker')
    } catch {
      throw new Error('Cannot find the Execution Points editor worker. Install execution-points-prototype in this workspace, or open the prototype repository root.')
    }
  }

  startWorker() {
    if (this.worker) return this.worker
    if (this.disposed || !vscode.workspace.isTrusted) throw new Error('Execution Points requires a trusted workspace.')
    const node = vscode.workspace.getConfiguration('executionPoints', this.folder.uri).get('nodePath', 'node')
    const workerPath = this.workerPath()
    const child = spawn(node, [workerPath, this.root], { cwd: this.root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const worker = { child, pending: new Map(), reader: createInterface({ input: child.stdout }) }
    this.worker = worker
    this.output.appendLine(`[${this.root}] Starting ${node} with ${workerPath}`)
    worker.reader.on('line', line => {
      if (!line.trim()) return
      let message
      try { message = JSON.parse(line) } catch {
        this.stopWorker(new Error('The compiler worker returned invalid JSON. See the Execution Points output.'), worker)
        this.output.appendLine(line)
        return
      }
      const pending = worker.pending.get(message.id)
      if (!pending) return
      worker.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (typeof message.error === 'string') pending.reject(new Error(message.error))
      else if (message.result && typeof message.result.projected === 'boolean') pending.resolve(message.result)
      else pending.reject(new Error('The compiler worker returned an invalid result.'))
    })
    child.stderr.on('data', data => this.output.append(`[${this.root}] ${data.toString()}`))
    child.on('error', error => this.stopWorker(new Error(`Cannot run the compiler worker: ${error.message}. Set executionPoints.nodePath to a Node.js 24 or newer executable.`), worker))
    child.on('exit', (code, signal) => this.stopWorker(new Error(`Compiler worker exited (${signal || code}). Check the Execution Points output and your Node.js version.`), worker))
    child.stdin.on('error', error => this.stopWorker(error, worker))
    return worker
  }

  stopWorker(error, worker = this.worker) {
    if (!worker || worker.stopped) return
    worker.stopped = true
    if (this.worker === worker) this.worker = undefined
    worker.reader.close()
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    worker.pending.clear()
    worker.child.kill()
  }

  request(method, buffers, extra = {}) {
    const worker = this.startWorker()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stopWorker(new Error('The compiler worker did not respond within 30 seconds.'), worker), REQUEST_TIMEOUT_MS)
      worker.pending.set(id, { resolve, reject, timer })
      worker.child.stdin.write(JSON.stringify({ id, method, overrides: [...buffers], ...extra }) + '\n', error => {
        if (error) this.stopWorker(error, worker)
      })
    })
  }

  publish(result, revision, buffers) {
    if (this.disposed || revision !== this.revision) return false
    const owned = new Set((result.files || []).filter(file => isWithin(this.root, file)).map(fileKey))
    const grouped = new Map()
    if (result.projected) for (const file of owned) grouped.set(file, [])
    for (const diagnostic of result.diagnostics || []) {
      const file = diagnostic.fileName && path.resolve(diagnostic.fileName)
      if (!file || !isWithin(this.root, file) || (result.projected && !owned.has(fileKey(file)))) continue
      const key = fileKey(file)
      if (!grouped.has(key)) grouped.set(key, [])
      let document = vscode.workspace.textDocuments.find(item => item.uri.scheme === 'file' && fileKey(item.fileName) === key)
      if (!document) {
        let text = buffers.get(file)
        if (text === undefined) {
          try { text = fs.readFileSync(file, 'utf8') } catch { text = '' }
        }
        document = { positionAt: offset => positionAtText(text, offset) }
      }
      const range = lspRange(document, diagnostic.start, diagnostic.end)
      const item = new vscode.Diagnostic(
        new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character),
        diagnostic.text,
        vscode.DiagnosticSeverity.Error,
      )
      item.source = 'execution-points'
      item.code = diagnostic.code
      grouped.get(key).push(item)
    }
    this.clearDiagnostics()
    for (const [file, diagnostics] of grouped) {
      this.diagnostics.set(vscode.Uri.file(file), diagnostics)
      this.publishedFiles.add(file)
    }
    this.ownedFiles = result.projected ? owned : new Set()
    this.publishedRevision = revision
    this.lastError = undefined
    return true
  }

  fail(error, revision) {
    if (this.disposed || revision !== this.revision) return
    this.clearDiagnostics()
    const message = error instanceof Error ? error.message : String(error)
    if (message !== this.lastError) this.output.appendLine(`[${this.root}] ${message}`)
    this.lastError = message
    const config = path.join(this.root, 'points.config.mjs')
    const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `Execution Points could not check this workspace: ${message}`, vscode.DiagnosticSeverity.Error)
    diagnostic.source = 'execution-points'
    this.diagnostics.set(vscode.Uri.file(config), [diagnostic])
    this.publishedFiles.add(config)
  }

  analyze() {
    const revision = this.revision
    if (this.analysis?.revision === revision) return this.analysis.promise
    const buffers = this.buffers()
    const promise = Promise.resolve().then(() => this.request('analyze', buffers)).then(result => {
      this.publish(result, revision, buffers)
      return { result, revision, buffers }
    }).catch(error => {
      this.fail(error, revision)
      throw error
    })
    this.analysis = { revision, promise }
    return promise
  }

  async query(method, document, position) {
    const version = document.version
    const analysis = await this.analyze()
    if (this.disposed || document.version !== version || analysis.revision !== this.revision || !analysis.result.projected || !this.owns(document.fileName)) return undefined
    const revision = this.revision
    try {
      const result = await this.request(method, analysis.buffers, {
        fileName: document.fileName,
        position: document.offsetAt(new vscode.Position(position.line, position.character)),
      })
      if (this.disposed || document.version !== version || revision !== this.revision) return undefined
      this.publish(result, revision, analysis.buffers)
      return result.projected && this.owns(document.fileName) ? result.queryResult ?? null : undefined
    } catch (error) {
      this.analysis = undefined
      this.fail(error, revision)
      throw error
    }
  }

  dispose() {
    this.disposed = true
    this.revision++
    clearTimeout(this.timer)
    this.stopWorker(new Error('Execution Points stopped.'))
    this.clearDiagnostics()
  }
}

async function activate(context) {
  const output = vscode.window.createOutputChannel('Execution Points')
  const diagnostics = vscode.languages.createDiagnosticCollection('execution-points')
  const projects = new Map()
  const watchers = []
  let nativeAPI
  let nativeError
  let disposed = false
  const projectFor = file => [...projects.values()]
    .filter(project => isWithin(project.root, file))
    .sort((a, b) => b.root.length - a.root.length)[0]
  const documentFor = uri => vscode.workspace.textDocuments.find(document => document.uri.toString() === uri)

  const refresh = () => {
    for (const watcher of watchers.splice(0)) watcher.dispose()
    const active = new Set()
    if (vscode.workspace.isTrusted && nativeAPI && !disposed) {
      for (const folder of vscode.workspace.workspaceFolders || []) {
        if (folder.uri.scheme !== 'file') continue
        const key = fileKey(folder.uri.fsPath)
        const configWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, 'points.config.mjs'))
        watchers.push(configWatcher, configWatcher.onDidCreate(refresh), configWatcher.onDidDelete(refresh))
        if (!fs.existsSync(path.join(folder.uri.fsPath, 'points.config.mjs'))) continue
        active.add(key)
        let project = projects.get(key)
        if (!project) {
          project = new Project(folder, diagnostics, output)
          projects.set(key, project)
          project.invalidate()
        }
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.{ts,tsx,mts,cts,js,jsx,json,mjs,cjs}'))
        const changed = uri => {
          const relative = path.relative(project.root, uri.fsPath)
          if (relative.split(path.sep).some(part => part === 'node_modules' || part === '.git')) return
          project.invalidate(true)
        }
        watchers.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed))
      }
    }
    for (const [key, project] of projects) if (!active.has(key)) {
      project.dispose()
      projects.delete(key)
    }
  }

  context.subscriptions.push(output, diagnostics, { dispose() {
    disposed = true
    for (const watcher of watchers.splice(0)) watcher.dispose()
    for (const project of projects.values()) project.dispose()
    projects.clear()
  } })

  context.subscriptions.push(vscode.commands.registerCommand('executionPoints.check', async () => {
    if (!vscode.workspace.isTrusted) return vscode.window.showErrorMessage('Execution Points requires a trusted workspace because it runs workspace configuration in Node.js.')
    if (!nativeAPI) {
      output.show(true)
      return vscode.window.showErrorMessage(nativeError || 'Install and enable the TypeScript 7 extension to use Execution Points.')
    }
    refresh()
    if (!projects.size) return vscode.window.showInformationMessage('Open a workspace folder containing points.config.mjs.')
    for (const project of projects.values()) {
      project.invalidate()
      clearTimeout(project.timer)
    }
    const results = await Promise.allSettled([...projects.values()].map(project => project.analyze()))
    const failed = results.some(result => result.status === 'rejected' || !result.value.result.projected)
    const count = results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? (result.value.result.diagnostics || []).length : 0), 0)
    if (failed) {
      output.show(true)
      return vscode.window.showErrorMessage('Execution Points could not build a current virtual type view. Native TypeScript diagnostics remain enabled; see Problems and Output.')
    }
    return vscode.window.showInformationMessage(`Execution Points checked ${projects.size} workspace${projects.size === 1 ? '' : 's'}: ${count} diagnostic${count === 1 ? '' : 's'}.`)
  }))

  if (!vscode.workspace.isTrusted) return
  try {
    const extension = vscode.extensions.getExtension('TypeScriptTeam.native-preview')
    if (!extension) throw new Error('Install the TypeScript 7 extension (TypeScriptTeam.native-preview).')
    nativeAPI = await extension.activate()
    if (typeof nativeAPI?.registerLspMiddleware !== 'function') throw new Error('This TypeScript 7 extension does not expose registerLspMiddleware. Update it to the version supporting TypeScript 7.1 middleware.')
  } catch (error) {
    nativeAPI = undefined
    nativeError = error instanceof Error ? error.message : String(error)
    output.appendLine(nativeError)
    void vscode.window.showErrorMessage(`Execution Points: ${nativeError}`)
    return
  }

  context.subscriptions.push(nativeAPI.registerLspMiddleware('textDocument/diagnostic', async (original, context) => {
    const uri = vscode.Uri.parse(context.params.textDocument.uri)
    if (uri.scheme !== 'file') return original
    const project = projectFor(uri.fsPath)
    if (!project) return original
    try {
      const analysis = await project.analyze()
      if (analysis.revision !== project.revision || !analysis.result.projected) return original
      // Our collection owns the complete mapped report. Suppress native copies
      // only after publishing this exact revision; keep unrelated reports intact.
      let relatedDocuments = original?.relatedDocuments
      if (relatedDocuments) {
        relatedDocuments = { ...relatedDocuments }
        for (const relatedUri of Object.keys(relatedDocuments)) {
          const related = vscode.Uri.parse(relatedUri)
          if (related.scheme === 'file' && project.owns(related.fsPath)) relatedDocuments[relatedUri] = { kind: 'full', items: [] }
        }
      }
      if (!project.owns(uri.fsPath)) return relatedDocuments ? { ...original, relatedDocuments } : original
      return { kind: 'full', items: [], ...(relatedDocuments ? { relatedDocuments } : {}) }
    } catch { return original }
  }))

  context.subscriptions.push(nativeAPI.registerLspMiddleware('textDocument/hover', async (original, context) => {
    const document = documentFor(context.params.textDocument.uri)
    const project = document?.uri.scheme === 'file' && projectFor(document.fileName)
    if (!project) return original
    try {
      const result = await project.query('hover', document, context.params.position)
      if (result === undefined) return original
      if (!result) return null
      return {
        contents: { language: 'typescript', value: result.text },
        range: lspRange(document, result.start, result.end),
      }
    } catch { return original }
  }))

  context.subscriptions.push(nativeAPI.registerLspMiddleware('textDocument/completion', async (original, context) => {
    const document = documentFor(context.params.textDocument.uri)
    const project = document?.uri.scheme === 'file' && projectFor(document.fileName)
    if (!project) return original
    try {
      const result = await project.query('completion', document, context.params.position)
      if (result === undefined) return original
      if (!result) return null
      return {
        isIncomplete: Boolean(result.isIncomplete),
        items: result.entries.map(entry => {
          const kind = Number.isInteger(entry.kind) && entry.kind >= 1 && entry.kind <= 25 ? entry.kind : completionKinds[entry.kind] || 1
          const item = { label: entry.name, kind, sortText: entry.sortText }
          if (entry.insertText !== undefined) item.insertText = entry.insertText
          if (Number.isInteger(entry.start) && Number.isInteger(entry.end)) {
            item.textEdit = { range: lspRange(document, entry.start, entry.end), newText: entry.insertText ?? entry.name }
          }
          return item
        }),
      }
    } catch { return original }
  }))

  const changedDocument = document => {
    if (document.uri.scheme !== 'file' || !TYPESCRIPT_FILE.test(document.fileName)) return
    projectFor(document.fileName)?.invalidate()
  }
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(changedDocument),
    vscode.workspace.onDidChangeTextDocument(event => changedDocument(event.document)),
    vscode.workspace.onDidSaveTextDocument(changedDocument),
    vscode.workspace.onDidCloseTextDocument(changedDocument),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('executionPoints.nodePath')) for (const project of projects.values()) project.invalidate(true)
    }),
  )
  if (typeof nativeAPI.onLanguageServerInitialized === 'function') {
    context.subscriptions.push(nativeAPI.onLanguageServerInitialized(() => {
      for (const project of projects.values()) project.invalidate()
    }))
  }
  refresh()
}

module.exports = { activate }
