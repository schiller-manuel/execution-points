/**
 * This oracle owns `execution-points-prototype`'s TypeScript 7.1 JSON-RPC
 * content mapper (`src/content-mapper.mjs`), checked on the `Content-Length`
 * framed JSON-RPC responses emitted for `initialize`, `openProject`,
 * `transform`, and `closeProject`. It owns `src/content-mapper.mjs`.
 *
 * ```ts
 * rpc('initialize', { protocolVersion: 1 }) // → { protocolVersion: 1, positionEncoding: 'utf-16', diagnosticSource: 'execution-points' }
 * rpc('openProject', { projectHandle: 'p1', configFileName: '/app/tsconfig.json' }) // → { configIdentity, watchedFiles: ['/app/app.ts', '/app/tsconfig.json'] }
 * rpc('transform', { projectHandle: 'p1', fileName: '/app/points.ep', content: '{"targets":["app.ts"]}' }) // → { extension: '.ts', text: '...ExecutionPointFileRegistry...', diagnostics: [], mappings: [] }
 * rpc('transform', { projectHandle: 'p1', fileName: '/app/points.ep', content: '{bad' }) // → { extension: '.ts', diagnostics: [{ code: 90100, ... }], ... }
 * ```
 *
 * Why does editing and saving a watched target `.ts` file on disk after
 * `openProject` require `transform("points.ep")` to re-index the target file
 * even when `points.ep`'s own JSON text has not changed?
 *
 * Three parts drive the content mapper: the **JSON-RPC framing transport**
 * (buffering `stdin` chunks across `Content-Length` headers, dispatching
 * methods, and returning `-32601` for unknown methods), the **manifest
 * validator** (`parseManifest` accepting empty/whitespace or JSON objects while
 * reporting diagnostic `90100` for invalid JSON and `90101` for non-object
 * JSON), and the **project scanner & transformer** (`scanProject`,
 * `openProject`, `transform`, and `closeProject` tracking watched files and
 * rebuilding the target plan whenever `points.ep` or any watched target source
 * on disk changes).
 *
 * For every `transform` request on a `.ep` manifest, empty or whitespace-only
 * content returns an empty `.ts` stub with zero diagnostics, invalid JSON
 * returns diagnostic `90100`, non-object JSON (arrays, null, or primitives)
 * returns diagnostic `90101`, and a valid manifest object returns the generated
 * `ExecutionPointFileRegistry` module with zero diagnostics (`src/content-mapper.mjs:25-44, 77-83`;
 * Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law M1).
 *
 * For every JSON-RPC request sequence over `Content-Length` framing,
 * `initialize` echoes `protocolVersion` with UTF-16 encoding, `openProject`
 * returns deterministic `configIdentity` and sorted `watchedFiles` (covering
 * existing `tsconfig.json` and target files while excluding `points.ep`),
 * `transform` reflects both `points.ep` edits and on-disk target `.ts` file
 * edits, `closeProject` removes the project handle, and unknown methods return
 * JSON-RPC error `-32601` (`README.md:169-172`, `src/content-mapper.mjs:46-135`;
 * Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law M2).
 *
 * The model predicts the exact JSON-RPC result or error payload, diagnostic
 * codes, watched file list, and emitted target callee names for each request.
 * The driver feeds framed `Content-Length` buffers (including split chunks and
 * notification frames) to `process.stdin` and parses the framed responses from
 * `process.stdout`.
 *
 * Process exit cleanup on `stdin` `end` is lifecycle teardown outside single
 * request-response histories.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { handleInputChunk } from '../src/content-mapper.mjs'

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
    const match = /Content-Length:\s*(\d+)/i.exec(
      outBuf.subarray(0, headerEnd).toString('ascii'),
    )
    if (!match) break
    const msgEnd = headerEnd + 4 + Number(match[1])
    if (outBuf.length < msgEnd) break
    const json = JSON.parse(outBuf.subarray(headerEnd + 4, msgEnd).toString('utf8'))
    messages.push(json)
    outBuf = outBuf.subarray(msgEnd)
  }
  return messages
}

function callRpc(method: string, params?: unknown, splitAt?: number) {
  const id = nextRpcId++
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
  const framed = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ])
  const chunks =
    splitAt !== undefined ? [framed.subarray(0, splitAt), framed.subarray(splitAt)] : [framed]
  const responses = sendFramedPayloads(chunks)
  return responses.find((r) => r.id === id) ?? null
}

// ---------------------------------------------------------------------------
// Law M1: Manifest validation and diagnostics (empty, invalid JSON, non-object, valid)
// ---------------------------------------------------------------------------

const MANIFEST_CASES = [
  'empty-whitespace',
  'invalid-json-syntax',
  'non-object-array',
  'non-object-null',
  'valid-manifest-object',
] as const

type ManifestCase = (typeof MANIFEST_CASES)[number]

interface ManifestHistory {
  manifestCase: ManifestCase
}

const enumeratedManifestHistories: ReadonlyArray<ManifestHistory> = MANIFEST_CASES.map(
  (manifestCase) => ({ manifestCase }),
)

function manifestModel(history: ManifestHistory) {
  switch (history.manifestCase) {
    case 'empty-whitespace':
      return {
        extension: '.ts',
        diagCodes: [],
        diagSpansValid: true,
        mappingsEmpty: true,
        hasRegistryInterface: true,
        hasTargetCallee: false,
      }
    case 'invalid-json-syntax':
      return {
        extension: '.ts',
        diagCodes: [90100],
        diagSpansValid: true,
        mappingsEmpty: true,
        hasRegistryInterface: false,
        hasTargetCallee: false,
      }
    case 'non-object-array':
    case 'non-object-null':
      return {
        extension: '.ts',
        diagCodes: [90101],
        diagSpansValid: true,
        mappingsEmpty: true,
        hasRegistryInterface: false,
        hasTargetCallee: false,
      }
    case 'valid-manifest-object':
      return {
        extension: '.ts',
        diagCodes: [],
        diagSpansValid: true,
        mappingsEmpty: true,
        hasRegistryInterface: true,
        hasTargetCallee: true,
      }
  }
}

oracleProperty({
  id: 'content-mapper-manifest-validation',
  owns: [
    'src/content-mapper.mjs#parseManifest',
    'src/content-mapper.mjs#transform',
  ],
  law: {
    statement:
      'For every transform request on a .ep manifest, empty or whitespace content emits an empty registry with 0 diagnostics, invalid JSON emits diagnostic code 90100, non-object JSON (arrays, null, or primitives) emits diagnostic code 90101, and a valid manifest object emits the virtual .ts registry with 0 diagnostics.',
    authority:
      'src/content-mapper.mjs:25-44, 77-83 and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law M1.',
    limits:
      'Unknown top-level keys on a valid JSON object are ignored.',
  },
  histories: {
    enumerated: enumeratedManifestHistories,
    states: [
      'valid-or-empty-manifest',
      'rejected-invalid-json-90100',
      'rejected-non-object-90101',
    ],
  },
  label: (h) => h.manifestCase,
  model: (history) => manifestModel(history),
  driver: (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-mapper-m1-'))
    try {
      const targetFile = join(tempDir, 'app.ts')
      const manifestFile = join(tempDir, 'points.ep')
      writeFileSync(
        targetFile,
        'function sendQuote(): number { return 7 }\nexport function work() { return sendQuote() }\n',
      )

      let content: string
      switch (history.manifestCase) {
        case 'empty-whitespace':
          observe('reach', 'valid-or-empty-manifest')
          content = '   \n  '
          break
        case 'invalid-json-syntax':
          observe('reach', 'rejected-invalid-json-90100')
          content = '{ "targets": ['
          break
        case 'non-object-array':
          observe('reach', 'rejected-non-object-90101')
          content = '["app.ts"]'
          break
        case 'non-object-null':
          observe('reach', 'rejected-non-object-90101')
          content = 'null'
          break
        case 'valid-manifest-object':
          observe('reach', 'valid-or-empty-manifest')
          content = JSON.stringify({ targets: ['app.ts'] })
          break
      }

      const resp = callRpc('transform', {
        projectHandle: 'unopened-handle',
        fileName: manifestFile,
        content,
      }) as {
        result?: {
          extension: string
          text: string
          mappings: Array<unknown>
          diagnostics: Array<{
            code: number
            start: number
            length: number
            messageText: string
          }>
        }
      } | null

      const res = resp?.result
      const diags = res?.diagnostics ?? []
      const diagSpansValid = diags.every(
        (d) =>
          d.start === 0 &&
          d.length === content.length &&
          (d.code === 90100
            ? d.messageText.includes('points.ep')
            : d.messageText.includes('"targets" array')),
      )
      observe('manifest', {
        extension: res?.extension ?? 'missing',
        diagCodes: diags.map((d) => d.code),
        diagSpansValid,
        mappingsEmpty: Array.isArray(res?.mappings) && res.mappings.length === 0,
        hasRegistryInterface: Boolean(res?.text.includes('interface ExecutionPointFileRegistry')),
        hasTargetCallee: Boolean(res?.text.includes('"sendQuote"')),
      })
    } catch (err) {
      observe('manifest', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'manifest')
    if (!entry) return differs('manifest', 'manifest-validation', undefined, expected) ?? pass
    return differs('manifest', 'manifest-validation', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'missing-diagnostic-code',
      law: 'manifest-validation',
      history: { enumerated: 'invalid-json-syntax' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'manifest'
            ? { ...o, value: { ...(o.value as object), diagCodes: [] } }
            : o,
        ),
    },
  ],
})

// ---------------------------------------------------------------------------
// Law M2: Project lifecycle, watchedFiles, live target refresh, and JSON-RPC framing
// ---------------------------------------------------------------------------

const LIFECYCLE_SCENARIOS = [
  'open-transform-edit-target-and-retransform',
  'open-transform-edit-manifest-and-close',
  'split-chunks-and-unknown-method-error',
] as const

type LifecycleScenario = (typeof LIFECYCLE_SCENARIOS)[number]

interface LifecycleHistory {
  scenario: LifecycleScenario
}

const enumeratedLifecycleHistories: ReadonlyArray<LifecycleHistory> = LIFECYCLE_SCENARIOS.map(
  (scenario) => ({ scenario }),
)

function lifecycleModel(history: LifecycleHistory) {
  switch (history.scenario) {
    case 'open-transform-edit-target-and-retransform':
      return {
        jsonrpcVersion: '2.0',
        initProtocolVersion: 1,
        initEncoding: 'utf-16',
        initSource: 'execution-points',
        watchedFilesExactMatch: true,
        identityChangedAfterEdit: true,
        identityChangedAfterTsconfigEdit: true,
        identityChangedAfterManifestEdit: true,
        firstHasFirstCall: true,
        secondHasSecondCall: true,
        secondHasStaleFirstCall: false,
      }
    case 'open-transform-edit-manifest-and-close':
      return {
        customConfigWatchedExtra: true,
        missingTsconfigExcluded: true,
        firstHasFirstCall: true,
        secondHasExtraCall: true,
        closedResultEmpty: true,
        afterCloseUsesFileDir: true,
      }
    case 'split-chunks-and-unknown-method-error':
      return {
        splitHeaderOk: true,
        splitBodyOk: true,
        unknownMethodJsonrpc: '2.0',
        unknownMethodErrorCode: -32601,
        unknownMethodMentionsName: true,
        internalErrorJsonrpc: '2.0',
        internalErrorCode: -32603,
        internalErrorHasMessage: true,
      }
  }
}

oracleProperty({
  id: 'content-mapper-lifecycle-and-live-refresh',
  owns: [
    'src/content-mapper.mjs#scanProject',
    'src/content-mapper.mjs#getSnapshotCache',
    'src/content-mapper.mjs#initialize',
    'src/content-mapper.mjs#openProject',
    'src/content-mapper.mjs#transform',
    'src/content-mapper.mjs#closeProject',
    'src/content-mapper.mjs#handleInputChunk',
  ],
  law: {
    statement:
      'For every initialize, openProject, transform, and closeProject sequence over Content-Length JSON-RPC framing, openProject returns sorted watchedFiles (including tsconfig.json and resolved targets while excluding points.ep), transform reflects on-disk edits to watched target .ts files as well as updated manifest content passed to transform, closeProject releases the project handle, and unknown methods return JSON-RPC error -32601.',
    authority:
      'README.md:169-172 ("Single .ep anchor (points.ep). tsconfig.json registers src/content-mapper.mjs for .ep files with dynamicConfig: true and watchedFiles covering only the configured target modules.") and Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law M2.',
    limits:
      'Malformed frames without a Content-Length header or JSON parse errors without an id are ignored; histories are bounded-exhaustive over three representative project lifecycle sequences.',
  },
  histories: {
    enumerated: enumeratedLifecycleHistories,
    states: [
      'refreshed-after-target-file-edit',
      'refreshed-after-manifest-edit',
      'handled-framing-and-unknown-method',
    ],
  },
  label: (h) => h.scenario,
  model: (history) => lifecycleModel(history),
  driver: (history, observe) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'ep-mapper-m2-'))
    try {
      const tsconfigFile = join(tempDir, 'tsconfig.json')
      const manifestFile = join(tempDir, 'points.ep')
      const target1 = join(tempDir, 'app.ts')
      const target2 = join(tempDir, 'extra.ts')

      const manifest1 = JSON.stringify({ tsconfig: 'tsconfig.json', targets: ['app.ts'] })
      writeFileSync(tsconfigFile, JSON.stringify({ compilerOptions: { strict: true } }))
      writeFileSync(manifestFile, manifest1)
      writeFileSync(
        target1,
        'function firstCall(): number { return 1 }\nexport function work() { return firstCall() }\n',
      )
      writeFileSync(
        target2,
        'function extraCall(): boolean { return true }\nexport function extra() { return extraCall() }\n',
      )

      if (history.scenario === 'open-transform-edit-target-and-retransform') {
        observe('reach', 'refreshed-after-target-file-edit')
        // Include points.ep in targets so watched.delete(manifestFile) is exercised
        writeFileSync(
          manifestFile,
          JSON.stringify({ tsconfig: 'tsconfig.json', targets: ['app.ts', 'points.ep'] }),
        )
        const initResp = callRpc('initialize', { protocolVersion: 1 }) as {
          jsonrpc?: string
          result?: {
            protocolVersion: number
            positionEncoding: string
            diagnosticSource: string
          }
        }
        const openResp1 = callRpc('openProject', {
          projectHandle: 'proj-1',
          configFileName: tsconfigFile,
        }) as {
          result?: { configIdentity: string; watchedFiles: Array<string> }
        }

        const firstTx = callRpc('transform', {
          projectHandle: 'proj-1',
          fileName: manifestFile,
          content: JSON.stringify({ targets: ['app.ts'] }),
        }) as { result?: { text: string } }

        // Edit app.ts on disk without changing points.ep!
        writeFileSync(
          target1,
          'function secondCall(): string { return "updated" }\nexport function work() { return secondCall() }\n',
        )

        const openResp2 = callRpc('openProject', {
          projectHandle: 'proj-1',
          configFileName: tsconfigFile,
        }) as {
          result?: { configIdentity: string; watchedFiles: Array<string> }
        }

        // Edit tsconfig.json on disk and check configIdentity changes
        writeFileSync(tsconfigFile, JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }))
        const openResp3 = callRpc('openProject', {
          projectHandle: 'proj-1',
          configFileName: tsconfigFile,
        }) as {
          result?: { configIdentity: string; watchedFiles: Array<string> }
        }

        // Edit points.ep on disk and check configIdentity changes
        writeFileSync(manifestFile, JSON.stringify({ tsconfig: 'tsconfig.json', targets: ['app.ts'] }))
        const openResp4 = callRpc('openProject', {
          projectHandle: 'proj-1',
          configFileName: tsconfigFile,
        }) as {
          result?: { configIdentity: string; watchedFiles: Array<string> }
        }

        const secondTx = callRpc('transform', {
          projectHandle: 'proj-1',
          fileName: manifestFile,
          content: JSON.stringify({ targets: ['app.ts'] }),
        }) as { result?: { text: string } }

        callRpc('closeProject', { projectHandle: 'proj-1' })

        const watched = openResp1?.result?.watchedFiles ?? []
        const expectedWatched = [target1, tsconfigFile].sort()
        observe('lifecycle', {
          jsonrpcVersion: initResp?.jsonrpc,
          initProtocolVersion: initResp?.result?.protocolVersion,
          initEncoding: initResp?.result?.positionEncoding,
          initSource: initResp?.result?.diagnosticSource,
          watchedFilesExactMatch:
            JSON.stringify(watched) === JSON.stringify(expectedWatched),
          identityChangedAfterEdit:
            Boolean(openResp1?.result?.configIdentity) &&
            openResp1?.result?.configIdentity !== openResp2?.result?.configIdentity,
          identityChangedAfterTsconfigEdit:
            openResp2?.result?.configIdentity !== openResp3?.result?.configIdentity,
          identityChangedAfterManifestEdit:
            openResp3?.result?.configIdentity !== openResp4?.result?.configIdentity,
          firstHasFirstCall: Boolean(firstTx?.result?.text.includes('"firstCall"')),
          secondHasSecondCall: Boolean(secondTx?.result?.text.includes('"secondCall"')),
          secondHasStaleFirstCall: Boolean(secondTx?.result?.text.includes('"firstCall"')),
        })
        return
      }

      if (history.scenario === 'open-transform-edit-manifest-and-close') {
        observe('reach', 'refreshed-after-manifest-edit')
        const customEp = join(tempDir, 'custom.ep')
        writeFileSync(customEp, JSON.stringify({ targets: ['extra.ts'] }))
        const missingTsconfig = join(tempDir, 'nonexistent-tsconfig.json')
        const customOpen = callRpc('openProject', {
          projectHandle: 'proj-2',
          configFileName: missingTsconfig,
          options: { configFile: 'custom.ep' },
        }) as { result?: { watchedFiles: Array<string> } }

        const firstTx = callRpc('transform', {
          projectHandle: 'proj-2',
          fileName: manifestFile,
          content: manifest1,
        }) as { result?: { text: string } }

        const manifest2 = JSON.stringify({
          tsconfig: 'tsconfig.json',
          targets: ['app.ts', 'extra.ts'],
        })
        const secondTx = callRpc('transform', {
          projectHandle: 'proj-2',
          fileName: manifestFile,
          content: manifest2,
        }) as { result?: { text: string } }

        const closeResp = callRpc('closeProject', { projectHandle: 'proj-2' }) as {
          result?: Record<string, unknown>
        }

        // After closeProject('proj-2'), transforming with 'proj-2' falls back to path.dirname(fileName)
        const subDir = mkdtempSync(join(tmpdir(), 'ep-mapper-closed-'))
        try {
          writeFileSync(
            join(subDir, 'sub.ts'),
            'function subCall(): number { return 1 }\nexport function s() { return subCall() }\n',
          )
          const afterCloseTx = callRpc('transform', {
            projectHandle: 'proj-2',
            fileName: join(subDir, 'points.ep'),
            content: JSON.stringify({ targets: ['sub.ts'] }),
          }) as { result?: { text: string } }

          const customWatched = customOpen?.result?.watchedFiles ?? []
          observe('lifecycle', {
            customConfigWatchedExtra: customWatched.includes(target2),
            missingTsconfigExcluded: !customWatched.includes(missingTsconfig),
            firstHasFirstCall: Boolean(firstTx?.result?.text.includes('"firstCall"')),
            secondHasExtraCall: Boolean(secondTx?.result?.text.includes('"extraCall"')),
            closedResultEmpty:
              closeResp?.result !== undefined && Object.keys(closeResp.result).length === 0,
            afterCloseUsesFileDir: Boolean(afterCloseTx?.result?.text.includes('"subCall"')),
          })
        } finally {
          rmSync(subDir, { recursive: true, force: true })
        }
        return
      }

      // split-chunks-and-unknown-method-error
      observe('reach', 'handled-framing-and-unknown-method')
      // Send a bad header, an invalid JSON frame, and a notification (no `id`)
      const badHeader = Buffer.from('X-Ignore: 1\r\n\r\n', 'ascii')
      const badJson = Buffer.from('Content-Length: 3\r\n\r\n{x}', 'ascii')
      const notifBody = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }), 'utf8')
      const notifFrame = Buffer.concat([
        Buffer.from(`Content-Length: ${notifBody.length}\r\n\r\n`, 'ascii'),
        notifFrameBody(notifBody),
      ])
      sendFramedPayloads([badHeader, badJson, notifFrame])

      const splitHeader = callRpc('initialize', { protocolVersion: 2 }, 8) as {
        result?: { protocolVersion: number }
      }
      const splitBody = callRpc('initialize', { protocolVersion: 3 }, 35) as {
        result?: { protocolVersion: number }
      }
      const unknownResp = callRpc('noSuchMethod', {}) as {
        jsonrpc?: string
        error?: { code: number; message: string }
      }
      const internalErrResp = callRpc('transform', null) as {
        jsonrpc?: string
        error?: { code: number; message: string }
      }

      observe('lifecycle', {
        splitHeaderOk: splitHeader?.result?.protocolVersion === 2,
        splitBodyOk: splitBody?.result?.protocolVersion === 3,
        unknownMethodJsonrpc: unknownResp?.jsonrpc,
        unknownMethodErrorCode: unknownResp?.error?.code ?? 0,
        unknownMethodMentionsName: Boolean(unknownResp?.error?.message.includes('noSuchMethod')),
        internalErrorJsonrpc: internalErrResp?.jsonrpc,
        internalErrorCode: internalErrResp?.error?.code ?? 0,
        internalErrorHasMessage: Boolean(internalErrResp?.error?.message && internalErrResp.error.message.length > 0),
      })
    } catch (err) {
      observe('lifecycle', { threw: err instanceof Error ? err.message : String(err) })
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  },
  check: (_history, observations, expected) => {
    const entry = observations.find((o) => o.checkpoint === 'lifecycle')
    if (!entry) return differs('lifecycle', 'lifecycle-and-live-refresh', undefined, expected) ?? pass
    return differs('lifecycle', 'lifecycle-and-live-refresh', entry.value, expected) ?? pass
  },
  calibrations: [
    {
      name: 'stale-target-plan-on-retransform',
      law: 'lifecycle-and-live-refresh',
      history: { enumerated: 'open-transform-edit-target-and-retransform' },
      corrupt: (trace) =>
        trace.map((o) =>
          o.checkpoint === 'lifecycle'
            ? {
                ...o,
                value: {
                  ...(o.value as object),
                  secondHasSecondCall: false,
                  secondHasStaleFirstCall: true,
                },
              }
            : o,
        ),
    },
  ],
})

function notifFrameBody(b: Buffer) {
  return b
}
