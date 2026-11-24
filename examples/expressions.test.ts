import { expect, test } from 'vitest'
import { select } from 'execution-points-prototype'
import { invoice, remoteTotal } from './expressions'

// Minimal selectors: no kind or inFunction needed when operator/callee is unique
const sumPoint = select('examples/expressions.ts', (node) => node.operator === '+' && node)
  .capture('base', 'fee')

const remotePoint = select('examples/expressions.ts', (node) => node.callee === 'fetchTotal' && node)
  .capture('id', 'source')

// Resetting captures to empty via .capture() exposes an empty locals object ({})
const noLocalsSumPoint = sumPoint.capture()

test('replaces an arithmetic expression, not only a function call', () => {
  expect(invoice(10)).toBe(13)
  const result = sumPoint.withReplacement(({ locals, original }) => {
    expect(locals.base).toBe(10)
    expect(locals.fee).toBe(3)
    return original() * 2
  }, () => invoice(10))
  expect(result).toBe(26)
})

test('resets captured locals to empty with zero-arg .capture()', () => {
  const result = noLocalsSumPoint.withReplacement(({ locals, original }) => {
    expect(Object.keys(locals)).toEqual([])
    return original() + 1
  }, () => invoice(10))
  expect(result).toBe(14)
})

test('preserves the Promise contract of an expression inside await', async () => {
  const result = await remotePoint.withReplacement(async ({ locals }) => {
    expect(locals.id).toBe('abc')
    expect(locals.source).toBe('remote')
    return 42
  }, () => remoteTotal('abc'))
  expect(result).toBe(42)
  expect(await remoteTotal('abc')).toBe(30)
})

test('pauses an asynchronous call until the test releases it', async () => {
  const pause = remotePoint.pause()
  const slow = pause.run(() => remoteTotal('abc'))

  // Resolves when the call is reached; rejects at once if the action finishes without reaching it.
  const { locals } = await pause.reached
  expect(locals.id).toBe('abc')

  // While it waits, other work runs to completion.
  expect(await remoteTotal('quick')).toBe(50)

  pause.release()
  expect(await slow).toBe(30)
})

test('tells a waiting test at once when the paused call never happens', async () => {
  const pause = remotePoint.pause()
  await pause.run(async () => invoice(1))
  await expect(pause.reached).rejects.toThrow('finished without reaching')
})

test('resolves and rejects an asynchronous expression', async () => {
  {
    using resolved = remotePoint.resolves(7)
    expect(await remoteTotal('abc')).toBe(7)
    expect(resolved.calls).toBe(1)
  }
  remotePoint.rejects(new Error('timeout'), { on: 2 })
  expect(await remoteTotal('abc')).toBe(30)
  await expect(remoteTotal('abc')).rejects.toThrow('timeout')
})
