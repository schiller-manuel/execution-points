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
