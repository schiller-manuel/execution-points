/**
 * This oracle owns the content mapper's side of the wire: reading requests out of a stream of
 * bytes and writing a reply for each. It is checked on the replies written for a stream that is
 * cut into chunks at arbitrary places, on the bytes kept for a frame that is not complete, and
 * on what happens when the input ends. It owns `src/content-mapper.ts#handleInputChunk` and
 * `src/content-mapper.ts#serve`.
 *
 * ```ts
 * handleInputChunk(state, chunk, write)
 * // chunk: 'Content-Length: 58\r\n\r\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
 * // → write('Content-Length: …\r\n\r\n{"jsonrpc":"2.0","id":1,"result":{…}}')
 * // a chunk that ends in the middle of a frame → nothing written, the bytes are kept in state.buffer
 * serve(input, output) // the same for every chunk of `input`; closes the TypeScript API when the input ends
 * ```
 *
 * TypeScript talks to the mapper over a pipe, and a pipe delivers bytes in pieces of any size.
 * A request can arrive in two halves, two requests can arrive in one piece, and a length counts
 * bytes, not characters. Does a request whose header arrives one byte at a time get its reply?
 * Does a blank line inside a message end a header?
 *
 * Three parts are checked: the **frame** (a header block that ends in a blank line and names a
 * `Content-Length`, then that many bytes), the **reply** (one for each request that has an id),
 * and the **remainder** (the bytes of a frame that has not arrived in full).
 *
 * For every stream of frames, cut into chunks at any places, `handleInputChunk` writes one
 * reply for each request that has an id, in the order of the requests, each as one frame whose
 * `Content-Length` is the byte length of its body: the method's result, error -32601 for a
 * method the mapper does not have, and error -32603 with the error's text for a method that
 * throws. It writes nothing for a message without an id, for a body that is not JSON, and for a
 * header block without a `Content-Length`. The bytes of a frame that is not complete are kept
 * until the rest arrives, so the replies do not depend on where the stream is cut. `serve`
 * does this for every chunk of its input, and when the input ends it closes the TypeScript API
 * the mapper opened, if it opened one, and can serve again (TypeScript 7.1's content mapper
 * protocol, `node_modules/typescript/schemas/contentmapper.schema.json`: JSON-RPC 2.0 in
 * `Content-Length` frames over standard input and output; Decision by Manuel Schiller (GitHub
 * schiller-manuel), 2026-11-23: Law M2, unknown methods return error -32601; Decision of
 * 2026-11-24: close all gaps, which this reader had four of).
 *
 * The model knows the frames it wrote and which of them ask for a reply. It never looks at
 * bytes: where the stream is cut is no input of it.
 */
import { EventEmitter } from 'node:events'
import fc from 'fast-check'
import { API } from 'typescript/sync'
import { afterEach, vi } from 'vitest'
import { differs, oracleProperty, pass } from '@tanstack/oracles'
import { handleInputChunk, serve } from '../src/content-mapper.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

interface FrameSpec {
  kind:
    | 'initialize'
    | 'close'
    | 'unknown-method'
    | 'method-that-throws'
    | 'notification'
    | 'not-json'
    | 'header-without-length'
    | 'blank-line'
  /** Written into the request, and expected back from `initialize`. Not all of it is ASCII. */
  text: string
  /** A second header line before the length, and the length's name in lower case. */
  otherHeader: boolean
  lowerCase: boolean
  /** A blank line between two members of the JSON body. */
  blankLineInBody: boolean
}

interface WireHistory {
  frames: Array<FrameSpec>
  /** Where the stream is cut into chunks, as offsets into it (taken modulo its length). */
  cuts: Array<number>
  /** How many bytes of the last frame arrive only later (taken modulo its length). */
  withheld: number
}

const TEXTS = ['1', 'v2', 'é', '✓ ok', '\r\n\r\n', 'Content-Length: 3'] as const

const frameArbitrary: fc.Arbitrary<FrameSpec> = fc.record({
  kind: fc.constantFrom(
    'initialize',
    'close',
    'unknown-method',
    'method-that-throws',
    'notification',
    'not-json',
    'header-without-length',
    'blank-line',
  ),
  text: fc.constantFrom(...TEXTS),
  otherHeader: fc.boolean(),
  lowerCase: fc.boolean(),
  blankLineInBody: fc.boolean(),
})

const wireArbitrary: fc.Arbitrary<WireHistory> = fc.record({
  frames: fc.array(frameArbitrary, { minLength: 1, maxLength: 5 }),
  cuts: fc.array(fc.nat({ max: 400 }), { maxLength: 6 }),
  withheld: fc.nat({ max: 400 }),
})

