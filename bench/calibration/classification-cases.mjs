/**
 * Calibration cases for failure classification (PROTOCOL section 2, D-16 and
 * D-19; harness v2.5): only an assertion failure is a reproduction, and the
 * type of an error is its `name` as Vitest holds it, not the first line of the
 * stack it prints.
 *
 * Cases marked `undecided` state TODAY's grading of a question the maintainer
 * has not decided (`UNDECIDED_GRADINGS` in `bench/classify.mjs`). When one is
 * decided, the rule there and the case here change together.
 */

const A = (message, causes = []) => ({ name: 'AssertionError', message, causes })
const E = (name, message, causes = []) => ({ name, message, causes })

/**
 * One error as `bench/failure-reporter.mjs` describes it -> its kind.
 * `stackHead` is what Vitest prints as the first line of that error's stack;
 * it is here to show which cases the v2.4 rule, which read that line, gets wrong.
 */
export const ERROR_KIND_CASES = [
  [A('expected 1 to be 2 // Object.is equality'), 'assertion', 'AssertionError: expected 1 to be 2 // Object.is equality'],
  [A('values differ'), 'assertion', 'AssertionError [ERR_ASSERTION]: values differ'],
  [A("expected 'matched 2 rows' to be 'matched 1 row' // Object.is equality"), 'assertion', "AssertionError: expected 'matched 2 rows' to be 'matched 1 row' // Object.is equality"],
  [A("expected [Function] to not throw an error but 'TypeError: cb is not a function' was thrown"), 'assertion', "AssertionError: expected [Function] to not throw an error but 'TypeError: cb is not a function' was thrown"],
  [A('expected "[execution-points] nope" to contain "ok"'), 'assertion', 'AssertionError: expected "[execution-points] nope" to contain "ok"'],
  // An AssertionError whose stack starts with `Error:` (D-19).
  [A(`promise resolved "'ok:p2'" instead of rejecting`), 'assertion', `Error: promise resolved "'ok:p2'" instead of rejecting`],
  [A('promise rejected "Error: boom" instead of resolving', [E('Error', 'boom')]), 'assertion', 'Error: promise rejected "Error: boom" instead of resolving'],
  [A("expected [Function] to throw error including 'other' but got 'boom'"), 'assertion', "Error: expected [Function] to throw error including 'other' but got 'boom'"],
  [A('expected 1 to be 2 // Object.is equality', [E('Error', 'Matcher did not succeed in time.')]), 'assertion', 'Error: expected 1 to be 2 // Object.is equality'],
  [E('TestTimeoutError', 'Test timed out in 1500ms.\nIf this is a long-running test, pass a timeout value'), 'timeout', 'TestTimeoutError: Test timed out in 1500ms.'],
  [E('Error', 'Hook timed out in 10000ms.'), 'timeout', 'Error: Hook timed out in 10000ms.'],
  [E('Error', '[execution-points] Visitor for "src/a.ts" must match exactly 1 expression; matched 0.'), 'selector_break', 'Error: [execution-points] Visitor for "src/a.ts" must match exactly 1 expression; matched 0.'],
  [E('Error', '[execution-points] Visitor for "src/a.ts" must match exactly 1 expression; matched 2.'), 'selector_break', 'Error: [execution-points] Visitor for "src/a.ts" must match exactly 1 expression; matched 2.'],
  [E('Error', '[execution-points] Target file "src/a.ts" was not instrumented or has not been imported yet. Check targets.'), 'selector_break', 'Error: [execution-points] Target file "src/a.ts" was not instrumented or has not been imported yet. Check targets.'],
  [E('Error', '[execution-points] The replacement for "src/a.ts#f:CallExpression:g:0" ran 0 times; expected at least once.'), 'selector_break', 'Error: [execution-points] The replacement for "src/a.ts#f:CallExpression:g:0" ran 0 times; expected at least once.'],
  [E('TypeError', "[execution-points] `times` must be a whole number, 0 or more, or 'any'."), 'selector_break', "TypeError: [execution-points] `times` must be a whole number, 0 or more, or 'any'."],
  [E('AggregateError', '[execution-points] The replacement for "a" ran 0 times; expected at least once.\n[execution-points] "b" was still paused when the test ended.'), 'selector_break', 'AggregateError: [execution-points] The replacement for "a" ran 0 times; expected at least once.'],
  [E('InterleavingFailure', '[execution-points] The scenario failed in this order:\n  1. a\nIt failed with: no item sku-1', [E('Error', 'no item sku-1')]), 'selector_break', 'InterleavingFailure: [execution-points] The scenario failed in this order:'],
  [E('Error', "Cannot find module './gone' imported from '/x/src/a.test.ts'"), 'load_break', "Error: Cannot find module './gone' imported from '/x/src/a.test.ts'"],
  [E('Error', 'Failed to resolve import "./gone" from "src/a.test.ts". Does the file exist?'), 'load_break', 'Error: Failed to resolve import "./gone" from "src/a.test.ts". Does the file exist?'],
  [E('SyntaxError', 'Unexpected token (3:1)'), 'load_break', 'SyntaxError: Unexpected token (3:1)'],
  [E('TypeError', 'Forbidden global monkey-patch: runtime:globalThis.Promise'), 'guard', 'TypeError: Forbidden global monkey-patch: runtime:globalThis.Promise'],
  [E('TypeError', 'helper is not a function'), 'error', 'TypeError: helper is not a function'],
  [E('Error', "ENOENT: no such file or directory, open '/tmp/x/j1.stage.tmp'"), 'error', "Error: ENOENT: no such file or directory, open '/tmp/x/j1.stage.tmp'"],
  [E('ReferenceError', 'matched is not defined'), 'error', 'ReferenceError: matched is not defined'],
  [E('Error', 'matched 2 rows but wanted 1'), 'error', 'Error: matched 2 rows but wanted 1'],
  // A thrown value that is no error object has no name.
  [E('', 'just a string'), 'error', 'just a string'],
  // An error of the test's own that wraps an assertion is graded by its own name.
  [E('Error', 'wrapped', [A('expected 1 to be 2')]), 'error', 'Error: wrapped'],
  // A text that only looks like an assertion is not one.
  [E('Error', 'AssertionError: expected 1 to be 2'), 'error', 'Error: AssertionError: expected 1 to be 2'],
]

