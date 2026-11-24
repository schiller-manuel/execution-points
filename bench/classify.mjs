/**
 * Failure classification for agent regression tests (harness v2.5).
 *
 * The rule a reader of `bench/PROTOCOL.md` section 2 relies on: a test run
 * reproduces a bug only when at least one test fails on an assertion. Every
 * other way of going red is a different outcome and never a reproduction.
 *
 * A failure is classified by the TYPE of the error the test threw: the `name`
 * of the error as Vitest holds it, which `bench/failure-reporter.mjs` writes
 * down together with the `name` of every `cause` behind it. The text Vitest
 * prints is not used. Up to v2.4 the type was read from the first line of the
 * stack, and that line says `Error:` for a failed `expect(p).rejects`,
 * `expect(p).resolves` and `expect.poll`, whose error is an `AssertionError`
 * (D-19). The text inside a message is matched only for errors that have no
 * type of their own to go by: Vitest's timeout, the library's prefix, a module
 * that did not load, and the guard's refusal.
 *
 * Kinds of a single error of a failed test:
 * - `assertion`       an `AssertionError` (Vitest/chai `expect`, `node:assert`).
 * - `timeout`         Vitest's test or hook timeout.
 * - `selector_break`  an error raised by `execution-points-prototype`; all of
 *                     its messages start with `[execution-points]`.
 * - `load_break`      the module graph did not load (missing module, syntax or
 *                     transform error, missing export).
 * - `guard`           the harness's runtime guard refused a global patch or a
 *                     sleep.
 * - `error`           any other thrown error or rejection, for example a
 *                     `TypeError: x is not a function` or an `ENOENT` that
 *                     escaped the code under test.
 *
 * Outcomes of one Vitest run (see `classifyFailedTests`):
 * `passed`, `true_red`, `timeout`, `loud_break`, `error`, `runtime_violation`.
 * Repeated runs that disagree are `unstable` (see `agreeOnOutcome`).
 */

/** Messages of `execution-points-prototype` start with this prefix. */
export const LIBRARY_MESSAGE_PREFIX = '[execution-points]'

/**
 * Two gradings that are the maintainer's to decide and are not decided
 * (asked on 2026-11-24). Each is ONE rule: the kind named here. To change a
 * decision, change the kind here and the self-test case that states today's
 * grading (`bench/calibration/classification-cases.mjs`, the cases marked
 * `undecided`); nothing else depends on it.
 */
export const UNDECIDED_GRADINGS = Object.freeze({
  /**
   * An error of the library that has an `AssertionError` among its causes. An
   * assertion that fails inside `order.run(...)` of `interleavings` arrives
   * this way, as an `InterleavingFailure`. Today it is graded like every other
   * error of the library: 'selector_break', a loud break. 'assertion' would
   * grade it as a reproduction.
   */
  libraryErrorCausedByAssertion: 'selector_break',
  /**
   * A failed expectation that Vitest throws as a plain `Error`:
   * `expect.assertions(n)`, `expect.hasAssertions()`, and a snapshot that does
   * not match. Today: 'error', no reproduction. 'assertion' would be one.
   */
  expectationThrownAsPlainError: 'error',
})

const ASSERTION_NAME = /(?:^|\.)\w*AssertionError$/
const TIMEOUT_NAMES = new Set(['TestTimeoutError', 'HookTimeoutError'])
const TIMEOUT = /^(?:Test|Hook) timed out in \d+ms/
const LOAD_BREAK =
  /^(?:Cannot find (?:module|package)\b|Failed to resolve import\b|Failed to load url\b|Transform failed\b|The requested module .* does not provide an export named\b)/
const GUARD = /^Forbidden (?:global monkey-patch|sleep)\b/
const EXPECTATION_AS_PLAIN_ERROR =
  /^(?:expected number of assertions to be \d+, but got \d+|expected any number of assertion, but got none|Snapshot [\s\S]* mismatched)/

const isAssertion = (error) => typeof error?.name === 'string' && ASSERTION_NAME.test(error.name)

/**
 * The kind of one error of a failed test. `error` is what
 * `bench/failure-reporter.mjs` describes: `{ name, message, causes }`.
 */
export function classifyError(error) {
  const name = typeof error?.name === 'string' ? error.name : ''
  const message = String(error?.message ?? '').trim()
  if (isAssertion(error)) return 'assertion'
  if (TIMEOUT_NAMES.has(name) || TIMEOUT.test(message)) return 'timeout'
  if (message.startsWith(LIBRARY_MESSAGE_PREFIX)) {
    return (error.causes ?? []).some(isAssertion) ? UNDECIDED_GRADINGS.libraryErrorCausedByAssertion : 'selector_break'
  }
  if (GUARD.test(message)) return 'guard'
  if (name === 'SyntaxError' || LOAD_BREAK.test(message)) return 'load_break'
  if (name === 'Error' && EXPECTATION_AS_PLAIN_ERROR.test(message)) return UNDECIDED_GRADINGS.expectationThrownAsPlainError
  return 'error'
}