const frame = (kind: FrameSpec['kind'], extra: Partial<FrameSpec> = {}): FrameSpec => ({
  kind,
  text: '1',
  otherHeader: false,
  lowerCase: false,
  blankLineInBody: false,
  ...extra,
})

/** Whether the mapper owes a reply for a frame, and which. */
const replyKind = (spec: FrameSpec) =>
  spec.kind === 'initialize'
    ? 'result'
    : spec.kind === 'close'
      ? 'empty-result'
      : spec.kind === 'unknown-method'
        ? 'unknown-method'
        : spec.kind === 'method-that-throws'
          ? 'failed'
          : undefined

/** The reply owed for the request with this id. */
function owedReply(spec: FrameSpec, id: number) {
  switch (replyKind(spec)) {
    case 'result':
      return { id, result: { protocolVersion: spec.text, positionEncoding: 'utf-16', diagnosticSource: 'execution-points' } }
    case 'empty-result':
      return { id, result: {} }
    case 'unknown-method':
      return { id, error: { code: -32601, namesTheMethod: true } }
    case 'failed':
      return { id, error: { code: -32603, saysWhatWasThrown: true } }
    default:
      return undefined
  }
}

/** The bytes of one frame. Its id is its place in the history, from `firstId` on. */
function written(spec: FrameSpec, id: number): Buffer {
  if (spec.kind === 'blank-line') return Buffer.from('\r\n\r\n', 'ascii')
  if (spec.kind === 'header-without-length') return Buffer.from(`X-Other: ${id}\r\n\r\n`, 'ascii')
  const message =
    spec.kind === 'initialize'
      ? { method: 'initialize', params: { protocolVersion: spec.text } }
      : spec.kind === 'close'
        ? { method: 'closeProject', params: { projectHandle: `nobody-${spec.text}` } }
        : spec.kind === 'unknown-method'
          ? { method: `no/such/${id}`, params: { note: spec.text } }
          : spec.kind === 'method-that-throws'
            ? // `transform` reads its params, and there are none.
              { method: 'transform' }
            : { method: 'initialized', params: { note: spec.text } }
  const members = [
    '"jsonrpc":"2.0"',
    ...(spec.kind === 'notification' ? [] : [`"id":${id}`]),
    ...Object.entries(message).map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`),
  ]
  // White space between the members of a JSON object may be anything, a blank line included.
  const json = `{${members.join(spec.blankLineInBody ? ',\r\n\r\n' : ',')}}`
  const body = Buffer.from(spec.kind === 'not-json' ? `{"id":${id}, not json ${spec.text}` : json, 'utf8')
  const length = `${spec.lowerCase ? 'content-length' : 'Content-Length'}: ${body.length}`
  return Buffer.concat([Buffer.from(`${spec.otherHeader ? 'Content-Type: application/json\r\n' : ''}${length}\r\n\r\n`, 'ascii'), body])
}

function wireModel(history: WireHistory) {
  const replies = history.frames.map((spec, index) => owedReply(spec, index + 1)).filter((reply) => reply !== undefined)
  const last = history.frames.at(-1)!
  const lastLength = written(last, history.frames.length).length
  const withheld = history.withheld % lastLength
  // A frame that has not arrived in full gets no reply yet, and all of it that arrived is kept.
  const lastIsOwedAReply = replyKind(last) !== undefined
  return {
    firstPart: {
      replies: withheld > 0 && lastIsOwedAReply ? replies.slice(0, -1) : replies,
      framesAreWellFormed: true,
      kept: withheld > 0 ? lastLength - withheld : 0,
    },
    afterTheRest: {
      replies: withheld > 0 && lastIsOwedAReply ? replies.slice(-1) : [],
      framesAreWellFormed: true,
      kept: 0,
    },
  }
}

/** Reads the frames the mapper wrote: each must be a header with the byte length of its body, and a JSON body. */
function readReplies(output: ReadonlyArray<Buffer>) {
  let rest = Buffer.concat(output)
  const replies: Array<unknown> = []
  let framesAreWellFormed = true
  while (rest.length > 0) {
    const header = /^Content-Length: (\d+)\r\n\r\n/.exec(rest.toString('latin1'))
    if (!header || rest.length < header[0].length + Number(header[1])) {
      framesAreWellFormed = false
      break
    }
    const body = rest.subarray(header[0].length, header[0].length + Number(header[1])).toString('utf8')
    rest = rest.subarray(header[0].length + Number(header[1]))
    try {
      const reply = JSON.parse(body) as {
        jsonrpc?: string
        id?: number
        result?: unknown
        error?: { code: number; message: unknown }
      }
      if (reply.jsonrpc !== '2.0') framesAreWellFormed = false
      replies.push(
        reply.error
          ? {
              id: reply.id,
              error: {
                code: reply.error.code,
                ...(reply.error.code === -32601
                  ? { namesTheMethod: reply.error.message === `Unknown method: no/such/${reply.id}` }
                  : { saysWhatWasThrown: typeof reply.error.message === 'string' && reply.error.message.startsWith('TypeError') }),
              },
            }
          : { id: reply.id, result: reply.result },
      )
    } catch {
      framesAreWellFormed = false
    }
  }
  return { replies, framesAreWellFormed }
}

/** The stream of a history, and the part of it that arrives first. */
function streamOf(history: WireHistory) {
  const frames = history.frames.map((spec, index) => written(spec, index + 1))
  const whole = Buffer.concat(frames)
  const withheld = history.withheld % frames.at(-1)!.length
  const first = whole.subarray(0, whole.length - withheld)
  const cuts = [...new Set(history.cuts.map((cut) => cut % (first.length + 1)))].sort((a, b) => a - b)
  const chunks = [0, ...cuts].map((from, index, all) => first.subarray(from, all[index + 1] ?? first.length))
  return { chunks, rest: whole.subarray(whole.length - withheld) }
}

const wireStates = (history: WireHistory) => {
  const states = new Set<string>()
  for (const spec of history.frames) {
    states.add(replyKind(spec) ? 'request-answered' : 'frame-without-reply')
    if (spec.blankLineInBody && spec.kind !== 'blank-line' && spec.kind !== 'header-without-length' && spec.kind !== 'not-json') {
      states.add('blank-line-inside-a-message')
    }
    if (/[^\x00-\x7f]/.test(spec.text) && spec.kind === 'initialize') states.add('length-in-bytes-not-characters')
  }
  if (history.frames.length > 1) states.add('several-frames')
  const { chunks } = streamOf(history)
  if (chunks.length > 1) states.add('cut-into-chunks')
  const last = history.frames.at(-1)!
  if (history.withheld % written(last, history.frames.length).length > 0) states.add('frame-arrives-in-two-parts')
  return states
}

oracleProperty({
  id: 'content-mapper-frames',
  owns: ['src/content-mapper.ts#handleInputChunk'],
  law: {
    statement:
      'For every stream of frames, cut into chunks at any places, handleInputChunk writes one reply for each request that has an id, in the order of the requests, each as one frame whose Content-Length is the byte length of its body: the method\'s result, error -32601 for a method the mapper does not have, and error -32603 with the error\'s text for a method that throws; it writes nothing for a message without an id, for a body that is not JSON, and for a header block without a Content-Length; and it keeps the bytes of a frame that is not complete until the rest arrives, so the replies do not depend on where the stream is cut.',
    authority:
      'TypeScript 7.1\'s content mapper protocol (node_modules/typescript/schemas/contentmapper.schema.json): JSON-RPC 2.0 in Content-Length frames. Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-23: Law M2, unknown methods return JSON-RPC error -32601. Decision by Manuel Schiller, 2026-11-24: close all gaps; the four that were left were endless loops in this reader.',
    limits:
      'Up to five frames of eight kinds, with a second header line, a lower-case length, a blank line inside the body, and text that is not ASCII; up to six cuts; the last frame arriving in two parts. The methods called are the three that need no TypeScript program. A frame whose length is larger than what ever arrives stays kept, which no history ends on.',
  },
  histories: {
    arbitrary: wireArbitrary,
    runs: 300,
    fixedSeeds: [42, 7],
    states: [
      'request-answered',
      'frame-without-reply',
      'several-frames',
      'cut-into-chunks',
      'frame-arrives-in-two-parts',
      'blank-line-inside-a-message',
      'length-in-bytes-not-characters',
    ],
    constructed: [
      {
        name: 'one-request-in-one-chunk',
        enters: ['request-answered'],
        build: (): WireHistory => ({ frames: [frame('initialize')], cuts: [], withheld: 0 }),
      },
      {
        name: 'request-cut-in-header-and-body',
        enters: ['request-answered', 'cut-into-chunks'],
        build: (): WireHistory => ({ frames: [frame('initialize', { text: 'v2' })], cuts: [8, 35], withheld: 0 }),
      },
      {
        name: 'request-one-byte-at-a-time',
        enters: ['request-answered', 'cut-into-chunks', 'length-in-bytes-not-characters'],
        build: (): WireHistory => ({
          frames: [frame('initialize', { text: '✓ ok' })],
          cuts: Array.from({ length: 6 }, (_, index) => index * 11 + 3),
          withheld: 0,
        }),
      },
      {
        name: 'second-part-arrives-later',
        enters: ['request-answered', 'frame-arrives-in-two-parts', 'several-frames'],
        build: (): WireHistory => ({ frames: [frame('close'), frame('initialize', { text: 'é' })], cuts: [], withheld: 9 }),
      },
      {
        name: 'blank-line-inside-the-message',
        enters: ['request-answered', 'blank-line-inside-a-message', 'several-frames'],
        build: (): WireHistory => ({
          frames: [frame('initialize', { blankLineInBody: true, text: '\r\n\r\n' }), frame('unknown-method', { blankLineInBody: true })],
          cuts: [30],
          withheld: 0,
        }),
      },
      {
        name: 'frames-that-get-no-reply-between-requests',
        enters: ['request-answered', 'frame-without-reply', 'several-frames'],
        build: (): WireHistory => ({
          frames: [frame('blank-line'), frame('header-without-length'), frame('notification'), frame('not-json'), frame('method-that-throws')],
          cuts: [],
          withheld: 0,
        }),
      },
      {
        name: 'headers-of-every-kind',
        enters: ['request-answered', 'several-frames'],
        build: (): WireHistory => ({
          frames: [frame('initialize', { otherHeader: true }), frame('unknown-method', { lowerCase: true }), frame('close', { otherHeader: true, lowerCase: true })],
          cuts: [5, 50, 90],
          withheld: 3,
        }),
      },
    ],
  },
  model: (history) => wireModel(history),
  driver: (history, observe) => {
    for (const state of wireStates(history)) observe('reach', state)
    try {
      const state = { buffer: Buffer.alloc(0) }
      const { chunks, rest } = streamOf(history)
      const feed = (parts: ReadonlyArray<Buffer>) => {
        const output: Array<Buffer> = []
        for (const chunk of parts) handleInputChunk(state, chunk, (reply) => output.push(reply))
        return { ...readReplies(output), kept: state.buffer.length }
      }
      const firstPart = feed(chunks)
      observe('wire', { firstPart, afterTheRest: feed([rest]) })
    } catch (error) {
      observe('wire', { threw: error instanceof Error ? error.message : String(error) })
    }
  },
  check: (_history, observations, expected) =>
    differs('wire', 'wire', observations.find((o) => o.checkpoint === 'wire')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'a-frame-in-two-parts-is-answered-twice',
      law: 'wire',
      history: { constructed: 'second-part-arrives-later' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'wire') return o
          const value = o.value as { firstPart: { replies: Array<unknown> }; afterTheRest: { replies: Array<unknown> } }
          return { ...o, value: { ...value, firstPart: { ...value.firstPart, replies: [...value.firstPart.replies, ...value.afterTheRest.replies] } } }
        }),
    },
    {
      name: 'a-notification-is-answered',
      law: 'wire',
      history: { constructed: 'frames-that-get-no-reply-between-requests' },
      corrupt: (trace) =>
        trace.map((o) => {
          if (o.checkpoint !== 'wire') return o
          const value = o.value as { firstPart: { replies: Array<unknown> } }
          return { ...o, value: { ...value, firstPart: { ...value.firstPart, replies: [{ id: 3, result: {} }, ...value.firstPart.replies] } } }
        }),
    },
  ],
})

// ---------------------------------------------------------------------------
// The mapper as a process: serve an input until it ends
// ---------------------------------------------------------------------------

interface ServeHistory {
  name: string
  states: ReadonlyArray<string>
  /** Whether a request needs the TypeScript API, so that the mapper opens one. */
  usesTheApi: boolean
  /** Whether the request arrives in two chunks. */
  cut: boolean
}

const SERVE_HISTORIES: ReadonlyArray<ServeHistory> = [
  { name: 'ends-without-opening-the-api', states: ['no-api-opened'], usesTheApi: false, cut: false },
  { name: 'ends-after-opening-the-api', states: ['api-opened'], usesTheApi: true, cut: false },
  { name: 'request-in-two-chunks', states: ['api-opened', 'cut-into-chunks'], usesTheApi: true, cut: true },
  { name: 'two-chunks-without-the-api', states: ['no-api-opened', 'cut-into-chunks'], usesTheApi: false, cut: true },
]

let serveRuns = 0

oracleProperty({
  id: 'content-mapper-serves-its-input',
  owns: ['src/content-mapper.ts#serve'],
  law: {
    statement:
      'For every stream of frames arriving on an input, serve(input, output) writes to the output the reply owed for each request, however the stream is cut into chunks; when the input ends it closes the TypeScript API the mapper opened, if it opened one, and does nothing if it opened none; and it can serve another input afterwards.',
    authority:
      'TypeScript 7.1\'s content mapper protocol: the compiler starts the mapper as a process, writes requests to its standard input and closes it when done. Decision by Manuel Schiller (GitHub schiller-manuel), 2026-11-24: close all gaps; the code that served standard input was owned by no oracle.',
    limits:
      'One request per input, whole or in two chunks, with and without a use of the TypeScript API. The input is an event emitter and the output collects what is written; that the process hands its own standard input and output to serve is the two lines of src/content-mapper-main.ts, which checks/verify.mjs runs through the real compiler.',
  },
  histories: {
    enumerated: SERVE_HISTORIES,
    states: ['no-api-opened', 'api-opened', 'cut-into-chunks'],
  },
  label: (history) => history.name,
  model: (history) => ({
    answered: history.usesTheApi ? 'registry-for-no-targets' : 'protocol-version',
    apisClosedWhenTheInputEnded: history.usesTheApi ? 1 : 0,
    endingThrew: false,
    answeredOnAnotherInput: 'registry-for-no-targets',
    apisClosedByTheSecondEnd: 1,
  }),
  driver: (history, observe) => {
    for (const state of history.states) observe('reach', state)
    try {
      serveRuns += 1
      // `close` is an accessor of the API class, and every call of it reads the accessor once.
      // (Its declared type is the function it returns, which is why the spy is told that it is a value.)
      const closes = vi.spyOn(API.prototype as unknown as { readonly close: unknown }, 'close', 'get')
      const request = (id: number, usesTheApi: boolean) => {
        const body = Buffer.from(
          JSON.stringify(
            usesTheApi
              ? // An empty list of targets needs TypeScript only to read the manifest's JSON.
                { jsonrpc: '2.0', id, method: 'transform', params: { projectHandle: `serve-${serveRuns}`, fileName: `/nowhere-${serveRuns}/points.ep`, content: '{"targets": []}' } }
              : { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: 'served' } },
          ),
          'utf8',
        )
        return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
      }
      /** Serves one input, and says what was answered and how many APIs its end closed. */
      const serveOne = (usesTheApi: boolean, cut: boolean) => {
        const input = new EventEmitter()
        const output: Array<Buffer> = []
        serve(input, { write: (reply: Buffer) => output.push(reply) })
        const bytes = request(1, usesTheApi)
        for (const chunk of cut ? [bytes.subarray(0, 20), bytes.subarray(20)] : [bytes]) input.emit('data', chunk)
        const [reply] = readReplies(output).replies as Array<{ result?: { protocolVersion?: string; text?: string; diagnostics?: Array<unknown> } }>
        const answered =
          reply?.result?.protocolVersion === 'served'
            ? 'protocol-version'
            : reply?.result?.text?.includes('interface ExecutionPointFileRegistry') && reply.result.diagnostics?.length === 0
              ? 'registry-for-no-targets'
              : JSON.stringify(reply)
        const closedBefore = closes.mock.calls.length
        let endingThrew = false
        try {
          input.emit('end')
        } catch {
          endingThrew = true
        }
        return { answered, closed: closes.mock.calls.length - closedBefore, endingThrew }
      }
      const first = serveOne(history.usesTheApi, history.cut)
      // The API of the first input is closed and gone: another input gets one of its own.
      const second = serveOne(true, false)
      observe('served', {
        answered: first.answered,
        apisClosedWhenTheInputEnded: first.closed,
        endingThrew: first.endingThrew || second.endingThrew,
        answeredOnAnotherInput: second.answered,
        apisClosedByTheSecondEnd: second.closed,
      })
    } catch (error) {
      observe('served', { threw: error instanceof Error ? error.message : String(error) })
    }
  },
  check: (_history, observations, expected) =>
    differs('served', 'served', observations.find((o) => o.checkpoint === 'served')?.value, expected) ?? pass,
  calibrations: [
    {
      name: 'the-api-is-left-open',
      law: 'served',
      history: { enumerated: 'ends-after-opening-the-api' },
      corrupt: (trace) =>
        trace.map((o) => (o.checkpoint === 'served' ? { ...o, value: { ...(o.value as object), apisClosedWhenTheInputEnded: 0 } } : o)),
    },
  ],
})
