/**
 * Vitest reporter of the benchmark harness (harness v2.6): writes the errors of
 * every failed test as Vitest holds them.
 *
 * `bench/classify.mjs` grades a failure by the type of the error. That type is
 * the error's own `name`, and for an error that wraps another one, the `name`
 * of each `cause` behind it. Neither is in the text Vitest prints: the first
 * line of the stack says `Error:` for a failed `expect(p).rejects`,
 * `expect(p).resolves` and `expect.poll`, although the object is an
 * `AssertionError`, and a cause is not in the stack at all. So the harness
 * reads both here, from the reporter API, and never from the text.
 *
 * The file is written once, when the run ends, to the path in
 * `BENCH_FAILURE_REPORT`:
 *
 *   { version, failedTests: [{ moduleId, fullName, errors: [described error] }],
 *     unhandledErrors: [described error] }
 *
 * A described error is `{ name, message, causes: [{ name, message }] }`.
 */
import { writeFileSync } from 'node:fs'

export const FAILURE_REPORT_VERSION = 1

const MAX_CAUSES = 8
const MAX_MESSAGE = 600

const text = (value) => {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value)
  return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}…` : s
}

/** `{ name, message }` of a thrown value as Vitest serialized it; a thrown non-object has no name. */
function nameAndMessage(thrown) {
  if (thrown !== null && typeof thrown === 'object') {
    return { name: typeof thrown.name === 'string' ? thrown.name : '', message: text(thrown.message) }
  }
  return { name: '', message: text(thrown) }
}

export function describeError(thrown) {
  const causes = []
  const seen = new Set([thrown])
  let cause = thrown !== null && typeof thrown === 'object' ? thrown.cause : undefined
  while (cause != null && causes.length < MAX_CAUSES && !seen.has(cause)) {
    seen.add(cause)
    causes.push(nameAndMessage(cause))
    cause = typeof cause === 'object' ? cause.cause : undefined
  }
  return { ...nameAndMessage(thrown), causes }
}

export default class BenchFailureReporter {
  onTestRunEnd(testModules, unhandledErrors) {
    const out = process.env.BENCH_FAILURE_REPORT
    if (!out) return
    const failedTests = []
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        const result = testCase.result()
        if (result.state !== 'failed') continue
        failedTests.push({
          moduleId: testModule.moduleId,
          fullName: testCase.fullName,
          errors: (result.errors ?? []).map(describeError),
        })
      }
    }
    writeFileSync(
      out,
      JSON.stringify({
        version: FAILURE_REPORT_VERSION,
        failedTests,
        unhandledErrors: (unhandledErrors ?? []).map(describeError),
      }),
    )
  }
}
