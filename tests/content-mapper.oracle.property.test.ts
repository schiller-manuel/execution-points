/**
 * This oracle owns the TypeScript 7.1 content mapper for `points.ep`
 * (`src/content-mapper.ts`), checked on the `Content-Length` framed JSON-RPC
 * responses to `initialize`, `openProject`, `transform`, and `closeProject`.
 * It owns `src/content-mapper.ts`.
 *
 * ```ts
 * rpc('transform', { fileName: '/app/points.ep', content: '{"targets":["src/app.ts"]}' })
 * // → { extension: '.ts', text: registry of src/app.ts, diagnostics: [], mappings: [the file's nodes → "src/app.ts"] }
 * rpc('transform', { fileName, content: '{"target":["src/app.ts"]}' })
 * // → diagnostics at "target" (unknown key) and for the missing "targets" array
 * rpc('transform', { fileName, content: '{"targets":["src/app.ts","src/typo.ts",42]}' })
 * // → registry of src/app.ts, diagnostics at "src/typo.ts" and at 42
 * rpc('openProject', { projectHandle, configFileName: '/app/tsconfig.json' })
 * // → { configIdentity, watchedFiles: tsconfig, targets, and every project file the targets' types depend on }
 * rpc('noSuchMethod', {}) // → error -32601
 * ```
 *
 * `{"targets": "src/app.ts"}` is a JSON object, and it used to be read as
 * eight one-letter targets, so the compiler watched `/` and nothing was said.
 * A manifest is only useful when it is either followed exactly or refused
 * at the text that is wrong.
 *
 * Three parts carry the promise. The **manifest** is the JSON object in
 * `points.ep`: a `targets` array of paths and globs and an optional
 * `tsconfig`. The **watch set** is what `openProject` reports: the files whose
 * change can change the registry, with a `configIdentity` that changes when
 * any of them does. The **warm program** is the one TypeScript program an open
 * project keeps and updates.
 *
 * For every manifest, either the registry reflects exactly the listed targets
 * that exist, or a diagnostic names what is wrong (Decision by Manuel Schiller
 * (GitHub schiller-manuel), 2026-11-24). Empty content is an empty registry
 * without a diagnostic, invalid JSON is diagnostic 90100, and JSON that is not
 * an object with a `targets` array is diagnostic 90101 (Decision by Manuel
 * Schiller (GitHub schiller-manuel), 2026-11-23). Each further diagnostic
 * stands at the offending key, value, or entry, and each registry file's
 * nodes are mapped to the entry that lists the file, so an error in the
 * registry is reported there and go-to-definition on a node's field lands
 * there (Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24).
 * The protocol maps a virtual file only onto its own `.ep` text, so the
 * manifest entry is the nearest place to the target expression it can name.
 *
 * For every open project, `watchedFiles` are the tsconfig, the listed
 * targets, and every file of the project that the analysis read, without
 * `points.ep`; `configIdentity` changes when one of them or the manifest
 * changes; `transform` then returns what a mapper started afresh returns; and
 * one TypeScript program serves the project until it closes (Decision by
 * Manuel Schiller (GitHub schiller-manuel), 2026-11-24, with `README.md:167`).
 * Requests arrive in `Content-Length` frames that may be split anywhere;
 * unknown methods answer -32601 and a failing handler -32603
 * (Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23).
 *
 * The manifest histories are built from tokens, so the model knows where each
 * key and entry stands without parsing: it expects a diagnostic exactly at
 * each token the history marks as wrong, and the registry of exactly the
 * files the history says an entry matches. The registry is read by compiling
 * it (`tests/registry-harness.ts`), never from its text.
 *
 * The mapper is imported here, so its standard-input loop is not exercised:
 * the oracle only checks that importing it attaches no listener. The wording
 * of a diagnostic is checked for naming its subject, not word for word.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { API } from 'typescript/sync'
import { afterAll, vi } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { generateFileRegistryModule } from '../src/contracts.ts'
import { handleInputChunk } from '../src/content-mapper.ts'
import { buildTargetPlan } from '../src/discovery.ts'
import { type Plan, type RegistryReading, compileRegistry, createProject, removeProject, repoRoot } from './registry-harness'

const api = new API({ cwd: repoRoot })
afterAll(() => {
  api.close()
})

type Observation = { checkpoint: string; value: unknown }

// ---------------------------------------------------------------------------
// The driver's side of the wire: frame a request, feed it, parse the reply
// ---------------------------------------------------------------------------

let nextRpcId = 1
const streamState = { buffer: Buffer.alloc(0) }

function sendFramedPayloads(rawChunks: ReadonlyArray<Buffer>): Array<Record<string, unknown>> {
  const capturedChunks: Array<Buffer> = []
  for (const chunk of rawChunks) {
    handleInputChunk(streamState, chunk, (frame: Buffer) => {
      capturedChunks.push(frame)
    })
  }

  let outBuf = Buffer.concat(capturedChunks)
  const messages: Array<Record<string, unknown>> = []
  for (;;) {
    const headerEnd = outBuf.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const match = /Content-Length:\s*(\d+)/i.exec(outBuf.subarray(0, headerEnd).toString('ascii'))
    if (!match) break
    const msgEnd = headerEnd + 4 + Number(match[1])
    if (outBuf.length < msgEnd) break
    messages.push(JSON.parse(outBuf.subarray(headerEnd + 4, msgEnd).toString('utf8')))
    outBuf = outBuf.subarray(msgEnd)
  }
  return messages
}

function callRpc(method: string, params?: unknown, splitAt?: number): any {
  const id = nextRpcId++
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
  const framed = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
  const chunks = splitAt !== undefined ? [framed.subarray(0, splitAt), framed.subarray(splitAt)] : [framed]
  return sendFramedPayloads(chunks).find((response) => response.id === id) ?? null
}

/** The file keys of a registry, and the callee of each call node, as TypeScript reads the compiled text. */
function readRegistry(root: string, text: string) {
  const files = ['src/app.ts', 'src/extra.ts', 'src/lib/deep.ts']
  const plan = buildTargetPlan({ root, targets: files, api }) as Plan
  const { reading } = compileRegistry(api, root, text, plan)
  return {
    files: reading.files,
    registryErrors: reading.registryErrors,
    callees: [...new Set(Object.values(reading.nodes).map((node) => node.descriptor.callee))].sort(),
    reading,
    plan,
  }
}