/** The same, for the two questions that are not decided. */
export const UNDECIDED_KIND_CASES = [
  {
    undecided: 'libraryErrorCausedByAssertion',
    error: E('InterleavingFailure', '[execution-points] The scenario failed in this order:\n  1. a\nIt failed with: expected 15 to be 14', [A('expected 15 to be 14 // Object.is equality')]),
    today: 'selector_break',
  },
  { undecided: 'expectationThrownAsPlainError', error: E('Error', 'expected number of assertions to be 2, but got 1'), today: 'error' },
  { undecided: 'expectationThrownAsPlainError', error: E('Error', 'expected any number of assertion, but got none'), today: 'error' },
  { undecided: 'expectationThrownAsPlainError', error: E('Error', 'Snapshot `inline snapshot mismatch 1` mismatched'), today: 'error' },
]

/** The errors of the failed tests of one run (one list per failed test) -> the run's outcome. */
export const RUN_OUTCOME_CASES = [
  [[[E('TypeError', 'x is not a function')]], 'error'],
  [[[E('Error', '[execution-points] Visitor for "a" must match exactly 1 expression; matched 0.')]], 'loud_break'],
  [[[E('TestTimeoutError', 'Test timed out in 1500ms.')]], 'timeout'],
  // A test that timed out and then failed the library's check at its end.
  [[[E('TestTimeoutError', 'Test timed out in 1500ms.'), E('Error', '[execution-points] The replacement for "a" ran 0 times; expected at least once.')]], 'timeout'],
  [[[E('TypeError', 'x is not a function')], [A('expected 1 to be 2')]], 'true_red'],
  // An assertion that failed while a pause was still held: the assertion decides.
  [[[A('expected 15 to be 14'), E('Error', '[execution-points] "a" was still paused when the test ended. Call release() on the pause.')]], 'true_red'],
  [[[E('Error', '[execution-points] x')], [E('Error', "ENOENT: no such file or directory, open 'a'")]], 'loud_break'],
  [[[A(`promise resolved "'ok:p2'" instead of rejecting`)]], 'true_red'],
  // A failed test for which Vitest holds no error at all.
  [[[]], 'error'],
]

