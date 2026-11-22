import { expect, test } from 'vitest'
import { fromFile, select } from 'execution-points-prototype'
import { invoice, remoteTotal } from './expressions'

// Option B: Typed fluent navigator
const sumPoint = fromFile('examples/expressions.ts', (f) =>
  f.fn('invoice').binary('+').capture('base', 'fee'),
)

// Option A: Imperative narrowing visitor
const remotePoint = select('examples/expressions.ts', (node) => {
  if (node.inFunction === 'remoteTotal' && node.kind === 'CallExpression' && node.callee === 'fetchTotal') {
    return node.capture('id', 'source')
  }
})

test('replaces an arithmetic expression, not only a function call', () => {
  expect(invoice(10)).toBe(13)
  const result = sumPoint.withReplacement(({ locals, original }) => {
    expect(locals.base).toBe(10)
    expect(locals.fee).toBe(3)
    return original() * 2
  }, () => invoice(10))
  expect(result).toBe(26)
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