const relativeTo = (root: string, files: ReadonlyArray<string>) =>
  files.map((file) => (file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file)).sort()

const judge =
  (law: string, checkpoint: string) =>
  (_history: unknown, observations: ReadonlyArray<Observation>, expected: unknown) => {
    const crash = observations.find((entry) => entry.checkpoint === 'crash')
    if (crash) return differs('crash', law, crash.value, 'no crash') ?? pass
    return differs(checkpoint, law, observations.find((entry) => entry.checkpoint === checkpoint)?.value, expected) ?? pass
  }

const corrupt =
  (checkpoint: string, change: (value: any) => unknown) =>
  (trace: ReadonlyArray<Observation>) =>
    trace.map((entry) =>
      entry.checkpoint === checkpoint ? { ...entry, value: change(structuredClone(entry.value)) } : entry,
    )

// ---------------------------------------------------------------------------
// Law M1 and Law 4: a manifest is followed exactly or refused where it is wrong
// ---------------------------------------------------------------------------

/**
 * A manifest as the tokens it is written from. A plain string is copied; a
 * marked token is a key, a target entry, or a value the model has a rule for.
 */
type Token =
  | string
  | { key: string }
  /** An entry of `targets`: its JSON text, whether it is a string, and the files it matches in the project. */
  | { entry: string; isString: boolean; matches: ReadonlyArray<string>; pattern: boolean }
  /** A value in the place of `targets` or `tsconfig` that is not what the key needs. */
  | { wrong: string; subject: string }

const key = (name: string): Token => ({ key: name })
const path = (file: string, exists = true): Token => ({
  entry: JSON.stringify(file),
  isString: true,
  matches: exists ? [file] : [],
  pattern: false,
})
const glob = (pattern: string, ...matches: Array<string>): Token => ({
  entry: JSON.stringify(pattern),
  isString: true,
  matches,
  pattern: true,
})
const notAString = (json: string): Token => ({ entry: json, isString: false, matches: [], pattern: false })
const wrong = (json: string, subject: string): Token => ({ wrong: json, subject })

const textOf = (token: Token) =>
  typeof token === 'string' ? token : 'key' in token ? JSON.stringify(token.key) : 'entry' in token ? token.entry : token.wrong

/** Where each marked token stands in the manifest text. */
const placed = (tokens: ReadonlyArray<Token>) => {
  let offset = 0
  return tokens.map((token) => {
    const text = textOf(token)
    const start = offset
    offset += text.length
    return { token, text, start }
  })
}

interface ManifestHistory {
  name: string
  states: ReadonlyArray<string>
  tokens: ReadonlyArray<Token>
  /** Content that is no JSON object: the whole of it is refused with this code. */
  refused?: 90100 | 90101
  /** The manifest has no `targets` key at all. */
  missingTargets?: boolean
}

/** The keys a manifest may have are the ones its schema describes. The model reads them there. */
const MANIFEST_KEYS: ReadonlyArray<string> = Object.keys(
  (JSON.parse(readFileSync(join(repoRoot, 'points.schema.json'), 'utf8')) as { properties: object }).properties,
)

/** The project every manifest history runs in. */
const MANIFEST_PROJECT = {
  // The name of Quote is an import relative to the manifest, so it holds only for the right manifest file.
  'src/app.ts': 'export interface Quote { total: number }\nfunction sendQuote(): Quote { return { total: 7 } }\nexport function work() { return sendQuote() }\n',
  'src/extra.ts': 'function extraCall(): boolean { return true }\nexport function extra() { return extraCall() }\n',
  'src/lib/deep.ts': 'function deepCall(): string { return "d" }\nexport function deep() { return deepCall() }\n',
  'other.tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src/**/*.ts'] }),
}

/** The project's own modules. Once a target exists, the analysis reads them all, so all are watched. */
const MANIFEST_PROJECT_MODULES = ['src/app.ts', 'src/extra.ts', 'src/lib/deep.ts']

