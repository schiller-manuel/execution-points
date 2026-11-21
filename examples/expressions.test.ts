import { expect, test } from 'vitest'
import { point } from 'execution-points-prototype'
import { invoice, remoteTotal } from './expressions'

const sumPoint = point({
  file: 'examples/expressions.ts',
  query: 'FunctionDeclaration[name.escapedText="invoice"] BinaryExpression',
  capture: ['base', 'fee'],
})

const remotePoint = point({
  file: 'examples/expressions.ts',
  query: 'FunctionDeclaration[name.escapedText="remoteTotal"] CallExpression[expression.escapedText="fetchTotal"]',
  capture: ['id', 'source'],
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
