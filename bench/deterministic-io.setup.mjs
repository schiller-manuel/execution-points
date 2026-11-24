/**
 * Deterministic leaf disk I/O for grading sandboxes of real-filesystem tasks
 * (harness v2.4, protocol decision D-09). Loaded through Vitest `setupFiles`
 * before the runtime guard, only for tasks with `deterministicLeafIo: true`
 * and only while GRADING. Agents' own workspaces keep the real asynchronous
 * `node:fs/promises`.
 *
 * Why this exists. A regression test for an in-memory task orders two
 * operations with event-loop turns: it holds the first one at a barrier,
 * starts the second, waits a few `setImmediate` turns, and releases. That
 * works because everything the second operation waits on finishes within
 * event-loop turns. Real disk calls finish on libuv's thread pool at a time
 * the event loop does not control, so "wait 20 turns" lets the second
 * operation get through zero, one, or all of its disk calls depending on how
 * busy the machine is. On `cancel-commit` that made the verdict on the
 * `CC-M1-shared-stage-file` mutant change between identical gradings of the
 * same files.
 *
 * What it does. Every call of a path-based `node:fs/promises` function takes
 * effect on the real disk and settles after exactly one event-loop turn, in
 * the order the calls were made. The work itself is done by the matching
 * synchronous `node:fs` function inside a `setImmediate` callback. A disk call
 * therefore costs one turn, the same as one `MessageChannel` tick costs in the
 * in-memory tasks, and the same test file gives the same result on every run.
 * This mirrors what the hidden oracle's engine already does for its own
 * schedules (`activeLeafIo` in `bench/graders/yield-engine.mjs`).
 *
 * What it does not cover: `FileHandle`s from `fs.promises.open`, directory
 * handles, `watch`, `glob`, streams, and the callback API of `node:fs`. Code
 * that uses those still does real asynchronous I/O; repeated grading reports
 * the result as `unstable` if it then differs between runs.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const nativeSetImmediate = globalThis.setImmediate

/** Path-based functions whose synchronous twin has the same arguments and result. */
const DETERMINISTIC_FUNCTIONS = [
  'access',
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'lchown',
  'link',
  'lstat',
  'lutimes',
  'mkdir',
  'mkdtemp',
  'readdir',
  'readFile',
  'readlink',
  'realpath',
  'rename',
  'rm',
  'rmdir',
  'stat',
  'statfs',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'writeFile',
]

function isFileHandle(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.fd === 'number' &&
    typeof value.close === 'function'
  )
}

function findAbortSignal(args) {
  for (const arg of args) {
    if (arg !== null && typeof arg === 'object' && !ArrayBuffer.isView(arg)) {
      const signal = arg.signal
      if (signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean') {
        return signal
      }
    }
  }
  return null
}

function abortError(signal) {
  const err = new Error('The operation was aborted', { cause: signal.reason })
  err.name = 'AbortError'
  err.code = 'ABORT_ERR'
  return err
}

const promisesApi = fs.promises
const installed = []

for (const name of DETERMINISTIC_FUNCTIONS) {
  const original = promisesApi[name]
  const sync = fs[`${name}Sync`]
  if (typeof original !== 'function' || typeof sync !== 'function') continue

  const deterministic = {
    // Keeps the original function name in stack traces and for `fn.name` checks.
    [name](...args) {
      // A FileHandle has no synchronous twin: leave those calls to Node.
      if (isFileHandle(args[0])) return original.apply(promisesApi, args)
      const signal = findAbortSignal(args)
      return new Promise((resolve, reject) => {
        nativeSetImmediate(() => {
          if (signal?.aborted) {
            reject(abortError(signal))
            return
          }
          try {
            resolve(sync.apply(fs, args))
          } catch (err) {
            reject(err)
          }
        })
      })
    },
  }[name]

  promisesApi[name] = deterministic
  installed.push(name)
}

// `import { writeFile } from 'node:fs/promises'` reads live bindings of the built-in module.
syncBuiltinESMExports()

globalThis[Symbol.for('execution-points.bench.deterministic-io')] = Object.freeze({
  functions: Object.freeze([...installed]),
})