const MANIFEST_HISTORIES: ReadonlyArray<ManifestHistory> = [
  { name: 'empty-whitespace', states: ['followed-exactly'], tokens: ['   \n  '] },
  { name: 'invalid-json-syntax', states: ['refused-as-a-whole'], tokens: ['{ "targets": ['], refused: 90100 },
  { name: 'non-object-array', states: ['refused-as-a-whole'], tokens: ['["src/app.ts"]'], refused: 90101 },
  { name: 'non-object-null', states: ['refused-as-a-whole'], tokens: ['null'], refused: 90101 },
  { name: 'non-object-string', states: ['refused-as-a-whole'], tokens: ['"src/app.ts"'], refused: 90101 },
  { name: 'non-object-number', states: ['refused-as-a-whole'], tokens: ['0'], refused: 90101 },
  {
    name: 'one-target',
    states: ['followed-exactly'],
    tokens: ['{', key('targets'), ':[', path('src/app.ts'), ']}'],
  },
  {
    name: 'targets-and-tsconfig-after-leading-space',
    states: ['followed-exactly'],
    tokens: [
      '\n  { ',
      key('tsconfig'),
      ': "other.tsconfig.json",\n    ',
      key('targets'),
      ': [\n      ',
      path('src/extra.ts'),
      ',\n      ',
      path('src/app.ts'),
      '\n    ]\n  }\n',
    ],
  },
  {
    name: 'glob-and-path-listing-one-file-twice',
    states: ['followed-exactly', 'file-listed-twice'],
    tokens: ['{', key('targets'), ': [', path('src/extra.ts'), ', ', glob('src/*.ts', 'src/app.ts', 'src/extra.ts'), ', ', path('src/lib/deep.ts'), ']}'],
  },
  {
    name: 'glob-listing-several-files',
    states: ['followed-exactly', 'entry-matching-several-files'],
    tokens: ['{', key('targets'), ': [', glob('src/**/*.ts', 'src/app.ts', 'src/extra.ts', 'src/lib/deep.ts'), ']}'],
  },
  {
    name: 'empty-targets-array',
    states: ['followed-exactly'],
    tokens: ['{', key('targets'), ': []}'],
  },
  {
    name: 'typo-in-targets-key',
    states: ['refused-at-a-key'],
    tokens: ['{', key('target'), ': ["src/app.ts"]}'],
    missingTargets: true,
  },
  {
    name: 'typo-in-tsconfig-key',
    states: ['refused-at-a-key'],
    tokens: ['{', key('targets'), ': [', path('src/app.ts'), '], ', key('tsconfg'), ': "x.json"}'],
  },
  {
    name: 'empty-object',
    states: ['refused-for-missing-targets'],
    tokens: ['{}'],
    missingTargets: true,
  },
  {
    name: 'targets-is-a-string',
    states: ['refused-at-a-value'],
    tokens: ['{', key('targets'), ': ', wrong('"src/app.ts"', '"targets" array'), '}'],
  },
  {
    name: 'targets-is-an-object',
    states: ['refused-at-a-value'],
    tokens: ['{', key('targets'), ': ', wrong('{"0": "src/app.ts"}', '"targets" array'), '}'],
  },
  {
    name: 'entries-that-are-not-strings',
    states: ['refused-at-an-entry'],
    tokens: ['{', key('targets'), ': [', notAString('42'), ', ', path('src/app.ts'), ', ', notAString('null'), ', ', notAString('["src/extra.ts"]'), ']}'],
  },
  {
    name: 'target-that-does-not-exist',
    states: ['refused-at-an-entry'],
    tokens: ['{', key('targets'), ': [', path('src/app.ts'), ', ', path('src/typo-does-not-exist.ts', false), ']}'],
  },
  {
    name: 'glob-that-matches-nothing',
    states: ['refused-at-an-entry'],
    tokens: ['{', key('targets'), ': [', glob('nowhere/*.ts'), ', ', path('src/extra.ts'), ']}'],
  },
  {
    name: 'tsconfig-that-is-not-a-string',
    states: ['refused-at-a-value'],
    tokens: ['{', key('tsconfig'), ': ', wrong('42', 'tsconfig'), ', ', key('targets'), ': [', path('src/app.ts'), ']}'],
  },
  {
    name: 'schema-key-beside-targets',
    states: ['followed-exactly'],
    tokens: ['{', key('$schema'), ': "./points.schema.json", ', key('targets'), ': [', path('src/app.ts'), ']}'],
  },
  {
    name: 'schema-that-is-not-a-string',
    states: ['refused-at-a-value'],
    tokens: ['{', key('$schema'), ': ', wrong('42', '$schema'), ', ', key('targets'), ': [', path('src/app.ts'), ']}'],
  },
  {
    name: 'tsconfig-that-does-not-exist',
    states: ['refused-at-a-value'],
    tokens: ['{', key('tsconfig'), ': ', wrong('"nope.json"', 'nope.json'), ', ', key('targets'), ': [', path('src/app.ts'), ']}'],
  },
]

/** The diagnostics the rules owe: where each stands and what its message must name. */
function owedDiagnostics(history: ManifestHistory) {
  const text = history.tokens.map(textOf).join('')
  if (history.refused) return [{ at: text, names: history.refused === 90100 ? 'points.ep' : '"targets" array', code: history.refused }]
  const owed: Array<{ at: string; names: string; start: number; code?: number }> = []
  for (const { token, text: at, start } of placed(history.tokens)) {
    if (typeof token === 'string') continue
    if ('key' in token) {
      if (!MANIFEST_KEYS.includes(token.key)) owed.push({ at, names: token.key, start })
    } else if ('wrong' in token) {
      owed.push({ at, names: token.subject, start, ...(token.subject === '"targets" array' ? { code: 90101 } : {}) })
    } else if (!token.isString || token.matches.length === 0) {
      owed.push({ at, names: token.isString ? JSON.parse(token.entry) : token.entry, start })
    }
  }
  if (history.missingTargets) owed.push({ at: text, names: '"targets" array', start: -1, code: 90101 })
  return owed.sort((a, b) => a.start - b.start).map(({ start: _start, ...rest }) => rest)
}

/** The entries that list at least one file no earlier entry lists, with those files. */
function owedMappings(history: ManifestHistory) {
  const seen = new Set<string>()
  const owed: Array<{ original: string; asAWhole: boolean; definitionLandsHere: boolean; files: Array<string> }> = []
  for (const token of history.tokens) {
    if (typeof token === 'string' || !('entry' in token)) continue
    const fresh = token.matches.filter((file) => !seen.has(file))
    for (const file of fresh) seen.add(file)
    if (fresh.length) owed.push({ original: token.entry, asAWhole: true, definitionLandsHere: true, files: [...fresh].sort() })
  }
  return owed
}