/** `Name: message`, with every cause behind it, on one line. */
export function formatError(error) {
  const one = (e) => `${e?.name || 'thrown value'}: ${String(e?.message ?? '').split('\n')[0]}`
  return [one(error), ...(error?.causes ?? []).map((cause) => `caused by ${one(cause)}`)].join(' <- ')
}

const EMPTY_KINDS = () => ({
  assertion: 0,
  timeout: 0,
  selector_break: 0,
  load_break: 0,
  guard: 0,
  error: 0,
})

/**
 * Classifies the failed tests of one Vitest run. `failedTests` is a list of
 * `{ errors: [{ name, message, causes }] }`, as `bench/failure-reporter.mjs`
 * writes them. A failed test with no error at all counts as `error`.
 *
 * - `true_red`   at least one failed test threw an assertion.
 * - `timeout`    no assertion, at least one timeout.
 * - `loud_break` no assertion or timeout, at least one selector, load or guard error.
 * - `error`      only other errors.
 */
export function classifyFailedTests(failedTests) {
  const kinds = EMPTY_KINDS()
  for (const t of failedTests) {
    if (!Array.isArray(t?.errors)) {
      throw new TypeError('classifyFailedTests needs the errors of each failed test as the failure reporter describes them')
    }
    if (t.errors.length === 0) {
      kinds.error++
      continue
    }
    for (const error of t.errors) kinds[classifyError(error)]++
  }
  let outcome = 'error'
  if (kinds.assertion > 0) outcome = 'true_red'
  else if (kinds.timeout > 0) outcome = 'timeout'
  else if (kinds.selector_break + kinds.load_break + kinds.guard > 0) outcome = 'loud_break'
  return { outcome, kinds }
}

/**
 * Repeated runs of the same test against the same code must agree. Anything
 * else is its own outcome, `unstable`, which no gate accepts.
 */
export function agreeOnOutcome(outcomes) {
  if (outcomes.length === 0) return 'unstable'
  return outcomes.every((o) => o === outcomes[0]) ? outcomes[0] : 'unstable'
}

/** Outcome of a buggy behavior-preserving refactor, from the raw run outcome. */
export function refactorOutcome(runOutcome) {
  return runOutcome === 'passed' ? 'false_green' : runOutcome
}

/** Outcome of a calibrated valid fix, from the raw run outcome. */
export function validFixOutcome(runOutcome) {
  switch (runOutcome) {
    case 'passed':
      return 'true_green'
    case 'true_red':
      return 'false_red_assertion'
    case 'timeout':
      return 'timeout'
    case 'loud_break':
      return 'selector_or_compile_break'
    case 'error':
      return 'runtime_error'
    default:
      return runOutcome // 'runtime_violation', 'unstable'
  }
}

/**
 * Per-outcome counts of refactor results, the same for both arms and for rows
 * written by any harness version (older rows only carry `results`).
 *
 * `stoppedTesting` is every refactor on which the test neither failed on an
 * assertion nor passed: a selector or load break, a timeout, another error, a
 * guard violation, or disagreement between repeated runs. A missing
 * interception point shows up as a selector break in a library test and as a
 * timeout in a `vi.mock` test; both are counted here.
 */
export function countRefactorResults(results = []) {
  const c = {
    total: results.length,
    stillRed: 0,
    loudBreak: 0,
    timeout: 0,
    error: 0,
    unstable: 0,
    other: 0,
    falseGreen: 0,
  }
  for (const r of results) {
    if (r.outcome === 'true_red') c.stillRed++
    else if (r.outcome === 'false_green') c.falseGreen++
    else if (r.outcome === 'loud_break') c.loudBreak++
    else if (r.outcome === 'timeout') c.timeout++
    else if (r.outcome === 'error') c.error++
    else if (r.outcome === 'unstable') c.unstable++
    else c.other++
  }
  c.stoppedTesting = c.loudBreak + c.timeout + c.error + c.unstable + c.other
  return c
}

/**
 * Per-outcome counts of valid-fix results. `notGreen` is every valid fix the
 * test did not pass, whatever the reason, so a selector break and a timeout
 * enter the false-red rate the same way.
 */
export function countValidFixResults(results = []) {
  const c = {
    total: results.length,
    green: 0,
    assertion: 0,
    timeout: 0,
    selectorOrCompileBreak: 0,
    error: 0,
    unstable: 0,
    other: 0,
  }
  for (const r of results) {
    if (r.outcome === 'true_green') c.green++
    else if (r.outcome === 'false_red_assertion') c.assertion++
    else if (r.outcome === 'timeout') c.timeout++
    else if (r.outcome === 'selector_or_compile_break') c.selectorOrCompileBreak++
    else if (r.outcome === 'runtime_error') c.error++
    else if (r.outcome === 'unstable') c.unstable++
    else c.other++
  }
  c.notGreen = c.total - c.green
  return c
}