const STORE = `import { getProfile, resetStore, seedProfile } from './profile-store'
`
const SELECT_FORMAT = `import { select } from 'execution-points-prototype'
const formatPoint = select('src/profile-store.ts', (n: any) => n.callee === 'formatProfile' && n)
`

/**
 * The same through real Vitest runs in a `stale-cache` workspace of the named
 * arm. `want` is the run's outcome. `wantError`, when given, is an error the
 * result must record: its `name`, its `kind`, and the names of its causes.
 */
export const E2E_CLASSIFICATION_CASES = [
  {
    name: 'hanging test -> timeout',
    arm: 'control',
    want: 'timeout',
    test: `import { test } from 'vitest'
test('hangs forever waiting for uncalled seam', async () => {
  await new Promise(() => {})
}, 150)
`,
  },
  {
    name: 'expect() failure -> true_red',
    arm: 'control',
    want: 'true_red',
    test: `import { expect, test } from 'vitest'
test('assertion', () => { expect(1).toBe(2) })
`,
  },
  {
    name: 'node:assert failure -> true_red',
    arm: 'control',
    want: 'true_red',
    test: `import assert from 'node:assert/strict'
import { test } from 'vitest'
test('assertion', () => { assert.equal(1, 2) })
`,
  },
  {
    name: 'assertion text contains "matched 2" -> true_red',
    arm: 'control',
    want: 'true_red',
    test: `import { expect, test } from 'vitest'
test('assertion', () => { expect('matched 2 rows').toBe('matched 1 row') })
`,
  },
  {
    name: 'assertion text contains "is not a function" -> true_red',
    arm: 'control',
    want: 'true_red',
    test: `import { expect, test } from 'vitest'
test('assertion', () => {
  expect(() => { throw new TypeError('cb is not a function') }).not.toThrow()
})
`,
  },
  {
    name: 'expect(p).rejects on a promise that resolves -> true_red (its stack starts with "Error:")',
    arm: 'control',
    want: 'true_red',
    wantError: { name: 'AssertionError', kind: 'assertion', causes: [] },
    test: `import { expect, test } from 'vitest'
test('must reject', async () => { await expect(Promise.resolve('ok:p2')).rejects.toThrow() })
`,
  },
  {
    name: 'expect(p).resolves on a promise that rejects -> true_red',
    arm: 'control',
    want: 'true_red',
    wantError: { name: 'AssertionError', kind: 'assertion', causes: ['Error'] },
    test: `import { expect, test } from 'vitest'
test('must resolve', async () => { await expect(Promise.reject(new Error('Gateway 502'))).resolves.toBe('ok') })
`,
  },
  {
    name: 'expect(p).rejects.toThrow(message) with another message -> true_red',
    arm: 'control',
    want: 'true_red',
    wantError: { name: 'AssertionError', kind: 'assertion', causes: [] },
    test: `import { expect, test } from 'vitest'
test('must reject with', async () => { await expect(Promise.reject(new Error('boom'))).rejects.toThrow('other') })
`,
  },
  {
    name: 'expect.poll that never holds -> true_red',
    arm: 'control',
    want: 'true_red',
    wantError: { name: 'AssertionError', kind: 'assertion', causes: ['Error'] },
    test: `import { expect, test } from 'vitest'
test('poll', async () => { await expect.poll(() => 1, { timeout: 120, interval: 20 }).toBe(2) })
`,
  },
  {
    name: 'await of a call that rejects, no expect around it -> error (D-16: an escaped error)',
    arm: 'control',
    want: 'error',
    wantError: { name: 'Error', kind: 'error', causes: [] },
    test: `import { expect, test } from 'vitest'
test('escapes', async () => { expect(await Promise.reject(new Error('Gateway 502'))).toBe('ok') })
`,
  },
  {
    name: 'an error of the test that wraps an assertion -> error (graded by its own name)',
    arm: 'control',
    want: 'error',
    wantError: { name: 'Error', kind: 'error', causes: ['AssertionError'] },
    test: `import { expect, test } from 'vitest'
test('wraps', () => {
  try { expect(1).toBe(2) } catch (cause) { throw new Error('wrapped', { cause }) }
})
`,
  },
  {
    name: 'TypeError "is not a function" -> error (not a reproduction, not a selector break)',
    arm: 'control',
    want: 'error',
    test: `import { test } from 'vitest'
import * as store from './profile-store'
test('calls a helper that does not exist', () => {
  ;(store as unknown as { noSuchHelper: () => void }).noSuchHelper()
})
`,
  },
  {
    name: 'ENOENT escaping the code under test -> error',
    arm: 'control',
    want: 'error',
    test: `import fs from 'node:fs/promises'
import { test } from 'vitest'
test('rejection escapes', async () => { await fs.readFile('/no/such/dir/j1.stage.tmp', 'utf8') })
`,
  },
  {
    name: 'all tests pass but a rejection is unhandled -> error (Vitest exits non-zero)',
    arm: 'control',
    want: 'error',
    test: `import { expect, test } from 'vitest'
test('passes while a rejection is left unhandled', async () => {
  void Promise.reject(new Error('left behind'))
  await new Promise<void>((r) => setImmediate(r))
  expect(1).toBe(1)
})
`,
  },
  {
    name: 'expect.assertions(n) not met -> error',
    undecided: 'expectationThrownAsPlainError',
    arm: 'control',
    want: 'error',
    wantError: { name: 'Error', kind: 'error', causes: [] },
    test: `import { expect, test } from 'vitest'
test('counts', () => { expect.assertions(2); expect(1).toBe(1) })
`,
  },
  {
    name: 'expect.hasAssertions() not met -> error',
    undecided: 'expectationThrownAsPlainError',
    arm: 'control',
    want: 'error',
    wantError: { name: 'Error', kind: 'error', causes: [] },
    test: `import { expect, test } from 'vitest'
test('has', () => { expect.hasAssertions() })
`,
  },
  {
    name: 'a snapshot that does not match -> error',
    undecided: 'expectationThrownAsPlainError',
    arm: 'control',
    want: 'error',
    wantError: { name: 'Error', kind: 'error', causes: [] },
    test: `import { expect, test } from 'vitest'
test('snapshot', () => { expect('a').toMatchInlineSnapshot(\`"b"\`) })
`,
  },
  {
    name: 'library: visitor matches 0 inside a test -> loud_break',
    arm: 'treatment',
    want: 'loud_break',
    test: `import { test } from 'vitest'
import { select } from 'execution-points-prototype'
import { getProfile } from './profile-store'
test('selector that matches nothing', async () => {
  const point = select('src/profile-store.ts', (n: any) => n.callee === 'noSuchHelper' && n)
  await point.withReplacement(async ({ original }: any) => original(), () => getProfile('u1'))
})
`,
  },
  {
    name: 'library: visitor matches 2 inside a test -> loud_break',
    arm: 'treatment',
    want: 'loud_break',
    test: `import { test } from 'vitest'
import { select } from 'execution-points-prototype'
import { getProfile } from './profile-store'
test('selector that matches twice', async () => {
  const point = select('src/profile-store.ts', (n: any) => n.callee === 'yieldIo' && n)
  await point.withReplacement(async ({ original }: any) => original(), () => getProfile('u1'))
})
`,
  },
  {
    name: 'library: target file was not instrumented -> loud_break',
    arm: 'treatment',
    want: 'loud_break',
    test: `import { test } from 'vitest'
import { select } from 'execution-points-prototype'
test('selects in a file that is not a target', async () => {
  const point = select('src/not-a-target.ts', (n: any) => n)
  await point.withReplacement(async ({ original }: any) => original(), async () => 1)
})
`,
  },
  {
    name: 'library: every assertion passes and the replacement never ran -> loud_break (the check after the test)',
    arm: 'treatment',
    want: 'loud_break',
    wantError: { name: 'Error', kind: 'selector_break', causes: [] },
    test: `import { expect, test } from 'vitest'
${SELECT_FORMAT}${STORE}
test('warm read', async () => {
  resetStore()
  // Nothing is seeded, so the read finds no profile and never formats one.
  const found = await formatPoint.withReplacement(async ({ original }: any) => original(), () => getProfile('nobody'))
  expect(found).toBeNull()
})
`,
  },
  {
    name: 'library: the paused operation never gets there -> loud_break, at once',
    arm: 'treatment',
    want: 'loud_break',
    wantError: { name: 'Error', kind: 'selector_break', causes: [] },
    test: `import { test } from 'vitest'
${SELECT_FORMAT}${STORE}
test('pause that is never reached', async () => {
  resetStore()
  const pause = formatPoint.pause()
  const read = pause.run(() => getProfile('nobody'))
  await pause.reached
  pause.release()
  await read
})
`,
  },
  {
    name: 'library: an assertion fails while the pause is still held -> true_red',
    arm: 'treatment',
    want: 'true_red',
    wantError: { name: 'AssertionError', kind: 'assertion', causes: [] },
    test: `import { expect, test } from 'vitest'
${SELECT_FORMAT}${STORE}
test('checks while held', async () => {
  resetStore()
  seedProfile('u1', 'Alice')
  const pause = formatPoint.pause()
  const read = pause.run(() => getProfile('u1'))
  await pause.reached
  expect(1).toBe(2)
  pause.release()
  await read
})
`,
  },
  {
    name: 'library: an assertion fails inside order.run() of interleavings -> loud_break, with the AssertionError recorded as the cause',
    undecided: 'libraryErrorCausedByAssertion',
    arm: 'treatment',
    want: 'loud_break',
    wantError: { name: 'InterleavingFailure', kind: 'selector_break', causes: ['AssertionError'] },
    test: `import { expect, test } from 'vitest'
import { interleavings, select } from 'execution-points-prototype'
${STORE}
const formatPoint = select('src/profile-store.ts', (n: any) => n.callee === 'formatProfile' && n)
test('every order', async () => {
  for (const order of interleavings([formatPoint as any])) {
    resetStore()
    seedProfile('u1', 'Alice')
    await order.run(async () => {
      const profile = await getProfile('u1')
      expect(profile?.name).toBe('Bob')
    })
  }
})
`,
  },
  {
    name: 'library: the same assertion after order.run() -> true_red',
    arm: 'treatment',
    want: 'true_red',
    wantError: { name: 'AssertionError', kind: 'assertion', causes: [] },
    test: `import { expect, test } from 'vitest'
import { interleavings, select } from 'execution-points-prototype'
${STORE}
const formatPoint = select('src/profile-store.ts', (n: any) => n.callee === 'formatProfile' && n)
test('every order', async () => {
  for (const order of interleavings([formatPoint as any])) {
    resetStore()
    seedProfile('u1', 'Alice')
    const profile = await order.run(() => getProfile('u1'))
    expect(profile?.name).toBe('Bob')
  }
})
`,
  },
]