oracleProperty({
  id: 'content-mapper-manifest-validation',
  owns: ['src/content-mapper.ts#parseManifest', 'src/content-mapper.ts#transform', 'src/content-mapper.ts#scanProject'],
  law: {
    statement:
      'For every manifest, either the registry reflects exactly the listed targets that exist, or a diagnostic names what is wrong: empty content is an empty registry with no diagnostic, invalid JSON is diagnostic 90100, JSON that is not an object with a "targets" array is diagnostic 90101, and a key that points.schema.json does not describe, a wrong value, an entry that is not a string, and an entry that matches no file each get a diagnostic at that text. Each registry file’s nodes are mapped to the entry that lists the file, for diagnostics and for go-to-definition.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: for every manifest, either the registry reflects exactly the listed targets that exist, or a diagnostic names what is wrong; registry lines are mapped to something useful. Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law M1 (90100 for invalid JSON, 90101 for JSON that is not an object with a "targets" array). Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: one source of truth for targets, with a published schema for the manifest (points.schema.json), which names the keys.',
    limits:
      'Twenty-three manifests over one project of three modules. A diagnostic’s message is checked for naming its subject, and only the codes 90100 and 90101 are fixed. The mapping is checked for the manifest text it points at and the files whose nodes it covers.',
  },
  histories: {
    enumerated: MANIFEST_HISTORIES,
    states: [
      'followed-exactly',
      'entry-matching-several-files',
      'file-listed-twice',
      'refused-as-a-whole',
      'refused-at-a-key',
      'refused-at-a-value',
      'refused-at-an-entry',
      'refused-for-missing-targets',
    ],
  },
  label: (history) => history.name,
  // The registry holds the files that the string entries match, whatever else
  // is wrong; content that is no object at all gets no registry. A listed
  // path is watched even while it does not exist, so that creating it is seen.
  model: (history) => {
    const entries = history.tokens.filter(
      (token): token is Extract<Token, { entry: string }> => typeof token !== 'string' && 'entry' in token && token.isString,
    )
    const owed = owedDiagnostics(history)
    const files = [...new Set(entries.flatMap((entry) => entry.matches))].sort()
    return {
      extension: '.ts',
      diagnostics: owed.map(({ at }) => at),
      diagnosticsNameTheirSubject: owed.map(() => true),
      fixedCodes: owed.map(({ code }) => code ?? 'free'),
      declaresRegistry: !history.refused,
      registryErrors: [],
      files,
      closed: true,
      sourceFilesLeftOpen: 0,
      mappings: owedMappings(history),
      watched: [
        ...new Set([
          'tsconfig.json',
          ...(files.length ? MANIFEST_PROJECT_MODULES : []),
          ...entries.flatMap((entry) => (entry.pattern ? entry.matches : [JSON.parse(entry.entry) as string])),
          ...(history.tokens.some((token) => typeof token === 'string' && token.includes('"other.tsconfig.json"'))
            ? ['other.tsconfig.json']
            : []),
        ]),
      ].sort(),
    }
  },
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    const owed = owedDiagnostics(history)
    const content = history.tokens.map(textOf).join('')
    const root = createProject({ ...MANIFEST_PROJECT, 'points.ep': content })
    try {
      const opened = callRpc('openProject', { projectHandle: `manifest-${history.name}`, configFileName: join(root, 'tsconfig.json') })
      const response = callRpc('transform', {
        projectHandle: `manifest-${history.name}`,
        fileName: join(root, 'points.ep'),
        content,
      })
      const closed = callRpc('closeProject', { projectHandle: `manifest-${history.name}` })
      if (!response?.result || !opened?.result) {
        observe('crash', JSON.stringify(response?.error ?? opened?.error ?? 'no response'))
        return
      }
      const result = response.result as {
        extension: string
        text: string
        diagnostics: Array<{ code: number; start: number; length: number; messageText: string }>
        mappings: Array<[number, number, number, number, number, number?]>
      }
      const diagnostics = [...result.diagnostics].sort((a, b) => a.start - b.start || b.length - a.length)
      const registry = readRegistry(root, result.text)
      observe('manifest', {
        extension: result.extension,
        diagnostics: diagnostics.map((diagnostic) => content.slice(diagnostic.start, diagnostic.start + diagnostic.length)),
        diagnosticsNameTheirSubject: diagnostics.map((diagnostic, index) =>
          diagnostic.messageText.includes(owed[index]?.names ?? '\u0000'),
        ),
        fixedCodes: diagnostics.map((diagnostic, index) => (owed[index]?.code ? diagnostic.code : 'free')),
        declaresRegistry: result.text.includes('interface ExecutionPointFileRegistry'),
        registryErrors: registry.registryErrors,
        files: registry.files,
        closed: JSON.stringify(closed?.result) === '{}',
        sourceFilesLeftOpen: sourceFilesOpen.size,
        // A segment is [virtualStart, virtualLength, originalStart, originalLength, kind, features].
        // Kind 1 maps the block as a whole; feature bit 8 is go-to-definition, and no bit means diagnostics only.
        mappings: result.mappings.map(([virtualStart, virtualLength, originalStart, originalLength, kind, features]) => ({
          original: content.slice(originalStart, originalStart + originalLength),
          asAWhole: kind === 1,
          definitionLandsHere: features === 8,
          files: registry.plan.files
            .filter((entry) =>
              entry.nodes.some((node) =>
                result.text.slice(virtualStart, virtualStart + virtualLength).includes(JSON.stringify(node.id)),
              ),
            )
            .map((entry) => entry.relativeFile)
            .sort(),
        })),
        watched: relativeTo(root, opened.result.watchedFiles),
      })
    } catch (error) {
      observe('crash', error instanceof Error ? error.message : String(error))
    } finally {
      removeProject(root)
    }
  },
  check: judge('manifest-validation', 'manifest'),
  calibrations: [
    {
      name: 'missing-diagnostic-code',
      law: 'manifest-validation',
      history: { enumerated: 'invalid-json-syntax' },
      corrupt: corrupt('manifest', (value) => ({ ...value, diagnostics: [], diagnosticsNameTheirSubject: [], fixedCodes: [] })),
    },
    {
      name: 'a-typo-that-nobody-reports',
      law: 'manifest-validation',
      history: { enumerated: 'typo-in-tsconfig-key' },
      corrupt: corrupt('manifest', (value) => ({ ...value, diagnostics: [], diagnosticsNameTheirSubject: [], fixedCodes: [] })),
    },
    {
      name: 'a-missing-target-reported-at-the-whole-file',
      law: 'manifest-validation',
      history: { enumerated: 'target-that-does-not-exist' },
      corrupt: corrupt('manifest', (value) => ({ ...value, diagnostics: ['{"targets": ["src/app.ts", "src/typo-does-not-exist.ts"]}'] })),
    },
    {
      name: 'a-string-read-as-a-list-of-letters',
      law: 'manifest-validation',
      history: { enumerated: 'targets-is-a-string' },
      corrupt: corrupt('manifest', (value) => ({ ...value, watched: [...value.watched, 's', 'r', 'c'].sort() })),
    },
    {
      name: 'nodes-mapped-to-another-entry',
      law: 'manifest-validation',
      history: { enumerated: 'glob-and-path-listing-one-file-twice' },
      corrupt: corrupt('manifest', (value) => ({ ...value, mappings: [...value.mappings].reverse() })),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law M2: the watch set, refresh after an edit, one warm program, and framing
// ---------------------------------------------------------------------------

const LIFECYCLE_SCENARIOS = [
  'open-transform-edit-and-retransform',
  'imported-files-are-watched-and-refresh',
  'custom-manifest-close-and-reopen',
  'config-with-another-name-and-no-config',
  'split-chunks-and-unknown-method-error',
] as const

type LifecycleScenario = (typeof LIFECYCLE_SCENARIOS)[number]

/**
 * What the mapper asks of TypeScript: every program it builds, every source
 * file it parses and whether it gave it back, and how many API instances
 * (each a TypeScript server process) it uses. The methods are wrapped for
 * every API instance but the oracle's own; the client caches a method on the
 * instance at first use, so the wrapper is installed there too.
 */
const programsBuilt: Array<{ isDisposed: () => boolean }> = []
const sourceFilesOpen = new Set<unknown>()
const serversUsed = new Set<unknown>()
function wrapApiMethod(method: 'createSnapshot' | 'createSourceFile', record: (result: any) => void) {
  const accessor = Object.getOwnPropertyDescriptor(API.prototype, method)!
  Object.defineProperty(API.prototype, method, {
    configurable: true,
    get(this: API) {
      const call = accessor.get!.call(this)
      if (this === api) return call
      const wrapped = (...args: Array<unknown>) => {
        serversUsed.add(this)
        const result = call.apply(this, args)
        record(result)
        return result
      }
      Object.defineProperty(this, method, { configurable: true, value: wrapped })
      return wrapped
    },
  })
  afterAll(() => {
    Object.defineProperty(API.prototype, method, accessor)
  })
}
wrapApiMethod('createSnapshot', (snapshot) => programsBuilt.push(snapshot))
wrapApiMethod('createSourceFile', (lease) => {
  sourceFilesOpen.add(lease)
  const dispose = lease.dispose
  Object.defineProperty(lease, 'dispose', {
    configurable: true,
    value: () => {
      sourceFilesOpen.delete(lease)
      return dispose.call(lease)
    },
  })
})

/** Run a sequence and hand it the programs the mapper built during it. */
function countingPrograms<T>(run: (built: Array<{ isDisposed: () => boolean }>) => T): T {
  programsBuilt.length = 0
  return run(programsBuilt)
}

const everyNodeFits = (reading: RegistryReading) =>
  Object.values(reading.nodes).every(
    (node) =>
      node.unportable === null &&
      [node.result, ...Object.values(node.locals)].every((fit) => fit === 'same' || fit === 'equivalent'),
  )

const IMPORT_PROJECT = {
  'src/app.ts': `import { loadLimit } from './limits'\nexport function allowed(n: number, s: Shape) {\n  const limit = loadLimit()\n  return check(limit, s, n)\n}\nfunction check(...parts: unknown[]) { return parts }\n`,
  'src/limits.ts': `import { deep } from './deep'\nexport function loadLimit() { return deep() }\n`,
  'src/deep.ts': `export function deep(): number { return 5 }\n`,
  'src/globals.d.ts': `interface Shape { x: number }\n`,
  'points.ep': JSON.stringify({ targets: ['src/app.ts'] }),
}

oracleProperty({
  id: 'content-mapper-lifecycle-and-live-refresh',
  owns: [
    'src/content-mapper.ts#scanProject',
    'src/content-mapper.ts#initialize',
    'src/content-mapper.ts#openProject',
    'src/content-mapper.ts#transform',
    'src/content-mapper.ts#closeProject',
    'src/content-mapper.ts#handleInputChunk',
  ],
  law: {
    statement:
      'For every initialize, openProject, transform, and closeProject sequence over Content-Length JSON-RPC framing, openProject returns sorted watchedFiles (tsconfig.json, the listed targets, and every project file the analysis read, without points.ep) and a configIdentity that changes when one of them or the manifest changes; transform returns the registry a mapper started afresh returns; one TypeScript program serves an open project until closeProject releases it; and unknown methods return JSON-RPC error -32601.',
    authority:
      'Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: after every sequence of edits to targets and to the files they import, the warm mapper’s registry equals a cold mapper’s registry, so the mapper watches those files too. README.md:167 ("A persistent typescript/sync snapshot ... updates incrementally via snapshot.update(...) on file saves"). Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law M2. The watch set (the tsconfig, the targets, and every project file the analysis read): approved by Manuel Schiller (GitHub schiller-manuel), 2026-11-24.',
    limits:
      'Malformed frames without a Content-Length header or JSON parse errors without an id are ignored; histories are bounded-exhaustive over five lifecycle sequences. The standard-input loop of the mapper process is not driven; importing the mapper is checked for attaching no listener.',
  },
  histories: {
    enumerated: LIFECYCLE_SCENARIOS.map((scenario) => ({ scenario })),
    states: [
      'refreshed-after-target-file-edit',
      'refreshed-after-imported-file-edit',
      'refreshed-after-manifest-edit',
      'reopened-after-close',
      'opened-with-another-config',
      'handled-framing-and-unknown-method',
    ],
  },
  label: (history) => history.scenario,
  model: (history: { scenario: LifecycleScenario }) => {
    switch (history.scenario) {
      case 'open-transform-edit-and-retransform':
        return {
          jsonrpcVersion: '2.0',
          initProtocolVersion: 1,
          initEncoding: 'utf-16',
          initSource: 'execution-points',
          // The manifest lists itself; it is the one file never watched.
          watched: ['src/app.ts', 'src/extra.ts', 'tsconfig.json'],
          identityIsStable: true,
          identityChangedAfterTargetEdit: true,
          identityChangedAfterTsconfigEdit: true,
          identityChangedAfterManifestEdit: true,
          calleesBeforeEdit: ['firstCall'],
          calleesAfterEdit: ['secondCall'],
          // One program, and a second one when the tsconfig's compiler options change.
          programsBuilt: 2,
        }
      case 'imported-files-are-watched-and-refresh':
        return {
          watched: ['src/app.ts', 'src/deep.ts', 'src/globals.d.ts', 'src/limits.ts', 'tsconfig.json'],
          identityChangedAfterImportedEdit: true,
          identityChangedAfterAmbientEdit: true,
          warmEqualsColdAfterEachEdit: [true, true],
          registryErrors: [],
          fitsAfterEdits: true,
          programsBuilt: 1,
          typescriptServers: 1,
        }
      case 'custom-manifest-close-and-reopen':
        return {
          customManifestWatched: ['src/extra.ts'],
          calleesOfCustomManifest: ['extraCall'],
          missingTsconfigExcluded: true,
          calleesOfFirstManifest: ['firstCall'],
          calleesOfSecondManifest: ['extraCall', 'firstCall'],
          closedResultEmpty: true,
          programReleasedOnClose: true,
          calleesAfterClose: ['subCall'],
          programsBuilt: 2,
        }
      case 'config-with-another-name-and-no-config':
        return {
          // Only tsconfig.app.json loads the Node types that the target needs.
          namedConfigIsUsed: true,
          // With no configuration file, the working directory is the project and tsconfig.json its configuration.
          watchedWithoutConfig: ['src/app.ts', 'tsconfig.json'],
        }
      case 'split-chunks-and-unknown-method-error':
        return {
          emptyHeaderSkipped: true,
          repliesToNotifications: 0,
          closingAnUnknownProjectAnswers: true,
          splitHeaderOk: true,
          splitBodyOk: true,
          unknownMethodJsonrpc: '2.0',
          unknownMethodErrorCode: -32601,
          unknownMethodMentionsName: true,
          internalErrorJsonrpc: '2.0',
          internalErrorCode: -32603,
          internalErrorHasMessage: true,
          standardInputListeners: 0,
        }
    }
  },
  driver: async (history, observe) => {
    const write = (root: string, relative: string, text: string) => {
      mkdirSync(dirname(join(root, relative)), { recursive: true })
      writeFileSync(join(root, relative), text)
    }
    const callees = (root: string, text: string) => readRegistry(root, text).callees.filter((name) => typeof name === 'string')
    const first = 'function firstCall(): number { return 1 }\nexport function work() { return firstCall() }\n'
    const second = 'function secondCall(): string { return "updated" }\nexport function work() { return secondCall() }\n'
    const extra = 'function extraCall(): boolean { return true }\nexport function extra() { return extraCall() }\n'

    try {
      if (history.scenario === 'open-transform-edit-and-retransform') {
        observe('reach', 'refreshed-after-target-file-edit')
        observe('reach', 'refreshed-after-manifest-edit')
        const manifest = JSON.stringify({ tsconfig: 'tsconfig.json', targets: ['src/app.ts', 'points.ep'] })
        const root = createProject({ 'src/app.ts': first, 'src/extra.ts': extra, 'points.ep': manifest })
        try {
          countingPrograms((built) => {
            const open = () => callRpc('openProject', { projectHandle: 'proj-1', configFileName: join(root, 'tsconfig.json') }).result
            const transform = () =>
              callRpc('transform', { projectHandle: 'proj-1', fileName: join(root, 'points.ep'), content: manifest }).result
            const init = callRpc('initialize', { protocolVersion: 1 })
            const opened = open()
            const again = open()
            const calleesBeforeEdit = callees(root, transform().text)
            write(root, 'src/app.ts', second)
            const afterTarget = open()
            const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
            write(root, 'tsconfig.json', JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, noUnusedLocals: true } }))
            const afterTsconfig = open()
            write(root, 'points.ep', JSON.stringify({ targets: ['src/app.ts', 'points.ep'] }))
            const afterManifest = open()
            const after = transform()
            callRpc('closeProject', { projectHandle: 'proj-1' })
            observe('lifecycle', {
              jsonrpcVersion: init.jsonrpc,
              initProtocolVersion: init.result.protocolVersion,
              initEncoding: init.result.positionEncoding,
              initSource: init.result.diagnosticSource,
              watched: relativeTo(root, opened.watchedFiles),
              identityIsStable: opened.configIdentity.length > 0 && opened.configIdentity === again.configIdentity,
              identityChangedAfterTargetEdit: again.configIdentity !== afterTarget.configIdentity,
              identityChangedAfterTsconfigEdit: afterTarget.configIdentity !== afterTsconfig.configIdentity,
              identityChangedAfterManifestEdit: afterTsconfig.configIdentity !== afterManifest.configIdentity,
              calleesBeforeEdit,
              calleesAfterEdit: callees(root, after.text),
              programsBuilt: built.length,
            })
          })
        } finally {
          removeProject(root)
        }
        return
      }

      if (history.scenario === 'imported-files-are-watched-and-refresh') {
        observe('reach', 'refreshed-after-imported-file-edit')
        const root = createProject(IMPORT_PROJECT)
        try {
          countingPrograms((built) => {
            const open = () => callRpc('openProject', { projectHandle: 'proj-imports', configFileName: join(root, 'tsconfig.json') }).result
            const transform = () =>
              callRpc('transform', { projectHandle: 'proj-imports', fileName: join(root, 'points.ep'), content: IMPORT_PROJECT['points.ep'] })
                .result.text as string
            // What a mapper started afresh returns: the registry generated with no warm program.
            const cold = () => {
              const plan = buildTargetPlan({ root, targets: ['src/app.ts'], api }) as Plan
              return { plan, text: generateFileRegistryModule(plan, { fromFile: join(root, 'points.ep'), api }).text }
            }
            const opened = open()
            transform()
            write(root, 'src/deep.ts', `export function deep(): string { return '5' }\n`)
            const afterImported = open()
            const warmAfterImported = transform()
            const coldAfterImported = cold().text
            write(root, 'src/globals.d.ts', `interface Shape { x: string; y: boolean }\n`)
            const afterAmbient = open()
            const warmAfterAmbient = transform()
            const fresh = cold()
            callRpc('closeProject', { projectHandle: 'proj-imports' })
            const { reading } = compileRegistry(api, root, warmAfterAmbient, fresh.plan)
            observe('lifecycle', {
              watched: relativeTo(root, opened.watchedFiles),
              identityChangedAfterImportedEdit: opened.configIdentity !== afterImported.configIdentity,
              identityChangedAfterAmbientEdit: afterImported.configIdentity !== afterAmbient.configIdentity,
              warmEqualsColdAfterEachEdit: [warmAfterImported === coldAfterImported, warmAfterAmbient === fresh.text],
              registryErrors: reading.registryErrors,
              fitsAfterEdits: everyNodeFits(reading),
              programsBuilt: built.length,
              typescriptServers: serversUsed.size,
            })
          })
        } finally {
          removeProject(root)
        }
        return
      }

      if (history.scenario === 'custom-manifest-close-and-reopen') {
        observe('reach', 'refreshed-after-manifest-edit')
        observe('reach', 'reopened-after-close')
        const manifestOne = JSON.stringify({ tsconfig: 'tsconfig.json', targets: ['src/app.ts'] })
        const manifestTwo = JSON.stringify({ tsconfig: 'tsconfig.json', targets: ['src/app.ts', 'src/extra.ts'] })
        const root = createProject({
          'src/app.ts': first,
          'src/extra.ts': extra,
          'points.ep': manifestOne,
          // A manifest in a directory of its own still names targets from the project root.
          'config/custom.ep': JSON.stringify({ targets: ['src/extra.ts'] }),
        })
        const elsewhere = createProject({
          'sub.ts': 'function subCall(): number { return 1 }\nexport function s() { return subCall() }\n',
        })
        try {
          countingPrograms((built) => {
            // A tsconfig that does not exist is not watched; a custom manifest names its own targets.
            const custom = callRpc('openProject', {
              projectHandle: 'proj-2',
              configFileName: join(root, 'nonexistent-tsconfig.json'),
              options: { configFile: 'config/custom.ep' },
            }).result
            const calleesOfCustomManifest = callees(
              root,
              callRpc('transform', {
                projectHandle: 'proj-2',
                fileName: join(root, 'config/custom.ep'),
                content: JSON.stringify({ targets: ['src/extra.ts'] }),
              }).result.text,
            )
            const customProgram = built[0]
            callRpc('closeProject', { projectHandle: 'proj-2' })
            const programReleasedOnClose = Boolean(customProgram?.isDisposed())
            built.length = 0

            callRpc('openProject', { projectHandle: 'proj-2', configFileName: join(root, 'tsconfig.json') })
            const transform = (content: string) =>
              callRpc('transform', { projectHandle: 'proj-2', fileName: join(root, 'points.ep'), content }).result.text as string
            const firstText = transform(manifestOne)
            const secondText = transform(manifestTwo)
            const closed = callRpc('closeProject', { projectHandle: 'proj-2' })
            callRpc('openProject', { projectHandle: 'proj-2', configFileName: join(root, 'tsconfig.json') })
            const programsBuilt = built.length
            callRpc('closeProject', { projectHandle: 'proj-2' })

            // With no open project, the manifest's own directory is the project root.
            const afterClose = callRpc('transform', {
              projectHandle: 'proj-2',
              fileName: join(elsewhere, 'points.ep'),
              content: JSON.stringify({ targets: ['sub.ts'] }),
            }).result.text as string
            const subPlan = buildTargetPlan({ root: elsewhere, targets: ['sub.ts'], api }) as Plan
            observe('lifecycle', {
              customManifestWatched: relativeTo(root, custom.watchedFiles),
              calleesOfCustomManifest,
              missingTsconfigExcluded: !custom.watchedFiles.includes(join(root, 'nonexistent-tsconfig.json')),
              calleesOfFirstManifest: callees(root, firstText),
              calleesOfSecondManifest: callees(root, secondText),
              closedResultEmpty: closed.result !== undefined && Object.keys(closed.result).length === 0,
              programReleasedOnClose,
              calleesAfterClose: Object.values(compileRegistry(api, elsewhere, afterClose, subPlan).reading.nodes).map(
                (node) => node.descriptor.callee,
              ),
              programsBuilt,
            })
          })
        } finally {
          removeProject(root)
          removeProject(elsewhere)
        }
        return
      }

      if (history.scenario === 'config-with-another-name-and-no-config') {
        observe('reach', 'opened-with-another-config')
        const manifest = JSON.stringify({ targets: ['src/app.ts'] })
        const root = createProject({
          'src/app.ts': `export function tag() { return Buffer.from('x') }\n`,
          'points.ep': manifest,
        })
        const base = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
        write(root, 'tsconfig.app.json', JSON.stringify({ ...base, compilerOptions: { ...base.compilerOptions, types: ['node'] } }))
        const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root)
        try {
          callRpc('openProject', { projectHandle: 'proj-app', configFileName: join(root, 'tsconfig.app.json') })
          const text = callRpc('transform', { projectHandle: 'proj-app', fileName: join(root, 'points.ep'), content: manifest }).result
            .text as string
          callRpc('closeProject', { projectHandle: 'proj-app' })
          const plan = buildTargetPlan({ root, targets: ['src/app.ts'], api }) as Plan
          const { reading } = compileRegistry(api, root, text, plan, { tsconfig: 'tsconfig.app.json' })
          const withoutConfig = callRpc('openProject', { projectHandle: 'proj-none', configFileName: '' }).result
          callRpc('closeProject', { projectHandle: 'proj-none' })
          observe('lifecycle', {
            namedConfigIsUsed: reading.registryErrors.length === 0 && Object.keys(reading.nodes).length === 1 && everyNodeFits(reading),
            watchedWithoutConfig: relativeTo(root, withoutConfig.watchedFiles),
          })
        } finally {
          cwd.mockRestore()
          removeProject(root)
        }
        return
      }

      observe('reach', 'handled-framing-and-unknown-method')
      // What a fresh import of the mapper adds to standard input.
      const listeners = () => process.stdin.listenerCount('data') + process.stdin.listenerCount('end')
      const listenersBeforeImport = listeners()
      vi.resetModules()
      await import('../src/content-mapper.ts')
      const listenersAfterImport = listeners()
      // A header without a length, a frame that is not JSON, and a notification get no reply.
      const notification = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }), 'utf8')
      const replies = sendFramedPayloads([
        Buffer.from('X-Ignore: 1\r\n\r\n', 'ascii'),
        Buffer.from('Content-Length: 3\r\n\r\n{x}', 'ascii'),
        Buffer.concat([Buffer.from(`Content-Length: ${notification.length}\r\n\r\n`, 'ascii'), notification]),
      ])
      // A frame whose header is empty is skipped, and the request after it is answered.
      sendFramedPayloads([Buffer.from('\r\n\r\n', 'ascii')])
      const afterEmptyHeader = callRpc('initialize', { protocolVersion: 4 })
      const closedUnknown = callRpc('closeProject', { projectHandle: 'never-opened' })
      const splitHeader = callRpc('initialize', { protocolVersion: 2 }, 8)
      const splitBody = callRpc('initialize', { protocolVersion: 3 }, 35)
      const unknown = callRpc('noSuchMethod', {})
      const internal = callRpc('transform', null)
      observe('lifecycle', {
        emptyHeaderSkipped: afterEmptyHeader?.result?.protocolVersion === 4,
        repliesToNotifications: replies.length,
        closingAnUnknownProjectAnswers: JSON.stringify(closedUnknown?.result) === '{}',
        splitHeaderOk: splitHeader?.result?.protocolVersion === 2,
        splitBodyOk: splitBody?.result?.protocolVersion === 3,
        unknownMethodJsonrpc: unknown?.jsonrpc,
        unknownMethodErrorCode: unknown?.error?.code ?? 0,
        unknownMethodMentionsName: Boolean(unknown?.error?.message.includes('noSuchMethod')),
        internalErrorJsonrpc: internal?.jsonrpc,
        internalErrorCode: internal?.error?.code ?? 0,
        internalErrorHasMessage: Boolean(internal?.error?.message),
        standardInputListeners: listenersAfterImport - listenersBeforeImport,
      })
    } catch (error) {
      observe('crash', error instanceof Error ? error.message : String(error))
    }
  },
  check: judge('lifecycle-and-live-refresh', 'lifecycle'),
  calibrations: [
    {
      name: 'stale-target-plan-on-retransform',
      law: 'lifecycle-and-live-refresh',
      history: { enumerated: 'open-transform-edit-and-retransform' },
      corrupt: corrupt('lifecycle', (value) => ({ ...value, calleesAfterEdit: ['firstCall'] })),
    },
    {
      name: 'an-imported-file-that-nobody-watches',
      law: 'lifecycle-and-live-refresh',
      history: { enumerated: 'imported-files-are-watched-and-refresh' },
      corrupt: corrupt('lifecycle', (value) => ({ ...value, watched: ['src/app.ts', 'tsconfig.json'] })),
    },
    {
      name: 'old-types-after-an-imported-file-changed',
      law: 'lifecycle-and-live-refresh',
      history: { enumerated: 'imported-files-are-watched-and-refresh' },
      corrupt: corrupt('lifecycle', (value) => ({ ...value, warmEqualsColdAfterEachEdit: [false, true] })),
    },
    {
      name: 'a-new-program-for-every-request',
      law: 'lifecycle-and-live-refresh',
      history: { enumerated: 'imported-files-are-watched-and-refresh' },
      corrupt: corrupt('lifecycle', (value) => ({ ...value, programsBuilt: 9 })),
    },
    {
      name: 'listeners-attached-by-an-import',
      law: 'lifecycle-and-live-refresh',
      history: { enumerated: 'split-chunks-and-unknown-method-error' },
      corrupt: corrupt('lifecycle', (value) => ({ ...value, standardInputListeners: 2 })),
    },
  ],
})
